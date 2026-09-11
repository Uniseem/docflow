using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using DocFlow.Helpers;
using DocFlow.Services;
using Microsoft.UI.Dispatching;

namespace DocFlow.ViewModels;

public sealed partial class StageItemViewModel : ObservableObject
{
    public string Title { get; init; } = "";
    public string Caption { get; init; } = "";

    [ObservableProperty]
    public partial string State { get; set; } = "wait";

    public bool IsDone => State == "finish";
    public bool IsCurrent => State == "process";
    public bool IsError => State == "error";
    public bool IsWaiting => State == "wait";

    partial void OnStateChanged(string value)
    {
        OnPropertyChanged(nameof(IsDone));
        OnPropertyChanged(nameof(IsCurrent));
        OnPropertyChanged(nameof(IsError));
        OnPropertyChanged(nameof(IsWaiting));
    }
}

public sealed class EventItemViewModel(ProcessingEvent source, DateTimeOffset createdAt)
{
    public ProcessingEvent Source { get; } = source;
    public string Message => Source.Message;
    public string? Detail => Source.Detail;
    public string Time => Format.Time(Source.CreatedAt);
    public string Elapsed => "+" + Format.Duration(Source.CreatedAt - createdAt);
    public string Progress => $"{Source.Progress}%";
    public bool IsAttention => Source.Level is "warning" or "error";
    public bool IsError => Source.Level == "error";
    public bool IsWarning => Source.Level == "warning";
    public bool IsSuccess => Source.Level == "success";
    public bool IsInfo => Source.Level is not ("error" or "warning" or "success");

    public string Counter
    {
        get
        {
            if (Source.Current is not { } current)
            {
                return "";
            }
            var bytes = Source.Stage.Contains("download") || Source.Stage is "source_saved" or "source_verified";
            string Show(long value) => bytes ? Format.Size(value) : value.ToString();
            return Source.Total is { } total ? $"{Show(current)} / {Show(total)}" : Show(current);
        }
    }
}

public sealed partial class DocumentViewModel : ObservableObject
{
    // Ascending by id. Live notifications can arrive while history is still
    // loading, so events are de-duplicated and inserted in order.
    private readonly List<EventItemViewModel> _allEvents = [];
    private readonly HashSet<long> _seen = [];
    private readonly DispatcherQueueTimer _clock;
    private EngineClient? _engine;
    private long _latest;

    public DocumentViewModel(DispatcherQueue dispatcher)
    {
        _clock = dispatcher.CreateTimer();
        _clock.Interval = TimeSpan.FromSeconds(1);
        _clock.Tick += (_, _) => UpdateElapsed();
    }

    public string Id { get; private set; } = "";

    public ObservableCollection<EventItemViewModel> Events { get; } = [];

    public ObservableCollection<StageItemViewModel> Stages { get; } = [];

    [ObservableProperty]
    public partial DocumentInfo? Document { get; set; }

    [ObservableProperty]
    public partial string Title { get; set; } = "";

    [ObservableProperty]
    public partial string Subtitle { get; set; } = "";

    [ObservableProperty]
    public partial string StatusText { get; set; } = "";

    [ObservableProperty]
    public partial string ElapsedText { get; set; } = "";

    [ObservableProperty]
    public partial string CurrentMessage { get; set; } = "";

    [ObservableProperty]
    public partial string? CurrentDetail { get; set; }

    [ObservableProperty]
    public partial int Progress { get; set; }

    [ObservableProperty]
    public partial bool IsActive { get; set; }

    [ObservableProperty]
    public partial bool IsCompleted { get; set; }

    [ObservableProperty]
    public partial bool IsStopped { get; set; }

    [ObservableProperty]
    public partial bool IsNative { get; set; }

    [ObservableProperty]
    public partial bool IsLoaded { get; set; }

    [ObservableProperty]
    public partial string? LoadError { get; set; }

    [ObservableProperty]
    public partial bool OnlyAttention { get; set; }

    [ObservableProperty]
    public partial long EventTotal { get; set; }

    public event Action? DocumentUpdated;

