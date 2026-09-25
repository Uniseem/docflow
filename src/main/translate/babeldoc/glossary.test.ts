import { describe, expect, test } from 'vitest'
import { analysisOf, line, unitOf } from '../../../../tests/unit/layout-units'
import { buildLayoutMap } from '../../pdf/pdf2zh/doclayout'
import { Glossary, glossaryFromCsv, GlossaryFormatError, parseCsv } from './glossary'
import { buildParagraphs } from './paragraphs'
import { batchPrompt, singlePrompt, termsPrompt } from './prompts'
import { extractTerms, finalizeGlossary, glossariesForTranslation } from './terms'

const encode = (text: string) => new TextEncoder().encode(text)

describe('Glossary', () => {
  test('from_csv keeps rows for zh-CN or without tgt_lng, dedupes normalised sources', () => {
    const csv =
      '\ufeffsource,target,tgt_lng\r\n' +
      'Large Language Model,大语言模型,zh-CN\r\n' +
      'large  language model,重复,\r\n' +
      'transformer,变换器,ja\r\n' +
      '"attention, please","注意，请",\r\n'
    const g = glossaryFromCsv('mine', encode(csv), 'zh-CN')
    expect(g.entries.map((e) => [e.source, e.target])).toEqual([
      ['Large Language Model', '大语言模型'],
      ['attention, please', '注意，请'],
    ])
  })

  test('from_csv needs source and target columns', () => {
    expect(() => glossaryFromCsv('bad', encode('a,b\n1,2\n'), 'zh-CN')).toThrow(GlossaryFormatError)
  })

  test('matching ignores ASCII case and folds whitespace in the text', () => {
    const g = new Glossary('g', [
      { source: 'Deep Learning', target: '深度学习' },
      { source: 'Ünïcode', target: '统一码' },
    ])
    expect(g.activeEntries('we use deep\n learning here')).toEqual([['Deep Learning', '深度学习']])
    // hyperscan's caseless flag without UTF8/UCP only folds ASCII.
    expect(g.activeEntries('üNïCODE')).toEqual([])
  })

  test('to_csv round-trips through the CSV reader', () => {
    const g = new Glossary('g', [{ source: 'a,b', target: 'x"y' }])
    expect(parseCsv(g.toCsv())).toEqual([
      ['source', 'target', 'tgt_lng'],
      ['a,b', 'x"y', ''],
    ])
  })
})

describe('glossaries in prompts', () => {
  const g = new Glossary('terms', [
    { source: 'LLM', target: '大语言模型' },
    { source: 'GPU', target: '图形处理器' },
  ])

  test('the batch prompt lists only the terms of the batch, sorted', () => {
    const prompt = batchPrompt({
      jsonInput: '[]',
      customPrompt: '',
      title: null,
      localTitle: null,
      glossaries: [g],
      glossaryText: 'An LLM on a GPU',
    })
    expect(prompt).toContain('## Glossary\nIf a glossary is provided:')
    expect(prompt).toContain(
      '## Glossary Tables\n\n### Glossary: terms\n\n| Source Term | Target Term |\n|-------------|-------------|\n| GPU | 图形处理器 |\n| LLM | 大语言模型 |\n',
    )
    const none = batchPrompt({
      jsonInput: '[]',
      customPrompt: 'Be terse.',
      title: null,
      localTitle: null,
      glossaries: [g],
      glossaryText: 'nothing here',
    })
    expect(none).not.toContain('Glossary')
    expect(none.startsWith('Be terse.\nFollow all rules strictly.\n\n## Structure Rules')).toBe(
      true,
    )
  })

  test('the single-paragraph prompt ends with the text', () => {
    const prompt = singlePrompt({
      text: 'An LLM',
      customPrompt: '',
      title: { id: 'a', unicode: 'Title' },
      localTitle: { id: 'a', unicode: 'Title' },
      glossaries: [g],
    })
    expect(prompt.startsWith('You are a professional zh-CN native translator')).toBe(true)
    expect(prompt).toContain('## Context / Hints\n1. First title in the full text: Title\n')
    expect(prompt).not.toContain('most recent title')
    expect(prompt.endsWith('Now translate the following text:\n\nAn LLM')).toBe(true)
  })

  test('the term prompt quotes the reference glossary and the example', () => {
    const prompt = termsPrompt(['An LLM'], [g])
    expect(prompt).toContain(
      'Reference Glossaries (for consistency and quality):\n\nterms:\n- LLM → 大语言模型\n',
    )
    expect(prompt).toContain('- Each element: {"src": "...", "tgt": "..."}.')
    expect(prompt).toContain('Input Text:\n```\nAn LLM\n```')
  })
})

describe('AutomaticTermExtractor', () => {
  test('batches of 13 paragraphs, most frequent translation wins', async () => {
    const boxes = Array.from({ length: 14 }, (_, i) => ({
      name: 'plain text',
      conf: 0.9,
      xyxy: [0, 40 + i * 50, 590, 70 + i * 50] as [number, number, number, number],
    }))
    const map = buildLayoutMap({ width: 600, height: 800, boxes })
    const items = boxes.flatMap((_, i) => line(`Neural network ${i}`, 5, 800 - 60 - i * 50))
    const paragraphs = buildParagraphs(analysisOf([unitOf(items, { map })]))
    const sizes: number[] = []
    let call = 0
    const { glossary } = await extractTerms(paragraphs, [], 2, {
      llm: (prompt) => {
        const body = prompt.split('Input Text:\n```\n')[1]!.split('\n```')[0]!
        sizes.push(body.split('\n\n').length)
        call += 1
        return Promise.resolve(
          JSON.stringify([
            { src: 'neural network', tgt: call === 1 ? '神经网络' : '神经网' },
            { src: 'NN', tgt: 'NN' },
          ]),
        )
      },
      isFatal: () => false,
      onFatal: () => undefined,
      onBatchDone: () => undefined,
      onError: () => undefined,
    })
    expect(sizes).toEqual([13, 1])
    expect(glossary?.entries).toEqual([{ source: 'neural network', target: '神经网络' }])
  })

  test('finalize and the glossaries used for translation', () => {
    const auto = finalizeGlossary(
      [
        ['a', 'x'],
        ['a', 'y'],
        ['a', 'y'],
      ],
      'auto_extracted_glossary',
    )!
    expect(auto.entries).toEqual([{ source: 'a', target: 'y' }])
    const user = new Glossary('mine', [])
    expect(glossariesForTranslation([user], auto, true)).toEqual([auto])
    expect(glossariesForTranslation([user], auto, false)).toEqual([user, auto])
    expect(glossariesForTranslation([user], null, true)).toEqual([user])
  })
})
