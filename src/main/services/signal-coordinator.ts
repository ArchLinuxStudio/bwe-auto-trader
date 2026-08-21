import {
  MAX_SIGNAL_HISTORY,
  SIGNAL_TRADE_DEADLINE_MS,
  TELEGRAM_PUBLICATION_FRESHNESS_MS
} from '../../shared/defaults'
import type {
  AiAnalysis,
  AppPosition,
  SignalRecord,
  TelegramMessagePayload,
  TradingSettings
} from '../../shared/types'
import type { TradingSignalAnalysis } from './chatgpt'

export interface SignalSafetySnapshot {
  monitoring: boolean
  liveArmed: boolean
  okxConnected: boolean
  emergencyStopped: boolean
  positionCloseInProgress: boolean
}

export interface OpenTradeResult {
  instrumentId: string
  orderId: string
  clientOrderId: string
}

export interface TradeErrorDisposition {
  kind: 'failed' | 'unknown'
  instrumentId?: string
  clientOrderId?: string
  detail?: string
}

export interface SignalOrderUpdate {
  clientOrderId?: string
  orderId?: string
  state?: string
  instrumentId?: string
  fillSize?: string
  accumulatedFillSize?: string
  averageFillPrice?: string
}

export interface SignalOrderUpdateOutcome {
  matched: boolean
  duplicate: boolean
  terminal: boolean
  state?: string
  instrumentId?: string
  clientOrderId?: string
  orderId?: string
}

export interface PendingSignalOrder {
  signalId: string
  clientOrderId: string
  orderId?: string
  instrumentId?: string
}

export interface SignalCoordinatorDependencies {
  analyze(message: string, timeoutMs: number): Promise<TradingSignalAnalysis>
  readPositions(): Promise<AppPosition[]>
  openTrade(input: {
    symbol: string
    direction: 'LONG' | 'SHORT'
    targetNotionalUsdt: number
    deadlineAt: number
  }): Promise<OpenTradeResult>
  settings(): TradingSettings
  safety(): SignalSafetySnapshot
  onRecord(record: SignalRecord): void | Promise<void>
  onNotice?(input: {
    level: 'success' | 'warning' | 'error' | 'info'
    title: string
    detail: string
  }): void | Promise<void>
  onAudit?(event: string, data: Record<string, unknown>): void | Promise<void>
  onTradeError?(error: unknown): TradeErrorDisposition | Promise<TradeErrorDisposition>
  now?: () => number
}

const TERMINAL_ORDER_STATES = new Set(['filled', 'canceled', 'rejected', 'failed', 'mmp_canceled'])
const EARLY_ORDER_UPDATE_LIMIT = 200

/**
 * Fail-closed bridge from untrusted channel text to the live-order capability.
 * It has no credentials and cannot manufacture an order without the injected,
 * runtime-armed exchange callback.
 */
export class SignalCoordinator {
  private readonly now: () => number
  private readonly records = new Map<string, SignalRecord>()
  private readonly seen = new Set<string>()
  private readonly seenOrder: string[] = []
  private readonly cooldowns = new Map<string, number>()
  private readonly lastOrderFingerprints = new Map<string, string>()
  private readonly partiallyFilledRecords = new Set<string>()
  private readonly earlyOrderUpdates: SignalOrderUpdate[] = []
  private readonly activeProcesses = new Set<Promise<SignalRecord | undefined>>()
  private pendingClientOrderId?: string
  private pendingSince?: number
  private accepting = true

