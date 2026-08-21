import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { CLOSE_POSITION_CONFIRMATION } from '../shared/defaults'
import { IPC_CHANNELS, INVOKE_CHANNELS } from '../shared/ipc-channels'
import type { IpcResult } from '../shared/types'
import type { AppController } from './app-controller'

export interface IpcRegistrationOptions {
  controller: AppController
  isTrustedSender(event: IpcMainInvokeEvent): boolean
}

export function registerIpcHandlers(options: IpcRegistrationOptions): () => void {
  const { controller } = options
  const handle = <T>(
    channel: string,
    operation: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> | T
  ): void => {
    ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<T>> => {
      if (!options.isTrustedSender(event)) return { ok: false, error: '已拒绝不可信页面的请求' }
      try {
        return { ok: true, value: await operation(event, ...args) }
      } catch (error) {
        return { ok: false, error: publicError(error) }
      }
    })
  }

  handle(IPC_CHANNELS.getSnapshot, () => controller.getSnapshot())
  handle(IPC_CHANNELS.saveTelegramCredentials, (_event, input) =>
    controller.saveTelegramCredentials(input as never)
  )
  handle(IPC_CHANNELS.connectTelegram, () => controller.connectTelegram())
  handle(IPC_CHANNELS.disconnectTelegram, () => controller.disconnectTelegram())
  handle(IPC_CHANNELS.submitAuthPrompt, (_event, id, value) =>
    controller.submitAuthPrompt(
      z.string().uuid().parse(id),
      z.string().min(1).max(512).parse(value)
    )
  )
  handle(IPC_CHANNELS.cancelAuthPrompt, (_event, id) =>
    controller.cancelAuthPrompt(z.string().uuid().parse(id))
  )
  handle(IPC_CHANNELS.loginChatGpt, () => controller.loginChatGpt())
  handle(IPC_CHANNELS.disconnectChatGpt, () => controller.disconnectChatGpt())
  handle(IPC_CHANNELS.saveOkxCredentials, (_event, input) =>
    controller.saveOkxCredentials(input as never)
  )
  handle(IPC_CHANNELS.connectOkx, () => controller.connectOkx())
  handle(IPC_CHANNELS.disconnectOkx, () => controller.disconnectOkx())
  handle(IPC_CHANNELS.updateSettings, (_event, input) =>
    controller.updateSettings(input as never)
  )
  handle(IPC_CHANNELS.runNetworkDiagnostics, () => controller.runNetworkDiagnostics())
  handle(IPC_CHANNELS.startMonitoring, () => controller.startMonitoring())
  handle(IPC_CHANNELS.stopMonitoring, () => controller.stopMonitoring())
  handle(IPC_CHANNELS.armLiveTrading, (_event, confirmation) =>
    controller.armLiveTrading(z.string().max(32).parse(confirmation))
  )
  handle(IPC_CHANNELS.disarmLiveTrading, () => controller.disarmLiveTrading())
  handle(IPC_CHANNELS.emergencyStop, () => controller.emergencyStop())
  handle(IPC_CHANNELS.closePosition, (_event, input) =>
    controller.closePosition(
      z.object({
        instrumentId: z.string().regex(/^[A-Z0-9]{1,24}-USDT-SWAP$/),
        confirmation: z.literal(CLOSE_POSITION_CONFIRMATION)
      }).parse(input)
    )
  )
  handle(IPC_CHANNELS.clearNotifications, () => controller.clearNotifications())

  return () => {
    for (const channel of INVOKE_CHANNELS) ipcMain.removeHandler(channel)
  }
}

function publicError(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? '输入格式不正确'
  const message = error instanceof Error ? error.message : String(error)
  // Never forward stack traces or multi-line stderr from native services.
  return message.split(/\r?\n/, 1)[0]!.slice(0, 500)
}
