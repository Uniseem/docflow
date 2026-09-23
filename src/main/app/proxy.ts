import type { ProxyConfig } from '../../shared/types'

export type SessionProxyConfig =
  { mode: 'system' } | { mode: 'direct' } | { mode: 'fixed_servers'; proxyRules: string }

/**
 * Settings proxy → `session.setProxy()` config. Chromium wants `scheme://host:port` only
 * (no path, no credentials), and its SOCKS5 already resolves names on the proxy, so
 * `socks5h` maps to `socks5`. Loopback addresses are never proxied by Chromium.
 */
export function toSessionProxy(proxy: ProxyConfig): SessionProxyConfig {
  if (proxy.mode === 'system') return { mode: 'system' }
  if (proxy.mode === 'direct') return { mode: 'direct' }
  const url = new URL(proxy.url)
  const scheme = url.protocol.replace(/:$/, '').toLowerCase()
  return {
    mode: 'fixed_servers',
    proxyRules: `${scheme === 'socks5h' ? 'socks5' : scheme}://${url.host}`,
  }
}
