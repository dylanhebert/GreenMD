using System.Windows;
using MarkdownViewer.Host;

namespace MarkdownViewer;

public partial class App : Application
{
    private SingleInstance? _instance;

    private void OnStartup(object sender, StartupEventArgs e)
    {
        // Scripted install/uninstall. Neither needs a window.
        if (e.Args.Any(a => a.Equals("--register", StringComparison.OrdinalIgnoreCase)))
        {
            FileAssociation.Register();
            Shutdown();
            return;
        }

        if (e.Args.Any(a => a.Equals("--unregister", StringComparison.OrdinalIgnoreCase)))
        {
            FileAssociation.Unregister();
            Shutdown();
            return;
        }

        var path = e.Args.FirstOrDefault(a => !a.StartsWith('-') && !a.StartsWith('/'));

        // Diagnostic: measure the real window and write the numbers out. Layout bugs
        // are invisible to the jsdom suite, and reasoning about CSS from a screenshot
        // has proven unreliable -- this reports what the running app actually did.
        var dumpLayoutPath = e.Args
            .FirstOrDefault(a => a.StartsWith("--dump-layout=", StringComparison.OrdinalIgnoreCase))
            ?["--dump-layout=".Length..];

        // Streams state to disk on every change and leaves the window open, for
        // diagnosing behaviour over time rather than a single snapshot.
        var dumpStatePath = e.Args
            .FirstOrDefault(a => a.StartsWith("--dump-state=", StringComparison.OrdinalIgnoreCase))
            ?["--dump-state=".Length..];

        if (dumpLayoutPath is not null || dumpStatePath is not null)
        {
            // A diagnostic run must never hand off to an existing window.
            new MainWindow(path, dumpLayoutPath, dumpStatePath).Show();
            return;
        }

        _instance = new SingleInstance();

        if (!_instance.IsFirstInstance)
        {
            // A window is already up: give it the file and get out of the way.
            // If the handoff fails the other process is wedged, so open our own
            // window rather than leaving the user with nothing.
            if (SingleInstance.TryHandOff(path ?? string.Empty))
            {
                Shutdown();
                return;
            }
        }

        var window = new MainWindow(path, null, null);

        _instance.FileRequested += requested =>
            window.Dispatcher.Invoke(() => window.HandleExternalRequest(requested));
        _instance.StartListening();

        MainWindow = window;
        window.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _instance?.Dispose();
        base.OnExit(e);
    }
}
