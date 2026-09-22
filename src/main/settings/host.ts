import { mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { HostState } from '../../shared/types'
import { writeJsonAtomic } from './atomic-write'

export type HostOptions = {
  env?: NodeJS.Dict<string>
  fallbackLibraryDir: string
}

export class HostStore {
  #value: HostState = {}
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
    if (fromEnv) return fromEnv
    return this.#value.libraryDir ?? this.options.fallbackLibraryDir
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

  async update(patch: HostState): Promise<HostState> {
    const next = HostState.parse({ ...this.#value, ...patch })
    await writeJsonAtomic(this.filePath, next)
    this.#value = next
    return next
  }
}

export function ensureLibraryFolderName(selected: string): string {
  return basename(selected) === 'DocFlow' ? selected : join(selected, 'DocFlow')
}
