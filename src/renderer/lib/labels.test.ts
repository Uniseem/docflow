import { expect, test } from 'vitest'
import { SEARCH_DEBOUNCE_MS } from '../../shared/constants'
import { basename, fileStem, formatElapsed, progressLabel, stageName } from './labels'
import { defaultTranslatorKey, parseTranslatorKey, translatorOptions } from './translators'

test('basename and stem', () => {
  expect(basename('/tmp/a/paper.pdf')).toBe('paper.pdf')
  expect(basename('C:\\\\docs\\\\x.pdf')).toBe('x.pdf')
  expect(fileStem('paper.pdf')).toBe('paper')
})

test('progress and stages', () => {
  expect(progressLabel('queued', 0)).toBe('排队中')
  expect(progressLabel('processing', 41)).toBe('处理中 · 41%')
  expect(stageName('inspect')).toBe('检查 PDF')
  expect(stageName('done')).toBe('已完成')
})

test('elapsed clock', () => {
  expect(formatElapsed(5_000)).toBe('0:05')
  expect(formatElapsed(3_661_000)).toBe('1:01:01')
})

test('translator helpers', () => {
  expect(parseTranslatorKey('deepseek/mock-chat')).toEqual({
    providerId: 'deepseek',
    model: 'mock-chat',
  })
  expect(translatorOptions(null)).toEqual([])
  expect(defaultTranslatorKey(null)).toBeNull()
})

test('search debounce constant', () => {
  expect(SEARCH_DEBOUNCE_MS).toBe(250)
})
