import { mkdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { HostState } from '../../shared/types'
import { writeJsonAtomic } from './atomic-write'

export type HostOptions = {
  env?: NodeJS.Dict<string>
  fallbackLibraryDir: string
}

export class HostStore {
  #value: HostState = {}
  #writes: Promise<void> = Promise.resolve()
  readonly filePath: string

  constructor(
    private readonly userDataDir: string,
    private readonly options: HostOptions,
  ) {
    this.filePath = join(userDataDir, 'host.json')
  }

  get snapshot(): HostState {
    return this.#value
  }

  libraryDir(): string {
    const fromEnv = this.options.env?.DOCFLOW_DATA_DIR?.trim()
    if (fromEnv) return resolve(fromEnv)
    return this.#value.libraryDir ?? this.options.fallbackLibraryDir
  }

  /** The library used when the configured one cannot be opened. */
  defaultLibraryDir(): string {
    return this.options.fallbackLibraryDir
  }

  async load(): Promise<HostState> {
    await mkdir(this.userDataDir, { recursive: true })
    try {
      const raw = await readFile(this.filePath, 'utf8')
      this.#value = HostState.parse(JSON.parse(raw) as unknown)
    } catch {
      this.#value = {}
    }
    return this.#value
  }

  /** Merges and saves; writes are queued so concurrent updates (theme, window) all land. */
  async update(patch: HostState): Promise<HostState> {
    const next = HostState.parse({ ...this.#value, ...patch })
    this.#value = next
    const write = this.#writes.then(() => writeJsonAtomic(this.filePath, this.#value))
    this.#writes = write.catch(() => undefined)
    await write
    return next
  }
}

export function ensureLibraryFolderName(selected: string): string {
  return basename(selected) === 'DocFlow' ? selected : join(selected, 'DocFlow')
}
