import { access, mkdtemp, mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { MAX_PDF_BYTES } from '../../shared/constants'
import { UserError } from '../../shared/errors'
import { DocumentLibrary } from '../library/library'
import { Scheduler } from '../jobs/scheduler'
import { SettingsStore } from '../settings/settings'
import { memoryCryptor, SecretsStore } from '../settings/secrets'
import { TranslationPools } from '../translate/pool'
import { fakeFetch, fakeProvider } from '../translate/fake'
import type { DialogHost } from '../app/dialogs'
import {
  handleAppTakePendingFiles,
  handleDocumentsCancel,
  handleDocumentsCreate,
  handleDocumentsDelete,
  handleDocumentsEvents,
  handleDocumentsExport,
  handleDocumentsGet,
  handleDocumentsList,
  handleDocumentsOpenExternal,
  handleDocumentsRename,
  handleDocumentsReveal,
  handleDocumentsRetry,
  handleGlossariesDelete,
  handleGlossariesImport,
  handleGlossariesUpdate,
  handleShellRevealExport,
  type HandlerContext,
} from './handlers'

const translator = { providerId: 'fake', model: 'fake-model' }

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'df-ipc-'))
  const lib = new DocumentLibrary()
  await lib.open(dir)
  const settings = new SettingsStore(dir)
  await settings.load()
  await settings.replaceProviders([fakeProvider()])
  const secrets = new SecretsStore(dir, memoryCryptor())
  await secrets.load()
  const hold = new Map<string, () => void>()
  const scheduler = new Scheduler(
    lib,
    (id, signal) =>
      new Promise<void>((resolve, reject) => {
        hold.set(id, resolve)
        signal.addEventListener('abort', () => reject(new UserError('cancelled')), { once: true })
      }),
    { concurrency: () => 1 },
  )
  const revealed: string[] = []
  const pending: string[] = []
  const opened: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  const dialog: DialogHost = {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: ({ defaultPath }) =>
      Promise.resolve({
        canceled: false,
        filePath: join(dir, defaultPath ?? 'out.bin'),
      }),
  }
  const ctx: HandlerContext = {
    library: lib,
    scheduler,
    settings,
    secrets,
    pools: new TranslationPools(fakeFetch, () => 'k'),
    dialog,
    fetch: fakeFetch,
    env: { DOCFLOW_FAKE_PROVIDERS: '1' },
    version: '4.0.0',
    platform: 'darwin',
    arch: 'arm64',
    logsDir: join(dir, 'logs'),
    getLibraryDir: () => dir,
    getTheme: () => 'system' as const,
    setTheme: () => Promise.resolve(),
    checkUpdates: () => Promise.resolve({ latest: '4.0.0', url: 'https://example', newer: false }),
    changeLibrary: (path) => Promise.resolve(path),
    reveal: (path) => {
      revealed.push(path)
    },
    openPath: (path) => {
      opened.push(path)
      return Promise.resolve()
    },
    openExternal: () => Promise.resolve(),
    sendChanged: (item) => {
      changed.push(item.id)
    },
    sendRemoved: (id) => {
      removed.push(id)
    },
    relaunch: () => undefined,
    exportedPaths: new Set(),
    takePendingFiles: () => pending.splice(0),
  }
  const pdf = join(dir, 'paper.pdf')
  await writeFile(pdf, '%PDF-1.4 fixture')
  return { dir, lib, ctx, pdf, hold, revealed, opened, removed, changed, pending }
}

