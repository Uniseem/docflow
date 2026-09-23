import { describe, expect, test } from 'vitest'
import {
  ProviderError,
  classifyHttpError,
  parseRetryAfter,
  redact,
  snippet,
  userFacingProviderError,
} from './errors'

describe('classifyHttpError', () => {
  test('status table', () => {
    expect(classifyHttpError({ status: 401, body: '' }).kind).toBe('credential')
    expect(classifyHttpError({ status: 403, body: 'rate limit exceeded' }).kind).toBe('rateLimited')
    // A bare 403 is a region block, proxy or model permission, not proof of a bad key.
    expect(classifyHttpError({ status: 403, body: 'forbidden' }).kind).toBe('fatal')
    expect(classifyHttpError({ status: 403, body: 'invalid api key' }).kind).toBe('credential')
    expect(classifyHttpError({ status: 404, body: '' }).kind).toBe('fatal')
    expect(classifyHttpError({ status: 429, body: '' }).kind).toBe('rateLimited')
    expect(classifyHttpError({ status: 429, body: 'insufficient balance' }).kind).toBe('credential')
    expect(classifyHttpError({ status: 413, body: '' }).kind).toBe('oversized')
    expect(classifyHttpError({ status: 503, body: '' }).kind).toBe('transient')
    expect(classifyHttpError({ status: 400, body: 'context length exceeded' }).kind).toBe(
      'oversized',
    )
    expect(classifyHttpError({ status: 400, body: 'content_filter' }).kind).toBe('refused')
    expect(classifyHttpError({ status: 400, body: 'invalid api key' }).kind).toBe('credential')
    expect(classifyHttpError({ status: 400, body: 'model not found' }).kind).toBe('fatal')
    expect(classifyHttpError({ status: 400, body: 'too many requests' }).kind).toBe('rateLimited')
    expect(classifyHttpError({ status: 400, body: 'nope' }).kind).toBe('rejected')
  })

  test('userFacingProviderError uses Chinese for credential and missing model', () => {
    const cred = classifyHttpError({ status: 401, body: 'unauthorized' })
    expect(userFacingProviderError(cred)).toContain('API Key')
    const missing = classifyHttpError({ status: 404, body: 'The model does not exist' })
    expect(userFacingProviderError(missing)).toContain('模型')
  })

  test('only credential errors blame the key; others keep the server reason and a next step', () => {
    const forbidden = userFacingProviderError(
      classifyHttpError({ status: 403, body: 'unsupported_country_region_territory' }),
    )
    expect(forbidden).not.toContain('API Key 无效')
    expect(forbidden).toContain('（HTTP 403）：unsupported_country_region_territory')
    expect(forbidden).toContain('代理')
    const missingRoute = userFacingProviderError(
      classifyHttpError({ status: 404, body: '404 page not found' }),
    )
    expect(missingRoute).toContain('（HTTP 404）：404 page not found')
    expect(missingRoute).toContain('服务地址')
    const busy = userFacingProviderError(classifyHttpError({ status: 503, body: 'overloaded' }))
    expect(busy).toBe('翻译服务返回错误（HTTP 503）：overloaded')
    const summary = new ProviderError('transient', '翻译请求多次重试后仍然失败：超时')
    expect(userFacingProviderError(summary)).toBe(summary.message)
    const broke = userFacingProviderError(classifyHttpError({ status: 402, body: '' }))
    expect(broke).toContain('余额')
  })

  test('rateLimited defaults Retry-After to 5s and caps at 300s', () => {
    expect(classifyHttpError({ status: 429, body: '' }).retryAfterMs).toBe(5_000)
    expect(classifyHttpError({ status: 429, body: '', retryAfter: '12' }).retryAfterMs).toBe(12_000)
    expect(classifyHttpError({ status: 429, body: '', retryAfter: '9999' }).retryAfterMs).toBe(
      300_000,
    )
  })
})

test('parseRetryAfter accepts HTTP dates', () => {
  const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')
  expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', now)).toBe(10_000)
})

test('redact and snippet', () => {
  expect(redact('using sk-secret here', ['sk-secret'])).toBe('using [redacted] here')
  expect(snippet('a'.repeat(401)).endsWith('…')).toBe(true)
  expect(snippet('short')).toBe('short')
})
