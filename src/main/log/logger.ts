import { join } from 'node:path'
import log from 'electron-log/main'
import { SNIPPET_CHARS } from '../../shared/constants'
import { redact, snippet } from '../translate/errors'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export type Logger = {
  debug: (message: string) => void
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

export type LogSink = {
  transports: {
    file: { resolvePathFn?: () => string; maxSize: number; level: LogLevel | false; format: string }
    console: { level: LogLevel | false }
  }
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

const FILE_MAX = 8 * 1024 * 1024

let sink: LogSink = log as unknown as LogSink

export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (value === 'error' || value === 'warn' || value === 'info' || value === 'debug') return value
  return undefined
}

export function configureLogger(
  libraryDir: string,
  options: { sink?: LogSink; env?: NodeJS.Dict<string>; packaged?: boolean } = {},
): string {
  sink = options.sink ?? (log as unknown as LogSink)
  const filePath = join(libraryDir, 'logs', 'main.log')
  sink.transports.file.resolvePathFn = () => filePath
  sink.transports.file.maxSize = FILE_MAX
  sink.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
  const env = options.env ?? process.env
  const level = parseLogLevel(env.DOCFLOW_LOG_LEVEL) ?? (options.packaged ? 'info' : 'debug')
  sink.transports.file.level = level
  sink.transports.console.level = level
  return filePath
}

export function createLogger(scope: string): Logger {
  const write = (level: LogLevel, message: string) => {
    sink[level](formatLogMessage(scope, undefined, message))
  }
  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}

export function formatLogMessage(
  scope: string,
  docId: string | undefined,
  message: string,
): string {
  return docId ? `[${scope}] {${docId}} ${message}` : `[${scope}] ${message}`
}

export function safeLogText(text: string, keys: readonly string[] = []): string {
  return redact(snippet(text, SNIPPET_CHARS), keys)
}
