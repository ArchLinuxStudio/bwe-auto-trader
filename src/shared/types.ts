export type ConnectionPhase =
  | 'not_configured'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'

export interface ConnectionStatus {
  phase: ConnectionPhase
  label: string
  detail?: string
  lastChangedAt: number
}

export type TradeDecision = 'LONG' | 'SHORT' | 'SKIP'
export type SignalStage =
  | 'received'
  | 'analyzing'
  | 'skipped'
  | 'blocked'
  | 'submitting'
  | 'submitted'
  | 'filled'
  | 'failed'

export interface TelegramMessagePayload {
  channelId: string
  messageId: number
  channelUsername: string
  text: string
  date: number
  receivedAt: number
  permalink?: string
  /** True for startup/reconnect replay; it may be analyzed but can never trade. */
  recovered?: boolean
}

export interface AiAnalysis {
  symbols: string[]
  decision: TradeDecision
  confidence: number
  reason: string
  latencyMs: number
  model?: string
}

export interface SignalRecord {
  id: string
  telegram: TelegramMessagePayload
  stage: SignalStage
  analysis?: AiAnalysis
  instrumentId?: string
  orderId?: string
  clientOrderId?: string
  orderState?: string
  filledContracts?: string
  averageFillPrice?: string
  detail: string
  createdAt: number
  updatedAt: number
}

export interface AppPosition {
  instrumentId: string
  direction: 'long' | 'short'
  contracts: number
  notionalUsd?: number
  averagePrice: number
  markPrice: number
  unrealizedPnl: number
  unrealizedPnlPercent: number
  leverage: number
  marginMode: 'isolated' | 'cross'
  closePending?: boolean
  closeOrderState?: string
  updatedAt: number
}

export interface TradingSettings {
  channelUsername: string
  orderNotionalUsdt: number
  leverage: number
  cooldownMinutes: number
  aiTimeoutMs: number
  maxConcurrentPositions: number
  marginMode: 'isolated'
  positionMode: 'net'
}

export interface ProxySettings {
  host: string
  port: number
  protocol: 'auto' | 'socks5' | 'http'
}

export interface PublicSettings {
  telegramApiId?: number
  telegramPhoneHint?: string
  proxy: ProxySettings
  trading: TradingSettings
  okxConfigured: boolean
  telegramConfigured: boolean
  chatgptConfigured: boolean
  notificationsEnabled: boolean
  soundsEnabled: boolean
}

export interface RuntimeSafetyState {
  liveArmed: boolean
  armedAt?: number
  monitoring: boolean
  emergencyStopped: boolean
  canArm: boolean
  armBlockers: string[]
}

export type PromptKind =
  | 'telegram_phone'
  | 'telegram_code'
  | 'telegram_password'

export interface AuthPrompt {
  id: string
  kind: PromptKind
  title: string
  detail: string
  secret: boolean
}

export interface NotificationItem {
  id: string
  level: 'success' | 'warning' | 'error' | 'info'
  title: string
  detail: string
  createdAt: number
}

export interface NetworkDiagnostics {
  proxyReachable: boolean
  proxyProtocol?: 'http' | 'socks5'
  directIp?: string
  proxiedIp?: string
  okxDirect: boolean
  checkedAt?: number
  detail?: string
}

export type OkxRouteKind = 'unselected' | 'direct' | 'proxy'

export interface OkxRouteStatus {
  kind: OkxRouteKind
  protocol?: Exclude<ProxySettings['protocol'], 'auto'>
  endpoint?: string
  selectedAt?: number
  detail?: string
}

export interface OkxRoutes {
  rest: OkxRouteStatus
  privateWs: OkxRouteStatus
}

export interface AppSnapshot {
  version: string
  connections: {
    telegram: ConnectionStatus
    chatgpt: ConnectionStatus
    okx: ConnectionStatus
  }
  safety: RuntimeSafetyState
  settings: PublicSettings
  diagnostics: NetworkDiagnostics
  okxRoutes: OkxRoutes
  positions: AppPosition[]
  signals: SignalRecord[]
  notifications: NotificationItem[]
  pendingAuthPrompt?: AuthPrompt
  aiModel?: string
  aiQuotaPercent?: number
  aiQuotaExhausted?: boolean
  lastError?: string
}

export interface TelegramCredentialsInput {
  apiId: number
  apiHash: string
  phoneNumber: string
}

export interface OkxCredentialsInput {
  apiKey: string
  secretKey: string
  passphrase: string
}

export interface SettingsUpdateInput {
  proxy?: Partial<ProxySettings>
  trading?: Partial<TradingSettings>
  notificationsEnabled?: boolean
  soundsEnabled?: boolean
}

export interface ClosePositionInput {
  instrumentId: string
  confirmation: string
}

export interface IpcResult<T = undefined> {
  ok: boolean
  value?: T
  error?: string
}

export type AppEvent =
  | { type: 'snapshot'; payload: AppSnapshot }
  | { type: 'notification'; payload: NotificationItem }
  | { type: 'auth-prompt'; payload: AuthPrompt }

export interface DesktopApi {
  getSnapshot(): Promise<IpcResult<AppSnapshot>>
  saveTelegramCredentials(input: TelegramCredentialsInput): Promise<IpcResult>
  connectTelegram(): Promise<IpcResult>
  disconnectTelegram(): Promise<IpcResult>
  submitAuthPrompt(id: string, value: string): Promise<IpcResult>
  cancelAuthPrompt(id: string): Promise<IpcResult>
  loginChatGpt(): Promise<IpcResult<{ authUrl?: string; userCode?: string }>>
  disconnectChatGpt(): Promise<IpcResult>
  saveOkxCredentials(input: OkxCredentialsInput): Promise<IpcResult>
  connectOkx(): Promise<IpcResult>
  disconnectOkx(): Promise<IpcResult>
  updateSettings(input: SettingsUpdateInput): Promise<IpcResult>
  runNetworkDiagnostics(): Promise<IpcResult<NetworkDiagnostics>>
  startMonitoring(): Promise<IpcResult>
  stopMonitoring(): Promise<IpcResult>
  armLiveTrading(confirmation: string): Promise<IpcResult>
  disarmLiveTrading(): Promise<IpcResult>
  emergencyStop(): Promise<IpcResult>
  closePosition(input: ClosePositionInput): Promise<IpcResult>
  clearNotifications(): Promise<IpcResult>
  onEvent(listener: (event: AppEvent) => void): () => void
}
