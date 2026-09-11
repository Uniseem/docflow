using DocFlow.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace DocFlow.Controls;

/// <summary>Settings row for one provider API key.</summary>
public sealed partial class SecretEditor : UserControl
{
    public static readonly DependencyProperty RowProperty =
        DependencyProperty.Register(nameof(Row), typeof(SecretRowViewModel), typeof(SecretEditor), new PropertyMetadata(null));

    public static readonly DependencyProperty ExtraProperty =
        DependencyProperty.Register(nameof(Extra), typeof(object), typeof(SecretEditor), new PropertyMetadata(null));

    public SecretEditor()
    {
        InitializeComponent();
    }

    public SecretRowViewModel Row
    {
        get => (SecretRowViewModel)GetValue(RowProperty);
        set => SetValue(RowProperty, value);
    }

    /// <summary>Optional extra settings shown under the key field.</summary>
    public object? Extra
    {
        get => GetValue(ExtraProperty);
        set => SetValue(ExtraProperty, value);
    }

    private async void OnSave(object sender, RoutedEventArgs e) => await Row.SaveAsync();

    private async void OnRemove(object sender, RoutedEventArgs e) => await Row.RemoveAsync();

    public string Placeholder(bool configured) => configured ? "输入新的 API Key 以替换" : "粘贴 API Key";

    public Visibility MessageVisible(string? message, bool isError, bool errorLine) =>
        !string.IsNullOrEmpty(message) && isError == errorLine ? Visibility.Visible : Visibility.Collapsed;
}
