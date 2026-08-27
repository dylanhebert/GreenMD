using System.IO;
using System.Text.Json;
using System.Windows;

namespace GreenMD.Host;

/// <summary>
/// Remembers where the window sat between runs: position, size, and whether it was
/// maximized. Kept apart from SessionStore because session.json's shape belongs to
/// the UI, and this is the one piece of state only the host can know.
/// </summary>
public static class WindowPlacement
{
    private sealed record Placement(double Left, double Top, double Width, double Height, bool Maximized);

    private static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "GreenMD", "window.json");

    public static void Restore(Window window)
    {
        Placement? saved = null;
        try
        {
            if (File.Exists(FilePath))
                saved = JsonSerializer.Deserialize<Placement>(File.ReadAllText(FilePath));
        }
        catch (JsonException) { }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }

        if (saved is null || saved.Width < 200 || saved.Height < 200) return;

        // A monitor that has since been unplugged must not strand the window
        // off-screen: the saved rectangle has to overlap the virtual desktop.
        var virtualScreen = new Rect(
            SystemParameters.VirtualScreenLeft, SystemParameters.VirtualScreenTop,
            SystemParameters.VirtualScreenWidth, SystemParameters.VirtualScreenHeight);
        var visible = Rect.Intersect(new Rect(saved.Left, saved.Top, saved.Width, saved.Height), virtualScreen);
        if (visible.IsEmpty || visible.Width < 100 || visible.Height < 100) return;

        window.WindowStartupLocation = WindowStartupLocation.Manual;
        window.Left = saved.Left;
        window.Top = saved.Top;
        window.Width = saved.Width;
        window.Height = saved.Height;

        // Set before the window shows, so it maximizes straight onto the monitor
        // the position above selects rather than flashing at normal size first.
        if (saved.Maximized) window.WindowState = WindowState.Maximized;
    }

    public static void Save(Window window)
    {
        // RestoreBounds is the normal-state rectangle even while maximized or
        // minimized, so an unmaximize after the next launch lands where it should.
        var bounds = window.WindowState == WindowState.Normal
            ? new Rect(window.Left, window.Top, window.ActualWidth, window.ActualHeight)
            : window.RestoreBounds;

        var placement = new Placement(bounds.Left, bounds.Top, bounds.Width, bounds.Height,
            window.WindowState == WindowState.Maximized);

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            var temporary = FilePath + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(placement));
            File.Move(temporary, FilePath, overwrite: true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
