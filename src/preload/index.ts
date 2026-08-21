import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import type {
  AppEvent,
  ClosePositionInput,
  DesktopApi,
  OkxCredentialsInput,
  SettingsUpdateInput,
  TelegramCredentialsInput
} from '../shared/types'

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot),
  saveTelegramCredentials: (input: TelegramCredentialsInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveTelegramCredentials, input),
  connectTelegram: () => ipcRenderer.invoke(IPC_CHANNELS.connectTelegram),
  disconnectTelegram: () => ipcRenderer.invoke(IPC_CHANNELS.disconnectTelegram),
  submitAuthPrompt: (id: string, value: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.submitAuthPrompt, id, value),
  cancelAuthPrompt: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.cancelAuthPrompt, id),
  loginChatGpt: () => ipcRenderer.invoke(IPC_CHANNELS.loginChatGpt),
  disconnectChatGpt: () => ipcRenderer.invoke(IPC_CHANNELS.disconnectChatGpt),
  saveOkxCredentials: (input: OkxCredentialsInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveOkxCredentials, input),
  connectOkx: () => ipcRenderer.invoke(IPC_CHANNELS.connectOkx),
  disconnectOkx: () => ipcRenderer.invoke(IPC_CHANNELS.disconnectOkx),
  updateSettings: (input: SettingsUpdateInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateSettings, input),
  runNetworkDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.runNetworkDiagnostics),
  startMonitoring: () => ipcRenderer.invoke(IPC_CHANNELS.startMonitoring),
  stopMonitoring: () => ipcRenderer.invoke(IPC_CHANNELS.stopMonitoring),
  armLiveTrading: (confirmation: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.armLiveTrading, confirmation),
  disarmLiveTrading: () => ipcRenderer.invoke(IPC_CHANNELS.disarmLiveTrading),
  emergencyStop: () => ipcRenderer.invoke(IPC_CHANNELS.emergencyStop),
  closePosition: (input: ClosePositionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.closePosition, input),
  clearNotifications: () => ipcRenderer.invoke(IPC_CHANNELS.clearNotifications),
  onEvent: (listener: (event: AppEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      if (isAppEvent(value)) listener(value)
    }
    ipcRenderer.on(IPC_CHANNELS.event, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.event, handler)
  }
}

contextBridge.exposeInMainWorld('desktopApi', Object.freeze(api))

function isAppEvent(value: unknown): value is AppEvent {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { type?: unknown; payload?: unknown }
  return (
    (candidate.type === 'snapshot' ||
      candidate.type === 'notification' ||
      candidate.type === 'auth-prompt') &&
    Boolean(candidate.payload && typeof candidate.payload === 'object')
  )
}
