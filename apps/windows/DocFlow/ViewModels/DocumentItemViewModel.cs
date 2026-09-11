using CommunityToolkit.Mvvm.ComponentModel;
using DocFlow.Helpers;
using DocFlow.Services;

namespace DocFlow.ViewModels;

/// <summary>One row of the document library.</summary>
public sealed partial class DocumentItemViewModel : ObservableObject
{
    public DocumentItemViewModel(DocumentInfo info)
    {
        Info = info;
        Update(info);
    }

    public DocumentInfo Info { get; private set; }

    public string Id => Info.Id;

    [ObservableProperty]
    public partial string Title { get; set; } = "";

    [ObservableProperty]
    public partial string Subtitle { get; set; } = "";

    [ObservableProperty]
    public partial string ModeGlyph { get; set; } = "";

    [ObservableProperty]
    public partial string StatusText { get; set; } = "";

    [ObservableProperty]
    public partial string StageText { get; set; } = "";

    [ObservableProperty]
    public partial int Progress { get; set; }

    [ObservableProperty]
    public partial bool IsActive { get; set; }

    [ObservableProperty]
    public partial bool IsCompleted { get; set; }

    [ObservableProperty]
    public partial bool IsFailed { get; set; }

    [ObservableProperty]
    public partial bool IsCancelled { get; set; }

    [ObservableProperty]
    public partial bool CanRetry { get; set; }

    public void Update(DocumentInfo info)
    {
        Info = info;
        Title = info.Title;
        ModeGlyph = Format.ModeGlyph(info.ProcessingMode);
        var size = Format.Size(info.SourceSize);
        var pages = info.PagesTotal is { } total ? $" · {total} 页" : "";
        Subtitle = $"{Format.Mode(info.ProcessingMode)} · {Format.Translator(info.TranslatorLabel, info.TranslationTier)} · {size}{pages} · {Format.RelativeDate(info.CreatedAt)}";
        Progress = info.Progress;
        IsActive = info.IsActive;
        IsCompleted = info.Status == "completed";
        IsFailed = info.Status == "failed";
        IsCancelled = info.Status == "cancelled";
        CanRetry = IsFailed || IsCancelled;
        StatusText = info.IsActive ? $"{Format.Status(info.Status)} · {info.Progress}%" : Format.Status(info.Status);
        if (!info.IsActive)
        {
            StageText = "";
        }
    }

    public void Apply(ProcessingEvent processingEvent)
    {
        if (!IsActive)
        {
            return;
        }
        Progress = Math.Max(Progress, processingEvent.Progress);
        StageText = processingEvent.Message;
        StatusText = $"{Format.Status(Info.Status == "queued" ? "processing" : Info.Status)} · {Progress}%";
    }
}
