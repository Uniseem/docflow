import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { MAX_PDF_BYTES } from '../../shared/constants'
import { ERROR_CODES, UserError } from '../../shared/errors'
import { newDocumentId } from '../../shared/text'
import {
  DocumentManifest,
  type DocumentSummary,
  type TranslatorChoice,
  type TranslationRuntime,
} from '../../shared/types'
import { EventLog } from './events'
import { DocumentIndex, type ListFilter } from './index'
import {
  documentDir,
  isoNow,
  outputDir,
  readManifest,
  sourcePath,
  toSummary,
  writeManifest,
} from './manifest'

export type CreateDocumentInput = {
  path: string
  title?: string
  translator: TranslatorChoice & { label: string }
  settingsSnapshot: TranslationRuntime
  now?: Date
  randomHex?: string
}

export type ManifestPatch = Partial<DocumentManifest>

export class DocumentLibrary {
  events: EventLog
  readonly index = new DocumentIndex()
  private libraryDir = ''
  /** Per-document queue: each update merges onto the manifest the previous one wrote. */
  private readonly chains = new Map<string, Promise<unknown>>()
  /** Deleted in this session: late writes from an interrupted task must not revive them. */
  private readonly removed = new Set<string>()

  constructor() {
    this.events = new EventLog('')
  }

  get dir(): string {
    return this.libraryDir
  }

  async open(libraryDir: string): Promise<void> {
    this.libraryDir = libraryDir
    this.removed.clear()
    this.events = new EventLog(libraryDir)
    await mkdir(join(libraryDir, 'documents'), { recursive: true })
    const items: DocumentManifest[] = []
    let names: string[]
    try {
      names = await readdir(join(libraryDir, 'documents'))
    } catch {
      names = []
    }
    for (const id of names) {
      try {
        items.push(await readManifest(libraryDir, id))
      } catch {
        continue
      }
    }
    this.index.load(items)
  }

  summary(manifest: DocumentManifest, running: boolean): DocumentSummary {
    return toSummary(manifest, {
      running,
      hasSource: true,
      hasMono: Boolean(manifest.outputs.mono),
      hasDual: Boolean(manifest.outputs.dual),
    })
  }

  list(filter: ListFilter, query: string | undefined, running: ReadonlySet<string>) {
    const items = this.index
      .list(filter, query)
      .map((item) => this.summary(item, running.has(item.id)))
    return { items, counts: this.index.counts(query) }
  }

  get(id: string, running: boolean): DocumentSummary {
    const manifest = this.require(id)
    return this.summary(manifest, running)
  }

  require(id: string): DocumentManifest {
    const manifest = this.index.get(id)
    if (!manifest) throw new UserError(ERROR_CODES.not_found)
    return manifest
  }

  async create(input: CreateDocumentInput): Promise<DocumentSummary> {
    const info = await stat(input.path).catch(() => {
      throw new UserError(ERROR_CODES.pdf_open, '无法读取这个文件。')
    })
    if (!info.isFile()) throw new UserError(ERROR_CODES.pdf_invalid, '请选择 PDF 文件。')
    if (info.size > MAX_PDF_BYTES) {
      throw new UserError(ERROR_CODES.pdf_invalid, '文件太大，请选择小于 500 MB 的 PDF。')
    }
    if (extname(input.path).toLowerCase() !== '.pdf') {
      throw new UserError(ERROR_CODES.pdf_invalid, '请选择 PDF 文件。')
    }
    const now = input.now ?? new Date()
    const id = newDocumentId(now, input.randomHex)
    const originalFilename = basename(input.path)
    const title = (input.title?.trim() || originalFilename.replace(/\.pdf$/i, '') || '文档').slice(
      0,
      300,
    )
    const sha = await sha256File(input.path)
    const dir = documentDir(this.libraryDir, id)
    await mkdir(join(dir, 'work'), { recursive: true })
    await mkdir(join(dir, 'output'), { recursive: true })
    await copyFile(input.path, sourcePath(this.libraryDir, id))
    const at = isoNow(now)
    const manifest = await writeManifest(
      this.libraryDir,
      DocumentManifest.parse({
        version: 1,
        id,
        title,
        titleCustom: Boolean(input.title?.trim()),
        originalFilename,
        sourceSize: info.size,
        sourceSha256: sha,
        pages: null,
        translator: input.translator,
        settingsSnapshot: input.settingsSnapshot,
        status: 'queued',
        stage: 'received',
        progress: 2,
        failure: null,
        attempts: 0,
        nextAttemptAt: null,
        stats: null,
        outputs: { mono: null, dual: null },
        createdAt: at,
        updatedAt: at,
        startedAt: null,
        completedAt: null,
      }),
    )
    this.index.set(manifest)
    await this.events.append(id, {
      stage: 'received',
      level: 'info',
      progress: 2,
      message: '已复制源文件并加入处理队列',
      detail: `${info.size} 字节，SHA-256 ${sha.slice(0, 16)}`,
      at,
    })
    return this.summary(manifest, false)
  }

