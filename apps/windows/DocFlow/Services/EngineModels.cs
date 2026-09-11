using System.Text.Json;
using System.Text.Json.Serialization;

namespace DocFlow.Services;

// Wire types of the docflow-engine JSON-RPC protocol (engine/src/rpc.rs).
// Property names map to snake_case through the client's naming policy.

public sealed class DocumentInfo
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string OriginalFilename { get; set; } = "";
    public long SourceSize { get; set; }
    public string SourceSha256 { get; set; } = "";
    public string? MimeType { get; set; }
    public string ProcessingMode { get; set; } = "mineru";
    public int TranslationTier { get; set; }
    /// <summary>"服务商 · 模型" (3.0.0 documents may say "Google 翻译（免费）"); absent for older documents.</summary>
    public string? TranslatorLabel { get; set; }
    public string MineruModel { get; set; } = "";
    public string Status { get; set; } = "";
    public string Stage { get; set; } = "";
    public int Progress { get; set; }
    public string? FailureReason { get; set; }
    public int QueueAttempts { get; set; }
    public int? PagesProcessed { get; set; }
    public int? PagesTotal { get; set; }
    public int ImageCount { get; set; }
    public string? Excerpt { get; set; }
    public bool Translated { get; set; }
    public long? PdfSize { get; set; }
    public long? DualPdfSize { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public DocumentFiles? Files { get; set; }
    public SuggestedNames? SuggestedNames { get; set; }
    public bool Running { get; set; }

    [JsonIgnore]
    public bool IsNative => ProcessingMode == "pdf2zh";

    [JsonIgnore]
    public bool IsActive => Status is "queued" or "processing" or "retrying";
}

public sealed class DocumentFiles
{
    public string? Source { get; set; }
    public string? ArchiveDir { get; set; }
    public string? JournalPdf { get; set; }
    public string? MonoPdf { get; set; }
    public string? DualPdf { get; set; }
    public string? Markdown { get; set; }
    public string? MarkdownOriginal { get; set; }
    public string? MarkdownTranslated { get; set; }
    public string? ReaderHtml { get; set; }
}

public sealed class SuggestedNames
{
    public string JournalPdf { get; set; } = "";
    public string MonoPdf { get; set; } = "";
    public string DualPdf { get; set; } = "";
    public string Markdown { get; set; } = "";
    public string Bundle { get; set; } = "";
    public string Source { get; set; } = "";
}

public sealed class DocumentList
{
    public List<DocumentInfo> Items { get; set; } = [];
    public long Total { get; set; }
    public StatusCounts Counts { get; set; } = new();
}

public sealed class StatusCounts
{
    public long All { get; set; }
    public long Active { get; set; }
    public long Completed { get; set; }
    public long Failed { get; set; }
}

