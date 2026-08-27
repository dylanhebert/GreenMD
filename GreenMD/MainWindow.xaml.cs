using System.Diagnostics;
using System.Reflection;
using System.IO;
using System.Text.Json;
using System.Windows;
using GreenMD.Host;
using Microsoft.Web.WebView2.Core;

namespace GreenMD;

public partial class MainWindow : Window
{
    private const string AppHost = "greenmd.app";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly DocumentStore _documents = new();
    private readonly FileWatchService _watcher = new();
    private readonly AssetServer _assets = new();
    private readonly WorkspaceService _workspace = new();
    private readonly SessionStore _session = new();

    private readonly string? _initialPath;
    private readonly string? _dumpLayoutPath;
    private readonly string? _dumpStatePath;
    private bool _uiReady;

    /// <summary>Set once the UI has confirmed there is no unsaved work to lose.</summary>
    private bool _closeConfirmed;

    public MainWindow(string? initialPath, string? dumpLayoutPath, string? dumpStatePath)
    {
        _initialPath = initialPath;
        _dumpLayoutPath = dumpLayoutPath;
        _dumpStatePath = dumpStatePath;
        InitializeComponent();
        Native.UseDarkTitleBar(this);

        // Routing Explorer drops through WPF (AllowExternalDrop=false) kept their
        // real paths, but in the WPF host it also suppressed the page's own tab
        // drags. So the page accepts drops itself and posts "dropped-files" via
        // postMessageWithAdditionalObjects, which preserves each file's path.
        Web.AllowExternalDrop = true;

        Closing += OnClosing;

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

    /// <summary>
    /// Closing the window must not silently discard unsaved edits, which closing a
    /// tab already guards against. The check lives in the UI -- only it knows which
    /// buffers are dirty -- so the first close is cancelled while it is asked, and
    /// the UI closes the window for real once it is satisfied.
    /// </summary>
    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_closeConfirmed || !_uiReady) return;

