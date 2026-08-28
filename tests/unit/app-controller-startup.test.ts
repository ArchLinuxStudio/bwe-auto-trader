import { EventEmitter } from 'node:events'
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

import { AppController, type AppControllerOptions } from '../../src/main/app-controller'
import type {
  ChatGptService,
  ChatGptServiceStatus
} from '../../src/main/services/chatgpt'
import type {
  OkxAccountVerification,
  OkxPrivateStream,
  OkxV5Client
} from '../../src/main/services/okx'
import { SecretStore } from '../../src/main/services/secret-store'
import { SettingsStore } from '../../src/main/services/settings-store'
import type { TelegramMonitor } from '../../src/main/services/telegram'
import type { TelegramMonitorOptions } from '../../src/main/services/telegram'

const TELEGRAM_CREDENTIALS_KEY = 'telegram.credentials.v1'
const OKX_CREDENTIALS_KEY = 'okx.credentials.v1'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('AppController startup connection restoration', () => {
  it('does nothing when no persisted service is configured', async () => {
    const createTelegramMonitor = vi.fn()
    const createChatGptService = vi.fn()
    const createOkxClient = vi.fn()
    const openExternal = vi.fn(async () => undefined)
    const controller = await createController({
      openExternal,
      createTelegramMonitor,
      createChatGptService,
      createOkxClient
    })

    await controller.restoreConfiguredServices()

    expect(createTelegramMonitor).not.toHaveBeenCalled()
    expect(createChatGptService).not.toHaveBeenCalled()
    expect(createOkxClient).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
    expect(controller.getSnapshot().safety).toEqual(expect.objectContaining({
      monitoring: false,
      liveArmed: false
    }))
    await controller.dispose()
  })

  it('restores all three services and starts monitoring only after Telegram start completes', async () => {
    const userDataDirectory = await createTemporaryDirectory()
    await seedConfiguration(userDataDirectory, {
      telegram: true,
      chatgpt: true,
      okx: true
    })
    const telegramStart = deferred<void>()
    const telegram = createTelegramMonitor(telegramStart.promise)
    const chatgpt = createChatGptService(connectedChatGptStatus())
    const okx = createOkxClient()
    const openExternal = vi.fn(async () => undefined)
    const controller = await createController({
      userDataDirectory,
      openExternal,
      createTelegramMonitor: vi.fn(() => telegram.monitor),
      createChatGptService: vi.fn(() => chatgpt.service),
      createOkxClient: vi.fn(() => okx.client)
    })

    const restoration = controller.restoreConfiguredServices()
    await telegram.startCalled.promise

    expect(controller.getSnapshot().safety.monitoring).toBe(false)
    telegramStart.resolve()
    await restoration

    const snapshot = controller.getSnapshot()
    expect(snapshot.connections.telegram.phase).toBe('connected')
    expect(snapshot.connections.chatgpt.phase).toBe('connected')
    expect(snapshot.connections.okx.phase).toBe('connected')
    expect(snapshot.safety).toEqual(expect.objectContaining({
      monitoring: true,
      liveArmed: false
    }))
    expect(okx.setLiveTradingArmed).toHaveBeenCalledWith(false)
    expect(okx.setLiveTradingArmed.mock.calls.every(([armed]) => armed === false)).toBe(true)
    expect(openExternal).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('does not start monitoring before the complete OKX verification promise resolves', async () => {
    const userDataDirectory = await createTemporaryDirectory()
    await seedConfiguration(userDataDirectory, {
      telegram: true,
      chatgpt: true,
      okx: true
    })
    const telegram = createTelegramMonitor()
    const chatgpt = createChatGptService(connectedChatGptStatus())
    const verification = deferred<OkxAccountVerification>()
    const okx = createOkxClient(verification.promise)
    const controller = await createController({
      userDataDirectory,
      createTelegramMonitor: vi.fn(() => telegram.monitor),
      createChatGptService: vi.fn(() => chatgpt.service),
      createOkxClient: vi.fn(() => okx.client)
    })

    const restoration = controller.restoreConfiguredServices()
    await okx.verificationStarted.promise
    expect(controller.getSnapshot().safety.monitoring).toBe(false)

    verification.resolve(healthyVerification())
    await restoration
    expect(controller.getSnapshot().safety).toEqual(expect.objectContaining({
      monitoring: true,
      liveArmed: false
    }))
    await controller.dispose()
  })

  it('does not start monitoring after shutdown begins during startup restoration', async () => {
    const userDataDirectory = await createTemporaryDirectory()
    await seedConfiguration(userDataDirectory, {
      telegram: true,
      chatgpt: true,
      okx: true
    })
    const telegramStart = deferred<void>()
    const telegram = createTelegramMonitor(telegramStart.promise)
    const chatgpt = createChatGptService(connectedChatGptStatus())
    const verification = deferred<OkxAccountVerification>()
    const okx = createOkxClient(verification.promise)
    const controller = await createController({
      userDataDirectory,
      createTelegramMonitor: vi.fn(() => telegram.monitor),
      createChatGptService: vi.fn(() => chatgpt.service),
      createOkxClient: vi.fn(() => okx.client)
    })

    const restoration = controller.restoreConfiguredServices()
    await Promise.all([telegram.startCalled.promise, okx.verificationStarted.promise])
    const disposal = controller.dispose()
    telegramStart.resolve()
    verification.resolve(healthyVerification())
    await Promise.all([restoration, disposal])

    expect(telegram.stop).toHaveBeenCalled()
    expect(okx.createPrivateStream).not.toHaveBeenCalled()
    expect(controller.getSnapshot().safety).toEqual(expect.objectContaining({
      monitoring: false,
      liveArmed: false
    }))
    const auditEntries = await (controller as unknown as {
      audit: { readRecent(): Promise<Array<{ event: string }>> }
    }).audit.readRecent()
    expect(auditEntries.map(({ event }) => event)).not.toContain('monitoring_started')
  })

  it('rejects a manual OKX connection queued behind startup when shutdown begins', async () => {
    const userDataDirectory = await createTemporaryDirectory()
    await seedConfiguration(userDataDirectory, {
      telegram: true,
      chatgpt: true,
      okx: true
    })
    const telegram = createTelegramMonitor()
    const chatgpt = createChatGptService(connectedChatGptStatus())
    const verification = deferred<OkxAccountVerification>()
    const okx = createOkxClient(verification.promise)
    const createOkxClientFactory = vi.fn(() => okx.client)
    const controller = await createController({
      userDataDirectory,
      createTelegramMonitor: vi.fn(() => telegram.monitor),
      createChatGptService: vi.fn(() => chatgpt.service),
      createOkxClient: createOkxClientFactory
    })

    const restoration = controller.restoreConfiguredServices()
    await okx.verificationStarted.promise
    const manualOutcome = controller.connectOkx().then(
      () => 'resolved',
      () => 'rejected'
    )
    const disposal = controller.dispose()
    verification.resolve(healthyVerification())
    await Promise.all([restoration, disposal])

    expect(await manualOutcome).toBe('rejected')
    expect(createOkxClientFactory).toHaveBeenCalledOnce()
    expect(okx.setLiveTradingArmed.mock.calls.every(([armed]) => armed === false)).toBe(true)
    expect(controller.getSnapshot().safety).toEqual(expect.objectContaining({
      monitoring: false,
      liveArmed: false
    }))
  })

  it('connects only persisted services when configuration is partial without starting monitoring', async () => {
    const userDataDirectory = await createTemporaryDirectory()
    await seedConfiguration(userDataDirectory, {
      telegram: true,
      chatgpt: true
    })
    const telegram = createTelegramMonitor()
    const chatgpt = createChatGptService(connectedChatGptStatus())
    const createTelegramMonitorFactory = vi.fn(() => telegram.monitor)
    const createChatGptServiceFactory = vi.fn(() => chatgpt.service)
    const createOkxClientFactory = vi.fn()
    const controller = await createController({
      userDataDirectory,
      createTelegramMonitor: createTelegramMonitorFactory,
      createChatGptService: createChatGptServiceFactory,
      createOkxClient: createOkxClientFactory
    })

    await controller.restoreConfiguredServices()

    const snapshot = controller.getSnapshot()
    expect(createTelegramMonitorFactory).toHaveBeenCalledOnce()
    expect(createChatGptServiceFactory).toHaveBeenCalledOnce()
    expect(createOkxClientFactory).not.toHaveBeenCalled()
    expect(snapshot.connections.telegram.phase).toBe('connected')
    expect(snapshot.connections.chatgpt.phase).toBe('connected')
    expect(snapshot.connections.okx.phase).toBe('not_configured')
    expect(snapshot.safety.monitoring).toBe(false)
    expect(snapshot.safety.liveArmed).toBe(false)
    await controller.dispose()
  })

  it('clears a stale ChatGPT startup hint without opening login or starting monitoring', async () => {
    const userDataDirectory = await createTemporaryDirectory()
    await seedConfiguration(userDataDirectory, {
      telegram: true,
      chatgpt: true,
      okx: true
    })
    const telegram = createTelegramMonitor()
    const chatgpt = createChatGptService({
      ...connectedChatGptStatus(),
      authenticated: false,
      warmedUp: false,
      selectedModel: null
    })
    const okx = createOkxClient()
    const openExternal = vi.fn(async () => undefined)
    const controller = await createController({
      userDataDirectory,
      openExternal,
      createTelegramMonitor: vi.fn(() => telegram.monitor),
      createChatGptService: vi.fn(() => chatgpt.service),
      createOkxClient: vi.fn(() => okx.client)
    })

    await controller.restoreConfiguredServices()

    const snapshot = controller.getSnapshot()
    expect(snapshot.settings.chatgptConfigured).toBe(false)
    expect(snapshot.connections.chatgpt.phase).toBe('error')
    expect(snapshot.safety.monitoring).toBe(false)
    expect(snapshot.safety.liveArmed).toBe(false)
    expect(chatgpt.startBrowserLogin).not.toHaveBeenCalled()
    expect(chatgpt.startDeviceCodeLogin).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
    expect(chatgpt.close).toHaveBeenCalledOnce()
    await controller.dispose()
  })

  it('keeps monitoring stopped when a configured OKX connection fails verification', async () => {
    const userDataDirectory = await createTemporaryDirectory()
    await seedConfiguration(userDataDirectory, {
      telegram: true,
      chatgpt: true,
      okx: true
    })
    const telegram = createTelegramMonitor()
    const chatgpt = createChatGptService(connectedChatGptStatus())
    const okx = createOkxClient(Promise.resolve({
      ...healthyVerification(),
      ok: false,
      errors: ['mock verification rejected']
    }))
    const controller = await createController({
      userDataDirectory,
      createTelegramMonitor: vi.fn(() => telegram.monitor),
      createChatGptService: vi.fn(() => chatgpt.service),
      createOkxClient: vi.fn(() => okx.client)
    })

    await controller.restoreConfiguredServices()

    const snapshot = controller.getSnapshot()
    expect(snapshot.connections.telegram.phase).toBe('connected')
    expect(snapshot.connections.chatgpt.phase).toBe('connected')
    expect(snapshot.connections.okx.phase).toBe('error')
    expect(snapshot.safety).toEqual(expect.objectContaining({
      monitoring: false,
      liveArmed: false
    }))
    expect(okx.setLiveTradingArmed.mock.calls.every(([armed]) => armed === false)).toBe(true)
    await controller.dispose()
  })

  it('keeps raw Telegram and ChatGPT startup failures out of public state and audit data', async () => {
    const userDataDirectory = await createTemporaryDirectory()
    await seedConfiguration(userDataDirectory, {
      telegram: true,
      chatgpt: true
    })
    const rawFailure = 'startup failed with mock-private-secret-value'
    const telegramStart = deferred<void>()
    const telegram = createTelegramMonitor(telegramStart.promise)
    let telegramOptions!: TelegramMonitorOptions
    const chatgpt = createChatGptService({
      ...connectedChatGptStatus(),
      initialized: false,
      authenticated: false,
      warmedUp: false,
      selectedModel: null,
      lastError: rawFailure
    })
    ;(chatgpt.service.start as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error(rawFailure))
    const controller = await createController({
      userDataDirectory,
      createTelegramMonitor: vi.fn((options) => {
        telegramOptions = options
        return telegram.monitor
      }),
      createChatGptService: vi.fn(() => chatgpt.service)
    })

    const restoration = controller.restoreConfiguredServices()
    await telegram.startCalled.promise
    telegramOptions.callbacks?.onStatus?.({
      state: 'error',
      at: new Date().toISOString(),
      detail: rawFailure
    })
    telegramStart.reject(new Error(rawFailure))
    await restoration

    const publicState = JSON.stringify(controller.getSnapshot())
    const auditEntries = await (controller as unknown as {
      audit: { readRecent(): Promise<unknown[]> }
    }).audit.readRecent()
    expect(publicState).not.toContain(rawFailure)
    expect(JSON.stringify(auditEntries)).not.toContain(rawFailure)
    expect(controller.getSnapshot().notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ detail: expect.stringContaining('请在程序内检查已保存配置') }),
      expect.objectContaining({ detail: expect.stringContaining('Telegram 自动连接未完成') })
    ]))
    await controller.dispose()
  })

  it('shares one Telegram connection task across concurrent startup and manual requests', async () => {
    const userDataDirectory = await createTemporaryDirectory()
    await seedConfiguration(userDataDirectory, { telegram: true })
    const start = deferred<void>()
    const telegram = createTelegramMonitor(start.promise)
    const createTelegramMonitorFactory = vi.fn(() => telegram.monitor)
    const controller = await createController({
      userDataDirectory,
      createTelegramMonitor: createTelegramMonitorFactory
    })

    const firstRestore = controller.restoreConfiguredServices()
    const secondRestore = controller.restoreConfiguredServices()
    const manualConnect = controller.connectTelegram()
    await telegram.startCalled.promise

    expect(secondRestore).toBe(firstRestore)
    expect(createTelegramMonitorFactory).toHaveBeenCalledOnce()
    expect(telegram.start).toHaveBeenCalledOnce()

    start.resolve()
    await Promise.all([firstRestore, secondRestore, manualConnect])
    expect(controller.getSnapshot().connections.telegram.phase).toBe('connected')
    await controller.dispose()
  })

  it('lets a manual ChatGPT login supersede startup restoration without late state overwrite', async () => {
    const userDataDirectory = await createTemporaryDirectory()
    await seedConfiguration(userDataDirectory, {
      telegram: true,
      chatgpt: true,
      okx: true
    })
    const telegram = createTelegramMonitor()
    const startupChatGpt = createChatGptService({
      ...connectedChatGptStatus(),
      initialized: false,
      authenticated: false,
      warmedUp: false,
      selectedModel: null
    })
    const startupBegin = deferred<void>()
    const startupFinish = deferred<void>()
    ;(startupChatGpt.service.start as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        startupBegin.resolve()
        return startupFinish.promise
      })
    const manualChatGpt = createChatGptService(connectedChatGptStatus())
    const createChatGptServiceFactory = vi.fn()
      .mockReturnValueOnce(startupChatGpt.service)
      .mockReturnValueOnce(manualChatGpt.service)
    const okx = createOkxClient()
    const openExternal = vi.fn(async () => undefined)
    const controller = await createController({
      userDataDirectory,
      openExternal,
      createTelegramMonitor: vi.fn(() => telegram.monitor),
      createChatGptService: createChatGptServiceFactory,
      createOkxClient: vi.fn(() => okx.client)
    })

    const restoration = controller.restoreConfiguredServices()
    await startupBegin.promise
    const manualLogin = controller.loginChatGpt()
    startupFinish.reject(new Error('late startup failure'))
    await Promise.all([restoration, manualLogin])

    const snapshot = controller.getSnapshot()
    expect(createChatGptServiceFactory).toHaveBeenCalledTimes(2)
    expect(snapshot.connections.chatgpt.phase).toBe('connected')
    expect(snapshot.safety).toEqual(expect.objectContaining({
      monitoring: false,
      liveArmed: false
    }))
    expect(openExternal).not.toHaveBeenCalled()
    expect(snapshot.notifications).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'ChatGPT 自动连接未完成' })
    ]))
    await controller.dispose()
  })

  it('does not open a late ChatGPT login URL after shutdown begins', async () => {
    const startCalled = deferred<void>()
    const startFinish = deferred<void>()
    const chatgpt = createChatGptService({
      ...connectedChatGptStatus(),
      initialized: false,
      authenticated: false,
      warmedUp: false,
      selectedModel: null
    })
    ;(chatgpt.service.start as unknown as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        startCalled.resolve()
        return startFinish.promise
      })
    const openExternal = vi.fn(async () => undefined)
    const controller = await createController({
      openExternal,
      createChatGptService: vi.fn(() => chatgpt.service)
    })

    const loginOutcome = controller.loginChatGpt().then(
      () => 'resolved',
      () => 'rejected'
    )
    await startCalled.promise
    const disposal = controller.dispose()
    startFinish.resolve()
    await disposal

    expect(await loginOutcome).toBe('rejected')
    expect(chatgpt.startBrowserLogin).not.toHaveBeenCalled()
    expect(chatgpt.startDeviceCodeLogin).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('cancels a Telegram connection while credentials are being read without creating a late monitor', async () => {
    const userDataDirectory = await createTemporaryDirectory()
    await seedConfiguration(userDataDirectory, { telegram: true })
    const createTelegramMonitorFactory = vi.fn()
    const controller = await createController({
      userDataDirectory,
      createTelegramMonitor: createTelegramMonitorFactory
    })
    const credentialRead = deferred<string | undefined>()
    const credentialReadStarted = deferred<void>()
    const internals = controller as unknown as {
      secretStore: { get(key: string): Promise<string | undefined> }
    }
    internals.secretStore.get = vi.fn(async () => {
      credentialReadStarted.resolve()
      return credentialRead.promise
    })

    const connect = controller.connectTelegram()
    await credentialReadStarted.promise
    const disconnect = controller.disconnectTelegram()
    credentialRead.resolve(JSON.stringify({
      apiHash: 'mock-api-hash',
      phoneNumber: '+10000000000'
    }))
    await Promise.all([connect, disconnect])

    expect(createTelegramMonitorFactory).not.toHaveBeenCalled()
    expect(controller.getSnapshot().connections.telegram.phase).toBe('disconnected')
    expect(controller.getSnapshot().safety.monitoring).toBe(false)
    await controller.dispose()
  })

  it('stops a Telegram monitor disconnected during start and never publishes it as connected', async () => {
    const userDataDirectory = await createTemporaryDirectory()
    await seedConfiguration(userDataDirectory, { telegram: true })
    const start = deferred<void>()
    const telegram = createTelegramMonitor(start.promise)
    const controller = await createController({
      userDataDirectory,
      createTelegramMonitor: vi.fn(() => telegram.monitor)
    })
    const connectedPhases: string[] = []
    const unsubscribe = controller.onAppEvent((event) => {
      if (event.type === 'snapshot') connectedPhases.push(event.payload.connections.telegram.phase)
    })

    const connect = controller.connectTelegram()
    await telegram.startCalled.promise
    const phaseCountBeforeDisconnect = connectedPhases.length
    const disconnect = controller.disconnectTelegram()
    await telegram.stopCalled.promise
    start.resolve()
    await Promise.all([connect, disconnect])

    expect(telegram.stop).toHaveBeenCalled()
    expect(controller.getSnapshot().connections.telegram.phase).toBe('disconnected')
    expect(connectedPhases.slice(phaseCountBeforeDisconnect)).not.toContain('connected')
    unsubscribe()
    await controller.dispose()
  })

  it('does not wait indefinitely for an obsolete Telegram start during disconnect or shutdown', async () => {
    const userDataDirectory = await createTemporaryDirectory()
    await seedConfiguration(userDataDirectory, { telegram: true })
    const neverFinishes = new Promise<void>(() => undefined)
    const telegram = createTelegramMonitor(neverFinishes)
    const controller = await createController({
      userDataDirectory,
      createTelegramMonitor: vi.fn(() => telegram.monitor)
    })

    void controller.restoreConfiguredServices()
    await telegram.startCalled.promise
    const disconnectResult = await Promise.race([
      controller.disconnectTelegram().then(() => 'disconnected'),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 1_000))
    ])
    expect(disconnectResult).toBe('disconnected')

    const shutdownResult = await Promise.race([
      controller.dispose().then(() => 'disposed'),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 1_000))
    ])
    expect(shutdownResult).toBe('disposed')
    expect(controller.getSnapshot().safety).toEqual(expect.objectContaining({
      monitoring: false,
      liveArmed: false
    }))
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'bwe-controller-startup-'))
  temporaryDirectories.push(directory)
  return directory
}

