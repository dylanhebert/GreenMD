using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace GreenMD.Host;

/// <summary>
/// Registers the app as a handler for markdown files under HKCU.
///
/// Everything here is per-user, so no elevation is needed. Note that this makes the
/// app *available* — it appears in "Open with" and can be picked as the default — but
/// Windows 11 will not let an application silently claim the default itself. The user
/// still confirms once, in the shell's own picker or in Settings.
/// </summary>
public static class FileAssociation
{
    private const string ProgId = "GreenMD.Document";
    private const string FriendlyName = "Markdown Document";
    private const string ClassesRoot = @"Software\Classes";

    private static readonly string[] Extensions = [".md", ".markdown", ".mdown", ".mkd", ".mdtext"];

    private const int ShcneAssocChanged = 0x08000000;
    private const int ShcnfIdList = 0x0000;

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);

    public static string ExecutablePath =>
        Environment.ProcessPath ?? System.Reflection.Assembly.GetExecutingAssembly().Location;

    /// <summary>
    /// True when this exact executable is registered. Comparing the command rather than
    /// just the ProgId means a moved or republished build reports as unregistered, which
    /// is what the user needs to know — the stale entry would open the old path.
    /// </summary>
    public static bool IsRegistered()
    {
        try
        {
            using var command = Registry.CurrentUser.OpenSubKey($@"{ClassesRoot}\{ProgId}\shell\open\command");
            if (command?.GetValue(null) is not string registered) return false;
            if (!registered.Contains(ExecutablePath, StringComparison.OrdinalIgnoreCase)) return false;

            using var progIds = Registry.CurrentUser.OpenSubKey($@"{ClassesRoot}\.md\OpenWithProgids");
            return progIds?.GetValue(ProgId) is not null;
        }
        catch (UnauthorizedAccessException) { return false; }
        catch (System.Security.SecurityException) { return false; }
    }

    public static void Register()
    {
        var exe = ExecutablePath;
        var open = $"\"{exe}\" \"%1\"";

        using (var progId = Registry.CurrentUser.CreateSubKey($@"{ClassesRoot}\{ProgId}"))
        {
            progId.SetValue(null, FriendlyName);
            progId.SetValue("FriendlyTypeName", FriendlyName);

            // Explorer draws .md files with the icon group embedded in the exe.
            using (var icon = progId.CreateSubKey("DefaultIcon"))
                icon.SetValue(null, $"\"{exe}\",0");

            using (var command = progId.CreateSubKey(@"shell\open\command"))
                command.SetValue(null, open);
        }

        foreach (var extension in Extensions)
        {
            // OpenWithProgids adds this app as a candidate without stomping whatever
            // the user already has set as their default.
            using var progIds = Registry.CurrentUser.CreateSubKey($@"{ClassesRoot}\{extension}\OpenWithProgids");
            progIds.SetValue(ProgId, Array.Empty<byte>(), RegistryValueKind.None);
        }

        // Registering under Applications is what puts a sensible entry in the
        // "Open with" list and in "Choose a default app" in Settings.
        var exeName = Path.GetFileName(exe);
        using (var application = Registry.CurrentUser.CreateSubKey($@"{ClassesRoot}\Applications\{exeName}"))
        {
            application.SetValue("FriendlyAppName", "GreenMD");

            using (var command = application.CreateSubKey(@"shell\open\command"))
                command.SetValue(null, open);

            using var supported = application.CreateSubKey("SupportedTypes");
            foreach (var extension in Extensions) supported.SetValue(extension, string.Empty);
        }

        NotifyShell();
    }

    public static void Unregister()
    {
        try
        {
            foreach (var extension in Extensions)
            {
                using var progIds = Registry.CurrentUser.OpenSubKey($@"{ClassesRoot}\{extension}\OpenWithProgids", writable: true);
                progIds?.DeleteValue(ProgId, throwOnMissingValue: false);
            }

            Registry.CurrentUser.DeleteSubKeyTree($@"{ClassesRoot}\{ProgId}", throwOnMissingSubKey: false);

            var exeName = Path.GetFileName(ExecutablePath);
            Registry.CurrentUser.DeleteSubKeyTree($@"{ClassesRoot}\Applications\{exeName}", throwOnMissingSubKey: false);
        }
        catch (UnauthorizedAccessException) { }
        catch (System.Security.SecurityException) { }

        NotifyShell();
    }

    /// <summary>Tells Explorer to drop its cached association and icon data.</summary>
    private static void NotifyShell() =>
        SHChangeNotify(ShcneAssocChanged, ShcnfIdList, IntPtr.Zero, IntPtr.Zero);
}
