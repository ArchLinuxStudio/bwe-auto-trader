import { describe, expect, it, vi } from 'vitest'
import type { AppPosition, TelegramMessagePayload, TradingSettings } from '../../src/shared/types'
import type { TradingSignalAnalysis } from '../../src/main/services/chatgpt'
import {
  SignalCoordinator,
  type SignalSafetySnapshot
} from '../../src/main/services/signal-coordinator'

const settings: TradingSettings = {
  channelUsername: 'BWEnews',
  orderNotionalUsdt: 10,
  leverage: 1,
  cooldownMinutes: 60,
  aiTimeoutMs: 10_000,
  maxConcurrentPositions: 1,
  marginMode: 'isolated',
  positionMode: 'net'
}

function message(now: number, id = 1): TelegramMessagePayload {
  return {
    channelId: 'bwe',
    messageId: id,
    channelUsername: 'BWEnews',
    text: 'Coinbase will list ABC',
    date: now,
    receivedAt: now,
    permalink: `https://t.me/BWEnews/${id}`
  }
}

function analysis(overrides: Partial<TradingSignalAnalysis> = {}): TradingSignalAnalysis {
  return {
    symbols: ['ABC'],
    decision: 'LONG',
    confidence: 0.9,
    reason: '明确上币消息',
    status: 'ok',
    model: 'fast-model',
    latencyMs: 120,
    analyzedAt: new Date().toISOString(),
    ...overrides
  }
}

function armedSafety(overrides: Partial<SignalSafetySnapshot> = {}): SignalSafetySnapshot {
  const safety: SignalSafetySnapshot = {
    monitoring: true,
    liveArmed: true,
    okxConnected: true,
    emergencyStopped: false,
    positionCloseInProgress: false,
    authorizationToken: {
      capability: {},
      armRevision: 1,
      monitoringRevision: 1,
      telegramLifecycleRevision: 1,
      telegramRecoveryRevision: 0,
      telegramMonitor: {}
    },
    ...overrides
  }
  if (!safety.liveArmed) safety.authorizationToken = undefined
  return safety
}

function harness(overrides: {
  analysis?: TradingSignalAnalysis
  positions?: AppPosition[]
  safety?: Partial<SignalSafetySnapshot>
} = {}) {
  let now = 1_700_000_000_000
  const safety = armedSafety(overrides.safety)
  const openTrade = vi.fn(async () => ({
    instrumentId: 'ABC-USDT-SWAP',
    orderId: 'order-1',
    clientOrderId: 'bwe-client-1'
  }))
  const analyze = vi.fn(async (_message: string, _timeoutMs: number) =>
    overrides.analysis ?? analysis()
  )
  const notices: string[] = []
  const coordinator = new SignalCoordinator({
    now: () => now,
    settings: () => settings,
    safety: () => safety,
    analyze: async (text, timeout) => analyze(text, timeout),
    readPositions: async () => overrides.positions ?? [],
    openTrade,
    onRecord: () => undefined,
    onNotice: ({ title }) => {
      notices.push(title)
    }
  })
  return {
    coordinator,
    openTrade,
    analyze,
    safety,
    notices,
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds
    }
  }
}

function processHarnessMessage(
  test: ReturnType<typeof harness>,
  payload: TelegramMessagePayload
) {
  return test.coordinator.process(
    payload,
    test.safety.liveArmed ? test.safety.authorizationToken : undefined
  )
}

