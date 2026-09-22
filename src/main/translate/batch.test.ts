import { describe, expect, test } from 'vitest'
import { DEFAULT_SYSTEM_PROMPT } from '../../shared/constants'
import type { TranslationRuntime } from '../../shared/types'
import { buildSystemPrompt, buildUserMessage, parseBatch, planBatches, smartSplit } from './batch'

const runtime = (over: Partial<TranslationRuntime['llm']> = {}): TranslationRuntime => ({
  llm: {
    chunkChars: 20,
    maxSegmentsPerRequest: 2,
    maxRequestChars: 30,
    maxOutputTokens: 0,
    ...over,
  },
  perDocumentConcurrency: 4,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
})

describe('smartSplit / planBatches / parseBatch', () => {
  test('splits on sentence then space and never cuts markers', () => {
    const marker = 'DOCFLOWKEEP000001TOKEN'
    const text = `${'a'.repeat(12)}. ${'b'.repeat(12)}${marker}${'c'.repeat(12)}`
    const parts = smartSplit(text, 20)
    expect(parts.every((part) => part.length <= 20 || part.includes(marker))).toBe(true)
    expect(parts.join('')).toBe(text)
    expect(
      parts.some(
        (part) =>
          part.includes(marker) && part.includes(marker.slice(0, 8)) && !part.includes(marker),
      ),
    ).toBe(false)
    expect(parts.join('').includes(marker)).toBe(true)
  })

  test('batches by segment count, chars, long split ids, and whitespace', () => {
    const batches = planBatches(
      [
        { id: 'a', text: 'one' },
        { id: 'b', text: 'two' },
        { id: 'c', text: 'three' },
        { id: 'd', text: '   ' },
        { id: 'e', text: 'x'.repeat(25) },
      ],
      runtime(),
    )
    expect(batches[0]?.map((s) => s.id)).toEqual(['a', 'b'])
    expect(batches.some((batch) => batch.length === 1 && batch[0]?.id === 'd')).toBe(true)
    expect(batches.flat().some((s) => s.id.startsWith('e#'))).toBe(true)
  })

  test('parseBatch strips wrapping newlines and drops empty or duplicate ids', () => {
    const parsed = parseBatch(
      '<segment id="a">\nhi\n</segment>\n<segment id="b">\n\n</segment>\n<segment id="a">\nagain\n</segment>\n<segment id="c">\nok\n</segment>',
    )
    expect(parsed.get('c')).toBe('ok')
    expect(parsed.has('a')).toBe(false)
    expect(parsed.has('b')).toBe(false)
  })

  test('builds protocol system prompt without changing wording', () => {
    const prompt = buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, 'standard', true)
    expect(prompt.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true)
    expect(prompt).toContain('DOCFLOWKEEP000123TOKEN')
    expect(buildUserMessage([{ id: '1', text: 'Hello' }])).toBe('Hello')
    expect(
      buildUserMessage([
        { id: '1', text: 'A' },
        { id: '2', text: 'B' },
      ]),
    ).toContain('<segment id="1">')
  })
})
