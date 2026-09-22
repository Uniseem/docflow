import { describe, expect, test } from 'vitest'
import { KEY_BENCH_MS } from '../../shared/constants'
import { ProviderError } from './errors'
import { FakeClock, KeyRing, mask, splitKeys } from './keys'

describe('splitKeys / mask', () => {
  test('splits mixed separators', () => {
    expect(splitKeys('a,b，c;d\ne f')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  test('masks according to length and count', () => {
    expect(mask('short')).toBe('••••••••')
    expect(mask('sk-abcdefghijk')).toBe('••••••••hijk')
    expect(mask('sk-abcdefghijk,other')).toBe('••••••••hijk（共 2 个）')
  })
})

describe('KeyRing', () => {
  test('round-robins usable keys', () => {
    const ring = new KeyRing('one,two,three')
    expect([ring.pick(), ring.pick(), ring.pick(), ring.pick()]).toEqual([
      'one',
      'two',
      'three',
      'one',
    ])
  })

  test('benches a credential key for 600s then restores', () => {
    const clock = new FakeClock()
    const ring = new KeyRing('good,bad', clock)
    expect(ring.pick()).toBe('good')
    expect(ring.noteCredential('bad', '401')).toBe('retry')
    expect(ring.usable()).toEqual(['good'])
    expect(ring.pick()).toBe('good')
    clock.advance(KEY_BENCH_MS - 1)
    expect(ring.usable()).toEqual(['good'])
    clock.advance(1)
    expect(ring.usable()).toEqual(['good', 'bad'])
  })

  test('all keys benched returns credential', () => {
    const clock = new FakeClock()
    const ring = new KeyRing('a,b', clock)
    expect(ring.noteCredential('a', 'first')).toBe('retry')
    expect(ring.noteCredential('b', 'second')).toBe('fail')
    expect(ring.pick()).toBeUndefined()
    expect(ring.allFailedMessage()).toBe('全部 2 个 API Key 都无法使用：second')
    expect(ring.allFailedError()).toBeInstanceOf(ProviderError)
    expect(ring.allFailedError().kind).toBe('credential')
  })

  test('a single key is not benched', () => {
    const ring = new KeyRing('only')
    expect(ring.noteCredential('only', '401')).toBe('fail')
    expect(ring.usable()).toEqual(['only'])
  })

  test('reset clears benches and order', () => {
    const ring = new KeyRing('a,b')
    ring.noteCredential('a', 'x')
    ring.reset('c,d')
    expect(ring.pick()).toBe('c')
    expect(ring.usable()).toEqual(['c', 'd'])
  })
})
