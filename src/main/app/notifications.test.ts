import { describe, expect, test } from 'vitest'
import { dockBadge, notifyIfBackground, overallProgress, windowFocused } from './notifications'

describe('notifications', () => {
  test('only notifies completed/failed when the window is in the background', () => {
    expect(
      notifyIfBackground({ enabled: true, focused: false, status: 'completed', title: 'A' }),
    ).toEqual({ title: '翻译完成', body: 'A' })
    expect(
      notifyIfBackground({ enabled: true, focused: true, status: 'failed', title: 'B' }),
    ).toBeNull()
    expect(
      notifyIfBackground({ enabled: false, focused: false, status: 'failed', title: 'C' }),
    ).toBeNull()
  })

  test('no window (closed on macOS) counts as background', () => {
    const window = (focused: boolean, destroyed = false) => ({
      isFocused: () => focused,
      isDestroyed: () => destroyed,
    })
    expect(windowFocused(null)).toBe(false)
    expect(windowFocused(window(true, true))).toBe(false)
    expect(windowFocused(window(false))).toBe(false)
    expect(windowFocused(window(true))).toBe(true)
  })

  test('badge and taskbar progress', () => {
    expect(dockBadge(0)).toBe('')
    expect(dockBadge(3)).toBe('3')
    expect(overallProgress([])).toBe(-1)
    expect(overallProgress([50, 50])).toBe(0.5)
  })
})
