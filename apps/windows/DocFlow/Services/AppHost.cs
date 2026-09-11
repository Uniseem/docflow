using Microsoft.UI.Dispatching;

namespace DocFlow.Services;

/// <summary>
/// Process-wide services: the engine connection, the latest engine settings
/// and the app's own preferences.
/// </summary>
public static class AppHost
{
    public static HostSettings Host { get; } = HostSettings.Load();

    public static EngineClient? Engine { get; private set; }

    public static SettingsInfo? Settings { get; private set; }

    public static string? EngineVersion { get; private set; }

    public static string? StartupError { get; private set; }

    /// <summary>The library folder; DOCFLOW_DATA_DIR overrides it for development.</summary>
    public static string DataDir =>
        Environment.GetEnvironmentVariable("DOCFLOW_DATA_DIR") is { Length: > 0 } overridden
            ? overridden
            : Host.EffectiveLibraryDir;

    /// <summary>Raised on the UI thread after the engine settings change.</summary>
    public static event Action? SettingsChanged;

    /// <summary>Raised on the UI thread when the engine starts or stops.</summary>
    public static event Action? EngineStateChanged;

    public static bool IsReady => Engine?.IsRunning == true && Settings is not null;

    public static EngineClient RequireEngine() =>
        Engine is { IsRunning: true } engine ? engine : throw new EngineException("engine_stopped", "处理引擎未运行");

    public static async Task StartEngineAsync(DispatcherQueue dispatcher)
    {
        StartupError = null;
        if (Engine is not null)
        {
            await Engine.DisposeAsync();
            Engine = null;
        }

        try
        {
            var location = EngineLocator.Locate();
            Directory.CreateDirectory(DataDir);
            var engine = new EngineClient(dispatcher);
            engine.Exited += message =>
            {
                StartupError = message;
                EngineStateChanged?.Invoke();
            };
            engine.Start(location, DataDir);
            var secrets = CredentialStore.ReadAll();
            var result = await engine.CallAsync<InitializeResult>("engine.initialize", new { secrets });
            Engine = engine;
            EngineVersion = result.Version;
            Settings = result.Settings;
        }
        catch (Exception error)
        {
            StartupError = error.Message;
        }
        EngineStateChanged?.Invoke();
        SettingsChanged?.Invoke();
    }

    public static void UpdateSettings(SettingsInfo settings)
    {
        Settings = settings;
        SettingsChanged?.Invoke();
    }

    public static async Task RefreshSettingsAsync()
    {
        if (Engine is { IsRunning: true } engine)
        {
            UpdateSettings(await engine.CallAsync<SettingsInfo>("settings.get"));
        }
    }

    public static async Task StopEngineAsync()
    {
        if (Engine is { } engine)
        {
            Engine = null;
            await engine.DisposeAsync();
        }
    }
}
