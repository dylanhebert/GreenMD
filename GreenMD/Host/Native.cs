using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace GreenMD.Host;

/// <summary>Win32 interop. Without this the WPF title bar stays light over a dark app.</summary>
internal static class Native
{
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaUseImmersiveDarkModeLegacy = 19;

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    public static void UseDarkTitleBar(Window window)
    {
        var hwnd = new WindowInteropHelper(window).EnsureHandle();
        var on = 1;
        // Attribute 20 on Win10 1903+ / Win11; older builds used 19.
        if (DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkMode, ref on, sizeof(int)) != 0)
            DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkModeLegacy, ref on, sizeof(int));
    }
}
