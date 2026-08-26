import { describe, expect, it, vi } from 'vitest'

import {
  createTrayMenuTemplate,
  hideWindowOnClose,
  revealTrayWindow,
  ShutdownCoordinator,
  type TrayManagedWindow,
} from '../../src/main/window-tray'

function fakeWindow(overrides: Partial<TrayManagedWindow> = {}): TrayManagedWindow {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    hide: vi.fn(),
    ...overrides,
  }
}

describe('window tray lifecycle', () => {
  it('hides the main window instead of closing it from the title bar', () => {
    const event = { preventDefault: vi.fn() }
    const window = fakeWindow()

    expect(hideWindowOnClose(event, window, false, true)).toBe(true)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window.hide).toHaveBeenCalledOnce()
  })

  it('allows the normal close path after an explicit application quit starts', () => {
    const event = { preventDefault: vi.fn() }
    const window = fakeWindow()

    expect(hideWindowOnClose(event, window, true, true)).toBe(false)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('allows closing when no usable tray exists so the app cannot become unreachable', () => {
    const event = { preventDefault: vi.fn() }
    const window = fakeWindow()

    expect(hideWindowOnClose(event, window, false, false)).toBe(false)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('restores, shows, and focuses a minimized tray window', () => {
    const window = fakeWindow({ isMinimized: vi.fn(() => true) })

    expect(revealTrayWindow(window)).toBe(true)

    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('does not touch a destroyed tray window', () => {
    const window = fakeWindow({ isDestroyed: vi.fn(() => true) })

    expect(revealTrayWindow(window)).toBe(false)

    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
  })

  it('provides explicit show and quit tray actions', () => {
    const showWindow = vi.fn()
    const quitApplication = vi.fn()
    const template = createTrayMenuTemplate(showWindow, quitApplication)

    expect(template.map((item) => item.type ?? item.label)).toEqual([
      '显示主窗口',
      'separator',
      '退出 BWE Auto Trader',
    ])
    expect(template.map((item) => item.id)).toEqual([
      'show-main-window',
      undefined,
      'quit-application',
    ])
    ;(template.find((item) => item.id === 'show-main-window')?.click as (() => void) | undefined)?.()
    ;(template.find((item) => item.id === 'quit-application')?.click as (() => void) | undefined)?.()
    expect(showWindow).toHaveBeenCalledOnce()
    expect(quitApplication).toHaveBeenCalledOnce()
  })

  it('blocks repeated quit requests until asynchronous cleanup completes', async () => {
    let resolveCleanup!: () => void
    const cleanup = vi.fn(() => new Promise<void>((resolve) => {
      resolveCleanup = resolve
    }))
    const finalizeQuit = vi.fn()
    const shutdown = new ShutdownCoordinator()
    const firstEvent = { preventDefault: vi.fn() }
    const repeatedEvent = { preventDefault: vi.fn() }

    expect(shutdown.handleBeforeQuit(firstEvent, cleanup, finalizeQuit)).toBe(true)
    expect(shutdown.started).toBe(true)
    expect(shutdown.handleBeforeQuit(repeatedEvent, cleanup, finalizeQuit)).toBe(false)
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(finalizeQuit).not.toHaveBeenCalled()

    resolveCleanup()
    await vi.waitFor(() => expect(finalizeQuit).toHaveBeenCalledOnce())

    const finalEvent = { preventDefault: vi.fn() }
    expect(shutdown.handleBeforeQuit(finalEvent, cleanup, finalizeQuit)).toBe(false)
    expect(finalEvent.preventDefault).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('finishes quitting even when best-effort cleanup fails', async () => {
    const shutdown = new ShutdownCoordinator()
    const finalizeQuit = vi.fn()

    shutdown.handleBeforeQuit(
      { preventDefault: vi.fn() },
      async () => { throw new Error('cleanup failed') },
      finalizeQuit,
    )

    await vi.waitFor(() => expect(finalizeQuit).toHaveBeenCalledOnce())
  })

  it('settles startup before disposing during an early quit', async () => {
    let settleStartup!: () => void
    const startup = new Promise<void>((resolve) => {
      settleStartup = resolve
    })
    const cleanup = vi.fn(async () => undefined)
    const finalizeQuit = vi.fn()
    const shutdown = new ShutdownCoordinator()

    shutdown.handleBeforeQuit(
      { preventDefault: vi.fn() },
      cleanup,
      finalizeQuit,
      startup,
    )

    await Promise.resolve()
    expect(cleanup).not.toHaveBeenCalled()
    expect(finalizeQuit).not.toHaveBeenCalled()

    settleStartup()
    await vi.waitFor(() => expect(finalizeQuit).toHaveBeenCalledOnce())
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
