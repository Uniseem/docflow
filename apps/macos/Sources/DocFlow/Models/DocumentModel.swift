import Foundation
import Observation

enum DocumentViewKind: String, CaseIterable, Identifiable, Hashable {
    case mono, dual, reader, journal, log

    var id: String { rawValue }

    var title: String {
        switch self {
        case .mono: return "中文 PDF"
        case .dual: return "双语对照"
        case .reader: return "阅读"
        case .journal: return "期刊 PDF"
        case .log: return "处理记录"
        }
    }
}

enum StageState {
    case waiting, current, done, failed
}

struct StageItem: Identifiable {
    let id: Int
    let title: String
    let caption: String
    let state: StageState
}

/// The selected document: its latest state and its processing log.
@MainActor
@Observable
final class DocumentModel: Identifiable {
    let id: String

    private(set) var info: DocumentInfo?
    /// Ascending by id. Live notifications can arrive while the history is
    /// still loading, so events are de-duplicated and inserted in order.
    private(set) var events: [ProcessingEvent] = []
    private(set) var eventTotal = 0
    private(set) var currentMessage = ""
    private(set) var currentDetail: String?
    private(set) var loadError: String?
    var onlyAttention = false
    var selectedView: DocumentViewKind?

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var seen = Set<Int64>()
    @ObservationIgnored private var latest: Int64 = 0

    init(id: String, app: AppModel) {
        self.id = id
        self.app = app
    }

    func load() async {
        guard let app else { return }
        loadError = nil
        do {
            let document: DocumentInfo = try await app.call("documents.get", IDParams(id: id))
            apply(document)
            var after: Int64 = 0
            while true {
                let page: EventList = try await app.call(
                    "documents.events",
                    EventsParams(id: id, afterId: after, limit: 2000)
                )
                for event in page.items {
                    add(event)
                }
                eventTotal = max(page.total, events.count)
                after = page.nextAfterId
                if !page.hasMore || page.items.isEmpty {
                    break
                }
            }
        } catch {
            if info == nil {
                loadError = error.localizedDescription
            }
        }
    }

    func apply(_ document: DocumentInfo) {
        guard document.id == id else { return }
        if let info, info.updatedAt > document.updatedAt {
            return
        }
        info = document
        if document.isStopped, let reason = document.failureReason, !reason.isEmpty {
            currentDetail = reason
        }
        let views = availableViews
        if let selected = selectedView, views.contains(selected) {
            return
        }
        selectedView = views.first
    }

    func receive(_ event: ProcessingEvent) {
        guard event.documentId == id else { return }
        add(event)
        if var document = info, document.isActive {
            document.stage = event.stage
            document.progress = max(document.progress, event.progress)
            info = document
        }
    }

    private func add(_ event: ProcessingEvent) {
        guard seen.insert(event.id).inserted else { return }
        if let last = events.last, last.id > event.id {
            let index = events.firstIndex { $0.id > event.id } ?? events.endIndex
            events.insert(event, at: index)
        } else {
            events.append(event)
        }
        eventTotal = max(eventTotal, events.count)
        if event.id > latest {
            latest = event.id
            currentMessage = event.message
            currentDetail = event.detail
        }
    }

    // MARK: Presentation

    /// Newest first.
    var visibleEvents: [ProcessingEvent] {
        let source = onlyAttention ? events.filter(\.isAttention) : events
        return Array(source.reversed())
    }

    var availableViews: [DocumentViewKind] {
        guard let document = info, document.isCompleted else { return [] }
        let files = document.files
        var views: [DocumentViewKind] = []
        if document.isNative {
            if files?.monoPdf != nil { views.append(.mono) }
            if files?.dualPdf != nil { views.append(.dual) }
        } else {
            if files?.readerHtml != nil { views.append(.reader) }
            if files?.journalPdf != nil { views.append(.journal) }
        }
        views.append(.log)
        return views
    }

