using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using MarkdownViewer.Host;
using Microsoft.Web.WebView2.Core;

namespace MarkdownViewer;

public partial class MainWindow : Window
{
    private const string AppHost = "mdviewer.app";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly DocumentStore _documents = new();
    private readonly FileWatchService _watcher = new();
    private readonly AssetServer _assets = new();
    private readonly WorkspaceService _workspace = new();
    private readonly SessionStore _session = new();

    private readonly string? _initialPath;
    private bool _uiReady;

    public MainWindow(string? initialPath)
    {
        _initialPath = initialPath;
        InitializeComponent();
        Native.UseDarkTitleBar(this);

        AllowDrop = true;

        // WebView2 would otherwise consume file drops itself and hand the page File
        // objects with no usable path. Letting WPF handle them keeps the real path,
        // which is what the watcher needs.
        Web.AllowExternalDrop = false;

        Drop += OnDrop;
        DragOver += OnDragOver;

        Closed += (_, _) =>
        {
            _session.Flush();
            _watcher.Dispose();
            _workspace.Dispose();
        };

        _watcher.Changed += OnFileChanged;
        _workspace.TreeChanged += OnWorkspaceTreeChanged;
        Loaded += OnLoadedAsync;
    }

    // ---------- WebView2 setup ----------

    private async void OnLoadedAsync(object sender, RoutedEventArgs e)
    {
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MarkdownViewer", "WebView2");
        Directory.CreateDirectory(userDataFolder);

        // Set before init, otherwise the first paint flashes white.
        Web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0x1E, 0x1E, 0x1C);

