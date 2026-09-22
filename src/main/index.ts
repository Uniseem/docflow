import { app, BrowserWindow, protocol, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installApplicationMenu } from './app/install-menu'
import { AppSession, pdfPathsFromArgv } from './app/session'

const appDir = fileURLToPath(new URL('.', import.meta.url))

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'docflow',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

let mainWindow: BrowserWindow | null = null
let session: AppSession | null = null
const pendingOpen: string[] = []

function isExternalUrl(url: string): boolean {
  return url.startsWith('https:') || url.startsWith('mailto:')
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  const window = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 960,
    minHeight: 600,
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
    window.show()
    const paths = pendingOpen.splice(0)
    session?.openPendingFiles(paths)
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

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(appDir, '../renderer/index.html'))
  }

  mainWindow = window
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
}

app.on('open-file', (event, path) => {
  event.preventDefault()
  if (session && mainWindow) session.openPendingFiles([path])
  else pendingOpen.push(path)
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    session?.openPendingFiles(pdfPathsFromArgv(argv))
  })

  void app.whenReady().then(async () => {
    session = new AppSession(app.getPath('userData'), process.env)
    session.getWindow = () => mainWindow
    await session.boot()
    installApplicationMenu({
      platform: process.platform,
      getWindow: () => mainWindow,
      sendCommand: (name) => session?.send('app:command', { name }),
      checkUpdates: () => {
        void session?.handlers['app:checkUpdates']({})
      },
      openLogs: () => {
        void session?.handlers['shell:openLogs']({})
      },
    })
    createWindow()
    session.openPendingFiles(pdfPathsFromArgv(process.argv))
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    void session?.dispose()
  })
}
