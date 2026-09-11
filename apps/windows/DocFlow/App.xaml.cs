using DocFlow.Services;
using Microsoft.UI.Xaml;
using WinRT.Interop;

namespace DocFlow;

public partial class App : Application
{
    private static MainWindow? _window;

    public App()
    {
        InitializeComponent();
        // Unpackaged apps may be installed in a read-only folder; keep the
        // WebView2 profile with the rest of the app's local data.
        Environment.SetEnvironmentVariable(
            "WEBVIEW2_USER_DATA_FOLDER",
            Path.Combine(HostSettings.AppDataDir, "WebView2"));
        UnhandledException += (_, args) =>
        {
            args.Handled = true;
            AppLog.Error("unhandled", args.Exception);
            _window?.ShowError("发生意外错误", args.Exception.Message);
        };
    }

    public static MainWindow Window => _window ?? throw new InvalidOperationException("窗口尚未创建");

    /// <summary>
    /// Called first thing in the MainWindow constructor: its initial
    /// navigation already needs <see cref="Window"/>.
    /// </summary>
    internal static void Attach(MainWindow window) => _window = window;

    public static IntPtr WindowHandle => WindowNative.GetWindowHandle(Window);

    public static IntPtr WindowHandleFor(Microsoft.UI.Xaml.Window window) => WindowNative.GetWindowHandle(window);

    public static void BringToFront(IReadOnlyList<string> files)
    {
        _window?.DispatcherQueue.TryEnqueue(() =>
        {
            _window.BringToFront();
            _window.OpenFiles([.. files]);
        });
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new MainWindow();
        _window.Activate();
        // Launch arguments are files to translate ("Open with", drag onto the icon).
        _window.OpenFiles([.. Environment.GetCommandLineArgs().Skip(1)]);
        _ = AppHost.StartEngineAsync(_window.DispatcherQueue);
    }
}
