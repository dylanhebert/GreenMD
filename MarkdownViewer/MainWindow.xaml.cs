using System.IO;
using System.Text;
using System.Text.Json;
using System.Windows;
using MarkdownViewer.Host;
using Microsoft.Web.WebView2.Core;

namespace MarkdownViewer;

public partial class MainWindow : Window
{
    private const string AppHost = "mdviewer.app";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly string? _initialPath;

    public MainWindow(string? initialPath)
    {
        _initialPath = initialPath;
        InitializeComponent();
        Native.UseDarkTitleBar(this);
        Loaded += OnLoadedAsync;
    }

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

        var webRoot = Path.Combine(AppContext.BaseDirectory, "web");
        core.SetVirtualHostNameToFolderMapping(AppHost, webRoot, CoreWebView2HostResourceAccessKind.Allow);

        core.WebMessageReceived += OnWebMessageReceived;
        core.Navigate($"https://{AppHost}/index.html");
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        var message = JsonSerializer.Deserialize<JsonElement>(e.WebMessageAsJson);
        if (!message.TryGetProperty("type", out var type)) return;

        switch (type.GetString())
        {
            case "ready":
                OpenDocument(_initialPath);
                break;
        }
    }

    private void OpenDocument(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            var welcome = MarkdownRenderer.Render(WelcomeMarkdown);
            Post("doc", new { path = "", title = "Welcome", html = welcome.Html, outline = welcome.Outline });
            return;
        }

        var full = Path.GetFullPath(path);
        var text = ReadAllText(full);
        var rendered = MarkdownRenderer.Render(text);

        Title = $"{Path.GetFileName(full)} — MarkdownViewer";
        Post("doc", new { path = full, title = Path.GetFileName(full), html = rendered.Html, outline = rendered.Outline });
    }

    /// <summary>Reads with BOM detection, falling back to UTF-8 (what agent-written files are).</summary>
    private static string ReadAllText(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream, new UTF8Encoding(false), detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    private void Post(string type, object payload) =>
        Web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type, payload }, JsonOptions));

    private const string WelcomeMarkdown = """
        # MarkdownViewer

        M0 is up: WPF shell, one WebView2, Markdig rendering, dark chrome.

        Pass a file on the command line to render it:

        ```
        MarkdownViewer.exe C:\path\to\file.md
        ```

        ## What renders today

        | Feature | Status |
        | --- | --- |
        | GFM tables | yes |
        | Task lists | yes |
        | Footnotes | yes |
        | Fenced code | yes, unhighlighted until M1 |

        - [x] Markdig pipeline with advanced extensions
        - [x] Heading outline extracted from the AST
        - [ ] Live reload on external change (M1)
        - [ ] Tabs, splits, workspaces (M1–M3)

        ### Next

        M1 wires up the document cache and the directory watchers, which is where
        the live-reload behaviour actually lives.
        """;
}
