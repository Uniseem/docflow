import {
  app,
  type BrowserWindow,
  dialog,
  type MessageBoxOptions,
  nativeTheme,
  net,
  Notification,
  protocol,
  safeStorage,
  session as electronSession,
  shell,
} from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOCUMENT_CHANGED_THROTTLE_MS } from '../../shared/constants'
import { ERROR_CODES, UserError, isUserError } from '../../shared/errors'
import type { PushChannelName } from '../../shared/ipc'
import type { DocumentManifest } from '../../shared/types'
import type { DialogHost } from './dialogs'
import { handleDocflowRequest } from './protocol'
import { dockBadge, notifyIfBackground, overallProgress, windowFocused } from './notifications'
import { toSessionProxy } from './proxy'
import { DocumentLibrary } from '../library/library'
import { Scheduler } from '../jobs/scheduler'
import { configureLogger, createLogger } from '../log/logger'
import { PdfWorkerHost } from '../pdf/worker-host'
import { createPipelineHooks } from '../pipeline/hooks'
import { runPipeline } from '../pipeline/run'
import { writeFileAtomic } from '../settings/atomic-write'
import { HostStore } from '../settings/host'
import { SettingsStore } from '../settings/settings'
import { SecretsStore, type Cryptor } from '../settings/secrets'
import { toSettingsView } from '../settings/view'
import { createFetch } from '../translate/http'
import { TranslationPools } from '../translate/pool'
import { fakeProvider } from '../translate/fake'
import { createIpcHandlers, registerIpc, type IpcHandlers } from '../ipc/register'
import type { HandlerContext } from '../ipc/handlers'

const appDir = fileURLToPath(new URL('.', import.meta.url))

export function workerPath(kind: 'analyze' | 'compose'): string {
  return join(appDir, `workers/${kind}.mjs`)
}

export function electronCryptor(): Cryptor {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => new Uint8Array(safeStorage.encryptString(plain)),
    decryptString: (data) => safeStorage.decryptString(Buffer.from(data)),
  }
}

export function pdfPathsFromArgv(argv: string[]): string[] {
  return argv.filter((item) => item.toLowerCase().endsWith('.pdf') && !item.startsWith('-'))
}

/** A library whose folder, settings, keys and index all loaded; not yet in use. */
type OpenedLibrary = {
  dir: string
  library: DocumentLibrary
  settings: SettingsStore
  secrets: SecretsStore
}

/** Why a folder can't hold a library, for the user (the error itself goes to the log). */
export function libraryUnavailableMessage(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
  const reason =
    code === 'EACCES' || code === 'EPERM'
      ? '没有读写这个文件夹的权限'
      : code === 'EROFS'
        ? '这个位置是只读的'
        : code === 'ENOSPC'
          ? '磁盘空间不足'
          : code === 'ENOENT' || code === 'ENOTDIR'
            ? '文件夹不存在或所在的磁盘已断开'
            : '无法读写这个文件夹'
  return `无法使用这个文件夹作为文档库：${reason}。请选择其他位置。`
}

export class AppSession {
  readonly host: HostStore
  library = new DocumentLibrary()
  settings: SettingsStore
  secrets: SecretsStore
  scheduler: Scheduler
  pools: TranslationPools
  analyzeWorker: PdfWorkerHost
  composeWorker: PdfWorkerHost
  logsDir = ''
  logger = createLogger('app')
  handlers!: IpcHandlers
  /** Files written by documents:export in this app session (for shell:revealExport). */
  readonly exportedPaths = new Set<string>()
  private changedTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private lastStatus = new Map<string, DocumentManifest['status']>()
  private pendingFiles: string[] = []
  private rendererReady = false
  private appliedProxy = ''
  private bootNotice: string | null = null

  constructor(
    private readonly userDataDir: string,
    readonly env: NodeJS.Dict<string> = process.env,
  ) {
    this.host = new HostStore(userDataDir, {
      env,
      fallbackLibraryDir: userDataDir,
    })
    this.settings = new SettingsStore(userDataDir)
    this.secrets = new SecretsStore(userDataDir, electronCryptor())
    this.pools = new TranslationPools(
      createFetch((input, init) => net.fetch(input, init)),
      (id) => this.secrets.get(id),
      undefined,
      app.getVersion(),
    )
    this.analyzeWorker = new PdfWorkerHost(workerPath('analyze'), 'analyze')
    this.composeWorker = new PdfWorkerHost(workerPath('compose'), 'compose')
    this.scheduler = this.makeScheduler(this.library, this.settings)
  }

  getWindow: () => BrowserWindow | null = () => null

