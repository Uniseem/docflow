import AppKit
import Observation
import SwiftUI
import UniformTypeIdentifiers

enum LibraryFilter: String, CaseIterable, Identifiable, Hashable {
    case all, active, completed, failed

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "全部文档"
        case .active: return "进行中"
        case .completed: return "已完成"
        case .failed: return "失败与取消"
        }
    }

    var symbol: String {
        switch self {
        case .all: return "tray.full"
        case .active: return "clock.arrow.circlepath"
        case .completed: return "checkmark.circle"
        case .failed: return "exclamationmark.triangle"
        }
    }

    func count(in counts: StatusCounts) -> Int {
        switch self {
        case .all: return counts.all
        case .active: return counts.active
        case .completed: return counts.completed
        case .failed: return counts.failed
        }
    }

    func matches(_ document: DocumentInfo) -> Bool {
        switch self {
        case .all: return true
        case .active: return document.isActive
        case .completed: return document.isCompleted
        case .failed: return document.isStopped
        }
    }
}

enum EngineState: Equatable {
    case stopped
    case starting
    case ready
    case failed(String)
}

struct AppAlert: Identifiable {
    let id = UUID()
    var title: String
    var message: String
}

/// App-wide state: the engine connection, the library list, the selection
/// and the dialogs that act on documents. There is one library window.
@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    // MARK: Engine

    private(set) var engineState: EngineState = .stopped
    private(set) var settings: SettingsInfo?
    private(set) var engineVersion = ""
    private(set) var dataDirectory = LibraryLocation.current
    var preferencesError: String?

    @ObservationIgnored private var engine: EngineClient?
    @ObservationIgnored private var listener: Task<Void, Never>?

    // MARK: Library

    private(set) var documents: [DocumentInfo] = []
    private(set) var counts = StatusCounts()
    private(set) var isLoadingLibrary = false
    private(set) var libraryError: String?
    private var filterValue: LibraryFilter? = .all
    private var queryValue = ""
    private var selectionValue: String?
    private(set) var current: DocumentModel?

    @ObservationIgnored private var loadGeneration = 0
    @ObservationIgnored private var queryTask: Task<Void, Never>?
    @ObservationIgnored private var countsTask: Task<Void, Never>?
    @ObservationIgnored private var knownStatus: [String: String] = [:]
    @ObservationIgnored private var activity: NSObjectProtocol?

    // MARK: Dialogs and window

    var isNewTranslationPresented = false
    let newTranslation: NewTranslationModel
    var isInspectorPresented = false
    var alert: AppAlert?
    var deleteCandidates: [DocumentInfo] = []
    var cancelCandidate: DocumentInfo?
    var renameCandidate: DocumentInfo?
    var renameText = ""

    @ObservationIgnored var openMainWindow: (@MainActor () -> Void)?
    @ObservationIgnored private var pendingFiles: [URL] = []

    private var readerSerifValue = UserDefaults.standard.bool(forKey: "ReaderSerif")

    private init() {
        newTranslation = NewTranslationModel()
        newTranslation.app = self
    }

    var readerSerif: Bool {
        get { readerSerifValue }
        set {
            readerSerifValue = newValue
            UserDefaults.standard.set(newValue, forKey: "ReaderSerif")
        }
    }

    var isReady: Bool { engineState == .ready }

    var needsShutdown: Bool { engine != nil }

    // MARK: - Engine lifecycle

    func start() {
        guard engineState != .starting else { return }
        Task { await startEngine() }
    }

    func startEngine() async {
        engineState = .starting
        if let previous = engine {
            engine = nil
            listener?.cancel()
            await previous.stop()
        }
        dataDirectory = LibraryLocation.current
        let client = EngineClient()
        do {
            let location = try EngineLocator.locate()
            try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
            try client.start(engine: location.engine, dataDirectory: dataDirectory, resources: location.resources)
            engine = client
            listen(to: client)
            let result: InitializeResult = try await client.call(
                "engine.initialize",
                params: InitializeParams(secrets: KeychainStore.readAll())
            )
            settings = result.settings
            engineVersion = result.version
            engineState = .ready
        } catch {
            if engine === client {
                engine = nil
            }
            await client.stop()
            // An engine that exited during start-up explains why on stderr.
            engineState = .failed(client.failureDescription ?? error.localizedDescription)
            return
        }
        await reloadLibrary()
        if let current {
            await current.load()
        }
        if !pendingFiles.isEmpty {
            let files = pendingFiles
            pendingFiles.removeAll()
            presentNewTranslation(with: files)
        }
    }

    func shutdown() async {
        guard let engine else { return }
        self.engine = nil
        listener?.cancel()
        await engine.stop()
        engineState = .stopped
        endActivity()
    }

    private func listen(to client: EngineClient) {
        listener?.cancel()
        listener = Task { [weak self] in
            for await notification in client.notifications {
                guard let self, self.engine === client else { return }
                self.handle(notification)
            }
        }
    }

    private func handle(_ notification: EngineNotification) {
        switch notification {
        case .event(let event):
            if let index = documents.firstIndex(where: { $0.id == event.documentId }), documents[index].isActive {
                documents[index].stage = event.stage
                documents[index].progress = max(documents[index].progress, event.progress)
            }
            current?.receive(event)
        case .documentChanged(let id):
            Task { await documentChanged(id) }
        case .documentRemoved(let id):
            documentRemoved(id)
        case .exited(let message):
            engine = nil
            engineState = .failed(message)
            endActivity()
        }
    }

    /// Calls the engine; fails with "处理引擎未运行" while it is not running.
    func call<Value: Decodable>(_ method: String, _ params: some Encodable) async throws -> Value {
        guard let engine else { throw EngineError.stopped }
        return try await engine.call(method, params: params)
    }

    // MARK: - Library

    var filter: LibraryFilter? {
        get { filterValue }
        set {
            guard newValue != filterValue else { return }
            filterValue = newValue
            Task { await reloadLibrary() }
        }
    }

    var query: String {
        get { queryValue }
        set {
            guard newValue != queryValue else { return }
            queryValue = newValue
            queryTask?.cancel()
            queryTask = Task {
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard !Task.isCancelled else { return }
                await reloadLibrary()
            }
        }
    }

    var selection: String? {
        get { selectionValue }
        set {
            guard newValue != selectionValue else { return }
            selectionValue = newValue
            if let newValue {
                let model = DocumentModel(id: newValue, app: self)
                current = model
                Task { await model.load() }
            } else {
                current = nil
            }
        }
    }

    var selectedDocument: DocumentInfo? {
        guard let selection else { return nil }
        if let current, current.id == selection, let info = current.info {
            return info
        }
        return documents.first { $0.id == selection }
    }

    func reloadLibrary() async {
        guard engine != nil else { return }
        loadGeneration += 1
        let generation = loadGeneration
        isLoadingLibrary = true
        do {
            let list: DocumentList = try await call(
                "documents.list",
                ListParams(filter: (filter ?? .all).rawValue, query: query.trimmed, limit: 2000)
            )
            guard generation == loadGeneration else { return }
            documents = list.items
            counts = list.counts
            libraryError = nil
            for document in list.items {
                knownStatus[document.id] = document.status
            }
            countsChanged()
        } catch {
            guard generation == loadGeneration else { return }
            libraryError = error.localizedDescription
        }
        isLoadingLibrary = false
    }

    private func documentChanged(_ id: String) async {
        guard let document: DocumentInfo = try? await call("documents.get", IDParams(id: id)) else { return }
        place(document)
        if let current, current.id == id {
            current.apply(document)
        }
        notifyIfFinished(document)
        refreshCountsSoon()
    }

    private func documentRemoved(_ id: String) {
        documents.removeAll { $0.id == id }
        knownStatus[id] = nil
        if selection == id {
            selection = nil
        }
        refreshCountsSoon()
    }

    /// Inserts, updates or drops one row according to the filter and search.
    private func place(_ document: DocumentInfo) {
        let search = query.trimmed
        let visible = (filter ?? .all).matches(document)
            && (search.isEmpty
                || document.title.localizedCaseInsensitiveContains(search)
                || document.originalFilename.localizedCaseInsensitiveContains(search))
        if let index = documents.firstIndex(where: { $0.id == document.id }) {
            // Responses to overlapping requests may arrive out of order.
            if documents[index].updatedAt > document.updatedAt {
                return
            }
            if visible {
                documents[index] = document
            } else {
                documents.remove(at: index)
            }
        } else if visible {
            // Newest first, like the engine's ORDER BY created_at DESC.
            let position = documents.firstIndex { $0.createdAt < document.createdAt } ?? documents.endIndex
            documents.insert(document, at: position)
        }
    }

    private func refreshCountsSoon() {
        countsTask?.cancel()
        countsTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled, let list: DocumentList = try? await call("documents.list", ListParams(limit: 1)) else {
                return
            }
            counts = list.counts
            countsChanged()
        }
    }

    /// Dock badge, and no App Nap or idle sleep while documents are processed.
    private func countsChanged() {
        NSApp.dockTile.badgeLabel = counts.active > 0 ? "\(counts.active)" : nil
        if counts.active > 0 {
            if activity == nil {
                activity = ProcessInfo.processInfo.beginActivity(options: .userInitiated, reason: "正在翻译文档")
            }
        } else {
            endActivity()
        }
    }

    private func endActivity() {
        if let activity {
            ProcessInfo.processInfo.endActivity(activity)
            self.activity = nil
        }
    }

    private func notifyIfFinished(_ document: DocumentInfo) {
        let previous = knownStatus[document.id]
        knownStatus[document.id] = document.status
        guard let previous, previous != document.status,
              document.status == "completed" || document.status == "failed",
              !NSApp.isActive
        else {
            return
        }
        Notifier.shared.post(
            title: document.isCompleted ? "翻译完成" : "处理失败",
            body: document.title,
            documentID: document.id
        )
    }

    // MARK: - Window and new translations

    func showMainWindow() {
        openMainWindow?()
        NSApp.activate()
    }

    /// Selects a document, e.g. from a notification.
    func reveal(documentID: String) {
        showMainWindow()
        if !documents.contains(where: { $0.id == documentID }) {
            query = ""
            filter = .all
        }
        selection = documentID
    }

    /// Files opened from Finder, the Dock or a drop onto the window.
    func openFiles(_ urls: [URL]) {
        let files = urls.filter { $0.isFileURL && FileManager.default.fileExists(atPath: $0.path) }
        guard !files.isEmpty else { return }
        guard isReady else {
            pendingFiles.append(contentsOf: files)
            showMainWindow()
            return
        }
        presentNewTranslation(with: files)
    }

    func presentNewTranslation(with files: [URL] = []) {
        showMainWindow()
        if !isNewTranslationPresented {
            newTranslation.reset()
        }
        newTranslation.add(files)
        isNewTranslationPresented = true
    }

    /// Called by the sheet after documents were queued.
    func didCreate(_ ids: [String]) {
        isNewTranslationPresented = false
        Task {
            if !(filter == .all || filter == .active) {
                filter = .all
            }
            await reloadLibrary()
            if let first = ids.first {
                selection = first
            }
        }
    }

    // MARK: - Document actions

    func retry(_ id: String) {
        perform("documents.retry", id: id, failure: "无法重新处理")
    }

    func cancel(_ id: String) {
        perform("documents.cancel", id: id, failure: "无法取消")
    }

    private func perform(_ method: String, id: String, failure: String) {
        Task {
            do {
                let document: DocumentInfo = try await call(method, IDParams(id: id))
                place(document)
                if let current, current.id == id {
                    current.apply(document)
                }
            } catch {
                alert = AppAlert(title: failure, message: error.localizedDescription)
            }
        }
    }

    func beginRename(_ document: DocumentInfo) {
        renameText = document.title
        renameCandidate = document
    }

    func commitRename() {
        guard let document = renameCandidate else { return }
        renameCandidate = nil
        let title = renameText.trimmed
        guard !title.isEmpty, title != document.title else { return }
        Task {
            do {
                let updated: DocumentInfo = try await call("documents.rename", RenameParams(id: document.id, title: title))
                place(updated)
                if let current, current.id == document.id {
                    current.apply(updated)
                }
            } catch {
                alert = AppAlert(title: "无法重命名", message: error.localizedDescription)
            }
        }
    }

    func beginDelete(_ ids: Set<String>) {
        deleteCandidates = documents.filter { ids.contains($0.id) }
        if deleteCandidates.isEmpty, let current = current?.info, ids.contains(current.id) {
            deleteCandidates = [current]
        }
    }

    func commitDelete() {
        let targets = deleteCandidates
        deleteCandidates = []
        Task {
            for document in targets {
                do {
                    let _: Empty = try await call("documents.delete", IDParams(id: document.id))
                } catch {
                    alert = AppAlert(title: "无法删除“\(document.title)”", message: error.localizedDescription)
                }
            }
        }
    }

    /// List rows carry no file paths; those come from documents.get.
    private func fetchFiles(of document: DocumentInfo) async -> DocumentFiles? {
        if let files = document.files {
            return files
        }
        let full: DocumentInfo? = try? await call("documents.get", IDParams(id: document.id))
        return full?.files
    }

    func revealInFinder(_ document: DocumentInfo) {
        Task {
            let files = await fetchFiles(of: document)
            if let path = files?.monoPdf ?? files?.journalPdf ?? files?.source ?? files?.archiveDir {
                FileActions.reveal(path)
            }
        }
    }

    /// Opens the main result in the default app (Preview for PDFs).
    func openExternally(_ document: DocumentInfo) {
        Task {
            let files = await fetchFiles(of: document)
            if let path = files?.monoPdf ?? files?.journalPdf ?? files?.readerHtml {
                FileActions.open(path)
            } else if let path = files?.source {
                FileActions.reveal(path)
            }
        }
    }

    func export(path: String, suggestedName: String) {
        Task {
            let type = UTType(filenameExtension: (suggestedName as NSString).pathExtension)
            guard let destination = await FileActions.chooseDestination(suggestedName: suggestedName, contentType: type) else {
                return
            }
            do {
                try FileActions.copy(path, to: destination)
            } catch {
                alert = AppAlert(title: "导出失败", message: error.localizedDescription)
            }
        }
    }

    func exportBundle(_ document: DocumentInfo) {
        Task {
            let name = document.suggestedNames?.bundle ?? "\(document.title).zip"
            guard let destination = await FileActions.chooseDestination(suggestedName: name, contentType: .zip) else {
                return
            }
            do {
                let _: ExportResult = try await call("documents.exportBundle", ExportParams(id: document.id, destination: destination.path))
                FileActions.reveal(destination.path)
            } catch {
                alert = AppAlert(title: "导出失败", message: error.localizedDescription)
            }
        }
    }

    // MARK: - Dialog state for bindings

    var isAlertPresented: Bool {
        get { alert != nil }
        set { if !newValue { alert = nil } }
    }

    var isRenamePresented: Bool {
        get { renameCandidate != nil }
        set { if !newValue { renameCandidate = nil } }
    }

    var isDeletePresented: Bool {
        get { !deleteCandidates.isEmpty }
        set { if !newValue { deleteCandidates = [] } }
    }

    var isCancelPresented: Bool {
        get { cancelCandidate != nil }
        set { if !newValue { cancelCandidate = nil } }
    }

    // MARK: - Settings

    var defaultModePreference: String {
        get { settings?.preferences.defaultMode ?? "pdf2zh" }
        set { setPreference(\.defaultMode, newValue) }
    }

    var defaultTranslatorPreference: TranslatorChoice {
        get { settings?.preferences.defaultTranslator ?? .google }
        set { setPreference(\.defaultTranslator, newValue) }
    }

    var workerConcurrencyPreference: Int {
        get { settings?.preferences.workerConcurrency ?? 2 }
        set { setPreference(\.workerConcurrency, newValue) }
    }

    var mineruModelPreference: String {
        get { settings?.preferences.mineruModel ?? "vlm" }
        set { setPreference(\.mineruModel, newValue) }
    }

    /// Google and every model of every usable provider.
    var translatorOptions: [TranslatorOption] {
        settings?.translatorOptions ?? [.google]
    }

    func setPreference<Value: Equatable>(_ keyPath: WritableKeyPath<Preferences, Value>, _ value: Value) {
        guard var preferences = settings?.preferences, preferences[keyPath: keyPath] != value else { return }
        preferences[keyPath: keyPath] = value
        settings?.preferences = preferences
        Task { await savePreferences(preferences) }
    }

    func savePreferences(_ preferences: Preferences) async {
        do {
            let updated: SettingsInfo = try await call("settings.update", SettingsUpdateParams(preferences: preferences))
            settings = updated
            preferencesError = nil
        } catch {
            preferencesError = error.localizedDescription
            await refreshSettings()
        }
    }

    func saveRuntime(_ runtime: TranslationRuntime) async throws {
        let updated: SettingsInfo = try await call("settings.update", SettingsUpdateParams(translationRuntime: runtime))
        settings = updated
    }

    func refreshSettings() async {
        if let updated: SettingsInfo = try? await call("settings.get", NoParams()) {
            settings = updated
        }
    }

    /// Checks the MinerU key with MinerU, then stores it in the keychain.
    func verifyAndStoreMineruKey(_ value: String) async throws {
        let _: Empty = try await call("secrets.verify", SecretParams(name: KeychainStore.mineru, value: value))
        try KeychainStore.write(KeychainStore.mineru, value)
        let updated: SettingsInfo = try await call("secrets.set", SecretParams(name: KeychainStore.mineru, value: value))
        settings = updated
    }

    func removeMineruKey() async throws {
        try KeychainStore.delete(KeychainStore.mineru)
        let updated: SettingsInfo = try await call("secrets.set", SecretParams(name: KeychainStore.mineru, value: nil))
        settings = updated
    }

    // MARK: - Providers

    /// Adds a provider from a preset; returns its id.
    func addProvider(_ preset: ProviderPreset, name: String? = nil, type: String? = nil, baseURL: String? = nil) async throws -> String {
        let existing = Set(settings?.providers.map(\.id) ?? [])
        var id = preset.id
        var suffix = 2
        while existing.contains(id) {
            id = "\(preset.id)-\(suffix)"
            suffix += 1
        }
        let config = ProviderConfig(
            id: id,
            name: name ?? (id == preset.id ? preset.name : "\(preset.name) \(suffix - 1)"),
            type: type ?? preset.type,
            baseUrl: baseURL ?? preset.baseUrl,
            enabled: true,
            models: [],
            concurrency: 100,
            preset: preset.id
        )
        try await saveProvider(config, extraBodyJSON: "")
        return id
    }

    func saveProvider(_ config: ProviderConfig, extraBodyJSON: String) async throws {
        let updated: SettingsInfo = try await call("providers.save", ProviderSaveParams(provider: config, extraBodyJson: extraBodyJSON))
        settings = updated
    }

    func deleteProvider(_ id: String) async throws {
        let updated: SettingsInfo = try await call("providers.delete", IDParams(id: id))
        try? KeychainStore.delete(KeychainStore.providerName(id))
        settings = updated
    }

    /// Stores one or more keys (separated by commas or new lines) for a provider.
    func setProviderKey(_ id: String, value: String?) async throws {
        let name = KeychainStore.providerName(id)
        if let value, !value.trimmed.isEmpty {
            try KeychainStore.write(name, value.trimmed)
        } else {
            try KeychainStore.delete(name)
        }
        let updated: SettingsInfo = try await call("secrets.set", SecretParams(name: name, value: value?.trimmed))
        settings = updated
    }

    func fetchModels(_ endpoint: EndpointParams) async throws -> [RemoteModel] {
        let result: RemoteModels = try await call("providers.models", endpoint)
        return result.models
    }

    func checkModel(_ endpoint: EndpointParams) async throws -> CheckResult {
        try await call("providers.check", endpoint)
    }

    func checkGoogle() async throws -> CheckResult {
        try await call("google.check", NoParams())
    }

    /// Uses (or creates) a "DocFlow" library inside the chosen folder and
    /// restarts the engine there. The old library stays where it was.
    func moveLibrary(to folder: URL) async {
        let target = folder.lastPathComponent == "DocFlow" ? folder : folder.appendingPathComponent("DocFlow", isDirectory: true)
        LibraryLocation.use(target)
        selection = nil
        documents = []
        counts = StatusCounts()
        await startEngine()
    }

    func showAbout() {
        let credits = NSMutableAttributedString(
            string: "DocFlow 本身以 MIT 许可证发布。PDF 原生翻译内置的 BabelDOC 与 PyMuPDF 以 GNU AGPL v3 许可证发布；期刊 PDF 由 Typst 排版，公式由 MiTeX 转换，阅读视图使用 KaTeX。各组件保留其原始许可证，详见应用包内的 THIRD_PARTY_NOTICES.md。\n\n",
            attributes: [.font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize), .foregroundColor: NSColor.secondaryLabelColor]
        )
        credits.append(NSAttributedString(
            string: "源代码与第三方许可",
            attributes: [
                .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize),
                .link: URL(string: "https://github.com/Uniseem/docflow")!,
            ]
        ))
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        credits.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: credits.length))
        var options: [NSApplication.AboutPanelOptionKey: Any] = [
            .applicationName: "DocFlow",
            .credits: credits,
        ]
        if !engineVersion.isEmpty {
            options[.version] = "引擎 \(engineVersion)"
        }
        NSApp.orderFrontStandardAboutPanel(options: options)
        NSApp.activate()
    }
}
