using DocFlow.Services;
using DocFlow.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace DocFlow.Views;

public sealed partial class SettingsPage : Page
{
    // Presets by group, as ids from engine/src/providers.rs.
    private static readonly (string Title, string[] Ids)[] PresetGroups =
    [
        ("国内服务", ["deepseek", "siliconflow", "dashscope", "volcengine", "moonshot", "zhipu", "hunyuan", "stepfun", "lingyi"]),
        ("国际服务", ["openai", "anthropic", "gemini", "openrouter", "xai", "groq", "mistral", "azure"]),
        ("本机模型", ["ollama", "lmstudio"]),
    ];

    public SettingsPage()
    {
        InitializeComponent();
    }

    public SettingsViewModel ViewModel { get; } = new();

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        AppHost.SettingsChanged += OnSettingsChanged;
        ViewModel.Load();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        AppHost.SettingsChanged -= OnSettingsChanged;
    }

    // Keep unsaved edits of the advanced form; refresh everything else.
    private void OnSettingsChanged() => ViewModel.Load(keepRuntimeForm: true);

    private async void OnCheckGoogle(object sender, RoutedEventArgs e) => await ViewModel.CheckGoogleAsync();

    private void OnPresetMenuOpening(object sender, object e)
    {
        PresetMenu.Items.Clear();
        var presets = ViewModel.Presets.ToDictionary(preset => preset.Id);
        foreach (var (title, ids) in PresetGroups)
        {
            var group = new MenuFlyoutSubItem { Text = title };
            foreach (var id in ids)
            {
                if (presets.TryGetValue(id, out var preset))
                {
                    group.Items.Add(PresetItem(preset));
                }
            }
            if (group.Items.Count > 0)
            {
                PresetMenu.Items.Add(group);
            }
        }
        // Anything the engine knows that the groups above do not list.
        var listed = PresetGroups.SelectMany(group => group.Ids).Append("custom").ToHashSet();
        foreach (var preset in ViewModel.Presets.Where(preset => !listed.Contains(preset.Id)))
        {
            PresetMenu.Items.Add(PresetItem(preset));
        }
        PresetMenu.Items.Add(new MenuFlyoutSeparator());
        var custom = new MenuFlyoutItem { Text = "自定义服务商…", Icon = new FontIcon { Glyph = "\uE710" } };
        custom.Click += async (_, _) => await AddCustomProviderAsync();
        PresetMenu.Items.Add(custom);
    }

    private MenuFlyoutItem PresetItem(ProviderPreset preset)
    {
        var item = new MenuFlyoutItem { Text = preset.Name };
        item.Click += async (_, _) => await ViewModel.AddProviderAsync(preset);
        return item;
    }

    private async Task AddCustomProviderAsync()
    {
        var preset = ViewModel.Presets.FirstOrDefault(candidate => candidate.Id == "custom")
            ?? new ProviderPreset { Id = "custom", Name = "自定义服务商", Type = "openai" };
        var name = new TextBox { Header = "名称", PlaceholderText = "例如 公司网关", MaxLength = 64 };
        var type = new ComboBox { Header = "接口类型", HorizontalAlignment = HorizontalAlignment.Stretch };
        (string Id, string Label)[] types = [("openai", "OpenAI 兼容（最常见）"), ("anthropic", "Anthropic"), ("gemini", "Gemini"), ("azure", "Azure OpenAI")];
        foreach (var (_, label) in types)
        {
            type.Items.Add(label);
        }
        type.SelectedIndex = 0;
        var address = new TextBox
        {
            Header = "API 地址",
            PlaceholderText = "https://example.com/v1",
            InputScope = new Microsoft.UI.Xaml.Input.InputScope { Names = { new Microsoft.UI.Xaml.Input.InputScopeName(Microsoft.UI.Xaml.Input.InputScopeNameValue.Url) } },
        };
        var hint = new TextBlock
        {
            Text = "OpenAI 兼容接口填写到 /v1 为止（程序会在后面加 /chat/completions）。",
            TextWrapping = TextWrapping.Wrap,
            Style = (Style)Application.Current.Resources["SecondaryTextBlockStyle"],
        };
        var content = new StackPanel { Spacing = 12, MinWidth = 400 };
        content.Children.Add(name);
        content.Children.Add(type);
        content.Children.Add(address);
        content.Children.Add(hint);
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = "添加自定义服务商",
            Content = content,
            PrimaryButtonText = "添加",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Primary,
        };
        dialog.PrimaryButtonClick += (_, args) =>
        {
            if (string.IsNullOrWhiteSpace(name.Text) || !Uri.TryCreate(address.Text.Trim(), UriKind.Absolute, out var uri)
                || uri.Scheme is not ("http" or "https"))
            {
                hint.Text = "请填写名称和以 http:// 或 https:// 开头的 API 地址。";
                hint.Foreground = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["SystemFillColorCriticalBrush"];
                args.Cancel = true;
            }
        };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary)
        {
            await ViewModel.AddProviderAsync(preset, name.Text.Trim(), types[Math.Max(type.SelectedIndex, 0)].Id, address.Text.Trim());
        }
    }

    private async void OnApplyProxy(object sender, RoutedEventArgs e) => await ViewModel.SavePreferencesAsync();

    private async void OnSaveRuntime(object sender, RoutedEventArgs e) => await ViewModel.SaveRuntimeAsync();

    private void OnResetRuntime(object sender, RoutedEventArgs e) => ViewModel.ResetRuntime();

    private void OnOpenLibrary(object sender, RoutedEventArgs e) => ShellService.Reveal(AppHost.DataDir);

    private void OnOpenLogs(object sender, RoutedEventArgs e) =>
        ShellService.Reveal(Path.Combine(AppHost.DataDir, "logs"));

    private async void OnChangeLibrary(object sender, RoutedEventArgs e)
    {
        var folder = await ShellService.PickFolderAsync();
        if (folder is null || string.Equals(folder, AppHost.DataDir, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }
        var message = "DocFlow 会在新位置使用独立的文档库，现有文档保留在原位置，改回原位置即可再次看到。处理引擎将重新启动，进行中的任务会在下次打开对应文档库时继续。";
        if (!await Dialogs.ConfirmAsync(XamlRoot, "更改文档库位置？", message, "更改并重新启动引擎"))
        {
            return;
        }
        var target = Path.Combine(folder, "DocFlow");
        AppHost.Host.LibraryDir = target;
        AppHost.Host.Save();
        await AppHost.StartEngineAsync(DispatcherQueue);
        ViewModel.Load();
    }
}
