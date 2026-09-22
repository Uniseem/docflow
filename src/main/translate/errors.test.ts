import { describe, expect, test } from 'vitest'
import { classifyHttpError, parseRetryAfter, redact, snippet } from './errors'

describe('classifyHttpError', () => {
  test('status table', () => {
    expect(classifyHttpError({ status: 401, body: '' }).kind).toBe('credential')
    expect(classifyHttpError({ status: 403, body: 'rate limit exceeded' }).kind).toBe('rateLimited')
    expect(classifyHttpError({ status: 403, body: 'forbidden' }).kind).toBe('credential')
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