public sealed class ProcessingEvent
{
    public long Id { get; set; }
    public string DocumentId { get; set; } = "";
    public string Stage { get; set; } = "";
    public string State { get; set; } = "";
    public string Level { get; set; } = "info";
    public int Progress { get; set; }
    public string Message { get; set; } = "";
    public string? Detail { get; set; }
    public long? Current { get; set; }
    public long? Total { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class EventList
{
    public List<ProcessingEvent> Items { get; set; } = [];
    public long Total { get; set; }
    public long NextAfterId { get; set; }
    public bool HasMore { get; set; }
}

public sealed class InitializeResult
{
    public int Protocol { get; set; }
    public string Version { get; set; } = "";
    public string DataDir { get; set; } = "";
    public string ResourcesDir { get; set; } = "";
    public SettingsInfo Settings { get; set; } = new();
}

public sealed class SettingsInfo
{
    public Preferences Preferences { get; set; } = new();
    public TranslationRuntime TranslationRuntime { get; set; } = new();
    public TranslationRuntime TranslationRuntimeDefaults { get; set; } = new();
    public RuntimeLimits TranslationRuntimeLimits { get; set; } = new();
    public List<ProviderInfo> Providers { get; set; } = [];
    public List<ProviderPreset> ProviderPresets { get; set; } = [];
    public SecretStatus Mineru { get; set; } = new();
    public Capabilities Capabilities { get; set; } = new();
    public string DataDir { get; set; } = "";
    public string EngineVersion { get; set; } = "";

    public ProviderInfo? Provider(string id) => Providers.FirstOrDefault(provider => provider.Id == id);

    /// <summary>Every model a document can be translated with right now.</summary>
    public List<TranslatorOption> TranslatorOptions()
    {
        var options = new List<TranslatorOption>();
        foreach (var provider in Providers.Where(provider => provider.Usable(Capabilities.FakeProviders)))
        {
            options.AddRange(provider.Models.Select(model => new TranslatorOption(
                TranslatorChoice.Llm(provider.Id, model.Id),
                $"{provider.Name} · {model.Name ?? model.Id}")));
        }
        return options;
    }
}

public sealed class Preferences
{
    public string MineruModel { get; set; } = "vlm";

    /// <summary>Null until the user picks a model; "新建翻译" then offers the first one.</summary>
    public TranslatorChoice? DefaultTranslator { get; set; }

    public string DefaultMode { get; set; } = "pdf2zh";
    public ProxySettings Proxy { get; set; } = new();
    public int WorkerConcurrency { get; set; } = 2;
}

/// <summary><c>{"kind":"llm","provider_id":…,"model":…}</c>: a model of a provider.</summary>
public sealed class TranslatorChoice
{
    public string Kind { get; set; } = "llm";

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ProviderId { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Model { get; set; }

    public static TranslatorChoice Llm(string providerId, string model) =>
        new() { Kind = "llm", ProviderId = providerId, Model = model };

    [JsonIgnore]
    public string Key => $"{Kind}:{ProviderId}:{Model}";
}

public sealed record TranslatorOption(TranslatorChoice Choice, string Label)
{
    public override string ToString() => Label;
}

public sealed class ProxySettings
{
    public string Mode { get; set; } = "system";

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Url { get; set; }
}

public sealed class TranslationRuntime
{
    public LlmRuntime Llm { get; set; } = new();
    public int PerDocumentConcurrency { get; set; }
    public string SystemPrompt { get; set; } = "";
}

public sealed class LlmRuntime
{
    public int ChunkChars { get; set; }
    public int MaxSegmentsPerRequest { get; set; }
    public int MaxRequestChars { get; set; }
    public long MaxOutputTokens { get; set; }
}

public sealed class RuntimeLimits
{
    public int MinChunkChars { get; set; }
    public int LlmChunkCharsMax { get; set; }
    public int LlmSegmentsPerRequestMax { get; set; }
    public int LlmRequestCharsMin { get; set; }
    public int LlmRequestCharsMax { get; set; }
    public double LlmOutputTokensMax { get; set; }
    public int PerDocumentConcurrencyMax { get; set; }
    public int ProviderConcurrencyMax { get; set; }
    public int SystemPromptMaxChars { get; set; }
}

public sealed class ModelConfig
{
    public string Id { get; set; } = "";

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Name { get; set; }
}

/// <summary>A provider as <c>providers.save</c> accepts it.</summary>
public class ProviderConfig
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Type { get; set; } = "openai";
    public string BaseUrl { get; set; } = "";
    public bool Enabled { get; set; } = true;
    public List<ModelConfig> Models { get; set; } = [];
    public int Concurrency { get; set; } = 100;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Preset { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, JsonElement>? ExtraBody { get; set; }
}

/// <summary>A provider as <c>settings.get</c> reports it, with its key status.</summary>
public sealed class ProviderInfo : ProviderConfig
{
    public bool KeyConfigured { get; set; }
    public string? KeyMasked { get; set; }
    public bool KeyOptional { get; set; }
    public string? KeyUrl { get; set; }

    public bool Usable(bool fake) => Enabled && Models.Count > 0 && (fake || KeyConfigured || KeyOptional);

    public ProviderConfig ToConfig() => new()
    {
        Id = Id,
        Name = Name,
        Type = Type,
        BaseUrl = BaseUrl,
        Enabled = Enabled,
        Models = Models.Select(model => new ModelConfig { Id = model.Id, Name = model.Name }).ToList(),
        Concurrency = Concurrency,
        Preset = Preset,
        ExtraBody = ExtraBody,
    };
}

public sealed class ProviderPreset
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Type { get; set; } = "openai";
    public string BaseUrl { get; set; } = "";
    public string KeyUrl { get; set; } = "";
    public bool KeyOptional { get; set; }
}

public sealed class RemoteModel
{
    public string Id { get; set; } = "";
    public string? Name { get; set; }
    public string? Owner { get; set; }
    public long? ContextLength { get; set; }
}

public sealed class RemoteModels
{
    public List<RemoteModel> Models { get; set; } = [];
}

public sealed class CheckResult
{
    public bool Ok { get; set; }
    public long LatencyMs { get; set; }
    public string Reply { get; set; } = "";
}

public sealed class SecretStatus
{
    public bool Configured { get; set; }
    public string? Masked { get; set; }
}

public sealed class Capabilities
{
    public bool MineruReady { get; set; }
    public bool Pdf2zhReady { get; set; }
    public string? Pdf2zhIssue { get; set; }
    public bool LlmReady { get; set; }
    public bool FakeProviders { get; set; }
    public long MaxUploadMb { get; set; }
    public List<string> MineruExtensions { get; set; } = [];
    public List<string> Pdf2zhExtensions { get; set; } = [];
}
public sealed class ExportResult
{
    public string Path { get; set; } = "";
    public long Bytes { get; set; }
}
