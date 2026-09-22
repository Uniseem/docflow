export type DocflowApi = Record<string, never>

declare global {
  interface Window {
    docflow: DocflowApi
  }
}

export {}
