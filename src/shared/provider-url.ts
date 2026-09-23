import type { ProviderConfig, ProviderType } from './types'

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
