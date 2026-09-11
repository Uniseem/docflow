using DocFlow.Services;
using DocFlow.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;

namespace DocFlow.Views;

public sealed partial class LibraryPage : Page
{
    public LibraryPage()
    {
        InitializeComponent();
    }

    public LibraryViewModel ViewModel { get; } = new();

    protected override async void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        App.Window.SearchChanged += OnSearchChanged;
        AppHost.EngineStateChanged += OnEngineStateChanged;
        ViewModel.Query = App.Window.SearchText.Trim();
        ViewModel.Attach();
        await ViewModel.LoadAsync();
        UpdateFilterLabels();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        App.Window.SearchChanged -= OnSearchChanged;
        AppHost.EngineStateChanged -= OnEngineStateChanged;
        ViewModel.Detach();
    }

    private async void OnEngineStateChanged()
    {
        ViewModel.Attach();
        await ViewModel.LoadAsync();
        UpdateFilterLabels();
    }

    private async void OnSearchChanged(string query)
    {
        ViewModel.Query = query;
        await ViewModel.LoadAsync();
    }

    private async void OnFilterChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
    {
        ViewModel.Filter = sender.SelectedItem?.Tag as string ?? "all";
        await ViewModel.LoadAsync();
        UpdateFilterLabels();
    }

    private void UpdateFilterLabels()
    {
        var counts = ViewModel.Counts;
        AllFilter.Text = counts.All > 0 ? $"全部 {counts.All}" : "全部";
        ActiveFilter.Text = counts.Active > 0 ? $"进行中 {counts.Active}" : "进行中";
        CompletedFilter.Text = counts.Completed > 0 ? $"已完成 {counts.Completed}" : "已完成";
        FailedFilter.Text = counts.Failed > 0 ? $"失败与取消 {counts.Failed}" : "失败与取消";
    }

    private async void OnRefresh(object sender, RoutedEventArgs e)
    {
        await ViewModel.LoadAsync();
        UpdateFilterLabels();
    }

    private void OnNewDocument(object sender, RoutedEventArgs e) =>
        App.Window.Navigate(typeof(NewDocumentPage));

    private void OnItemClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is DocumentItemViewModel item)
        {
            App.Window.Navigate(typeof(DocumentPage), item.Id);
        }
    }

    private void OnOpenItem(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { Tag: string id })
        {
            App.Window.Navigate(typeof(DocumentPage), id);
        }
    }

    private void OnRevealItem(object sender, RoutedEventArgs e)
    {
        if (Find(sender)?.Info.Files is { } files && (files.ArchiveDir ?? files.Source) is { } path)
        {
            ShellService.Reveal(path);
        }
    }

    private async void OnRetryItem(object sender, RoutedEventArgs e) => await Run(sender, "documents.retry");

    private async void OnCancelItem(object sender, RoutedEventArgs e) => await Run(sender, "documents.cancel");

    private async void OnDeleteItem(object sender, RoutedEventArgs e)
    {
        if (Find(sender) is not { } item)
        {
            return;
        }
        if (await Dialogs.ConfirmDeleteAsync(XamlRoot, item.Title))
        {
            await Run(sender, "documents.delete");
        }
    }

    private DocumentItemViewModel? Find(object sender) =>
        sender is FrameworkElement { Tag: string id } ? ViewModel.Items.FirstOrDefault(item => item.Id == id) : null;

    private async Task Run(object sender, string method)
    {
        if (sender is not FrameworkElement { Tag: string id })
        {
            return;
        }
        try
        {
            await AppHost.RequireEngine().CallAsync(method, new { id });
        }
        catch (EngineException error)
        {
            await Dialogs.ShowErrorAsync(XamlRoot, "操作失败", error.Message);
        }
    }

    private void OnDragOver(object sender, DragEventArgs e)
    {
        if (e.DataView.Contains(StandardDataFormats.StorageItems))
        {
            e.AcceptedOperation = DataPackageOperation.Copy;
            e.DragUIOverride.Caption = "添加到 DocFlow";
            DropOverlay.Visibility = Visibility.Visible;
        }
    }

    private void OnDragLeave(object sender, DragEventArgs e) => DropOverlay.Visibility = Visibility.Collapsed;

    private async void OnDrop(object sender, DragEventArgs e)
    {
        DropOverlay.Visibility = Visibility.Collapsed;
        if (!e.DataView.Contains(StandardDataFormats.StorageItems))
        {
            return;
        }
        var items = await e.DataView.GetStorageItemsAsync();
        var paths = items.OfType<StorageFile>().Select(file => file.Path).Where(path => !string.IsNullOrEmpty(path)).ToList();
        if (paths.Count > 0)
        {
            App.Window.Navigate(typeof(NewDocumentPage), paths);
        }
    }

    public string EmptyTitle(bool libraryEmpty) => libraryEmpty ? "还没有文档" : "没有符合条件的文档";

    public string EmptyDetail(bool libraryEmpty) => libraryEmpty
        ? "把 PDF、Word、PowerPoint 或图片拖到这里，或选择文件开始翻译。"
        : "试试其他筛选条件或搜索词。";

    public bool HasError(string? error) => !string.IsNullOrEmpty(error);
}
