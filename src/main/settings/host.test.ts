import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

  test('a relative DOCFLOW_DATA_DIR resolves to an absolute path', () => {
    const store = new HostStore(tmpdir(), {
      fallbackLibraryDir: tmpdir(),
      env: { DOCFLOW_DATA_DIR: 'relative/lib' },
    })
    expect(store.libraryDir()).toBe(resolve('relative/lib'))
  })

  test('concurrent updates all reach host.json', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'docflow-host-'))
    const store = new HostStore(userData, { fallbackLibraryDir: userData, env: {} })
    await store.load()
    await Promise.all([
      store.update({ theme: 'dark' }),
      store.update({ window: { x: 1, y: 2, width: 1000, height: 700, maximized: false } }),
    ])
    const again = new HostStore(userData, { fallbackLibraryDir: userData, env: {} })
    await again.load()
    expect(again.snapshot.theme).toBe('dark')
    expect(again.snapshot.window?.width).toBe(1000)
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
