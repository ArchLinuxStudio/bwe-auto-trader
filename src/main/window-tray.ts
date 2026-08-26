import type { MenuItemConstructorOptions } from 'electron'

export interface TrayManagedWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  hide(): void
}

export interface PreventableWindowCloseEvent {
  preventDefault(): void
}

type ShutdownPhase = 'idle' | 'disposing' | 'ready-to-quit'

/**
 * Keeps repeated quit requests fail-closed until the asynchronous main-process
 * cleanup has completed. Electron may emit before-quit again while cleanup is
 * still pending, so a boolean alone would allow the process to exit early.
 */
export class ShutdownCoordinator {
  private phase: ShutdownPhase = 'idle'

  get started(): boolean {
    return this.phase !== 'idle'
  }

  handleBeforeQuit(
    event: PreventableWindowCloseEvent,
    cleanup: () => Promise<void>,
    finalizeQuit: () => void,
    settleBeforeCleanup?: Promise<unknown>,
  ): boolean {
    if (this.phase === 'ready-to-quit') return false

    event.preventDefault()
    if (this.phase === 'disposing') return false

    this.phase = 'disposing'
    void (async () => {
      try {
        if (settleBeforeCleanup) await settleBeforeCleanup.catch(() => undefined)
        await cleanup()
      } catch {
        // Shutdown must still be able to complete if best-effort cleanup fails.
      }
      this.phase = 'ready-to-quit'
      finalizeQuit()
    })()
    return true
  }
}

/**
 * Converts the title-bar close action into a hide-to-tray action. Returning
 * false leaves Electron's normal close path untouched for an explicit quit.
 */
export function hideWindowOnClose(
  event: PreventableWindowCloseEvent,
  window: TrayManagedWindow,
  quitting: boolean,
  trayAvailable: boolean,
): boolean {
  if (quitting || !trayAvailable || window.isDestroyed()) return false
  event.preventDefault()
  window.hide()
  return true
}

/** Restores a hidden/minimized window and gives it foreground focus. */
export function revealTrayWindow(window: TrayManagedWindow | null | undefined): boolean {
  if (!window || window.isDestroyed()) return false
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return true
}

export function createTrayMenuTemplate(
  showWindow: () => void,
  quitApplication: () => void,
): MenuItemConstructorOptions[] {
  return [
    { id: 'show-main-window', label: '显示主窗口', click: showWindow },
    { type: 'separator' },
    { id: 'quit-application', label: '退出 BWE Auto Trader', click: quitApplication },
  ]
}
