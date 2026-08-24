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

const telegramHarness = vi.hoisted(() => ({ options: undefined as unknown }))

vi.mock('../../src/main/services/telegram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/telegram')>()

  class FakeTelegramMonitor {
    readonly channelUsername: string
    state = 'idle'
    private recoveryRevision = 0

    constructor(
      private readonly options: import('../../src/main/services/telegram').TelegramMonitorOptions
    ) {
      telegramHarness.options = options
      this.channelUsername = options.channel ?? 'BWEnews'
    }

    get liveTradingReadiness(): import('../../src/main/services/telegram').TelegramLiveTradingReadiness {
      return { ready: this.state === 'connected', revision: this.recoveryRevision }
    }

    async start(): Promise<void> {
      this.state = 'connected'
    }

    async stop(): Promise<void> {
      this.state = 'stopped'
      this.recoveryRevision += 1
    }

    cancelAuthentication(): void {}

    provideAuth(): boolean {
      return false
    }
  }

  return { ...actual, TelegramMonitor: FakeTelegramMonitor }
})

import { AppController } from '../../src/main/app-controller'
import type { TradingSignalAnalysis } from '../../src/main/services/chatgpt'
import type {
  TelegramMonitorOptions,
  TelegramSignalMessage
} from '../../src/main/services/telegram'

const temporaryDirectories: string[] = []

afterEach(async () => {
  telegramHarness.options = undefined
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('AppController Telegram early visibility wiring', () => {
  it('publishes an observed message immediately, then reuses it for canonical AI without trading', async () => {
    const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'bwe-controller-telegram-'))
    temporaryDirectories.push(userDataDirectory)
    const analyzeSignal = vi.fn(async (): Promise<TradingSignalAnalysis> => ({
      symbols: ['BTC'],
      decision: 'LONG',
      confidence: 0.95,
      reason: 'test signal',
      status: 'ok',
      model: 'test-model',
      latencyMs: 1,
      analyzedAt: new Date().toISOString()
    }))
    const controller = new AppController({
      userDataDirectory,
      version: 'test',
      openExternal: async () => undefined,
      analyzeSignal
    })
    await controller.initialize()
    await controller.saveTelegramCredentials({
      apiId: 12345,
      apiHash: '0123456789abcdef0123456789abcdef',
      phoneNumber: '+10000000000'
    })
    await controller.connectTelegram()

    const options = telegramHarness.options as TelegramMonitorOptions
    expect(options.callbacks?.onMessageObserved).toBeTypeOf('function')
    expect(options.callbacks?.onMessage).toBeTypeOf('function')
    ;(controller as unknown as { monitoring: boolean }).monitoring = true

    const timestamp = new Date().toISOString()
    const observed: TelegramSignalMessage = {
      channelUsername: 'BWEnews',
      channelId: 'channel-1',
      channelTitle: 'BWEnews',
      messageId: 7001,
      text: 'BTC test signal',
      publishedAt: timestamp,
      receivedAt: timestamp,
      url: 'https://t.me/BWEnews/7001',
      hasMedia: false,
      recovered: true
    }

    await options.callbacks!.onMessageObserved!(observed)

    expect(controller.getSnapshot().signals).toEqual([
      expect.objectContaining({
        id: 'channel-1:7001',
        stage: 'received',
        telegram: expect.objectContaining({ recovered: true })
      })
    ])
    expect(analyzeSignal).not.toHaveBeenCalled()

    await options.callbacks!.onMessage!({ ...observed, recovered: false }, {})

    expect(controller.getSnapshot().signals).toEqual([
      expect.objectContaining({
        id: 'channel-1:7001',
        stage: 'skipped',
        telegram: expect.objectContaining({ recovered: true }),
        analysis: expect.objectContaining({ decision: 'LONG' })
      })
    ])
    expect(analyzeSignal).toHaveBeenCalledOnce()
  })

  it('terminally skips an observed message when emergency stop abandons recovery', async () => {
    const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'bwe-controller-telegram-stop-'))
    temporaryDirectories.push(userDataDirectory)
    const analyzeSignal = vi.fn(async (): Promise<TradingSignalAnalysis> => ({
      symbols: [],
      decision: 'SKIP',
      confidence: 0,
      reason: 'should not run',
      status: 'skipped',
      model: 'test-model',
      latencyMs: 1,
      analyzedAt: new Date().toISOString()
    }))
    const controller = new AppController({
      userDataDirectory,
      version: 'test',
      openExternal: async () => undefined,
      analyzeSignal
    })
    await controller.initialize()
    await controller.saveTelegramCredentials({
      apiId: 12345,
      apiHash: '0123456789abcdef0123456789abcdef',
      phoneNumber: '+10000000000'
    })
    await controller.connectTelegram()
    ;(controller as unknown as { monitoring: boolean }).monitoring = true

    const options = telegramHarness.options as TelegramMonitorOptions
    const timestamp = new Date().toISOString()
    const observed: TelegramSignalMessage = {
      channelUsername: 'BWEnews',
      channelId: 'channel-1',
      messageId: 7002,
      text: 'message waiting for recovery',
      publishedAt: timestamp,
      receivedAt: timestamp,
      url: 'https://t.me/BWEnews/7002',
      hasMedia: false,
      recovered: true
    }
    await options.callbacks!.onMessageObserved!(observed)

    await controller.emergencyStop()

    expect(controller.getSnapshot().signals).toEqual([
      expect.objectContaining({
        id: 'channel-1:7002',
        stage: 'skipped',
        detail: expect.stringContaining('紧急停止')
      })
    ])
    await options.callbacks!.onMessage!(observed, {})
    expect(controller.getSnapshot().signals).toHaveLength(1)
    expect(analyzeSignal).not.toHaveBeenCalled()
  })
})
