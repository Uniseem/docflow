import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SettingsView } from '../../shared/view'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('../api/invoke', () => ({
  invoke: invokeMock,
  listen: () => () => undefined,
  hasApi: () => true,
}))

const { useUiStore } = await import('./ui')
const { useSettingsStore } = await import('./settings')

const info = {
  version: '4.0.0',
  platform: 'darwin' as const,
  libraryDir: '/lib/DocFlow',
  logsDir: '/lib/DocFlow/logs',
  arch: 'arm64',
  theme: 'light' as const,
  dataDirFromEnv: false,
}

function llmReady(ready: boolean): void {
  useSettingsStore.setState({
    view: { capabilities: { llmReady: ready } } as unknown as SettingsView,
  })
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue({})
  useUiStore.setState({
    view: 'library',
    theme: 'system',
    settingsTab: 'general',
    appInfo: null,
    confirm: null,
    newTranslationOpen: false,
    newTranslationPaths: [],
  })
})

describe('ui store', () => {
  test('openSettings starts at 翻译服务 until a model is configured', () => {
    llmReady(false)
    useUiStore.getState().openSettings()
    expect(useUiStore.getState()).toMatchObject({ view: 'settings', settingsTab: 'providers' })
    llmReady(true)
    useUiStore.getState().openSettings()
    expect(useUiStore.getState().settingsTab).toBe('general')
    useUiStore.getState().openSettings('about')
    expect(useUiStore.getState().settingsTab).toBe('about')
  })

  test('a library change keeps the theme chosen in this session', async () => {
    const ui = useUiStore.getState()
    ui.setAppInfo(info)
    expect(useUiStore.getState().theme).toBe('light')
    await useUiStore.getState().setTheme('dark')
    expect(useUiStore.getState().appInfo?.theme).toBe('dark')
    // library:changed re-sends app info built from the old snapshot
    useUiStore.getState().setAppInfo({ ...info, libraryDir: '/other/DocFlow' })
    expect(useUiStore.getState().theme).toBe('dark')
    expect(useUiStore.getState().appInfo).toMatchObject({
      libraryDir: '/other/DocFlow',
      theme: 'dark',
    })
  })

  test('clearConfirm never closes a newer confirm', () => {
    const first = { title: 'a', body: '', confirmLabel: 'ok', onConfirm: () => undefined }
    const second = { title: 'b', body: '', confirmLabel: 'ok', onConfirm: () => undefined }
    const ui = useUiStore.getState()
    ui.setConfirm(first)
    ui.setConfirm(second)
    ui.clearConfirm(first)
    expect(useUiStore.getState().confirm).toBe(second)
    ui.clearConfirm(second)
    expect(useUiStore.getState().confirm).toBeNull()
  })
})