    partial void OnOnlyAttentionChanged(bool value) => RebuildEvents();

    public async Task LoadAsync(string id)
    {
        if (Id != id)
        {
            Id = id;
            _allEvents.Clear();
            _seen.Clear();
            Events.Clear();
            _latest = 0;
            Document = null;
            IsLoaded = false;
        }
        LoadError = null;
        Attach();
        try
        {
            await RefreshDocumentAsync();
            await LoadEventsAsync();
            IsLoaded = true;
        }
        catch (EngineException error)
        {
            LoadError = error.Message;
        }
    }

    public void Attach()
    {
        Detach();
        _engine = AppHost.Engine;
        if (_engine is null)
        {
            return;
        }
        _engine.EventReceived += OnEvent;
        _engine.DocumentChanged += OnDocumentChanged;
    }

    public void Detach()
    {
        _clock.Stop();
        if (_engine is null)
        {
            return;
        }
        _engine.EventReceived -= OnEvent;
        _engine.DocumentChanged -= OnDocumentChanged;
        _engine = null;
    }

    public async Task RefreshDocumentAsync()
    {
        var document = await AppHost.RequireEngine().CallAsync<DocumentInfo>("documents.get", new { id = Id });
        Apply(document);
    }

    private async Task LoadEventsAsync()
    {
        var engine = AppHost.RequireEngine();
        long after = 0;
        while (true)
        {
            var page = await engine.CallAsync<EventList>("documents.events", new { id = Id, after_id = after, limit = 2000 });
            foreach (var item in page.Items)
            {
                Add(item);
            }
            EventTotal = Math.Max(page.Total, _allEvents.Count);
            after = page.NextAfterId;
            if (!page.HasMore || page.Items.Count == 0)
            {
                break;
            }
        }
    }

    private void Apply(DocumentInfo document)
    {
        Document = document;
        Title = document.Title;
        IsNative = document.IsNative;
        IsActive = document.IsActive;
        IsCompleted = document.Status == "completed";
        IsStopped = document.Status is "failed" or "cancelled";
        Progress = document.Progress;
        StatusText = Format.Status(document.Status);
        var parts = new List<string>
        {
            Format.Mode(document.ProcessingMode),
            Format.Translator(document.TranslatorLabel, document.TranslationTier),
            Format.Size(document.SourceSize),
        };
        if (document.PagesTotal is { } pages)
        {
            parts.Add($"{pages} 页");
        }
        if (!document.IsNative && document.ImageCount > 0)
        {
            parts.Add($"{document.ImageCount} 张图片");
        }
        parts.Add(Format.Date(document.CreatedAt));
        Subtitle = string.Join(" · ", parts);
        if (IsStopped && !string.IsNullOrEmpty(document.FailureReason))
        {
            CurrentDetail = document.FailureReason;
        }
        UpdateStages();
        UpdateElapsed();
        if (IsActive)
        {
            _clock.Start();
        }
        else
        {
            _clock.Stop();
        }
        DocumentUpdated?.Invoke();
    }

    private void Add(ProcessingEvent processingEvent)
    {
        if (!_seen.Add(processingEvent.Id))
        {
            return;
        }
        var item = new EventItemViewModel(processingEvent, Document?.CreatedAt ?? processingEvent.CreatedAt);
        var index = _allEvents.FindLastIndex(existing => existing.Source.Id < processingEvent.Id) + 1;
        _allEvents.Insert(index, item);
        EventTotal = Math.Max(EventTotal, _allEvents.Count);
        if (!OnlyAttention || item.IsAttention)
        {
            // The visible list is newest first.
            var position = Events.TakeWhile(existing => existing.Source.Id > processingEvent.Id).Count();
            Events.Insert(position, item);
        }
        if (processingEvent.Id > _latest)
        {
            _latest = processingEvent.Id;
            CurrentMessage = processingEvent.Message;
            CurrentDetail = processingEvent.Detail;
        }
    }

    private void RebuildEvents()
    {
        Events.Clear();
        foreach (var item in Enumerable.Reverse(_allEvents).Where(item => !OnlyAttention || item.IsAttention))
        {
            Events.Add(item);
        }
    }

