import { describe, expect, test } from 'vitest'
import { restorableBounds } from './window-state'

const screen = [{ x: 0, y: 25, width: 1440, height: 875 }]

describe('restorableBounds', () => {
  test('keeps saved bounds whose title bar is on a display', () => {
    expect(
      restorableBounds({ x: 100, y: 80, width: 1300, height: 820, maximized: false }, screen),
    ).toEqual({ x: 100, y: 80, width: 1300, height: 820 })
  })

  test('drops bounds left on an unplugged monitor', () => {
    expect(
      restorableBounds({ x: 2000, y: 80, width: 1300, height: 820, maximized: false }, screen),
    ).toBeUndefined()
    expect(
      restorableBounds({ x: 100, y: -900, width: 1300, height: 820, maximized: false }, screen),
    ).toBeUndefined()
  })

  test('enforces the minimum size and ignores nothing saved', () => {
    expect(
      restorableBounds({ x: 10, y: 40, width: 300, height: 200, maximized: false }, screen),
    ).toEqual({ x: 10, y: 40, width: 960, height: 600 })
    expect(restorableBounds(undefined, screen)).toBeUndefined()
  })
})
