using System.Windows;

namespace MarkdownViewer;

public partial class App : Application
{
    private void OnStartup(object sender, StartupEventArgs e)
    {
        // M0: single window, one file from the command line.
        // M1 replaces this with single-instance handoff over a named pipe.
        var path = e.Args.FirstOrDefault(a => !a.StartsWith('-') && !a.StartsWith('/'));
        new MainWindow(path).Show();
    }
}
