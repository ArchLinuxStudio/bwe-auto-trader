export const IPC_CHANNELS = {
  getSnapshot: 'app:get-snapshot',
  saveTelegramCredentials: 'telegram:save-credentials',
  connectTelegram: 'telegram:connect',
  disconnectTelegram: 'telegram:disconnect',
  submitAuthPrompt: 'auth:submit',
  cancelAuthPrompt: 'auth:cancel',
  loginChatGpt: 'chatgpt:login',
  disconnectChatGpt: 'chatgpt:disconnect',
  saveOkxCredentials: 'okx:save-credentials',
  connectOkx: 'okx:connect',
  disconnectOkx: 'okx:disconnect',
  updateSettings: 'settings:update',
  runNetworkDiagnostics: 'network:diagnose',
  startMonitoring: 'monitoring:start',
  stopMonitoring: 'monitoring:stop',
  armLiveTrading: 'trading:arm',
  disarmLiveTrading: 'trading:disarm',
  emergencyStop: 'trading:emergency-stop',
  closePosition: 'trading:close-position',
  clearNotifications: 'notifications:clear',
  event: 'app:event'
} as const

export const INVOKE_CHANNELS = Object.values(IPC_CHANNELS).filter(
  (channel) => channel !== IPC_CHANNELS.event
)
