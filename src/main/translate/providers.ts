import { LIST_MODELS_TIMEOUT_MS, CHECK_MODEL_TIMEOUT_MS } from '../../shared/constants'
import { ERROR_CODES, UserError } from '../../shared/errors'
import type { ModelInfo, ProviderConfig } from '../../shared/types'
import { classifyHttpError, classifyNetworkError, snippet } from './errors'
import type { FetchFn } from './http'
import { authHeaders, buildRequest, modelsUrl } from './request'
import { parseChatResponse, type ChatReply } from './response'

export { chatUrl, modelsUrl, buildRequest } from './request'

export type CheckResult =
  { ok: true; latencyMs: number; reply: string } | { ok: false; message: string }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export async function listModels(
  provider: ProviderConfig,
  key: string | undefined,
  fetchFn: FetchFn,
): Promise<ModelInfo[]> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...authHeaders(provider.type, key),
  }
  try {
    if (provider.type === 'anthropic')
      return await listAnthropic(modelsUrl(provider), headers, fetchFn)
    if (provider.type === 'gemini') return await listGemini(modelsUrl(provider), headers, fetchFn)
    return await listOpenAi(modelsUrl(provider), headers, fetchFn)
  } catch (error) {
    if (error instanceof UserError) throw error
    if (
      error instanceof Error &&
      'status' in error &&
      (error.status === 404 || error.status === 405)
    ) {
      throw new UserError(ERROR_CODES.models_unsupported)
    }
    throw error
  }
}

export async function checkModel(
  provider: ProviderConfig,
  key: string | undefined,
  model: string,
  fetchFn: FetchFn,
  appVersion = '4.0.0',
): Promise<CheckResult> {
  const started = Date.now()
  const { url, init } = buildRequest(
    provider,
    model,
    '你是翻译引擎。把用户输入翻译成简体中文，只输出译文。',
    'Hello, world.',
    provider.type === 'anthropic' ? 256 : undefined,
    appVersion,
    key,
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_MODEL_TIMEOUT_MS)
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal })
    const body = await response.text()
    if (!response.ok) {
      const error = classifyHttpError({
        status: response.status,
        body,
        retryAfter: response.headers.get('retry-after'),
      })
      return { ok: false, message: error.message }
    }
    const json: unknown = JSON.parse(body)
    const reply = parseChatResponse(provider.type, json)
    const ok = reply.text.trim().length > 0 || reply.finish === 'truncated'
    if (!ok) return { ok: false, message: '译文为空' }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      reply: snippet(reply.text.trim(), 80),
    }
  } catch (error) {
    const classified = classifyNetworkError(error)
    return { ok: false, message: classified.message }
  } finally {
    clearTimeout(timer)
  }
}

export async function postChat(
  provider: ProviderConfig,
  model: string,
  system: string,
  user: string,
  maxTokens: number | undefined,
  key: string | undefined,
  fetchFn: FetchFn,
  signal: AbortSignal,
  appVersion: string,
): Promise<ChatReply> {
  const { url, init } = buildRequest(provider, model, system, user, maxTokens, appVersion, key)
  try {
    const response = await fetchFn(url, { ...init, signal })
    const body = await response.text()
    if (!response.ok) {
      throw classifyHttpError({
        status: response.status,
        body,
        retryAfter: response.headers.get('retry-after'),
      })
    }
    const json: unknown = JSON.parse(body)
    const root = asRecord(json)
    if (root && asRecord(root.error)) {
      throw classifyHttpError({ status: 200, body: JSON.stringify(root.error) })
    }
    return parseChatResponse(provider.type, json)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw classifyNetworkError(error)
    throw error
  }
}

async function listOpenAi(
  url: string,
  headers: Record<string, string>,
  fetchFn: FetchFn,
): Promise<ModelInfo[]> {
  const json = await getJson(url, headers, fetchFn)
  const rows = Array.isArray(json)
    ? json
    : Array.isArray(asRecord(json)?.data)
      ? (asRecord(json)?.data as unknown[])
      : Array.isArray(asRecord(json)?.models)
        ? (asRecord(json)?.models as unknown[])
        : []
  return uniqueModels(rows.map(parseOpenAiModel).filter((row) => row !== undefined))
}

async function listAnthropic(
  url: string,
  headers: Record<string, string>,
  fetchFn: FetchFn,
): Promise<ModelInfo[]> {
  const models: ModelInfo[] = []
  let after: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const query = new URL(url)
    query.searchParams.set('limit', '1000')
    if (after) query.searchParams.set('after_id', after)
    const json = asRecord(await getJson(query.toString(), headers, fetchFn)) ?? {}
    const data = Array.isArray(json.data) ? json.data : []
    for (const row of data) {
      const rec = asRecord(row)
      if (!rec || typeof rec.id !== 'string') continue
      models.push({
        id: rec.id,
        ...(typeof rec.display_name === 'string' ? { name: rec.display_name } : {}),
      })
    }
    if (json.has_more !== true) break
    const last = asRecord(data[data.length - 1])
    after = typeof last?.id === 'string' ? last.id : undefined
    if (!after) break
  }
  return uniqueModels(models)
}

async function listGemini(
  url: string,
  headers: Record<string, string>,
  fetchFn: FetchFn,
): Promise<ModelInfo[]> {
  const models: ModelInfo[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const query = new URL(url)
    query.searchParams.set('pageSize', '1000')
    if (pageToken) query.searchParams.set('pageToken', pageToken)
    const json = asRecord(await getJson(query.toString(), headers, fetchFn)) ?? {}
    const rows = Array.isArray(json.models) ? json.models : []
    for (const row of rows) {
      const rec = asRecord(row)
      if (!rec || typeof rec.name !== 'string') continue
      const methods = Array.isArray(rec.supportedGenerationMethods)
        ? rec.supportedGenerationMethods
        : []
      if (!methods.includes('generateContent')) continue
      const id = rec.name.replace(/^models\//, '')
      models.push({
        id,
        ...(typeof rec.displayName === 'string' ? { name: rec.displayName } : {}),
        ...(typeof rec.inputTokenLimit === 'number' ? { contextLength: rec.inputTokenLimit } : {}),
      })
    }
    pageToken = typeof json.nextPageToken === 'string' ? json.nextPageToken : undefined
    if (!pageToken) break
  }
  return uniqueModels(models)
}

function parseOpenAiModel(row: unknown): ModelInfo | undefined {
  const rec = asRecord(row)
  const id =
    typeof rec?.id === 'string' ? rec.id : typeof rec?.name === 'string' ? rec.name : undefined
  if (!id) return undefined
  return {
    id,
    ...(typeof rec?.owned_by === 'string' ? { ownedBy: rec.owned_by } : {}),
    ...(typeof rec?.context_length === 'number' ? { contextLength: rec.context_length } : {}),
  }
}

function uniqueModels(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>()
  const out: ModelInfo[] = []
  for (const model of models) {
    const key = model.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(model)
  }
  out.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }))
  return out
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    this.name = 'HttpStatusError'
  }
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchFn: FetchFn,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LIST_MODELS_TIMEOUT_MS)
  try {
    const response = await fetchFn(url, { method: 'GET', headers, signal: controller.signal })
    if (response.status === 404 || response.status === 405) {
      throw new UserError(ERROR_CODES.models_unsupported)
    }
    if (!response.ok) throw new HttpStatusError(response.status)
    return JSON.parse(await response.text()) as unknown
  } finally {
    clearTimeout(timer)
  }
}
