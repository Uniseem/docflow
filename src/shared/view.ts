import type { ProviderPreset } from './presets'
import type { ProviderConfig, Settings } from './types'

export type SettingsViewProvider = ProviderConfig & {
  keyConfigured: boolean
  keyMasked: string | null
  keyOptional: boolean
  keyUrl?: string | undefined
}

export type SettingsView = Omit<Settings, 'providers'> & {
  providers: SettingsViewProvider[]
  presets: readonly ProviderPreset[]
  limits: {
    maxProviders: number
    workerConcurrency: { min: number; max: number }
  }
  capabilities: {
    llmReady: boolean
    fakeProviders: boolean
  }
}