  /** Shows and focuses the main window; index.ts replaces it to reopen a closed one. */
  showWindow: () => void = () => {
    const window = this.getWindow()
    window?.show()
    window?.focus()
  }

  /**
   * Opens the configured library. When it can't be opened (unplugged drive, no permission,
   * unreadable files) falls back to the default library and tells the user once the window
   * is up; host.json keeps the configured folder for the next launch.
   */
  async boot(): Promise<void> {
    await this.host.load()
    if (this.host.snapshot.theme) nativeTheme.themeSource = this.host.snapshot.theme
    const configured = this.host.libraryDir()
    let opened: OpenedLibrary
    try {
      opened = await this.prepareLibrary(configured)
    } catch (error) {
      const fallback = this.host.defaultLibraryDir()
      if (fallback === configured) throw error
      opened = await this.prepareLibrary(fallback)
      const reason = error instanceof Error ? error.message : String(error)
      this.bootNotice = `${reason}\n\n文档库位置：${configured}\n本次已改用默认文档库：${fallback}`
    }
    this.activateLibrary(opened)
    if (this.bootNotice) this.logger.warn(`library fallback: ${this.bootNotice}`)
    await this.applyProxy()
    protocol.handle('docflow', async (request) => {
      return handleDocflowRequest(this.library.dir, request.url, (fileUrl) => net.fetch(fileUrl))
    })
    this.handlers = createIpcHandlers(this.handlerContext())
    registerIpc(this.handlers, this.logger)
    await this.scheduler.start()
  }

  /** Shows the library fallback notice from boot(), once, over `window`. */
  async showBootNotice(window: BrowserWindow): Promise<void> {
    const notice = this.bootNotice
    if (!notice) return
    this.bootNotice = null
    await dialog.showMessageBox(window, {
      type: 'warning',
      message: '无法打开文档库',
      detail: `${notice}\n\n可以在 设置 → 通用 → 文档库 中重新选择。`,
      buttons: ['好'],
    })
  }

  async dispose(): Promise<void> {
    await this.scheduler.stop()
    this.analyzeWorker.kill()
    this.composeWorker.kill()
    for (const timer of this.changedTimers.values()) clearTimeout(timer)
    this.changedTimers.clear()
  }

