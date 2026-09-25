import { describe, expect, test } from 'vitest'
import { analysisOf, line, unitOf } from '../../../../tests/unit/layout-units'
import { FontMapper } from '../../pdf/babeldoc/fontmap'
import { buildLayoutMap } from '../../pdf/pdf2zh/doclayout'
import { buildParagraphs, type BdParagraph } from './paragraphs'
import { translateParagraphs, type TranslatorHooks } from './translator'

/** One box per paragraph, stacked from the top; `x` shifts a box to the right. */
function page(
  texts: ReadonlyArray<{ text: string; label?: string; x?: number; y?: number; w?: number }>,
  pageIndex = 0,
) {
  const boxes = texts.map((t, i) => {
    const top = t.y ?? 50 + i * 40
    const x = t.x ?? 0
    return {
      name: t.label ?? 'plain text',
      conf: 0.9 - i * 0.01,
      xyxy: [x, top, x + (t.w ?? 590), top + 30],
    }
  })
  const map = buildLayoutMap({ width: 600, height: 800, boxes: boxes as never })
  const items = texts.flatMap((t, i) => {
    const top = t.y ?? 50 + i * 40
    return line(t.text, (t.x ?? 0) + 5, 800 - top - 20)
  })
  return unitOf(items, { map, page: pageIndex })
}

type Call = { prompt: string; kind: 'batch' | 'single' }

function fakeLlm(respond?: (inputs: Array<{ id: number; input: string }>) => unknown) {
  const calls: Call[] = []
  const llm = (prompt: string) => {
    const marker = '## Here is the input:\n\n'
    const at = prompt.indexOf(marker)
    if (at >= 0) {
      calls.push({ prompt, kind: 'batch' })
      const inputs = JSON.parse(prompt.slice(at + marker.length)) as Array<{
        id: number
        input: string
      }>
      const reply = respond
        ? respond(inputs)
        : inputs.map((item) => ({ id: item.id, output: `译${item.input}` }))
      return Promise.resolve(typeof reply === 'string' ? reply : JSON.stringify(reply))
    }
    calls.push({ prompt, kind: 'single' })
    const text = prompt.split('Now translate the following text:\n\n')[1] ?? ''
    return Promise.resolve(`单${text}`)
  }
  return { calls, llm }
}

function hooks(llm: TranslatorHooks['llm'], extra: Partial<TranslatorHooks> = {}): TranslatorHooks {
  return {
    llm,
    isFatal: (error) => error instanceof Error && error.message === 'fatal',
    onFatal: () => undefined,
    onPlanned: () => undefined,
    onParagraphDone: () => undefined,
    onFallback: () => undefined,
    onKept: () => undefined,
    ...extra,
  }
}

const options = {
  minTextLength: 5,
  disableRichText: false,
  customPrompt: '',
  mapper: new FontMapper('auto', () => true),
  glossaries: [],
  concurrency: 4,
}

function inputsOf(call: Call): string[] {
  const json = call.prompt.split('## Here is the input:\n\n')[1] ?? '[]'
  return (JSON.parse(json) as Array<{ input: string }>).map((item) => item.input)
}

describe('ILTranslatorLLMOnly batching', () => {
  test('a page is sent six paragraphs per request', async () => {
    const texts = Array.from({ length: 7 }, (_, i) => ({ text: `Paragraph number ${i} here` }))
    const paragraphs = buildParagraphs(analysisOf([page(texts)]))
    const { calls, llm } = fakeLlm()
    let planned = [0, 0]
    const results = await translateParagraphs(
      paragraphs,
      options,
      hooks(llm, { onPlanned: (n, b) => (planned = [n, b]) }),
    )
    expect(planned).toEqual([7, 2])
    expect(calls.map((c) => inputsOf(c).length)).toEqual([6, 1])
    expect(results.get('0#0')?.comps).toEqual([
      {
        kind: 'text',
        text: '译Paragraph number 0 here',
        style: { font: 'F1', size: 10, gstate: '' },
      },
    ])
  })

  test('short, numeric and cid paragraphs stay out', async () => {
    const paragraphs = buildParagraphs(
      analysisOf([page([{ text: 'Long enough text' }, { text: 'Tiny' }, { text: '2024.5' }])]),
    )
    const { calls, llm } = fakeLlm()
    await translateParagraphs(paragraphs, options, hooks(llm))
    expect(calls.flatMap(inputsOf)).toEqual(['Long enough text'])
  })

  test('the last body paragraph of a page goes with the first of the next page', async () => {
    const units = [
      page([{ text: 'First page body one' }, { text: 'First page body two' }], 0),
      page([{ text: 'Second page body one' }, { text: 'Second page body two' }], 1),
    ]
    const { calls, llm } = fakeLlm()
    await translateParagraphs(buildParagraphs(analysisOf(units)), options, hooks(llm))
    expect(inputsOf(calls[0]!)).toEqual(['First page body two', 'Second page body one'])
  })

  test('a paragraph whose top is 20 pt above the previous one starts a new column', async () => {
    const units = [
      page([
        { text: 'Left column end', y: 700, w: 290 },
        { text: 'Right column top', x: 300, y: 60, w: 290 },
        { text: 'Right column next', x: 300, y: 100, w: 290 },
      ]),
    ]
    const { calls, llm } = fakeLlm()
    await translateParagraphs(buildParagraphs(analysisOf(units)), options, hooks(llm))
    expect(inputsOf(calls[0]!)).toEqual(['Left column end', 'Right column top'])
    expect(inputsOf(calls[1]!)).toEqual(['Right column next'])
  })

  test('the first title and the most recent title are the context', async () => {
    const units = [
      page([
        { text: 'Document Title', label: 'title' },
        { text: 'Intro body text' },
        { text: 'Method Section', label: 'title' },
        { text: 'Method body text' },
      ]),
    ]
    const { calls, llm } = fakeLlm()
    await translateParagraphs(buildParagraphs(analysisOf(units)), options, hooks(llm))
    expect(calls[0]!.prompt).toContain('1. First title in full text: Document Title')
    expect(calls[0]!.prompt).toContain('2. The most recent title is: Method Section')
  })
})

