import Foundation

// Wire types of the docflow-engine JSON-RPC protocol (engine/src/rpc.rs and
// engine/src/models.rs). EngineClient converts between snake_case and
// camelCase keys.

struct DocumentInfo: Decodable, Identifiable, Hashable, Sendable {
    var id: String
    var title: String
    var originalFilename: String
    var sourceSize: Int64
    var sourceSha256: String
    var mimeType: String?
    var processingMode: String
    var translationTier: Int
    /// "Google 翻译（免费）" or "服务商 · 模型"; absent for older documents.
    var translatorLabel: String?
    var mineruModel: String
    var status: String
    var stage: String
    var progress: Int
    var failureReason: String?
    var queueAttempts: Int
    var pagesProcessed: Int?
    var pagesTotal: Int?
    var imageCount: Int
    var excerpt: String?
    var translated: Bool
    var pdfSize: Int64?
    var dualPdfSize: Int64?
    var createdAt: Date
    var updatedAt: Date
    var startedAt: Date?
    var completedAt: Date?
    // Only present in documents.get / create / rename / retry / cancel.
    var files: DocumentFiles?
    var suggestedNames: SuggestedNames?
    var running: Bool?

    var isNative: Bool { processingMode == "pdf2zh" }
    var isActive: Bool { status == "queued" || status == "processing" || status == "retrying" }
    var isCompleted: Bool { status == "completed" }
    var isStopped: Bool { status == "failed" || status == "cancelled" }
}

struct DocumentFiles: Decodable, Hashable, Sendable {
    var source: String?
    var archiveDir: String?
    var journalPdf: String?
    var monoPdf: String?
    var dualPdf: String?
    var markdown: String?
    var markdownOriginal: String?
    var markdownTranslated: String?
    var readerHtml: String?
}

struct SuggestedNames: Decodable, Hashable, Sendable {
    var journalPdf: String
    var monoPdf: String
    var dualPdf: String
    var markdown: String
    var bundle: String
    var source: String
}

struct DocumentList: Decodable, Sendable {
    var items: [DocumentInfo]
    var total: Int
    var counts: StatusCounts
}

struct StatusCounts: Decodable, Hashable, Sendable {
    var all = 0
    var active = 0
    var completed = 0
    var failed = 0
}

struct ProcessingEvent: Decodable, Identifiable, Hashable, Sendable {
    var id: Int64
    var documentId: String
    var stage: String
    var state: String
    var level: String
    var progress: Int
    var message: String
    var detail: String?
    var current: Int64?
    var total: Int64?
    var createdAt: Date

    var isAttention: Bool { level == "warning" || level == "error" }
}

struct EventList: Decodable, Sendable {
    var items: [ProcessingEvent]
    var total: Int
    var nextAfterId: Int64
    var hasMore: Bool
}

struct InitializeResult: Decodable, Sendable {
    var version: String
    var dataDir: String
    var resourcesDir: String
    var settings: SettingsInfo
}

struct SettingsInfo: Decodable, Sendable {
    var preferences: Preferences
    var translationRuntime: TranslationRuntime
    var translationRuntimeDefaults: TranslationRuntime
    var translationRuntimeLimits: RuntimeLimits
    var providers: [ProviderInfo]
    var providerPresets: [ProviderPreset]
    var mineru: SecretStatus
    var capabilities: Capabilities
    var dataDir: String
    var engineVersion: String

    func provider(_ id: String) -> ProviderInfo? {
        providers.first { $0.id == id }
    }

    /// Google, then every model of every usable provider.
    var translatorOptions: [TranslatorOption] {
        var options = [TranslatorOption.google]
        for provider in providers where provider.isUsable(fake: capabilities.fakeProviders) {
            for model in provider.models {
                options.append(TranslatorOption(
                    choice: .llm(providerID: provider.id, model: model.id),
                    label: "\(provider.name) · \(model.name ?? model.id)"
                ))
            }
        }
        return options
    }
}

struct Preferences: Codable, Equatable, Sendable {
    var mineruModel: String
    var defaultTranslator: TranslatorChoice
    var defaultMode: String
    var proxy: ProxySettings
    var workerConcurrency: Int
}

/// `{"kind": "google"}` or `{"kind": "llm", "provider_id": …, "model": …}`.
/// Absent optionals are left out when encoding, as the engine requires.
struct TranslatorChoice: Codable, Hashable, Sendable {
    var kind: String
    var providerId: String?
    var model: String?

    static let google = TranslatorChoice(kind: "google")

    static func llm(providerID: String, model: String) -> TranslatorChoice {
        TranslatorChoice(kind: "llm", providerId: providerID, model: model)
    }

    var isLLM: Bool { kind == "llm" }
}

struct TranslatorOption: Identifiable, Hashable, Sendable {
    var choice: TranslatorChoice
    var label: String

    var id: TranslatorChoice { choice }

    static let google = TranslatorOption(choice: .google, label: "Google 翻译（免费）")
}

/// `{"mode": "system" | "direct"}` or `{"mode": "custom", "url": "…"}`.
struct ProxySettings: Codable, Equatable, Sendable {
    var mode: String
    var url: String?
}

