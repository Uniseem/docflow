import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { relativeFromDocflowUrl, resolveLibraryPdf } from './protocol'

describe('docflow:// protocol', () => {
  test('accepts library-relative PDF URLs', () => {
    expect(relativeFromDocflowUrl('docflow://library/documents/a/source.pdf')).toBe(
      'documents/a/source.pdf',
    )
    expect(relativeFromDocflowUrl('docflow://other/documents/a/source.pdf')).toBeNull()
    expect(relativeFromDocflowUrl('docflow://library/../etc/passwd')).toBeNull()
    expect(relativeFromDocflowUrl('https://library/documents/a/source.pdf')).toBeNull()
  })

  test('resolves only files inside the library that are PDFs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-proto-'))
    await mkdir(join(dir, 'documents', 'a'), { recursive: true })
    const pdf = join(dir, 'documents', 'a', 'source.pdf')
    await writeFile(pdf, '%PDF-1.4')
    await writeFile(join(dir, 'documents', 'a', 'notes.txt'), 'nope')
    const ok = await resolveLibraryPdf(dir, 'docflow://library/documents/a/source.pdf')
    expect(ok).toBe(await realpath(pdf))
    expect(await resolveLibraryPdf(dir, 'docflow://library/documents/a/notes.txt')).toBeNull()
    expect(await resolveLibraryPdf(dir, 'docflow://library/../source.pdf')).toBeNull()
    expect(await resolveLibraryPdf(dir, 'docflow://library/documents/missing.pdf')).toBeNull()
  })
})
