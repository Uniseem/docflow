import { mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { Settings, defaultSettings, type ProviderConfig } from '../../shared/types'
import { writeJsonAtomic } from './atomic-write'

export type SettingsHooks = {
  onChange?: (settings: Settings) => void
  onWarning?: (message: string) => void
}

export function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base
  if (patch === null || Array.isArray(patch) || typeof patch !== 'object') return patch
  if (base === null || Array.isArray(base) || typeof base !== 'object') return patch
  const source = base as Record<string, unknown>
  const out: Record<string, unknown> = { ...source }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = deepMerge(source[key], value)
  }
  return out
}

function dropStaleTranslator(settings: Settings): Settings {
  const choice = settings.defaultTranslator
  if (!choice) return settings
  const provider = settings.providers.find((item) => item.id === choice.providerId)
  const modelOk = provider?.models.some((model) => model.id === choice.model)
  if (!provider || !modelOk) {
    return { ...settings, defaultTranslator: null }
  }
  return settings
}

export class SettingsStore {
  #value: Settings = defaultSettings()
  readonly filePath: string

  constructor(
    private readonly libraryDir: string,
    private readonly hooks: SettingsHooks = {},
  ) {
    this.filePath = join(libraryDir, 'settings.json')
  }

  get snapshot(): Settings {
    return this.#value
  }

  async load(): Promise<Settings> {
    await mkdir(this.libraryDir, { recursive: true })
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNotFound(error)) {
        this.#value = defaultSettings()
        return this.#value
      }
      throw error
    }

    try {
      this.#value = dropStaleTranslator(Settings.parse(JSON.parse(raw) as unknown))
    } catch {
      const broken = `${this.filePath}.broken-${stamp()}`
      await rename(this.filePath, broken).catch(() => undefined)
      this.hooks.onWarning?.(`settings.json 无法解析，已备份为 ${broken} 并恢复默认设置`)
      this.#value = defaultSettings()
    }
    return this.#value
  }

  async update(patch: unknown): Promise<Settings> {
    const merged = deepMerge(this.#value, patch)
    const parsed = dropStaleTranslator(Settings.parse(merged))
    await writeJsonAtomic(this.filePath, parsed)
    this.#value = parsed
    this.hooks.onChange?.(parsed)
    return parsed
  }

  replaceProviders(providers: ProviderConfig[]): Promise<Settings> {
    return this.update({ providers })
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function stamp(): string {
  return new Date().toISOString().replaceAll(':', '').replaceAll('.', '')
}
