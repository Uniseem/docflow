import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { HostStore, ensureLibraryFolderName } from './host'

describe('HostStore', () => {
  test('DOCFLOW_DATA_DIR wins over host.json', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'docflow-host-'))
    const fallback = join(userData, 'fallback')
    const store = new HostStore(userData, {
      fallbackLibraryDir: fallback,
      env: { DOCFLOW_DATA_DIR: join(userData, 'env-lib') },
    })
    await store.load()
    await store.update({ libraryDir: join(userData, 'host-lib') })
    expect(store.libraryDir()).toBe(join(userData, 'env-lib'))
  })

  test('host.json libraryDir beats fallback', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'docflow-host-'))
    const fallback = join(userData, 'fallback')
    const store = new HostStore(userData, { fallbackLibraryDir: fallback, env: {} })
    await store.load()
    expect(store.libraryDir()).toBe(fallback)
    await store.update({ libraryDir: join(userData, 'host-lib'), theme: 'dark' })
    const again = new HostStore(userData, { fallbackLibraryDir: fallback, env: {} })
    await again.load()
    expect(again.libraryDir()).toBe(join(userData, 'host-lib'))
    expect(again.snapshot.theme).toBe('dark')
  })
})

test('ensureLibraryFolderName appends DocFlow when needed', () => {
  expect(ensureLibraryFolderName('/tmp/DocFlow')).toBe('/tmp/DocFlow')
  expect(ensureLibraryFolderName('/tmp/papers')).toBe(join('/tmp/papers', 'DocFlow'))
})
