import type { DocflowApi } from '../shared/ipc'

declare global {
  interface Window {
    docflow: DocflowApi
  }
}

export type { DocflowApi }
