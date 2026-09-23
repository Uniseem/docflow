import type { ProviderType } from './types'
import { LOCALHOSTS } from './constants'

export type PresetGroup = 'domestic' | 'international' | 'local' | 'custom'

export type ProviderPreset = {
  id: string
  name: string
  type: ProviderType
  baseUrl: string
  keyUrl?: string
  keyOptional?: boolean
  group: PresetGroup
}

export const PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai',
    baseUrl: 'https://api.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    group: 'domestic',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    type: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    group: 'domestic',
  },
  {
    id: 'dashscope',
    name: '阿里云百炼',
    type: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    group: 'domestic',
  },
  {
    id: 'volcengine',
    name: '火山引擎（豆包）',
    type: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyUrl: 'https://console.volcengine.com/ark',
    group: 'domestic',
  },
  {
    id: 'moonshot',
    name: '月之暗面（Kimi）',
    type: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    group: 'domestic',
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    type: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    group: 'domestic',
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    type: 'openai',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    keyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
    group: 'domestic',
  },
  {
    id: 'stepfun',
    name: '阶跃星辰',
    type: 'openai',
    baseUrl: 'https://api.stepfun.com/v1',
    keyUrl: 'https://platform.stepfun.com/interface-key',
    group: 'domestic',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    type: 'openai',
    baseUrl: 'https://api.minimaxi.com/v1',
    keyUrl: 'https://platform.minimaxi.com',
    group: 'domestic',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    group: 'international',
  },
  {
    id: 'anthropic',
    name: 'Anthropic（Claude）',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    group: 'international',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    type: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    keyUrl: 'https://aistudio.google.com/apikey',
    group: 'international',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    group: 'international',
  },
  {
    id: 'xai',
    name: 'xAI（Grok）',
    type: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    keyUrl: 'https://console.x.ai',
    group: 'international',
  },
  {
    id: 'groq',
    name: 'Groq',
    type: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    group: 'international',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    type: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    group: 'international',
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    type: 'azure',
    baseUrl: 'https://example.openai.azure.com/openai/v1',
    keyUrl: 'https://portal.azure.com',
    group: 'international',
  },
  {
    id: 'ollama',
    name: 'Ollama（本机）',
    type: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    keyOptional: true,
    group: 'local',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本机）',
    type: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    keyOptional: true,
    group: 'local',
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    type: 'openai',
    baseUrl: '',
    group: 'custom',
  },
]

export const PRESET_BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]))

export function uniqueProviderId(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing)
  if (!taken.has(base)) return base
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

export function isLocalHost(hostname: string): boolean {
  return LOCALHOSTS.has(hostname)
}

export function keyOptional(input: { preset?: string | undefined; baseUrl: string }): boolean {
  const preset = input.preset ? PRESET_BY_ID.get(input.preset) : undefined
  if (preset?.keyOptional) return true
  try {
    return isLocalHost(new URL(input.baseUrl).hostname)
  } catch {
    return false
  }
}

export function mockBaseUrl(type: ProviderType, mockRoot: string): string {
  const root = mockRoot.replace(/\/$/, '')
  if (type === 'anthropic') return `${root}/anthropic`
  if (type === 'gemini') return `${root}/gemini`
  return `${root}/v1`
}

export function resolvedBaseUrl(type: ProviderType, baseUrl: string, mockRoot?: string): string {
  if (mockRoot) return mockBaseUrl(type, mockRoot)
  return baseUrl.replace(/\/$/, '')
}

export function withMockProviderUrl<T extends { type: ProviderType; baseUrl: string }>(
  provider: T,
  mockRoot?: string,
): T {
  if (!mockRoot) return provider
  return { ...provider, baseUrl: mockBaseUrl(provider.type, mockRoot) }
}
