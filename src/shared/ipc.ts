import { z } from 'zod'
import {
  DocumentSummary,
  ModelInfo,
  ProcessingEvent,
  ProviderConfig,
  TranslatorChoice,
} from './types'

const empty = z.object({})

export const IpcEnvelopeError = z.object({
  code: z.string(),
  message: z.string(),
  user: z.boolean(),
})

export const PushChannels = {
  'document:changed': DocumentSummary,
  'document:removed': z.object({ id: z.string() }),
  'document:event': ProcessingEvent.extend({ documentId: z.string() }),
  'settings:changed': z.unknown(),
  'library:changed': z.object({ libraryDir: z.string() }),
  'app:openFiles': z.object({ paths: z.array(z.string()) }),
  'app:command': z.object({
    name: z.enum(['new-translation', 'settings', 'focus-search']),
  }),
} as const

export const channels = {
  'app:info': {
    request: empty,
    response: z.object({
      version: z.string(),
      platform: z.enum(['darwin', 'win32']),
      libraryDir: z.string(),
      logsDir: z.string(),
      arch: z.string(),
      theme: z.enum(['system', 'light', 'dark']),
      dataDirFromEnv: z.boolean(),
    }),
  },
  'app:setTheme': {
    request: z.object({ theme: z.enum(['system', 'light', 'dark']) }),
    response: empty,
  },
  'app:checkUpdates': {
    request: empty,
    response: z.union([
      z.object({ latest: z.string(), url: z.string(), newer: z.boolean() }),
      z.object({ error: z.string() }),
    ]),
  },
  'app:relaunch': { request: empty, response: empty },
  'settings:get': { request: empty, response: z.unknown() },
  'settings:update': { request: z.unknown(), response: z.unknown() },
  'secrets:set': {
    request: z.object({ providerId: z.string(), value: z.string().nullable() }),
    response: z.unknown(),
  },
  'providers:save': {
    request: z.object({ provider: ProviderConfig }),
    response: z.unknown(),
  },
  'providers:delete': { request: z.object({ id: z.string() }), response: z.unknown() },
  'providers:listModels': {
    request: z.object({
      providerId: z.string().optional(),
      type: z.enum(['openai', 'azure', 'anthropic', 'gemini']),
      baseUrl: z.string(),
      key: z.string().optional(),
    }),
    response: z.object({ models: z.array(ModelInfo) }),
  },
  'providers:check': {
    request: z.object({
      providerId: z.string().optional(),
      type: z.enum(['openai', 'azure', 'anthropic', 'gemini']),
      baseUrl: z.string(),
      key: z.string().optional(),
      model: z.string(),
    }),
    response: z.union([
      z.object({ ok: z.literal(true), latencyMs: z.number(), reply: z.string() }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
  'documents:create': {
    request: z.object({
      paths: z.array(z.string()),
      title: z.string().optional(),
      translator: TranslatorChoice,
    }),
    response: z.object({
      created: z.array(DocumentSummary),
      failed: z.array(z.object({ path: z.string(), message: z.string() })),
    }),
  },
  'documents:list': {
    request: z.object({
      filter: z.enum(['all', 'active', 'completed', 'failed']),
      query: z.string().optional(),
    }),
    response: z.object({
      items: z.array(DocumentSummary),
      counts: z.object({
        all: z.number(),
        active: z.number(),
        completed: z.number(),
        failed: z.number(),
      }),
    }),
  },
  'documents:get': {
    request: z.object({ id: z.string() }),
    response: DocumentSummary,
  },
  'documents:events': {
    request: z.object({
      id: z.string(),
      afterSeq: z.number().optional(),
      limit: z.number().optional(),
    }),
    response: z.object({ items: z.array(ProcessingEvent), lastSeq: z.number() }),
  },
  'documents:rename': {
    request: z.object({ id: z.string(), title: z.string() }),
    response: DocumentSummary,
  },
  'documents:retry': {
    request: z.object({ id: z.string() }),
    response: DocumentSummary,
  },
  'documents:cancel': {
    request: z.object({ id: z.string() }),
    response: DocumentSummary,
  },
  'documents:delete': {
    request: z.object({ ids: z.array(z.string()) }),
    response: z.object({ deleted: z.array(z.string()) }),
  },
  'documents:export': {
    request: z.object({
      id: z.string(),
      kind: z.enum(['mono', 'dual', 'source', 'bundle']),
    }),
    response: z.union([z.object({ cancelled: z.literal(true) }), z.object({ path: z.string() })]),
  },
  'documents:reveal': {
    request: z.object({
      id: z.string(),
      kind: z.enum(['mono', 'dual', 'source', 'folder']).optional(),
    }),
    response: empty,
  },
  'documents:openExternal': {
    request: z.object({ id: z.string(), kind: z.enum(['mono', 'dual', 'source']) }),
    response: empty,
  },
  'dialog:pickPdfs': {
    request: empty,
    response: z.object({ paths: z.array(z.string()) }),
  },
  'dialog:pickFolder': {
    request: z.object({ title: z.string(), message: z.string() }),
    response: z.union([z.object({ path: z.string() }), z.object({ cancelled: z.literal(true) })]),
  },
  'library:change': {
    request: z.object({ path: z.string() }),
    response: z.object({ libraryDir: z.string() }),
  },
  'shell:openExternal': {
    request: z.object({ url: z.string() }),
    response: empty,
  },
  'shell:openLogs': { request: empty, response: empty },
  'shell:openNotices': { request: empty, response: empty },
} as const

export type ChannelName = keyof typeof channels
export type PushChannelName = keyof typeof PushChannels
export type ChannelRequest<K extends ChannelName> = z.input<(typeof channels)[K]['request']>
export type ChannelResponse<K extends ChannelName> = z.output<(typeof channels)[K]['response']>

export const PUSH_CHANNEL_NAMES = Object.keys(PushChannels) as PushChannelName[]

export type IpcEnvelope<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string; user: boolean } }

export function envelopeOk<T>(data: T): { ok: true; data: T } {
  return { ok: true, data }
}

export function envelopeErr(code: string, message: string, user: boolean) {
  return { ok: false as const, error: { code, message, user } }
}

/** Rejection value of `window.docflow.invoke`. A plain object because contextBridge drops custom Error properties. */
export type IpcFailure = { code: string; message: string; user: boolean }

export type DocflowApi = {
  invoke<K extends ChannelName>(channel: K, payload: ChannelRequest<K>): Promise<ChannelResponse<K>>
  on<K extends PushChannelName>(
    channel: K,
    cb: (payload: z.output<(typeof PushChannels)[K]>) => void,
  ): () => void
  pathsForFiles(files: File[]): string[]
}
