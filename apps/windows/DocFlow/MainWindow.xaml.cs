using System.Runtime.InteropServices;
using DocFlow.Services;
using DocFlow.Views;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Navigation;
using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;
using Windows.Graphics;

namespace DocFlow;

public sealed partial class MainWindow : Window
{
    private readonly DispatcherQueueTimer _badgeTimer;
    private readonly DispatcherQueueTimer _searchTimer;
    private readonly Dictionary<string, string> _knownStatus = [];
    private bool _notificationsRegistered;

    public MainWindow()
    {
        App.Attach(this);
        InitializeComponent();
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico"));
        RestorePlacement();

        _badgeTimer = DispatcherQueue.CreateTimer();
        _badgeTimer.Interval = TimeSpan.FromMilliseconds(600);
        _badgeTimer.IsRepeating = false;
        _badgeTimer.Tick += async (_, _) => await RefreshBadgeAsync();
        _searchTimer = DispatcherQueue.CreateTimer();
        _searchTimer.Interval = TimeSpan.FromMilliseconds(300);
        _searchTimer.IsRepeating = false;
        _searchTimer.Tick += (_, _) => ApplySearch();

        AppHost.EngineStateChanged += OnEngineStateChanged;
        RegisterNotifications();
        AppWindow.Closing += OnClosing;
        Closed += OnClosed;
        NavView.Loaded += (_, _) =>
        {
            if (NavView.SettingsItem is NavigationViewItem settings)
            {
                settings.Content = "设置";
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(settings, "设置");
            }
        };
        ContentFrame.NavigationFailed += (_, args) =>
        {
            args.Handled = true;
            AppLog.Error("navigation failed", args.Exception);
            ShowError("无法打开页面", args.Exception.Message);
        };
        NavView.SelectedItem = LibraryItem;
        ShowStarting();
    }

    private readonly List<string> _pendingFiles = [];

    /// <summary>Opens "新建翻译" with files passed on the command line.</summary>
    public void OpenFiles(IReadOnlyCollection<string> paths)
    {
        var files = paths.Where(File.Exists).Select(Path.GetFullPath).ToList();
        if (files.Count == 0)
        {
            return;
        }
        if (!AppHost.IsReady)
        {
            _pendingFiles.AddRange(files);
            return;
        }
        Navigate(typeof(NewDocumentPage), files);
    }

    public string SearchText => SearchBox.Text;

    public event Action<string>? SearchChanged;

    public void Navigate(Type page, object? parameter = null)
    {
        if (ContentFrame.CurrentSourcePageType == page && parameter is null)
        {
            return;
        }
        NavigationTransitionInfo transition = page == typeof(DocumentPage)
            ? new DrillInNavigationTransitionInfo()
            : new EntranceNavigationTransitionInfo();
        try
        {
            ContentFrame.Navigate(page, parameter, transition);
        }
        catch (Exception error)
        {
            AppLog.Error($"navigate {page.Name}", error);
            ShowError("无法打开页面", error.Message);
        }
    }

    public void ShowError(string title, string message)
    {
        EngineInfoBar.Title = title;
        EngineInfoBar.Message = message;
        EngineInfoBar.Severity = InfoBarSeverity.Error;
        EngineRetryButton.Visibility = Visibility.Collapsed;
        EngineInfoBar.IsClosable = true;
        EngineInfoBar.IsOpen = true;
    }

