using DocFlow.Services;
using DocFlow.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using Microsoft.Web.WebView2.Core;

namespace DocFlow.Views;

public sealed partial class DocumentPage : Page
{
    private const string LibraryHost = "library.docflow";
    private bool _webViewReady;
    private string? _viewSignature;
    private string _currentView = "";

    public DocumentPage()
    {
        InitializeComponent();
        ViewModel = new DocumentViewModel(DispatcherQueue);
        ViewModel.DocumentUpdated += OnDocumentUpdated;
        ActualThemeChanged += (_, _) => ApplyWebTheme();
    }

    public DocumentViewModel ViewModel { get; }

    protected override async void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        if (AppHost.Engine is { } engine)
        {
            engine.DocumentRemoved += OnDocumentRemoved;
        }
        if (e.Parameter is string id)
        {
            await ViewModel.LoadAsync(id);
        }
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        ViewModel.Detach();
        if (AppHost.Engine is { } engine)
        {
            engine.DocumentRemoved -= OnDocumentRemoved;
        }
    }

    private void OnDocumentRemoved(string id)
    {
        if (id == ViewModel.Id && Frame.CanGoBack)
        {
            Frame.GoBack();
        }
    }

    // -- Views ------------------------------------------------------------

    private void OnDocumentUpdated()
    {
        var document = ViewModel.Document;
        if (document is null)
        {
            return;
        }
        var files = document.Files ?? new DocumentFiles();
        var signature = $"{document.Status}|{files.ReaderHtml}|{files.MonoPdf}|{files.DualPdf}|{files.JournalPdf}";
        if (signature == _viewSignature)
        {
            return;
        }
        _viewSignature = signature;
        BuildExportMenu(document);
        if (document.Status != "completed")
        {
            return;
        }

        ViewBar.Items.Clear();
        void AddView(string tag, string text, string glyph)
        {
            ViewBar.Items.Add(new SelectorBarItem { Tag = tag, Text = text, Icon = new FontIcon { Glyph = glyph } });
        }
        if (document.IsNative)
        {
            if (files.MonoPdf is not null) AddView("mono", "中文 PDF", "\uEA90");
            if (files.DualPdf is not null) AddView("dual", "双语对照", "\uE89A");
        }
        else
        {
            if (files.ReaderHtml is not null) AddView("reader", "阅读", "\uE736");
            if (files.JournalPdf is not null) AddView("journal", "期刊 PDF", "\uEA90");
        }
        AddView("log", "处理记录", "\uE81C");
        var preferred = ViewBar.Items.FirstOrDefault(item => (string)item.Tag == _currentView) ?? ViewBar.Items[0];
        ViewBar.SelectedItem = preferred;
        _ = ShowViewAsync((string)preferred.Tag);
    }

    private async void OnViewChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
    {
        if (sender.SelectedItem?.Tag is string tag)
        {
            await ShowViewAsync(tag);
        }
    }

    private async Task ShowViewAsync(string tag)
    {
        _currentView = tag;
        var files = ViewModel.Document?.Files;
        SerifToggle.Visibility = tag == "reader" ? Visibility.Visible : Visibility.Collapsed;
        SerifToggle.IsChecked = AppHost.Host.ReaderSerif;
        if (tag == "log" || files is null)
        {
            ViewerHost.Visibility = Visibility.Collapsed;
            LogHost.Visibility = Visibility.Visible;
            return;
        }
        LogHost.Visibility = Visibility.Collapsed;
        ViewerHost.Visibility = Visibility.Visible;
        var path = tag switch
        {
            "reader" => files.ReaderHtml,
            "mono" => files.MonoPdf,
            "dual" => files.DualPdf,
            "journal" => files.JournalPdf,
            _ => null,
        };
        if (path is null || !await EnsureWebViewAsync())
        {
            return;
        }
        if (LibraryUri(path) is { } uri)
        {
            Viewer.Source = uri;
        }
    }

    private async Task<bool> EnsureWebViewAsync()
    {
        if (_webViewReady)
        {
            return true;
        }
        try
        {
            await Viewer.EnsureCoreWebView2Async();
            var core = Viewer.CoreWebView2;
            core.SetVirtualHostNameToFolderMapping(LibraryHost, AppHost.DataDir, CoreWebView2HostResourceAccessKind.Allow);
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.NavigationStarting += OnNavigationStarting;
            core.NewWindowRequested += OnNewWindowRequested;
            core.NavigationCompleted += (_, _) => ApplyReaderFont();
            _webViewReady = true;
            ApplyWebTheme();
            return true;
        }
        catch (Exception error)
        {
            await Dialogs.ShowErrorAsync(XamlRoot, "无法显示文档", $"需要 Microsoft Edge WebView2 运行时。{error.Message}");
            return false;
        }
    }

    private static Uri? LibraryUri(string path)
    {
        var relative = Path.GetRelativePath(AppHost.DataDir, path);
        if (relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relative))
        {
            return null;
        }
        var segments = relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Select(Uri.EscapeDataString);
        return new Uri($"https://{LibraryHost}/{string.Join('/', segments)}");
    }

    /// <summary>Links inside an article open in the default browser.</summary>
    private void OnNavigationStarting(CoreWebView2 sender, CoreWebView2NavigationStartingEventArgs args)
    {
        if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) && uri.Host != LibraryHost)
        {
            args.Cancel = true;
            if (uri.Scheme is "http" or "https" or "mailto")
            {
                ShellService.OpenUri(uri);
            }
        }
    }

    private void OnNewWindowRequested(CoreWebView2 sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        args.Handled = true;
        if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
        {
            ShellService.OpenUri(uri);
        }
    }

    private void ApplyWebTheme()
    {
        if (!_webViewReady)
        {
            return;
        }
        Viewer.CoreWebView2.Profile.PreferredColorScheme = ActualTheme == ElementTheme.Dark
            ? CoreWebView2PreferredColorScheme.Dark
            : CoreWebView2PreferredColorScheme.Light;
    }

    private void OnSerifToggled(object sender, RoutedEventArgs e)
    {
        AppHost.Host.ReaderSerif = SerifToggle.IsChecked == true;
        AppHost.Host.Save();
        ApplyReaderFont();
    }

    private async void ApplyReaderFont()
    {
        if (_webViewReady && _currentView == "reader")
        {
            var enabled = AppHost.Host.ReaderSerif ? "true" : "false";
            await Viewer.CoreWebView2.ExecuteScriptAsync($"document.documentElement.classList.toggle('serif', {enabled});");
        }
    }

    // -- Commands -----------------------------------------------------------

    private void BuildExportMenu(DocumentInfo document)
    {
        ExportMenu.Items.Clear();
        var files = document.Files ?? new DocumentFiles();
        var names = document.SuggestedNames ?? new SuggestedNames();
        void Add(string text, string? path, string name, string label, string extension)
        {
            if (path is null)
            {
                return;
            }
            var item = new MenuFlyoutItem { Text = text };
            item.Click += async (_, _) => await SaveCopyAsync(path, name, label, extension);
            ExportMenu.Items.Add(item);
        }
        Add("中文 PDF…", files.MonoPdf, names.MonoPdf, "PDF 文档", ".pdf");
        Add("双语对照 PDF…", files.DualPdf, names.DualPdf, "PDF 文档", ".pdf");
        Add("期刊排版 PDF…", files.JournalPdf, names.JournalPdf, "PDF 文档", ".pdf");
        Add("Markdown 译文…", files.Markdown, names.Markdown, "Markdown", ".md");
        if (ExportMenu.Items.Count > 0)
        {
            ExportMenu.Items.Add(new MenuFlyoutSeparator());
        }
        Add("源文件…", files.Source, names.Source, "原始文件", Path.GetExtension(names.Source));
        var bundle = new MenuFlyoutItem { Text = "全部文件（ZIP）…" };
        bundle.Click += async (_, _) => await ExportBundleAsync(names.Bundle);
        ExportMenu.Items.Add(bundle);
    }

    private async Task SaveCopyAsync(string source, string name, string label, string extension)
    {
        var destination = await ShellService.PickSaveLocationAsync(name, label, extension);
        if (destination is null)
        {
            return;
        }
        try
        {
            File.Copy(source, destination, overwrite: true);
        }
        catch (Exception error)
        {
            await Dialogs.ShowErrorAsync(XamlRoot, "导出失败", error.Message);
        }
    }

    private async Task ExportBundleAsync(string name)
    {
        var destination = await ShellService.PickSaveLocationAsync(name, "ZIP 压缩包", ".zip");
        if (destination is null)
        {
            return;
        }
        try
        {
            await AppHost.RequireEngine().CallAsync<ExportResult>("documents.exportBundle", new { id = ViewModel.Id, destination });
            ShellService.Reveal(destination);
        }
        catch (EngineException error)
        {
            await Dialogs.ShowErrorAsync(XamlRoot, "导出失败", error.Message);
        }
    }

    private void OnOpenPrimary(object sender, RoutedEventArgs e)
    {
        var files = ViewModel.Document?.Files;
        var path = _currentView switch
        {
            "dual" => files?.DualPdf,
            "journal" => files?.JournalPdf,
            "reader" => files?.JournalPdf ?? files?.ReaderHtml,
            _ => files?.MonoPdf ?? files?.JournalPdf,
        };
        if (path is not null)
        {
            ShellService.Open(path);
        }
    }

    private void OnReveal(object sender, RoutedEventArgs e)
    {
        var files = ViewModel.Document?.Files;
        if ((files?.MonoPdf ?? files?.JournalPdf ?? files?.Source ?? files?.ArchiveDir) is { } path)
        {
            ShellService.Reveal(path);
        }
    }

    private async void OnRetry(object sender, RoutedEventArgs e) => await RunAsync("documents.retry");

    private async void OnCancel(object sender, RoutedEventArgs e)
    {
        if (await Dialogs.ConfirmAsync(XamlRoot, "取消处理？", "正在进行的解析、翻译或排版会停止。源文件和已完成的翻译断点会保留，之后可以重新处理。", "取消处理"))
        {
            await RunAsync("documents.cancel");
        }
    }

    private async void OnRename(object sender, RoutedEventArgs e)
    {
        var title = await Dialogs.PromptAsync(XamlRoot, "重命名", "标题", ViewModel.Title);
        if (!string.IsNullOrWhiteSpace(title) && title != ViewModel.Title)
        {
            try
            {
                await AppHost.RequireEngine().CallAsync("documents.rename", new { id = ViewModel.Id, title });
                await ViewModel.RefreshDocumentAsync();
            }
            catch (EngineException error)
            {
                await Dialogs.ShowErrorAsync(XamlRoot, "无法重命名", error.Message);
            }
        }
    }

    private async void OnDelete(object sender, RoutedEventArgs e)
    {
        if (await Dialogs.ConfirmDeleteAsync(XamlRoot, ViewModel.Title))
        {
            // Release any open PDF before the engine deletes the files.
            Viewer.Source = new Uri("about:blank");
            await RunAsync("documents.delete");
        }
    }

    private async Task RunAsync(string method)
    {
        try
        {
            await AppHost.RequireEngine().CallAsync(method, new { id = ViewModel.Id });
        }
        catch (EngineException error)
        {
            await Dialogs.ShowErrorAsync(XamlRoot, "操作失败", error.Message);
        }
    }

    // -- x:Bind helpers -----------------------------------------------------

    public string Percent(int progress) => $"{progress}%";

    public bool IsWaiting(bool active, int progress) => active && progress <= 3;

    public string ProgressTitle(bool active, string status) => active ? "处理进度" : status;

    public string LogTitle(long total) => total > 0 ? $"处理记录 · {total} 条" : "处理记录";

    public string FailureText(DocumentInfo? document) => document?.FailureReason ?? "";

    public bool HasText(string? value) => !string.IsNullOrWhiteSpace(value);
}
