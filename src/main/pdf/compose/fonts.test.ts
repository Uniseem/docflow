import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { PDFDocument } from '@cantoo/pdf-lib'
import { stripSubsetPrefix, embedCjkFonts } from './fonts'

describe('fonts', () => {
  test('strips PDF subset prefixes', () => {
    expect(stripSubsetPrefix('ABCDEF+CMR10')).toBe('CMR10')
    expect(stripSubsetPrefix('Times-Roman')).toBe('Times-Roman')
  })

  test('embeds CJK with subset and mounts a dictionary name', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([200, 200])
    const { regular } = await embedCjkFonts(
      doc,
      {
        regular: join(process.cwd(), 'resources/fonts/NotoSansSC-Regular.otf'),
        bold: join(process.cwd(), 'resources/fonts/NotoSansSC-Bold.otf'),
      },
      false,
    )
    page.node.normalize()
    page.node.setFontDictionary((await import('@cantoo/pdf-lib')).PDFName.of('DFcjk'), regular.ref)
    const dir = await mkdtemp(join(tmpdir(), 'df-font-'))
    const bytes = await doc.save()
    expect(bytes.length).toBeGreaterThan(1000)
    expect(dir).toBeTruthy()
  })
})