        var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);
        await Web.EnsureCoreWebView2Async(environment);

        var core = Web.CoreWebView2;
        core.Profile.PreferredColorScheme = CoreWebView2PreferredColorScheme.Dark;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsSwipeNavigationEnabled = false;

        // Ctrl+wheel and Ctrl+/- must not zoom the whole shell -- each pane owns its
        // own text scale, handled in the UI. Turning this off leaves the wheel event
        // itself intact for the UI to interpret.
        core.Settings.IsZoomControlEnabled = false;

        var webRoot = Path.Combine(AppContext.BaseDirectory, "web");
        core.SetVirtualHostNameToFolderMapping(AppHost, webRoot, CoreWebView2HostResourceAccessKind.Allow);

        _assets.Attach(core);

        // Nothing should ever navigate the shell away from index.html.
        core.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            OpenExternally(args.Uri);
        };

        core.WebMessageReceived += OnWebMessageReceived;
        core.Navigate($"https://{AppHost}/index.html");
    }

    // ---------- messages from the UI ----------

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        var message = JsonSerializer.Deserialize<JsonElement>(e.WebMessageAsJson);
        if (!message.TryGetProperty("type", out var typeElement)) return;

        var payload = message.TryGetProperty("payload", out var p) ? p : default;

        switch (typeElement.GetString())
        {
            case "ready":
                _uiReady = true;
                await StartUpAsync();
                break;

            case "open-file":
                if (payload.ValueKind == JsonValueKind.String)
                    await OpenAsync(payload.GetString()!);
                break;

            case "load-docs":
                if (payload.ValueKind == JsonValueKind.Array)
                    await LoadDocumentsAsync(payload);
                break;

            case "sync-open":
                if (payload.ValueKind == JsonValueKind.Array) SyncOpenDocuments(payload);
                break;

            case "open-external":
                if (payload.ValueKind == JsonValueKind.String)
                    OpenExternally(payload.GetString()!);
                break;

            case "pick-file":
                await PickFileAsync();
                break;

            case "pick-folder":
                PickFolder();
                break;

            case "open-workspace":
                if (payload.ValueKind == JsonValueKind.String)
                    OpenWorkspace(payload.GetString()!);
                break;

            case "close-workspace":
                _workspace.Close();
                Post("workspace", new { closed = true });
                break;

            case "get-text":
                if (payload.ValueKind == JsonValueKind.String) SendText(payload.GetString()!);
                break;

            case "save-doc":
                if (payload.ValueKind == JsonValueKind.Object) await SaveAsync(payload);
                break;

            case "toggle-task":
                if (payload.ValueKind == JsonValueKind.Object) await ToggleTaskAsync(payload);
                break;

            case "set-title":
                UpdateTitle(payload.ValueKind == JsonValueKind.String ? payload.GetString() : null);
                break;

            case "save-session":
                if (payload.ValueKind == JsonValueKind.Object) _session.Save(payload);
                break;

            case "register-association":
                FileAssociation.Register();
                PostAssociationState();
                break;
        }
    }

    /// <summary>
    /// Restores the previous session, then applies whatever this launch asked for on
    /// top. A file passed on the command line always wins and ends up focused.
    /// </summary>
    private async Task StartUpAsync()
    {
        PostAssociationState();

        var saved = _session.Load();

        if (saved is not null)
        {
            if (saved.Value.TryGetProperty("workspace", out var workspaceRoot)
                && workspaceRoot.GetString() is { Length: > 0 } root
                && Directory.Exists(root))
            {
                _workspace.Open(root);
                _assets.AllowRoot(root);
                PostWorkspaceTree();
            }

            Post("session", saved.Value);
        }

        if (!string.IsNullOrWhiteSpace(_initialPath))
        {
            await OpenAsync(_initialPath);
        }
        else if (saved is null)
        {
            Post("welcome", RenderWelcome());
        }
    }

    // ---------- opening documents ----------

    private async Task OpenAsync(string path)
    {
        var document = await LoadAsync(path);
        if (document is null) return;

        Post("doc-opened", Describe(document));
    }

    /// <summary>Loads without placing a tab — used when restoring a saved layout.</summary>
    private async Task LoadDocumentsAsync(JsonElement paths)
    {
        foreach (var element in paths.EnumerateArray())
        {
            if (element.GetString() is not { Length: > 0 } path) continue;

            var document = await LoadAsync(path);
            if (document is not null) Post("doc-content", Describe(document));
        }
    }

    private async Task<Document?> LoadAsync(string path)
    {
        string full;
        try { full = DocumentStore.Normalize(path); }
        catch (ArgumentException) { return null; }
        catch (NotSupportedException) { return null; }
        catch (PathTooLongException) { return null; }

        if (!File.Exists(full))
        {
            Post("error", new { message = $"Not found: {full}" });
            return null;
        }

        var directory = Path.GetDirectoryName(full);
        if (directory is not null) _assets.AllowRoot(directory);

        // A cloud-only file blocks on a network download. Tell the UI first so the
        // tab appears immediately instead of the window seeming to hang.
        if (DocumentStore.IsCloudOnly(full))
            Post("downloading", new { path = full, title = Path.GetFileName(full) });

        var document = await _documents.LoadAsync(full);
        _watcher.Watch(full);
        return document;
    }

    // ---------- editing ----------

    /// <summary>
    /// Hands the raw markdown to the editor. Sent on request rather than with every
    /// document, so the common read-only path does not carry the source as well as
    /// the rendered HTML.
    /// </summary>
    private void SendText(string path)
    {
        var document = _documents.Get(path);
        if (document is null || document.Missing) return;

        Post("doc-text", new { path = document.Path, text = document.RawText });
    }

    private async Task SaveAsync(JsonElement request)
    {
        if (!request.TryGetProperty("path", out var pathElement)
            || !request.TryGetProperty("text", out var textElement)
            || pathElement.GetString() is not { Length: > 0 } path
            || textElement.GetString() is not { } text)
        {
            return;
        }

        var force = request.TryGetProperty("force", out var forceElement)
                    && forceElement.ValueKind == JsonValueKind.True;

        var (saved, conflict) = await _documents.SaveAsync(path, text, force);

        Post("save-result", new { path, saved, conflict });

        if (!saved) return;

        var document = _documents.Get(path);
        if (document is not null) Post("doc-updated", Describe(document));
    }

    /// <summary>
    /// Ticking a checkbox in the rendered view edits the markdown itself. The UI sends
    /// the checkbox's index; the offset recorded at render time says where to edit.
    /// </summary>
    private async Task ToggleTaskAsync(JsonElement request)
    {
        if (!request.TryGetProperty("path", out var pathElement)
            || !request.TryGetProperty("index", out var indexElement)
            || pathElement.GetString() is not { Length: > 0 } path
            || !indexElement.TryGetInt32(out var index))
        {
            return;
        }

        var check = request.TryGetProperty("checked", out var checkedElement)
                    && checkedElement.ValueKind == JsonValueKind.True;

        var document = _documents.Get(path);
        if (document is null || index < 0 || index >= document.TaskOffsets.Count) return;

        var updated = MarkdownRenderer.ToggleTask(document.RawText, document.TaskOffsets[index], check);
        if (updated is null)
        {
            Post("error", new { message = "That checkbox has moved — reload the file and try again." });
            return;
        }

        var (saved, conflict) = await _documents.SaveAsync(path, updated, force: false);

        if (conflict)
        {
            Post("error", new { message = $"{Path.GetFileName(path)} changed on disk; not overwriting." });
            return;
        }

        if (!saved)
        {
            Post("error", new { message = $"Could not write to {Path.GetFileName(path)}." });
            return;
        }

        var refreshed = _documents.Get(path);
        if (refreshed is not null) Post("doc-updated", Describe(refreshed));
    }

    /// <summary>
    /// Drops watchers for documents the UI no longer has open anywhere. The UI sends
    /// the whole open set rather than individual closes, because the same file can be
    /// open in several panes and only the UI knows when the last one went away.
    /// </summary>
    private void SyncOpenDocuments(JsonElement openPaths)
    {
        var stillOpen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var element in openPaths.EnumerateArray())
        {
            if (element.GetString() is { Length: > 0 } path) stillOpen.Add(path);
        }

        foreach (var path in _documents.OpenPaths)
        {
            if (stillOpen.Contains(path)) continue;
            _watcher.Unwatch(path);
            _documents.Remove(path);
        }
    }

    // ---------- workspaces ----------

    private void OpenWorkspace(string root)
    {
        if (!Directory.Exists(root)) return;

        _workspace.Open(root);
        _assets.AllowRoot(root);
        PostWorkspaceTree();
    }

    private void PostWorkspaceTree()
    {
        var tree = _workspace.Scan();
        if (tree is null) { Post("workspace", new { closed = true }); return; }

        Post("workspace", new
        {
            root = tree.Root,
            name = tree.Name,
            truncated = tree.Truncated,
            entries = tree.Entries.Select(entry => new
            {
                path = entry.Path,
                name = entry.Name,
                parent = entry.Parent,
                dir = entry.IsDirectory
            })
        });
    }

    private void OnWorkspaceTreeChanged() =>
        _ = Dispatcher.InvokeAsync(() => { if (_uiReady) PostWorkspaceTree(); });

    // ---------- dialogs ----------

    private async Task PickFileAsync()
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Title = "Open markdown",
            Filter = "Markdown (*.md;*.markdown;*.mdown;*.mkd)|*.md;*.markdown;*.mdown;*.mkd|All files (*.*)|*.*",
            Multiselect = true
        };

        if (dialog.ShowDialog(this) != true) return;

        foreach (var file in dialog.FileNames) await OpenAsync(file);
    }

    private void PickFolder()
    {
        var dialog = new Microsoft.Win32.OpenFolderDialog { Title = "Open a folder as a workspace" };
        if (dialog.ShowDialog(this) == true) OpenWorkspace(dialog.FolderName);
    }

    /// <summary>Called when a second launch hands a path to this window.</summary>
    public async void HandleExternalRequest(string path)
    {
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
        Topmost = true;
        Topmost = false;

        if (!string.IsNullOrWhiteSpace(path) && _uiReady) await OpenAsync(path);
    }

    // ---------- live reload ----------

    private void OnFileChanged(string path)
    {
        // Watcher callbacks arrive on the thread pool.
        _ = Dispatcher.InvokeAsync(async () =>
        {
            if (!_uiReady) return;

            var changed = await _documents.ReloadAsync(path);
            if (!changed) return;   // duplicate event, or a byte-identical rewrite

            var document = _documents.Get(path);
            if (document is null) return;

            Post("doc-updated", Describe(document));
        });
    }

    // ---------- drag and drop ----------

    private static void OnDragOver(object sender, DragEventArgs e)
    {
        e.Effects = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;
        e.Handled = true;
    }

    private async void OnDrop(object sender, DragEventArgs e)
    {
        if (e.Data.GetData(DataFormats.FileDrop) is not string[] paths) return;

        foreach (var path in paths)
        {
            if (Directory.Exists(path)) OpenWorkspace(path);
            else await OpenAsync(path);
        }
    }

    // ---------- helpers ----------

    private object Describe(Document document) => new
    {
        path = document.Path,
        title = document.Title,
        html = document.Html,
        outline = document.Outline,
        missing = document.Missing,
        loadedAt = document.LoadedAt.ToString("o"),
        folder = Path.GetDirectoryName(document.Path) ?? string.Empty
    };

    private object RenderWelcome()
    {
        var rendered = MarkdownRenderer.Render(WelcomeMarkdown);
        return new { html = rendered.Html, outline = rendered.Outline };
    }

    private void PostAssociationState() => Post("association", new
    {
        registered = FileAssociation.IsRegistered(),
        exe = FileAssociation.ExecutablePath
    });

    private void UpdateTitle(string? documentTitle) =>
        Title = string.IsNullOrEmpty(documentTitle) ? "MarkdownViewer" : $"{documentTitle} — MarkdownViewer";

    private static void OpenExternally(string uri)
    {
        if (!uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            && !uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { }
    }

    private void Post(string type, object payload) =>
        Web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type, payload }, JsonOptions));

    private const string WelcomeMarkdown = """
        # MarkdownViewer

        No document open.

        - **Ctrl+O** opens a file
        - **Ctrl+K** opens a folder as a workspace
        - **Ctrl+P** jumps to a file once a workspace is open
        - **Ctrl+\\** splits the pane, **Ctrl+Shift+\\** splits it downwards
        - Drag a file or folder onto the window

        Files reload automatically when something changes them on disk, and your place
        in the document is kept.
        """;
}
