import type { TranslationRuntime, TranslationRuntimeLimits } from './types'

export function copyTranslationRuntime(runtime: TranslationRuntime): TranslationRuntime {
  return { google: { ...runtime.google }, deepseek: { ...runtime.deepseek }, per_document_concurrency: runtime.per_document_concurrency, system_prompt: runtime.system_prompt }
}

export function validateTranslationRuntime(runtime: TranslationRuntime, limits: TranslationRuntimeLimits): string[] {
  const errors: string[] = []
  function integer(value: number, min: number, max: number, label: string) {
    if (!Number.isInteger(value) || value < min || value > max) errors.push(`${label}必须是 ${min}–${max} 之间的整数`)
  }
  for (const provider of ['google', 'deepseek'] as const) {
    const name = provider === 'google' ? 'Google' : 'DeepSeek'
    integer(runtime[provider].concurrency, 1, limits[provider].concurrency_max, `${name} 并发请求数`)
    integer(runtime[provider].chunk_chars, limits.min_chunk_chars, limits[provider].chunk_chars_max, `${name} 每段最大字符数`)
    integer(runtime[provider].max_segments_per_request, 1, limits[provider].max_segments_per_request_max, `${name} 每次请求最多段数`)
  }
  integer(runtime.per_document_concurrency, 1, limits.per_document_concurrency_max, '单篇文档最大在途请求数')
  if (typeof runtime.system_prompt !== 'string' || !runtime.system_prompt.trim()) errors.push('全局翻译提示词不能为空')
  else if (Array.from(runtime.system_prompt).length > limits.system_prompt_max_chars) errors.push(`全局翻译提示词不能超过 ${limits.system_prompt_max_chars} 个字符`)
  if (typeof runtime.system_prompt === 'string' && runtime.system_prompt.includes('\0')) errors.push('全局翻译提示词不能包含空字符')
  return errors
}
