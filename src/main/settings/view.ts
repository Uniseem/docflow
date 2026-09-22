import { PRESETS, keyOptional } from '../../shared/presets'
import type { Settings, ProviderConfig } from '../../shared/types'
import type { SecretsStore } from './secrets'

export function llmReady(
  settings: Settings,
  secrets: { keyConfigured(id: string): boolean },
): boolean {
  return settings.providers.some((provider) => {
    if (!provider.enabled || provider.models.length === 0) return false
    return secrets.keyConfigured(provider.id) || keyOptional(provider)
  })
}

export function toSettingsView(
  settings: Settings,
  secrets: Pick<SecretsStore, 'keyConfigured' | 'keyMasked'>,
  env: NodeJS.Dict<string> = process.env,
) {
  return {
    ...settings,
    providers: settings.providers.map((provider) => ({
      ...provider,
      keyConfigured: secrets.keyConfigured(provider.id),
      keyMasked: secrets.keyMasked(provider.id),
      keyOptional: keyOptional(provider),
      keyUrl: PRESETS.find((preset) => preset.id === provider.preset)?.keyUrl,
    })),
    presets: PRESETS,
    limits: {
      maxProviders: 64,
      workerConcurrency: { min: 1, max: 4 },
    },
    capabilities: {
      llmReady: llmReady(settings, secrets),
      fakeProviders: env.DOCFLOW_FAKE_PROVIDERS === '1',
    },
  }
}

export type SettingsView = ReturnType<typeof toSettingsView>
export type { ProviderConfig }
