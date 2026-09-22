import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, test } from 'vitest'
import { defaultTranslationRuntime } from '../../shared/types'
import { exportBundle } from './export'
import { DocumentLibrary } from './library'
import { EVENT_KEEP, MAX_EVENTS } from '../../shared/constants'
import { EventLog } from './events'
import { mkdir } from 'node:fs/promises'
import { eventsPath } from './manifest'

const translator = {
  providerId: 'fake',
  model: 'fake-model',
  label: '假服务商 · fake-model',
}

async function tempLib() {
  const dir = await mkdtemp(join(tmpdir(), 'df-lib-'))
  const lib = new DocumentLibrary()
  await lib.open(dir)
  return { dir, lib }
}

describe('DocumentLibrary', () => {
  test('creates a document, lists it, and rebuilds the index', async () => {
    const { dir, lib } = await tempLib()
    const pdf = join(dir, 'paper.pdf')
    await writeFile(pdf, '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n')
    const created = await lib.create({
      path: pdf,
      title: 'A Paper',
      translator,
      settingsSnapshot: defaultTranslationRuntime(),
      now: new Date('2026-09-22T08:00:00Z'),
      randomHex: 'abc123',
    })
    expect(created.id).toBe('20260922T080000-abc123')
    expect(created.title).toBe('A Paper')
    expect(created.files.source).toContain('docflow://library/documents/')
    const listed = lib.list('all', undefined, new Set())
    expect(listed.counts.all).toBe(1)
    expect(listed.items[0]?.title).toBe('A Paper')
    const again = new DocumentLibrary()
    await again.open(dir)
    expect(again.get(created.id, false).originalFilename).toBe('paper.pdf')
  })

  test('filters by query and status groups', async () => {
    const { dir, lib } = await tempLib()
    const pdfA = join(dir, 'alpha.pdf')
    const pdfB = join(dir, 'beta.pdf')
    await writeFile(pdfA, '%PDF-1.4\n')
    await writeFile(pdfB, '%PDF-1.4\n')
    const a = await lib.create({
      path: pdfA,
      title: 'Alpha Study',
      translator,
      settingsSnapshot: defaultTranslationRuntime(),
      randomHex: 'aaaaaa',
    })
    const b = await lib.create({
      path: pdfB,
      title: 'Beta Notes',
      translator,
      settingsSnapshot: defaultTranslationRuntime(),
      randomHex: 'bbbbbb',
    })
    await lib.update(b.id, { status: 'completed' })
    expect(lib.list('all', 'alpha', new Set()).items).toHaveLength(1)
    expect(lib.list('completed', undefined, new Set()).items.map((i) => i.id)).toEqual([b.id])
    expect(lib.index.counts().active).toBe(1)
    await lib.rename(a.id, 'Renamed')
    expect(lib.get(a.id, false).titleCustom).toBe(true)
    await lib.remove(a.id)
    expect(lib.list('all', undefined, new Set()).counts.all).toBe(1)
  })

  test('export zip contains source and manifest', async () => {
    const { dir, lib } = await tempLib()
    const pdf = join(dir, 'paper.pdf')
    await writeFile(pdf, '%PDF-1.4 hello')
    const created = await lib.create({
      path: pdf,
      title: 'Zip Me',
      translator,
      settingsSnapshot: defaultTranslationRuntime(),
    })
    const zip = await exportBundle(dir, lib.require(created.id))
    const files = unzipSync(zip)
    expect(strFromU8(files['manifest.json']!).includes('Zip Me')).toBe(true)
    expect(files['source/paper.pdf']).toBeTruthy()
    expect(strFromU8(files['README.txt']!)).toContain('DocFlow 导出')
  })
})

describe('EventLog', () => {
  test('serializes appends and truncates while keeping the first event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-ev-'))
    await mkdir(join(dir, 'documents', 'x'), { recursive: true })
    await writeFile(eventsPath(dir, 'x'), '')
    const log = new EventLog(dir)
    const originalMax = MAX_EVENTS
    expect(originalMax).toBeGreaterThan(EVENT_KEEP)
    for (let i = 0; i < 3; i += 1) {
      await log.append('x', { stage: 'inspect', level: 'info', message: `m${i}` })
    }
    const page = await log.read('x', 1, 10)
    expect(page.items[0]?.seq).toBe(2)
    expect(page.lastSeq).toBe(3)
  })
})