  async update(
    id: string,
    patch: ManifestPatch | ((current: DocumentManifest) => ManifestPatch),
  ): Promise<DocumentManifest> {
    const next = await this.updateWhen(id, () => true, patch)
    if (!next) throw new UserError(ERROR_CODES.not_found)
    return next
  }

  /**
   * Applies `patch` only if `when(current)` still holds once the update's turn comes, so a
   * status change can't be overwritten by a write that was decided on stale state.
   * Resolves `undefined` when the condition fails.
   */
  updateWhen(
    id: string,
    when: (current: DocumentManifest) => boolean,
    patch: ManifestPatch | ((current: DocumentManifest) => ManifestPatch),
  ): Promise<DocumentManifest | undefined> {
    return this.serialize(id, async () => {
      const current = this.require(id)
      if (!when(current)) return undefined
      const gone = () => this.removed.has(id) || !this.index.get(id)
      let next: DocumentManifest
      try {
        next = await writeManifest(this.libraryDir, {
          ...current,
          ...(typeof patch === 'function' ? patch(current) : patch),
          id,
          updatedAt: isoNow(),
        })
      } catch (error) {
        // The folder vanished under the write because the document was deleted.
        if (gone()) throw new UserError(ERROR_CODES.not_found)
        throw error
      }
      if (gone()) {
        // Deleted while the write was in flight: don't leave a manifest behind.
        await rm(documentDir(this.libraryDir, id), RM_OPTIONS).catch(() => undefined)
        throw new UserError(ERROR_CODES.not_found)
      }
      this.index.set(next)
      return next
    })
  }

  private serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(id) ?? Promise.resolve()).then(fn, fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.chains.set(id, tail)
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id)
    })
    return run
  }

  async rename(id: string, title: string): Promise<DocumentSummary> {
    const trimmed = title.trim()
    if (!trimmed) throw new UserError(ERROR_CODES.not_found, '标题不能为空。')
    const next = await this.update(id, { title: trimmed.slice(0, 300), titleCustom: true })
    return this.summary(next, false)
  }

  async remove(id: string): Promise<void> {
    const manifest = this.require(id)
    // Out of the index first so the scheduler and late pipeline writes see not_found.
    this.index.delete(id)
    this.removed.add(id)
    try {
      await rm(documentDir(this.libraryDir, id), RM_OPTIONS)
    } catch (error) {
      this.removed.delete(id)
      this.index.set(manifest)
      throw error
    }
  }

  pathFor(id: string, kind: 'source' | 'mono' | 'dual' | 'folder'): string {
    this.require(id)
    if (kind === 'folder') return documentDir(this.libraryDir, id)
    if (kind === 'source') return sourcePath(this.libraryDir, id)
    return join(outputDir(this.libraryDir, id), `${kind}.pdf`)
  }
}

// Windows: a PDF viewer or antivirus may hold a file open for a moment (EBUSY/EPERM).
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as const

async function sha256File(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
