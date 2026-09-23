import { create } from 'zustand'
import type { SettingsView } from '../../shared/view'
import { invoke, listen } from '../api/invoke'
import { notifyError } from '../lib/notify'

type SettingsState = {
  view: SettingsView | null
  selectedProviderId: string | null
  load: () => Promise<void>
  apply: (next: SettingsView) => void
  /** Saves a settings patch; on failure shows `设置未保存：<原因>` and resolves false. Never throws. */
  update: (patch: unknown) => Promise<boolean>
  selectProvider: (id: string | null) => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  view: null,
  selectedProviderId: null,
  load: async () => {
    const view = (await invoke('settings:get', {})) as SettingsView
    set({
      view,
      selectedProviderId: get().selectedProviderId ?? view.providers[0]?.id ?? null,
    })
  },
  apply: (view) => {
    const current = get().selectedProviderId
    const still = view.providers.some((item) => item.id === current)
    set({
      view,
      selectedProviderId: still ? current : (view.providers[0]?.id ?? null),
    })
  },
  update: async (patch) => {
    try {
      const view = (await invoke('settings:update', patch)) as SettingsView
      get().apply(view)
      return true
    } catch (error) {
      // invoke() already toasted internal errors; user-facing ones get the 06 §6.5 prefix.
      notifyError(error, '设置未保存：')
      return false
    }
  },
  selectProvider: (selectedProviderId) => set({ selectedProviderId }),
}))

export function subscribeSettings(): () => void {
  return listen('settings:changed', (payload) => {
    useSettingsStore.getState().apply(payload as SettingsView)
  })
}
