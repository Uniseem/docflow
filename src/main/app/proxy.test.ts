import { expect, test } from 'vitest'
import { toSessionProxy } from './proxy'

test('settings proxy maps to session.setProxy config', () => {
  expect(toSessionProxy({ mode: 'system' })).toEqual({ mode: 'system' })
  expect(toSessionProxy({ mode: 'direct' })).toEqual({ mode: 'direct' })
  expect(toSessionProxy({ mode: 'custom', url: 'http://127.0.0.1:7890/' })).toEqual({
    mode: 'fixed_servers',
    proxyRules: 'http://127.0.0.1:7890',
  })
  expect(toSessionProxy({ mode: 'custom', url: 'socks5h://127.0.0.1:1080' })).toEqual({
    mode: 'fixed_servers',
    proxyRules: 'socks5://127.0.0.1:1080',
  })
})
