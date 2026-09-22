import {
  app,
  type BrowserWindow,
  dialog,
  nativeTheme,
  net,
  Notification,
  protocol,
  safeStorage,
  shell,
} from 'electron'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOCUMENT_CHANGED_THROTTLE_MS } from '../../shared/constants'
import type { PushChannelName } from '../../shared/ipc'
import type { DocumentManifest } from '../../shared/types'
import type { DialogHost } from './dialogs'
import { handleDocflowRequest } from './protocol'
import { dockBadge, notifyIfBackground, overallProgress } from './notifications'
import { DocumentLibrary } from '../library/library'
import { Scheduler } from '../jobs/scheduler'
import { configureLogger, createLogger } from '../log/logger'
import { PdfWorkerHost } from '../pdf/worker-host'
import { createPipelineHooks } from '../pipeline/hooks'
import { runPipeline } from '../pipeline/run'
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
  private changedTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private lastStatus = new Map<string, DocumentManifest['status']>()

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
    this.scheduler = this.makeScheduler()
  }

  getWindow: () => BrowserWindow | null = () => null

  async boot(): Promise<void> {
    await this.host.load()
    if (this.host.snapshot.theme) nativeTheme.themeSource = this.host.snapshot.theme
    await this.openLibrary(this.host.libraryDir())
    protocol.handle('docflow', async (request) => {
      return handleDocflowRequest(this.library.dir, request.url, (fileUrl) => net.fetch(fileUrl))
    })
    this.handlers = createIpcHandlers(this.handlerContext())
    registerIpc(this.handlers, this.logger)
    await this.scheduler.start()
  }

  async dispose(): Promise<void> {
    await this.scheduler.stop()
    this.analyzeWorker.kill()
    this.composeWorker.kill()
    for (const timer of this.changedTimers.values()) clearTimeout(timer)
    this.changedTimers.clear()
  }

  send<K extends PushChannelName>(channel: K, payload: unknown): void {
    this.getWindow()?.webContents.send(channel, payload)
  }

  openPendingFiles(paths: string[]): void {
    if (paths.length === 0) return
    this.send('app:openFiles', { paths })
  }

  private async openLibrary(libraryDir: string): Promise<void> {
    await mkdir(libraryDir, { recursive: true })
    this.logsDir = configureLogger(libraryDir, {
      env: this.env,
      packaged: app.isPackaged,
    })
    this.logger = createLogger('app')
    this.settings = new SettingsStore(libraryDir, {
      onChange: (settings) => {
        this.pools.configure(settings.providers)
        this.send('settings:changed', toSettingsView(settings, this.secrets, this.env))
      },
      onWarning: (message) => this.logger.warn(message),
    })
    this.secrets = new SecretsStore(libraryDir, electronCryptor())
    await this.settings.load()
    await this.secrets.load()
    if (this.env.DOCFLOW_FAKE_PROVIDERS === '1') {
      const hasFake = this.settings.snapshot.providers.some((item) => item.id === 'fake')
      if (!hasFake) {
        await this.settings.replaceProviders([...this.settings.snapshot.providers, fakeProvider()])
      }
    }
    this.pools.configure(this.settings.snapshot.providers)
    await this.library.open(libraryDir)
    this.library.events.onAppend = (id, event) => {
      this.send('document:event', { ...event, documentId: id })
    }
    this.scheduler = this.makeScheduler()
  }

  private makeScheduler(): Scheduler {
    const hooks = createPipelineHooks({
      library: this.library,
      settings: this.settings,
      pools: this.pools,
      analyze: this.analyzeWorker,
      compose: this.composeWorker,
      env: this.env,
    })
    return new Scheduler(
      this.library,
      (id, signal) => runPipeline(this.library, id, signal, hooks),
      {
        concurrency: () => this.settings.snapshot.workerConcurrency,
        onChanged: (manifest) => this.onManifestChanged(manifest),
        onEvent: async (id, message) => {
          const current = this.library.require(id)
          await this.library.events.append(id, {
            stage: current.stage,
            level: message.startsWith('处理失败') ? 'error' : 'info',
            message,
          })
        },
      },
    )
  }

  private onManifestChanged(manifest: DocumentManifest): void {
    const previous = this.lastStatus.get(manifest.id)
    this.lastStatus.set(manifest.id, manifest.status)
    this.queueChanged(manifest.id)
    this.updateBadge()
    if (previous && previous !== manifest.status) {
      const note = notifyIfBackground({
        enabled: this.settings.snapshot.notifications,
        focused: this.getWindow()?.isFocused() ?? true,
        status: manifest.status,
        title: manifest.title,
      })
      if (note && Notification.isSupported()) {
        const notification = new Notification({ title: note.title, body: note.body })
        notification.on('click', () => {
          const window = this.getWindow()
          window?.show()
          window?.focus()
        })
        notification.show()
      }
    }
  }

  private queueChanged(id: string): void {
    const existing = this.changedTimers.get(id)
    if (existing) clearTimeout(existing)
    this.changedTimers.set(
      id,
      setTimeout(() => {
        this.changedTimers.delete(id)
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
    window?.setProgressBar(overallProgress(active.map((item) => item.progress)))
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

  async changeLibrary(path: string): Promise<string> {
    await this.scheduler.stop()
    this.analyzeWorker.kill()
    this.composeWorker.kill()
    await this.host.update({ libraryDir: path })
    await this.openLibrary(this.host.libraryDir())
    this.handlers = createIpcHandlers(this.handlerContext())
    registerIpc(this.handlers, this.logger)
    await this.scheduler.start()
    this.send('library:changed', { libraryDir: this.library.dir })
    return this.library.dir
  }

  private handlerContext(): HandlerContext {
    return {
      library: this.library,
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
      getLibraryDir: () => this.library.dir,
      setTheme: async (theme) => {
        nativeTheme.themeSource = theme
        await this.host.update({ theme })
      },
      checkUpdates: () => this.checkUpdates(),
      changeLibrary: (path) => this.changeLibrary(path),
      reveal: (path) => shell.showItemInFolder(path),
      openPath: async (path) => {
        await shell.openPath(path)
      },
      openExternal: (url) => shell.openExternal(url),
      sendRemoved: (id) => this.send('document:removed', { id }),
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
