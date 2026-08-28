import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'secret_service',
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}))

import { AppController } from '../../src/main/app-controller'
import type { TelegramMonitor, TelegramStatusEvent } from '../../src/main/services/telegram'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function createController(
  showDesktopNotification: (title: string, body: string) => void | Promise<void> = vi.fn()
) {
  const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'bwe-controller-notifications-'))
  temporaryDirectories.push(userDataDirectory)
  const controller = new AppController({
    userDataDirectory,
    version: 'test',
    openExternal: async () => undefined,
    showDesktopNotification
  })
  await controller.initialize()
  return { controller, showDesktopNotification }
}

describe('AppController system notifications', () => {
  it('keeps ordinary notices in the application without publishing them globally', async () => {
    const { controller, showDesktopNotification } = await createController()
    const notify = (controller as unknown as {
      notify(level: 'info', title: string, detail: string): Promise<void>
    }).notify.bind(controller)

    await notify('info', '程序内消息', '只进入通知历史')

    expect(showDesktopNotification).not.toHaveBeenCalled()
    expect(controller.getSnapshot().notifications).toEqual([
      expect.objectContaining({
        level: 'info',
        title: '程序内消息',
        detail: '只进入通知历史'
      })
    ])
    await controller.dispose()
  })

  it('publishes explicit system notices only while notifications are enabled', async () => {
    const { controller, showDesktopNotification } = await createController()
    const showSystemNotification = (controller as unknown as {
      showSystemNotification(title: string, detail: string): void
    }).showSystemNotification.bind(controller)

    showSystemNotification('全局消息', '第一次')
    await controller.updateSettings({ notificationsEnabled: false })
    showSystemNotification('全局消息', '已禁用')

    expect(showDesktopNotification).toHaveBeenCalledOnce()
    expect(showDesktopNotification).toHaveBeenCalledWith('全局消息', '第一次')
    expect(controller.getSnapshot().notifications).toEqual([])
    await controller.dispose()
  })

  it('deduplicates reconnecting notices until the current reconnect cycle ends', async () => {
    const { controller, showDesktopNotification } = await createController()
    const readiness = { ready: false, revision: 1 }
    const telegram = {
      get liveTradingReadiness() {
        return readiness
      },
      stop: vi.fn(async () => undefined)
    } as unknown as TelegramMonitor
    const internals = controller as unknown as {
      telegram?: TelegramMonitor
      handleTelegramStatus(source: TelegramMonitor, status: TelegramStatusEvent): void
    }
    internals.telegram = telegram

    const status = (state: TelegramStatusEvent['state'], detail: string): TelegramStatusEvent => ({
      state,
      detail,
      at: new Date().toISOString()
    })
    internals.handleTelegramStatus(telegram, status('reconnecting', '网络波动'))
    internals.handleTelegramStatus(telegram, status('reconnecting', '仍在重试'))

    expect(showDesktopNotification).toHaveBeenCalledOnce()
    expect(showDesktopNotification).toHaveBeenLastCalledWith(
      'Telegram 正在自动重连',
      '检测到 Telegram 连接中断，正在自动恢复；恢复前不会进行实盘下单'
    )

    readiness.ready = true
    internals.handleTelegramStatus(telegram, status('connected', '连接恢复'))
    readiness.ready = false
    internals.handleTelegramStatus(telegram, status('reconnecting', '再次波动'))
    expect(showDesktopNotification).toHaveBeenCalledTimes(2)

    internals.handleTelegramStatus(telegram, status('error', '本周期失败'))
    internals.handleTelegramStatus(telegram, status('reconnecting', '新周期重试'))
    expect(showDesktopNotification).toHaveBeenCalledTimes(3)
    expect(showDesktopNotification).toHaveBeenLastCalledWith(
      'Telegram 正在自动重连',
      '检测到 Telegram 连接中断，正在自动恢复；恢复前不会进行实盘下单'
    )
    await controller.dispose()
  })

  it('ignores reconnect status from an obsolete monitor instance', async () => {
    const { controller, showDesktopNotification } = await createController()
    const current = {
      liveTradingReadiness: { ready: false, revision: 1 },
      stop: vi.fn(async () => undefined)
    } as unknown as TelegramMonitor
    const obsolete = {
      liveTradingReadiness: { ready: false, revision: 0 },
      stop: vi.fn(async () => undefined)
    } as unknown as TelegramMonitor
    const internals = controller as unknown as {
      telegram?: TelegramMonitor
      handleTelegramStatus(source: TelegramMonitor, status: TelegramStatusEvent): void
    }
    internals.telegram = current
    const reconnecting: TelegramStatusEvent = {
      state: 'reconnecting',
      detail: 'stale callback',
      at: new Date().toISOString()
    }

    internals.handleTelegramStatus(obsolete, reconnecting)
    expect(showDesktopNotification).not.toHaveBeenCalled()

    internals.handleTelegramStatus(current, reconnecting)
    expect(showDesktopNotification).toHaveBeenCalledOnce()
    await controller.dispose()
  })

  it('treats synchronous and asynchronous desktop delivery failures as best-effort', async () => {
    const synchronous = await createController(vi.fn(() => {
      throw new Error('notification backend unavailable')
    }))
    const asynchronous = await createController(vi.fn(async () => {
      throw new Error('notification backend rejected')
    }))
    const showSystemNotification = (synchronous.controller as unknown as {
      showSystemNotification(title: string, detail: string): void
    }).showSystemNotification.bind(synchronous.controller)

    expect(() => showSystemNotification('全局消息', '同步投递失败')).not.toThrow()
    const showRejectedSystemNotification = (asynchronous.controller as unknown as {
      showSystemNotification(title: string, detail: string): void
    }).showSystemNotification.bind(asynchronous.controller)
    expect(() => showRejectedSystemNotification('全局消息', '异步投递失败')).not.toThrow()
    await Promise.resolve()
    await synchronous.controller.dispose()
    await asynchronous.controller.dispose()
  })
})
