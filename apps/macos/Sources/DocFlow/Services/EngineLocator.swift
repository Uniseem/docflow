import Foundation

struct EngineLocation {
    var engine: URL
    /// Bundled Python + BabelDOC runtime; nil lets the engine look beside itself.
    var resources: URL?
}

enum EngineLocator {
    /// DocFlow.app/Contents/MacOS/docflow-engine with its runtime in
    /// Contents/Resources/engine. During development (`swift run`) the engine
    /// comes from engine/target and the runtime from runtime/build.
    /// DOCFLOW_ENGINE and DOCFLOW_RESOURCES override both.
    static func locate() throws -> EngineLocation {
        let environment = ProcessInfo.processInfo.environment
        let files = FileManager.default
        var candidates: [URL] = []
        if let path = environment["DOCFLOW_ENGINE"], !path.isEmpty {
            candidates.append(URL(fileURLWithPath: path))
        }
        if let bundled = Bundle.main.url(forAuxiliaryExecutable: "docflow-engine") {
            candidates.append(bundled)
        }
        if let repository = repositoryRoot() {
            for profile in ["release", "debug"] {
                candidates.append(repository.appendingPathComponent("engine/target/\(profile)/docflow-engine"))
            }
        }
        guard let engine = candidates.first(where: { files.isExecutableFile(atPath: $0.path) }) else {
            throw EngineError(code: "engine_missing", message: "找不到处理引擎 docflow-engine，请重新安装 DocFlow。")
        }
        return EngineLocation(engine: engine, resources: resources())
    }

    private static func resources() -> URL? {
        let environment = ProcessInfo.processInfo.environment
        if let path = environment["DOCFLOW_RESOURCES"], !path.isEmpty {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        var candidates: [URL] = []
        if let bundled = Bundle.main.resourceURL {
            candidates.append(bundled.appendingPathComponent("engine", isDirectory: true))
        }
        if let repository = repositoryRoot() {
            candidates.append(repository.appendingPathComponent("runtime/build/macos-\(architecture)/resources", isDirectory: true))
        }
        return candidates.first { isDirectory($0) }
    }

    static var architecture: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }

    /// The source checkout when running from apps/macos/.build.
    private static func repositoryRoot() -> URL? {
        var directory = Bundle.main.executableURL?.deletingLastPathComponent()
        for _ in 0..<8 {
            guard let current = directory else { return nil }
            if FileManager.default.fileExists(atPath: current.appendingPathComponent("engine/Cargo.toml").path) {
                return current
            }
            directory = current.deletingLastPathComponent()
        }
        return nil
    }

    private static func isDirectory(_ url: URL) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory) && directory.boolValue
    }
}

/// Where the document library lives: ~/Library/Application Support/DocFlow
/// unless the user moved it (Settings → 通用) or DOCFLOW_DATA_DIR is set.
enum LibraryLocation {
    static let defaultsKey = "LibraryPath"

    static var current: URL {
        if let path = ProcessInfo.processInfo.environment["DOCFLOW_DATA_DIR"], !path.isEmpty {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        if let path = UserDefaults.standard.string(forKey: defaultsKey), !path.isEmpty {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return standard
    }

    static var standard: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("DocFlow", isDirectory: true)
    }

    static var isOverriddenByEnvironment: Bool {
        !(ProcessInfo.processInfo.environment["DOCFLOW_DATA_DIR"] ?? "").isEmpty
    }

    static func use(_ url: URL) {
        if url.standardizedFileURL == standard.standardizedFileURL {
            UserDefaults.standard.removeObject(forKey: defaultsKey)
        } else {
            UserDefaults.standard.set(url.path, forKey: defaultsKey)
        }
    }
}
