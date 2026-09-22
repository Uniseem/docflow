import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { UserError } from '../../shared/errors'
import { DocumentLibrary } from '../library/library'
import { Scheduler } from '../jobs/scheduler'
import { SettingsStore } from '../settings/settings'
import { memoryCryptor, SecretsStore } from '../settings/secrets'
import { TranslationPools } from '../translate/pool'
import { fakeFetch, fakeProvider } from '../translate/fake'
import type { DialogHost } from '../app/dialogs'
import {
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
  const opened: string[] = []
  const removed: string[] = []
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
    sendRemoved: (id) => {
      removed.push(id)
    },
  }
  const pdf = join(dir, 'paper.pdf')
  await writeFile(pdf, '%PDF-1.4 fixture')
  return { dir, lib, ctx, pdf, hold, revealed, opened, removed }
}

describe('documents handlers', () => {
  test('create / list / get / events / rename', async () => {
    const { ctx, pdf, hold } = await setup()
    const created = await handleDocumentsCreate(ctx, { paths: [pdf], translator, title: 'Paper' })
    expect(created.created).toHaveLength(1)
    expect(created.failed).toHaveLength(0)
    const id = created.created[0]!.id
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
})