describe('checks and fallback', () => {
  const long = 'This sentence is long enough to have more than ten tokens in it for sure'

  test('an output equal to a long input is translated again on its own', async () => {
    const paragraphs = buildParagraphs(
      analysisOf([page([{ text: long }, { text: 'Other text ok' }])]),
    )
    const { calls, llm } = fakeLlm((inputs) =>
      inputs.map((item) => ({
        id: item.id,
        output: item.input === long ? long : `译${item.input}`,
      })),
    )
    const fallbacks: BdParagraph[] = []
    const results = await translateParagraphs(
      paragraphs,
      options,
      hooks(llm, { onFallback: (p) => fallbacks.push(p) }),
    )
    expect(fallbacks.map((p) => p.id)).toEqual(['0#0'])
    expect(calls.filter((c) => c.kind === 'single')).toHaveLength(1)
    expect(results.get('0#0')?.text).toBe(`单${long}`)
    expect(results.get('0#1')?.text).toBe('译Other text ok')
  })

  test('a reply with the wrong number of items falls back for the whole batch', async () => {
    const paragraphs = buildParagraphs(
      analysisOf([page([{ text: 'One two three' }, { text: 'Four five six' }])]),
    )
    const { calls, llm } = fakeLlm(() => [{ id: 0, output: '一' }])
    const results = await translateParagraphs(paragraphs, options, hooks(llm))
    expect(calls.filter((c) => c.kind === 'single')).toHaveLength(2)
    expect([...results.values()].map((r) => r.text)).toEqual(['单One two three', '单Four five six'])
  })

  test('a reply wrapped in a code fence is accepted', async () => {
    const paragraphs = buildParagraphs(analysisOf([page([{ text: 'Fenced reply text' }])]))
    const { llm } = fakeLlm(() => '```json\n[{"id": 0, "output": "围栏"}]\n```')
    const results = await translateParagraphs(paragraphs, options, hooks(llm))
    expect(results.get('0#0')?.text).toBe('围栏')
  })

  test('a failed fallback keeps the original', async () => {
    const paragraphs = buildParagraphs(analysisOf([page([{ text: 'Cannot translate this' }])]))
    const kept: string[] = []
    const llm = (prompt: string) =>
      prompt.includes('## Here is the input:')
        ? Promise.resolve('not json')
        : Promise.reject(new Error('refused'))
    const results = await translateParagraphs(
      paragraphs,
      options,
      hooks(llm, { onKept: (p) => kept.push(p.id) }),
    )
    expect(results.size).toBe(0)
    expect(kept).toEqual(['0#0'])
  })

  test('a fatal error ends the run once, without unhandled rejections', async () => {
    const texts = Array.from({ length: 12 }, (_, i) => ({ text: `Paragraph number ${i} here` }))
    const paragraphs = buildParagraphs(analysisOf([page(texts)]))
    let fatals = 0
    const llm = () => Promise.reject(new Error('fatal'))
    await expect(
      translateParagraphs(paragraphs, options, hooks(llm, { onFatal: () => (fatals += 1) })),
    ).rejects.toThrow('fatal')
    expect(fatals).toBe(1)
  })
})
