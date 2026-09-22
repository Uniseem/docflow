import { describe, expect, test } from 'vitest'
import { joinLineTexts, normalizeParagraphText } from './normalize'

describe('normalize', () => {
  test('joins hyphenated line breaks', () => {
    expect(joinLineTexts('The transfor-', 'mation uses')).toBe('The transformation uses')
    expect(joinLineTexts('state-of-the-', 'Art method')).toBe('state-of-the-Art method')
  })

  test('expands ligatures and markers', () => {
    expect(normalizeParagraphText('the ﬁ ligature  {v1}yes')).toBe('the fi ligature {v1} yes')
  })
})
