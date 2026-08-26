using System.Windows;
using MarkdownViewer.Host;

namespace MarkdownViewer;

public partial class App : Application
{
    private SingleInstance? _instance;

    private void OnStartup(object sender, StartupEventArgs e)
    {
        var path = e.Args.FirstOrDefault(a => !a.StartsWith('-') && !a.StartsWith('/'));

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

        var window = new MainWindow(path);

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