struct TranslationRuntime: Codable, Equatable, Sendable {
    var google: GoogleRuntime
    var llm: LLMRuntime
    var perDocumentConcurrency: Int
    var systemPrompt: String
}

struct GoogleRuntime: Codable, Equatable, Sendable {
    var concurrency: Int
    var chunkChars: Int
}

struct LLMRuntime: Codable, Equatable, Sendable {
    var chunkChars: Int
    var maxSegmentsPerRequest: Int
    var maxRequestChars: Int
    var maxOutputTokens: Int
}

struct RuntimeLimits: Decodable, Sendable {
    var minChunkChars: Int
    var googleConcurrencyMax: Int
    var googleChunkCharsMax: Int
    var llmChunkCharsMax: Int
    var llmSegmentsPerRequestMax: Int
    var llmRequestCharsMin: Int
    var llmRequestCharsMax: Int
    var llmOutputTokensMax: Int
    var perDocumentConcurrencyMax: Int
    var providerConcurrencyMax: Int
    var systemPromptMaxChars: Int
}

struct ModelConfig: Codable, Hashable, Sendable {
    var id: String
    var name: String?
}

/// A large-model provider as the engine reports it. Its extra request
/// fields arrive as JSON text: the snake_case key strategies of
/// EngineCoding would rename keys inside an object (`generationConfig`).
struct ProviderInfo: Decodable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var type: String
    var baseUrl: String
    var enabled: Bool
    var models: [ModelConfig]
    var concurrency: Int
    var preset: String?
    var extraBodyJson: String
    var keyConfigured: Bool
    var keyMasked: String?
    var keyOptional: Bool
    var keyUrl: String?

    func isUsable(fake: Bool) -> Bool {
        enabled && !models.isEmpty && (fake || keyConfigured || keyOptional)
    }

    var config: ProviderConfig {
        ProviderConfig(id: id, name: name, type: type, baseUrl: baseUrl, enabled: enabled, models: models, concurrency: concurrency, preset: preset)
    }
}

/// A provider as `providers.save` takes it (extra fields travel separately).
struct ProviderConfig: Encodable, Hashable, Sendable {
    var id: String
    var name: String
    var type: String
    var baseUrl: String
    var enabled: Bool
    var models: [ModelConfig]
    var concurrency: Int
    var preset: String?
}

struct ProviderPreset: Decodable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var type: String
    var baseUrl: String
    var keyUrl: String
    var keyOptional: Bool
}

struct RemoteModel: Decodable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String?
    var owner: String?
    var contextLength: Int?
}

struct RemoteModels: Decodable, Sendable {
    var models: [RemoteModel]
}

struct CheckResult: Decodable, Sendable {
    var ok: Bool
    var latencyMs: Int
    var reply: String
}

struct SecretStatus: Decodable, Sendable {
    var configured: Bool
    var masked: String?
}

struct Capabilities: Decodable, Sendable {
    var mineruReady: Bool
    var pdf2zhReady: Bool
    var pdf2zhIssue: String?
    var googleReady: Bool
    var llmReady: Bool
    var fakeProviders: Bool
    var maxUploadMb: Int
    var mineruExtensions: [String]
    var pdf2zhExtensions: [String]
}

struct ExportResult: Decodable, Sendable {
    var path: String
    var bytes: Int64
}

/// A result whose content is not needed (`{}`, `{"ok": true}`, …).
struct Empty: Decodable, Sendable {}

// MARK: - Request parameters

struct IDParams: Encodable, Sendable {
    var id: String
}

struct ListParams: Encodable, Sendable {
    var filter: String?
    var query: String?
    var limit: Int?
}

struct EventsParams: Encodable, Sendable {
    var id: String
    var afterId: Int64
    var limit: Int
}

struct CreateParams: Encodable, Sendable {
    var path: String
    var title: String?
    var mode: String
    var translator: TranslatorChoice
}

struct RenameParams: Encodable, Sendable {
    var id: String
    var title: String
}

struct ExportParams: Encodable, Sendable {
    var id: String
    var destination: String
}

/// `mineru` or `provider:<id>`; `value: null` removes the key.
struct SecretParams: Encodable, Sendable {
    var name: String
    var value: String?

    // `value: null` must be written, not left out.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(value, forKey: .value)
    }

    private enum CodingKeys: String, CodingKey {
        case name, value
    }
}

struct InitializeParams: Encodable, Sendable {
    var secrets: [String: String]
}

struct SettingsUpdateParams: Encodable, Sendable {
    var preferences: Preferences?
    var translationRuntime: TranslationRuntime?
}

struct ProviderSaveParams: Encodable, Sendable {
    var provider: ProviderConfig
    /// Blank clears the extra request fields.
    var extraBodyJson: String
}

/// A provider endpoint for `providers.models` / `providers.check`; without
/// `apiKey` the engine uses the key stored for `providerId`.
struct EndpointParams: Encodable, Sendable {
    var providerId: String?
    var name: String
    var type: String
    var baseUrl: String
    var apiKey: String?
    var model: String?
    var extraBodyJson: String?
}

struct NoParams: Encodable, Sendable {}
