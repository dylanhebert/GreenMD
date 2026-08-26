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

    private readonly string? _initialPath;
    private bool _uiReady;

    public MainWindow(string? initialPath)
    {
        _initialPath = initialPath;
        InitializeComponent();
        Native.UseDarkTitleBar(this);

        AllowDrop = true;
        Drop += OnDrop;
        DragOver += OnDragOver;
        Closed += (_, _) => _watcher.Dispose();

        _watcher.Changed += OnFileChanged;
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
        // own text scale, handled in app.js. Turning this off leaves the wheel event
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
                if (!string.IsNullOrWhiteSpace(_initialPath)) await OpenAsync(_initialPath);
                else Post("welcome", RenderWelcome());
                break;

            case "open-file":
                if (payload.ValueKind == JsonValueKind.String)
                    await OpenAsync(payload.GetString()!);
                break;

            case "close-doc":
                if (payload.ValueKind == JsonValueKind.String)
                    CloseDocument(payload.GetString()!);
                break;

            case "open-external":
                if (payload.ValueKind == JsonValueKind.String)
                    OpenExternally(payload.GetString()!);
                break;

            case "pick-file":
                await PickFileAsync();
                break;
        }
    }

    // ---------- opening and closing ----------

    private async Task OpenAsync(string path)
    {
        string full;
        try { full = DocumentStore.Normalize(path); }
        catch (ArgumentException) { return; }
        catch (NotSupportedException) { return; }
        catch (PathTooLongException) { return; }

        if (!File.Exists(full))
        {
            Post("error", new { message = $"Not found: {full}" });
            return;
        }

        var directory = Path.GetDirectoryName(full);
        if (directory is not null) _assets.AllowRoot(directory);

        // A cloud-only file blocks on a network download. Tell the UI first so the
        // tab appears immediately instead of the window seeming to hang.
        if (DocumentStore.IsCloudOnly(full))
            Post("downloading", new { path = full, title = Path.GetFileName(full) });

        var document = await _documents.LoadAsync(full);
        _watcher.Watch(full);

        Post("doc-opened", Describe(document));
        UpdateTitle(document.Title);
    }

    private void CloseDocument(string path)
    {
        _watcher.Unwatch(path);
        _documents.Remove(path);
    }

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
        if (e.Data.GetData(DataFormats.FileDrop) is not string[] files) return;

        foreach (var file in files)
        {
            if (Directory.Exists(file)) continue;   // folders arrive with workspaces in M3
            await OpenAsync(file);
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

        - **Ctrl+O** to open a file
        - Drag a `.md` file onto the window
        - Or pass one on the command line

        Files reload automatically when something changes them on disk, and your
        place in the document is kept.
        """;
}
