import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateConnectionState } from 'teleproto/network/index.js'

import {
  TelegramMonitor,
  type TelegramMessageDispatchContext,
  type TelegramMonitorOptions,
  type TelegramStatusEvent,
} from '../src/main/services/telegram'
import {
  toTelegramMessagePayload,
  type TelegramSignalMessage,
} from '../src/main/services/telegram-message'
import {
  SignalCoordinator,
  type SignalSafetySnapshot,
  type SignalTradeAuthorizationToken,
} from '../src/main/services/signal-coordinator'

interface TelegramMonitorHarness {
  processingTail: Promise<void>
  bufferingInitialMessages: boolean
  initialMessageBuffer: Array<{
    raw: unknown
    receivedAt: Date
    recovered: boolean
  }>
  disconnectedChecks: number
  startupBaselineId: number
  lastSeenMessageId: number
  stopRequested: boolean
  reconnecting: boolean
  recoveryPending: boolean
  recoveryFromMessageId?: number
  recoveryPromise?: Promise<void>
  liveTradingReadiness: { ready: boolean; revision: number }
  stateValue: 'idle' | 'connected' | 'reconnecting'
  client?: {
    connected: boolean
    getMessages: (...args: unknown[]) => Promise<unknown[]>
    connect?: () => Promise<void>
    disconnect?: () => Promise<void>
    checkAuthorization?: () => Promise<boolean>
    addEventHandler?: (...args: unknown[]) => void
    destroy?: () => Promise<void>
    session?: { save(): string }
  }
  channelEntity?: object
  createClient(storedSession: string, proxyProtocol: 'socks5' | 'http'): unknown
  connectWithProxyFallback(storedSession: string): Promise<unknown>
  enqueueRawMessage(raw: unknown, receivedAt?: Date, recovered?: boolean): Promise<void>
  handleNewMessageEvent(event: unknown): Promise<void>
  catchUpMessages(fromMessageId?: number): Promise<void>
  healthCheck(): Promise<void>
  startHealthTimer(): void
  clearHealthTimer(): void
  installConnectionStateHandler(client: unknown): void
  connectionEventHandler?: (event: unknown) => void
}

function createMonitor(
  onMessage: (
    message: TelegramSignalMessage,
    context: TelegramMessageDispatchContext,
  ) => void | Promise<void>,
  onError?: (error: { message: string }) => void | Promise<void>,
  onStatus?: (status: TelegramStatusEvent) => void | Promise<void>,
  monitorOptions: Partial<Pick<
    TelegramMonitorOptions,
    | 'catchUpLimit'
    | 'healthCheckIntervalMs'
    | 'healthProbeTimeoutMs'
    | 'stopDrainTimeoutMs'
    | 'captureAuthorization'
  >> = {},
  onMessageObserved?: (message: TelegramSignalMessage) => void | Promise<void>,
): { monitor: TelegramMonitor; harness: TelegramMonitorHarness } {
  const monitor = new TelegramMonitor({
    apiId: 1,
    apiHash: 'test-hash',
    secretStore: {
      get: async () => undefined,
      set: async () => undefined,
    },
    callbacks: { onMessage, onMessageObserved, onError, onStatus },
    ...monitorOptions,
  })

  return {
    monitor,
    harness: monitor as unknown as TelegramMonitorHarness,
  }
}

