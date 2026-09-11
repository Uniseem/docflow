import AppKit
import SwiftUI

/// The Settings window (⌘,): 通用, 翻译服务, 文档解析, 网络, 高级.
@MainActor
struct SettingsView: View {
    var body: some View {
        TabView {
            GeneralSettingsView()
                .tabItem { Label("通用", systemImage: "gearshape") }
            ServicesSettingsView()
                .tabItem { Label("翻译服务", systemImage: "character.bubble") }
            MineruSettingsView()
                .tabItem { Label("文档解析", systemImage: "doc.viewfinder") }
            NetworkSettingsView()
                .tabItem { Label("网络", systemImage: "network") }
            AdvancedSettingsView()
                .tabItem { Label("高级", systemImage: "slider.horizontal.3") }
        }
        .frame(width: 720)
    }
}

/// Settings need a running engine; this replaces a tab's form until then.
@MainActor
private struct EngineRequired<Content: View>: View {
    @Environment(AppModel.self) private var model
    let height: CGFloat
    @ViewBuilder let content: () -> Content

    var body: some View {
        if model.settings != nil {
            content()
                .frame(height: height)
        } else {
            ContentUnavailableView {
                Label(model.engineState == .starting ? "正在启动处理引擎…" : "处理引擎未运行", systemImage: "gearshape.2")
            } description: {
                Text("处理引擎运行后才能修改这些设置。")
            } actions: {
                if model.engineState != .starting {
                    Button("重新启动处理引擎") { model.start() }
                }
            }
            .frame(height: 260)
        }
    }
}

/// A message under a form: red for errors, secondary otherwise.
@MainActor
private struct FormMessage: View {
    let text: String
    let isError: Bool

    var body: some View {
        Label {
            Text(text)
                .textSelection(.enabled)
        } icon: {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(isError ? Color.red : Color.green)
        }
        .font(.callout)
    }
}

// MARK: - 通用

@MainActor
private struct GeneralSettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        EngineRequired(height: 520) {
            Form {
                Section {
                    Picker("默认处理方式", selection: $model.defaultModePreference) {
                        Text("PDF 原生翻译").tag("pdf2zh")
                        Text("MinerU 解析翻译").tag("mineru")
                    }
                    Picker("默认翻译服务", selection: $model.defaultTranslatorPreference) {
                        ForEach(model.translatorOptions) { option in
                            Text(option.label).tag(option.choice)
                        }
                    }
                    Picker("同时处理的文档数", selection: $model.workerConcurrencyPreference) {
                        ForEach(1...4, id: \.self) { count in
                            Text("\(count)").tag(count)
                        }
                    }
                } header: {
                    Text("新建翻译")
                } footer: {
                    Text("Google 翻译免费可用；在“翻译服务”中添加大模型服务商后，可以选用它们的模型。同时处理更多文档会占用更多 CPU 和内存，翻译请求的并发由各服务商的“并发请求数”控制。")
                        .foregroundStyle(.secondary)
                }

                if let error = model.preferencesError {
                    Section {
                        FormMessage(text: error, isError: true)
                    }
                }

                Section {
                    LabeledContent("位置") {
                        Text(model.dataDirectory.path)
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                            .multilineTextAlignment(.trailing)
                    }
                    HStack {
                        Spacer()
                        Button("在访达中显示") { FileActions.openFolder(model.dataDirectory) }
                        Button("更改…") { changeLibrary() }
                            .disabled(LibraryLocation.isOverriddenByEnvironment)
                    }
                    LabeledContent("PDF 原生翻译运行环境") {
                        runtimeStatus
                    }
                    LabeledContent("日志") {
                        Button("在访达中显示") {
                            FileActions.openFolder(model.dataDirectory.appendingPathComponent("logs", isDirectory: true))
                        }
                    }
                } header: {
                    Text("文档库")
                } footer: {
                    Text("文档库保存源文件副本、译文、PDF 和处理记录。PDF 原生翻译要求文档库路径只包含英文字符。")
                        .foregroundStyle(.secondary)
                }

                if model.settings?.capabilities.fakeProviders == true {
                    Section {
                        Label("测试模式：翻译由本地测试文本代替，不会调用云端服务（DOCFLOW_FAKE_PROVIDERS=1）。", systemImage: "testtube.2")
                    }
                }
            }
            .formStyle(.grouped)
        }
    }

    @ViewBuilder
    private var runtimeStatus: some View {
        if let capabilities = model.settings?.capabilities {
            if capabilities.pdf2zhReady {
                Label {
                    Text("已就绪")
                } icon: {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
            } else {
                Text(capabilities.pdf2zhIssue ?? "不可用")
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.trailing)
                    .textSelection(.enabled)
            }
        }
    }

    private func changeLibrary() {
        Task {
            guard let folder = await FileActions.chooseFolder(
                message: "选择存放文档库的文件夹，DocFlow 会在其中使用“DocFlow”文件夹。",
                prompt: "选取"
            ) else {
                return
            }
            let alert = NSAlert()
            alert.messageText = "更改文档库位置？"
            var text = "DocFlow 会在新位置使用独立的文档库，现有文档保留在原位置，改回原位置即可再次看到。处理引擎将重新启动，进行中的任务会在下次打开对应文档库时继续。"
            if !folder.path.allSatisfy(\.isASCII) {
                text += "\n\n注意：该路径包含非英文字符，PDF 原生翻译需要纯英文路径。"
            }
            alert.informativeText = text
            alert.addButton(withTitle: "更改并重新启动引擎")
            alert.addButton(withTitle: "取消")
            if alert.runModal() == .alertFirstButtonReturn {
                await model.moveLibrary(to: folder)
            }
        }
    }
}