        e.Cancel = true;
        Post("confirm-close", new { });
    }

    // ---------- WebView2 setup ----------

    private async void OnLoadedAsync(object sender, RoutedEventArgs e)
    {
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "GreenMD", "WebView2");
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

            case "dropped-files":
                // Sent with postMessageWithAdditionalObjects; each object is a
                // CoreWebView2File carrying the dropped file's real path.
                foreach (var dropped in e.AdditionalObjects ?? Enumerable.Empty<object>())
                {
                    if (dropped is not CoreWebView2File file) continue;
                    if (Directory.Exists(file.Path)) OpenWorkspace(file.Path);
                    else await OpenAsync(file.Path);
                }
                break;

            case "close-workspace":
                // A path closes one folder; anything else closes them all.
                if (payload.ValueKind == JsonValueKind.String) _workspace.Remove(payload.GetString()!);
                else _workspace.Clear();
                PostWorkspaceTree();
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

            case "layout-dump":
                WriteLayoutDump(payload);
                break;

            case "state-dump":
                WriteStateDump(payload);
                break;

            case "get-about":
                PostAbout();
                break;

            case "close-approved":
                _closeConfirmed = true;
                Close();
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
            RestoreWorkspaces(saved.Value);
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

        if (_dumpLayoutPath is not null) Post("dump-layout", new { });
        if (_dumpStatePath is not null) Post("dump-state", new { });
    }

    /// <summary>
    /// Appends a state snapshot from the UI. Unlike the layout dump this leaves the
    /// window open, so behaviour over time -- did a watcher event actually arrive? --
    /// can be observed instead of inferred.
    /// </summary>
    private void WriteStateDump(JsonElement snapshot)
    {
        if (_dumpStatePath is null) return;

        try
        {
            var line = JsonSerializer.Serialize(new
            {
                at = DateTimeOffset.Now.ToString("HH:mm:ss.fff"),
                hostWatching = _documents.OpenPaths.ToArray(),
                ui = snapshot
            }, JsonOptions);

            File.AppendAllText(_dumpStatePath, line + Environment.NewLine);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    /// <summary>Writes the UI's own measurements of the real window to disk, then exits.</summary>
    private void WriteLayoutDump(JsonElement measurements)
    {
        if (_dumpLayoutPath is null) return;

        try
        {
            File.WriteAllText(_dumpLayoutPath,
                JsonSerializer.Serialize(measurements, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }

        Close();
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

        var directory = Path.GetDirectoryName(full);
        if (directory is not null) _assets.AllowRoot(directory);

        // A missing file still gets a document and a watcher. Bailing out here left the
        // tab in limbo -- no document, no watcher, and no way to recover when the file
        // came back, so nothing that happened to it afterwards was ever noticed.
        if (!File.Exists(full))
        {
            Post("error", new { message = $"Not found: {Path.GetFileName(full)}" });

            var placeholder = await _documents.LoadAsync(full);
            _watcher.Watch(full);
            return placeholder;
        }

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

        _workspace.Add(root);
        _assets.AllowRoot(root);
        PostWorkspaceTree();
    }

    /// <summary>Sends every open folder in one message; the UI renders one section each.</summary>
    private void PostWorkspaceTree() => Post("workspace", new
    {
        workspaces = _workspace.ScanAll().Select(tree => new
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
        })
    });

    /// <summary>
    /// Reopens the saved folders. The single-string "workspace" key from before
    /// multi-folder support is still read, so an existing session is not lost.
    /// </summary>
    private void RestoreWorkspaces(JsonElement saved)
    {
        List<string> roots = [];

        if (saved.TryGetProperty("workspaces", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in list.EnumerateArray())
            {
                if (element.GetString() is { Length: > 0 } root) roots.Add(root);
            }
        }
        else if (saved.TryGetProperty("workspace", out var single)
                 && single.GetString() is { Length: > 0 } legacy)
        {
            roots.Add(legacy);
        }

        var opened = false;
        foreach (var root in roots)
        {
            if (!Directory.Exists(root)) continue;
            if (!_workspace.Add(root)) continue;

            _assets.AllowRoot(root);
            opened = true;
        }

        if (opened) PostWorkspaceTree();
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

            LogState($"host posting doc-updated for {Path.GetFileName(path)} hash={document.Hash[..8]}");
            Post("doc-updated", Describe(document));
        });
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

    /// <summary>
    /// Facts about this build and where it keeps things. Gathered here because the
    /// UI has no way to see any of it.
    /// </summary>
    private void PostAbout()
    {
        var assembly = Assembly.GetExecutingAssembly();

        var version = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? assembly.GetName().Version?.ToString()
            ?? "unknown";

        // A build produced from a git checkout carries a +sha suffix; drop it here and
        // show it separately rather than in the headline version.
        var plus = version.IndexOf('+');
        var build = plus >= 0 ? version[(plus + 1)..] : string.Empty;
        if (plus >= 0) version = version[..plus];

        string webView2;
        try { webView2 = CoreWebView2Environment.GetAvailableBrowserVersionString(); }
        catch (WebView2RuntimeNotFoundException) { webView2 = "not found"; }

        Post("about", new
        {
            version,
            build,
            dotnet = Environment.Version.ToString(),
            webView2,
            selfContained = !string.IsNullOrEmpty(Environment.ProcessPath)
                            && !File.Exists(Path.Combine(AppContext.BaseDirectory, "GreenMD.runtimeconfig.json")),
            executable = FileAssociation.ExecutablePath,
            sessionFile = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "GreenMD", "session.json"),
            webViewData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GreenMD", "WebView2"),
            associationRegistered = FileAssociation.IsRegistered()
        });
    }

    private void PostAssociationState() => Post("association", new
    {
        registered = FileAssociation.IsRegistered(),
        exe = FileAssociation.ExecutablePath
    });

    private void UpdateTitle(string? documentTitle) =>
        Title = string.IsNullOrEmpty(documentTitle) ? "GreenMD" : $"{documentTitle} — GreenMD";

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

    /// <summary>Host-side note in the same stream as the UI snapshots.</summary>
    private void LogState(string note)
    {
        if (_dumpStatePath is null) return;

        try
        {
            File.AppendAllText(_dumpStatePath,
                JsonSerializer.Serialize(new { at = DateTimeOffset.Now.ToString("HH:mm:ss.fff"), note }, JsonOptions)
                + Environment.NewLine);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private void Post(string type, object payload) =>
        Web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type, payload }, JsonOptions));

    private const string WelcomeMarkdown = """
        # GreenMD

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
