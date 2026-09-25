// Translations for compose tests that go through the real BabelDOC input and output parsing:
// every Latin word outside the placeholders becomes 译文.
import type { AnalysisResult, TranslatedParagraph } from '../../src/shared/pdf-types'
import { FontMapper } from '../../src/main/pdf/babeldoc/fontmap'
import { buildParagraphs } from '../../src/main/translate/babeldoc/paragraphs'
import {
  getTranslateInput,
  parseTranslateOutput,
} from '../../src/main/translate/babeldoc/placeholders'

const PLACEHOLDER = /(\{v\d+\}|<style id='\d+'>|<\/style>)/

export function fakeTranslate(text: string, word = '译文'): string {
  return text
    .split(PLACEHOLDER)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/[A-Za-z]+/g, word)))
    .join('')
}

export function fakeTranslations(
  analysis: AnalysisResult,
  options: { minTextLength?: number; richText?: boolean } = {},
): TranslatedParagraph[] {
  const mapper = new FontMapper('auto', () => true)
  const out: TranslatedParagraph[] = []
  for (const p of buildParagraphs(analysis)) {
    if ([...p.unicode].length < (options.minTextLength ?? 5)) continue
    const input = getTranslateInput(p, {
      disableRichText: options.richText === false,
      mapper,
      fonts: p.unit.fonts,
    })
    if (!input) continue
    const text = fakeTranslate(input.unicode)
    out.push({ id: p.id, text, kept: false, comps: parseTranslateOutput(input, text) })
  }
  return out
}