  constructor(private readonly dependencies: SignalCoordinatorDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  get history(): SignalRecord[] {
    return [...this.records.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_SIGNAL_HISTORY)
      .map((record) => structuredClone(record))
  }

  get hasPendingOrder(): boolean {
    return Boolean(this.pendingClientOrderId)
  }

  get pendingOrder(): PendingSignalOrder | undefined {
    if (!this.pendingClientOrderId || this.pendingClientOrderId === 'preparing') return undefined
    const record = [...this.records.values()].find(
      (candidate) => candidate.clientOrderId === this.pendingClientOrderId
    )
    if (!record) return undefined
    return {
      signalId: record.id,
      clientOrderId: this.pendingClientOrderId,
      orderId: record.orderId,
      instrumentId: record.instrumentId
    }
  }

  process(message: TelegramMessagePayload): Promise<SignalRecord | undefined> {
    if (!this.accepting) return Promise.resolve(undefined)
    const task = this.processInternal(message)
    this.activeProcesses.add(task)
    void task.then(
      () => this.activeProcesses.delete(task),
      () => this.activeProcesses.delete(task)
    )
    return task
  }

  async shutdown(): Promise<void> {
    this.accepting = false
    await Promise.allSettled([...this.activeProcesses])
  }

  private async processInternal(message: TelegramMessagePayload): Promise<SignalRecord | undefined> {
    const key = `${message.channelId}:${message.messageId}`
    if (this.seen.has(key)) return undefined
    this.rememberMessage(key)

    const safety = this.dependencies.safety()
    if (!safety.monitoring || safety.emergencyStopped || safety.positionCloseInProgress) {
      await this.audit('signal_ignored_monitoring_off', {
        channelId: message.channelId,
        messageId: message.messageId,
        positionCloseInProgress: safety.positionCloseInProgress
      })
      return undefined
    }

    const createdAt = this.now()
    let record: SignalRecord = {
      id: key,
      telegram: structuredClone(message),
      stage: 'received',
      detail: '收到频道新消息',
      createdAt,
      updatedAt: createdAt
    }
    await this.publish(record)

    // Telegram may replay channel history after a reconnect and assign a fresh
    // local receivedAt. The signed channel publication time is the independent
    // catch-up guard; allow only a small tolerance for second precision and
    // modest local clock skew.
    if (this.now() - message.date > TELEGRAM_PUBLICATION_FRESHNESS_MS) {
      record = await this.update(record, 'skipped', '频道消息发布时间已超过新鲜度限制，判定为重连补拉消息，未下单')
      await this.audit('signal_skipped_stale_publication', {
        signalId: record.id,
        publishedAt: message.date,
        receivedAt: message.receivedAt
      })
      return record
    }
    record = await this.update(record, 'analyzing', 'ChatGPT 正在快速判断币种和方向')

    const settings = this.dependencies.settings()
    let result: TradingSignalAnalysis
    try {
      result = await this.dependencies.analyze(message.text, settings.aiTimeoutMs)
    } catch (error) {
      record = await this.update(record, 'skipped', `AI 服务异常，已安全跳过：${errorText(error)}`)
      await this.notice('error', 'AI 分析失败，未下单', record.detail)
      await this.audit('signal_ai_error', { signalId: record.id, error: errorText(error) })
      return record
    }

    const analysis: AiAnalysis = {
      symbols: normalizeSymbols(result.symbols),
      decision: result.decision,
      confidence: clampConfidence(result.confidence),
      reason: result.reason,
      latencyMs: result.latencyMs,
      model: result.model ?? undefined
    }
    record = { ...record, analysis, updatedAt: this.now() }
    await this.publish(record)

    if (result.status !== 'ok' || result.decision === 'SKIP') {
      const reason = result.failureCode
        ? `AI 未给出可执行信号（${failureLabel(result.failureCode)}）：${result.reason}`
        : `AI 判断不交易：${result.reason}`
      record = await this.update(record, 'skipped', reason)
      if (result.failureCode) await this.notice('warning', '本条消息已跳过', reason)
      await this.audit('signal_skipped_by_ai', {
        signalId: record.id,
        failureCode: result.failureCode,
        reason: result.reason
      })
      return record
    }

    if (analysis.symbols.length !== 1 || !isSafeBaseSymbol(analysis.symbols[0]!)) {
      record = await this.update(record, 'skipped', '币种不是唯一且可验证的 ticker，已安全跳过')
      await this.notice('warning', '币种识别不唯一，未下单', analysis.symbols.join(', ') || '未识别币种')
      return record
    }

    const symbol = analysis.symbols[0]!
    if (this.now() - message.receivedAt >= SIGNAL_TRADE_DEADLINE_MS) {
      record = await this.update(record, 'skipped', '分析完成时信号已超过 10 秒时限，未追单')
      await this.notice('warning', '信号已过期，未下单', `${symbol} ${analysis.decision}`)
      return record
    }

    const latestSafety = this.dependencies.safety()
    if (!latestSafety.monitoring || latestSafety.emergencyStopped) {
      return this.update(record, 'blocked', '分析期间监听已停止，未下单')
    }
    if (!latestSafety.okxConnected) {
      record = await this.update(record, 'blocked', 'OKX 未连接，分析结果仅展示')
      await this.notice('warning', 'OKX 未连接，未下单', `${symbol} ${analysis.decision}`)
      return record
    }
    if (latestSafety.positionCloseInProgress) {
      return this.update(record, 'blocked', '平仓操作仍在处理或等待最终状态，未开新仓')
    }
    if (!latestSafety.liveArmed) {
      record = await this.update(record, 'blocked', 'AI 已给出方向，但实盘尚未解锁，未下单')
      await this.notice('warning', '实盘未解锁，未下单', `${symbol} ${analysis.decision} · ${analysis.reason}`)
      return record
    }

    const cooldownUntil = this.cooldowns.get(symbol) ?? 0
    if (cooldownUntil > this.now()) {
      const minutes = Math.max(1, Math.ceil((cooldownUntil - this.now()) / 60_000))
      record = await this.update(record, 'blocked', `${symbol} 仍在冷却期（约 ${minutes} 分钟），未重复下单`)
      return record
    }

    if (this.pendingClientOrderId) {
      record = await this.update(record, 'blocked', '已有一笔订单等待 OKX 最终状态，未发起新订单')
      return record
    }

    let positions: AppPosition[]
    try {
      positions = await this.dependencies.readPositions()
    } catch (error) {
      record = await this.update(record, 'blocked', `无法核对当前仓位，已安全跳过：${errorText(error)}`)
      await this.notice('error', '仓位核对失败，未下单', errorText(error))
      return record
    }
    if (positions.length >= settings.maxConcurrentPositions) {
      record = await this.update(record, 'blocked', `已有 ${positions.length} 个仓位，达到最多 1 仓限制`)
      return record
    }

    // Every await above is a concurrency boundary. Recheck all volatile gates
    // immediately before reserving the single opening-order slot so two
    // simultaneous messages cannot both pass the same stale snapshot.
    const finalSafety = this.dependencies.safety()
    if (
      !finalSafety.monitoring ||
      finalSafety.emergencyStopped ||
      !finalSafety.liveArmed ||
      finalSafety.positionCloseInProgress
    ) {
      return this.update(record, 'blocked', '交易前安全状态已变化，未下单')
    }
    if (!finalSafety.okxConnected) {
      return this.update(record, 'blocked', '交易前 OKX 已断开，未下单')
    }
    if (this.now() >= message.receivedAt + SIGNAL_TRADE_DEADLINE_MS) {
      return this.update(record, 'skipped', '交易前检查完成时信号已超过 10 秒时限，未追单')
    }
    if (this.pendingClientOrderId) {
      return this.update(record, 'blocked', '另一条信号已进入下单流程，未发起重复订单')
    }
    const latestCooldownUntil = this.cooldowns.get(symbol) ?? 0
    if (latestCooldownUntil > this.now()) {
      return this.update(record, 'blocked', `${symbol} 已由另一笔成交进入冷却期，未重复下单`)
    }

    // Reserve before crossing the order boundary so two signals cannot race.
    this.pendingClientOrderId = 'preparing'
    this.pendingSince = this.now()
    try {
      record = await this.update(record, 'submitting', `正在提交 ${symbol}-USDT-SWAP 市价单`)
    } catch (error) {
      this.pendingClientOrderId = undefined
      this.pendingSince = undefined
      record = {
        ...record,
        stage: 'failed',
        detail: `本地下单状态记录失败，未发送订单：${errorText(error)}`,
        updatedAt: this.now()
      }
      this.records.set(record.id, structuredClone(record))
      await Promise.resolve(this.dependencies.onTradeError?.(error)).catch(() => undefined)
      await this.notice('error', '本地状态异常，未下单', record.detail).catch(() => undefined)
      await this.audit('order_preparation_local_state_failed', {
        signalId: record.id,
        error: errorText(error)
      }).catch(() => undefined)
      return structuredClone(record)
    }
    // Keep the exchange mutation in its own transaction boundary. Once this
    // resolves, failures in local rendering, notifications, or audit storage
    // must never rewrite an accepted order as "failed" or release its slot.
    let placed: OpenTradeResult
    try {
      // SKIP returned above; keep the narrowed direction stable across await boundaries.
      const direction: 'LONG' | 'SHORT' =
        analysis.decision === 'LONG' ? 'LONG' : 'SHORT'
      placed = await this.dependencies.openTrade({
        symbol,
        direction,
        targetNotionalUsdt: settings.orderNotionalUsdt,
        deadlineAt: message.receivedAt + SIGNAL_TRADE_DEADLINE_MS
      })
    } catch (error) {
      let disposition: TradeErrorDisposition = { kind: 'failed' }
      try {
        disposition = await this.dependencies.onTradeError?.(error) ?? disposition
      } catch {
        // The safety hook is best-effort here; the order path still fails closed.
      }
      if (
        disposition.kind === 'unknown' &&
        disposition.clientOrderId &&
        disposition.instrumentId
      ) {
        this.pendingClientOrderId = disposition.clientOrderId
        this.pendingSince = this.now()
        record = {
          ...record,
          stage: 'submitted',
          instrumentId: disposition.instrumentId,
          clientOrderId: disposition.clientOrderId,
          orderState: 'unknown',
          detail: disposition.detail ?? 'OKX 下单结果未知，已锁定实盘并开始只读对账',
          updatedAt: this.now()
        }
        const localError = await this.persistUnknownOrderState(record)
        if (localError) await this.reportAcceptedOrderLocalFailure(localError, record)
        return structuredClone(this.records.get(record.id) ?? record)
      }

      this.pendingClientOrderId = undefined
      this.pendingSince = undefined
      record = await this.update(record, 'failed', `下单失败：${errorText(error)}`)
      await this.notice('error', '下单失败，实盘已锁定', errorText(error))
      await this.audit('order_submit_failed', { signalId: record.id, error: errorText(error) })
      return record
    }

    this.pendingClientOrderId = placed.clientOrderId
    this.pendingSince = this.now()
    record = {
      ...record,
      stage: 'submitted',
      instrumentId: placed.instrumentId,
      orderId: placed.orderId,
      clientOrderId: placed.clientOrderId,
      detail: `OKX 已受理 ${analysis.decision} ${placed.instrumentId}，等待最终成交状态`,
      updatedAt: this.now()
    }
    const acceptedDirection: 'LONG' | 'SHORT' =
      analysis.decision === 'LONG' ? 'LONG' : 'SHORT'
    const localError = await this.persistAcceptedOrder(record, acceptedDirection, settings.orderNotionalUsdt)
    if (localError) await this.reportAcceptedOrderLocalFailure(localError, record)
    return structuredClone(this.records.get(record.id) ?? record)
  }

  async handleOrderUpdate(input: SignalOrderUpdate): Promise<SignalOrderUpdateOutcome> {
    const normalized = normalizeOrderUpdate(input)
    const state = normalized.state
    const record = [...this.records.values()].find(
      (candidate) =>
        (normalized.clientOrderId && candidate.clientOrderId === normalized.clientOrderId) ||
        (normalized.orderId && candidate.orderId === normalized.orderId)
    )
    if (!record) {
      if (normalized.clientOrderId || normalized.orderId) this.bufferEarlyOrderUpdate(normalized)
      return {
        matched: false,
        duplicate: false,
        terminal: Boolean(state && TERMINAL_ORDER_STATES.has(state)),
        state,
        instrumentId: normalized.instrumentId,
        clientOrderId: normalized.clientOrderId,
        orderId: normalized.orderId
      }
    }

    return this.applyOrderUpdate(record, normalized)
  }

  async confirmPendingOrderFromPosition(input: {
    clientOrderId: string
    instrumentId: string
  }): Promise<boolean> {
    const record = [...this.records.values()].find(
      (candidate) => candidate.clientOrderId === input.clientOrderId
    )
    if (!record) return false
    if (record.orderState && TERMINAL_ORDER_STATES.has(record.orderState)) {
      if (this.pendingClientOrderId === input.clientOrderId) {
        this.pendingClientOrderId = undefined
        this.pendingSince = undefined
      }
      return false
    }
    this.startCooldown(record)
    const next: SignalRecord = {
      ...record,
      stage: 'filled',
      instrumentId: input.instrumentId,
      orderState: 'position_confirmed',
      detail: `${input.instrumentId} 已通过只读持仓对账确认成交`,
      updatedAt: this.now()
    }
    if (this.pendingClientOrderId === input.clientOrderId) {
      this.pendingClientOrderId = undefined
      this.pendingSince = undefined
    }
    let localError: unknown
    const run = async (effect: () => Promise<void>): Promise<void> => {
      try {
        await effect()
      } catch (error) {
        localError ??= error
      }
    }
    await run(() => this.publish(next))
    await run(() => this.notice('warning', '订单已通过持仓确认', next.detail))
    await run(() => this.audit('order_confirmed_by_position', {
      signalId: record.id,
      instrumentId: input.instrumentId,
      clientOrderId: input.clientOrderId
    }))
    if (localError) await this.reportAcceptedOrderLocalFailure(localError, next)
    return true
  }

  /**
   * Releases an ambiguous opening-order interlock only after the OKX client
   * has completed its bounded, read-only absence confirmation window. A
   * single "not found" observation must never call this method.
   */
  async confirmPendingOrderAbsent(input: {
    clientOrderId: string
    instrumentId: string
    reason: string
  }): Promise<boolean> {
    const record = [...this.records.values()].find(
      (candidate) => candidate.clientOrderId === input.clientOrderId
    )
    if (!record || this.pendingClientOrderId !== input.clientOrderId) return false
    this.pendingClientOrderId = undefined
    this.pendingSince = undefined
    const next: SignalRecord = {
      ...record,
      stage: 'failed',
      instrumentId: input.instrumentId,
      orderState: 'absent_confirmed',
      detail: `${input.instrumentId} 经安全等待窗口和只读对账确认未生成订单，旧信号不会重发`,
      updatedAt: this.now()
    }

    let localError: unknown
    const run = async (effect: () => Promise<void>): Promise<void> => {
      try {
        await effect()
      } catch (error) {
        localError ??= error
      }
    }
    await run(() => this.publish(next))
    await run(() => this.notice('warning', '未知订单已确认不存在', next.detail))
    await run(() => this.audit('order_absence_confirmed', {
      signalId: next.id,
      instrumentId: input.instrumentId,
      clientOrderId: input.clientOrderId,
      reason: input.reason
    }))
    if (localError) await this.reportAcceptedOrderLocalFailure(localError, next)
    return true
  }

  reconcilePositions(_positions: readonly AppPosition[]): void {
    // Positions alone must never clear an accepted/pending order. Only a WS
    // terminal state or explicit read-only reconciliation may release it.
  }

  clearRuntimeState(): void {
    this.pendingClientOrderId = undefined
    this.pendingSince = undefined
    this.earlyOrderUpdates.length = 0
  }

  private async persistAcceptedOrder(
    record: SignalRecord,
    direction: 'LONG' | 'SHORT',
    notionalUsdt: number
  ): Promise<unknown | undefined> {
    let firstError: unknown
    const run = async (effect: () => Promise<void>): Promise<void> => {
      try {
        await effect()
      } catch (error) {
        firstError ??= error
      }
    }
    await run(() => this.publish(record))
    await run(() => this.notice(
      'success',
      '订单已提交',
      `${direction} ${record.instrumentId} · ${notionalUsdt} USDT`
    ))
    await run(() => this.audit('order_submitted', {
      signalId: record.id,
      instrumentId: record.instrumentId,
      orderId: record.orderId,
      clientOrderId: record.clientOrderId,
      direction,
      notionalUsdt
    }))
    await run(() => this.replayEarlyOrderUpdates(record))
    return firstError
  }

  private async persistUnknownOrderState(record: SignalRecord): Promise<unknown | undefined> {
    let firstError: unknown
    const run = async (effect: () => Promise<void>): Promise<void> => {
      try {
        await effect()
      } catch (error) {
        firstError ??= error
      }
    }
    await run(() => this.publish(record))
    await run(() => this.notice('warning', '订单状态未知，禁止重试', record.detail))
    await run(() => this.audit('order_state_unknown', {
      signalId: record.id,
      instrumentId: record.instrumentId,
      clientOrderId: record.clientOrderId
    }))
    await run(() => this.replayEarlyOrderUpdates(record))
    return firstError
  }

  private async reportAcceptedOrderLocalFailure(
    error: unknown,
    record: SignalRecord
  ): Promise<void> {
    try {
      await this.dependencies.onTradeError?.(error)
    } catch {
      // The accepted/unknown exchange fact and pending interlock remain intact.
    }
    const terminal = Boolean(
      record.orderState &&
      (TERMINAL_ORDER_STATES.has(record.orderState) || record.orderState === 'absent_confirmed')
    )
    await this.notice(
      'error',
      '订单已受理，但本地记录异常',
      `${record.instrumentId ?? 'OKX 订单'} ${terminal ? '最终状态已保留' : '状态仍等待确认'}；已锁定实盘，请以交易所状态为准`
    ).catch(() => undefined)
    await this.audit('accepted_order_local_side_effect_failed', {
      signalId: record.id,
      instrumentId: record.instrumentId,
      orderId: record.orderId,
      clientOrderId: record.clientOrderId,
      error: errorText(error)
    }).catch(() => undefined)
  }

  private async applyOrderUpdate(
    record: SignalRecord,
    input: SignalOrderUpdate
  ): Promise<SignalOrderUpdateOutcome> {
    const state = input.state
    const terminal = Boolean(state && TERMINAL_ORDER_STATES.has(state))
    const fingerprint = orderUpdateFingerprint(input)
    if (this.lastOrderFingerprints.get(record.id) === fingerprint) {
      return {
        matched: true,
        duplicate: true,
        terminal,
        state,
        instrumentId: input.instrumentId ?? record.instrumentId,
        clientOrderId: input.clientOrderId ?? record.clientOrderId,
        orderId: input.orderId ?? record.orderId
      }
    }
    if (record.orderState && TERMINAL_ORDER_STATES.has(record.orderState)) {
      return {
        matched: true,
        duplicate: true,
        terminal: true,
        state: record.orderState,
        instrumentId: record.instrumentId,
        clientOrderId: record.clientOrderId,
        orderId: record.orderId
      }
    }
    this.lastOrderFingerprints.set(record.id, fingerprint)

    const accumulatedFill = numericFill(input.accumulatedFillSize ?? input.fillSize)
    const hasPartialFill = state === 'partially_filled' || accumulatedFill > 0
    if (hasPartialFill) this.partiallyFilledRecords.add(record.id)

    let next: SignalRecord = {
      ...record,
      orderId: input.orderId ?? record.orderId,
      clientOrderId: input.clientOrderId ?? record.clientOrderId,
      instrumentId: input.instrumentId ?? record.instrumentId,
      orderState: state ?? record.orderState,
      filledContracts: input.accumulatedFillSize ?? input.fillSize ?? record.filledContracts,
      averageFillPrice: input.averageFillPrice ?? record.averageFillPrice,
      updatedAt: this.now()
    }

    let orderNotice: {
      level: 'success' | 'warning'
      title: string
      detail: string
    } | undefined
    if (state === 'filled') {
      this.startCooldown(next)
      next = {
        ...next,
        stage: 'filled',
        detail: `${next.instrumentId ?? '订单'} 已全部成交`
      }
      orderNotice = { level: 'success', title: '订单已全部成交', detail: next.detail }
    } else if (state === 'partially_filled') {
      this.startCooldown(next)
      next = {
        ...next,
        stage: 'submitted',
        detail: `${next.instrumentId ?? '订单'} 已部分成交，继续等待最终状态`
      }
      orderNotice = { level: 'warning', title: '订单部分成交', detail: next.detail }
    } else if (state && TERMINAL_ORDER_STATES.has(state)) {
      if (this.partiallyFilledRecords.has(record.id) || accumulatedFill > 0) {
        this.startCooldown(next)
        next = {
          ...next,
          stage: 'filled',
          detail: `${next.instrumentId ?? '订单'} 部分成交后状态为 ${state}，请以当前仓位为准`
        }
      } else {
        next = {
          ...next,
          stage: 'failed',
          detail: `OKX 订单最终状态：${state}`
        }
      }
      orderNotice = { level: 'warning', title: '订单已结束', detail: next.detail }
    }

    if (
      terminal &&
      this.pendingClientOrderId &&
      this.pendingClientOrderId !== 'preparing' &&
      this.pendingClientOrderId === next.clientOrderId
    ) {
      this.pendingClientOrderId = undefined
      this.pendingSince = undefined
      this.partiallyFilledRecords.delete(record.id)
    }

    let localError: unknown
    const run = async (effect: () => Promise<void>): Promise<void> => {
      try {
        await effect()
      } catch (error) {
        localError ??= error
      }
    }
    await run(() => this.publish(next))
    if (orderNotice) {
      await run(() => this.notice(orderNotice.level, orderNotice.title, orderNotice.detail))
    }
    await run(() => this.audit('order_state_updated', {
      signalId: next.id,
      instrumentId: next.instrumentId,
      orderId: next.orderId,
      clientOrderId: next.clientOrderId,
      state,
      filledContracts: next.filledContracts,
      averageFillPrice: next.averageFillPrice,
      terminal
    }))
    if (localError) await this.reportAcceptedOrderLocalFailure(localError, next)

    return {
      matched: true,
      duplicate: false,
      terminal,
      state,
      instrumentId: next.instrumentId,
      clientOrderId: next.clientOrderId,
      orderId: next.orderId
    }
  }

  private bufferEarlyOrderUpdate(input: SignalOrderUpdate): void {
    this.earlyOrderUpdates.push(structuredClone(input))
    while (this.earlyOrderUpdates.length > EARLY_ORDER_UPDATE_LIMIT) {
      this.earlyOrderUpdates.shift()
    }
  }

  private async replayEarlyOrderUpdates(record: SignalRecord): Promise<void> {
    const matches: SignalOrderUpdate[] = []
    for (let index = this.earlyOrderUpdates.length - 1; index >= 0; index -= 1) {
      const update = this.earlyOrderUpdates[index]!
      if (
        (record.clientOrderId && update.clientOrderId === record.clientOrderId) ||
        (record.orderId && update.orderId === record.orderId)
      ) {
        matches.unshift(update)
        this.earlyOrderUpdates.splice(index, 1)
      }
    }
    for (const update of matches) {
      const current = this.records.get(record.id)
      if (current) await this.applyOrderUpdate(current, update)
    }
  }

  private startCooldown(record: SignalRecord): void {
    const symbol = record.analysis?.symbols[0]
    if (!symbol) return
    const duration = this.dependencies.settings().cooldownMinutes * 60_000
    this.cooldowns.set(symbol, this.now() + duration)
  }

  private async update(record: SignalRecord, stage: SignalRecord['stage'], detail: string): Promise<SignalRecord> {
    const next = { ...record, stage, detail, updatedAt: this.now() }
    await this.publish(next)
    return next
  }

  private async publish(record: SignalRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record))
    await this.dependencies.onRecord(structuredClone(record))
  }

  private rememberMessage(key: string): void {
    this.seen.add(key)
    this.seenOrder.push(key)
    while (this.seenOrder.length > 5_000) {
      const oldest = this.seenOrder.shift()
      if (oldest) this.seen.delete(oldest)
    }
  }

  private async notice(
    level: 'success' | 'warning' | 'error' | 'info',
    title: string,
    detail: string
  ): Promise<void> {
    await this.dependencies.onNotice?.({ level, title, detail })
  }

  private async audit(event: string, data: Record<string, unknown>): Promise<void> {
    await this.dependencies.onAudit?.(event, data)
  }
}