async function createController(
  options: Partial<AppControllerOptions> & { userDataDirectory?: string } = {}
): Promise<AppController> {
  const userDataDirectory = options.userDataDirectory ?? await createTemporaryDirectory()
  const controller = new AppController({
    userDataDirectory,
    version: 'test',
    openExternal: async () => undefined,
    ...options
  })
  await controller.initialize()
  return controller
}

async function seedConfiguration(
  userDataDirectory: string,
  configured: { telegram?: boolean; chatgpt?: boolean; okx?: boolean }
): Promise<void> {
  const settingsStore = new SettingsStore(userDataDirectory)
  await settingsStore.setFlags({
    telegramConfigured: configured.telegram === true,
    chatgptConfigured: configured.chatgpt === true,
    okxConfigured: configured.okx === true,
    ...(configured.telegram
      ? {
          telegramApiId: 12345,
          telegramPhoneHint: '+1*******000'
        }
      : {})
  })
  const secretStore = new SecretStore(userDataDirectory)
  if (configured.telegram) {
    await secretStore.set(TELEGRAM_CREDENTIALS_KEY, JSON.stringify({
      apiHash: 'mock-api-hash',
      phoneNumber: '+10000000000'
    }))
  }
  if (configured.okx) {
    await secretStore.set(OKX_CREDENTIALS_KEY, JSON.stringify({
      apiKey: 'mock-api-key',
      secretKey: 'mock-secret-key',
      passphrase: 'mock-passphrase'
    }))
  }
}

