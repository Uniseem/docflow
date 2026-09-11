using System.Collections.ObjectModel;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using DocFlow.Helpers;
using DocFlow.Services;

namespace DocFlow.ViewModels;

/// <summary>One model of a provider, with the result of its last check.</summary>
public sealed partial class ModelItemViewModel : ObservableObject
{
    public ModelItemViewModel(ProviderViewModel provider, ModelConfig model)
    {
        Provider = provider;
        Id = model.Id;
        Name = model.Name;
    }

    public ProviderViewModel Provider { get; }

    public string Id { get; }

    public string? Name { get; }

    public string Label => string.IsNullOrWhiteSpace(Name) || Name == Id ? Id : $"{Name}（{Id}）";

    [ObservableProperty]
    public partial bool IsChecking { get; set; }

    [ObservableProperty]
    public partial string? CheckResult { get; set; }

    [ObservableProperty]
    public partial bool CheckFailed { get; set; }
}

/// <summary>
/// A large-model provider in the settings page, in the spirit of Cherry
/// Studio: API address, keys, a model list fetched from the provider, and a
/// concurrency limit. Changes apply immediately, like Windows Settings.
/// </summary>
public sealed partial class ProviderViewModel : ObservableObject
{
    private ProviderInfo _saved;
    private bool _loading;

    public ProviderViewModel(ProviderInfo info)
    {
        _saved = info;
        Load(info);
    }

    public string Id => _saved.Id;

    public string Type => _saved.Type;

    public string TypeLabel => Format.ProviderType(Type);

    public string Initial => string.IsNullOrWhiteSpace(Name) ? "?" : Name.Trim()[..1].ToUpperInvariant();

