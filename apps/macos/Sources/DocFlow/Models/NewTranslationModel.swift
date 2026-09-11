import Foundation
import Observation
import UniformTypeIdentifiers

struct PendingFile: Identifiable, Hashable {
    let url: URL
    let size: Int64

    var id: URL { url }
    var name: String { url.lastPathComponent }
    var isPDF: Bool { url.pathExtension.lowercased() == "pdf" }

    init(url: URL) {
        self.url = url
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        size = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
    }
}

/// The "新建翻译" sheet: files, processing mode, translation service and title.
@MainActor
@Observable
final class NewTranslationModel {
    private(set) var files: [PendingFile] = []
    var mode = "pdf2zh"
    /// Nil while no model is usable yet.
    var translator: TranslatorChoice?
    var title = ""
    private(set) var isSubmitting = false
    private(set) var submitError: String?
    private var submitProblems: [URL: String] = [:]

    @ObservationIgnored weak var app: AppModel?

    private var capabilities: Capabilities? { app?.settings?.capabilities }

    var isNative: Bool { mode == "pdf2zh" }

    var acceptedExtensions: [String] {
        (isNative ? capabilities?.pdf2zhExtensions : capabilities?.mineruExtensions) ?? [".pdf"]
    }

    /// Everything either route accepts; picking an Office file switches to MinerU.
    var importableTypes: [UTType] {
        let extensions = Set((capabilities?.mineruExtensions ?? [".pdf"]) + (capabilities?.pdf2zhExtensions ?? []))
        let types = extensions.sorted().compactMap { UTType(filenameExtension: String($0.dropFirst())) }
        return types.isEmpty ? [.pdf] : types
    }

    var acceptedHint: String {
        isNative
            ? "仅支持带文本层的 PDF；扫描件请选择 MinerU 解析翻译。"
            : "支持 PDF、Word、PowerPoint、Excel、图片与网页文件。"
    }

    /// Every model of every usable provider.
    var translatorOptions: [TranslatorOption] {
        app?.translatorOptions ?? []
    }

    var hasModels: Bool { !translatorOptions.isEmpty }

    var isTranslatorAvailable: Bool {
        translatorOptions.contains { $0.choice == translator }
    }

    /// Why the files cannot be submitted right now, if anything.
    var issue: String? {
        guard let capabilities else { return "处理引擎尚未就绪。" }
        if !isNative && !capabilities.mineruReady {
            return "MinerU 解析翻译需要先在设置中填写 MinerU API Key。"
        }
        if isNative && !capabilities.pdf2zhReady {
            return "PDF 原生翻译暂不可用：\(capabilities.pdf2zhIssue ?? "运行环境不完整")"
        }
        if !hasModels {
            return "还没有可用的大模型：请在设置的“翻译服务”中添加服务商、填写 API Key 并获取模型。"
        }
        if !isTranslatorAvailable {
            return "所选的模型已停用或已删除，请换一个模型。"
        }
        return nil
    }

    func problem(for file: PendingFile) -> String? {
        if let problem = submitProblems[file.url] {
            return problem
        }
        let fileExtension = file.url.pathExtension.lowercased()
        let dotted = fileExtension.isEmpty ? "" : ".\(fileExtension)"
        let maxMB = capabilities?.maxUploadMb ?? 200
        if !FileManager.default.fileExists(atPath: file.url.path) {
            return "文件不存在"
        }
        if !acceptedExtensions.contains(dotted) {
            if isNative {
                return "PDF 原生翻译只支持 .pdf 文件"
            }
            return "不支持\(dotted.isEmpty ? "无扩展名的" : " \(dotted) ")文件"
        }
        if file.size == 0 {
            return "文件为空"
        }
        if file.size > Int64(maxMB) * 1024 * 1024 {
            return "文件超过 \(maxMB) MB"
        }
        return nil
    }

    var canSubmit: Bool {
        !files.isEmpty && issue == nil && !isSubmitting && files.allSatisfy { problem(for: $0) == nil }
    }

    // MARK: Editing

    func reset() {
        files = []
        title = ""
        submitError = nil
        submitProblems = [:]
        if let preferences = app?.settings?.preferences {
            mode = preferences.defaultMode
        }
        translator = app?.defaultTranslatorPreference
    }

    /// A model became usable (or the chosen one went away) while the sheet
    /// is open: keep a usable choice.
    func refreshTranslator() {
        if !isTranslatorAvailable {
            translator = app?.defaultTranslatorPreference
        }
    }

    func add(_ urls: [URL]) {
        for url in urls where url.isFileURL {
            let standardized = url.standardizedFileURL
            if !files.contains(where: { $0.url == standardized }) {
                files.append(PendingFile(url: standardized))
            }
        }
        if files.count == 1 && title.trimmed.isEmpty {
            title = files[0].url.deletingPathExtension().lastPathComponent
        }
        // Office documents, images and web pages can only take the MinerU route.
        if isNative && files.contains(where: { !$0.isPDF }) {
            mode = "mineru"
        }
    }

    func remove(_ file: PendingFile) {
        files.removeAll { $0.id == file.id }
        submitProblems[file.url] = nil
        if files.count != 1 {
            title = ""
        }
    }

    /// Queues every file; returns the ids of the created documents. Files
    /// the engine rejects stay in the list with the reason.
    func submit() async -> [String] {
        guard canSubmit, let app, let translator else { return [] }
        isSubmitting = true
        submitError = nil
        let single = files.count == 1
        let customTitle = title.trimmed
        var created: [String] = []
        for file in files {
            do {
                let document: DocumentInfo = try await app.call(
                    "documents.create",
                    CreateParams(
                        path: file.url.path,
                        title: single && !customTitle.isEmpty ? customTitle : nil,
                        mode: mode,
                        translator: translator
                    )
                )
                created.append(document.id)
                files.removeAll { $0.id == file.id }
            } catch {
                submitProblems[file.url] = error.localizedDescription
                submitError = "\(file.name)：\(error.localizedDescription)"
            }
        }
        isSubmitting = false
        if files.isEmpty {
            title = ""
        }
        return created
    }
}
