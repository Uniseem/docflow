import { describe, expect, test } from 'vitest'
import {
  formatBytes,
  formatRelativeTime,
  maskKey,
  sanitizeFilename,
  splitKeys,
  suggestedNames,
} from './text'

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
      glossary: 'My Paper-术语表.csv',
    })
  })
})

describe('formatBytes', () => {
  test('uses whole KB below 1 MB', () => {
    expect(formatBytes(0)).toBe('0 KB')
    expect(formatBytes(1)).toBe('1 KB')
    expect(formatBytes(512)).toBe('1 KB')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('2 KB')
    expect(formatBytes(900 * 1024)).toBe('900 KB')
    expect(formatBytes(1023 * 1024)).toBe('1023 KB')
  })

  test('uses MB with one decimal and GB with two', () => {
    expect(formatBytes(1024 * 1024 - 100)).toBe('1.0 MB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(2.46 * 1024 * 1024)).toBe('2.5 MB')
    expect(formatBytes(500 * 1024 * 1024)).toBe('500.0 MB')
    expect(formatBytes(1024 * 1024 * 1024 - 1000)).toBe('1.00 GB')
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.50 GB')
  })

  test('treats invalid sizes as zero', () => {
    expect(formatBytes(-1)).toBe('0 KB')
    expect(formatBytes(Number.NaN)).toBe('0 KB')
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

describe('splitKeys / maskKey', () => {
  test('splits English/Chinese commas, semicolons and whitespace', () => {
    expect(splitKeys('a,b，c; d\ne')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  test('masks long and short keys, and counts multiples', () => {
    expect(maskKey('short')).toBe('••••••••')
    expect(maskKey('sk-abcdefghijk')).toBe('••••••••hijk')
    expect(maskKey('sk-abcdefghijk,other')).toBe('••••••••hijk（共 2 个）')
  })
})
