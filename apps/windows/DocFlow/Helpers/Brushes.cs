using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;

namespace DocFlow.Helpers;

/// <summary>Theme brushes chosen by state (also used from x:Bind).</summary>
public static class Brushes
{
    /// <summary>Critical for errors, success otherwise.</summary>
    public static Brush Status(bool error) =>
        (Brush)Application.Current.Resources[error ? "SystemFillColorCriticalBrush" : "SystemFillColorSuccessBrush"];

    /// <summary>Critical for errors, secondary text otherwise.</summary>
    public static Brush Message(bool error) =>
        (Brush)Application.Current.Resources[error ? "SystemFillColorCriticalBrush" : "TextFillColorSecondaryBrush"];
}