    func path(for view: DocumentViewKind) -> String? {
        let files = info?.files
        switch view {
        case .mono: return files?.monoPdf
        case .dual: return files?.dualPdf
        case .reader: return files?.readerHtml
        case .journal: return files?.journalPdf
        case .log: return nil
        }
    }

    var subtitle: String {
        guard let document = info else { return "" }
        var parts = [
            Format.mode(document.processingMode),
            Format.translator(of: document),
            Format.size(document.sourceSize),
        ]
        if let pages = document.pagesTotal {
            parts.append("\(pages) 页")
        }
        if !document.isNative && document.imageCount > 0 {
            parts.append("\(document.imageCount) 张图片")
        }
        return parts.joined(separator: " · ")
    }

    func elapsedText(now: Date) -> String {
        guard let document = info else { return "" }
        let end = document.completedAt ?? (document.isActive ? now : document.updatedAt)
        return (document.isActive ? "已运行 " : "用时 ") + Format.duration(end.timeIntervalSince(document.createdAt))
    }

    var stages: [StageItem] {
        guard let document = info else { return [] }
        let definitions = StageDefinition.all(for: document)
        let active = definitions.firstIndex { definition in
            guard let prefix = definition.prefix else { return false }
            return document.stage == prefix || document.stage.hasPrefix(prefix + "_")
        }
        return definitions.enumerated().map { index, definition in
            let state: StageState
            if document.isCompleted {
                state = .done
            } else if let active {
                if index < active {
                    state = .done
                } else if index > active {
                    state = .waiting
                } else {
                    state = document.isStopped ? .failed : .current
                }
            } else if document.isStopped && document.progress >= definition.start && document.progress <= definition.end {
                state = .failed
            } else if document.progress > definition.end {
                state = .done
            } else {
                state = document.progress >= definition.start && !document.isStopped ? .current : .waiting
            }
            return StageItem(id: index, title: definition.title, caption: definition.caption, state: state)
        }
    }
}

private struct StageDefinition {
    var title: String
    var caption: String
    var start: Int
    var end: Int
    var prefix: String?

    static func all(for document: DocumentInfo) -> [StageDefinition] {
        let translation = Format.translator(of: document)
        var stages = [StageDefinition(title: "接收与排队", caption: "复制源文件并加入处理队列", start: 0, end: 4)]
        if document.isNative {
            stages += [
                StageDefinition(title: "检查 PDF", caption: "检查文本层，拒绝扫描件与加密文件", start: 5, end: 9, prefix: "pdf2zh_preflight"),
                StageDefinition(title: "分析版面", caption: "BabelDOC 分析页面、段落与公式", start: 10, end: 29, prefix: "pdf2zh_layout"),
                StageDefinition(title: "翻译段落", caption: "\(translation)，共享任务池并发翻译", start: 30, end: 79, prefix: "pdf2zh_translation"),
                StageDefinition(title: "排版译文", caption: "保留页面版式，生成中文与双语 PDF", start: 80, end: 89, prefix: "pdf2zh_typesetting"),
                StageDefinition(title: "校验结果", caption: "检查两份 PDF 的页数、尺寸与可读性", start: 90, end: 93, prefix: "pdf2zh_verified"),
            ]
        } else {
            stages += [
                StageDefinition(title: "MinerU 解析", caption: "上传文档并等待逐页解析", start: 5, end: 52),
                StageDefinition(title: "获取结果", caption: "下载并安全解压解析结果", start: 53, end: 64),
                StageDefinition(title: "图片本地化", caption: "转换为 WebP 并改写引用", start: 65, end: 70),
                StageDefinition(title: "分段翻译", caption: "\(translation)，并发翻译与无损校验", start: 71, end: 87),
                StageDefinition(title: "排版", caption: "规范化 Markdown，生成阅读视图与期刊 PDF", start: 88, end: 93),
            ]
        }
        stages.append(StageDefinition(title: "保存到文档库", caption: "写入译文、PDF 与处理记录", start: 94, end: 100))
        return stages
    }
}
