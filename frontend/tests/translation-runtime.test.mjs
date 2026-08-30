import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/translationRuntime.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { copyTranslationRuntime, validateTranslationRuntime } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

const limits = {
  google: { concurrency_max: 256, chunk_chars_max: 4000, max_segments_per_request_max: 100 },
  deepseek: { concurrency_max: 2000, chunk_chars_max: 12000, max_segments_per_request_max: 64 },
  min_chunk_chars: 100,
  per_document_concurrency_max: 32,
  system_prompt_max_chars: 12000,
}
const defaults = {
  google: { concurrency: 32, chunk_chars: 3000, max_segments_per_request: 1 },
  deepseek: { concurrency: 64, chunk_chars: 6000, max_segments_per_request: 4 },
  per_document_concurrency: 4,
  system_prompt: '将以下内容忠实翻译为简体中文，保留术语与结构。',
}

test('accepts valid defaults and inclusive server-provided boundaries', () => {
  assert.deepEqual(validateTranslationRuntime(defaults, limits), [])
  const boundary = copyTranslationRuntime(defaults)
  for (const key of ['google', 'deepseek']) {
    boundary[key] = { concurrency: limits[key].concurrency_max, chunk_chars: limits[key].chunk_chars_max, max_segments_per_request: limits[key].max_segments_per_request_max }
  }
  boundary.per_document_concurrency = limits.per_document_concurrency_max
  assert.deepEqual(validateTranslationRuntime(boundary, limits), [])
})

test('rejects cleared, fractional, zero and nonfinite numeric fields', () => {
  for (const value of [null, undefined, 0, -1, 1.5, NaN, Infinity, '4']) {
    const runtime = copyTranslationRuntime(defaults)
    runtime.google.concurrency = value
    assert.ok(validateTranslationRuntime(runtime, limits).some((item) => item.includes('Google 并发请求数')))
  }
})

test('uses each provider limits separately for chunk length and batch count', () => {
  const runtime = copyTranslationRuntime(defaults)
  runtime.google.chunk_chars = 4001
  runtime.google.max_segments_per_request = 101
  runtime.deepseek.chunk_chars = 12001
  runtime.deepseek.max_segments_per_request = 65
  runtime.per_document_concurrency = 33
  assert.equal(validateTranslationRuntime(runtime, limits).length, 5)
})

test('rejects empty prompts and counts Unicode characters rather than UTF-16 code units', () => {
  const runtime = copyTranslationRuntime(defaults)
  runtime.system_prompt = ' \n\t '
  assert.ok(validateTranslationRuntime(runtime, limits).some((item) => item.includes('不能为空')))
  runtime.system_prompt = '𠮷'.repeat(12000)
  assert.deepEqual(validateTranslationRuntime(runtime, limits), [])
  runtime.system_prompt += '字'
  assert.ok(validateTranslationRuntime(runtime, limits).some((item) => item.includes('不能超过')))
})

test('rejects NUL in administrator prompts consistently with the backend', () => {
  const runtime = copyTranslationRuntime(defaults)
  runtime.system_prompt = '翻译\0此文'
  assert.ok(validateTranslationRuntime(runtime, limits).some((item) => item.includes('空字符')))
})

test('copy and reset operations never mutate the saved settings or server defaults', () => {
  const copied = copyTranslationRuntime(defaults)
  copied.google.concurrency = 3
  copied.deepseek.chunk_chars = 500
  copied.system_prompt = '新的提示词'
  assert.equal(defaults.google.concurrency, 32)
  assert.equal(defaults.deepseek.chunk_chars, 6000)
  assert.notEqual(defaults.system_prompt, copied.system_prompt)
})
