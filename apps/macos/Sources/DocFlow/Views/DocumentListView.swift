import SwiftUI

@MainActor
struct DocumentListView: View {
    @Environment(AppModel.self) private var model
    @State private var isDropTargeted = false

    var body: some View {
        @Bindable var model = model
        List(selection: $model.selection) {
            ForEach(model.documents) { document in
                DocumentRow(document: document)
                    .tag(document.id)
            }
        }
        // Rows dissolve into the toolbar's glass instead of being cut off
        // by a hairline under it.
        .softScrollEdges(.top)
        .contextMenu(forSelectionType: String.self) { ids in
            menuItems(for: ids)
        } primaryAction: { ids in
            if let id = ids.first, let document = model.documents.first(where: { $0.id == id }) {
                model.openExternally(document)
            }
        }
        .onDeleteCommand {
            if let selection = model.selection {
                model.beginDelete([selection])
            }
        }
        .overlay {
            emptyState
        }
        .overlay {
            if isDropTargeted {
                DropTargetOutline()
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            guard model.isReady else { return false }
            model.openFiles(urls)
            return true
        } isTargeted: { targeted in
            isDropTargeted = targeted
        }
        .navigationTitle((model.filter ?? .all).title)
        .navigationSubtitle(subtitle)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    model.presentNewTranslation()
                } label: {
                    Label("新建翻译", systemImage: "plus")
                }
                // The window's main action, so it is the tinted glass one.
                .prominentGlassAction()
                .help("新建翻译（⌘N）")
                .disabled(!model.isReady)
            }
        }
    }

    private var subtitle: String {
        let count = model.documents.count
        return count == 0 ? "" : "\(count) 个文档"
    }

    @ViewBuilder
    private var emptyState: some View {
        switch model.engineState {
        case .starting, .stopped:
            if model.documents.isEmpty {
                ProgressView("正在启动处理引擎…")
            }
        case .failed(let message):
            ContentUnavailableView {
                Label("处理引擎未运行", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
                    .textSelection(.enabled)
            } actions: {
                Button("重新启动") { model.start() }
                    .glassAction()
            }
        case .ready:
            if let error = model.libraryError, model.documents.isEmpty {
                ContentUnavailableView("无法读取文档库", systemImage: "exclamationmark.triangle", description: Text(error))
            } else if model.documents.isEmpty && !model.isLoadingLibrary {
                if !model.query.trimmed.isEmpty {
                    ContentUnavailableView.search(text: model.query)
                } else if model.counts.all == 0 {
                    LibraryWelcomeView()
                } else {
                    ContentUnavailableView(
                        "没有\((model.filter ?? .all).title)",
                        systemImage: (model.filter ?? .all).symbol
                    )
                }
            }
        }
    }

    @ViewBuilder
    private func menuItems(for ids: Set<String>) -> some View {
        let selected = model.documents.filter { ids.contains($0.id) }
        if selected.count == 1, let document = selected.first {
            Button("用默认应用打开") { model.openExternally(document) }
                .disabled(!document.isCompleted)
            Button("在访达中显示") { model.revealInFinder(document) }
            Divider()
            if document.isStopped {
                Button("重新处理") { model.retry(document.id) }
            }
            if document.isActive {
                Button("取消处理…") { model.cancelCandidate = document }
            }
            Button("重命名…") { model.beginRename(document) }
            Divider()
        }
        if !selected.isEmpty {
            Button(selected.count == 1 ? "删除…" : "删除 \(selected.count) 个文档…", role: .destructive) {
                model.beginDelete(ids)
            }
        }
    }
}

/// The first-run empty state. Translation needs a large model, so without
/// one the first step is adding a provider.
@MainActor
private struct LibraryWelcomeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let ready = model.settings?.capabilities.llmReady == true
        ContentUnavailableView {
            Label("文档库为空", systemImage: "doc.badge.plus")
        } description: {
            if ready {
                Text("把 PDF、Word、PowerPoint 或图片拖到这里，或点按“新建翻译”。")
            } else {
                Text("DocFlow 用大模型翻译。先在设置中添加一个服务商（DeepSeek、通义千问、Kimi、Claude 等）并填写 API Key，再把文件拖到这里。")
            }
        } actions: {
            if ready {
                Button("新建翻译…") { model.presentNewTranslation() }
                    .prominentGlassAction()
            } else {
                SettingsLink {
                    Text("添加大模型服务商…")
                }
                .prominentGlassAction()
            }
        }
    }
}

@MainActor
struct DocumentRow: View {
    let document: DocumentInfo

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: Format.modeSymbol(document.processingMode))
                .font(.title2)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.secondary)
                .frame(width: 26)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(document.title)
                    .font(.headline)
                    .lineLimit(2)
                Text("\(Format.mode(document.processingMode)) · \(Format.translator(of: document)) · \(Format.relative(document.createdAt))")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if document.isActive {
                    ProgressView(value: Double(document.progress), total: 100)
                        .controlSize(.small)
                        .accessibilityLabel("处理进度")
                    Text(activeCaption)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                } else {
                    StatusLabel(status: document.status)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var activeCaption: String {
        switch document.status {
        case "queued": return "排队中"
        case "retrying": return "等待重试 · \(document.progress)%"
        default: return "处理中 · \(document.progress)%"
        }
    }
}

@MainActor
struct StatusLabel: View {
    let status: String

    var body: some View {
        Label {
            Text(Format.status(status))
                .foregroundStyle(.secondary)
        } icon: {
            Image(systemName: Format.statusSymbol(status))
                .foregroundStyle(Format.statusColor(status))
        }
        .font(.caption)
    }
}
