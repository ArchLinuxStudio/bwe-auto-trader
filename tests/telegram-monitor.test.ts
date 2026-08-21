import { afterEach, describe, expect, it, vi } from 'vitest'

import { TelegramMonitor, type TelegramStatusEvent } from '../src/main/services/telegram'
import type { TelegramSignalMessage } from '../src/main/services/telegram-message'

interface TelegramMonitorHarness {
  processingTail: Promise<void>
  disconnectedChecks: number
  reconnecting: boolean
  stateValue: 'idle' | 'connected' | 'reconnecting'
  client?: {
    connected: boolean
    getMessages: (...args: unknown[]) => Promise<unknown[]>
    connect?: () => Promise<void>
    checkAuthorization?: () => Promise<boolean>
  }
  channelEntity?: object
  createClient(storedSession: string, proxyProtocol: 'socks5' | 'http'): unknown
  connectWithProxyFallback(storedSession: string): Promise<unknown>
  enqueueRawMessage(raw: unknown, receivedAt?: Date): Promise<void>
  catchUpMessages(fromMessageId?: number): Promise<void>
  healthCheck(): Promise<void>
}

function createMonitor(
  onMessage: (message: TelegramSignalMessage) => void | Promise<void>,
  onError?: (error: { message: string }) => void | Promise<void>,
  onStatus?: (status: TelegramStatusEvent) => void | Promise<void>,
): { monitor: TelegramMonitor; harness: TelegramMonitorHarness } {
  const monitor = new TelegramMonitor({
    apiId: 1,
    apiHash: 'test-hash',
    secretStore: {
      get: async () => undefined,
      set: async () => undefined,
    },
    callbacks: { onMessage, onError, onStatus },
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
    })
  })

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
    expect(statuses).toEqual([])
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

  it('reports a generic recoverable GramJS error without changing transport state', async () => {
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
