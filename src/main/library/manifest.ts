import { DocumentManifest, DocumentSummary, type ProcessingEvent } from '../../shared/types'
import { suggestedNames } from '../../shared/text'
import { writeJsonAtomic } from '../settings/atomic-write'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function documentDir(libraryDir: string, id: string): string {
  return join(libraryDir, 'documents', id)
}

export function manifestPath(libraryDir: string, id: string): string {
  return join(documentDir(libraryDir, id), 'manifest.json')
}

export function sourcePath(libraryDir: string, id: string): string {
  return join(documentDir(libraryDir, id), 'source.pdf')
}

export function eventsPath(libraryDir: string, id: string): string {
  return join(documentDir(libraryDir, id), 'events.jsonl')
}

export function workDir(libraryDir: string, id: string): string {
  return join(documentDir(libraryDir, id), 'work')
}

export function outputDir(libraryDir: string, id: string): string {
  return join(documentDir(libraryDir, id), 'output')
}

export function fileUrl(kind: 'source' | 'mono' | 'dual', id: string): string {
  const rel =
    kind === 'source' ? `documents/${id}/source.pdf` : `documents/${id}/output/${kind}.pdf`
  return `docflow://library/${rel}`
}

export function toSummary(
  manifest: DocumentManifest,
  options: {
    running: boolean
    hasMono: boolean
    hasDual: boolean
    hasSource: boolean
    hasGlossary?: boolean
  },
): DocumentSummary {
  const rest: Record<string, unknown> = { ...manifest }
  delete rest.settingsSnapshot
  return DocumentSummary.parse({
    ...rest,
    files: {
      ...(options.hasSource ? { source: fileUrl('source', manifest.id) } : {}),
      ...(options.hasMono ? { mono: fileUrl('mono', manifest.id) } : {}),
      ...(options.hasDual ? { dual: fileUrl('dual', manifest.id) } : {}),
      // Not served by docflow://: the renderer only uses it to know that it exists.
      ...(options.hasGlossary ? { glossary: 'glossary.csv' } : {}),
    },
    suggestedNames: suggestedNames(manifest.title, manifest.originalFilename),
    running: options.running,
  })
}

export async function readManifest(libraryDir: string, id: string): Promise<DocumentManifest> {
  const raw = JSON.parse(await readFile(manifestPath(libraryDir, id), 'utf8')) as unknown
  return DocumentManifest.parse(raw)
}

export async function writeManifest(
  libraryDir: string,
  manifest: DocumentManifest,
): Promise<DocumentManifest> {
  const parsed = DocumentManifest.parse(manifest)
  const path = manifestPath(libraryDir, parsed.id)
  await mkdir(dirname(path), { recursive: true })
  await writeJsonAtomic(path, parsed)
  return parsed
}

export function patchManifest(
  current: DocumentManifest,
  patch: Partial<DocumentManifest>,
  now: string,
): DocumentManifest {
  return DocumentManifest.parse({ ...current, ...patch, updatedAt: now })
}

export function isoNow(date = new Date()): string {
  return date.toISOString()
}

export function makeReceivedEvent(
  seq: number,
  at: string,
  size: number,
  sha: string,
): ProcessingEvent {
  return {
    seq,
    at,
    stage: 'received',
    level: 'info',
    progress: 2,
    message: '已复制源文件并加入处理队列',
    detail: `${size} 字节，SHA-256 ${sha.slice(0, 16)}`,
  }
}
