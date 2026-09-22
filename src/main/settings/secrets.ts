import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ERROR_CODES, UserError } from '../../shared/errors'
import { maskKey } from '../../shared/text'
import { writeFileAtomic } from './atomic-write'

export type Cryptor = {
  isAvailable: () => boolean
  encryptString: (plain: string) => Uint8Array
  decryptString: (data: Uint8Array) => string
}

export class SecretsStore {
  #map = new Map<string, string>()
  readonly filePath: string

  constructor(
    private readonly libraryDir: string,
    private readonly cryptor: Cryptor,
  ) {
    this.filePath = join(libraryDir, 'secrets.bin')
  }

  get(providerId: string): string | undefined {
    return this.#map.get(providerId)
  }

  keyConfigured(providerId: string): boolean {
    return (this.#map.get(providerId)?.length ?? 0) > 0
  }

  keyMasked(providerId: string): string | null {
    const raw = this.#map.get(providerId)
    if (!raw) return null
    return maskKey(raw)
  }

  async load(): Promise<void> {
    let bytes: Uint8Array
    try {
      bytes = await readFile(this.filePath)
    } catch (error) {
      if (isNotFound(error)) {
        this.#map = new Map()
        return
      }
      throw error
    }
    if (!this.cryptor.isAvailable()) {
      this.#map = new Map()
      return
    }
    const parsed = JSON.parse(this.cryptor.decryptString(bytes)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.#map = new Map()
      return
    }
    this.#map = new Map(
      Object.entries(parsed as Record<string, unknown>).flatMap(([id, value]) =>
        typeof value === 'string' && value.length > 0 ? [[id, value] as const] : [],
      ),
    )
  }

  async set(providerId: string, value: string | null): Promise<void> {
    if (!this.cryptor.isAvailable()) {
      throw new UserError(ERROR_CODES.keychain_unavailable)
    }
    if (value === null || value.length === 0) this.#map.delete(providerId)
    else this.#map.set(providerId, value)
    const payload = JSON.stringify(Object.fromEntries(this.#map))
    await writeFileAtomic(this.filePath, this.cryptor.encryptString(payload))
  }
}

export function memoryCryptor(): Cryptor {
  return {
    isAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain, 'utf8'),
    decryptString: (data) => Buffer.from(data).toString('utf8'),
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
