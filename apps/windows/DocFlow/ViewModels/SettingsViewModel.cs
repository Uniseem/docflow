using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using DocFlow.Services;

namespace DocFlow.ViewModels;

/// <summary>The MinerU API key row.</summary>
public sealed partial class SecretRowViewModel : ObservableObject
{
    public SecretRowViewModel(string name, string title, string description)
    {
        Name = name;
        Title = title;
        Description = description;
    }

    public string Name { get; }
    public string Title { get; }
    public string Description { get; }

    [ObservableProperty]
    public partial string Input { get; set; } = "";

    [ObservableProperty]
    public partial bool Configured { get; set; }

    [ObservableProperty]
    public partial string Status { get; set; } = "未配置";

    [ObservableProperty]
    public partial bool IsBusy { get; set; }

    [ObservableProperty]
    public partial string? Message { get; set; }

    [ObservableProperty]
    public partial bool MessageIsError { get; set; }

    public void Load(SecretStatus status)
    {
        Configured = status.Configured;
        Status = status.Configured ? $"已配置 {status.Masked}" : "未配置";
    }

    /// <summary>Verifies the key with the service, then stores it in Credential Manager.</summary>
    public async Task SaveAsync()
    {
        var value = Input.Trim();
        if (value.Length == 0)
        {
            Show("请输入 API Key", true);
            return;
        }
        IsBusy = true;
        Message = null;
        try
        {
            var engine = AppHost.RequireEngine();
            await engine.CallAsync("secrets.verify", new { name = Name, value });
            CredentialStore.Write(Name, value);
            AppHost.UpdateSettings(await engine.CallAsync<SettingsInfo>("secrets.set", new { name = Name, value }));
            Input = "";
            Show("已验证并保存到 Windows 凭据管理器", false);
        }
        catch (Exception error) when (error is EngineException or InvalidOperationException)
        {
            Show(error.Message, true);
        }
        finally
        {
            IsBusy = false;
        }
    }

    public async Task RemoveAsync()
    {
        IsBusy = true;
        try
        {
            CredentialStore.Delete(Name);
            AppHost.UpdateSettings(await AppHost.RequireEngine().CallAsync<SettingsInfo>("secrets.set", new { name = Name, value = (string?)null }));
            Show("已移除", false);
        }
        catch (Exception error) when (error is EngineException or InvalidOperationException)
        {
            Show(error.Message, true);
        }
        finally
        {
            IsBusy = false;
        }
    }

    private void Show(string message, bool error)
    {
        Message = message;
        MessageIsError = error;
    }
}

public sealed partial class SettingsViewModel : ObservableObject
{
    private bool _loading;

    public SecretRowViewModel Mineru { get; } = new(CredentialStore.Mineru, "MinerU", "MinerU 解析翻译使用的文档解析服务");

    public ObservableCollection<ProviderViewModel> Providers { get; } = [];

    public ObservableCollection<ProviderPreset> Presets { get; } = [];

    public ObservableCollection<TranslatorOption> TranslatorOptions { get; } = [];

    [ObservableProperty]
    public partial TranslatorOption? DefaultTranslator { get; set; }

    /// <summary>At least one model is usable, so there is a default to pick.</summary>
    [ObservableProperty]
    public partial bool HasModels { get; set; }

    [ObservableProperty]
    public partial bool HasProviders { get; set; }

    [ObservableProperty]
    public partial int DefaultModeIndex { get; set; }

    [ObservableProperty]
    public partial int MineruModelIndex { get; set; }

    [ObservableProperty]
    public partial double WorkerConcurrency { get; set; } = 2;

    [ObservableProperty]
    public partial int ProxyModeIndex { get; set; }

    [ObservableProperty]
    public partial string ProxyUrl { get; set; } = "";

    [ObservableProperty]
    public partial bool IsCustomProxy { get; set; }

    [ObservableProperty]
    public partial string? PreferencesError { get; set; }

    // Advanced translation runtime.
    [ObservableProperty] public partial double LlmChunkChars { get; set; }
    [ObservableProperty] public partial double LlmSegments { get; set; }
    [ObservableProperty] public partial double LlmRequestChars { get; set; }
    [ObservableProperty] public partial double LlmMaxOutputTokens { get; set; }
    [ObservableProperty] public partial double PerDocumentConcurrency { get; set; }
    [ObservableProperty] public partial string SystemPrompt { get; set; } = "";
    [ObservableProperty] public partial string? RuntimeMessage { get; set; }
    [ObservableProperty] public partial bool RuntimeMessageIsError { get; set; }