function createTelegramMonitor(startPromise: Promise<void> = Promise.resolve()) {
  const startCalled = deferred<void>()
  const stopCalled = deferred<void>()
  const monitor = {
    state: 'idle',
    channelUsername: 'BWEnews',
    liveTradingReadiness: { ready: true, revision: 0 },
    start: vi.fn(async () => {
      startCalled.resolve()
      await startPromise
    }),
    stop: vi.fn(async () => {
      stopCalled.resolve()
    }),
    cancelAuthentication: vi.fn(),
    provideAuth: vi.fn(() => false)
  } as unknown as TelegramMonitor
  return {
    monitor,
    start: monitor.start as unknown as ReturnType<typeof vi.fn>,
    stop: monitor.stop as unknown as ReturnType<typeof vi.fn>,
    startCalled,
    stopCalled
  }
}

function connectedChatGptStatus(): ChatGptServiceStatus {
  return {
    initialized: true,
    authenticated: true,
    busy: false,
    warmedUp: true,
    account: null,
    selectedModel: 'mock-model',
    reasoningEffort: 'low',
    rateLimits: null,
    quotaExhausted: false,
    lastError: null
  }
}

function createChatGptService(status: ChatGptServiceStatus) {
  const startBrowserLogin = vi.fn()
  const startDeviceCodeLogin = vi.fn()
  const close = vi.fn(async () => undefined)
  const service = {
    start: vi.fn(async () => undefined),
    getStatus: vi.fn(() => structuredClone(status)),
    onStatus: vi.fn(() => vi.fn()),
    listModels: vi.fn(async () => []),
    warmUp: vi.fn(async () => true),
    close,
    logout: vi.fn(async () => undefined),
    startBrowserLogin,
    startDeviceCodeLogin
  } as unknown as ChatGptService
  return {
    service,
    close,
    startBrowserLogin,
    startDeviceCodeLogin
  }
}

