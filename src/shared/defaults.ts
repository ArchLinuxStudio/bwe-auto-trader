import type { PublicSettings } from './types'

export const DEFAULT_SETTINGS: PublicSettings = {
  proxy: {
    host: '127.0.0.1',
    port: 7890,
    protocol: 'auto'
  },
  trading: {
    channelUsername: 'BWEnews',
    orderNotionalUsdt: 10,
    leverage: 1,
    cooldownMinutes: 60,
    aiTimeoutMs: 10_000,
    maxConcurrentPositions: 1,
    marginMode: 'isolated',
    positionMode: 'net'
  },
  okxConfigured: false,
  telegramConfigured: false,
  chatgptConfigured: false,
  notificationsEnabled: true,
  soundsEnabled: true
}

export const LIVE_ARM_CONFIRMATION = '确认实盘'
export const CLOSE_POSITION_CONFIRMATION = '确认平仓'
export const SIGNAL_TRADE_DEADLINE_MS = 10_000
export const TELEGRAM_PUBLICATION_FRESHNESS_MS = 15_000
export const MAX_SIGNAL_HISTORY = 300
export const MAX_NOTIFICATION_HISTORY = 50
