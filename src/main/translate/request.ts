import type { ProviderConfig, ProviderType } from '../../shared/types'
import { chatUrl } from '../../shared/provider-url'

export { stripTrailingSlash, chatUrl, modelsUrl } from '../../shared/provider-url'

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
  // The Messages API rejects requests without a version header, keyed or not.
  if (type === 'anthropic') {
    return key
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { 'anthropic-version': '2023-06-01' }
  }
  if (!key) return {}
  if (type === 'azure') return { 'api-key': key }
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
