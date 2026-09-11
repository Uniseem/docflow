import SwiftUI

/// A document that is queued, being processed, failed or was cancelled.
@MainActor
struct ProgressDetailView: View {
    @Environment(AppModel.self) private var model
    @Bindable var document: DocumentModel

    var body: some View {
        if let info = document.info {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(info.title)
                            .font(.title2.weight(.semibold))
                            .textSelection(.enabled)
                        Text(document.subtitle)
                            .foregroundStyle(.secondary)
                    }
                    if info.isStopped {
                        FailureBox(info: info)
                    }
                    ProgressBox(document: document, info: info)
                    GroupBox {
                        StageList(stages: document.stages)
                            .padding(8)
                    } label: {
                        Text("处理阶段")
                    }
                    EventLogBox(document: document)
                }
                .padding(24)
                .frame(maxWidth: 900, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
        }
    }
}

@MainActor
private struct FailureBox: View {
    @Environment(AppModel.self) private var model
    let info: DocumentInfo

    var body: some View {
        let cancelled = info.status == "cancelled"
        GroupBox {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: cancelled ? "xmark.circle.fill" : "exclamationmark.triangle.fill")
                    .font(.title2)
                    .foregroundStyle(cancelled ? Color.secondary : Color.red)
                VStack(alignment: .leading, spacing: 6) {
                    Text(cancelled ? "已取消处理" : "处理失败")
                        .font(.headline)
                    if let reason = info.failureReason, !reason.isEmpty {
                        Text(reason)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    Button("重新处理") { model.retry(info.id) }
                        .buttonStyle(.borderedProminent)
                        .padding(.top, 4)
                }
                Spacer(minLength: 0)
            }
            .padding(8)
        }
    }
}

@MainActor
private struct ProgressBox: View {
    let document: DocumentModel
    let info: DocumentInfo

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(info.isActive ? "处理进度" : Format.status(info.status))
                        .font(.headline)
                    Spacer()
                    Text("\(info.progress)%")
                        .font(.headline)
                        .monospacedDigit()
                }
                if info.isActive && info.progress <= 3 {
                    ProgressView()
                        .progressViewStyle(.linear)
                } else {
                    ProgressView(value: Double(info.progress), total: 100)
                        .tint(info.isStopped ? .red : nil)
                }
                if !document.currentMessage.isEmpty {
                    Text(document.currentMessage)
                        .fontWeight(.medium)
                        .textSelection(.enabled)
                }
                if let detail = document.currentDetail, !detail.isEmpty {
                    Text(detail)
                        .foregroundStyle(.secondary)
                        .lineLimit(6)
                        .textSelection(.enabled)
                }
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(document.elapsedText(now: context.date))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .monospacedDigit()
                }
            }
            .padding(8)
        }
        .accessibilityElement(children: .contain)
    }
}

@MainActor
struct StageList: View {
    let stages: [StageItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(stages) { stage in
                HStack(alignment: .top, spacing: 10) {
                    StageIcon(state: stage.state)
                        .frame(width: 18, height: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(stage.title)
                            .foregroundStyle(stage.state == .waiting ? .secondary : .primary)
                        Text(stage.caption)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

@MainActor
private struct StageIcon: View {
    let state: StageState

    var body: some View {
        switch state {
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .accessibilityLabel("已完成")
        case .current:
            ProgressView()
                .controlSize(.small)
                .accessibilityLabel("进行中")
        case .failed:
            Image(systemName: "xmark.octagon.fill")
                .foregroundStyle(.red)
                .accessibilityLabel("失败")
        case .waiting:
            Image(systemName: "circle.dashed")
                .foregroundStyle(.tertiary)
                .accessibilityLabel("等待")
        }
    }
}

/// The processing log, newest first.
@MainActor
struct EventLogBox: View {
    @Bindable var document: DocumentModel

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(document.eventTotal > 0 ? "处理记录 · \(document.eventTotal) 条" : "处理记录")
                        .font(.headline)
                    Spacer()
                    Toggle("只看警告和错误", isOn: $document.onlyAttention)
                        .toggleStyle(.checkbox)
                }
                .padding(.bottom, 8)
                let events = document.visibleEvents
                if events.isEmpty {
                    Text(document.onlyAttention ? "没有警告或错误。" : "暂无记录。")
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 12)
                } else {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(events) { event in
                            EventRow(event: event, origin: document.info?.createdAt ?? event.createdAt)
                                .padding(.vertical, 7)
                            Divider()
                        }
                    }
                }
            }
            .padding(8)
        }
    }
}

@MainActor
struct EventRow: View {
    let event: ProcessingEvent
    let origin: Date

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            icon
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 3) {
                Text(event.message)
                    .textSelection(.enabled)
                if let detail = event.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                HStack(spacing: 12) {
                    Text(Format.time(event.createdAt))
                    Text("+" + Format.duration(event.createdAt.timeIntervalSince(origin)))
                    Text("\(event.progress)%")
                    if let counter {
                        Text(counter)
                    }
                }
                .font(.caption)
                .foregroundStyle(.tertiary)
                .monospacedDigit()
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var icon: some View {
        switch event.level {
        case "success":
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case "warning":
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        case "error":
            Image(systemName: "xmark.octagon.fill")
                .foregroundStyle(.red)
        default:
            Image(systemName: "circle.fill")
                .font(.system(size: 6))
                .foregroundStyle(Color.accentColor)
        }
    }

    private var counter: String? {
        guard let current = event.current else { return nil }
        let bytes = event.stage.contains("download") || event.stage == "source_saved" || event.stage == "source_verified"
        func show(_ value: Int64) -> String {
            bytes ? Format.size(value) : "\(value)"
        }
        if let total = event.total {
            return "\(show(current)) / \(show(total))"
        }
        return show(current)
    }
}
