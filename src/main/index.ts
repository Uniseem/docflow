import { app, BrowserWindow, dialog, protocol, screen, shell } from 'electron'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installApplicationMenu } from './app/install-menu'
import { AppSession, pdfPathsFromArgv } from './app/session'
import { WINDOW_DEFAULT_SIZE, WINDOW_MIN_SIZE, restorableBounds } from './app/window-state'

const appDir = fileURLToPath(new URL('.', import.meta.url))

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'docflow',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

// A DOCFLOW_DATA_DIR run (E2E, debugging) must not touch the real profile: host.json,
// Chromium caches and the single-instance lock all live under userData. app.setPath needs
// an absolute path, and later readers of the variable get the same one.
const dataDirOverride = process.env.DOCFLOW_DATA_DIR?.trim()
if (dataDirOverride) {
  const absolute = resolve(dataDirOverride)
  process.env.DOCFLOW_DATA_DIR = absolute
  app.setPath('userData', join(absolute, '.electron-user-data'))
}

let mainWindow: BrowserWindow | null = null
let session: AppSession | null = null
/** open-file can fire before the app is ready (macOS cold start from Finder). */
const earlyFiles: string[] = []
let quitting = false

const BOUNDS_SAVE_DELAY_MS = 500

function isExternalUrl(url: string): boolean {
  return url.startsWith('https:') || url.startsWith('mailto:')
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  const saved = session?.host.snapshot.window
  const bounds = restorableBounds(
    saved,
    screen.getAllDisplays().map((display) => display.workArea),
  )
  const window = new BrowserWindow({
    ...(bounds ?? WINDOW_DEFAULT_SIZE),
    minWidth: WINDOW_MIN_SIZE.width,
    minHeight: WINDOW_MIN_SIZE.height,
    show: false,
    title: 'DocFlow',
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    webPreferences: {
      preload: join(appDir, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      plugins: true,
      spellcheck: false,
    },
  })
  window.once('ready-to-show', () => {
    // maximize() also shows the window, so it waits for the first paint too.
    if (saved?.maximized) window.maximize()
    window.show()
    void session?.showBootNotice(window)
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL
    if (rendererUrl && url.startsWith(rendererUrl)) return
    const productionFile = join(appDir, '../renderer/index.html')
    if (url.startsWith('file:') && decodeURIComponent(url).includes(productionFile)) return
    event.preventDefault()
    if (isExternalUrl(url)) {
      void shell.openExternal(url)
    }
  })

  // A reload (or crash) drops the renderer's subscriptions: queue files until it asks again.
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) session?.rendererGone()
  })
  window.webContents.on('render-process-gone', () => session?.rendererGone())

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(appDir, '../renderer/index.html'))
  }

  // 02 §2.5 step 8: remember size and position in host.json.
  let boundsTimer: ReturnType<typeof setTimeout> | undefined
  const saveBounds = () => {
    clearTimeout(boundsTimer)
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return
    const maximized = window.isMaximized()
    const rect = maximized ? window.getNormalBounds() : window.getBounds()
    void session?.host.update({ window: { ...rect, maximized } }).catch(() => undefined)
  }
  const scheduleSave = () => {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(saveBounds, BOUNDS_SAVE_DELAY_MS)
  }
  window.on('resize', scheduleSave)
  window.on('move', scheduleSave)
  window.on('maximize', scheduleSave)
  window.on('unmaximize', scheduleSave)
  window.on('close', saveBounds)

  mainWindow = window
  window.on('closed', () => {
    clearTimeout(boundsTimer)
    session?.rendererGone()
    if (mainWindow === window) mainWindow = null
  })
}

function openFiles(paths: string[]): void {
  if (paths.length === 0) return
  if (!session) {
    earlyFiles.push(...paths)
    return
  }
  if (!mainWindow && app.isReady()) createWindow()
  session.queueOpenFiles(paths)
}

app.on('open-file', (event, path) => {
  event.preventDefault()
  openFiles([path])
})

function fatalStartup(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  console.error('DocFlow failed to start', error)
  dialog.showErrorBox('DocFlow 无法启动', `${detail}\n\n请查看日志，或删除设置后重试。`)
  app.exit(1)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    openFiles(pdfPathsFromArgv(argv))
  })

  app
    .whenReady()
    .then(async () => {
      const current = new AppSession(app.getPath('userData'), process.env)
      current.getWindow = () => mainWindow
      await current.boot()
      session = current
      installApplicationMenu({
        platform: process.platform,
        getWindow: () => mainWindow,
        sendCommand: (name) => session?.send('app:command', { name }),
        checkUpdates: () => {
          void session?.checkUpdatesInteractive()
        },
        openLogs: () => {
          void session?.handlers['shell:openLogs']({})
        },
      })
      current.queueOpenFiles([...earlyFiles.splice(0), ...pdfPathsFromArgv(process.argv)])
      createWindow()
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch(fatalStartup)

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Give running documents up to STOP_GRACE_MS to reach a checkpoint before exiting; they
  // stay `processing` and resume on the next launch.
  app.on('before-quit', (event) => {
    if (quitting || !session) return
    quitting = true
    event.preventDefault()
    void session
      .dispose()
      .catch(() => undefined)
      .finally(() => app.quit())
  })
}