// MARK: - 翻译服务

private enum ServiceSelection: Hashable {
    case google
    case provider(String)
}

private struct PresetGroup: Hashable {
    var title: String
    var ids: [String]
}

/// Presets by group, as ids from engine/src/providers.rs.
private let presetGroups = [
    PresetGroup(title: "国内服务", ids: ["deepseek", "siliconflow", "dashscope", "volcengine", "moonshot", "zhipu", "hunyuan", "stepfun", "lingyi"]),
    PresetGroup(title: "国际服务", ids: ["openai", "anthropic", "gemini", "openrouter", "xai", "groq", "mistral", "azure"]),
    PresetGroup(title: "本机模型", ids: ["ollama", "lmstudio"]),
]

/// Like Mail's accounts: a list of services with + and −, and the
/// selected one's settings beside it.
@MainActor
private struct ServicesSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var selection: ServiceSelection? = .google
    @State private var isCustomPresented = false
    @State private var deleteCandidate: ProviderInfo?
    @State private var error: String?

    var body: some View {
        EngineRequired(height: 580) {
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    List(selection: $selection) {
                        Section("免费") {
                            Label("Google 翻译", systemImage: "globe")
                                .tag(ServiceSelection.google)
                        }
                        Section("大模型服务商") {
                            ForEach(model.settings?.providers ?? []) { provider in
                                ProviderRow(provider: provider, fake: model.settings?.capabilities.fakeProviders == true)
                                    .tag(ServiceSelection.provider(provider.id))
                            }
                        }
                    }
                    .listStyle(.sidebar)
                    Divider()
                    HStack(spacing: 2) {
                        Menu {
                            presetMenu
                        } label: {
                            Image(systemName: "plus")
                        }
                        .fixedSize()
                        .help("添加服务商")
                        .accessibilityLabel("添加服务商")
                        Button {
                            if case .provider(let id) = selection {
                                deleteCandidate = model.settings?.provider(id)
                            }
                        } label: {
                            Image(systemName: "minus")
                        }
                        .help("删除所选服务商")
                        .accessibilityLabel("删除所选服务商")
                        .disabled(selectedProviderID == nil)
                        Spacer()
                    }
                    .buttonStyle(.borderless)
                    .padding(6)
                }
                .frame(width: 230)
                Divider()
                detail
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .sheet(isPresented: $isCustomPresented) {
            CustomProviderSheet { name, type, address in
                add(customPreset, name: name, type: type, baseURL: address)
            }
        }
        .confirmationDialog(
            "删除“\(deleteCandidate?.name ?? "")”？",
            isPresented: Binding(get: { deleteCandidate != nil }, set: { if !$0 { deleteCandidate = nil } }),
            titleVisibility: .visible
        ) {
            Button("删除服务商", role: .destructive) {
                if let candidate = deleteCandidate {
                    delete(candidate)
                }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("服务商的设置和保存在钥匙串中的 API Key 会被删除。已经完成的文档不受影响；使用它排队中的文档将无法继续翻译。")
        }
        .alert("操作失败", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("好") {}
        } message: {
            Text(error ?? "")
        }
    }

    private var selectedProviderID: String? {
        if case .provider(let id) = selection, model.settings?.provider(id) != nil {
            return id
        }
        return nil
    }

    @ViewBuilder
    private var detail: some View {
        if let id = selectedProviderID {
            ProviderDetailView(id: id)
                .id(id)
        } else {
            GoogleServiceView()
        }
    }

    @ViewBuilder
    private var presetMenu: some View {
        let presets = model.settings?.providerPresets ?? []
        ForEach(presetGroups, id: \.title) { group in
            Section(group.title) {
                ForEach(presets.filter { group.ids.contains($0.id) }) { preset in
                    Button(preset.name) { add(preset) }
                }
            }
        }
        Divider()
        Button("自定义服务商…") { isCustomPresented = true }
    }

    private var customPreset: ProviderPreset {
        model.settings?.providerPresets.first { $0.id == "custom" }
            ?? ProviderPreset(id: "custom", name: "自定义服务商", type: "openai", baseUrl: "", keyUrl: "", keyOptional: false)
    }

    private func add(_ preset: ProviderPreset, name: String? = nil, type: String? = nil, baseURL: String? = nil) {
        Task {
            do {
                let id = try await model.addProvider(preset, name: name, type: type, baseURL: baseURL)
                selection = .provider(id)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func delete(_ provider: ProviderInfo) {
        Task {
            do {
                try await model.deleteProvider(provider.id)
                selection = .google
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

@MainActor
private struct ProviderRow: View {
    let provider: ProviderInfo
    let fake: Bool

    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                Circle()
                    .fill(provider.enabled ? Color.accentColor : Color.gray)
                Text(String(provider.name.prefix(1)).uppercased())
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.white)
            }
            .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(provider.name)
                    .lineLimit(1)
                Text(status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private var status: String {
        if !provider.enabled { return "已停用" }
        if provider.models.isEmpty { return "需要添加模型" }
        if !(fake || provider.keyConfigured || provider.keyOptional) { return "需要 API Key" }
        return "\(provider.models.count) 个模型"
    }
}

@MainActor
private struct GoogleServiceView: View {
    @Environment(AppModel.self) private var model
    @State private var concurrency = 8
    @State private var loaded = false
    @State private var isChecking = false
    @State private var status: String?
    @State private var statusIsError = false

    var body: some View {
        Form {
            Section {
                Text("无需 API Key，速度快，适合快速阅读。所在网络无法直接访问 Google 时，请在“网络”中设置代理。")
                    .foregroundStyle(.secondary)
                HStack {
                    Button("测试连接", action: check)
                        .disabled(isChecking)
                    if isChecking {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Spacer()
                }
                if let status {
                    FormMessage(text: status, isError: statusIsError)
                }
            } header: {
                Text("Google 翻译（免费）")
            }
            Section {
                NumberField(
                    "并发请求数",
                    value: $concurrency,
                    range: 1...(model.settings?.translationRuntimeLimits.googleConcurrencyMax ?? 64)
                )
            } footer: {
                Text("免费接口对频率敏感，默认 8。遇到限流会自动降低并发并重试。")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear {
            concurrency = model.settings?.translationRuntime.google.concurrency ?? 8
            loaded = true
        }
        .onChange(of: concurrency) { _, value in
            guard loaded, var runtime = model.settings?.translationRuntime, runtime.google.concurrency != value else { return }
            runtime.google.concurrency = value
            Task {
                do {
                    try await model.saveRuntime(runtime)
                } catch {
                    status = error.localizedDescription
                    statusIsError = true
                }
            }
        }
    }

    private func check() {
        isChecking = true
        status = "正在连接 Google 翻译…"
        statusIsError = false
        Task {
            do {
                let result = try await model.checkGoogle()
                status = "连接正常 · \(result.latencyMs) ms · “Hello, world.” → “\(result.reply)”"
                statusIsError = false
            } catch {
                status = error.localizedDescription
                statusIsError = true
            }
            isChecking = false
        }
    }
}

private struct ModelCheck {
    var running = false
    var text: String?
    var failed = false
}

private struct ModelPickerRequest: Identifiable {
    let id = UUID()
    let models: [RemoteModel]
    let selected: Set<String>
}

/// One provider's settings. Toggles, models and the concurrency apply at
/// once; text fields when editing ends, like System Settings.
@MainActor
private struct ProviderDetailView: View {
    @Environment(AppModel.self) private var model
    let id: String

    @State private var name = ""
    @State private var baseURL = ""
    @State private var concurrency = 100
    @State private var extraJSON = ""
    @State private var keyInput = ""
    @State private var loaded = false
    @State private var isBusy = false
    @State private var isFetching = false
    @State private var message: String?
    @State private var messageIsError = false
    @State private var checks: [String: ModelCheck] = [:]
    @State private var picker: ModelPickerRequest?
    @State private var isAddModelPresented = false
    @State private var newModelID = ""
    @FocusState private var nameFocused: Bool
    @FocusState private var addressFocused: Bool

    private var provider: ProviderInfo? { model.settings?.provider(id) }

    var body: some View {
        if let provider {
            Form {
                Section {
                    Toggle("启用", isOn: Binding(
                        get: { provider.enabled },
                        set: { value in save { $0.enabled = value } }
                    ))
                    TextField("名称", text: $name)
                        .focused($nameFocused)
                        .onSubmit(commitText)
                    LabeledContent("接口类型", value: Format.providerType(provider.type))
                    TextField("API 地址", text: $baseURL, prompt: Text("https://…/v1"))
                        .focused($addressFocused)
                        .onSubmit(commitText)
                    Text("请求地址：\(Format.chatEndpoint(type: provider.type, baseURL: baseURL, model: provider.models.first?.id))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                } header: {
                    Text(provider.name)
                }

                Section {
                    LabeledContent("状态") {
                        if provider.keyConfigured {
                            Label {
                                Text("已保存 \(provider.keyMasked ?? "")")
                            } icon: {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                            }
                        } else {
                            Text(provider.keyOptional ? "本机服务，无需 Key" : "未填写")
                                .foregroundStyle(.secondary)
                        }
                    }
                    SecureField("API Key", text: $keyInput, prompt: Text(provider.keyConfigured ? "输入新的 Key 以替换" : "粘贴 API Key"))
                        .onSubmit(saveKey)
                    HStack {
                        if let url = URL(string: provider.keyUrl ?? ""), provider.keyUrl?.isEmpty == false {
                            Link("获取 API Key", destination: url)
                        }
                        Spacer()
                        if isBusy {
                            ProgressView()
                                .controlSize(.small)
                        }
                        if provider.keyConfigured {
                            Button("移除", role: .destructive, action: removeKey)
                                .disabled(isBusy)
                        }
                        Button("保存", action: saveKey)
                            .disabled(isBusy || keyInput.trimmed.isEmpty)
                    }
                } header: {
                    Text("API Key")
                } footer: {
                    Text("多个 Key 用英文逗号分隔，请求会轮流使用；某个 Key 失效或余额不足时自动改用其余的。Key 保存在“钥匙串”中，只在本机传给处理引擎。")
                        .foregroundStyle(.secondary)
                }

                Section {
                    if provider.models.isEmpty {
                        Text("还没有模型。填写 API Key 后点按“获取模型列表”，或按服务商文档手动添加模型 ID。")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(provider.models, id: \.id) { item in
                        ModelRow(
                            model: item,
                            check: checks[item.id] ?? ModelCheck(),
                            onCheck: { check(item.id) },
                            onRemove: { save { $0.models.removeAll { $0.id == item.id } } }
                        )
                    }
                    HStack {
                        Spacer()
                        Button("手动添加…") {
                            newModelID = ""
                            isAddModelPresented = true
                        }
                        Button(action: fetchModels) {
                            HStack(spacing: 6) {
                                if isFetching {
                                    ProgressView()
                                        .controlSize(.small)
                                }
                                Text("获取模型列表…")
                            }
                        }
                        .disabled(isFetching)
                    }
                } header: {
                    Text("模型")
                }

                Section {
                    NumberField(
                        "并发请求数",
                        value: $concurrency,
                        range: 1...(model.settings?.translationRuntimeLimits.providerConcurrencyMax ?? 2_000),
                        step: 10
                    )
                } footer: {
                    Text("同时发往这个服务商的请求上限，所有文档共用；默认 100。遇到限流（HTTP 429）会自动减半，恢复后逐步回升。")
                        .foregroundStyle(.secondary)
                }

                Section {
                    TextEditor(text: $extraJSON)
                        .font(.body.monospaced())
                        .frame(minHeight: 64)
                    HStack {
                        Spacer()
                        Button("应用") {
                            save(extraJSON: extraJSON)
                        }
                        .disabled(extraJSON.trimmed == provider.extraBodyJson.trimmed)
                    }
                } header: {
                    Text("附加请求参数（JSON，可选）")
                } footer: {
                    Text("合并进每个请求，例如 {\"temperature\": 0.3}，或关闭思考模式的参数。")
                        .foregroundStyle(.secondary)
                }

                if let message {
                    Section {
                        FormMessage(text: message, isError: messageIsError)
                    }
                }
            }
            .formStyle(.grouped)
            .onAppear(perform: load)
            .onChange(of: concurrency) { _, value in
                if loaded, value != provider.concurrency {
                    save { $0.concurrency = value }
                }
            }
            .onChange(of: nameFocused) { _, focused in
                if !focused { commitText() }
            }
            .onChange(of: addressFocused) { _, focused in
                if !focused { commitText() }
            }
            .sheet(item: $picker) { request in
                ModelPickerSheet(providerName: provider.name, models: request.models, initial: request.selected) { selected in
                    applySelection(request.models, selected: selected)
                }
            }
            .alert("添加模型", isPresented: $isAddModelPresented) {
                TextField("模型 ID", text: $newModelID)
                Button("添加") {
                    let modelID = newModelID.trimmed
                    guard !modelID.isEmpty, !provider.models.contains(where: { $0.id == modelID }) else { return }
                    save { $0.models.append(ModelConfig(id: modelID, name: nil)) }
                }
                Button("取消", role: .cancel) {}
            } message: {
                Text("与服务商文档中的模型名称一致，例如 deepseek-chat。")
            }
        } else {
            ContentUnavailableView("没有选择服务商", systemImage: "sparkles")
        }
    }

    private func load() {
        guard let provider, !loaded else { return }
        name = provider.name
        baseURL = provider.baseUrl
        concurrency = provider.concurrency
        extraJSON = provider.extraBodyJson
        loaded = true
    }

    private func show(_ text: String, error: Bool) {
        message = text
        messageIsError = error
    }

    /// Saves the provider with a change applied; failures keep the edits.
    private func save(extraJSON: String? = nil, _ change: (inout ProviderConfig) -> Void = { _ in }) {
        guard let provider else { return }
        var config = provider.config
        change(&config)
        let extra = extraJSON ?? provider.extraBodyJson
        Task {
            do {
                try await model.saveProvider(config, extraBodyJSON: extra)
                if messageIsError {
                    message = nil
                }
            } catch {
                show(error.localizedDescription, error: true)
            }
        }
    }

    private func commitText() {
        guard let provider else { return }
        let newName = name.trimmed
        var newURL = baseURL.trimmed
        while newURL.hasSuffix("/") {
            newURL.removeLast()
        }
        guard newName != provider.name || newURL != provider.baseUrl else { return }
        save {
            $0.name = newName
            $0.baseUrl = newURL
        }
    }

    private func saveKey() {
        let value = keyInput.trimmed
        guard !value.isEmpty, !isBusy else { return }
        isBusy = true
        Task {
            do {
                try await model.setProviderKey(id, value: value)
                keyInput = ""
                show(provider?.models.isEmpty == false ? "已保存到钥匙串。可以点按模型旁的“检查”确认 Key 可用。" : "已保存到钥匙串。下一步：获取模型列表。", error: false)
            } catch {
                show(error.localizedDescription, error: true)
            }
            isBusy = false
        }
    }

    private func removeKey() {
        isBusy = true
        Task {
            do {
                try await model.setProviderKey(id, value: nil)
                show("已移除 Key。", error: false)
            } catch {
                show(error.localizedDescription, error: true)
            }
            isBusy = false
        }
    }

    /// The address and key being edited, or the stored key.
    private func endpoint(model modelID: String?) -> EndpointParams? {
        guard let provider else { return nil }
        return EndpointParams(
            providerId: id,
            name: name.trimmed.isEmpty ? provider.name : name.trimmed,
            type: provider.type,
            baseUrl: baseURL.trimmed,
            apiKey: keyInput.trimmed.isEmpty ? nil : keyInput.trimmed,
            model: modelID,
            extraBodyJson: extraJSON
        )
    }

    private func fetchModels() {
        guard let endpoint = endpoint(model: nil), let provider else { return }
        isFetching = true
        message = nil
        Task {
            do {
                let remote = try await model.fetchModels(endpoint)
                if remote.isEmpty {
                    show("服务商没有返回任何模型，请手动添加模型 ID。", error: true)
                } else {
                    let listed = Set(remote.map(\.id))
                    picker = ModelPickerRequest(
                        models: remote,
                        selected: Set(provider.models.map(\.id).filter { listed.contains($0) })
                    )
                }
            } catch {
                show(error.localizedDescription, error: true)
            }
            isFetching = false
        }
    }

    /// Models of the fetched list are in or out as ticked; models added by
    /// hand stay.
    private func applySelection(_ remote: [RemoteModel], selected: Set<String>) {
        guard let provider else { return }
        let listed = Set(remote.map(\.id))
        var models = provider.models.filter { !listed.contains($0.id) || selected.contains($0.id) }
        let removedCount = provider.models.count - models.count
        let added = remote.filter { candidate in
            selected.contains(candidate.id) && !models.contains { $0.id == candidate.id }
        }
        models += added.map { ModelConfig(id: $0.id, name: $0.name) }
        guard removedCount > 0 || !added.isEmpty else { return }
        save { $0.models = models }
        if !added.isEmpty && removedCount > 0 {
            show("已添加 \(added.count) 个、移除 \(removedCount) 个模型。", error: false)
        } else if !added.isEmpty {
            show("已添加 \(added.count) 个模型。", error: false)
        } else {
            show("已移除 \(removedCount) 个模型。", error: false)
        }
    }

    private func check(_ modelID: String) {
        guard let endpoint = endpoint(model: modelID) else { return }
        checks[modelID] = ModelCheck(running: true)
        Task {
            do {
                let result = try await model.checkModel(endpoint)
                checks[modelID] = ModelCheck(text: "可用 · \(result.latencyMs) ms · “\(result.reply)”")
            } catch {
                checks[modelID] = ModelCheck(text: error.localizedDescription, failed: true)
            }
        }
    }
}

@MainActor
private struct ModelRow: View {
    let model: ModelConfig
    let check: ModelCheck
    let onCheck: () -> Void
    let onRemove: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.name.map { $0 == model.id ? model.id : "\($0)（\(model.id)）" } ?? model.id)
                    .textSelection(.enabled)
                if let text = check.text {
                    Text(text)
                        .font(.caption)
                        .foregroundStyle(check.failed ? Color.red : Color.green)
                        .textSelection(.enabled)
                }
            }
            Spacer()
            if check.running {
                ProgressView()
                    .controlSize(.small)
            }
            Button("检查", action: onCheck)
                .disabled(check.running)
                .help("用这个模型发送一个测试请求")
            Button(action: onRemove) {
                Image(systemName: "trash")
            }
            .buttonStyle(.borderless)
            .help("移除模型")
            .accessibilityLabel("移除 \(model.id)")
        }
    }
}

/// Ticks the models to use from the provider's list, with a search field.
@MainActor
private struct ModelPickerSheet: View {
    let providerName: String
    let models: [RemoteModel]
    let apply: (Set<String>) -> Void
    @State private var selected: Set<String>
    @State private var search = ""
    @Environment(\.dismiss) private var dismiss

    init(providerName: String, models: [RemoteModel], initial: Set<String>, apply: @escaping (Set<String>) -> Void) {
        self.providerName = providerName
        self.models = models
        self.apply = apply
        _selected = State(initialValue: initial)
    }

    private var visible: [RemoteModel] {
        let query = search.trimmed
        guard !query.isEmpty else { return models }
        return models.filter {
            $0.id.localizedCaseInsensitiveContains(query) || ($0.name?.localizedCaseInsensitiveContains(query) ?? false)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Text("\(providerName) 的模型")
                .font(.headline)
                .padding(.top, 16)
            TextField("搜索", text: $search, prompt: Text("在 \(models.count) 个模型中搜索"))
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            List {
                ForEach(visible) { item in
                    Toggle(isOn: Binding(
                        get: { selected.contains(item.id) },
                        set: { isOn in
                            if isOn {
                                selected.insert(item.id)
                            } else {
                                selected.remove(item.id)
                            }
                        }
                    )) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.id)
                            if let details = details(item) {
                                Text(details)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .toggleStyle(.checkbox)
                }
            }
            Divider()
            HStack {
                Text("已选择 \(selected.count) 个模型")
                    .foregroundStyle(.secondary)
                Spacer()
                Button("取消", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("确定") {
                    apply(selected)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
            .padding(16)
        }
        .frame(width: 480, height: 540)
    }

    private func details(_ item: RemoteModel) -> String? {
        var parts: [String] = []
        if let name = item.name, name != item.id {
            parts.append(name)
        }
        if let owner = item.owner {
            parts.append(owner)
        }
        if let context = item.contextLength {
            parts.append("上下文 \(context / 1000)K")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

@MainActor
private struct CustomProviderSheet: View {
    let add: (String, String, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var type = "openai"
    @State private var address = ""

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    TextField("名称", text: $name, prompt: Text("例如 公司网关"))
                    Picker("接口类型", selection: $type) {
                        Text("OpenAI 兼容（最常见）").tag("openai")
                        Text("Anthropic").tag("anthropic")
                        Text("Gemini").tag("gemini")
                        Text("Azure OpenAI").tag("azure")
                    }
                    TextField("API 地址", text: $address, prompt: Text("https://example.com/v1"))
                } header: {
                    Text("添加自定义服务商")
                } footer: {
                    Text("OpenAI 兼容接口填写到 /v1 为止，程序会在后面加上 /chat/completions。")
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                Button("取消", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("添加") {
                    add(name.trimmed, type, address.trimmed)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!isValid)
            }
            .padding(16)
        }
        .frame(width: 480)
    }

    private var isValid: Bool {
        guard !name.trimmed.isEmpty, let url = URL(string: address.trimmed), let scheme = url.scheme else { return false }
        return scheme == "http" || scheme == "https"
    }
}

// MARK: - 文档解析

@MainActor
private struct MineruSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var input = ""
    @State private var isBusy = false
    @State private var message: String?
    @State private var messageIsError = false

    var body: some View {
        @Bindable var model = model
        EngineRequired(height: 360) {
            Form {
                Section {
                    LabeledContent("状态") {
                        if model.settings?.mineru.configured == true {
                            Label {
                                Text("已配置 \(model.settings?.mineru.masked ?? "")")
                            } icon: {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                            }
                        } else {
                            Text("未配置")
                                .foregroundStyle(.secondary)
                        }
                    }
                    SecureField("API Key", text: $input, prompt: Text(model.settings?.mineru.configured == true ? "输入新的 Key 以替换" : "粘贴 API Key"))
                        .onSubmit(save)
                    Picker("解析模型", selection: $model.mineruModelPreference) {
                        Text("VLM").tag("vlm")
                        Text("Pipeline").tag("pipeline")
                    }
                    HStack {
                        Spacer()
                        if isBusy {
                            ProgressView()
                                .controlSize(.small)
                        }
                        if model.settings?.mineru.configured == true {
                            Button("移除", role: .destructive, action: remove)
                                .disabled(isBusy)
                        }
                        Button("验证并保存", action: save)
                            .disabled(isBusy || input.trimmed.isEmpty)
                    }
                    if let message {
                        FormMessage(text: message, isError: messageIsError)
                    }
                } header: {
                    Text("MinerU")
                } footer: {
                    Text("MinerU 解析翻译使用的文档解析服务。VLM 对复杂版面和公式识别更好，Pipeline 速度更快。Key 保存前会先向 MinerU 验证，保存在“钥匙串”中。")
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
        }
    }

    private func save() {
        let value = input.trimmed
        guard !value.isEmpty, !isBusy else { return }
        isBusy = true
        message = nil
        Task {
            do {
                try await model.verifyAndStoreMineruKey(value)
                input = ""
                message = "已验证并保存到钥匙串。"
                messageIsError = false
            } catch {
                message = error.localizedDescription
                messageIsError = true
            }
            isBusy = false
        }
    }

    private func remove() {
        isBusy = true
        Task {
            do {
                try await model.removeMineruKey()
                message = "已移除。"
                messageIsError = false
            } catch {
                message = error.localizedDescription
                messageIsError = true
            }
            isBusy = false
        }
    }
}

// MARK: - 网络

@MainActor
private struct NetworkSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var mode = "system"
    @State private var address = ""

    var body: some View {
        EngineRequired(height: 330) {
            Form {
                Section {
                    Picker("代理", selection: $mode) {
                        Text("跟随系统").tag("system")
                        Text("不使用代理").tag("direct")
                        Text("自定义").tag("custom")
                    }
                    .pickerStyle(.radioGroup)
                    if mode == "custom" {
                        TextField("代理地址", text: $address, prompt: Text("http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"))
                            .onSubmit(applyCustom)
                        HStack {
                            Spacer()
                            Button("应用", action: applyCustom)
                                .disabled(address.trimmed.isEmpty || isCurrent)
                        }
                    }
                } footer: {
                    Text("处理引擎访问 Google 翻译、大模型服务商和 MinerU 时使用的网络代理。“跟随系统”会读取“系统设置”中的代理。")
                        .foregroundStyle(.secondary)
                }
                if let error = model.preferencesError {
                    Section {
                        FormMessage(text: error, isError: true)
                    }
                }
            }
            .formStyle(.grouped)
            // The form only appears once the engine's settings are known.
            .onAppear(perform: load)
            .onChange(of: mode) { _, value in
                if value != "custom" {
                    model.setPreference(\.proxy, ProxySettings(mode: value, url: nil))
                }
            }
        }
    }

    private var isCurrent: Bool {
        model.settings?.preferences.proxy == ProxySettings(mode: "custom", url: address.trimmed)
    }

    private func load() {
        let proxy = model.settings?.preferences.proxy
        mode = proxy?.mode ?? "system"
        address = proxy?.url ?? ""
    }

    private func applyCustom() {
        let url = address.trimmed
        guard !url.isEmpty else { return }
        model.setPreference(\.proxy, ProxySettings(mode: "custom", url: url))
    }
}

// MARK: - 高级

@MainActor
private struct AdvancedSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var runtime = TranslationRuntime.fallback
    @State private var loaded = false
    @State private var message: String?
    @State private var messageIsError = false

    var body: some View {
        EngineRequired(height: 700) {
            if let limits = model.settings?.translationRuntimeLimits {
                Form {
                    Section("Google 翻译") {
                        NumberField("每次请求最多字符", value: $runtime.google.chunkChars, range: limits.minChunkChars...limits.googleChunkCharsMax, step: 100)
                    }
                    Section {
                        NumberField("每段最多字符", value: $runtime.llm.chunkChars, range: limits.minChunkChars...limits.llmChunkCharsMax, step: 100)
                        NumberField("单次请求最多段数", value: $runtime.llm.maxSegmentsPerRequest, range: 1...limits.llmSegmentsPerRequestMax)
                        NumberField("单次请求最多字符", value: $runtime.llm.maxRequestChars, range: limits.llmRequestCharsMin...limits.llmRequestCharsMax, step: 500)
                        NumberField("最大输出 tokens", value: $runtime.llm.maxOutputTokens, range: 0...limits.llmOutputTokensMax, step: 1_024)
                    } header: {
                        Text("大模型")
                    } footer: {
                        Text("每个段落是一段，更长的段落在句子边界拆开。最大输出 tokens 为 0 时使用服务商的默认值。各服务商的并发请求数在“翻译服务”中设置。")
                            .foregroundStyle(.secondary)
                    }
                    Section {
                        NumberField("单个文档最多同时发出的请求数", value: $runtime.perDocumentConcurrency, range: 1...limits.perDocumentConcurrencyMax)
                    }
                    Section {
                        TextEditor(text: $runtime.systemPrompt)
                            .font(.body)
                            .frame(minHeight: 150)
                    } header: {
                        Text("翻译提示词（大模型）")
                    } footer: {
                        Text("最多 \(limits.systemPromptMaxChars) 个字符。公式、代码、链接和排版标记由程序在本地保护，提示词无需说明这些规则。新任务使用新参数，进行中的任务保持提交时的设置。")
                            .foregroundStyle(.secondary)
                    }
                    Section {
                        HStack {
                            if let message {
                                Text(message)
                                    .font(.callout)
                                    .foregroundStyle(messageIsError ? Color.red : Color.secondary)
                            }
                            Spacer()
                            Button("恢复默认", action: reset)
                            Button("保存", action: save)
                                .disabled(!loaded || !isChanged)
                        }
                    }
                }
                .formStyle(.grouped)
                .onAppear {
                    if !loaded, let current = model.settings?.translationRuntime {
                        runtime = current
                        loaded = true
                    }
                }
            }
        }
    }

    /// The Google concurrency is set (and saved) in “翻译服务”.
    private var withSavedGoogleConcurrency: TranslationRuntime {
        var value = runtime
        value.google.concurrency = model.settings?.translationRuntime.google.concurrency ?? runtime.google.concurrency
        return value
    }

    private var isChanged: Bool {
        withSavedGoogleConcurrency != model.settings?.translationRuntime
    }

    private func reset() {
        if let defaults = model.settings?.translationRuntimeDefaults {
            runtime = defaults
            message = "已恢复默认值，点按“保存”后生效。"
            messageIsError = false
        }
    }

    private func save() {
        let runtime = withSavedGoogleConcurrency
        Task {
            do {
                try await model.saveRuntime(runtime)
                message = "已保存。"
                messageIsError = false
            } catch {
                message = error.localizedDescription
                messageIsError = true
            }
        }
    }
}

/// A number with a text field and a stepper, kept within its range.
@MainActor
private struct NumberField: View {
    let title: String
    @Binding var value: Int
    let range: ClosedRange<Int>
    let step: Int

    init(_ title: String, value: Binding<Int>, range: ClosedRange<Int>, step: Int = 1) {
        self.title = title
        self._value = value
        self.range = range
        self.step = step
    }

    var body: some View {
        LabeledContent(title) {
            HStack(spacing: 4) {
                TextField(title, value: $value, format: .number.grouping(.never))
                    .labelsHidden()
                    .multilineTextAlignment(.trailing)
                    .frame(width: 90)
                Stepper(title, value: $value, in: range, step: step)
                    .labelsHidden()
            }
        }
        .onChange(of: value) { _, newValue in
            let clamped = min(max(newValue, range.lowerBound), range.upperBound)
            if clamped != newValue {
                value = clamped
            }
        }
    }
}

extension TranslationRuntime {
    /// Only shown for a moment before the engine's values arrive.
    static let fallback = TranslationRuntime(
        google: GoogleRuntime(concurrency: 8, chunkChars: 3_000),
        llm: LLMRuntime(chunkChars: 4_000, maxSegmentsPerRequest: 8, maxRequestChars: 8_000, maxOutputTokens: 0),
        perDocumentConcurrency: 100,
        systemPrompt: ""
    )
}
