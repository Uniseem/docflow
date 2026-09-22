import { z } from 'zod'
import {
  DEFAULT_SYSTEM_PROMPT,
  EXTRA_BODY_FORBIDDEN,
  MAX_MODELS_PER_PROVIDER,
  MAX_PROVIDERS,
} from './constants'

export const ProviderType = z.enum(['openai', 'azure', 'anthropic', 'gemini'])
export type ProviderType = z.infer<typeof ProviderType>

export const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
  openai: 'OpenAI 兼容',
  azure: 'Azure OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
}

export const ModelConfig = z.object({
  id: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\r\n]+$/),
  name: z.string().max(200).optional(),
})
export type ModelConfig = z.infer<typeof ModelConfig>

const extraBodyForbidden = new Set<string>(EXTRA_BODY_FORBIDDEN)

export const ProviderConfig = z
  .object({
    id: z.string().regex(/^[a-z0-9-_]{1,64}$/),
    name: z.string().min(1).max(64),
    type: ProviderType,
    baseUrl: z
      .string()
      .url()
      .refine((u) => /^https?:$/.test(new URL(u).protocol)),
    enabled: z.boolean().default(true),
    models: z.array(ModelConfig).max(MAX_MODELS_PER_PROVIDER),
    concurrency: z.number().int().min(1).max(2000).default(100),
    preset: z.string().optional(),
    extraBody: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.models.map((model) => model.id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: 'models id 必须唯一', path: ['models'] })
    }
    if (value.extraBody) {
      for (const key of Object.keys(value.extraBody)) {
        if (extraBodyForbidden.has(key)) {
          ctx.addIssue({
            code: 'custom',
            message: `extraBody 不得包含 ${key}`,
            path: ['extraBody', key],
          })
        }
      }
    }
  })
export type ProviderConfig = z.infer<typeof ProviderConfig>

export const TranslatorChoice = z.object({ providerId: z.string(), model: z.string() })
export type TranslatorChoice = z.infer<typeof TranslatorChoice>

export function translatorLabel(provider: ProviderConfig, modelId: string): string {
  return `${provider.name} · ${provider.models.find((model) => model.id === modelId)?.name ?? modelId}`
}

export const LlmRuntime = z.object({
  chunkChars: z.number().int().min(100).max(32_000).default(4000),
  maxSegmentsPerRequest: z.number().int().min(1).max(64).default(8),
  maxRequestChars: z.number().int().min(500).max(100_000).default(8000),
  maxOutputTokens: z.number().int().min(0).max(1_000_000).default(0),
})
export type LlmRuntime = z.infer<typeof LlmRuntime>

export const TranslationRuntime = z.object({
  llm: LlmRuntime,
  perDocumentConcurrency: z.number().int().min(1).max(1000).default(100),
  systemPrompt: z.string().max(12_000),
})
export type TranslationRuntime = z.infer<typeof TranslationRuntime>

export const ProxyConfig = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('system') }),
  z.object({ mode: z.literal('direct') }),
  z.object({
    mode: z.literal('custom'),
    url: z
      .string()
      .url()
      .refine((u) => /^(https?|socks5h?):$/.test(new URL(u).protocol)),
  }),
])
export type ProxyConfig = z.infer<typeof ProxyConfig>

export const Settings = z
  .object({
    version: z.literal(1),
    providers: z.array(ProviderConfig).max(MAX_PROVIDERS),
    defaultTranslator: TranslatorChoice.nullable(),
    workerConcurrency: z.number().int().min(1).max(4).default(2),
    translation: TranslationRuntime,
    proxy: ProxyConfig,
    pdf: z.object({
      minFontScale: z.number().min(0.4).max(1).default(0.6),
      bilingual: z.boolean().default(true),
    }),
    notifications: z.boolean().default(true),
    checkUpdates: z.boolean().default(true),
  })
  .strict()
export type Settings = z.infer<typeof Settings>

