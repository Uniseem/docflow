import SwiftUI

/// The selected document: progress while it is processed, the translated
/// result once it is done, and an inspector with its details.
@MainActor
struct DocumentDetailView: View {
    @Environment(AppModel.self) private var model
    @Bindable var document: DocumentModel

    var body: some View {
        @Bindable var model = model
        content
            .navigationTitle(document.info?.title ?? "")
            .navigationSubtitle(document.subtitle)
            .toolbar {
                toolbar
            }
            .inspector(isPresented: $model.isInspectorPresented) {
                DocumentInspector(document: document)
                    .inspectorColumnWidth(min: 260, ideal: 300, max: 420)
            }
    }

    @ViewBuilder
    private var content: some View {
        if let info = document.info {
            if info.isCompleted, let view = document.selectedView {
                ResultContent(document: document, view: view)
            } else {
                ProgressDetailView(document: document)
            }
        } else if let error = document.loadError {
            ContentUnavailableView("无法打开文档", systemImage: "exclamationmark.triangle", description: Text(error))
        } else {
            ProgressView()
        }
    }

    /// Two groups of toolbar items — what to do with the document, and how
    /// to look at it — with a spacer between them, so macOS 26 gives each
    /// group its own glass capsule instead of running everything together.
    /// Before macOS 26 there is no glass to split, and the groups simply
    /// follow one another.
    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if document.availableViews.count > 1 {
            ToolbarItem(placement: .principal) {
                Picker("视图", selection: $document.selectedView) {
                    ForEach(document.availableViews) { view in
                        Text(view.title).tag(Optional(view))
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .help("切换视图")
            }
        }
        // Every status puts something in this group, so it never leaves an
        // empty capsule behind; while the document loads it is left out
        // along with the spacer.
        if let info = document.info {
            ToolbarItemGroup(placement: .primaryAction) {
                if info.isStopped {
                    Button {
                        model.retry(info.id)
                    } label: {
                        Label("重新处理", systemImage: "arrow.clockwise")
                    }
                    .help("重新处理这个文档")
                }
                if info.isActive {
                    Button {
                        model.cancelCandidate = info
                    } label: {
                        Label("取消处理", systemImage: "stop.circle")
                    }
                    .help("取消处理")
                }
                if info.isCompleted {
                    Button {
                        model.openExternally(info)
                    } label: {
                        Label("用默认应用打开", systemImage: "arrow.up.forward.app")
                    }
                    .help("用默认应用打开译文")
                    ExportMenu(info: info)
                }
            }
            #if compiler(>=6.2)
            if #available(macOS 26.0, *) {
                ToolbarSpacer(.fixed, placement: .primaryAction)
            }
            #endif
        }
        ToolbarItemGroup(placement: .primaryAction) {
            if let info = document.info, info.isCompleted, document.selectedView == .reader {
                Toggle(isOn: Bindable(model).readerSerif) {
                    Label("衬线字体", systemImage: "textformat")
                }
                .help("阅读视图使用衬线字体")
            }
            Button {
                model.isInspectorPresented.toggle()
            } label: {
                Label("文档信息", systemImage: "info.circle")
            }
            .help("显示或隐藏文档信息")
        }
    }
}

@MainActor
struct ExportMenu: View {
    @Environment(AppModel.self) private var model
    let info: DocumentInfo

    var body: some View {
        Menu {
            let files = info.files
            let names = info.suggestedNames
            if let path = files?.monoPdf {
                Button("中文 PDF…") { model.export(path: path, suggestedName: names?.monoPdf ?? "\(info.title).pdf") }
            }
            if let path = files?.dualPdf {
                Button("双语对照 PDF…") { model.export(path: path, suggestedName: names?.dualPdf ?? "\(info.title)（双语）.pdf") }
            }
            if let path = files?.journalPdf {
                Button("期刊排版 PDF…") { model.export(path: path, suggestedName: names?.journalPdf ?? "\(info.title).pdf") }
            }
            if let path = files?.markdown {
                Button("Markdown 译文…") { model.export(path: path, suggestedName: names?.markdown ?? "\(info.title).md") }
            }
            Divider()
            if let path = files?.source {
                Button("源文件…") { model.export(path: path, suggestedName: names?.source ?? info.originalFilename) }
            }
            Button("全部文件（ZIP）…") { model.exportBundle(info) }
        } label: {
            Label("导出", systemImage: "square.and.arrow.up")
        }
        .help("导出译文、PDF 或全部文件")
    }
}

