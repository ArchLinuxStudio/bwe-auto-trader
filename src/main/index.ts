import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  Notification,
  session,
  shell,
  type IpcMainInvokeEvent
} from 'electron'
import { AppController } from './app-controller'
import { registerIpcHandlers } from './ipc'
import { IPC_CHANNELS } from '../shared/ipc-channels'

let mainWindow: BrowserWindow | null = null
let controller: AppController | null = null
let removeIpcHandlers: (() => void) | null = null
let shutdownStarted = false

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

void app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  app.setAppUserModelId('com.local.bweautotrader')
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
        ]
      }
    })
  })

  controller = new AppController({
    userDataDirectory: app.getPath('userData'),
    version: app.getVersion(),
    openExternal: openTrustedAuthUrl,
    showDesktopNotification: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body, silent: false }).show()
    }
  })
  await controller.initialize()
  removeIpcHandlers = registerIpcHandlers({
    controller,
    isTrustedSender
  })
  await createWindow()
  controller.onAppEvent((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.event, event)
    }
  })
}).catch((error) => {
  // Initialization failures otherwise become silent unhandled rejections in a
  // packaged GUI process. Keep live trading impossible and show a clear dialog.
  const detail = error instanceof Error ? error.message : String(error)
  console.error('Application initialization failed:', error instanceof Error ? error.stack : detail)
  dialog.showErrorBox('BWE Auto Trader 启动失败', detail.slice(0, 800))
  app.exit(1)
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownStarted) return
  shutdownStarted = true
  event.preventDefault()
  void (async () => {
    removeIpcHandlers?.()
    removeIpcHandlers = null
    await controller?.dispose().catch(() => undefined)
    controller = null
    app.quit()
  })()
})

async function createWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) return
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1060,
    minHeight: 720,
    show: false,
    backgroundColor: '#07110f',
    title: 'BWE Auto Trader',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  })
  mainWindow = window
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) await window.loadURL(rendererUrl)
  else await window.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) return false
  try {
    const url = new URL(frame.url)
    const rendererUrl = process.env.ELECTRON_RENDERER_URL
    if (rendererUrl) return url.origin === new URL(rendererUrl).origin
    return url.protocol === 'file:' && path.normalize(decodeURIComponent(url.pathname)).endsWith(
      path.normalize(path.join('out', 'renderer', 'index.html'))
    )
  } catch {
    return false
  }
}

async function openTrustedAuthUrl(raw: string): Promise<void> {
  const url = new URL(raw)
  const hostname = url.hostname.toLowerCase()
  const trustedHttps =
    url.protocol === 'https:' &&
    (hostname === 'openai.com' ||
      hostname.endsWith('.openai.com') ||
      hostname === 'chatgpt.com' ||
      hostname.endsWith('.chatgpt.com'))
  const trustedLocalhost =
    url.protocol === 'http:' && (hostname === '127.0.0.1' || hostname === 'localhost')
  if (!trustedHttps && !trustedLocalhost) throw new Error('登录服务返回了不受信任的网址')
  await shell.openExternal(url.toString())
}

function isTrustedExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return (
      host === 't.me' ||
      host === 'my.telegram.org' ||
      host === 'okx.com' ||
      host.endsWith('.okx.com') ||
      host === 'openai.com' ||
      host.endsWith('.openai.com') ||
      host === 'chatgpt.com' ||
      host.endsWith('.chatgpt.com')
    )
  } catch {
    return false
  }
}
