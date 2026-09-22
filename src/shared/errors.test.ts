import { expect, test } from 'vitest'
import {
  CancelledError,
  ERROR_CODES,
  PermanentError,
  UserError,
  isPermanentCode,
  isUserError,
} from './errors'

test('permanent codes and user-facing messages', () => {
  expect(isPermanentCode(ERROR_CODES.pdf_encrypted)).toBe(true)
  expect(isPermanentCode(ERROR_CODES.analyze_timeout)).toBe(false)
  const encrypted = new PermanentError(ERROR_CODES.pdf_encrypted)
  expect(encrypted.permanent).toBe(true)
  expect(encrypted.message).toContain('已加密')
  expect(isUserError(encrypted)).toBe(true)
  const timeout = new UserError(ERROR_CODES.analyze_timeout)
  expect(timeout.permanent).toBe(false)
  expect(new CancelledError().code).toBe('cancelled')
})
