using DocFlow.Services;
using DocFlow.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace DocFlow.Controls;

/// <summary>Settings card for one large-model provider.</summary>
public sealed partial class ProviderEditor : UserControl
{
    public static readonly DependencyProperty ProviderProperty =
        DependencyProperty.Register(nameof(Provider), typeof(ProviderViewModel), typeof(ProviderEditor), new PropertyMetadata(null));

    public ProviderEditor()
    {
        InitializeComponent();
    }

    public ProviderViewModel Provider
    {
        get => (ProviderViewModel)GetValue(ProviderProperty);
        set => SetValue(ProviderProperty, value);
    }

    public double MaxConcurrency => AppHost.Settings?.TranslationRuntimeLimits.ProviderConcurrencyMax is > 0 and var max ? max : 2000;

    public Uri? KeyUri(string? url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri : null;

    private async void OnSaveKey(object sender, RoutedEventArgs e) => await Provider.SaveKeyAsync();

    private async void OnRemoveKey(object sender, RoutedEventArgs e) => await Provider.RemoveKeyAsync();

    private async void OnCommitText(object sender, RoutedEventArgs e) => await Provider.CommitTextAsync();

    private async void OnCheckModel(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { Tag: ModelItemViewModel model })
        {
            await Provider.CheckAsync(model);
        }
    }

    private async void OnRemoveModel(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { Tag: ModelItemViewModel model })
        {
            await Provider.RemoveModelAsync(model);
        }
    }

    private async void OnAddModel(object sender, RoutedEventArgs e)
    {
        var id = await Dialogs.PromptAsync(XamlRoot, "添加模型", "模型 ID（与服务商文档中的名称一致）", "");
        if (!string.IsNullOrWhiteSpace(id))
        {
            await Provider.AddModelsAsync([new ModelConfig { Id = id.Trim() }]);
        }
    }

    private async void OnDelete(object sender, RoutedEventArgs e)
    {
        var confirmed = await Dialogs.ConfirmAsync(
            XamlRoot,
            $"删除“{Provider.Name}”？",
            "服务商的设置和保存在 Windows 凭据管理器中的 API Key 会被删除。已经完成的文档不受影响；使用它排队中的文档将无法继续翻译。",
            "删除");
        if (confirmed)
        {
            await Provider.DeleteAsync();
        }
    }

    /// <summary>
    /// Fetches the provider's models and lets the user tick the ones to use;
    /// already added models start ticked.
    /// </summary>
    private async void OnFetchModels(object sender, RoutedEventArgs e)
    {
        if (await Provider.FetchModelsAsync() is not { } remote)
        {
            return;
        }
        var selected = Provider.Models.Select(model => model.Id).Where(id => remote.Any(model => model.Id == id)).ToHashSet();
        var search = new TextBox { PlaceholderText = $"在 {remote.Count} 个模型中搜索" };
        var list = new ListView
        {
            SelectionMode = ListViewSelectionMode.Multiple,
            Height = 380,
            MinWidth = 440,
            IsMultiSelectCheckBoxEnabled = true,
        };
        var count = new TextBlock { Style = (Style)Application.Current.Resources["SecondaryTextBlockStyle"] };
        var updating = false;

        void UpdateCount() => count.Text = $"已选择 {selected.Count} 个模型";

        void Fill()
        {
            updating = true;
            var query = search.Text.Trim();
            var visible = remote
                .Where(model => query.Length == 0
                    || model.Id.Contains(query, StringComparison.OrdinalIgnoreCase)
                    || (model.Name?.Contains(query, StringComparison.OrdinalIgnoreCase) ?? false))
                .ToList();
            list.Items.Clear();
            foreach (var model in visible)
            {
                var item = new ListViewItem { Tag = model.Id, Content = ModelRow(model) };
                list.Items.Add(item);
                if (selected.Contains(model.Id))
                {
                    list.SelectedItems.Add(item);
                }
            }
            updating = false;
        }

        list.SelectionChanged += (_, args) =>
        {
            if (updating)
            {
                return;
            }
            foreach (var item in args.AddedItems.OfType<ListViewItem>())
            {
                selected.Add((string)item.Tag);
            }
            foreach (var item in args.RemovedItems.OfType<ListViewItem>())
            {
                selected.Remove((string)item.Tag);
            }
            UpdateCount();
        };
        search.TextChanged += (_, _) => Fill();
        Fill();
        UpdateCount();

        var content = new StackPanel { Spacing = 8 };
        content.Children.Add(search);
        content.Children.Add(list);
        content.Children.Add(count);
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = $"{Provider.Name} 的模型",
            Content = content,
            PrimaryButtonText = "确定",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Primary,
        };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary)
        {
            await Provider.ApplyModelSelectionAsync(remote, selected);
        }
    }

    private static UIElement ModelRow(RemoteModel model)
    {
        var row = new StackPanel { Spacing = 1, Padding = new Thickness(0, 4, 0, 4) };
        row.Children.Add(new TextBlock { Text = model.Id, TextTrimming = TextTrimming.CharacterEllipsis });
        var details = new List<string>();
        if (!string.IsNullOrWhiteSpace(model.Name) && model.Name != model.Id)
        {
            details.Add(model.Name);
        }
        if (!string.IsNullOrWhiteSpace(model.Owner))
        {
            details.Add(model.Owner);
        }
        if (model.ContextLength is { } context)
        {
            details.Add($"上下文 {context / 1000:N0}K");
        }
        if (details.Count > 0)
        {
            row.Children.Add(new TextBlock
            {
                Text = string.Join(" · ", details),
                Style = (Style)Application.Current.Resources["SecondaryTextBlockStyle"],
                TextTrimming = TextTrimming.CharacterEllipsis,
            });
        }
        return row;
    }
}
