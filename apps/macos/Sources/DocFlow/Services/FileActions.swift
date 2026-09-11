import AppKit
import UniformTypeIdentifiers

/// Finder, default-app and save-panel helpers.
@MainActor
enum FileActions {
    static func reveal(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    static func openFolder(_ url: URL) {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        NSWorkspace.shared.open(url)
    }

    static func open(_ path: String) {
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    static func openWebLink(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
        NSWorkspace.shared.open(url)
    }

    /// A save panel attached to the key window; nil when cancelled.
    static func chooseDestination(suggestedName: String, contentType: UTType?) async -> URL? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedName
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        if let contentType {
            panel.allowedContentTypes = [contentType]
        }
        return await present(panel) ? panel.url : nil
    }

    static func chooseFolder(message: String, prompt: String) async -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = message
        panel.prompt = prompt
        return await present(panel) ? panel.url : nil
    }

    private static func present(_ panel: NSSavePanel) async -> Bool {
        guard let window = NSApp.keyWindow ?? NSApp.mainWindow else {
            return panel.runModal() == .OK
        }
        let response = await withCheckedContinuation { (continuation: CheckedContinuation<NSApplication.ModalResponse, Never>) in
            panel.beginSheetModal(for: window) { response in
                continuation.resume(returning: response)
            }
        }
        return response == .OK
    }

    /// Copies a finished file out of the library, replacing an existing file
    /// the user agreed to overwrite in the save panel.
    static func copy(_ source: String, to destination: URL) throws {
        let files = FileManager.default
        let sourceURL = URL(fileURLWithPath: source)
        if files.fileExists(atPath: destination.path) {
            _ = try files.replaceItemAt(destination, withItemAt: temporaryCopy(of: sourceURL, near: destination))
        } else {
            try files.copyItem(at: sourceURL, to: destination)
        }
    }

    private static func temporaryCopy(of source: URL, near destination: URL) throws -> URL {
        let temporary = destination.deletingLastPathComponent()
            .appendingPathComponent(".\(UUID().uuidString)-\(destination.lastPathComponent)")
        try FileManager.default.copyItem(at: source, to: temporary)
        return temporary
    }
}
