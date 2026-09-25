import { describe, expect, test } from 'vitest'
import { LEGACY_SYSTEM_PROMPT } from '../../shared/constants'
import { cleanReply, pdf2zhPrompt, safeSubstitute } from './pdf2zh-prompt'

describe('pdf2zh prompt', () => {
  test('renders exactly BaseTranslator.prompt for lang_out zh', () => {
    expect(pdf2zhPrompt('Hello {v0}.')).toBe(
      'You are a professional, authentic machine translation engine. Only Output the translated text, do not include any other text.\n\nTranslate the following markdown source text to zh. Keep the formula notation {v*} unchanged. Output translation directly without any additional text.\n\nSource Text: Hello {v0}.\n\nTranslated Text:',
    )
  })

  test('a custom template uses string.Template variables; the 4.0.0 prompt is replaced', () => {
    expect(pdf2zhPrompt('Hi', 'Translate $lang_in to ${lang_out}: $text ($$5, $unknown)')).toBe(
      'Translate en to zh: Hi ($5, $unknown)',
    )
    expect(pdf2zhPrompt('Hi', LEGACY_SYSTEM_PROMPT)).toBe(pdf2zhPrompt('Hi'))
  })

  test('safeSubstitute leaves a $ that starts no identifier alone', () => {
    expect(safeSubstitute('cost $ 5 ${x', { x: 'y' })).toBe('cost $ 5 ${x')
  })

  test('cleanReply strips, drops a leading <think> block, strips again', () => {
    expect(cleanReply('  <think>\nstep one\n</think>\n\n译文 {v0}\n')).toBe('译文 {v0}')
    expect(cleanReply('<think>unterminated\n译文')).toBe('<think>unterminated\n译文')
    expect(cleanReply('　 译文 ')).toBe('译文')
  })
})
