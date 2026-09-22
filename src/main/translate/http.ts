export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export function createFetch(fetchFn: FetchFn = fetch): FetchFn {
  return (input, init) => fetchFn(input, init)
}
