import { FILENAME_STEM_MAX } from './constants'

export function sanitizeFilename(input: string): string {
  let replaced = ''
  for (const char of input) {
    const code = char.charCodeAt(0)
    replaced += code < 32 || '\\/:*?"<>|'.includes(char) ? '_' : char
  }
  const cleaned = replaced.replace(/^[\s.]+|[\s.]+$/g, '')
  if (!cleaned) return '文档'
  return cleaned.length > FILENAME_STEM_MAX ? cleaned.slice(0, FILENAME_STEM_MAX) : cleaned
}

export function suggestedNames(
  title: string,
  originalFilename: string,
): { mono: string; dual: string; bundle: string; source: string } {
  const stem = sanitizeFilename(title)
  return {
    mono: `${stem}-中文译文.pdf`,
    dual: `${stem}-双语对照.pdf`,
    bundle: `${stem}-完整文件.zip`,
    source: originalFilename,
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 10 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}

export function formatRelativeTime(iso: string, now = new Date()): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return iso
  const deltaMs = now.getTime() - then.getTime()
  if (deltaMs < 60_000) return '刚刚'
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)} 分钟前`
  if (isYesterday(then, now)) return '昨天'
  if (isSameDay(then, now)) return `${Math.max(1, Math.floor(deltaMs / 3_600_000))} 小时前`
  if (then.getFullYear() === now.getFullYear()) {
    return `${then.getMonth() + 1}月${then.getDate()}日`
  }
  return `${then.getFullYear()}年${then.getMonth() + 1}月${then.getDate()}日`
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function isYesterday(then: Date, now: Date): boolean {
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  return isSameDay(then, y)
}

export function splitKeys(raw: string): string[] {
  return raw
    .split(/[,，\s;]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

export function maskKey(raw: string): string {
  const keys = splitKeys(raw)
  if (keys.length === 0) return ''
  const first = keys[0] ?? ''
  const masked = first.length >= 12 ? `••••••••${first.slice(-4)}` : '••••••••'
  return keys.length > 1 ? `${masked}（共 ${keys.length} 个）` : masked
}

export function newDocumentId(at = new Date(), randomHex?: string): string {
  const y = at.getUTCFullYear().toString().padStart(4, '0')
  const mo = (at.getUTCMonth() + 1).toString().padStart(2, '0')
  const d = at.getUTCDate().toString().padStart(2, '0')
  const hh = at.getUTCHours().toString().padStart(2, '0')
  const mm = at.getUTCMinutes().toString().padStart(2, '0')
  const ss = at.getUTCSeconds().toString().padStart(2, '0')
  const rand = (randomHex ?? Math.random().toString(16).slice(2, 8)).padEnd(6, '0').slice(0, 6)
  return `${y}${mo}${d}T${hh}${mm}${ss}-${rand}`
}
