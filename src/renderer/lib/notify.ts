import { toast } from '@heroui/react'
import type { ReactNode } from 'react'
import { toDocflowError } from '../api/errors'

type ToastOptions = NonNullable<Parameters<typeof toast.success>[1]>

/** 06 §6.6: toasts stay for 6 s unless a caller asks otherwise. */
export const TOAST_TIMEOUT_MS = 6_000

function withDefaults(options?: ToastOptions): ToastOptions {
  return { timeout: TOAST_TIMEOUT_MS, ...options }
}

export const notify = {
  success: (message: ReactNode, options?: ToastOptions) =>
    toast.success(message, withDefaults(options)),
  info: (message: ReactNode, options?: ToastOptions) => toast.info(message, withDefaults(options)),
  warning: (message: ReactNode, options?: ToastOptions) =>
    toast.warning(message, withDefaults(options)),
  danger: (message: ReactNode, options?: ToastOptions) =>
    toast.danger(message, withDefaults(options)),
}

/**
 * Shows a rejected invoke() to the user. Internal errors were already toasted by invoke()
 * itself, so only user-facing ones are shown here; `prefix` goes before the message.
 */
export function notifyError(error: unknown, prefix = ''): void {
  const err = toDocflowError(error)
  if (!err.user) {
    console.error(error)
    return
  }
  notify.danger(`${prefix}${err.message}`)
}