function flushMessageDispatches(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('TelegramMonitor message dispatch', () => {
  it.each([
    ['locked', false],
    ['an older arm epoch', true],
  ])('never authorizes a queued message received while %s', async (_label, initiallyArmed) => {
    const now = 1_700_000_000_000
    const monitorIdentity = {}
    const makeToken = (revision: number): SignalTradeAuthorizationToken => ({
      capability: {},
      armRevision: revision,
      monitoringRevision: 1,
      telegramLifecycleRevision: 1,
      telegramRecoveryRevision: 0,
      telegramMonitor: monitorIdentity,
    })
    const oldToken = makeToken(1)
    const newToken = makeToken(3)
    let capturedToken = initiallyArmed ? oldToken : undefined
    const safety: SignalSafetySnapshot = {
      monitoring: true,
      liveArmed: initiallyArmed,
      authorizationToken: capturedToken,
      okxConnected: true,
      emergencyStopped: false,
      positionCloseInProgress: false,
    }
    const openTrade = vi.fn(async () => ({
      instrumentId: 'ABC-USDT-SWAP',
      orderId: 'order-1',
      clientOrderId: 'client-1',
    }))
    const coordinator = new SignalCoordinator({
      now: () => now,
      settings: () => ({
        channelUsername: 'BWEnews',
        orderNotionalUsdt: 10,
        leverage: 1,
        cooldownMinutes: 60,
        aiTimeoutMs: 10_000,
        maxConcurrentPositions: 1,
        marginMode: 'isolated',
        positionMode: 'net',
      }),
      safety: () => safety,
      analyze: async () => ({
        symbols: ['ABC'],
        decision: 'LONG',
        confidence: 0.9,
        reason: 'listing',
        status: 'ok',
        model: 'test-fast',
        latencyMs: 1,
        analyzedAt: new Date(now).toISOString(),
      }),
      readPositions: async () => [],
      openTrade,
      onRecord: () => undefined,
    })
    let finalStage: string | undefined
    const { harness } = createMonitor(
      async (message, context) => {
        finalStage = (await coordinator.process(
          toTelegramMessagePayload(message),
          context.authorizationToken,
        ))?.stage
      },
      undefined,
      undefined,
      { captureAuthorization: () => capturedToken },
    )
    harness.channelEntity = {}
    let releaseQueue!: () => void
    harness.processingTail = new Promise<void>((resolve) => {
      releaseQueue = resolve
    })

    await harness.handleNewMessageEvent({
      message: { id: initiallyArmed ? 702 : 701, message: 'Coinbase will list ABC', date: now / 1_000 },
    })
    // Simulate arm/re-arm after the transport received the update but before
    // its FIFO and setImmediate callback can start.
    capturedToken = newToken
    safety.liveArmed = true
    safety.authorizationToken = newToken
    releaseQueue()
    await harness.processingTail
    await vi.waitFor(() => expect(finalStage).toBe('blocked'))

    expect(openTrade).not.toHaveBeenCalled()
  })

  it('captures receivedAt when the update enters the ordered queue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-14T01:00:00.000Z'))

    let releaseQueue!: () => void
    const queueBarrier = new Promise<void>((resolve) => {
      releaseQueue = resolve
    })
    const delivered: TelegramSignalMessage[] = []
    const { harness } = createMonitor((message) => {
      delivered.push(message)
    })
    harness.processingTail = queueBarrier

    const operation = harness.enqueueRawMessage({
      id: 101,
      message: 'BTC ETF approved',
      date: 1_786_665_590,
    })
    vi.setSystemTime(new Date('2026-08-14T01:00:09.000Z'))
    releaseQueue()

    await operation
    await flushMessageDispatches()

    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.receivedAt).toBe('2026-08-14T01:00:00.000Z')
    expect(delivered[0]?.recovered).toBe(false)
  })

  it('starts later callbacks without waiting for an earlier AI callback', async () => {
    let releaseFirst!: () => void
    const firstCallbackBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const callbackStarts: number[] = []
    const { harness } = createMonitor(async (message) => {
      callbackStarts.push(message.messageId)
      if (message.messageId === 1) {
        await firstCallbackBarrier
      }
    })

    await Promise.all([
      harness.enqueueRawMessage(
        { id: 1, message: 'first', date: 1_786_665_590 },
        new Date('2026-08-14T01:00:00.000Z'),
      ),
      harness.enqueueRawMessage(
        { id: 2, message: 'second', date: 1_786_665_591 },
        new Date('2026-08-14T01:00:01.000Z'),
      ),
    ])
    await flushMessageDispatches()

    expect(callbackStarts).toEqual([1, 2])
    releaseFirst()
    await flushMessageDispatches()
  })

  it('isolates callback failures and continues dispatching later messages', async () => {
    const callbackStarts: number[] = []
    const errors: string[] = []
    const { harness } = createMonitor(
      async (message) => {
        callbackStarts.push(message.messageId)
        if (message.messageId === 1) throw new Error('AI callback failed')
      },
      (error) => {
        errors.push(error.message)
      },
    )

    await harness.enqueueRawMessage({ id: 1, message: 'first', date: 1_786_665_590 })
    await harness.enqueueRawMessage({ id: 2, message: 'second', date: 1_786_665_591 })
    await flushMessageDispatches()
    await Promise.resolve()

    expect(callbackStarts).toEqual([1, 2])
    expect(errors).toContain('AI callback failed')
  })

  it('preserves an old Telegram publication time during reconnect catch-up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-14T01:00:00.000Z'))
    const delivered: TelegramSignalMessage[] = []
    const { harness } = createMonitor((message) => {
      delivered.push(message)
    })
    harness.channelEntity = {}
    harness.client = {
      connected: true,
      getMessages: vi.fn().mockResolvedValue([
        {
          id: 77,
          message: 'old reconnect post',
          date: 1_786_579_200,
        },
      ]),
    }

    await harness.catchUpMessages(76)
    await flushMessageDispatches()

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      messageId: 77,
      publishedAt: '2026-08-13T00:00:00.000Z',
      receivedAt: '2026-08-14T01:00:00.000Z',
      recovered: true,
    })
  })

  it('detects a missed target-channel push within the default five-second poll', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date('2026-08-26T01:00:00.000Z'))
    let releaseCatchUp!: (messages: unknown[]) => void
    const catchUp = new Promise<unknown[]>((resolve) => {
      releaseCatchUp = resolve
    })
    const observed: TelegramSignalMessage[] = []
    const delivered: TelegramSignalMessage[] = []
    const dispatchTokens: Array<SignalTradeAuthorizationToken | undefined> = []
    const statuses: string[] = []
    const authorizationToken: SignalTradeAuthorizationToken = {
      capability: {},
      armRevision: 1,
      monitoringRevision: 1,
      telegramLifecycleRevision: 1,
      telegramRecoveryRevision: 0,
      telegramMonitor: {},
    }
    const missedMessage = {
      id: 101,
      message: 'low-latency cursor recovery',
      date: Math.floor(Date.now() / 1_000),
    }
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce([missedMessage])
      .mockImplementationOnce(() => catchUp)
    const client = {
      connected: true,
      getMessages,
      checkAuthorization: vi.fn(async () => true),
    }
    const aiStartedAt: number[] = []
    const analyze = vi.fn(async () => {
      aiStartedAt.push(Date.now())
      return {
        symbols: ['ABC'],
        decision: 'LONG' as const,
        confidence: 0.9,
        reason: 'listing',
        status: 'ok' as const,
        model: 'test-fast',
        latencyMs: 1,
        analyzedAt: new Date(Date.now()).toISOString(),
      }
    })
    const openTrade = vi.fn(async () => ({
      instrumentId: 'ABC-USDT-SWAP',
      orderId: 'order-1',
      clientOrderId: 'client-1',
    }))
    const coordinator = new SignalCoordinator({
      now: () => Date.now(),
      settings: () => ({
        channelUsername: 'BWEnews',
        orderNotionalUsdt: 10,
        leverage: 1,
        cooldownMinutes: 60,
        aiTimeoutMs: 10_000,
        maxConcurrentPositions: 1,
        marginMode: 'isolated',
        positionMode: 'net',
      }),
      safety: () => ({
        monitoring: true,
        liveArmed: true,
        authorizationToken,
        okxConnected: true,
        emergencyStopped: false,
        positionCloseInProgress: false,
      }),
      analyze,
      readPositions: async () => [],
      openTrade,
      onRecord: () => undefined,
    })
    const { harness } = createMonitor(
      async (message, context) => {
        delivered.push(message)
        dispatchTokens.push(context.authorizationToken)
        await coordinator.process(
          toTelegramMessagePayload(message),
          context.authorizationToken,
        )
      },
      undefined,
      (status) => {
        statuses.push(status.state)
      },
      { captureAuthorization: () => authorizationToken },
      (message) => {
        observed.push(message)
      },
    )
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.startupBaselineId = 100
    harness.lastSeenMessageId = 100
    harness.client = client

    harness.startHealthTimer()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(getMessages).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(observed).toHaveLength(1))
    expect(delivered).toEqual([])
    expect(observed[0]).toMatchObject({
      messageId: 101,
      text: 'low-latency cursor recovery',
      receivedAt: '2026-08-26T01:00:05.000Z',
      recovered: true,
    })

    releaseCatchUp([missedMessage])
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce())
    harness.clearHealthTimer()

    expect(getMessages).toHaveBeenCalledTimes(2)
    expect(getMessages).toHaveBeenNthCalledWith(1, harness.channelEntity, { limit: 1 })
    expect(getMessages).toHaveBeenNthCalledWith(2, harness.channelEntity, {
      limit: 100,
      minId: 100,
      reverse: true,
    })
    expect(client.checkAuthorization).toHaveBeenCalledOnce()
    expect(delivered[0]).toMatchObject({
      messageId: 101,
      text: 'low-latency cursor recovery',
      receivedAt: '2026-08-26T01:00:05.000Z',
      recovered: true,
    })
    expect(statuses).toEqual([])
    expect(harness.liveTradingReadiness.ready).toBe(true)
    expect(aiStartedAt).toHaveLength(1)
    const aiDelayMs = aiStartedAt[0]! - Date.parse('2026-08-26T01:00:00.000Z')
    expect(aiDelayMs).toBeGreaterThanOrEqual(5_000)
    expect(aiDelayMs).toBeLessThanOrEqual(10_000)
    expect(dispatchTokens).toEqual([undefined])
    expect(openTrade).not.toHaveBeenCalled()
  })

  it('merges a multi-message cursor gap with a residual live update in FIFO order', async () => {
    let releaseCatchUp!: (messages: unknown[]) => void
    const catchUp = new Promise<unknown[]>((resolve) => {
      releaseCatchUp = resolve
    })
    const publishedAt = Math.floor(Date.now() / 1_000)
    const messages = [101, 102, 103, 104].map((id) => ({
      id,
      message: `message-${id}`,
      date: publishedAt,
    }))
    const observed: number[] = []
    const delivered: TelegramSignalMessage[] = []
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce([messages[2]])
      .mockImplementationOnce(() => catchUp)
    const { harness } = createMonitor(
      (message) => {
        delivered.push(message)
      },
      undefined,
      undefined,
      {},
      (message) => {
        observed.push(message.messageId)
      },
    )
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.startupBaselineId = 100
    harness.lastSeenMessageId = 100
    harness.client = {
      connected: true,
      getMessages,
      checkAuthorization: vi.fn(async () => true),
    }

    const health = harness.healthCheck()
    await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))
    await harness.handleNewMessageEvent({ message: messages[3] })
    await flushMessageDispatches()
    expect(observed).toEqual([103, 104])

    releaseCatchUp([messages[2], messages[0], messages[1]])
    await health
    await flushMessageDispatches()

    expect(delivered.map((message) => message.messageId)).toEqual([101, 102, 103, 104])
    expect(delivered.every((message) => message.recovered)).toBe(true)
  })

  it('bounds a stalled target-channel health probe', async () => {
    vi.useFakeTimers()
    const errors: string[] = []
    const never = new Promise<unknown[]>(() => undefined)
    const neverReports = new Promise<void>(() => undefined)
    const { harness } = createMonitor(
      () => undefined,
      async (error) => {
        errors.push(error.message)
        await neverReports
      },
    )
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.client = {
      connected: true,
      getMessages: vi.fn(() => never),
      checkAuthorization: vi.fn(async () => true),
    }

    const health = harness.healthCheck()
    await vi.advanceTimersByTimeAsync(3_999)
    expect(harness.recoveryPending).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await health

    expect(errors).toEqual(['Telegram target-channel health probe timed out'])
    expect(harness.recoveryPending).toBe(true)
    expect(harness.liveTradingReadiness.ready).toBe(false)
  })

  it('rebuilds a ghost connection after a target-channel probe timeout', async () => {
    vi.useFakeTimers()
    const never = new Promise<unknown[]>(() => undefined)
    const getMessages = vi.fn().mockImplementationOnce(() => never).mockResolvedValueOnce([])
    const client = {
      connected: true,
      getMessages,
      checkAuthorization: vi.fn(async () => true),
      disconnect: vi.fn(async () => {
        client.connected = false
      }),
      connect: vi.fn(async () => {
        client.connected = true
      }),
    }
    const { harness } = createMonitor(
      () => undefined,
      undefined,
      undefined,
      { healthProbeTimeoutMs: 4_000 },
    )
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.client = client

    const stalledHealth = harness.healthCheck()
    await vi.advanceTimersByTimeAsync(4_000)
    await stalledHealth
    expect(harness.recoveryPending).toBe(true)

    await harness.healthCheck()

    expect(client.disconnect).toHaveBeenCalledOnce()
    expect(client.connect).toHaveBeenCalledOnce()
    expect(getMessages).toHaveBeenCalledTimes(2)
    expect(client.checkAuthorization).toHaveBeenCalledOnce()
    expect(harness.recoveryPending).toBe(false)
    expect(harness.liveTradingReadiness.ready).toBe(true)
  })

  it.each(['catch-up page', 'recovery authorization'] as const)(
    'bounds a stalled %s request and keeps the recovery gate closed',
    async (stage) => {
      vi.useFakeTimers()
      const errors: string[] = []
      const missedMessage = {
        id: 101,
        message: 'bounded recovery request',
        date: Math.floor(Date.now() / 1_000),
      }
      const neverMessages = new Promise<unknown[]>(() => undefined)
      const neverAuthorization = new Promise<boolean>(() => undefined)
      const getMessages = stage === 'catch-up page'
        ? vi.fn().mockResolvedValueOnce([missedMessage]).mockImplementationOnce(() => neverMessages)
        : vi.fn().mockResolvedValueOnce([missedMessage]).mockResolvedValueOnce([missedMessage])
      const checkAuthorization = stage === 'recovery authorization'
        ? vi.fn(() => neverAuthorization)
        : vi.fn(async () => true)
      const { harness } = createMonitor(
        () => undefined,
        (error) => {
          errors.push(error.message)
        },
      )
      harness.stateValue = 'connected'
      harness.channelEntity = {}
      harness.startupBaselineId = 100
      harness.lastSeenMessageId = 100
      harness.client = {
        connected: true,
        getMessages,
        checkAuthorization,
      }

      const health = harness.healthCheck()
      if (stage === 'catch-up page') {
        await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2))
      } else {
        await vi.waitFor(() => expect(checkAuthorization).toHaveBeenCalledOnce())
      }
      await vi.advanceTimersByTimeAsync(4_000)
      await health

      expect(errors).toContain(
        stage === 'catch-up page'
          ? 'Telegram catch-up page timed out'
          : 'Telegram recovery authorization probe timed out',
      )
      expect(harness.recoveryPromise).toBeUndefined()
      expect(harness.recoveryPending).toBe(true)
      expect(harness.liveTradingReadiness.ready).toBe(false)
    },
  )

  it.each(['disconnect', 'connect'] as const)(
    'bounds a stalled forced %s lifecycle step',
    async (stage) => {
      vi.useFakeTimers()
      const neverMessages = new Promise<unknown[]>(() => undefined)
      const neverLifecycle = new Promise<void>(() => undefined)
      const client = {
        connected: true,
        getMessages: vi.fn().mockImplementationOnce(() => neverMessages).mockResolvedValue([]),
        checkAuthorization: vi.fn(async () => true),
        disconnect: vi.fn(async () => {
          if (stage === 'disconnect') await neverLifecycle
          client.connected = false
        }),
        connect: vi.fn(async () => {
          if (stage === 'connect') await neverLifecycle
          client.connected = true
        }),
      }
      const { harness } = createMonitor(() => undefined)
      harness.stateValue = 'connected'
      harness.channelEntity = {}
      harness.client = client

      const stalledProbe = harness.healthCheck()
      await vi.advanceTimersByTimeAsync(4_000)
      await stalledProbe

      const recovery = harness.healthCheck()
      await vi.advanceTimersByTimeAsync(4_000)
      await recovery

      expect(client.disconnect).toHaveBeenCalledOnce()
      expect(client.connect).toHaveBeenCalledTimes(stage === 'connect' ? 1 : 0)
      expect(harness.recoveryPromise).toBeUndefined()
      expect(harness.recoveryPending).toBe(true)
      expect(harness.liveTradingReadiness.ready).toBe(false)
    },
  )

  it('debounces one disconnected sample and recovers the queued message without publishing reconnecting', async () => {
    const delivered: TelegramSignalMessage[] = []
    const statuses: string[] = []
    const { harness } = createMonitor(
      (message) => {
        delivered.push(message)
      },
      undefined,
      (status) => {
        statuses.push(status.state)
      },
    )
    const missedMessage = {
      id: 88,
      message: 'single-sample recovery',
      date: Math.floor(Date.now() / 1_000),
    }
    const client = {
      connected: false,
      getMessages: vi.fn(async () => [missedMessage]),
      checkAuthorization: vi.fn(async () => true),
    }
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.client = client

    await harness.healthCheck()
    expect(harness.disconnectedChecks).toBe(1)
    expect(statuses).toEqual([])

    await harness.enqueueRawMessage(missedMessage)
    await flushMessageDispatches()
    expect(delivered).toEqual([])

    client.connected = true
    await harness.healthCheck()
    await flushMessageDispatches()

    expect(harness.disconnectedChecks).toBe(0)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.messageId).toBe(88)
    expect(delivered[0]?.recovered).toBe(true)
    expect(statuses).toEqual([])
    expect(client.checkAuthorization).toHaveBeenCalledOnce()
  })

  it('shows a recovery-buffered live update before catch-up settles and dispatches it only once', async () => {
    let releaseCatchUp!: (messages: unknown[]) => void
    const catchUpBarrier = new Promise<unknown[]>((resolve) => {
      releaseCatchUp = resolve
    })
    const observed: TelegramSignalMessage[] = []
    const delivered: TelegramSignalMessage[] = []
    const rawMessage = {
      id: 89,
      message: 'recovery-visible immediately',
      date: Math.floor(Date.now() / 1_000),
    }
    const client = {
      connected: true,
      getMessages: vi.fn(() => catchUpBarrier),
      checkAuthorization: vi.fn(async () => true),
      addEventHandler: vi.fn(),
    }
    const { harness } = createMonitor(
      (message) => {
        delivered.push(message)
      },
      undefined,
      undefined,
      {},
      (message) => {
        observed.push(message)
      },
    )
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.client = client
    harness.installConnectionStateHandler(client)

    harness.connectionEventHandler?.(
      new UpdateConnectionState(UpdateConnectionState.broken),
    )
    harness.connectionEventHandler?.(
      new UpdateConnectionState(UpdateConnectionState.connected),
    )
    await vi.waitFor(() => expect(client.getMessages).toHaveBeenCalledOnce())

    await harness.handleNewMessageEvent({ message: rawMessage })
    await flushMessageDispatches()

    expect(harness.recoveryPending).toBe(true)
    expect(harness.recoveryPromise).toBeDefined()
    expect(delivered).toHaveLength(0)
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({
      messageId: 89,
      text: 'recovery-visible immediately',
      recovered: true,
    })

    releaseCatchUp([rawMessage])
    await harness.recoveryPromise
    await flushMessageDispatches()

    expect(harness.recoveryPending).toBe(false)
    expect(observed).toHaveLength(1)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ messageId: 89, recovered: true })
  })

  it('shows a startup-buffered live update before the startup gate opens', async () => {
    const observed: TelegramSignalMessage[] = []
    const delivered: TelegramSignalMessage[] = []
    const { harness } = createMonitor(
      (message) => {
        delivered.push(message)
      },
      undefined,
      undefined,
      {},
      (message) => {
        observed.push(message)
      },
    )
    const rawMessage = {
      id: 90,
      message: 'startup-visible immediately',
      date: Math.floor(Date.now() / 1_000),
    }
    harness.channelEntity = {}
    harness.bufferingInitialMessages = true

    await harness.handleNewMessageEvent({ message: rawMessage })
    await flushMessageDispatches()

    expect(harness.initialMessageBuffer).toHaveLength(1)
    expect(delivered).toHaveLength(0)
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({ messageId: 90, recovered: true })

    const [queued] = harness.initialMessageBuffer
    harness.initialMessageBuffer = []
    harness.bufferingInitialMessages = false
    await harness.enqueueRawMessage(queued!.raw, queued!.receivedAt, queued!.recovered)
    await flushMessageDispatches()

    expect(observed).toHaveLength(1)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ messageId: 90, recovered: true })
  })

  it('publishes reconnecting only after two consecutive disconnected samples', async () => {
    const statuses: string[] = []
    const { harness } = createMonitor(
      () => undefined,
      undefined,
      (status) => {
        statuses.push(status.state)
      },
    )
    const client = {
      connected: false,
      getMessages: vi.fn(async () => []),
      connect: vi.fn(async () => {
        client.connected = true
      }),
      checkAuthorization: vi.fn(async () => true),
    }
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.client = client

    await harness.healthCheck()
    expect(statuses).toEqual([])
    expect(client.connect).not.toHaveBeenCalled()

    await harness.healthCheck()

    expect(client.connect).toHaveBeenCalledOnce()
    expect(client.checkAuthorization).toHaveBeenCalledOnce()
    expect(statuses).toEqual(['reconnecting', 'connected'])
    expect(harness.disconnectedChecks).toBe(0)
    expect(harness.reconnecting).toBe(false)
  })

  it('accepts a later successful internal connect attempt after a transient disconnected update', async () => {
    const statuses: string[] = []
    let emitConnectionState: ((event: unknown) => void) | undefined
    const client = {
      connected: false,
      getMessages: vi.fn(async () => []),
      checkAuthorization: vi.fn(async () => true),
      addEventHandler: vi.fn(),
      connect: vi.fn(async () => {
        emitConnectionState?.(
          new UpdateConnectionState(UpdateConnectionState.disconnected),
        )
        client.connected = true
      }),
    }
    const { harness } = createMonitor(
      () => undefined,
      undefined,
      (status) => {
        statuses.push(status.state)
      },
    )
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.client = client
    harness.installConnectionStateHandler(client)
    emitConnectionState = harness.connectionEventHandler

    await harness.healthCheck()
    await harness.healthCheck()

    expect(client.connect).toHaveBeenCalledOnce()
    expect(harness.recoveryPending).toBe(false)
    expect(harness.disconnectedChecks).toBe(0)
    expect(statuses).toEqual(['reconnecting', 'connected'])
  })

  it('throws instead of treating a disconnected catch-up as success', async () => {
    const { harness } = createMonitor(() => undefined)
    harness.channelEntity = {}
    harness.client = {
      connected: false,
      getMessages: vi.fn(async () => []),
    }

    await expect(harness.catchUpMessages(10)).rejects.toThrow('disconnected before catch-up')
  })

  it('dispatches no partial catch-up page when a later page fails', async () => {
    const delivered: number[] = []
    const { harness } = createMonitor(
      (message) => {
        delivered.push(message.messageId)
      },
      undefined,
      undefined,
      { catchUpLimit: 2 },
    )
    const page = [
      { id: 77, message: 'first page a', date: Math.floor(Date.now() / 1_000) },
      { id: 78, message: 'first page b', date: Math.floor(Date.now() / 1_000) },
    ]
    const final = { id: 79, message: 'final page', date: Math.floor(Date.now() / 1_000) }
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockRejectedValueOnce(new Error('second page failed'))
    harness.channelEntity = {}
    harness.client = { connected: true, getMessages }

    await expect(harness.catchUpMessages(76)).rejects.toThrow('second page failed')
    await flushMessageDispatches()
    expect(delivered).toEqual([])

    getMessages.mockReset()
    getMessages.mockResolvedValueOnce(page).mockResolvedValueOnce([final])
    await harness.catchUpMessages(76)
    await flushMessageDispatches()
    expect(delivered).toEqual([77, 78, 79])
  })

  it('keeps the recovery gate and frozen cursor after catch-up verification fails', async () => {
    const delivered: number[] = []
    const statuses: string[] = []
    const missedMessage = {
      id: 91,
      message: 'must remain gated',
      date: Math.floor(Date.now() / 1_000),
    }
    const getMessages = vi.fn().mockRejectedValueOnce(new Error('catch-up unavailable'))
    const client = {
      connected: false,
      getMessages,
      checkAuthorization: vi.fn(async () => true),
    }
    const { harness } = createMonitor(
      (message) => {
        delivered.push(message.messageId)
      },
      undefined,
      (status) => {
        statuses.push(status.state)
      },
    )
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.client = client

    await harness.healthCheck()
    await harness.enqueueRawMessage(missedMessage)
    client.connected = true
    await harness.healthCheck()
    await flushMessageDispatches()

    expect(harness.recoveryPending).toBe(true)
    expect(harness.recoveryFromMessageId).toBe(0)
    expect(harness.disconnectedChecks).toBe(2)
    expect(statuses).toEqual(['reconnecting'])
    expect(delivered).toEqual([])

    getMessages.mockResolvedValueOnce([missedMessage])
    await harness.healthCheck()
    await flushMessageDispatches()
    expect(harness.recoveryPending).toBe(false)
    expect(statuses).toEqual(['reconnecting', 'connected'])
    expect(delivered).toEqual([91])
  })

  it('keeps one catch-up in flight when health checks overlap', async () => {
    let releaseCatchUp!: () => void
    const catchUpBarrier = new Promise<void>((resolve) => {
      releaseCatchUp = resolve
    })
    const getMessages = vi.fn(async () => {
      await catchUpBarrier
      return []
    })
    const client = {
      connected: false,
      getMessages,
      checkAuthorization: vi.fn(async () => true),
    }
    const { harness } = createMonitor(() => undefined)
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.client = client

    await harness.healthCheck()
    client.connected = true
    const first = harness.healthCheck()
    const second = harness.healthCheck()
    expect(second).toBe(first)
    await Promise.resolve()
    expect(getMessages).toHaveBeenCalledOnce()

    releaseCatchUp()
    await Promise.all([first, second])
    expect(getMessages).toHaveBeenCalledOnce()
    expect(harness.recoveryPending).toBe(false)
  })

  it('publishes reconnecting on deadline while a recovery request is still pending', async () => {
    vi.useFakeTimers()
    let releaseCatchUp!: () => void
    const catchUpBarrier = new Promise<void>((resolve) => {
      releaseCatchUp = resolve
    })
    const statuses: string[] = []
    const client = {
      connected: true,
      getMessages: vi.fn(async () => {
        await catchUpBarrier
        return []
      }),
      checkAuthorization: vi.fn(async () => true),
      addEventHandler: vi.fn(),
    }
    const { harness } = createMonitor(
      () => undefined,
      undefined,
      (status) => {
        statuses.push(status.state)
      },
      { healthCheckIntervalMs: 1_000 },
    )
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.client = client
    harness.installConnectionStateHandler(client)

    harness.connectionEventHandler?.(
      new UpdateConnectionState(UpdateConnectionState.broken),
    )
    harness.connectionEventHandler?.(
      new UpdateConnectionState(UpdateConnectionState.connected),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(client.getMessages).toHaveBeenCalledOnce()
    expect(harness.liveTradingReadiness.ready).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(statuses).toEqual(['reconnecting'])
    expect(harness.recoveryPromise).toBeDefined()

    releaseCatchUp()
    await harness.recoveryPromise
    expect(statuses).toEqual(['reconnecting', 'connected'])
    expect(harness.liveTradingReadiness.ready).toBe(true)
  })

  it('does not let a pending target-channel probe block the confirmation deadline', async () => {
    vi.useFakeTimers()
    let resolveProbe!: (messages: unknown[]) => void
    const probe = new Promise<unknown[]>((resolve) => {
      resolveProbe = resolve
    })
    const statuses: string[] = []
    const client = {
      connected: true,
      getMessages: vi.fn(() => probe),
      checkAuthorization: vi.fn(async () => true),
      addEventHandler: vi.fn(),
    }
    const { harness } = createMonitor(
      () => undefined,
      undefined,
      (status) => {
        statuses.push(status.state)
      },
      { healthCheckIntervalMs: 1_000 },
    )
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.client = client
    harness.installConnectionStateHandler(client)

    const health = harness.healthCheck()
    await Promise.resolve()
    harness.connectionEventHandler?.(
      new UpdateConnectionState(UpdateConnectionState.broken),
    )
    await vi.advanceTimersByTimeAsync(1_000)

    expect(statuses).toEqual(['reconnecting'])
    expect(harness.liveTradingReadiness.ready).toBe(false)
    resolveProbe([])
    await health
  })

  it('ignores a stale target-channel probe after a newer recovery succeeds', async () => {
    let resolveOldProbe!: (messages: unknown[]) => void
    const oldProbe = new Promise<unknown[]>((resolve) => {
      resolveOldProbe = resolve
    })
    const staleMessage = {
      id: 999,
      message: 'stale probe must not reopen recovery',
      date: Math.floor(Date.now() / 1_000),
    }
    const observed: number[] = []
    const statuses: string[] = []
    const client = {
      connected: true,
      getMessages: vi.fn().mockImplementationOnce(() => oldProbe).mockResolvedValue([]),
      checkAuthorization: vi.fn(async () => true),
      addEventHandler: vi.fn(),
    }
    const { harness } = createMonitor(
      () => undefined,
      undefined,
      (status) => {
        statuses.push(status.state)
      },
      {},
      (message) => {
        observed.push(message.messageId)
      },
    )
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.client = client
    harness.installConnectionStateHandler(client)

    const oldHealth = harness.healthCheck()
    await Promise.resolve()
    harness.connectionEventHandler?.(
      new UpdateConnectionState(UpdateConnectionState.broken),
    )
    harness.connectionEventHandler?.(
      new UpdateConnectionState(UpdateConnectionState.connected),
    )
    await harness.recoveryPromise
    expect(harness.liveTradingReadiness.ready).toBe(true)

    resolveOldProbe([staleMessage])
    await oldHealth
    await flushMessageDispatches()
    expect(harness.recoveryPending).toBe(false)
    expect(harness.disconnectedChecks).toBe(0)
    expect(client.getMessages).toHaveBeenCalledTimes(2)
    expect(observed).toEqual([])
    expect(statuses).toEqual([])
  })

  it('isolates a late recovery failure from a new monitor generation after bounded stop', async () => {
    let rejectCatchUp!: (error: Error) => void
    const catchUp = new Promise<unknown[]>((_resolve, reject) => {
      rejectCatchUp = reject
    })
    const statuses: string[] = []
    const { monitor, harness } = createMonitor(
      () => undefined,
      undefined,
      (status) => {
        statuses.push(status.state)
      },
      { stopDrainTimeoutMs: 20 },
    )
    const oldClient = {
      connected: true,
      getMessages: vi.fn(() => catchUp),
      checkAuthorization: vi.fn(async () => true),
      destroy: vi.fn(async () => undefined),
    }
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.client = oldClient
    harness.recoveryPending = true
    harness.recoveryFromMessageId = 0

    const oldHealth = harness.healthCheck()
    await vi.waitFor(() => expect(oldClient.getMessages).toHaveBeenCalledOnce())
    await monitor.stop()

    const newClient = {
      connected: true,
      getMessages: vi.fn(async () => []),
      checkAuthorization: vi.fn(async () => true),
    }
    harness.stopRequested = false
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.client = newClient
    const statusesBeforeLateFailure = statuses.length

    // stop() must detach the old health single-flight even if its bounded
    // drain returned before the obsolete recovery settled.
    await harness.healthCheck()
    expect(newClient.getMessages).toHaveBeenCalledOnce()

    rejectCatchUp(new Error('obsolete recovery failed late'))
    await oldHealth

    expect(harness.stateValue).toBe('connected')
    expect(harness.recoveryPending).toBe(false)
    expect(harness.disconnectedChecks).toBe(0)
    expect(statuses.slice(statusesBeforeLateFailure)).toEqual([])
  })

  it('bounds stop even when a message callback never settles', async () => {
    let callbackStarted!: () => void
    const started = new Promise<void>((resolve) => {
      callbackStarted = resolve
    })
    const never = new Promise<void>(() => undefined)
    const { monitor, harness } = createMonitor(
      async () => {
        callbackStarted()
        await never
      },
      undefined,
      undefined,
      { stopDrainTimeoutMs: 20 },
    )
    harness.stateValue = 'connected'
    harness.channelEntity = {}
    harness.client = {
      connected: true,
      getMessages: vi.fn(async () => []),
      destroy: vi.fn(async () => undefined),
    }

    await harness.enqueueRawMessage({
      id: 500,
      message: 'callback never settles',
      date: Math.floor(Date.now() / 1_000),
    })
    await started
    const startedAt = Date.now()
    await monitor.stop()

    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(monitor.state).toBe('stopped')
  })

  it('bounds stop even when a display-only observation never settles', async () => {
    let observationStarted!: () => void
    const started = new Promise<void>((resolve) => {
      observationStarted = resolve
    })
    const never = new Promise<void>(() => undefined)
    const { monitor, harness } = createMonitor(
      () => undefined,
      undefined,
      undefined,
      { stopDrainTimeoutMs: 20 },
      async () => {
        observationStarted()
        await never
      },
    )
    harness.stateValue = 'connected'
    harness.bufferingInitialMessages = true
    harness.channelEntity = {}
    harness.client = {
      connected: true,
      getMessages: vi.fn(async () => []),
      destroy: vi.fn(async () => undefined),
    }

    await harness.handleNewMessageEvent({
      message: {
        id: 501,
        message: 'observation never settles',
        date: Math.floor(Date.now() / 1_000),
      },
    })
    await started
    const startedAt = Date.now()
    await monitor.stop()

    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(monitor.state).toBe('stopped')
  })

  it('uses teleproto connection-state updates to gate residual messages immediately', () => {
    const addEventHandler = vi.fn()
    const { harness } = createMonitor(() => undefined)
    harness.stateValue = 'connected'
    harness.installConnectionStateHandler({ addEventHandler })

    expect(addEventHandler).toHaveBeenCalledOnce()
    harness.connectionEventHandler?.(
      new UpdateConnectionState(UpdateConnectionState.broken),
    )

    expect(harness.recoveryPending).toBe(true)
    expect(harness.recoveryFromMessageId).toBe(0)
    expect(harness.disconnectedChecks).toBe(1)
  })

  it('reports a generic recoverable teleproto error without changing transport state', async () => {
    const errors: string[] = []
    const statuses: string[] = []
    const { harness } = createMonitor(
      () => undefined,
      (error) => {
        errors.push(error.message)
      },
      (status) => {
        statuses.push(status.state)
      },
    )
    const client = {
      connected: true,
      onError: undefined as ((error: Error) => Promise<void>) | undefined,
      start: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
    }
    harness.createClient = () => client

    await harness.connectWithProxyFallback('')
    statuses.length = 0
    harness.stateValue = 'connected'
    await client.onError?.(new Error('recoverable RPC warning'))

    expect(errors).toEqual(['recoverable RPC warning'])
    expect(statuses).toEqual([])
    expect(harness.stateValue).toBe('connected')
  })
})
