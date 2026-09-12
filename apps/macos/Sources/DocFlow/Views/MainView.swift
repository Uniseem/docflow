import SwiftUI

/// The library window: filters, the document list and the selected document.
@MainActor
struct MainView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 280)
        } content: {
            DocumentListView()
                .navigationSplitViewColumnWidth(min: 280, ideal: 340, max: 520)
        } detail: {
            DetailView()
        }
        .searchable(text: $model.query, placement: .toolbar, prompt: "搜索标题或文件名")
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                ToastView(toast: toast)
                    .padding(.bottom, 20)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.toast)
        .sheet(isPresented: $model.isNewTranslationPresented) {
            NewTranslationSheet()
        }
        .alert(
            model.alert?.title ?? "",
            isPresented: $model.isAlertPresented,
            presenting: model.alert
        ) { _ in
            Button("好") {}
        } message: { alert in
            Text(alert.message)
        }
        .alert(
            "重命名",
            isPresented: $model.isRenamePresented
        ) {
            TextField("标题", text: $model.renameText)
            Button("重命名") { model.commitRename() }
            Button("取消", role: .cancel) {}
        }
        .confirmationDialog(
            deleteTitle,
            isPresented: $model.isDeletePresented,
            titleVisibility: .visible
        ) {
            Button("删除", role: .destructive) { model.commitDelete() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("译文、PDF、处理记录和文档库里的源文件副本都会被删除，你最初选择的文件不受影响。此操作无法撤销。")
        }
        .confirmationDialog(
            "取消处理“\(model.cancelCandidate?.title ?? "")”？",
            isPresented: $model.isCancelPresented,
            titleVisibility: .visible
        ) {
            Button("取消处理", role: .destructive) {
                if let document = model.cancelCandidate {
                    model.cancel(document.id)
                }
            }
            Button("继续处理", role: .cancel) {}
        } message: {
            Text("正在进行的解析、翻译或排版会停止。源文件和已完成的翻译断点会保留，之后可以重新处理。")
        }
        .onAppear {
            model.openMainWindow = { openWindow(id: "main") }
        }
    }

    private var deleteTitle: String {
        let candidates = model.deleteCandidates
        if candidates.count == 1, let document = candidates.first {
            return "删除“\(document.title)”？"
        }
        return "删除 \(candidates.count) 个文档？"
    }
}

/// A finished export (or another short confirmation) at the bottom of the
/// window. It goes away by itself; failures use an alert instead.
///
/// The one piece of chrome DocFlow floats over its own content, so it is
/// Liquid Glass: a capsule lens with no border and no shadow. The close
/// button sits in its own circle of glass beside it rather than inside the
/// capsule, because glass never stacks on glass; one container renders the
/// two together and animates them as a unit.
@MainActor
private struct ToastView: View {
    @Environment(AppModel.self) private var model
    let toast: Toast

    var body: some View {
        GlassGroup(spacing: 0) {
            HStack(spacing: 8) {
                HStack(spacing: 10) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(.green)
                    Text(toast.message)
                        .lineLimit(2)
                        .truncationMode(.middle)
                    if let file = toast.file {
                        Button("在访达中显示") {
                            FileActions.reveal(file.path)
                            model.dismissToast()
                        }
                        .buttonStyle(.borderless)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .glassChrome(in: Capsule())

                Button {
                    model.dismissToast()
                } label: {
                    Image(systemName: "xmark")
                        .frame(width: 18, height: 18)
                }
                .glassAction()
                .buttonBorderShape(.circle)
                .controlSize(.large)
                .help("关闭")
                .accessibilityLabel("关闭")
            }
        }
        .frame(maxWidth: 560)
    }
}

@MainActor
struct SidebarView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        List(selection: $model.filter) {
            Section("文档库") {
                ForEach(LibraryFilter.allCases) { filter in
                    Label(filter.title, systemImage: filter.symbol)
                        .badge(filter.count(in: model.counts))
                        .tag(filter)
                }
            }
        }
        .listStyle(.sidebar)
        .softScrollEdges(.top)
        // A glass bar, so the list scrolls behind the status instead of
        // stopping at a divider above it.
        .glassBar(edge: .bottom) {
            EngineStatusFooter()
        }
    }
}

/// A quiet line at the bottom of the sidebar while the engine is not ready.
@MainActor
private struct EngineStatusFooter: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.engineState {
        case .starting:
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("正在启动处理引擎…")
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
        case .failed:
            Label("处理引擎未运行", systemImage: "exclamationmark.triangle.fill")
                .font(.callout)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
        case .ready, .stopped:
            EmptyView()
        }
    }
}

@MainActor
struct DetailView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let document = model.current {
            DocumentDetailView(document: document)
                .id(document.id)
        } else {
            ContentUnavailableView(
                "未选择文档",
                systemImage: "doc.text",
                description: Text("在列表中选择一个文档，查看处理进度或阅读译文。")
            )
        }
    }
}