export function defaultLlmRuntime(): LlmRuntime {
  return LlmRuntime.parse({})
}

export function defaultTranslationRuntime(): TranslationRuntime {
  return TranslationRuntime.parse({
    llm: defaultLlmRuntime(),
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  })
}

export function defaultSettings(): Settings {
  return Settings.parse({
    version: 1,
    providers: [],
    defaultTranslator: null,
    translation: defaultTranslationRuntime(),
    proxy: { mode: 'system' },
    pdf: {},
  })
}

export const HostState = z
  .object({
    libraryDir: z.string().optional(),
    window: z
      .object({
        width: z.number(),
        height: z.number(),
        x: z.number(),
        y: z.number(),
        maximized: z.boolean(),
      })
      .optional(),
    theme: z.enum(['system', 'light', 'dark']).optional(),
  })
  .strict()
export type HostState = z.infer<typeof HostState>

export const DocumentStatus = z.enum([
  'queued',
  'processing',
  'retrying',
  'completed',
  'failed',
  'cancelled',
])
export type DocumentStatus = z.infer<typeof DocumentStatus>

export const Stage = z.enum([
  'received',
  'inspect',
  'analyze',
  'translate',
  'compose',
  'verify',
  'archive',
  'done',
])
export type Stage = z.infer<typeof Stage>

export const DocumentManifest = z
  .object({
    version: z.literal(1),
    id: z.string(),
    title: z.string().min(1).max(300),
    titleCustom: z.boolean(),
    originalFilename: z.string(),
    sourceSize: z.number().int(),
    sourceSha256: z.string().length(64),
    pages: z.number().int().nullable(),
    translator: z.object({ providerId: z.string(), model: z.string(), label: z.string() }),
    settingsSnapshot: TranslationRuntime,
    status: DocumentStatus,
    stage: Stage,
    progress: z.number().min(0).max(100),
    failure: z.object({ code: z.string(), message: z.string(), permanent: z.boolean() }).nullable(),
    attempts: z.number().int(),
    nextAttemptAt: z.string().datetime().nullable(),
    stats: z
      .object({
        paragraphs: z.number(),
        translatable: z.number(),
        translated: z.number(),
        kept: z.number(),
        formulaRuns: z.number(),
        opsRemoved: z.number(),
        usage: z.object({ input: z.number(), output: z.number() }),
      })
      .nullable(),
    outputs: z.object({
      mono: z.object({ bytes: z.number() }).nullable(),
      dual: z.object({ bytes: z.number() }).nullable(),
    }),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict()
export type DocumentManifest = z.infer<typeof DocumentManifest>

export const ProcessingEvent = z.object({
  seq: z.number().int(),
  at: z.string().datetime(),
  stage: Stage,
  level: z.enum(['info', 'success', 'warning', 'error']),
  progress: z.number().min(0).max(100).optional(),
  message: z.string(),
  detail: z.string().optional(),
  current: z.number().optional(),
  total: z.number().optional(),
})
export type ProcessingEvent = z.infer<typeof ProcessingEvent>

export const DocumentFiles = z.object({
  source: z.string().optional(),
  mono: z.string().optional(),
  dual: z.string().optional(),
})
export type DocumentFiles = z.infer<typeof DocumentFiles>

export const SuggestedNames = z.object({
  mono: z.string(),
  dual: z.string(),
  bundle: z.string(),
  source: z.string(),
})
export type SuggestedNames = z.infer<typeof SuggestedNames>

export const DocumentSummary = DocumentManifest.omit({ settingsSnapshot: true }).extend({
  files: DocumentFiles,
  suggestedNames: SuggestedNames,
  running: z.boolean(),
})
export type DocumentSummary = z.infer<typeof DocumentSummary>

export const ModelInfo = z.object({
  id: z.string(),
  name: z.string().optional(),
  ownedBy: z.string().optional(),
  contextLength: z.number().optional(),
})
export type ModelInfo = z.infer<typeof ModelInfo>