describe('SignalCoordinator', () => {
  it('submits one live order only after all gates pass', async () => {
    const test = harness()
    const record = await processHarnessMessage(test, message(test.now()))

    expect(test.openTrade).toHaveBeenCalledOnce()
    expect(test.openTrade).toHaveBeenCalledWith({
      symbol: 'ABC',
      direction: 'LONG',
      targetNotionalUsdt: 10,
      deadlineAt: test.now() + 10_000,
      authorizationToken: test.safety.authorizationToken
    })
    expect(record).toMatchObject({
      stage: 'submitted',
      instrumentId: 'ABC-USDT-SWAP',
      clientOrderId: 'bwe-client-1'
    })
  })

  it('deduplicates the same Telegram channel/message pair', async () => {
    const test = harness()
    const payload = message(test.now())
    await processHarnessMessage(test, payload)
    await test.coordinator.handleOrderUpdate({ clientOrderId: 'bwe-client-1', state: 'filled' })

    await expect(processHarnessMessage(test, payload)).resolves.toBeUndefined()
    expect(test.analyze).toHaveBeenCalledOnce()
    expect(test.openTrade).toHaveBeenCalledOnce()
  })

  it('shows the analysis but blocks orders while live trading is locked', async () => {
    const test = harness({ safety: { liveArmed: false } })
    const record = await processHarnessMessage(test, message(test.now()))

    expect(record).toMatchObject({
      stage: 'blocked',
      analysis: { decision: 'LONG', symbols: ['ABC'] }
    })
    expect(record?.detail).toContain('实盘尚未解锁')
    expect(test.openTrade).not.toHaveBeenCalled()
  })

  it('does not let a later arm retroactively authorize a message received while locked', async () => {
    const safety = armedSafety({ liveArmed: false })
    let releaseAnalysis!: (value: TradingSignalAnalysis) => void
    const analyze = vi.fn(() => new Promise<TradingSignalAnalysis>((resolve) => {
      releaseAnalysis = resolve
    }))
    const openTrade = vi.fn()
    const coordinator = new SignalCoordinator({
      now: () => 1_000,
      settings: () => settings,
      safety: () => safety,
      analyze,
      readPositions: async () => [],
      openTrade,
      onRecord: () => undefined
    })

    const processing = coordinator.process(message(1_000, 11))
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce())
    const armed = armedSafety()
    safety.liveArmed = true
    safety.authorizationToken = armed.authorizationToken
    releaseAnalysis(analysis())

    await expect(processing).resolves.toMatchObject({ stage: 'blocked' })
    expect(openTrade).not.toHaveBeenCalled()
  })

  it('does not let disarm and re-arm reuse an in-flight message authorization', async () => {
    const safety = armedSafety()
    let releaseAnalysis!: (value: TradingSignalAnalysis) => void
    const analyze = vi.fn(() => new Promise<TradingSignalAnalysis>((resolve) => {
      releaseAnalysis = resolve
    }))
    const openTrade = vi.fn()
    const coordinator = new SignalCoordinator({
      now: () => 1_000,
      settings: () => settings,
      safety: () => safety,
      analyze,
      readPositions: async () => [],
      openTrade,
      onRecord: () => undefined
    })

    const ingressAuthorization = safety.authorizationToken
    const processing = coordinator.process(message(1_000, 12), ingressAuthorization)
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce())
    const rearmed = armedSafety()
    safety.liveArmed = true
    safety.authorizationToken = {
      ...rearmed.authorizationToken!,
      armRevision: 3
    }
    releaseAnalysis(analysis())

    await expect(processing).resolves.toMatchObject({
      stage: 'blocked',
      detail: expect.stringContaining('授权')
    })
    expect(openTrade).not.toHaveBeenCalled()
  })

  it('skips multi-symbol, timed-out and stale analyses without crossing the order boundary', async () => {
    const multi = harness({
      analysis: analysis({ symbols: ['ABC', 'XYZ'], decision: 'LONG' })
    })
    expect((await processHarnessMessage(multi, message(multi.now())))?.stage).toBe('skipped')

    const timeout = harness({
      analysis: analysis({
        symbols: [],
        decision: 'SKIP',
        status: 'skipped',
        failureCode: 'timeout'
      })
    })
    expect((await processHarnessMessage(timeout, message(timeout.now())))?.stage).toBe('skipped')

    const stale = harness()
    const staleMessage = message(stale.now())
    stale.advance(10_001)
    expect((await processHarnessMessage(stale, staleMessage))?.detail).toContain('超过 10 秒')
    expect(multi.openTrade).not.toHaveBeenCalled()
    expect(timeout.openTrade).not.toHaveBeenCalled()
    expect(stale.openTrade).not.toHaveBeenCalled()
  })

  it('enforces max one position and the 60 minute cooldown after a fill', async () => {
    const occupied = harness({
      positions: [
        {
          instrumentId: 'BTC-USDT-SWAP',
          direction: 'long',
          contracts: 1,
          averagePrice: 1,
          markPrice: 1,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          leverage: 1,
          marginMode: 'isolated',
          updatedAt: 1
        }
      ]
    })
    expect((await processHarnessMessage(occupied, message(occupied.now())))?.detail).toContain('最多 1 仓')

    const cooldown = harness()
    await processHarnessMessage(cooldown, message(cooldown.now(), 1))
    await cooldown.coordinator.handleOrderUpdate({ clientOrderId: 'bwe-client-1', state: 'filled' })
    const second = await processHarnessMessage(cooldown, message(cooldown.now(), 2))
    expect(second?.detail).toContain('冷却期')
    expect(cooldown.openTrade).toHaveBeenCalledOnce()
  })

  it('fails closed and invokes the disarm hook when order submission throws', async () => {
    const onTradeError = vi.fn()
    const safety = armedSafety()
    const coordinator = new SignalCoordinator({
      now: () => 1000,
      settings: () => settings,
      safety: () => safety,
      analyze: async () => analysis(),
      readPositions: async () => [],
      openTrade: async () => {
        throw new Error('ambiguous network failure')
      },
      onRecord: () => undefined,
      onTradeError
    })

    const record = await coordinator.process(message(1000), safety.authorizationToken)
    expect(record).toMatchObject({ stage: 'failed' })
    expect(onTradeError).toHaveBeenCalledOnce()
  })

  it('buffers an early WS fill that arrives before the REST acknowledgement is recorded', async () => {
    let resolveTrade!: (value: {
      instrumentId: string
      orderId: string
      clientOrderId: string
    }) => void
    const openTrade = vi.fn(() => new Promise<{
      instrumentId: string
      orderId: string
      clientOrderId: string
    }>((resolve) => {
      resolveTrade = resolve
    }))
    const notices = vi.fn()
    const audits = vi.fn()
    const safety = armedSafety()
    const coordinator = new SignalCoordinator({
      now: () => 1_000,
      settings: () => settings,
      safety: () => safety,
      analyze: async () => analysis(),
      readPositions: async () => [],
      openTrade,
      onRecord: () => undefined,
      onNotice: notices,
      onAudit: audits
    })

    const processing = coordinator.process(message(1_000), safety.authorizationToken)
    await vi.waitFor(() => expect(openTrade).toHaveBeenCalledOnce())
    const early = await coordinator.handleOrderUpdate({
      clientOrderId: 'bwe-race-1',
      orderId: 'order-race-1',
      instrumentId: 'ABC-USDT-SWAP',
      state: 'filled',
      accumulatedFillSize: '2',
      averageFillPrice: '10'
    })
    expect(early).toMatchObject({ matched: false, terminal: true })
    resolveTrade({
      instrumentId: 'ABC-USDT-SWAP',
      orderId: 'order-race-1',
      clientOrderId: 'bwe-race-1'
    })

    await expect(processing).resolves.toMatchObject({
      stage: 'filled',
      orderState: 'filled',
      filledContracts: '2'
    })
    expect(coordinator.hasPendingOrder).toBe(false)

    const noticeCount = notices.mock.calls.length
    const auditCount = audits.mock.calls.length
    const duplicate = await coordinator.handleOrderUpdate({
      clientOrderId: 'bwe-race-1',
      orderId: 'order-race-1',
      instrumentId: 'ABC-USDT-SWAP',
      state: 'filled',
      accumulatedFillSize: '2',
      averageFillPrice: '10'
    })
    expect(duplicate).toMatchObject({ matched: true, duplicate: true, terminal: true })
    expect(notices).toHaveBeenCalledTimes(noticeCount)
    expect(audits).toHaveBeenCalledTimes(auditCount)
  })

  it('serializes two concurrent signals at the final order gate', async () => {
    const test = harness()
    const [first, second] = await Promise.all([
      processHarnessMessage(test, message(test.now(), 101)),
      processHarnessMessage(test, message(test.now(), 102))
    ])

    expect(test.openTrade).toHaveBeenCalledOnce()
    expect([first?.stage, second?.stage]).toContain('submitted')
    expect([first?.stage, second?.stage]).toContain('blocked')
  })

  it('blocks an opening order when a position close starts at the final gate', async () => {
    const safety = armedSafety()
    const openTrade = vi.fn(async () => ({
      instrumentId: 'ABC-USDT-SWAP',
      orderId: 'order-close-race',
      clientOrderId: 'bwe-close-race'
    }))
    const coordinator = new SignalCoordinator({
      now: () => 1_000,
      settings: () => settings,
      safety: () => safety,
      analyze: async () => analysis(),
      readPositions: async () => {
        safety.positionCloseInProgress = true
        return []
      },
      openTrade,
      onRecord: () => undefined
    })

    await expect(coordinator.process(
      message(1_000, 151),
      safety.authorizationToken
    )).resolves.toMatchObject({
      stage: 'blocked',
      detail: '交易前安全状态已变化，未下单'
    })
    expect(openTrade).not.toHaveBeenCalled()
  })

  it('does not start cooldown for a fully rejected order', async () => {
    const test = harness()
    await processHarnessMessage(test, message(test.now(), 201))
    await test.coordinator.handleOrderUpdate({
      clientOrderId: 'bwe-client-1',
      orderId: 'order-1',
      state: 'rejected'
    })
    const second = await processHarnessMessage(test, message(test.now(), 202))

    expect(second?.stage).toBe('submitted')
    expect(test.openTrade).toHaveBeenCalledTimes(2)
  })

  it('keeps a partial fill as exposure when OKX later mmp-cancels the remainder', async () => {
    const test = harness()
    await processHarnessMessage(test, message(test.now(), 301))
    await test.coordinator.handleOrderUpdate({
      clientOrderId: 'bwe-client-1',
      orderId: 'order-1',
      instrumentId: 'ABC-USDT-SWAP',
      state: 'partially_filled',
      accumulatedFillSize: '1'
    })
    await test.coordinator.handleOrderUpdate({
      clientOrderId: 'bwe-client-1',
      orderId: 'order-1',
      instrumentId: 'ABC-USDT-SWAP',
      state: 'mmp_canceled',
      accumulatedFillSize: '1'
    })

    expect(test.coordinator.history[0]).toMatchObject({
      stage: 'filled',
      orderState: 'mmp_canceled',
      filledContracts: '1'
    })
    expect(test.coordinator.hasPendingOrder).toBe(false)
  })

  it('keeps an ambiguous mutation pending and never labels it as a safe failure', async () => {
    const safety = armedSafety()
    const coordinator = new SignalCoordinator({
      now: () => 1_000,
      settings: () => settings,
      safety: () => safety,
      analyze: async () => analysis(),
      readPositions: async () => [],
      openTrade: async () => {
        throw new Error('timeout after request transmission')
      },
      onRecord: () => undefined,
      onTradeError: () => ({
        kind: 'unknown',
        instrumentId: 'ABC-USDT-SWAP',
        clientOrderId: 'bwe-unknown-1'
      })
    })

    await expect(coordinator.process(
      message(1_000, 401),
      safety.authorizationToken
    )).resolves.toMatchObject({
      stage: 'submitted',
      orderState: 'unknown',
      clientOrderId: 'bwe-unknown-1'
    })
    expect(coordinator.hasPendingOrder).toBe(true)

    await expect(coordinator.confirmPendingOrderAbsent({
      clientOrderId: 'bwe-unknown-1',
      instrumentId: 'ABC-USDT-SWAP',
      reason: 'No order, pending order, or position after the bounded consistency window'
    })).resolves.toBe(true)
    expect(coordinator.hasPendingOrder).toBe(false)
    expect(coordinator.history[0]).toMatchObject({
      stage: 'failed',
      orderState: 'absent_confirmed'
    })
    expect(coordinator.history[0]?.detail).toContain('旧信号不会重发')
  })

  it('rejects a reconnect catch-up message even when receivedAt is current', async () => {
    const test = harness()
    const caughtUp = message(test.now(), 501)
    caughtUp.date = test.now() - 30_000

    await expect(processHarnessMessage(test, caughtUp)).resolves.toMatchObject({
      stage: 'skipped'
    })
    expect(test.analyze).not.toHaveBeenCalled()
    expect(test.openTrade).not.toHaveBeenCalled()
  })

  it('analyzes a fresh recovered delivery but never lets a later arm authorize it', async () => {
    const test = harness()
    const caughtUp = message(test.now(), 502)
    caughtUp.recovered = true

    await expect(processHarnessMessage(test, caughtUp)).resolves.toMatchObject({
      stage: 'skipped',
      analysis: { decision: 'LONG' },
      detail: expect.stringContaining('永不触发下单')
    })
    expect(test.analyze).toHaveBeenCalledOnce()
    expect(test.openTrade).not.toHaveBeenCalled()
  })
})
