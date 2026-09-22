import type { ProviderConfig, ProviderType } from '../../shared/types'

export function stripTrailingSlash(base: string): string {
  return base.replace(/\/+$/, '')
}

export function chatUrl(provider: Pick<ProviderConfig, 'type' | 'baseUrl'>, model: string): string {
  const base = stripTrailingSlash(provider.baseUrl)
  const type: ProviderType = provider.type
  if (type === 'openai' || type === 'azure') return `${base}/chat/completions`
  if (type === 'anthropic') {
    return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
  }
  const geminiBase = base.endsWith('/v1beta') ? base : `${base}/v1beta`
  const id = model.replace(/^models\//, '')
  return `${geminiBase}/models/${id}:generateContent`
}

export function modelsUrl(provider: Pick<ProviderConfig, 'type' | 'baseUrl'>): string {
  const base = stripTrailingSlash(provider.baseUrl)
  const type: ProviderType = provider.type
  if (type === 'openai' || type === 'azure') return `${base}/models`
  if (type === 'anthropic') {
    return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
  }
  const geminiBase = base.endsWith('/v1beta') ? base : `${base}/v1beta`
  return `${geminiBase}/models`
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function mergeExtraBody(
  base: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  if (!extra) return base
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key]
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = mergeExtraBody(current, value)
    } else {
      out[key] = value
    }
  }
  return out
}

export function authHeaders(type: ProviderType, key: string | undefined): Record<string, string> {
  if (!key) return {}
  if (type === 'azure') return { 'api-key': key }
  if (type === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  if (type === 'gemini') return { 'x-goog-api-key': key }
  return { Authorization: `Bearer ${key}` }
}

export function buildRequest(
  provider: ProviderConfig,
  model: string,
  system: string,
  user: string,
  maxTokens: number | undefined,
  appVersion: string,
  key: string | undefined,
): { url: string; init: RequestInit } {
  const url = chatUrl(provider, model)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': `DocFlow/${appVersion}`,
    ...authHeaders(provider.type, key),
  }

  let body: Record<string, unknown>
  if (provider.type === 'anthropic') {
    body = {
      model,
      max_tokens: maxTokens ?? 8192,
      system,
      messages: [{ role: 'user', content: user }],
    }
  } else if (provider.type === 'gemini') {
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
    }
    if (maxTokens) {
      body.generationConfig = { maxOutputTokens: maxTokens }
    }
  } else {
    body = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
    }
    if (maxTokens) body.max_tokens = maxTokens
  }

  const payload = mergeExtraBody(body, provider.extraBody)
  return {
    url,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(900_000),
    },
  }
}