    public ObservableCollection<ModelItemViewModel> Models { get; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Initial))]
    public partial string Name { get; set; } = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(EndpointPreview), nameof(Summary))]
    public partial string BaseUrl { get; set; } = "";

    [ObservableProperty]
    public partial bool Enabled { get; set; }

    [ObservableProperty]
    public partial double Concurrency { get; set; } = 100;

    [ObservableProperty]
    public partial string ExtraBodyText { get; set; } = "";

    [ObservableProperty]
    public partial string KeyInput { get; set; } = "";

    [ObservableProperty]
    public partial bool KeyConfigured { get; set; }

    [ObservableProperty]
    public partial string KeyStatus { get; set; } = "";

    [ObservableProperty]
    public partial bool KeyOptional { get; set; }

    [ObservableProperty]
    public partial string? KeyUrl { get; set; }

    [ObservableProperty]
    public partial bool IsBusy { get; set; }

    [ObservableProperty]
    public partial bool IsFetching { get; set; }

    [ObservableProperty]
    public partial bool IsExpanded { get; set; }

    [ObservableProperty]
    public partial string? Message { get; set; }

    [ObservableProperty]
    public partial bool MessageIsError { get; set; }

    public bool HasKeyUrl => !string.IsNullOrWhiteSpace(KeyUrl);

    public string KeyPlaceholder => KeyConfigured
        ? "输入新的 Key 以替换；多个 Key 用英文逗号分隔，轮流使用"
        : KeyOptional ? "本机服务通常不需要 Key，可留空" : "粘贴 API Key；多个 Key 用英文逗号分隔，轮流使用";

    public string EndpointPreview =>
        Format.ChatEndpoint(Type, BaseUrl, Models.FirstOrDefault()?.Id) is { Length: > 0 } url ? $"请求地址：{url}" : "请填写 API 地址";

    public string Summary
    {
        get
        {
            var host = Uri.TryCreate(BaseUrl.Trim(), UriKind.Absolute, out var uri) ? uri.Host : BaseUrl.Trim();
            var models = Models.Count == 0 ? "还没有模型" : $"{Models.Count} 个模型";
            return $"{TypeLabel} · {host} · {models}";
        }
    }

    public string StatusText => !Enabled
        ? "已停用"
        : Models.Count == 0
            ? "需要添加模型"
            : KeyConfigured || KeyOptional ? "可以使用" : "需要 API Key";

    public bool IsUsable => Enabled && Models.Count > 0 && (KeyConfigured || KeyOptional);

    public bool HasModels => Models.Count > 0;

    public void Load(ProviderInfo info)
    {
        _loading = true;
        try
        {
            _saved = info;
            Name = info.Name;
            BaseUrl = info.BaseUrl;
            Enabled = info.Enabled;
            Concurrency = info.Concurrency;
            ExtraBodyText = info.ExtraBody is { Count: > 0 } extra
                ? JsonSerializer.Serialize(extra, new JsonSerializerOptions { WriteIndented = true })
                : "";
            Models.Clear();
            foreach (var model in info.Models)
            {
                Models.Add(new ModelItemViewModel(this, model));
            }
            LoadKey(info);
        }
        finally
        {
            _loading = false;
        }
        Changed();
    }

    /// <summary>Key status and other engine-computed fields; keeps edits.</summary>
    public void LoadKey(ProviderInfo info)
    {
        _saved = info;
        KeyConfigured = info.KeyConfigured;
        KeyOptional = info.KeyOptional;
        KeyUrl = info.KeyUrl;
        KeyStatus = info.KeyConfigured
            ? $"已保存 {info.KeyMasked}"
            : info.KeyOptional ? "无需 Key" : "未填写 Key";
        OnPropertyChanged(nameof(HasKeyUrl));
        OnPropertyChanged(nameof(KeyPlaceholder));
        Changed();
    }

    private void Changed()
    {
        OnPropertyChanged(nameof(Summary));
        OnPropertyChanged(nameof(StatusText));
        OnPropertyChanged(nameof(IsUsable));
        OnPropertyChanged(nameof(HasModels));
        OnPropertyChanged(nameof(EndpointPreview));
    }

    /// <summary>
    /// The model picker's result: models of the fetched list are in or out
    /// as ticked; models added by hand stay.
    /// </summary>
    public async Task ApplyModelSelectionAsync(IReadOnlyList<RemoteModel> remote, IReadOnlySet<string> selected)
    {
        var listed = remote.Select(model => model.Id).ToHashSet();
        var removed = Models.Where(model => listed.Contains(model.Id) && !selected.Contains(model.Id)).ToList();
        foreach (var model in removed)
        {
            Models.Remove(model);
        }
        var added = remote
            .Where(model => selected.Contains(model.Id) && Models.All(existing => existing.Id != model.Id))
            .ToList();
        foreach (var model in added)
        {
            Models.Add(new ModelItemViewModel(this, new ModelConfig { Id = model.Id, Name = model.Name }));
        }
        if (removed.Count == 0 && added.Count == 0)
        {
            return;
        }
        Changed();
        if (await CommitAsync())
        {
            Show(
                (added.Count, removed.Count) switch
                {
                    ( > 0, > 0) => $"已添加 {added.Count} 个、移除 {removed.Count} 个模型",
                    ( > 0, _) => $"已添加 {added.Count} 个模型",
                    _ => $"已移除 {removed.Count} 个模型",
                },
                false);
        }
    }

    partial void OnEnabledChanged(bool value)
    {
        if (!_loading)
        {
            _ = CommitAsync();
        }
        Changed();
    }

    partial void OnConcurrencyChanged(double value)
    {
        if (!_loading && !double.IsNaN(value) && (int)Math.Round(value) != _saved.Concurrency)
        {
            _ = CommitAsync();
        }
    }

    /// <summary>Saves the name, address and extra parameters after editing.</summary>
    public Task CommitTextAsync()
    {
        var extra = ExtraBodyText.Trim();
        var savedExtra = _saved.ExtraBody is { Count: > 0 } saved
            ? JsonSerializer.Serialize(saved, new JsonSerializerOptions { WriteIndented = true })
            : "";
        return Name.Trim() == _saved.Name && BaseUrl.Trim().TrimEnd('/') == _saved.BaseUrl && extra == savedExtra.Trim()
            ? Task.CompletedTask
            : CommitAsync();
    }

    private ProviderConfig? BuildConfig()
    {
        Dictionary<string, JsonElement>? extra = null;
        var text = ExtraBodyText.Trim();
        if (text.Length > 0)
        {
            try
            {
                using var document = JsonDocument.Parse(text);
                if (document.RootElement.ValueKind != JsonValueKind.Object)
                {
                    Show("附加请求参数必须是 JSON 对象，例如 {\"temperature\": 0.3}", true);
                    return null;
                }
                extra = document.RootElement.EnumerateObject().ToDictionary(property => property.Name, property => property.Value.Clone());
            }
            catch (JsonException error)
            {
                Show($"附加请求参数不是有效的 JSON：{error.Message}", true);
                return null;
            }
        }
        return new ProviderConfig
        {
            Id = Id,
            Name = Name.Trim(),
            Type = Type,
            BaseUrl = BaseUrl.Trim(),
            Enabled = Enabled,
            Models = Models.Select(model => new ModelConfig { Id = model.Id, Name = model.Name }).ToList(),
            Concurrency = double.IsNaN(Concurrency) ? _saved.Concurrency : (int)Math.Round(Concurrency),
            Preset = _saved.Preset,
            ExtraBody = extra,
        };
    }

    /// <summary>Saves the current state; on failure the edits stay for fixing.</summary>
    public async Task<bool> CommitAsync()
    {
        if (BuildConfig() is not { } config)
        {
            return false;
        }
        try
        {
            var settings = await AppHost.RequireEngine().CallAsync<SettingsInfo>("providers.save", new { provider = config });
            if (settings.Provider(Id) is { } saved)
            {
                _saved = saved;
            }
            if (MessageIsError)
            {
                Message = null;
            }
            AppHost.UpdateSettings(settings);
            return true;
        }
        catch (EngineException error)
        {
            Show(error.Message, true);
            return false;
        }
    }

    public async Task SaveKeyAsync()
    {
        var value = KeyInput.Trim();
        if (value.Length == 0)
        {
            Show("请输入 API Key", true);
            return;
        }
        IsBusy = true;
        try
        {
            var name = CredentialStore.ProviderName(Id);
            CredentialStore.Write(name, value);
            AppHost.UpdateSettings(await AppHost.RequireEngine().CallAsync<SettingsInfo>("secrets.set", new { name, value }));
            KeyInput = "";
            Show(Models.Count > 0 ? "已保存到 Windows 凭据管理器。可以点模型旁的“检查”确认 Key 可用" : "已保存到 Windows 凭据管理器。下一步：获取模型列表", false);
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

    public async Task RemoveKeyAsync()
    {
        IsBusy = true;
        try
        {
            var name = CredentialStore.ProviderName(Id);
            CredentialStore.Delete(name);
            AppHost.UpdateSettings(await AppHost.RequireEngine().CallAsync<SettingsInfo>("secrets.set", new { name, value = (string?)null }));
            Show("已移除 Key", false);
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

    /// <summary>The address and key being edited, or the stored key.</summary>
    private object Endpoint(string? model = null) => new
    {
        provider_id = Id,
        name = Name.Trim(),
        type = Type,
        base_url = BaseUrl.Trim(),
        api_key = KeyInput.Trim() is { Length: > 0 } key ? key : null,
        model,
        extra_body = BuildConfig()?.ExtraBody,
    };

    public async Task<List<RemoteModel>?> FetchModelsAsync()
    {
        IsFetching = true;
        Message = null;
        try
        {
            var result = await AppHost.RequireEngine().CallAsync<RemoteModels>("providers.models", Endpoint());
            if (result.Models.Count == 0)
            {
                Show("服务商没有返回任何模型，请手动添加模型 ID", true);
                return null;
            }
            return result.Models;
        }
        catch (EngineException error)
        {
            Show(error.Message, true);
            return null;
        }
        finally
        {
            IsFetching = false;
        }
    }

    public async Task CheckAsync(ModelItemViewModel model)
    {
        model.IsChecking = true;
        model.CheckResult = null;
        try
        {
            var result = await AppHost.RequireEngine().CallAsync<CheckResult>("providers.check", Endpoint(model.Id));
            model.CheckFailed = false;
            model.CheckResult = $"可用 · {result.LatencyMs} ms · “{result.Reply}”";
        }
        catch (EngineException error)
        {
            model.CheckFailed = true;
            model.CheckResult = error.Message;
        }
        finally
        {
            model.IsChecking = false;
        }
    }

    public async Task AddModelsAsync(IEnumerable<ModelConfig> models)
    {
        var added = 0;
        foreach (var model in models)
        {
            var id = model.Id.Trim();
            if (id.Length > 0 && Models.All(existing => existing.Id != id))
            {
                Models.Add(new ModelItemViewModel(this, new ModelConfig { Id = id, Name = model.Name }));
                added++;
            }
        }
        if (added == 0)
        {
            return;
        }
        Changed();
        if (await CommitAsync())
        {
            Show($"已添加 {added} 个模型", false);
        }
    }

    public async Task RemoveModelAsync(ModelItemViewModel model)
    {
        Models.Remove(model);
        Changed();
        await CommitAsync();
    }

    public async Task<bool> DeleteAsync()
    {
        try
        {
            AppHost.UpdateSettings(await AppHost.RequireEngine().CallAsync<SettingsInfo>("providers.delete", new { id = Id }));
            CredentialStore.Delete(CredentialStore.ProviderName(Id));
            return true;
        }
        catch (Exception error) when (error is EngineException or InvalidOperationException)
        {
            Show(error.Message, true);
            return false;
        }
    }

    private void Show(string message, bool error)
    {
        Message = message;
        MessageIsError = error;
    }
}
