import { create } from 'zustand'
import { invoke } from '../api/invoke'

export type UiView = 'library' | 'settings'
export type ThemeChoice = 'system' | 'light' | 'dark'
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
  setTheme: (theme: ThemeChoice) => Promise<void>
  setAppInfo: (info: AppInfo) => void
  openNewTranslation: (paths?: string[]) => void
  closeNewTranslation: () => void
  setConfirm: (confirm: ConfirmState | null) => void
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
  onConfirm: () => Promise<void> | void
}

export const useUiStore = create<UiState>((set) => ({
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
  setTheme: async (theme) => {
    set({ theme })
    await invoke('app:setTheme', { theme })
  },
  setAppInfo: (appInfo) => set({ appInfo, theme: appInfo.theme, engineReady: true }),
  openNewTranslation: (paths = []) =>
    set({ newTranslationOpen: true, newTranslationPaths: paths, view: 'library' }),
  closeNewTranslation: () => set({ newTranslationOpen: false, newTranslationPaths: [] }),
  setConfirm: (confirm) => set({ confirm }),
  setRename: (rename) => set({ rename }),
  setNarrow: (narrow) => set({ narrow }),
  setInfoOpen: (infoOpen) => set({ infoOpen }),
  focusSearch: () => set((state) => ({ searchFocused: state.searchFocused + 1 })),
}))

function hasWindowApi(): boolean {
  return typeof window !== 'undefined' && Boolean(window.docflow)
}
