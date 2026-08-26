import path from 'node:path'
import { Buffer } from 'node:buffer'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent
} from 'electron'
import { AppController } from './app-controller'
import { registerIpcHandlers } from './ipc'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import {
  createTrayMenuTemplate,
  hideWindowOnClose,
  revealTrayWindow,
  ShutdownCoordinator,
} from './window-tray'

let mainWindow: BrowserWindow | null = null
let windowCreation: Promise<BrowserWindow> | null = null
let tray: Tray | null = null
let controller: AppController | null = null
let removeIpcHandlers: (() => void) | null = null
let applicationInitialized = false
const shutdown = new ShutdownCoordinator()

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

app.on('second-instance', () => {
  if (!app.isReady()) return
  requestShowOrCreateMainWindow()
})

const startupTask = app.whenReady().then(async () => {
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

  const nextController = new AppController({
    userDataDirectory: app.getPath('userData'),
    version: app.getVersion(),
    openExternal: openTrustedAuthUrl,
    showDesktopNotification: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body, silent: false }).show()
    }
  })
  controller = nextController
  await nextController.initialize()
  if (shutdown.started || controller !== nextController) return
  removeIpcHandlers = registerIpcHandlers({
    controller: nextController,
    isTrustedSender
  })
  const window = await createWindow()
  if (shutdown.started || controller !== nextController) return
  nextController.onAppEvent((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.event, event)
    }
  })
  createTray()
  applicationInitialized = true
  revealTrayWindow(window)
})

void startupTask.catch((error) => {
  if (shutdown.started) return
  // Initialization failures otherwise become silent unhandled rejections in a
  // packaged GUI process. Keep live trading impossible and show a clear dialog.
  const detail = error instanceof Error ? error.message : String(error)
  console.error('Application initialization failed:', error instanceof Error ? error.stack : detail)
  dialog.showErrorBox('BWE Auto Trader 启动失败', detail.slice(0, 800))
  app.exit(1)
})

app.on('activate', () => {
  requestShowOrCreateMainWindow()
})

app.on('window-all-closed', () => {
  // A hidden-to-tray window normally remains alive. If the window is ever
  // destroyed unexpectedly, keep the tray process available so it can be
  // recreated by the tray click or platform activate event.
  if (shutdown.started) return
  if ((!tray || tray.isDestroyed()) && process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  const initiated = shutdown.handleBeforeQuit(
    event,
    async () => {
      const activeController = controller
      controller = null
      await activeController?.dispose()
    },
    () => app.quit(),
    startupTask,
  )
  if (!initiated) return

  applicationInitialized = false
  tray?.destroy()
  tray = null
  try {
    removeIpcHandlers?.()
  } catch {
    // Continue disposing the controller even if handler removal fails.
  }
  removeIpcHandlers = null
})

async function createWindow(): Promise<BrowserWindow> {
  if (windowCreation) return windowCreation
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow

  const creation = createWindowInstance()
  windowCreation = creation
  try {
    return await creation
  } finally {
    if (windowCreation === creation) windowCreation = null
  }
}

async function createWindowInstance(): Promise<BrowserWindow> {
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
  window.on('close', (event) => {
    hideWindowOnClose(
      event,
      window,
      shutdown.started,
      Boolean(tray && !tray.isDestroyed()),
    )
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  try {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL
    if (rendererUrl) await window.loadURL(rendererUrl)
    else await window.loadFile(path.join(__dirname, '../renderer/index.html'))
  } catch (error) {
    if (!window.isDestroyed()) window.destroy()
    if (mainWindow === window) mainWindow = null
    throw error
  }
  return window
}

async function showOrCreateMainWindow(): Promise<void> {
  if (!applicationInitialized || shutdown.started) return
  const window = await createWindow()
  if (shutdown.started) return
  revealTrayWindow(window)
}

function requestShowOrCreateMainWindow(): void {
  void showOrCreateMainWindow().catch(() => {
    dialog.showErrorBox('BWE Auto Trader', '无法恢复主窗口，请从托盘菜单退出并重启程序。')
  })
}

function createTray(): boolean {
  if (tray && !tray.isDestroyed()) return true
  let nextTray: Tray | null = null
  try {
    const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG_BASE64, 'base64'))
    if (icon.isEmpty()) return false
    if (process.platform === 'darwin') icon.setTemplateImage(true)

    nextTray = new Tray(icon)
    nextTray.setToolTip('BWE Auto Trader')
    nextTray.setContextMenu(Menu.buildFromTemplate(createTrayMenuTemplate(
      requestShowOrCreateMainWindow,
      () => app.quit(),
    )))
    nextTray.on('click', requestShowOrCreateMainWindow)
    tray = nextTray
    return true
  } catch {
    nextTray?.destroy()
    tray = null
    return false
  }
}

// A compact transparent 32px application glyph keeps tray behavior independent
// of platform packaging resources, which currently still use Electron's default
// unsigned application icon.
const TRAY_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAnUlEQVR42u2XsQ2AMAwE07EQDSXrsSEbMAFtaBFF8Nvv5IWw5DZ3SmzLKeUPIJZ9q5YcBqaLPA+c1tmUFBEPuCWSBj/qyZVA4W8CsARy7VaBuwQdTpUYKhCBWwWaEmjhyQlYxUICUXhXAfoTMOBuARacUoTRdkwV6NKGEXjaNKTAJQQ8E5EKRxYSD5y2FaXCJZZSibVc4mMi8zX7dFxmzm+M0aNOZQAAAABJRU5ErkJggg=='

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
