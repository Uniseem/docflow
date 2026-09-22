import { describe, expect, test } from 'vitest'
import { formatBytes, formatRelativeTime, sanitizeFilename, suggestedNames } from './text'

describe('sanitizeFilename', () => {
  test('replaces reserved characters and trims', () => {
    expect(sanitizeFilename(' a/b:c*?.pdf ')).toBe('a_b_c__.pdf')
    expect(sanitizeFilename('...')).toBe('文档')
    expect(sanitizeFilename('')).toBe('文档')
    expect(sanitizeFilename('a'.repeat(200)).length).toBe(120)
  })
})

describe('suggestedNames', () => {
  test('uses sanitized title', () => {
    expect(suggestedNames('My Paper', 'src.pdf')).toEqual({
      mono: 'My Paper-中文译文.pdf',
      dual: 'My Paper-双语对照.pdf',
      bundle: 'My Paper-完整文件.zip',
      source: 'src.pdf',
    })
  })
})

describe('formatBytes', () => {
  test('formats binary units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
  })
})

describe('formatRelativeTime', () => {
  const now = new Date('2026-09-22T16:00:00+08:00')

  test('covers the UI buckets', () => {
    expect(formatRelativeTime(new Date(now.getTime() - 10_000).toISOString(), now)).toBe('刚刚')
    expect(formatRelativeTime(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe(
      '5 分钟前',
    )
    expect(formatRelativeTime(new Date(now.getTime() - 3 * 3_600_000).toISOString(), now)).toBe(
      '3 小时前',
    )
    expect(formatRelativeTime(new Date('2026-09-21T10:00:00+08:00').toISOString(), now)).toBe(
      '昨天',
    )
    expect(formatRelativeTime(new Date('2026-03-05T10:00:00+08:00').toISOString(), now)).toBe(
      '3月5日',
    )
    expect(formatRelativeTime(new Date('2025-12-01T10:00:00+08:00').toISOString(), now)).toBe(
      '2025年12月1日',
    )
  })
})
