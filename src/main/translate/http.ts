import { fakeFetch } from './fake'

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export function createFetch(fetchFn?: FetchFn): FetchFn {
  if (fetchFn) return fetchFn
  if (process.env.DOCFLOW_FAKE_PROVIDERS === '1') return fakeFetch
  return fetch
}
