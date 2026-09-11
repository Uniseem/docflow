using DocFlow.Services;
using DocFlow.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;

namespace DocFlow.Views;

public sealed partial class NewDocumentPage : Page
{
    private bool _defaultsLoaded;

    public NewDocumentPage()
    {
        InitializeComponent();
    }

    public NewDocumentViewModel ViewModel { get; } = new();

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        AppHost.SettingsChanged += OnSettingsChanged;
        if (!_defaultsLoaded && AppHost.Settings is not null)
        {
            ViewModel.LoadDefaults();
            _defaultsLoaded = true;
        }
        else if (AppHost.Settings is { } settings)
        {
            ViewModel.LoadTranslators(settings);
        }
        if (e.Parameter is IEnumerable<string> paths)
        {
            ViewModel.AddFiles(paths);
        }
        ViewModel.Refresh();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        AppHost.SettingsChanged -= OnSettingsChanged;
    }

    private void OnSettingsChanged()
    {
        if (!_defaultsLoaded && AppHost.Settings is not null)
        {
            ViewModel.LoadDefaults();
            _defaultsLoaded = true;
        }
        else if (AppHost.Settings is { } settings)
        {
            // Providers may have been added, renamed or disabled meanwhile.
            ViewModel.LoadTranslators(settings);
        }
        ViewModel.Refresh();
    }

    private async void OnPickFiles(object sender, RoutedEventArgs e)
    {
        var extensions = (AppHost.Settings?.Capabilities.MineruExtensions ?? [".pdf"]).ToList();
        var paths = await ShellService.PickDocumentsAsync(extensions);
        if (paths.Count > 0)
        {
            ViewModel.AddFiles(paths);
        }
    }

    private void OnRemoveFile(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { Tag: PendingFile file })
        {
            ViewModel.Remove(file);
        }
    }

    private void OnClear(object sender, RoutedEventArgs e) => ViewModel.Clear();

    private void OnOpenSettings(object sender, RoutedEventArgs e) => App.Window.Navigate(typeof(SettingsPage));

    private async void OnSubmit(object sender, RoutedEventArgs e)
    {
        var created = await ViewModel.SubmitAsync();
        if (created.Count == 1 && ViewModel.Files.Count == 0)
        {
            App.Window.Navigate(typeof(DocumentPage), created[0]);
        }
        else if (created.Count > 1 && ViewModel.Files.Count == 0)
        {
            App.Window.Navigate(typeof(LibraryPage));
        }
    }

    private void OnDragOver(object sender, DragEventArgs e)
    {
        if (e.DataView.Contains(StandardDataFormats.StorageItems))
        {
            e.AcceptedOperation = DataPackageOperation.Copy;
            e.DragUIOverride.Caption = "添加文件";
            DropZone.BorderBrush = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["AccentFillColorDefaultBrush"];
        }
    }

    private void OnDragLeave(object sender, DragEventArgs e) => DropZone.ClearValue(Border.BorderBrushProperty);

    private async void OnDrop(object sender, DragEventArgs e)
    {
        DropZone.ClearValue(Border.BorderBrushProperty);
        if (!e.DataView.Contains(StandardDataFormats.StorageItems))
        {
            return;
        }
        var items = await e.DataView.GetStorageItemsAsync();
        var paths = items.OfType<StorageFile>().Select(file => file.Path).Where(path => !string.IsNullOrEmpty(path)).ToList();
        ViewModel.AddFiles(paths);
    }

    public bool HasText(string? value) => !string.IsNullOrWhiteSpace(value);
}
