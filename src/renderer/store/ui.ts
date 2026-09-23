import { create } from 'zustand'
import { invoke } from '../api/invoke'
import type { ThemeChoice } from '../lib/theme'
import { useSettingsStore } from './settings'

export type { ThemeChoice }
export type UiView = 'library' | 'settings'
export type SettingsTab = 'general' | 'providers' | 'network' | 'advanced' | 'about'

export type AppInfo = {
  version: string
  platform: 'darwin' | 'win32'
  libraryDir: string
  logsDir: string
  arch: string
  theme: ThemeChoice
  dataDirFromEnv: boolean
}

type UiState = {
  view: UiView
  theme: ThemeChoice
  settingsTab: SettingsTab
  appInfo: AppInfo | null
  newTranslationOpen: boolean
  newTranslationPaths: string[]
  confirm: ConfirmState | null
  rename: { id: string; title: string } | null
  searchFocused: number
  narrow: boolean
  infoOpen: boolean
  engineReady: boolean
  setView: (view: UiView) => void
  setSettingsTab: (tab: SettingsTab) => void
  /** Opens settings on `tab`; without one, 翻译服务 until a model is configured, else 通用. */
  openSettings: (tab?: SettingsTab) => void
  setTheme: (theme: ThemeChoice) => Promise<void>
  /** Only the first call adopts `info.theme`; later calls (library change) keep the current theme. */
  setAppInfo: (info: AppInfo) => void
  openNewTranslation: (paths?: string[]) => void
  closeNewTranslation: () => void
  setConfirm: (confirm: ConfirmState | null) => void
  /** Closes `confirm` only if it is still the one shown; a newer confirm stays open. */
  clearConfirm: (confirm: ConfirmState) => void
  setRename: (rename: { id: string; title: string } | null) => void
  setNarrow: (narrow: boolean) => void
  setInfoOpen: (open: boolean) => void
  focusSearch: () => void
}

export type ConfirmState = {
  title: string
  body: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  /** Runs on confirm; the dialog closes itself when it resolves and stays open if it throws. */
  onConfirm: () => Promise<void> | void
}

export const useUiStore = create<UiState>((set, get) => ({
  view: 'library',
  theme: 'system',
  settingsTab: 'general',
  appInfo: null,
  newTranslationOpen: false,
  newTranslationPaths: [],
  confirm: null,
  rename: null,
  searchFocused: 0,
  narrow: false,
  infoOpen: false,
  engineReady: hasWindowApi(),
  setView: (view) => set({ view }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  openSettings: (tab) => {
    const llmReady = useSettingsStore.getState().view?.capabilities.llmReady ?? false
    set({ view: 'settings', settingsTab: tab ?? (llmReady ? 'general' : 'providers') })
  },
  setTheme: async (theme) => {
    set((state) => ({ theme, appInfo: state.appInfo ? { ...state.appInfo, theme } : null }))
    await invoke('app:setTheme', { theme })
  },
  setAppInfo: (appInfo) => {
    const first = get().appInfo === null
    set({
      appInfo: first ? appInfo : { ...appInfo, theme: get().theme },
      ...(first ? { theme: appInfo.theme } : {}),
      engineReady: true,
    })
  },
  // Paths arriving while the dialog is open (a second drop, app:openFiles) replace the preset;
  // the dialog merges each new preset into its own list.
  openNewTranslation: (paths = []) =>
    set({ newTranslationOpen: true, newTranslationPaths: paths, view: 'library' }),
  closeNewTranslation: () => set({ newTranslationOpen: false, newTranslationPaths: [] }),
  setConfirm: (confirm) => set({ confirm }),
  clearConfirm: (confirm) => {
    if (get().confirm === confirm) set({ confirm: null })
  },
  setRename: (rename) => set({ rename }),
  setNarrow: (narrow) => set({ narrow }),
  setInfoOpen: (infoOpen) => set({ infoOpen }),
  focusSearch: () => set((state) => ({ searchFocused: state.searchFocused + 1 })),
}))

function hasWindowApi(): boolean {
  return typeof window !== 'undefined' && Boolean(window.docflow)
}
