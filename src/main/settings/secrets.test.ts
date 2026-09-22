import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ERROR_CODES } from '../../shared/errors'
import { SecretsStore, memoryCryptor, type Cryptor } from './secrets'

function unavailable(): Cryptor {
  return {
    isAvailable: () => false,
    encryptString: () => {
      throw new Error('unavailable')
    },
    decryptString: () => {
      throw new Error('unavailable')
    },
  }
}

describe('SecretsStore', () => {
  test('round-trips keys with an injected cryptor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docflow-secrets-'))
    const store = new SecretsStore(dir, memoryCryptor())
    await store.load()
    await store.set('deepseek', 'sk-abcdefghijk')
    expect(store.keyConfigured('deepseek')).toBe(true)
    expect(store.keyMasked('deepseek')).toBe('••••••••hijk')
    const again = new SecretsStore(dir, memoryCryptor())
    await again.load()
    expect(again.get('deepseek')).toBe('sk-abcdefghijk')
    await again.set('deepseek', null)
    expect(again.get('deepseek')).toBeUndefined()
  })

  test('saving without a cryptor is a user error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docflow-secrets-'))
    const store = new SecretsStore(dir, unavailable())
    await store.load()
    await expect(store.set('deepseek', 'sk-test')).rejects.toMatchObject({
      code: ERROR_CODES.keychain_unavailable,
      user: true,
    })
  })

  test('half-written tmp does not break load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docflow-secrets-'))
    const store = new SecretsStore(dir, memoryCryptor())
    await store.load()
    await store.set('deepseek', 'sk-abcdefghijk')
    await writeFile(join(dir, 'secrets.bin.partial.tmp'), 'xxxx', 'utf8')
    const again = new SecretsStore(dir, memoryCryptor())
    await again.load()
    expect(again.get('deepseek')).toBe('sk-abcdefghijk')
  })
})
