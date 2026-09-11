using System.Text.Json;

namespace DocFlow.Services;

/// <summary>
/// Settings owned by the Windows app itself (not the engine): where the
/// library lives and the window placement. Stored in
/// %LOCALAPPDATA%\DocFlow\host.json.
/// </summary>
public sealed class HostSettings
{
    public static string AppDataDir { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DocFlow");

    private static string FilePath => Path.Combine(AppDataDir, "host.json");

    public string? LibraryDir { get; set; }
    public int WindowWidth { get; set; } = 1280;
    public int WindowHeight { get; set; } = 820;
    public bool WindowMaximized { get; set; }
    public bool ReaderSerif { get; set; }

    public string EffectiveLibraryDir =>
        string.IsNullOrWhiteSpace(LibraryDir) ? AppDataDir : LibraryDir!;

    public static HostSettings Load()
    {
        try
        {
            if (File.Exists(FilePath))
            {
                return JsonSerializer.Deserialize<HostSettings>(File.ReadAllText(FilePath), EngineClient.Json) ?? new();
            }
        }
        catch (Exception)
        {
            // A damaged file falls back to defaults.
        }
        return new();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(AppDataDir);
            var temporary = FilePath + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(this, EngineClient.Json));
            File.Move(temporary, FilePath, overwrite: true);
        }
        catch (Exception)
        {
            // Preferences are best-effort.
        }
    }
}
