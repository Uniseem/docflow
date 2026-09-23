import { afterEach, describe, expect, test, vi } from 'vitest'
import { relaunchApp } from './relaunch'

function stubWindow(answer?: () => Promise<unknown>) {
  const reload = vi.fn()
  const invoke = vi.fn(answer)
  vi.stubGlobal('window', {
    location: { reload },
    ...(answer ? { docflow: { invoke } } : {}),
  })
  return { reload, invoke }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('relaunchApp', () => {
  test('asks main to relaunch when the bridge is there', async () => {
    const { reload, invoke } = stubWindow(() => Promise.resolve({}))
    await relaunchApp()
    expect(invoke).toHaveBeenCalledWith('app:relaunch', {})
    expect(reload).not.toHaveBeenCalled()
  })

  test('reloads the page without the bridge or when main does not answer', async () => {
    const { reload } = stubWindow()
    await relaunchApp()
    expect(reload).toHaveBeenCalledTimes(1)
    const failed = stubWindow(() => Promise.reject(new Error('no handler')))
    await relaunchApp()
    expect(failed.invoke).toHaveBeenCalledTimes(1)
    expect(failed.reload).toHaveBeenCalledTimes(1)
  })
})
