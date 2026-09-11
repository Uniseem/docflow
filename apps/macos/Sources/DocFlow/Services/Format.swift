import Foundation
import SwiftUI

/// Display text shared by the views.
enum Format {
    private static func formatter(_ pattern: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = pattern
        return formatter
    }

    private static let dateFormatter = formatter("yyyy-MM-dd HH:mm")
    private static let timeFormatter = formatter("HH:mm:ss")
    private static let clockFormatter = formatter("HH:mm")
    private static let dayFormatter = formatter("M月d日 HH:mm")
    private static let yearFormatter = formatter("yyyy年M月d日")

    static func size(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    static func date(_ date: Date) -> String {
        dateFormatter.string(from: date)
    }

    static func time(_ date: Date) -> String {
        timeFormatter.string(from: date)
    }

    static func relative(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return "今天 " + clockFormatter.string(from: date)
        }
        if calendar.isDateInYesterday(date) {
            return "昨天 " + clockFormatter.string(from: date)
        }
        if calendar.isDate(date, equalTo: Date(), toGranularity: .year) {
            return dayFormatter.string(from: date)
        }
        return yearFormatter.string(from: date)
    }

    static func duration(_ interval: TimeInterval) -> String {
        let seconds = max(0, Int(interval))
        if seconds < 60 {
            return "\(seconds) 秒"
        }
        if seconds < 3600 {
            return "\(seconds / 60) 分 \(seconds % 60) 秒"
        }
        return "\(seconds / 3600) 小时 \(seconds % 3600 / 60) 分"
    }

    static func mode(_ mode: String) -> String {
        mode == "pdf2zh" ? "PDF 原生翻译" : "MinerU 解析翻译"
    }

    static func modeSymbol(_ mode: String) -> String {
        mode == "pdf2zh" ? "doc.richtext" : "doc.text.magnifyingglass"
    }

    /// What translated a document; older documents only know a tier.
    static func translator(_ label: String?, tier: Int) -> String {
        if let label, !label.isEmpty {
            return label
        }
        switch tier {
        case 1: return "Google 翻译"
        case 2: return "DeepSeek"
        case 3: return "DeepSeek 思考模式"
        default: return "未知翻译服务"
        }
    }

    static func translator(of document: DocumentInfo) -> String {
        translator(document.translatorLabel, tier: document.translationTier)
    }

    static func providerType(_ type: String) -> String {
        switch type {
        case "openai": return "OpenAI 兼容"
        case "azure": return "Azure OpenAI"
        case "anthropic": return "Anthropic"
        case "gemini": return "Gemini"
        default: return type
        }
    }

    /// The request URL the engine derives from an API address (engine/src/providers.rs).
    static func chatEndpoint(type: String, baseURL: String, model: String?) -> String {
        var base = baseURL.trimmed
        while base.hasSuffix("/") {
            base.removeLast()
        }
        guard !base.isEmpty else { return "" }
        switch type {
        case "anthropic":
            return base.hasSuffix("/v1") ? base + "/messages" : base + "/v1/messages"
        case "gemini":
            let versioned = base.hasSuffix("/v1") || base.hasSuffix("/v1beta") ? base : base + "/v1beta"
            return versioned + "/models/\(model ?? "模型"):generateContent"
        default:
            return base + "/chat/completions"
        }
    }

    static func status(_ status: String) -> String {
        switch status {
        case "queued": return "排队中"
        case "processing": return "处理中"
        case "retrying": return "等待重试"
        case "completed": return "已完成"
        case "failed": return "失败"
        case "cancelled": return "已取消"
        default: return status
        }
    }

    static func statusSymbol(_ status: String) -> String {
        switch status {
        case "completed": return "checkmark.circle.fill"
        case "failed": return "exclamationmark.triangle.fill"
        case "cancelled": return "xmark.circle.fill"
        case "retrying": return "arrow.clockwise.circle.fill"
        case "processing": return "gearshape.2.fill"
        default: return "clock.fill"
        }
    }

    static func statusColor(_ status: String) -> Color {
        switch status {
        case "completed": return .green
        case "failed": return .red
        case "cancelled": return .secondary
        case "retrying": return .orange
        default: return .accentColor
        }
    }
}

extension String {
    var trimmed: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
