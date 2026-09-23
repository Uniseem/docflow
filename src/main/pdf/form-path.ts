/**
 * True when `formPath` is a shared form or nested anywhere inside one. Shared forms are drawn
 * on several pages, so neither analysis nor rewrite may touch their text or their children.
 */
export function inSharedForm(formPath: string, shared: ReadonlySet<string>): boolean {
  if (!formPath) return false
  for (const path of shared) {
    if (formPath === path || formPath.startsWith(`${path}/`)) return true
  }
  return false
}