    private void OnEvent(ProcessingEvent processingEvent)
    {
        if (processingEvent.DocumentId != Id)
        {
            return;
        }
        Add(processingEvent);
        if (Document is { } document && document.IsActive)
        {
            document.Stage = processingEvent.Stage;
            document.Progress = Math.Max(document.Progress, processingEvent.Progress);
            Progress = document.Progress;
            UpdateStages();
        }
    }

    private async void OnDocumentChanged(string id)
    {
        if (id != Id)
        {
            return;
        }
        try
        {
            await RefreshDocumentAsync();
        }
        catch (EngineException)
        {
            // Deleted: the page navigates away on its own.
        }
    }

    private void UpdateElapsed()
    {
        if (Document is not { } document)
        {
            return;
        }
        var end = document.CompletedAt ?? (IsActive ? DateTimeOffset.Now : document.UpdatedAt);
        ElapsedText = (IsActive ? "已运行 " : "用时 ") + Format.Duration(end - document.CreatedAt);
    }

    private void UpdateStages()
    {
        if (Document is not { } document)
        {
            return;
        }
        var definitions = StageDefinitions(document);
        if (Stages.Count != definitions.Count || Stages.Select(stage => stage.Title).SequenceEqual(definitions.Select(d => d.Title)) is false)
        {
            Stages.Clear();
            foreach (var definition in definitions)
            {
                Stages.Add(new StageItemViewModel { Title = definition.Title, Caption = definition.Caption });
            }
        }
        var active = definitions.FindIndex(d => d.Prefix is { } prefix && (document.Stage == prefix || document.Stage.StartsWith(prefix + "_", StringComparison.Ordinal)));
        for (var index = 0; index < definitions.Count; index++)
        {
            var definition = definitions[index];
            string state;
            if (document.Status == "completed")
            {
                state = "finish";
            }
            else if (active >= 0)
            {
                state = index < active ? "finish" : index > active ? "wait" : IsStopped ? "error" : "process";
            }
            else if (IsStopped && document.Progress >= definition.Start && document.Progress <= definition.End)
            {
                state = "error";
            }
            else if (document.Progress > definition.End)
            {
                state = "finish";
            }
            else
            {
                state = document.Progress >= definition.Start && !IsStopped ? "process" : "wait";
            }
            Stages[index].State = state;
        }
    }

    private sealed record StageDefinition(string Title, string Caption, int Start, int End, string? Prefix = null);

    private static List<StageDefinition> StageDefinitions(DocumentInfo document)
    {
        var translation = Format.Translator(document.TranslatorLabel, document.TranslationTier);
        var stages = new List<StageDefinition> { new("接收与排队", "复制源文件并加入处理队列", 0, 4) };
        if (document.IsNative)
        {
            stages.Add(new("检查 PDF", "检查文本层，拒绝扫描件与加密文件", 5, 9, "pdf2zh_preflight"));
            stages.Add(new("分析版面", "BabelDOC 分析页面、段落与公式", 10, 29, "pdf2zh_layout"));
            stages.Add(new("翻译段落", $"{translation}，共享任务池并发翻译", 30, 79, "pdf2zh_translation"));
            stages.Add(new("排版译文", "保留页面版式，生成中文与双语 PDF", 80, 89, "pdf2zh_typesetting"));
            stages.Add(new("校验结果", "检查两份 PDF 的页数、尺寸与可读性", 90, 93, "pdf2zh_verified"));
        }
        else
        {
            stages.Add(new("MinerU 解析", "上传文档并等待逐页解析", 5, 52));
            stages.Add(new("获取结果", "下载并安全解压解析结果", 53, 64));
            stages.Add(new("图片本地化", "转换为 WebP 并改写引用", 65, 70));
            stages.Add(new("分段翻译", $"{translation}，并发翻译与无损校验", 71, 87));
            stages.Add(new("排版", "规范化 Markdown，生成阅读视图与期刊 PDF", 88, 93));
        }
        stages.Add(new("保存到文档库", "写入译文、PDF 与处理记录", 94, 100));
        return stages;
    }
}
