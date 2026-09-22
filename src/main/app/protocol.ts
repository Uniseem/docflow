import { extname, relative, resolve, sep } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export function relativeFromDocflowUrl(urlString: string): string | null {
  if (urlString.includes('..')) return null
  let url: URL
  try {
    url = new URL(urlString)
  } catch {
    return null
  }
  if (url.protocol !== 'docflow:') return null
  if (url.hostname !== 'library') return null
  const rel = decodeURIComponent(url.pathname.replace(/^\/+/, '')).replaceAll('\\', '/')
  if (!rel || rel.includes('\0') || rel.split('/').includes('..')) return null
  return rel
}

export function isInsideDir(root: string, candidate: string): boolean {
  const base = resolve(root)
  const target = resolve(candidate)
  const rel = relative(base, target)
  if (!rel || rel === '') return false
  if (rel.startsWith('..')) return false
  if (rel.split(sep).includes('..')) return false
  return true
}

export async function resolveLibraryPdf(
  libraryDir: string,
  urlString: string,
): Promise<string | null> {
  const rel = relativeFromDocflowUrl(urlString)
  if (!rel) return null
  if (extname(rel).toLowerCase() !== '.pdf') return null
  const root = resolve(libraryDir)
  const candidate = resolve(root, rel)
  if (!isInsideDir(root, candidate)) return null
  try {
    const realRoot = await realpath(root)
    const realFile = await realpath(candidate)
    if (!isInsideDir(realRoot, realFile)) return null
    const info = await stat(realFile)
    if (!info.isFile()) return null
    return realFile
  } catch {
    return null
  }
}

export async function handleDocflowRequest(
  libraryDir: string,
  requestUrl: string,
  fetchFile: (fileUrl: string) => Promise<Response>,
): Promise<Response> {
  const file = await resolveLibraryPdf(libraryDir, requestUrl)
  if (!file) return new Response('Not Found', { status: 404 })
  const response = await fetchFile(pathToFileURL(file).href)
  const headers = new Headers(response.headers)
  headers.set('Content-Type', 'application/pdf')
  headers.set('Cache-Control', 'no-store')
  return new Response(response.body, { status: response.status, headers })
}
