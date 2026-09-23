import type { IpcFailure } from '../../shared/ipc'

export type DocflowError = Error & { code: string; user: boolean }

/** Normalizes a rejection from `window.docflow.invoke` (a plain IpcFailure) into an Error. */
export function toDocflowError(raw: unknown): DocflowError {
  if (raw instanceof Error) {
    const known = raw as Error & Partial<IpcFailure>
    return Object.assign(raw, {
      code: typeof known.code === 'string' ? known.code : 'internal',
      user: known.user === true,
    })
  }
  if (raw && typeof raw === 'object' && 'message' in raw) {
    const failure = raw as Partial<IpcFailure>
    return Object.assign(new Error(String(failure.message)), {
      code: typeof failure.code === 'string' ? failure.code : 'internal',
      user: failure.user === true,
    })
  }
  return Object.assign(new Error(String(raw)), { code: 'internal', user: false })
}