    public void BringToFront()
    {
        if (AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized } presenter)
        {
            presenter.Restore();
        }
        Activate();
        SetForegroundWindow(App.WindowHandle);
    }

    private void ShowStarting()
    {
        EngineInfoBar.Title = "正在启动处理引擎";
        EngineInfoBar.Message = "";
        EngineInfoBar.Severity = InfoBarSeverity.Informational;
        EngineRetryButton.Visibility = Visibility.Collapsed;
        EngineInfoBar.IsOpen = true;
    }

    private void OnEngineStateChanged()
    {
        if (AppHost.IsReady)
        {
            EngineInfoBar.IsOpen = false;
            var engine = AppHost.Engine!;
            engine.DocumentChanged -= OnDocumentChanged;
            engine.DocumentChanged += OnDocumentChanged;
            engine.DocumentRemoved -= OnDocumentRemoved;
            engine.DocumentRemoved += OnDocumentRemoved;
            _badgeTimer.Start();
            if (_pendingFiles.Count > 0)
            {
                var files = _pendingFiles.ToList();
                _pendingFiles.Clear();
                Navigate(typeof(NewDocumentPage), files);
            }
            else if (ContentFrame.Content is null)
            {
                Navigate(typeof(LibraryPage));
            }
            return;
        }

        EngineInfoBar.Title = "处理引擎未运行";
        EngineInfoBar.Message = AppHost.StartupError ?? "";
        EngineInfoBar.Severity = InfoBarSeverity.Error;
        EngineRetryButton.Visibility = Visibility.Visible;
        EngineInfoBar.IsOpen = true;
        if (ContentFrame.Content is null)
        {
            Navigate(typeof(LibraryPage));
        }
    }

    private async void OnRestartEngine(object sender, RoutedEventArgs e)
    {
        ShowStarting();
        await AppHost.StartEngineAsync(DispatcherQueue);
    }

    private void OnDocumentChanged(string id)
    {
        _badgeTimer.Stop();
        _badgeTimer.Start();
        _ = NotifyIfFinishedAsync(id);
    }

    private void OnDocumentRemoved(string id)
    {
        _knownStatus.Remove(id);
        _badgeTimer.Stop();
        _badgeTimer.Start();
    }

    private async Task RefreshBadgeAsync()
    {
        try
        {
            var list = await AppHost.RequireEngine().CallAsync<DocumentList>("documents.list", new { limit = 1 });
            ActiveBadge.Value = (int)list.Counts.Active;
            ActiveBadge.Visibility = list.Counts.Active > 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        catch (EngineException)
        {
            ActiveBadge.Visibility = Visibility.Collapsed;
        }
    }

    /// <summary>A toast when a document finishes while the app is in the background.</summary>
    private async Task NotifyIfFinishedAsync(string id)
    {
        try
        {
            var document = await AppHost.RequireEngine().CallAsync<DocumentInfo>("documents.get", new { id });
            var previous = _knownStatus.GetValueOrDefault(id);
            _knownStatus[id] = document.Status;
            var finished = document.Status is "completed" or "failed";
            if (!finished || previous is null || previous == document.Status || !_notificationsRegistered)
            {
                return;
            }
            if (GetForegroundWindow() == App.WindowHandle)
            {
                return;
            }
            var builder = new AppNotificationBuilder()
                .AddArgument("document", id)
                .AddText(document.Status == "completed" ? "翻译完成" : "处理失败")
                .AddText(document.Title);
            AppNotificationManager.Default.Show(builder.BuildNotification());
        }
        catch (Exception)
        {
            // Notifications are best-effort.
        }
    }

    private void RegisterNotifications()
    {
        try
        {
            AppNotificationManager.Default.NotificationInvoked += (_, args) =>
            {
                DispatcherQueue.TryEnqueue(() =>
                {
                    BringToFront();
                    if (args.Arguments.TryGetValue("document", out var id))
                    {
                        Navigate(typeof(DocumentPage), id);
                    }
                });
            };
            AppNotificationManager.Default.Register();
            _notificationsRegistered = true;
        }
        catch (Exception)
        {
            _notificationsRegistered = false;
        }
    }

    private void OnNavigationSelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (args.IsSettingsSelected)
        {
            Navigate(typeof(SettingsPage));
        }
        else if (args.SelectedItem is NavigationViewItem { Tag: string tag })
        {
            Navigate(tag == "new" ? typeof(NewDocumentPage) : typeof(LibraryPage));
        }
    }

    private void OnNavigated(object sender, NavigationEventArgs e)
    {
        AppTitleBar.IsBackButtonEnabled = ContentFrame.CanGoBack;
        var selected = e.SourcePageType == typeof(SettingsPage)
            ? NavView.SettingsItem
            : e.SourcePageType == typeof(NewDocumentPage) ? NewItem : LibraryItem;
        if (!ReferenceEquals(NavView.SelectedItem, selected))
        {
            NavView.SelectionChanged -= OnNavigationSelectionChanged;
            NavView.SelectedItem = selected;
            NavView.SelectionChanged += OnNavigationSelectionChanged;
        }
    }

    private void OnBackRequested(TitleBar sender, object args)
    {
        if (ContentFrame.CanGoBack)
        {
            ContentFrame.GoBack();
        }
    }

    private void OnPaneToggleRequested(TitleBar sender, object args)
    {
        NavView.IsPaneOpen = !NavView.IsPaneOpen;
    }

    private void OnSearchTextChanged(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args)
    {
        if (args.Reason == AutoSuggestionBoxTextChangeReason.UserInput)
        {
            _searchTimer.Stop();
            _searchTimer.Start();
        }
    }

    private void OnSearchSubmitted(AutoSuggestBox sender, AutoSuggestBoxQuerySubmittedEventArgs args)
    {
        _searchTimer.Stop();
        ApplySearch();
    }

    private void ApplySearch()
    {
        if (ContentFrame.CurrentSourcePageType != typeof(LibraryPage))
        {
            Navigate(typeof(LibraryPage));
        }
        SearchChanged?.Invoke(SearchBox.Text.Trim());
    }

    private void RestorePlacement()
    {
        var host = AppHost.Host;
        var scale = GetDpiForWindow(App.WindowHandleFor(this)) / 96.0;
        AppWindow.Resize(new SizeInt32((int)(host.WindowWidth * scale), (int)(host.WindowHeight * scale)));
        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.PreferredMinimumWidth = (int)(880 * scale);
            presenter.PreferredMinimumHeight = (int)(600 * scale);
            if (host.WindowMaximized)
            {
                presenter.Maximize();
            }
        }
    }

    private bool _closing;

    /// <summary>
    /// Hides the window at once and stops the engine without blocking the UI
    /// thread; running jobs resume from their checkpoints on the next launch.
    /// </summary>
    private async void OnClosing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        if (_closing)
        {
            return;
        }
        args.Cancel = true;
        _closing = true;
        SavePlacement();
        AppWindow.Hide();
        try
        {
            await AppHost.StopEngineAsync();
        }
        catch (Exception error)
        {
            AppLog.Error("engine shutdown", error);
        }
        Close();
    }

    private void SavePlacement()
    {
        var host = AppHost.Host;
        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            host.WindowMaximized = presenter.State == OverlappedPresenterState.Maximized;
            if (presenter.State == OverlappedPresenterState.Restored)
            {
                var scale = GetDpiForWindow(App.WindowHandleFor(this)) / 96.0;
                host.WindowWidth = (int)(AppWindow.Size.Width / scale);
                host.WindowHeight = (int)(AppWindow.Size.Height / scale);
            }
        }
        host.Save();
    }

    private void OnClosed(object sender, WindowEventArgs args)
    {
        if (_notificationsRegistered)
        {
            try
            {
                AppNotificationManager.Default.Unregister();
            }
            catch (Exception)
            {
                // Ignore; the process is exiting.
            }
        }
    }

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr hwnd);
}