    [ObservableProperty] public partial RuntimeLimits Limits { get; set; } = new();

    [ObservableProperty] public partial string DataDir { get; set; } = "";
    [ObservableProperty] public partial string EngineVersion { get; set; } = "";
    [ObservableProperty] public partial string RuntimeStatus { get; set; } = "";
    [ObservableProperty] public partial bool RuntimeReady { get; set; }
    [ObservableProperty] public partial bool FakeProviders { get; set; }

    public string AppVersion => typeof(App).Assembly.GetName().Version?.ToString(3) ?? "";

    /// <summary>Refreshes from the engine settings; unsaved form edits survive.</summary>
    public void Load(bool keepRuntimeForm = false)
    {
        if (AppHost.Settings is not { } settings)
        {
            return;
        }
        _loading = true;
        try
        {
            Mineru.Load(settings.Mineru);
            LoadProviders(settings);
            if (Presets.Count != settings.ProviderPresets.Count)
            {
                Presets.Clear();
                foreach (var preset in settings.ProviderPresets)
                {
                    Presets.Add(preset);
                }
            }
            var preferences = settings.Preferences;
            LoadTranslatorOptions(settings);
            DefaultModeIndex = preferences.DefaultMode == "mineru" ? 1 : 0;
            MineruModelIndex = preferences.MineruModel == "pipeline" ? 1 : 0;
            WorkerConcurrency = preferences.WorkerConcurrency;
            ProxyModeIndex = preferences.Proxy.Mode switch { "direct" => 1, "custom" => 2, _ => 0 };
            ProxyUrl = preferences.Proxy.Url ?? "";
            IsCustomProxy = ProxyModeIndex == 2;
            if (!keepRuntimeForm)
            {
                LoadRuntime(settings.TranslationRuntime);
            }
            Limits = settings.TranslationRuntimeLimits;
            DataDir = settings.DataDir;
            EngineVersion = settings.EngineVersion;
            var capabilities = settings.Capabilities;
            RuntimeReady = capabilities.Pdf2zhReady;
            RuntimeStatus = capabilities.Pdf2zhReady ? "已就绪" : capabilities.Pdf2zhIssue ?? "不可用";
            FakeProviders = capabilities.FakeProviders;
        }
        finally
        {
            _loading = false;
        }
    }

    private void LoadProviders(SettingsInfo settings)
    {
        foreach (var stale in Providers.Where(row => settings.Provider(row.Id) is null).ToList())
        {
            Providers.Remove(stale);
        }
        for (var index = 0; index < settings.Providers.Count; index++)
        {
            var info = settings.Providers[index];
            var row = Providers.FirstOrDefault(existing => existing.Id == info.Id);
            if (row is null)
            {
                Providers.Insert(Math.Min(index, Providers.Count), new ProviderViewModel(info));
            }
            else
            {
                row.LoadKey(info);
            }
        }
        HasProviders = Providers.Count > 0;
    }

    private void LoadTranslatorOptions(SettingsInfo settings)
    {
        var options = settings.TranslatorOptions();
        var wanted = settings.Preferences.DefaultTranslator?.Key;
        TranslatorOptions.Clear();
        foreach (var option in options)
        {
            TranslatorOptions.Add(option);
        }
        HasModels = TranslatorOptions.Count > 0;
        // Without a saved (and still usable) default, the first model is it.
        DefaultTranslator = TranslatorOptions.FirstOrDefault(option => option.Choice.Key == wanted) ?? TranslatorOptions.FirstOrDefault();
    }

    private void LoadRuntime(TranslationRuntime runtime)
    {
        LlmChunkChars = runtime.Llm.ChunkChars;
        LlmSegments = runtime.Llm.MaxSegmentsPerRequest;
        LlmRequestChars = runtime.Llm.MaxRequestChars;
        LlmMaxOutputTokens = runtime.Llm.MaxOutputTokens;
        PerDocumentConcurrency = runtime.PerDocumentConcurrency;
        SystemPrompt = runtime.SystemPrompt;
    }

    partial void OnDefaultTranslatorChanged(TranslatorOption? value) => _ = SavePreferencesAsync();
    partial void OnDefaultModeIndexChanged(int value) => _ = SavePreferencesAsync();
    partial void OnMineruModelIndexChanged(int value) => _ = SavePreferencesAsync();
    partial void OnWorkerConcurrencyChanged(double value) => _ = SavePreferencesAsync();

    partial void OnProxyModeIndexChanged(int value)
    {
        IsCustomProxy = value == 2;
        if (value != 2)
        {
            _ = SavePreferencesAsync();
        }
    }