function createOkxClient(
  verification: Promise<OkxAccountVerification> = Promise.resolve(healthyVerification())
) {
  const stream = Object.assign(new EventEmitter(), {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn()
  }) as unknown as OkxPrivateStream
  const setLiveTradingArmed = vi.fn()
  const createPrivateStream = vi.fn(() => stream)
  const verificationStarted = deferred<void>()
  const client = {
    get restRouteSelection() { return { route: 'direct' as const } },
    get privateWebSocketRouteSelection() { return { route: 'direct' as const } },
    get requiresOrderReconciliation() { return false },
    get isLiveTradingArmed() { return false },
    verifyAccountConfiguration: vi.fn(async () => {
      verificationStarted.resolve()
      return verification
    }),
    setLiveTradingArmed,
    getInstruments: vi.fn(async () => []),
    getPositions: vi.fn(async () => []),
    getPendingOrders: vi.fn(async () => []),
    getPendingAlgoOrders: vi.fn(async () => []),
    getOrder: vi.fn(async () => undefined),
    createPrivateStream
  } as unknown as OkxV5Client
  return { client, stream, setLiveTradingArmed, createPrivateStream, verificationStarted }
}

function healthyVerification(): OkxAccountVerification {
  return {
    ok: true,
    config: {
      acctLv: '2',
      posMode: 'net_mode',
      perm: 'read_only,trade',
      type: '1',
      uid: 'mock-sub-account-uid',
      ip: ''
    },
    checks: {
      hasReadPermission: true,
      hasTradePermission: true,
      hasNoWithdrawPermission: true,
      isSubAccount: true,
      isNetPositionMode: true,
      supportsDerivatives: true,
      supportsIsolatedSwapTrading: true,
      hasNoPendingSwapOrders: true
    },
    pendingSwapOrders: [],
    errors: [],
    warnings: []
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