describe('documents handlers', () => {
  test('create / list / get / events / rename', async () => {
    const { ctx, pdf, hold, changed } = await setup()
    const created = await handleDocumentsCreate(ctx, { paths: [pdf], translator, title: 'Paper' })
    expect(created.created).toHaveLength(1)
    expect(created.failed).toHaveLength(0)
    const id = created.created[0]!.id
    expect(changed).toContain(id)
    const listed = handleDocumentsList(ctx, { filter: 'all' })
    expect(listed.counts.all).toBe(1)
    expect(listed.items[0]?.title).toBe('Paper')
    expect(handleDocumentsGet(ctx, { id }).originalFilename).toBe('paper.pdf')
    const events = await handleDocumentsEvents(ctx, { id })
    expect(events.items[0]?.message).toContain('已复制源文件')
    const renamed = await handleDocumentsRename(ctx, { id, title: 'Renamed' })
    expect(renamed.title).toBe('Renamed')
    await expect.poll(() => hold.has(id)).toBe(true)
    hold.get(id)?.()
    await ctx.scheduler.stop(0)
  })

  test('cancel / retry / delete / export / reveal / openExternal', async () => {
    const { ctx, pdf, hold, revealed, opened, removed, dir, lib } = await setup()
    const created = await handleDocumentsCreate(ctx, { paths: [pdf], translator })
    const id = created.created[0]!.id
    await expect.poll(() => ctx.scheduler.isRunning(id)).toBe(true)
    const cancelled = await handleDocumentsCancel(ctx, { id })
    expect(cancelled.status).toBe('cancelled')
    const retried = await handleDocumentsRetry(ctx, { id })
    expect(retried.status === 'queued' || retried.status === 'processing' || retried.running).toBe(
      true,
    )
    await expect.poll(() => hold.has(id)).toBe(true)
    hold.get(id)?.()
    await lib.update(id, {
      status: 'completed',
      outputs: { mono: { bytes: 10 }, dual: { bytes: 10 } },
    })
    await mkdir(join(dir, 'documents', id, 'output'), { recursive: true })
    await writeFile(join(dir, 'documents', id, 'output', 'mono.pdf'), '%PDF-1.4 mono')
    await writeFile(join(dir, 'documents', id, 'output', 'dual.pdf'), '%PDF-1.4 dual')
    const exported = await handleDocumentsExport(ctx, { id, kind: 'mono' })
    expect('path' in exported && exported.path.endsWith('.pdf')).toBe(true)
    const zipped = await handleDocumentsExport(ctx, { id, kind: 'bundle' })
    expect('path' in zipped && zipped.path.endsWith('.zip')).toBe(true)
    handleDocumentsReveal(ctx, { id, kind: 'folder' })
    expect(revealed[0]).toContain(id)
    await handleDocumentsOpenExternal(ctx, { id, kind: 'source' })
    expect(opened[0]).toContain('source.pdf')
    const deleted = await handleDocumentsDelete(ctx, { ids: [id] })
    expect(deleted.deleted).toEqual([id])
    expect(removed).toEqual([id])
    await ctx.scheduler.stop(0)
  })

  test('revealExport only reveals files exported in this session', async () => {
    const { ctx, pdf, hold, revealed, dir, lib } = await setup()
    const created = await handleDocumentsCreate(ctx, { paths: [pdf], translator })
    const id = created.created[0]!.id
    await expect.poll(() => hold.has(id)).toBe(true)
    hold.get(id)?.()
    await expect.poll(() => lib.require(id).status).toBe('completed')
    await mkdir(join(dir, 'documents', id, 'output'), { recursive: true })
    await writeFile(join(dir, 'documents', id, 'output', 'mono.pdf'), '%PDF-1.4 mono')
    const exported = await handleDocumentsExport(ctx, { id, kind: 'mono' })
    if (!('path' in exported)) throw new Error('export was cancelled')
    handleShellRevealExport(ctx, { path: exported.path })
    expect(revealed).toEqual([exported.path])
    expect(() => handleShellRevealExport(ctx, { path: join(dir, 'other.pdf') })).toThrow(/找不到/)
    await rm(exported.path)
    expect(() => handleShellRevealExport(ctx, { path: exported.path })).toThrow(/移动或删除/)
    await ctx.scheduler.stop(0)
  })

  test('revealExport also reveals an exported bundle', async () => {
    const { ctx, pdf, hold, revealed } = await setup()
    const created = await handleDocumentsCreate(ctx, { paths: [pdf], translator })
    const id = created.created[0]!.id
    await expect.poll(() => hold.has(id)).toBe(true)
    hold.get(id)?.()
    const zipped = await handleDocumentsExport(ctx, { id, kind: 'bundle' })
    if (!('path' in zipped)) throw new Error('export was cancelled')
    handleShellRevealExport(ctx, { path: zipped.path })
    expect(revealed).toEqual([zipped.path])
    await ctx.scheduler.stop(0)
  })

  test('openExternal and export report a missing file instead of failing silently', async () => {
    const { ctx, pdf, hold, lib } = await setup()
    const created = await handleDocumentsCreate(ctx, { paths: [pdf], translator })
    const id = created.created[0]!.id
    await expect.poll(() => hold.has(id)).toBe(true)
    hold.get(id)?.()
    await expect.poll(() => lib.require(id).status).toBe('completed')
    await expect(handleDocumentsOpenExternal(ctx, { id, kind: 'dual' })).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('双语') as unknown,
    })
    await expect(handleDocumentsExport(ctx, { id, kind: 'mono' })).rejects.toMatchObject({
      code: 'not_found',
    })
    await ctx.scheduler.stop(0)
  })

  test('takePendingFiles hands over the queue once', async () => {
    const { ctx, pending } = await setup()
    pending.push('/tmp/a.pdf', '/tmp/b.pdf')
    expect(handleAppTakePendingFiles(ctx)).toEqual({ paths: ['/tmp/a.pdf', '/tmp/b.pdf'] })
    expect(handleAppTakePendingFiles(ctx)).toEqual({ paths: [] })
    await ctx.scheduler.stop(0)
  })

  test('create records failed paths', async () => {
    const { ctx } = await setup()
    const result = await handleDocumentsCreate(ctx, {
      paths: [join(tmpdir(), 'missing-docflow.pdf')],
      translator,
    })
    expect(result.created).toHaveLength(0)
    expect(result.failed[0]?.message).toBeTruthy()
    await ctx.scheduler.stop(0)
  })

  test('create rejects empty and oversized PDFs', async () => {
    const { ctx, dir } = await setup()
    const empty = join(dir, 'empty.pdf')
    await writeFile(empty, '')
    const huge = join(dir, 'huge.pdf')
    await writeFile(huge, '')
    // Sparse file: reports the size without writing 500 MB.
    await truncate(huge, MAX_PDF_BYTES + 1)
    const result = await handleDocumentsCreate(ctx, { paths: [empty, huge], translator })
    expect(result.created).toHaveLength(0)
    expect(result.failed).toEqual([
      { path: empty, message: '文件是空的（0 字节），请选择其他 PDF。' },
      { path: huge, message: '文件太大，请选择小于 500 MB 的 PDF。' },
    ])
    await ctx.scheduler.stop(0)
  })
})

