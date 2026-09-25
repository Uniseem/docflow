import { describe, expect, test } from 'vitest'
import { name2unicode, parseToUnicode, type1Encoding } from './unicode'

const enc = (text: string) => new TextEncoder().encode(text)

describe('name2unicode (encodingdb)', () => {
  test.each([
    ['A', 'A'],
    ['fi', 'ﬁ'],
    ['alpha', 'α'],
    ['uni0041', 'A'],
    ['uni00410042', 'AB'],
    ['u1F600', '😀'],
    ['f_i', 'fi'],
    ['A.sc', 'A'],
  ])('%s → %s', (name, text) => {
    expect(name2unicode(name)).toBe(text)
  })

  test.each(['a27', '.notdef', 'uniD800', 'foo'])('%s raises', (name) => {
    expect(() => name2unicode(name)).toThrow()
  })
})

describe('parseToUnicode (CMapParser → FileUnicodeMap)', () => {
  test('bfchar, bfrange with a start value and with an array', () => {
    const map = parseToUnicode(
      enc(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <00> <FF> endcodespacerange
2 beginbfchar <01> <0041> <02> <D83DDE00> endbfchar
2 beginbfrange <10> <12> <0061> <20> <21> [<0066006C> (X)] endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end`),
    )
    expect(Object.fromEntries(map)).toEqual({
      1: 'A',
      2: '😀',
      16: 'a',
      17: 'b',
      18: 'c',
      32: 'fl',
      33: '',
    })
  })

  test('a non-breaking space does not replace a space for the same code', () => {
    const map = parseToUnicode(enc('2 beginbfchar <01> <0020> <01> <00A0> endbfchar'))
    expect(map.get(1)).toBe(' ')
  })
})

describe('type1Encoding (Type1FontHeaderParser)', () => {
  test('reads dup <code> /<name> put entries and drops unknown names', () => {
    const header = enc(
      '/Encoding 256 array 0 1 255 {1 index exch /.notdef put} for\n' +
        'dup 32 /space put\ndup 65 /A put\ndup 55 /a27 put\nreadonly def',
    )
    expect(Object.fromEntries(type1Encoding(header))).toEqual({ 32: ' ', 65: 'A' })
  })
})
