using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using DocFlow.Helpers;
using DocFlow.Services;

namespace DocFlow.ViewModels;

public sealed partial class PendingFile : ObservableObject
{
    public PendingFile(string path)
    {
        Path = path;
        Name = System.IO.Path.GetFileName(path);
        Size = File.Exists(path) ? new FileInfo(path).Length : 0;
    }

    public string Path { get; }

    public string Name { get; }

    public long Size { get; }

    public string SizeText => Format.Size(Size);

    public string Glyph => Path.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase) ? "\uEA90" : "\uE8A5";

    [ObservableProperty]
    public partial string? Problem { get; set; }
}

public sealed partial class NewDocumentViewModel : ObservableObject
{
    public ObservableCollection<PendingFile> Files { get; } = [];

    public ObservableCollection<TranslatorOption> Translators { get; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsMineru), nameof(IsNative), nameof(AcceptedHint))]
    public partial string Mode { get; set; } = "pdf2zh";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(TranslatorDetail))]
    public partial TranslatorOption? Translator { get; set; }

    [ObservableProperty]
    public partial string Title { get; set; } = "";

    [ObservableProperty]
    public partial bool IsSubmitting { get; set; }

    [ObservableProperty]
    public partial string? Issue { get; set; }

    [ObservableProperty]
    public partial string? SubmitError { get; set; }

    [ObservableProperty]
    public partial bool CanSubmit { get; set; }

    [ObservableProperty]
    public partial bool HasFiles { get; set; }

    [ObservableProperty]
    public partial bool IsSingleFile { get; set; }

    [ObservableProperty]
    public partial bool LlmReady { get; set; }

    public bool IsMineru
    {
        get => Mode == "mineru";
        set
        {
            if (value)
            {
                Mode = "mineru";
            }
        }
    }

    public bool IsNative
    {
        get => Mode == "pdf2zh";
        set
        {
            if (value)
            {
                Mode = "pdf2zh";
            }
        }
    }

    public string TranslatorDetail => Translator?.Choice.Kind == "llm"
        ? "大模型翻译：理解上下文、术语更统一，适合精读；速度和费用取决于服务商和模型。"
        : "免费，无需 API Key，速度快，适合快速阅读。需要能访问 Google 的网络。";

    public string AcceptedHint => IsNative
        ? "仅支持带文本层的 PDF；扫描件请选择 MinerU 解析翻译"
        : "支持 PDF、Word、PowerPoint、Excel、图片与网页文件";

    public IReadOnlyList<string> AcceptedExtensions =>
        (IsNative ? AppHost.Settings?.Capabilities.Pdf2zhExtensions : AppHost.Settings?.Capabilities.MineruExtensions)
        ?? [".pdf"];

    public void LoadDefaults()
    {
        if (AppHost.Settings is not { } settings)
        {
            return;
        }
        Mode = settings.Preferences.DefaultMode;
        LoadTranslators(settings, settings.Preferences.DefaultTranslator.Key);
        Refresh();
    }

    /// <summary>Google plus every usable provider model; keeps the choice while it is offered.</summary>
    public void LoadTranslators(SettingsInfo settings, string? preferred = null)
    {
        var wanted = preferred ?? Translator?.Choice.Key ?? settings.Preferences.DefaultTranslator.Key;
        var options = settings.TranslatorOptions();
        if (!options.Select(option => (option.Choice.Key, option.Label)).SequenceEqual(Translators.Select(option => (option.Choice.Key, option.Label))))
        {
            Translators.Clear();
            foreach (var option in options)
            {
                Translators.Add(option);
            }
        }
        Translator = Translators.FirstOrDefault(option => option.Choice.Key == wanted) ?? Translators[0];
    }

    public void AddFiles(IEnumerable<string> paths)
    {
        foreach (var path in paths)
        {
            if (Files.All(file => !string.Equals(file.Path, path, StringComparison.OrdinalIgnoreCase)))
            {
                Files.Add(new PendingFile(path));
            }
        }
        if (Files.Count == 1 && string.IsNullOrWhiteSpace(Title))
        {
            Title = System.IO.Path.GetFileNameWithoutExtension(Files[0].Name);
        }
        // Office documents, images and web pages can only take the MinerU route.
        if (IsNative && Files.Any(file => !file.Path.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)))
        {
            Mode = "mineru";
        }
        Refresh();
    }

    public void Remove(PendingFile file)
    {
        Files.Remove(file);
        if (Files.Count != 1)
        {
            Title = "";
        }
        Refresh();
    }

    public void Clear()
    {
        Files.Clear();
        Title = "";
        SubmitError = null;
        Refresh();
    }

    partial void OnModeChanged(string value) => Refresh();

    partial void OnTranslatorChanged(TranslatorOption? value) => Refresh();

    public void Refresh()
    {
        var capabilities = AppHost.Settings?.Capabilities;
        LlmReady = capabilities?.LlmReady == true;
        var extensions = AcceptedExtensions;
        var maxBytes = (capabilities?.MaxUploadMb ?? 200) * 1024 * 1024;
        foreach (var file in Files)
        {
            var extension = System.IO.Path.GetExtension(file.Path).ToLowerInvariant();
            file.Problem = !File.Exists(file.Path)
                ? "文件不存在"
                : !extensions.Contains(extension)
                    ? IsNative ? "PDF 原生翻译只支持 .pdf 文件" : $"不支持 {(extension.Length > 0 ? extension : "无扩展名")} 文件"
                    : file.Size == 0
                        ? "文件为空"
                        : file.Size > maxBytes ? $"文件超过 {capabilities?.MaxUploadMb ?? 200} MB" : null;
        }

        Issue = capabilities is null
            ? "处理引擎尚未就绪"
            : IsMineru && !capabilities.MineruReady
                ? "MinerU 解析翻译需要先在设置中填写 MinerU API Key。"
                : IsNative && !capabilities.Pdf2zhReady
                    ? $"PDF 原生翻译暂不可用：{capabilities.Pdf2zhIssue ?? "运行环境不完整"}"
                    : Translator is null
                        ? "请选择翻译服务"
                        : null;
        HasFiles = Files.Count > 0;
        IsSingleFile = Files.Count == 1;
        CanSubmit = HasFiles && Issue is null && !IsSubmitting && Files.All(file => file.Problem is null);
    }

    /// <summary>Queues every selected file; returns the created document ids.</summary>
    public async Task<List<string>> SubmitAsync()
    {
        Refresh();
        var created = new List<string>();
        if (!CanSubmit || Translator is not { } translator)
        {
            return created;
        }
        IsSubmitting = true;
        SubmitError = null;
        Refresh();
        try
        {
            var engine = AppHost.RequireEngine();
            foreach (var file in Files.ToList())
            {
                try
                {
                    var document = await engine.CallAsync<DocumentInfo>("documents.create", new
                    {
                        path = file.Path,
                        title = IsSingleFile && !string.IsNullOrWhiteSpace(Title) ? Title.Trim() : null,
                        mode = Mode,
                        translator = translator.Choice,
                    });
                    created.Add(document.Id);
                    Files.Remove(file);
                }
                catch (EngineException error)
                {
                    file.Problem = error.Message;
                    SubmitError = $"{file.Name}：{error.Message}";
                }
            }
        }
        catch (EngineException error)
        {
            SubmitError = error.Message;
        }
        finally
        {
            IsSubmitting = false;
            if (Files.Count == 0)
            {
                Title = "";
            }
            Refresh();
        }
        return created;
    }
}