  send<K extends PushChannelName>(channel: K, payload: unknown): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(channel, payload)
  }

  /**
   * PDFs from the command line, open-file or a second instance. Until the renderer has
   * taken the queue (app:takePendingFiles, right after it subscribes) they wait here, so
   * a cold start or a reload doesn't lose them.
   */
  queueOpenFiles(paths: string[]): void {
    if (paths.length === 0) return
    if (this.rendererReady && this.getWindow()) {
      this.send('app:openFiles', { paths })
      return
    }
    for (const path of paths) {
      if (!this.pendingFiles.includes(path)) this.pendingFiles.push(path)
    }
  }

  takePendingFiles(): string[] {
    this.rendererReady = true
    return this.pendingFiles.splice(0)
  }

  /** The page is reloading or the window closed: queue files until it asks again. */
  rendererGone(): void {
    this.rendererReady = false
  }

  /**
   * Builds a library in fresh objects without touching the one in use: creates the folder,
   * checks it is writable and loads settings, keys and the document index.
   */
  private async prepareLibrary(dir: string): Promise<OpenedLibrary> {
    try {
      await mkdir(dir, { recursive: true })
      const probe = join(dir, `.docflow-write-test-${randomBytes(4).toString('hex')}`)
      await writeFileAtomic(probe, 'ok')
      await unlink(probe)
      const settings: SettingsStore = new SettingsStore(dir, {
        onChange: (next) => {
          // Changes made while preparing (fake provider) belong to a library not in use yet.
          if (this.settings !== settings) return
          this.pools.configure(next.providers)
          this.send('settings:changed', toSettingsView(next, this.secrets, this.env))
          void this.applyProxy()
        },
        onWarning: (message) => this.logger.warn(message),
      })
      const secrets = new SecretsStore(dir, electronCryptor(), (message) =>
        this.logger.warn(message),
      )
      await settings.load()
      await secrets.load()
      if (this.env.DOCFLOW_FAKE_PROVIDERS === '1') {
        const hasFake = settings.snapshot.providers.some((item) => item.id === 'fake')
        if (!hasFake) {
          await settings.replaceProviders([...settings.snapshot.providers, fakeProvider()])
        }
      }
      const library = new DocumentLibrary()
      await library.open(dir)
      return { dir, library, settings, secrets }
    } catch (error) {
      if (isUserError(error)) throw error
      this.logger.warn(`library ${dir} unavailable: ${describeError(error)}`)
      throw new UserError(ERROR_CODES.internal, libraryUnavailableMessage(error), true)
    }
  }

  /** Switches every consumer to `opened`. The previous scheduler must already be stopped. */
  private activateLibrary(opened: OpenedLibrary): void {
    this.logsDir = dirname(configureLogger(opened.dir, { env: this.env, packaged: app.isPackaged }))
    this.logger = createLogger('app')
    this.library = opened.library
    this.settings = opened.settings
    this.secrets = opened.secrets
    this.library.events.onAppend = (id, event) => {
      this.send('document:event', { ...event, documentId: id })
    }
    this.lastStatus.clear()
    // Keys and concurrency come from the new library's secrets and settings.
    this.pools.invalidate()
    this.pools.configure(this.settings.snapshot.providers)
    this.scheduler = this.makeScheduler(this.library, this.settings)
  }

  /** Applies the proxy setting to net.fetch (session.defaultSession) when it changed. */
  private async applyProxy(): Promise<void> {
    const proxy = this.settings.snapshot.proxy
    const key = JSON.stringify(proxy)
    if (key === this.appliedProxy) return
    this.appliedProxy = key
    try {
      await electronSession.defaultSession.setProxy(toSessionProxy(proxy))
      // Pooled connections keep using the old route otherwise.
      await electronSession.defaultSession.closeAllConnections()
      this.logger.info(`proxy mode ${proxy.mode}`)
    } catch (error) {
      this.appliedProxy = ''
      this.logger.error(`setProxy failed: ${describeError(error)}`)
    }
  }

  private makeScheduler(library: DocumentLibrary, settings: SettingsStore): Scheduler {
    const hooks = createPipelineHooks({
      library,
      settings,
      pools: this.pools,
      analyze: this.analyzeWorker,
      compose: this.composeWorker,
      env: this.env,
      fontsDir: app.isPackaged
        ? join(process.resourcesPath, 'fonts')
        : join(app.getAppPath(), 'resources/fonts'),
      modelsDir: app.isPackaged
        ? join(process.resourcesPath, 'models')
        : join(app.getAppPath(), 'resources/models'),
      onChanged: (manifest) => this.onManifestChanged(manifest),
    })
    return new Scheduler(library, (id, signal) => runPipeline(library, id, signal, hooks), {
      concurrency: () => settings.snapshot.workerConcurrency,
      onChanged: (manifest) => this.onManifestChanged(manifest),
      onEvent: async (id, event) => {
        const current = library.index.get(id)
        if (!current) return
        await library.events.append(id, { stage: current.stage, ...event })
      },
      onInternalError: (id, error) => {
        this.logger.error(`{${id}} ${describeError(error)}`)
      },
    })
  }

  private onManifestChanged(manifest: DocumentManifest): void {
    if (this.library.index.get(manifest.id) === undefined) return
    const previous = this.lastStatus.get(manifest.id)
    this.lastStatus.set(manifest.id, manifest.status)
    this.queueChanged(manifest.id)
    if (previous && previous !== manifest.status) {
      const note = notifyIfBackground({
        enabled: this.settings.snapshot.notifications,
        focused: windowFocused(this.getWindow()),
        status: manifest.status,
        title: manifest.title,
      })
      if (note && Notification.isSupported() && this.env.DOCFLOW_HIDE_WINDOW !== '1') {
        const notification = new Notification({ title: note.title, body: note.body })
        notification.on('click', () => this.showWindow())
        notification.show()
      }
    }
  }

  /** At most one document:changed per document per 200 ms, carrying the latest state. */
  private queueChanged(id: string): void {
    if (this.changedTimers.has(id)) return
    this.changedTimers.set(
      id,
      setTimeout(() => {
        this.changedTimers.delete(id)
        this.updateBadge()
        try {
          this.send('document:changed', this.library.get(id, this.scheduler.isRunning(id)))
        } catch {
          /* deleted */
        }
      }, DOCUMENT_CHANGED_THROTTLE_MS),
    )
  }

  private updateBadge(): void {
    const active = this.library.index.list('active')
    const window = this.getWindow()
    app.dock?.setBadge(dockBadge(active.length))
    if (window && !window.isDestroyed()) {
      window.setProgressBar(overallProgress(active.map((item) => item.progress)))
    }
  }

  private dialogHost(): DialogHost {
    return {
      showOpenDialog: async (options) => {
        const window = this.getWindow()
        const result = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options)
        return { canceled: result.canceled, filePaths: result.filePaths }
      },
      showSaveDialog: async (options) => {
        const window = this.getWindow()
        const result = window
          ? await dialog.showSaveDialog(window, options)
          : await dialog.showSaveDialog(options)
        return { canceled: result.canceled, filePath: result.filePath }
      },
    }
  }

  /**
   * Opens `path` as the library. Everything is loaded in new objects first; only when that
   * worked is the running library stopped, swapped and host.json updated. On failure the
   * current library keeps running and the user gets the reason.
   */
  async changeLibrary(path: string): Promise<string> {
    const opened = await this.prepareLibrary(path)
    await this.scheduler.stop()
    this.analyzeWorker.kill()
    this.composeWorker.kill()
    this.activateLibrary(opened)
    await this.applyProxy()
    await this.host.update({ libraryDir: path }).catch((error: unknown) => {
      this.logger.warn(`host.json not saved: ${describeError(error)}`)
    })
    this.handlers = createIpcHandlers(this.handlerContext())
    registerIpc(this.handlers, this.logger)
    await this.scheduler.start()
    this.send('library:changed', { libraryDir: this.library.dir })
    this.send('settings:changed', toSettingsView(this.settings.snapshot, this.secrets, this.env))
    return this.library.dir
  }

  private handlerContext(): HandlerContext {
    // One handler set serves one library: changeLibrary() swaps this.library before it
    // re-registers the handlers, and app:info must not report the new directory while the
    // other channels still read the old library.
    const library = this.library
    return {
      library,
      scheduler: this.scheduler,
      settings: this.settings,
      secrets: this.secrets,
      pools: this.pools,
      dialog: this.dialogHost(),
      fetch: createFetch((input, init) => net.fetch(input, init)),
      env: this.env,
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      logsDir: this.logsDir,
      getLibraryDir: () => library.dir,
      getTheme: () => this.host.snapshot.theme ?? 'system',
      setTheme: async (theme) => {
        nativeTheme.themeSource = theme
        await this.host.update({ theme })
      },
      checkUpdates: () => this.checkUpdates(),
      changeLibrary: (path) => this.changeLibrary(path),
      reveal: (path) => shell.showItemInFolder(path),
      openPath: async (path) => {
        const failure = await shell.openPath(path)
        if (failure) {
          throw new UserError(ERROR_CODES.internal, `无法打开文件：${failure}`, true)
        }
      },
      openExternal: (url) => shell.openExternal(url),
      sendChanged: (item) => this.send('document:changed', item),
      sendRemoved: (id) => this.send('document:removed', { id }),
      relaunch: () => {
        app.relaunch()
        app.quit()
      },
      exportedPaths: this.exportedPaths,
      takePendingFiles: () => this.takePendingFiles(),
    }
  }

  async checkUpdates(): Promise<
    { latest: string; url: string; newer: boolean } | { error: string }
  > {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await net.fetch(
        'https://api.github.com/repos/Uniseem/docflow/releases/latest',
        {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DocFlow' },
          signal: controller.signal,
        },
      )
      if (!response.ok) return { error: `GitHub 返回 ${response.status}` }
      const json = (await response.json()) as { tag_name?: string; html_url?: string }
      const latest = json.tag_name ?? ''
      const url = json.html_url ?? 'https://github.com/Uniseem/docflow/releases'
      return { latest, url, newer: isNewerVersion(latest, app.getVersion()) }
    } catch {
      return { error: '无法检查更新，请稍后重试。' }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Menu 「检查更新…」: runs the check and reports the result in a native dialog. */
  async checkUpdatesInteractive(): Promise<void> {
    const result = await this.checkUpdates()
    const window = this.getWindow()
    const show = (options: MessageBoxOptions) =>
      window && !window.isDestroyed()
        ? dialog.showMessageBox(window, options)
        : dialog.showMessageBox(options)
    const current = `当前版本 ${app.getVersion()}。`
    if ('error' in result) {
      await show({
        type: 'warning',
        message: '检查更新失败',
        detail: result.error,
        buttons: ['好'],
      })
      return
    }
    if (!result.newer) {
      await show({ type: 'info', message: '已是最新版本', detail: current, buttons: ['好'] })
      return
    }
    const { response } = await show({
      type: 'info',
      message: `有新版本 ${result.latest.replace(/^v/, '')}`,
      detail: current,
      buttons: ['前往下载', '以后再说'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0 && result.url.startsWith('https:')) await shell.openExternal(result.url)
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.replace(/^v/, '').split(/[.-]/)
  const b = current.replace(/^v/, '').split(/[.-]/)
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const av = Number.parseInt(a[i] ?? '0', 10)
    const bv = Number.parseInt(b[i] ?? '0', 10)
    const an = Number.isFinite(av) ? av : 0
    const bn = Number.isFinite(bv) ? bv : 0
    if (an > bn) return true
    if (an < bn) return false
  }
  return false
}
