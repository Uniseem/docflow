export type ThemeChoice = 'system' | 'light' | 'dark'

/**
 * `system` follows prefers-color-scheme, which in Electron reflects nativeTheme.themeSource.
 * Main sets that from host.json before the window loads, so main.tsx can apply the saved theme
 * synchronously before the first render (no flash of the light theme).
 */
export function applyTheme(theme: ThemeChoice): void {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.classList.toggle('light', !dark)
  root.setAttribute('data-theme', dark ? 'dark' : 'light')
}
