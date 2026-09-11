using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;
using Windows.ApplicationModel.Activation;

namespace DocFlow;

/// <summary>
/// Single-instance entry point: a second launch hands its activation (and any
/// files on its command line) to the running window instead of starting
/// another engine on the same library.
/// </summary>
public static partial class Program
{
    /// <summary>
    /// Exists while DocFlow runs: its installer and uninstaller (AppMutex in
    /// apps\windows\installer\DocFlow.iss) ask to close it before touching files.
    /// </summary>
    private static Mutex? s_running;

    [STAThread]
    private static int Main(string[] args)
    {
        WinRT.ComWrappersSupport.InitializeComWrappers();
        var instance = AppInstance.FindOrRegisterForKey("DocFlow.Main");
        if (!instance.IsCurrent)
        {
            var activation = AppInstance.GetCurrent().GetActivatedEventArgs();
            instance.RedirectActivationToAsync(activation).AsTask().Wait();
            return 0;
        }
        s_running = new Mutex(false, "DocFlow.Running");

        instance.Activated += (_, activation) =>
        {
            var files = activation.Data is ILaunchActivatedEventArgs launch ? SplitArguments(launch.Arguments) : [];
            App.BringToFront(files);
        };
        Application.Start(callback =>
        {
            var context = new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread());
            SynchronizationContext.SetSynchronizationContext(context);
            _ = new App();
        });
        return 0;
    }

    /// <summary>Command-line arguments after the executable, split like argv.</summary>
    public static IReadOnlyList<string> SplitArguments(string? commandLine)
    {
        if (string.IsNullOrWhiteSpace(commandLine))
        {
            return [];
        }
        var pointer = CommandLineToArgvW(commandLine, out var count);
        if (pointer == IntPtr.Zero)
        {
            return [];
        }
        try
        {
            var result = new List<string>(count);
            for (var index = 0; index < count; index++)
            {
                result.Add(Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, index * IntPtr.Size)) ?? "");
            }
            // Launch arguments may or may not start with the executable path.
            if (result.Count > 0 && result[0].EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            {
                result.RemoveAt(0);
            }
            return result;
        }
        finally
        {
            LocalFree(pointer);
        }
    }

    [LibraryImport("shell32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial IntPtr CommandLineToArgvW(string commandLine, out int count);

    [LibraryImport("kernel32.dll")]
    private static partial IntPtr LocalFree(IntPtr memory);
}
