import { describe, expect, test } from 'vitest'
import { toDocflowError } from './errors'

describe('toDocflowError', () => {
  test('restores code and user from a plain IPC failure', () => {
    const error = toDocflowError({ code: 'not_found', message: '找不到这个文档。', user: true })
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('找不到这个文档。')
    expect(error.code).toBe('not_found')
    expect(error.user).toBe(true)
  })

  test('treats bare errors and unknown values as internal', () => {
    const bare = toDocflowError(new Error('invalid ipc response'))
    expect(bare.code).toBe('internal')
    expect(bare.user).toBe(false)
    const odd = toDocflowError('boom')
    expect(odd.message).toBe('boom')
    expect(odd.user).toBe(false)
  })

  test('keeps code and user already set on an Error', () => {
    const local = Object.assign(new Error('处理引擎未运行'), { code: 'internal', user: true })
    expect(toDocflowError(local).user).toBe(true)
  })
})