    public async Task SavePreferencesAsync()
    {
        if (_loading || AppHost.Settings is null)
        {
            return;
        }
        var proxy = ProxyModeIndex switch
        {
            1 => new ProxySettings { Mode = "direct" },
            2 => new ProxySettings { Mode = "custom", Url = ProxyUrl.Trim() },
            _ => new ProxySettings { Mode = "system" },
        };
        var preferences = new Preferences
        {
            DefaultMode = DefaultModeIndex == 1 ? "mineru" : "pdf2zh",
            DefaultTranslator = DefaultTranslator?.Choice,
            MineruModel = MineruModelIndex == 1 ? "pipeline" : "vlm",
            WorkerConcurrency = double.IsNaN(WorkerConcurrency) ? 2 : (int)Math.Clamp(WorkerConcurrency, 1, 4),
            Proxy = proxy,
        };
        try
        {
            AppHost.UpdateSettings(await AppHost.RequireEngine().CallAsync<SettingsInfo>("settings.update", new { preferences }));
            PreferencesError = null;
        }
        catch (EngineException error)
        {
            PreferencesError = error.Message;
        }
    }

    private TranslationRuntime RuntimeFromForm(TranslationRuntime saved) => new()
    {
        Llm = new LlmRuntime
        {
            ChunkChars = ToInt(LlmChunkChars, saved.Llm.ChunkChars),
            MaxSegmentsPerRequest = ToInt(LlmSegments, saved.Llm.MaxSegmentsPerRequest),
            MaxRequestChars = ToInt(LlmRequestChars, saved.Llm.MaxRequestChars),
            MaxOutputTokens = double.IsNaN(LlmMaxOutputTokens) ? saved.Llm.MaxOutputTokens : (long)Math.Round(LlmMaxOutputTokens),
        },
        PerDocumentConcurrency = ToInt(PerDocumentConcurrency, saved.PerDocumentConcurrency),
        SystemPrompt = SystemPrompt,
    };

    public async Task SaveRuntimeAsync()
    {
        if (AppHost.Settings is not { } settings)
        {
            return;
        }
        try
        {
            var runtime = RuntimeFromForm(settings.TranslationRuntime);
            AppHost.UpdateSettings(await AppHost.RequireEngine().CallAsync<SettingsInfo>("settings.update", new { translation_runtime = runtime }));
            RuntimeMessage = "已保存。新任务使用新参数，进行中的任务保持提交时的设置。";
            RuntimeMessageIsError = false;
        }
        catch (EngineException error)
        {
            RuntimeMessage = error.Message;
            RuntimeMessageIsError = true;
        }
    }

    public void ResetRuntime()
    {
        if (AppHost.Settings is { } settings)
        {
            LoadRuntime(settings.TranslationRuntimeDefaults);
            RuntimeMessage = "已恢复默认值，点击“保存”后生效。";
            RuntimeMessageIsError = false;
        }
    }

    /// <summary>Adds a provider from a preset; returns its row, expanded.</summary>
    public async Task<ProviderViewModel?> AddProviderAsync(ProviderPreset preset, string? name = null, string? type = null, string? baseUrl = null)
    {
        var baseId = preset.Id == "custom" ? "custom" : preset.Id;
        var id = baseId;
        for (var suffix = 2; Providers.Any(row => row.Id == id); suffix++)
        {
            id = $"{baseId}-{suffix}";
        }
        var config = new ProviderConfig
        {
            Id = id,
            Name = name ?? (id == baseId ? preset.Name : $"{preset.Name} {id[(baseId.Length + 1)..]}"),
            Type = type ?? preset.Type,
            BaseUrl = baseUrl ?? preset.BaseUrl,
            Enabled = true,
            Concurrency = 100,
            Preset = preset.Id,
        };
        try
        {
            AppHost.UpdateSettings(await AppHost.RequireEngine().CallAsync<SettingsInfo>("providers.save", new { provider = config }));
            var row = Providers.FirstOrDefault(existing => existing.Id == id);
            if (row is not null)
            {
                row.IsExpanded = true;
            }
            return row;
        }
        catch (EngineException error)
        {
            PreferencesError = error.Message;
            return null;
        }
    }

    public async Task DeleteProviderAsync(ProviderViewModel provider)
    {
        if (await provider.DeleteAsync())
        {
            Providers.Remove(provider);
            HasProviders = Providers.Count > 0;
        }
    }

    private static int ToInt(double value, int fallback = 0) => double.IsNaN(value) ? fallback : (int)Math.Round(value);
}
