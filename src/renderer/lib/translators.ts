import type { SettingsView } from '../../shared/view'

export type TranslatorOption = {
  key: string
  providerId: string
  model: string
  label: string
  providerName: string
}

export function translatorOptions(view: SettingsView | null): TranslatorOption[] {
  if (!view) return []
  const out: TranslatorOption[] = []
  for (const provider of view.providers) {
    if (!provider.enabled) continue
    if (!provider.keyConfigured && !provider.keyOptional) continue
    for (const model of provider.models) {
      out.push({
        key: `${provider.id}/${model.id}`,
        providerId: provider.id,
        model: model.id,
        label: model.name || model.id,
        providerName: provider.name,
      })
    }
  }
  return out
}

export function groupedTranslators(
  options: TranslatorOption[],
): Array<{ id: string; name: string; items: TranslatorOption[] }> {
  // Group by provider id, not display name: two providers may share a name, and the group id
  // is used as a React key for the ListBox sections.
  const groups: Array<{ id: string; name: string; items: TranslatorOption[] }> = []
  for (const option of options) {
    const group = groups.find((item) => item.id === option.providerId)
    if (group) group.items.push(option)
    else groups.push({ id: option.providerId, name: option.providerName, items: [option] })
  }
  return groups
}

export function defaultTranslatorKey(view: SettingsView | null): string | null {
  const options = translatorOptions(view)
  if (options.length === 0) return null
  const choice = view?.defaultTranslator
  if (choice) {
    const key = `${choice.providerId}/${choice.model}`
    if (options.some((item) => item.key === key)) return key
  }
  return options[0]?.key ?? null
}

export function parseTranslatorKey(key: string): { providerId: string; model: string } | null {
  const index = key.indexOf('/')
  if (index <= 0) return null
  return { providerId: key.slice(0, index), model: key.slice(index + 1) }
}
