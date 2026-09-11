namespace DocFlow.Services;

public sealed record EngineLocation(string EnginePath, string? ResourcesDir);

/// <summary>
/// Finds the engine binary and its resources (Python runtime + BabelDOC
/// assets). Installed layout: <c>engine\docflow-engine.exe</c> and
/// <c>engine\resources\</c> next to DocFlow.exe. During development the
/// repository build outputs are used, or DOCFLOW_ENGINE / DOCFLOW_RESOURCES.
/// </summary>
public static class EngineLocator
{
    public static EngineLocation Locate()
    {
        var baseDir = AppContext.BaseDirectory;
        var overrideEngine = Environment.GetEnvironmentVariable("DOCFLOW_ENGINE");
        var overrideResources = Environment.GetEnvironmentVariable("DOCFLOW_RESOURCES");

        var engine = FirstExisting(
            overrideEngine,
            Path.Combine(baseDir, "engine", "docflow-engine.exe"),
            Path.Combine(baseDir, "docflow-engine.exe"),
            RepoPath(baseDir, "engine", "target", "release", "docflow-engine.exe"),
            RepoPath(baseDir, "engine", "target", "debug", "docflow-engine.exe"));
        if (engine is null)
        {
            throw new FileNotFoundException("找不到处理引擎 docflow-engine.exe，请重新安装应用。");
        }

        var resources = FirstDirectory(
            overrideResources,
            Path.Combine(Path.GetDirectoryName(engine)!, "resources"),
            RepoPath(baseDir, "runtime", "build", "windows-x64", "resources"));
        return new EngineLocation(engine, resources);
    }

    private static string? FirstExisting(params string?[] candidates) =>
        candidates.FirstOrDefault(path => !string.IsNullOrEmpty(path) && File.Exists(path));

    private static string? FirstDirectory(params string?[] candidates) =>
        candidates.FirstOrDefault(path => !string.IsNullOrEmpty(path) && Directory.Exists(path));

    /// <summary>Walks up from the app folder to a DocFlow repository checkout.</summary>
    private static string? RepoPath(string start, params string[] parts)
    {
        var directory = new DirectoryInfo(start);
        while (directory is not null)
        {
            if (Directory.Exists(Path.Combine(directory.FullName, "engine", "src")))
            {
                return Path.Combine([directory.FullName, .. parts]);
            }
            directory = directory.Parent;
        }
        return null;
    }
}
