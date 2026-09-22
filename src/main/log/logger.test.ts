import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  configureLogger,
  createLogger,
  formatLogMessage,
  parseLogLevel,
  safeLogText,
  type LogSink,
} from './logger'

function fakeSink(): LogSink & { lines: string[] } {
  const lines: string[] = []
  const push =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push(`${level} ${args.join(' ')}`)
    }
  return {
    lines,
    transports: {
      file: { maxSize: 0, level: 'info', format: '' },
      console: { level: 'info' },
    },
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  }
}

describe('logger', () => {
  test('parses level and defaults by packaged flag', () => {
    expect(parseLogLevel('debug')).toBe('debug')
    expect(parseLogLevel('verbose')).toBeUndefined()
    const sink = fakeSink()
    const path = configureLogger('/tmp/lib', { sink, env: {}, packaged: true })
    expect(path).toBe(join('/tmp/lib', 'logs', 'main.log'))
    expect(sink.transports.file.level).toBe('info')
    expect(sink.transports.file.maxSize).toBe(8 * 1024 * 1024)
    configureLogger('/tmp/lib', { sink, env: { DOCFLOW_LOG_LEVEL: 'warn' }, packaged: true })
    expect(sink.transports.file.level).toBe('warn')
  })

  test('scopes messages and redacts keys', () => {
    const sink = fakeSink()
    configureLogger('/tmp/lib', { sink, env: { DOCFLOW_LOG_LEVEL: 'debug' } })
    const logger = createLogger('pipeline')
    logger.info('inspect ok pages=12')
    expect(sink.lines.at(-1)).toBe('info [pipeline] inspect ok pages=12')
    expect(formatLogMessage('pipeline', 'doc1', 'inspect ok')).toBe('[pipeline] {doc1} inspect ok')
    expect(safeLogText('key sk-abcdefghijk in body', ['sk-abcdefghijk'])).toContain('[redacted]')
    expect(safeLogText('x'.repeat(500)).endsWith('…')).toBe(true)
  })
})
