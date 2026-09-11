using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace DocFlow;

/// <summary>Standard content dialogs.</summary>
public static class Dialogs
{
    public static async Task<bool> ConfirmDeleteAsync(XamlRoot root, string title)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = root,
            Title = "删除文档？",
            Content = $"“{title}”及其源文件、译文和处理记录将从文档库中永久删除。",
            PrimaryButtonText = "删除",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Close,
        };
        return await dialog.ShowAsync() == ContentDialogResult.Primary;
    }

    public static async Task ShowErrorAsync(XamlRoot root, string title, string message)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = root,
            Title = title,
            Content = new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true },
            CloseButtonText = "确定",
            DefaultButton = ContentDialogButton.Close,
        };
        await dialog.ShowAsync();
    }

    public static async Task<string?> PromptAsync(XamlRoot root, string title, string label, string value)
    {
        var box = new TextBox { Header = label, Text = value, MinWidth = 360 };
        box.SelectAll();
        var dialog = new ContentDialog
        {
            XamlRoot = root,
            Title = title,
            Content = box,
            PrimaryButtonText = "保存",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Primary,
        };
        return await dialog.ShowAsync() == ContentDialogResult.Primary ? box.Text.Trim() : null;
    }

    public static async Task<bool> ConfirmAsync(XamlRoot root, string title, string message, string primary)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = root,
            Title = title,
            Content = new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap },
            PrimaryButtonText = primary,
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Primary,
        };
        return await dialog.ShowAsync() == ContentDialogResult.Primary;
    }
}