/// The completed document in the chosen view.
@MainActor
struct ResultContent: View {
    @Environment(AppModel.self) private var model
    let document: DocumentModel
    let view: DocumentViewKind

    var body: some View {
        switch view {
        case .log:
            ScrollView {
                EventLogBox(document: document)
                    .padding(24)
                    .frame(maxWidth: 900)
                    .frame(maxWidth: .infinity)
            }
            .softScrollEdges(.top)
        case .reader:
            if let path = document.path(for: .reader) {
                ReaderView(
                    url: URL(fileURLWithPath: path),
                    readAccess: model.dataDirectory,
                    serif: model.readerSerif
                )
            } else {
                missing
            }
        case .mono, .dual, .journal:
            if let path = document.path(for: view) {
                PDFKitView(url: URL(fileURLWithPath: path), revision: document.info?.completedAt)
            } else {
                missing
            }
        }
    }

    private var missing: some View {
        ContentUnavailableView("文件不存在", systemImage: "doc.questionmark", description: Text("可以重新处理这个文档来生成它。"))
    }
}

@MainActor
struct DocumentInspector: View {
    @Environment(AppModel.self) private var model
    let document: DocumentModel

    var body: some View {
        if let info = document.info {
            Form {
                Section("文档") {
                    LabeledContent("状态") {
                        StatusLabel(status: info.status)
                    }
                    LabeledContent("处理方式", value: Format.mode(info.processingMode))
                    LabeledContent("翻译服务") {
                        Text(Format.translator(of: info))
                            .multilineTextAlignment(.trailing)
                            .textSelection(.enabled)
                    }
                    if !info.isNative {
                        LabeledContent("解析模型", value: info.mineruModel == "pipeline" ? "Pipeline" : "VLM")
                    }
                    if let pages = info.pagesTotal {
                        LabeledContent("页数", value: "\(pages)")
                    }
                    if !info.isNative && info.imageCount > 0 {
                        LabeledContent("图片", value: "\(info.imageCount) 张")
                    }
                }
                Section("源文件") {
                    LabeledContent("文件名") {
                        Text(info.originalFilename)
                            .multilineTextAlignment(.trailing)
                            .textSelection(.enabled)
                    }
                    LabeledContent("大小", value: Format.size(info.sourceSize))
                    LabeledContent("SHA-256") {
                        Text(String(info.sourceSha256.prefix(16)) + "…")
                            .font(.caption.monospaced())
                            .help(info.sourceSha256)
                    }
                }
                Section("时间") {
                    LabeledContent("加入", value: Format.date(info.createdAt))
                    if let started = info.startedAt {
                        LabeledContent("开始", value: Format.date(started))
                    }
                    if let completed = info.completedAt {
                        LabeledContent("完成", value: Format.date(completed))
                    }
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        LabeledContent("用时", value: document.elapsedText(now: context.date))
                    }
                }
                if let excerpt = info.excerpt, !excerpt.isEmpty {
                    Section("摘要") {
                        Text(excerpt)
                            .textSelection(.enabled)
                    }
                }
                Section {
                    Button("在访达中显示") { model.revealInFinder(info) }
                    if info.isCompleted {
                        Button("用默认应用打开") { model.openExternally(info) }
                    }
                }
            }
            .formStyle(.grouped)
            .softScrollEdges(.top)
        } else {
            ContentUnavailableView("没有文档信息", systemImage: "info.circle")
        }
    }
}