describe('documents:create options (BabelDOC pages)', () => {
  test('pages, only-these-pages and the enabled glossaries are stored with the document', async () => {
    const { ctx, pdf, lib } = await setup()
    await ctx.settings.update({
      glossaries: [
        { id: 'aa', name: 'on', enabled: true, entries: 1 },
        { id: 'bb', name: 'off', enabled: false, entries: 1 },
      ],
    })
    const created = await handleDocumentsCreate(ctx, {
      paths: [pdf],
      translator,
      pages: ' 2-3,5 ',
      onlyTranslatedPages: true,
    })
    const id = created.created[0]!.id
    expect(lib.require(id).options).toEqual({
      pages: '2-3,5',
      onlyTranslatedPages: true,
      glossaryIds: ['aa'],
    })
    await expect(
      handleDocumentsCreate(ctx, { paths: [pdf], translator, pages: '3-1' }),
    ).rejects.toMatchObject({ code: 'pages_out_of_range' })
    await ctx.scheduler.stop(0)
  })
})

describe('glossaries handlers', () => {
  test('import copies the CSV into the library and lists it by file name', async () => {
    const { ctx, dir } = await setup()
    const csv = join(dir, '化学.csv')
    await writeFile(csv, 'source,target\nacid,酸\nbase,碱\n')
    ctx.env = { ...ctx.env, DOCFLOW_E2E_GLOSSARY_PATH: csv }
    const result = await handleGlossariesImport(ctx)
    if (!('glossary' in result)) throw new Error('cancelled')
    expect(result.glossary).toMatchObject({ name: '化学', enabled: true, entries: 2 })
    expect(ctx.settings.snapshot.glossaries).toEqual([result.glossary])
    const stored = join(dir, 'glossaries', `${result.glossary.id}.csv`)
    expect(await readFile(stored, 'utf8')).toBe('source,target\nacid,酸\nbase,碱\n')

    await handleGlossariesUpdate(ctx, { id: result.glossary.id, enabled: false })
    expect(ctx.settings.snapshot.glossaries[0]?.enabled).toBe(false)
    await expect(handleGlossariesUpdate(ctx, { id: 'nope', enabled: true })).rejects.toMatchObject({
      code: 'not_found',
    })

    await handleGlossariesDelete(ctx, { id: result.glossary.id })
    expect(ctx.settings.snapshot.glossaries).toEqual([])
    await expect(access(stored)).rejects.toThrow()
    await ctx.scheduler.stop(0)
  })

  test('a CSV without source and target columns is refused with the reason', async () => {
    const { ctx, dir } = await setup()
    const csv = join(dir, 'bad.csv')
    await writeFile(csv, 'foo,bar\n1,2\n')
    ctx.env = { ...ctx.env, DOCFLOW_E2E_GLOSSARY_PATH: csv }
    await expect(handleGlossariesImport(ctx)).rejects.toMatchObject({
      message: '术语表 CSV 必须包含 source 和 target 两列。',
    })
    expect(ctx.settings.snapshot.glossaries).toEqual([])
    await ctx.scheduler.stop(0)
  })

  test('cancelling the file dialog changes nothing', async () => {
    const { ctx } = await setup()
    expect(await handleGlossariesImport(ctx)).toEqual({ cancelled: true })
    await ctx.scheduler.stop(0)
  })
})
