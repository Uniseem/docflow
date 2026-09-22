import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { joinTokens, lexContent, tokenText } from './content-lexer'
import { PDFDocument } from '@cantoo/pdf-lib'
import { contentBytesOf } from './streams'

const dir = join(process.cwd(), 'tests/fixtures')

function latin(text: string): Uint8Array {
  return Buffer.from(text, 'latin1')
}

describe('lexContent', () => {
  test('round-trips constructed samples', () => {
    const samples = [
      'BT /F1 12 Tf 1 0 0 1 72 720 Tm (Hello) Tj ET',
      '% comment\n[ (a) -120 (b) ] TJ',
      '<< /Type /Font /Name /F1 >>',
      '(nested (parens) and \\) tick)',
      '<48656C6C6F>',
      '0 Tc 0 Tw (line) \' 5 10 (q) "',
      'BI /W 1 /H 1 /CS /RGB ID \x00\x00\x00 EI\n',
    ]
    for (const sample of samples) {
      const bytes = latin(sample)
      const tokens = lexContent(bytes)
      expect(Buffer.from(joinTokens(bytes, tokens)).equals(Buffer.from(bytes)), sample).toBe(true)
    }
  })

  test('names, numbers and operators', () => {
    const bytes = latin('/F1 12.5 Tf -.2 Tc')
    const tokens = lexContent(bytes).filter((t) => t.kind !== 'space')
    expect(tokens.map((t) => [t.kind, tokenText(bytes, t)])).toEqual([
      ['name', '/F1'],
      ['number', '12.5'],
      ['operator', 'Tf'],
      ['number', '-.2'],
      ['operator', 'Tc'],
    ])
  })

  test('fixture page streams round-trip', async () => {
    const names = (await readdir(dir)).filter(
      (name) => name.endsWith('.pdf') && !name.startsWith('arxiv-') && name !== 'encrypted.pdf',
    )
    for (const name of names) {
      if (name === 'empty.pdf') continue
      const doc = await PDFDocument.load(await readFile(join(dir, name)), {
        ignoreEncryption: true,
      })
      const pages = Math.min(doc.getPageCount(), name === 'long.pdf' ? 1 : 2)
      for (let i = 0; i < pages; i += 1) {
        const bytes = contentBytesOf(doc.getPages()[i]!)
        const tokens = lexContent(bytes)
        expect(
          Buffer.from(joinTokens(bytes, tokens)).equals(Buffer.from(bytes)),
          `${name} p${i}`,
        ).toBe(true)
      }
    }
  })
})