function normalizeSymbols(symbols: readonly string[]): string[] {
  return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))]
}

function isSafeBaseSymbol(symbol: string): boolean {
  return /^[A-Z0-9]{1,20}$/.test(symbol) && symbol !== 'USDT' && symbol !== 'USD'
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function failureLabel(code: string): string {
  const labels: Record<string, string> = {
    timeout: '超时',
    cancelled: '已取消',
    not_authenticated: '未登录',
    quota_exceeded: '额度不足',
    model_unavailable: '模型不可用',
    invalid_response: '结果无效',
    server_unavailable: '服务不可用',
    analysis_error: '分析错误'
  }
  return labels[code] ?? code
}

function normalizeOrderUpdate(input: SignalOrderUpdate): SignalOrderUpdate {
  const state = input.state?.trim().toLowerCase().replace(/^cancelled$/, 'canceled')
  return {
    clientOrderId: cleanOptional(input.clientOrderId),
    orderId: cleanOptional(input.orderId),
    state: cleanOptional(state),
    instrumentId: cleanOptional(input.instrumentId)?.toUpperCase(),
    fillSize: cleanOptional(input.fillSize),
    accumulatedFillSize: cleanOptional(input.accumulatedFillSize),
    averageFillPrice: cleanOptional(input.averageFillPrice)
  }
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim()
  return cleaned || undefined
}

function numericFill(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function orderUpdateFingerprint(input: SignalOrderUpdate): string {
  return [
    input.clientOrderId,
    input.orderId,
    input.state,
    input.instrumentId,
    input.fillSize,
    input.accumulatedFillSize,
    input.averageFillPrice
  ].join('|')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
