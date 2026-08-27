import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import type {
  AppEvent,
  AppPosition,
  AppSnapshot,
  AuthPrompt,
  ClosePositionInput,
  ConnectionPhase,
  ConnectionStatus,
  NetworkDiagnostics,
  NotificationItem,
  OkxCredentialsInput,
  OkxRouteStatus,
  OkxRoutes,
  PublicSettings,
  SettingsUpdateInput,
  TelegramCredentialsInput
} from '../shared/types'
import {
  CLOSE_POSITION_CONFIRMATION,
  LIVE_ARM_CONFIRMATION,
  MAX_NOTIFICATION_HISTORY
} from '../shared/defaults'
import {
  normalizeChannelUsername,
  okxCredentialsSchema,
  settingsUpdateSchema,
  telegramCredentialsSchema
} from '../shared/validation'
import { AuditLog } from './services/audit-log'
import {
  ChatGptService,
  type ChatGptRateLimits,
  type TradingSignalAnalysis
} from './services/chatgpt'
import { runNetworkDiagnostics } from './services/network-diagnostics'
import {
  OkxApiError,
  OkxV5Client,
  OkxOrderStateUnknownError,
  OkxTransportError,
  okxPositionsToAppPositions,
  type OkxAccountVerification,
  type OkxClientOptions,
  type OkxInstrument,
  type OkxMutationLifecycleEvent,
  type OkxOrder,
  type OkxOrderReconciliationResult,
  type OkxOrderUpdate,
  type OkxPlacedOrder,
  type OkxPosition,
  type OkxPrivateStream,
  type OkxRouteSelection
} from './services/okx'
import {
  MutationJournalConflictError,
  MutationJournalStore,
  createOkxAccountFingerprint,
  type DurableMutationRecord,
  type DurableMutationResolutionEvidence
} from './services/mutation-journal'
import { SecretStore } from './services/secret-store'
import { SettingsStore } from './services/settings-store'
import {
  SignalCoordinator,
  sameSignalTradeAuthorization,
  type SignalTradeAuthorizationToken
} from './services/signal-coordinator'
import {
  TelegramMonitor,
  type TelegramAuthField,
  type TelegramAuthRequest,
  type TelegramMonitorError,
  type TelegramStatusEvent
} from './services/telegram'
import { toTelegramMessagePayload } from './services/telegram-message'

const TELEGRAM_CREDENTIALS_KEY = 'telegram.credentials.v1'
const TELEGRAM_SESSION_KEY = 'telegram.string-session'
const OKX_CREDENTIALS_KEY = 'okx.credentials.v1'

export interface AppControllerOptions {
  userDataDirectory: string
  version: string
  openExternal(url: string): Promise<void>
  showDesktopNotification?(title: string, body: string): void
  now?: () => number
  createOkxClient?(options: OkxClientOptions): OkxV5Client
  analyzeSignal?(message: string, timeoutMs: number): Promise<TradingSignalAnalysis>
}

interface PendingPromptState {
  prompt: AuthPrompt
  field: TelegramAuthField
}

interface ControllerEvents {
  event: [AppEvent]
}

interface PendingPositionClose {
  instrumentId: string
  orderId?: string
  clientOrderId?: string
  state: 'submitting' | 'accepted' | 'live' | 'partially_filled' | 'unknown'
  submittedAt: number
  lastFingerprint?: string
}

type OkxCredentialExposureStatus = 'unverified' | 'verified_clear' | 'exposure_seen'

/**
 * A tiny FIFO mutex for controller lifecycle boundaries. The gate promise
 * never rejects, so one failed operation cannot poison the queue.
 */
class AsyncLifecycleMutex {
  private tail: Promise<void> = Promise.resolve()

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    return (async () => {
      await prior
      try {
        return await operation()
      } finally {
        release()
      }
    })()
  }
}

const TERMINAL_OKX_ORDER_STATES = new Set([
  'filled',
  'canceled',
  'mmp_canceled'
])
const OBSERVABLE_OKX_ORDER_STATES = new Set([
  'live',
  'partially_filled',
  ...TERMINAL_OKX_ORDER_STATES
])
const EARLY_CLOSE_ORDER_UPDATE_LIMIT = 200
const FINALIZED_CLOSE_ORDER_KEY_LIMIT = 200

export class AppController extends EventEmitter<ControllerEvents> {
  private readonly now: () => number
  private readonly settingsStore: SettingsStore
  private readonly secretStore: SecretStore
  private readonly audit: AuditLog
  private readonly mutationJournal: MutationJournalStore
  private readonly coordinator: SignalCoordinator
  private settings!: PublicSettings
  private telegram?: TelegramMonitor
  private chatgpt?: ChatGptService
  private unsubscribeChatGptStatus?: () => void
  private okx?: OkxV5Client
  private okxStream?: OkxPrivateStream
  private okxInstruments: OkxInstrument[] = []
  private readonly pendingPositionCloses = new Map<string, PendingPositionClose>()
  private readonly earlyCloseOrderUpdates: OkxOrderUpdate[] = []
  private readonly earlyDurableOrderUpdates: OkxOrderUpdate[] = []
  private readonly finalizedCloseOrderKeys = new Set<string>()
  private readonly finalizedCloseOrderKeyOrder: string[] = []
  private readonly finalizedDurableMutationIds = new Set<string>()
  private readonly finalizedDurableMutationIdOrder: string[] = []
  private readonly finalizedDurableOrderIdsByClient = new Map<string, string | undefined>()
  private readonly finalizedDurableClientIdsByOrder = new Map<string, string>()
  private readonly finalizedDurableMutationsPermittingOrderBinding = new Set<string>()
  private readonly finalizedDurableInstrumentIdsByClient = new Map<string, string>()
  private readonly finalizedDurableOperationsByClient = new Map<
    string,
    DurableMutationRecord['operation']
  >()
  private readonly startupDurableMutationIds = new Set<string>()
  private durableMutations: DurableMutationRecord[] = []
  private mutationJournalFailure?: string
  private readonly okxAccountFingerprints = new WeakMap<OkxV5Client, string>()
  private positions: AppPosition[] = []
  private notifications: NotificationItem[] = []
  private pendingPrompt?: PendingPromptState
  private diagnostics: NetworkDiagnostics = {
    proxyReachable: false,
    okxDirect: false
  }
  private okxRoutes: OkxRoutes = emptyOkxRoutes()
  private connections: AppSnapshot['connections']
  private monitoring = false
  private liveArmed = false
  private liveArmRevision = 0
  private monitoringRevision = 0
  private telegramLifecycleRevision = 0
  private liveArmCapability?: object
  private telegramReconnectRetainedArm = false
  private emergencyStopped = false
  private armedAt?: number
  private aiModel?: string
  private aiQuotaPercent?: number
  private aiQuotaExhausted = false
  private lastError?: string
  private initialized = false
  private closing = false
  private positionRefresh?: Promise<void>
  private activePositionClose?: Promise<void>
  private closeScopedArmedClient?: OkxV5Client
  private readonly okxLifecycleMutex = new AsyncLifecycleMutex()
  private readonly mutationJournalLifecycleMutex = new AsyncLifecycleMutex()
  private okxLifecycleRevision = 0
  private okxCredentialExposureStatus: OkxCredentialExposureStatus = 'unverified'
  private readonly okxCredentialExposureFacts = new Set<string>()
  private reconciliationTimer?: NodeJS.Timeout
  private closeReconciliationTimer?: NodeJS.Timeout
  private trackedOrderReconciliation?: Promise<void>
  /**
   * Keeps the exchange client that actually crossed the mutation boundary.
   * The active controller client may already be gone (or may be a newly
   * connected client) by the time an in-flight POST reports an unknown
   * result, so `this.okx` cannot identify the origin safely.
   */
  private readonly unknownOrderOriginClients = new WeakMap<
    OkxOrderStateUnknownError,
    OkxV5Client
  >()

  constructor(private readonly options: AppControllerOptions) {
    super()
    this.now = options.now ?? Date.now
    this.settingsStore = new SettingsStore(options.userDataDirectory)
    this.secretStore = new SecretStore(options.userDataDirectory)
    this.audit = new AuditLog(options.userDataDirectory)
    this.mutationJournal = new MutationJournalStore(options.userDataDirectory)
    const initial = this.now()
    this.connections = {
      telegram: connection('not_configured', '未配置', initial),
      chatgpt: connection('not_configured', '未登录', initial),
      okx: connection('not_configured', '未配置', initial)
    }
    this.coordinator = new SignalCoordinator({
      now: this.now,
      settings: () => this.settings.trading,
      safety: () => {
        const authorizationToken = this.currentSignalTradeAuthorization()
        return {
          monitoring: this.monitoring,
          liveArmed: Boolean(authorizationToken),
          authorizationToken,
          okxConnected: this.connections.okx.phase === 'connected',
          emergencyStopped: this.emergencyStopped,
          positionCloseInProgress: this.hasPositionCloseInterlock()
        }
      },
      analyze: async (message, timeoutMs) => {
        if (this.options.analyzeSignal) {
          return this.options.analyzeSignal(message, timeoutMs)
        }
        if (!this.chatgpt) throw new Error('ChatGPT 服务尚未连接')
        return this.chatgpt.analyze(message, { timeoutMs })
      },
      readPositions: async () => {
        await this.refreshPositions()
        return structuredClone(this.positions)
      },
      openTrade: async ({
        symbol,
        direction,
        targetNotionalUsdt,
        deadlineAt,
        authorizationToken
      }) => {
        const client = this.requireOkx()
        const transmissionGuard = (): void => {
          this.assertSignalTradeAuthorization(authorizationToken, client)
        }
        transmissionGuard()
        const remainingTtlMs = deadlineAt - this.now()
        if (remainingTtlMs <= 0) {
          throw new Error('交易前信号已超过 10 秒，已取消订单')
        }
        const intent = await client.prepareMarketOrder({
          symbolOrInstId: symbol,
          direction,
          targetNotionalUsdt
        }, remainingTtlMs)
        transmissionGuard()
        if (this.now() >= deadlineAt) {
          throw new Error('下单预检完成时信号已超过 10 秒，已取消订单')
        }
        // The one-time capability is minted only after all preview/network checks.
        const arm = client.armNextLiveTrade('open')
        let placed: OkxPlacedOrder
        try {
          placed = await client.submitPreparedMarketOrder({
            intent,
            arm,
            transmissionGuard
          })
        } catch (error) {
          if (error instanceof OkxOrderStateUnknownError) {
            this.unknownOrderOriginClients.set(error, client)
          }
          throw error
        }
        return {
          instrumentId: placed.instId,
          orderId: placed.ordId,
          clientOrderId: placed.clOrdId
        }
      },
      onRecord: () => this.emitSnapshot(),
      onNotice: (notice) => this.notify(notice.level, notice.title, notice.detail),
      onAudit: (event, data) => this.audit.write(event, 'info', data),
      onTradeError: async (error) => {
        // Disarming mutates the capability before its audit/notification
        // awaits. A local audit failure must not hide an exchange ambiguity.
        await this.disarmLiveTrading('订单结果异常，已自动锁定实盘').catch((disarmError) => {
          this.lastError = `实盘已锁定，但本地锁定记录失败：${errorText(disarmError)}`
        })
        if (
          error instanceof OkxOrderStateUnknownError &&
          (error as OkxOrderStateUnknownError & { operation?: 'open' | 'close' }).operation !== 'close'
        ) {
          const originatingClient = this.unknownOrderOriginClients.get(error)
          const canReconcileOnOrigin = Boolean(
            originatingClient &&
            this.okx === originatingClient &&
            originatingClient.requiresOrderReconciliation
          )
          if (originatingClient && canReconcileOnOrigin) {
            this.scheduleUnknownOrderReconciliation(originatingClient, error)
          }
          return {
            kind: 'unknown',
            instrumentId: error.instId,
            clientOrderId: error.clOrdId,
            detail: canReconcileOnOrigin
              ? 'OKX 开仓请求结果未知，已禁止重试并开始只读对账'
              : 'OKX 开仓请求结果未知，已禁止重试；等待 OKX 重连后按客户订单号只读对账'
          } as const
        }
        return { kind: 'failed' } as const
      }
    })
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.settings = await this.settingsStore.read()
    let recoveredBeforeTransmission = 0
    try {
      this.durableMutations = await this.mutationJournal.read()
      const startupRecords = new Map(
        this.durableMutations.map((record) => [record.clOrdId, record] as const)
      )
      const recovery = await this.mutationJournal.resolvePreparedBeforeTransmission()
      this.durableMutations = recovery.records
      for (const record of recovery.records) {
        this.startupDurableMutationIds.add(record.clOrdId)
      }
      recoveredBeforeTransmission = recovery.removedClientOrderIds.length
      for (const clientOrderId of recovery.removedClientOrderIds) {
        const record = startupRecords.get(clientOrderId)
        this.rememberFinalizedDurableMutation(
          clientOrderId,
          undefined,
          false,
          record?.instId,
          record?.operation
        )
      }
    } catch {
      this.mutationJournalFailure = '本地订单恢复日志无法验证，已禁止任何实盘 mutation'
      this.lastError = this.mutationJournalFailure
    }
    this.connections.telegram = connection(
      this.settings.telegramConfigured ? 'disconnected' : 'not_configured',
      this.settings.telegramConfigured ? '已配置，未连接' : '未配置',
      this.now()
    )
    this.connections.okx = connection(
      this.settings.okxConfigured ? 'disconnected' : 'not_configured',
      this.settings.okxConfigured ? '已配置，未连接' : '未配置',
      this.now()
    )
    this.connections.chatgpt = connection('disconnected', '等待 ChatGPT Plus 登录', this.now())
    this.initialized = true
    await this.audit.write('application_started', 'info', {
      version: this.options.version,
      platform: process.platform,
      liveArmed: false,
      unresolvedMutationCount: this.durableMutations.length,
      recoveredBeforeTransmission,
      mutationJournalHealthy: !this.mutationJournalFailure
    })
    this.emitSnapshot()
  }

  getSnapshot(): AppSnapshot {
    this.assertInitialized()
    const blockers = this.armBlockers()
    return structuredClone({
      version: this.options.version,
      connections: this.connections,
      safety: {
        liveArmed: this.liveArmed,
        armedAt: this.armedAt,
        monitoring: this.monitoring,
        emergencyStopped: this.emergencyStopped,
        canArm: blockers.length === 0,
        armBlockers: blockers
      },
      settings: this.settings,
      diagnostics: this.diagnostics,
      okxRoutes: this.okxRoutes,
      positions: this.positions,
      signals: this.coordinator.history,
      notifications: this.notifications,
      pendingAuthPrompt: this.pendingPrompt?.prompt,
      aiModel: this.aiModel,
      aiQuotaPercent: this.aiQuotaPercent,
      aiQuotaExhausted: this.aiQuotaExhausted,
      lastError: this.lastError
    })
  }

  onAppEvent(listener: (event: AppEvent) => void): () => void {
    this.on('event', listener)
    return () => this.off('event', listener)
  }

  async saveTelegramCredentials(raw: TelegramCredentialsInput): Promise<void> {
    const input = telegramCredentialsSchema.parse(raw)
    await this.disconnectTelegram()
    await this.secretStore.set(
      TELEGRAM_CREDENTIALS_KEY,
      JSON.stringify({ apiHash: input.apiHash, phoneNumber: input.phoneNumber })
    )
    this.settings = await this.settingsStore.setFlags({
      telegramConfigured: true,
      telegramApiId: input.apiId,
      telegramPhoneHint: maskPhone(input.phoneNumber)
    })
    this.setConnection('telegram', 'disconnected', '凭据已加密保存，等待连接')
    await this.audit.write('telegram_credentials_saved', 'info')
    await this.notify('success', 'Telegram 配置已保存', 'API hash 和登录会话只存放在系统安全存储中')
  }

  async connectTelegram(): Promise<void> {
    // Authentication can require a second IPC call for OTP/2FA. Do not keep
    // the initial connect IPC pending or the renderer would be unable to submit
    // that prompt while its connect action is busy.
    const existingMonitor = this.telegram
    if (existingMonitor) {
      if (existingMonitor.state !== 'error' && existingMonitor.state !== 'stopped') return
      this.telegram = undefined
      this.telegramLifecycleRevision += 1
      const disarm = this.disarmLiveTrading(
        'Telegram 错误连接正在重建，已保持锁定；恢复后需人工重新确认实盘'
      ).catch(() => undefined)
      await this.coordinator.finalizePendingRecoveryObservations(
        'Telegram 错误连接已替换，等待连续性校验的消息未进入 AI 分析'
      ).catch(() => undefined)
      await existingMonitor.stop().catch(() => undefined)
      await disarm
      // Another connect request may have installed a replacement while the
      // obsolete monitor performed its bounded stop.
      if (this.telegram) return
    }
    const apiId = this.settings.telegramApiId
    const stored = await this.readJsonSecret<{ apiHash: string; phoneNumber: string }>(
      TELEGRAM_CREDENTIALS_KEY
    )
    if (!apiId || !stored?.apiHash || !stored.phoneNumber) throw new Error('请先保存 Telegram API 凭据')
    this.setConnection('telegram', 'connecting', `正在通过 Clash 连接 @${this.settings.trading.channelUsername}`)
    let monitor!: TelegramMonitor
    monitor = new TelegramMonitor({
      apiId,
      apiHash: stored.apiHash,
      channel: normalizeChannelUsername(this.settings.trading.channelUsername),
      sessionSecretKey: TELEGRAM_SESSION_KEY,
      secretStore: this.secretStore,
      proxy: this.settings.proxy,
      auth: { phoneNumber: stored.phoneNumber },
      captureAuthorization: () => this.currentSignalTradeAuthorization(),
      callbacks: {
        onStatus: (status) => this.handleTelegramStatus(monitor, status),
        onAuthRequired: (request) => {
          if (this.telegram === monitor) this.createTelegramPrompt(request)
        },
        onMessageObserved: async (message) => {
          if (this.telegram !== monitor) return
          await this.coordinator.observeRecovered(toTelegramMessagePayload(message))
        },
        onMessage: async (message, context) => {
          if (this.telegram !== monitor) return
          await this.coordinator.process(
            toTelegramMessagePayload(message),
            context.authorizationToken
          )
        },
        onError: (event) => this.handleTelegramError(monitor, event)
      }
    })
    this.telegram = monitor
    this.telegramLifecycleRevision += 1
    // start() reaches the auth broker before waiting for OTP/2FA, so wait a
    // short moment to surface immediate configuration/proxy failures while
    // still returning control to the renderer for interactive auth prompts.
    const start = this.finishTelegramConnection(monitor)
    await Promise.race([
      start,
      new Promise<void>((resolve) => setTimeout(resolve, 400))
    ])
  }

  private async finishTelegramConnection(monitor: TelegramMonitor): Promise<void> {
    try {
      await monitor.start()
      if (this.telegram !== monitor) return
      this.pendingPrompt = undefined
      this.setConnection('telegram', 'connected', `已连接并守候 @${monitor.channelUsername}`)
      await this.audit.write('telegram_connected', 'info', { channel: monitor.channelUsername })
    } catch (error) {
      if (this.telegram !== monitor) return
      const disarm = this.disarmLiveTrading('Telegram 连接失败，已锁定实盘').catch(() => undefined)
      this.telegram = undefined
      this.telegramLifecycleRevision += 1
      const failedLifecycleRevision = this.telegramLifecycleRevision
      await this.coordinator.finalizePendingRecoveryObservations(
        'Telegram 连接失败，等待连续性校验的消息未进入 AI 分析'
      ).catch(() => undefined)
      await disarm
      if (this.telegram || this.telegramLifecycleRevision !== failedLifecycleRevision) return
      this.setConnection('telegram', 'error', errorText(error))
      await this.notify('error', 'Telegram 连接失败', errorText(error))
    }
  }

  async disconnectTelegram(): Promise<void> {
    this.pendingPrompt = undefined
    const monitor = this.telegram
    this.telegram = undefined
    if (monitor) this.telegramLifecycleRevision += 1
    const disconnectedLifecycleRevision = this.telegramLifecycleRevision
    // stopMonitoring flips monitoring/liveArmed synchronously before its first
    // await, so any already-running AI callback is fail-closed while the
    // transport performs its bounded drain.
    await this.stopMonitoring('Telegram 已断开').catch(() => undefined)
    if (monitor) {
      monitor.cancelAuthentication('用户断开 Telegram')
      await monitor.stop().catch(() => undefined)
    }
    if (this.telegram || this.telegramLifecycleRevision !== disconnectedLifecycleRevision) return
    this.setConnection(
      'telegram',
      this.settings?.telegramConfigured ? 'disconnected' : 'not_configured',
      this.settings?.telegramConfigured ? '已断开' : '未配置'
    )
  }

  async submitAuthPrompt(id: string, value: string): Promise<void> {
    const state = this.pendingPrompt
    if (!state || state.prompt.id !== id) throw new Error('登录输入已过期，请重新连接')
    if (!value.trim()) throw new Error('输入不能为空')
    const accepted = this.telegram?.provideAuth(state.field, value.trim()) ?? false
    if (!accepted) throw new Error('Telegram 当前未等待此项输入')
    this.pendingPrompt = undefined
    this.emitSnapshot()
  }

  async cancelAuthPrompt(id: string): Promise<void> {
    if (!this.pendingPrompt || this.pendingPrompt.prompt.id !== id) return
    this.telegram?.cancelAuthentication('用户取消登录')
    this.pendingPrompt = undefined
    this.emitSnapshot()
  }

  async loginChatGpt(): Promise<{ authUrl?: string; userCode?: string }> {
    if (this.chatgpt?.getStatus().authenticated) return {}
    await this.closeChatGptService()
    this.setConnection('chatgpt', 'connecting', '正在启动本机 ChatGPT 登录服务')
    const proxyUrl = proxyUrlForChild(this.settings.proxy)
    const service = new ChatGptService({
      proxyUrl,
      timeoutMs: this.settings.trading.aiTimeoutMs,
      cwd: path.resolve(this.options.userDataDirectory, '..')
    })
    this.chatgpt = service
    this.unsubscribeChatGptStatus = service.onStatus((status) => this.handleChatGptStatus(status))
    try {
      await service.start()
      if (service.getStatus().authenticated) {
        await service.listModels()
        await service.warmUp()
        this.settings = await this.settingsStore.setFlags({ chatgptConfigured: true })
        this.handleChatGptStatus(service.getStatus())
        return {}
      }
      try {
        const login = await service.startBrowserLogin()
        await this.options.openExternal(login.authUrl)
        void this.finishChatGptLogin(service, login.loginId)
        return { authUrl: login.authUrl }
      } catch {
        const login = await service.startDeviceCodeLogin()
        await this.options.openExternal(login.verificationUrl)
        void this.finishChatGptLogin(service, login.loginId)
        return { authUrl: login.verificationUrl, userCode: login.userCode }
      }
    } catch (error) {
      this.setConnection('chatgpt', 'error', errorText(error))
      throw error
    }
  }

  async disconnectChatGpt(): Promise<void> {
    const service = this.chatgpt
    if (service) await service.logout().catch(() => undefined)
    await this.closeChatGptService()
    await this.stopMonitoring('ChatGPT 已断开')
    this.settings = await this.settingsStore.setFlags({ chatgptConfigured: false })
    this.aiModel = undefined
    this.aiQuotaPercent = undefined
    this.aiQuotaExhausted = false
    this.setConnection('chatgpt', 'disconnected', '已退出 ChatGPT')
  }

  async saveOkxCredentials(raw: OkxCredentialsInput): Promise<void> {
    // Credential replacement is a high-risk lifecycle boundary. Revoke every
    // opening capability before the mutex can yield, including when a close or
    // another lifecycle action is already ahead in the queue.
    this.reserveOkxLifecycleChange()
    const input = okxCredentialsSchema.parse(raw)
    return this.okxLifecycleMutex.runExclusive(() => this.saveOkxCredentialsUnlocked(input))
  }

  private async saveOkxCredentialsUnlocked(input: OkxCredentialsInput): Promise<void> {
    const existing = await this.readJsonSecret<OkxCredentialsInput>(OKX_CREDENTIALS_KEY)
    if (existing && sameOkxCredentials(existing, input)) {
      // Re-saving byte-for-byte identical credentials is not an account
      // transition. It must not disconnect an account or clear order facts.
      return
    }

    if (existing) {
      const blockers = this.okxCredentialChangeBlockers()
      if (blockers.length > 0) {
        this.rememberOkxExposureFacts(blockers)
        throw new Error(`当前不能更换 OKX API 凭据：${blockers.join('；')}`)
      }
      const client = this.okx
      if (
        !client ||
        !this.okxStream ||
        this.connections.okx.phase !== 'connected'
      ) {
        const remembered = [...this.okxCredentialExposureFacts]
        const detail = remembered.length > 0
          ? `；本机仍记得：${remembered.join('；')}`
          : ''
        throw new Error(
          `当前不能更换 OKX API 凭据：必须先使用旧凭据重新连接旧账户，并完成实时只读暴露核验${detail}`
        )
      }
      await this.verifyOldOkxAccountIsClearForCredentialChange(client)
      this.assertOldOkxAccountStillClearForCredentialChange(client)
      await this.disconnectOkxUnlocked()
      this.coordinator.clearRuntimeState()
      this.pendingPositionCloses.clear()
      this.earlyCloseOrderUpdates.length = 0
      this.finalizedCloseOrderKeys.clear()
      this.finalizedCloseOrderKeyOrder.length = 0
      this.earlyDurableOrderUpdates.length = 0
      this.finalizedDurableMutationIds.clear()
      this.finalizedDurableMutationIdOrder.length = 0
      this.finalizedDurableOrderIdsByClient.clear()
      this.finalizedDurableClientIdsByOrder.clear()
      this.finalizedDurableMutationsPermittingOrderBinding.clear()
      this.finalizedDurableInstrumentIdsByClient.clear()
      this.finalizedDurableOperationsByClient.clear()
      this.startupDurableMutationIds.clear()
    }

    await this.secretStore.set(OKX_CREDENTIALS_KEY, JSON.stringify(input))
    this.settings = await this.settingsStore.setFlags({ okxConfigured: true })
    this.okxCredentialExposureStatus = 'unverified'
    this.okxCredentialExposureFacts.clear()
    this.setConnection('okx', 'disconnected', '凭据已加密保存，等待连接校验')
    await this.audit.write('okx_credentials_saved', 'info')
    await this.notify('success', 'OKX API 已保存', '连接时将校验子账户、Read + Trade 权限和 net 模式；提现权限仅作安全提醒')
  }

  async connectOkx(): Promise<void> {
    this.reserveOkxLifecycleChange()
    return this.okxLifecycleMutex.runExclusive(() => this.connectOkxUnlocked())
  }

  private async connectOkxUnlocked(): Promise<void> {
    if (this.mutationJournalFailure) throw new Error(this.mutationJournalFailure)
    const credentials = await this.readJsonSecret<OkxCredentialsInput>(OKX_CREDENTIALS_KEY)
    if (!credentials) throw new Error('请先保存 OKX 子账户 API 凭据')
    await this.disconnectOkxUnlocked()
    this.setConnection('okx', 'connecting', '正在连接 OKX 并校验子账户')
    let client!: OkxV5Client
    client = (this.options.createOkxClient ?? ((options) => new OkxV5Client(options)))({
      credentials,
      proxy: this.settings.proxy,
      onMutationLifecycle: (event) => this.handleOkxMutationLifecycle(client, event)
    })
    this.okx = client
    try {
      let verification = await client.verifyAccountConfiguration()
      this.rememberOkxVerificationExposure(verification)
      this.captureOkxRoutes(client)
      await this.auditOkxRoute('rest', this.okxRoutes.rest)
      const accountFingerprint = createOkxAccountFingerprint(verification.config.uid)
      this.okxAccountFingerprints.set(client, accountFingerprint)
      const hadRecoveredMutations = this.durableMutations.length > 0
      await this.recoverDurableMutations(client, verification, accountFingerprint)
      if (hadRecoveredMutations && this.durableMutations.length === 0) {
        // Recovery may have consumed a terminal order that appeared pending in
        // the first snapshot. Re-run the complete fail-closed exposure check.
        verification = await client.verifyAccountConfiguration()
        this.rememberOkxVerificationExposure(verification)
      }
      if (!verification.ok) throw new Error(verification.errors.join('；'))
      client.setLiveTradingArmed(false)
      const [instruments] = await Promise.all([
        client.getInstruments(),
        this.refreshPositions(client)
      ])
      this.okxInstruments = instruments
      await this.refreshPositions(client)
      const stream = client.createPrivateStream()
      stream.on('orders', (orders: OkxOrderUpdate[]) => {
        void this.handleOkxOrders(orders).catch((error) => {
          this.handlePrivateStreamProcessingFailure(client, stream, '订单更新', error)
        })
      })
      stream.on('positions', () => {
        void this.refreshPositions(client).catch((error) => {
          this.handlePrivateStreamProcessingFailure(client, stream, '持仓刷新', error)
        })
      })
      stream.on('status', (status: string) => {
        if (status === 'connected') {
          this.captureOkxRoutes(client)
          this.setConnection(
            'okx',
            'connected',
            `REST 与私有 WebSocket 已连接 · ${okxRoutesSummary(this.okxRoutes)}`
          )
          void this.reconcileTrackedOrders(client, 'private_ws_connected').catch((error) => {
            this.handleTrackedOrderReconciliationFailure(client, error)
          })
        }
        if (status === 'reconnecting') {
          void this.disarmLiveTrading('OKX 私有数据流重连中，已锁定实盘')
          this.setConnection(
            'okx',
            'connecting',
            `私有 WebSocket 正在通过${okxRouteLabel(this.okxRoutes.privateWs)}重连`
          )
        }
        if (status === 'disconnected' && this.okxStream === stream && !this.closing) {
          void this.disarmLiveTrading('OKX 私有数据流已断开，已立即锁定实盘')
          this.setConnection('okx', 'connecting', '私有 WebSocket 已断开，等待自动重连')
        }
      })
      stream.on('error', (error: Error) => {
        const detail = okxConnectionErrorDetail(error, credentials)
        this.lastError = detail
        void this.disarmLiveTrading('OKX 数据流异常，已锁定实盘')
        if (!this.closing && this.okxStream === stream) {
          this.setConnection('okx', 'error', detail)
          void this.audit.write('okx_private_stream_error', 'warning', {
            detail,
            ...okxTransportAuditFields(error)
          })
        }
      })
      this.okxStream = stream
      await stream.connect()
      this.captureOkxRoutes(client)
      await this.auditOkxRoute('private_ws', this.okxRoutes.privateWs)
      await this.reconcileTrackedOrders(client, 'initial_connect')
      this.updateOkxExposureStatusAfterConnectedVerification(client, verification)
      this.lastError = undefined
      this.setConnection(
        'okx',
        'connected',
        `子账户校验通过 · ${okxRoutesSummary(this.okxRoutes)}`
      )
      await this.audit.write('okx_connected_verified', 'info', {
        warningCount: verification.warnings.length,
        warnings: verification.warnings,
        routes: this.okxRoutes
      })
      if (verification.warnings.length) {
        await this.notify('warning', 'OKX 连接成功，但有安全提醒', verification.warnings.join('；'))
      }
    } catch (error) {
      const detail = okxConnectionErrorDetail(error, credentials)
      this.captureOkxRoutes(client)
      client.setLiveTradingArmed(false)
      this.okxStream?.disconnect()
      this.okxStream = undefined
      if (this.okx === client) this.okx = undefined
      this.lastError = detail
      this.setConnection('okx', 'error', detail)
      await this.audit.write('okx_connection_failed', 'warning', {
        detail,
        routes: this.okxRoutes,
        ...okxTransportAuditFields(error)
      }).catch(() => undefined)
      throw new Error(detail)
    }
  }

  async disconnectOkx(): Promise<void> {
    this.reserveOkxLifecycleChange()
    return this.okxLifecycleMutex.runExclusive(() => this.disconnectOkxUnlocked())
  }

  private async disconnectOkxUnlocked(): Promise<void> {
    this.captureCurrentOkxExposureFacts()
    if (this.reconciliationTimer) clearTimeout(this.reconciliationTimer)
    this.reconciliationTimer = undefined
    if (this.closeReconciliationTimer) clearTimeout(this.closeReconciliationTimer)
    this.closeReconciliationTimer = undefined
    const stream = this.okxStream
    this.okxStream = undefined
    this.okx = undefined
    this.okxRoutes = emptyOkxRoutes()
    this.okxInstruments = []
    this.positions = []
    stream?.disconnect()
    await this.disarmLiveTrading()
    if (this.settings) await this.stopMonitoring('OKX 已断开')
    this.setConnection(
      'okx',
      this.settings?.okxConfigured ? 'disconnected' : 'not_configured',
      this.settings?.okxConfigured ? '已断开' : '未配置'
    )
  }

  async updateSettings(raw: SettingsUpdateInput): Promise<void> {
    const input = settingsUpdateSchema.parse(raw)
    const prior = this.settings
    this.settings = await this.settingsStore.update(input)
    const proxyChanged = input.proxy && JSON.stringify(prior.proxy) !== JSON.stringify(this.settings.proxy)
    const channelChanged =
      input.trading?.channelUsername !== undefined &&
      prior.trading.channelUsername !== this.settings.trading.channelUsername
    const aiChanged =
      input.trading?.aiTimeoutMs !== undefined &&
      prior.trading.aiTimeoutMs !== this.settings.trading.aiTimeoutMs
    const tradingPolicyChanged = Boolean(input.trading)
    if (tradingPolicyChanged) await this.disarmLiveTrading('交易策略设置已变化，请重新确认实盘')
    if (proxyChanged || channelChanged || aiChanged) {
      await this.stopMonitoring('连接相关设置已变更，请重新连接')
      if (proxyChanged) await this.disconnectOkx()
      if (proxyChanged || channelChanged) await this.disconnectTelegram()
      if (proxyChanged || aiChanged) await this.closeChatGptService()
    }
    await this.audit.write('settings_updated', 'info', {
      proxyChanged: Boolean(proxyChanged),
      channelChanged,
      aiChanged
    })
    this.emitSnapshot()
  }

  async runNetworkDiagnostics(): Promise<NetworkDiagnostics> {
    this.diagnostics = await runNetworkDiagnostics({
      proxy: this.settings.proxy,
      timeoutMs: 8_000
    })
    await this.audit.write('network_diagnostics', this.diagnostics.proxyReachable ? 'info' : 'warning', {
      proxyReachable: this.diagnostics.proxyReachable,
      proxyProtocol: this.diagnostics.proxyProtocol,
      directIp: this.diagnostics.directIp,
      proxiedIp: this.diagnostics.proxiedIp,
      okxDirect: this.diagnostics.okxDirect
    })
    this.emitSnapshot()
    return structuredClone(this.diagnostics)
  }

  async startMonitoring(): Promise<void> {
    if (this.monitoring) return
    if (this.connectionBlockers().length) throw new Error(this.connectionBlockers().join('；'))
    const priorEmergencyStopped = this.emergencyStopped
    this.emergencyStopped = false
    this.monitoringRevision += 1
    this.monitoring = true
    try {
      await this.audit.write('monitoring_started', 'info')
      await this.notify('success', '监听已开启', `只处理现在起 @${this.settings.trading.channelUsername} 的新消息`)
      this.emitSnapshot()
    } catch (error) {
      this.monitoring = false
      this.monitoringRevision += 1
      this.emergencyStopped = priorEmergencyStopped
      this.invalidateOkxOpeningCapability()
      await this.coordinator.finalizePendingRecoveryObservations(
        '监听启动已回滚，等待连续性校验的消息未进入 AI 分析'
      ).catch(() => undefined)
      this.emitSnapshot()
      await this.audit.write('monitoring_start_rolled_back', 'warning', {
        error: errorText(error)
      }).catch(() => undefined)
      throw new Error(`监听开启未完成，已保持停止：${errorText(error)}`)
    }
  }

  async stopMonitoring(reason = '用户停止监听'): Promise<void> {
    const wasMonitoring = this.monitoring
    this.monitoringRevision += 1
    this.monitoring = false
    // Calling the async method starts its synchronous capability revocation
    // before any observation/UI cleanup is allowed to yield.
    const disarm = this.disarmLiveTrading()
    void disarm.catch(() => undefined)
    await this.coordinator.finalizePendingRecoveryObservations(
      `${reason}，等待连续性校验的消息未进入 AI 分析`
    ).catch(() => undefined)
    await disarm
    if (wasMonitoring) {
      await this.audit.write('monitoring_stopped', 'warning', { reason })
      await this.notify('info', '监听已停止', reason)
    } else {
      this.emitSnapshot()
    }
  }

  async armLiveTrading(confirmation: string): Promise<void> {
    if (this.activePositionClose || this.pendingPositionCloses.size > 0) {
      throw new Error('平仓操作仍在提交或等待最终状态，不能解锁实盘')
    }
    const durableBlockers = this.mutationJournalBlockers()
    if (durableBlockers.length > 0) throw new Error(durableBlockers.join('；'))
    const lifecycleRevision = this.okxLifecycleRevision
    const telegramMonitor = this.telegram
    const telegramRevision = telegramMonitor?.liveTradingReadiness.revision
    const telegramLifecycleRevision = this.telegramLifecycleRevision
    return this.okxLifecycleMutex.runExclusive(
      () => this.armLiveTradingUnlocked(
        confirmation,
        lifecycleRevision,
        telegramMonitor,
        telegramRevision,
        telegramLifecycleRevision
      )
    )
  }

  private async armLiveTradingUnlocked(
    confirmation: string,
    lifecycleRevision: number,
    telegramMonitor: TelegramMonitor | undefined,
    telegramRevision: number | undefined,
    telegramLifecycleRevision: number
  ): Promise<void> {
    if (confirmation !== LIVE_ARM_CONFIRMATION) throw new Error(`请输入“${LIVE_ARM_CONFIRMATION}”以解锁实盘`)
    if (!this.monitoring) throw new Error('请先开启监听')
    if (this.liveArmed) throw new Error('实盘已经解锁，无需重复解锁')
    if (!telegramMonitor || !telegramMonitor.liveTradingReadiness.ready) {
      throw new Error('Telegram 正在校验断线补拉，暂时不能解锁实盘')
    }
    const client = this.requireOkx()
    try {
      await this.refreshPositions(client)
    } catch (error) {
      await this.disarmLiveTrading('实盘解锁前无法刷新持仓，已保持锁定').catch(() => undefined)
      throw error
    }
    await this.reconcileTrackedOrders(client, 'before_arm')
    const blockers = this.armBlockers()
    if (blockers.length) throw new Error(blockers.join('；'))
    if (
      this.okxLifecycleRevision !== lifecycleRevision ||
      this.okx !== client ||
      this.connections.okx.phase !== 'connected' ||
      this.telegram !== telegramMonitor ||
      this.telegramLifecycleRevision !== telegramLifecycleRevision ||
      !telegramMonitor.liveTradingReadiness.ready ||
      telegramMonitor.liveTradingReadiness.revision !== telegramRevision
    ) {
      throw new Error('OKX 连接在交易前检查期间发生变化，或 Telegram 正在恢复，请重新确认')
    }
    client.setLiveTradingArmed(true)
    this.liveArmRevision += 1
    this.liveArmCapability = Object.freeze({})
    this.liveArmed = true
    this.armedAt = this.now()
    this.emergencyStopped = false
    try {
      await this.audit.write('live_trading_armed', 'critical', {
        notionalUsdt: this.settings.trading.orderNotionalUsdt,
        leverage: this.settings.trading.leverage,
        maxPositions: this.settings.trading.maxConcurrentPositions
      })
      await this.notify('warning', '实盘已解锁', '新消息可能触发真实 OKX 市价单；重启后会自动锁定')
      this.emitSnapshot()
    } catch (error) {
      this.invalidateOkxOpeningCapability()
      this.emitSnapshot()
      await this.audit.write('live_trading_arm_rolled_back', 'critical', {
        error: errorText(error)
      }).catch(() => undefined)
      throw new Error(`实盘解锁未完整记录，已自动回滚锁定：${errorText(error)}`)
    }
  }

  async disarmLiveTrading(reason?: string): Promise<void> {
    const wasArmed = this.liveArmed
    this.invalidateOkxOpeningCapability()
    if (wasArmed) {
      await this.audit.write('live_trading_disarmed', 'warning', { reason })
      if (reason) await this.notify('warning', '实盘已锁定', reason)
    }
    this.emitSnapshot()
  }

  async emergencyStop(): Promise<void> {
    this.monitoringRevision += 1
    this.monitoring = false
    this.emergencyStopped = true
    const disarm = this.disarmLiveTrading()
    void disarm.catch(() => undefined)
    await this.coordinator.finalizePendingRecoveryObservations(
      '已紧急停止，等待连续性校验的消息未进入 AI 分析'
    ).catch(() => undefined)
    await disarm
    await this.audit.write('emergency_stop', 'critical', {
      openPositions: this.positions.map((position) => position.instrumentId)
    })
    await this.notify('error', '已紧急停止', '监听和新下单已停止；现有仓位不会自动平仓，请在确认后手动处理')
    this.emitSnapshot()
  }

  async closePosition(input: ClosePositionInput): Promise<void> {
    if (this.activePositionClose) throw new Error('已有平仓操作正在提交，请等待其最终状态')
    const durableBlockers = this.mutationJournalBlockers()
    if (durableBlockers.length > 0) {
      throw new Error(`当前不能提交新的平仓 mutation：${durableBlockers.join('；')}`)
    }

    // A close request is a risk-reduction boundary. Invalidate every old
    // opening capability synchronously, before validation, position refresh,
    // audit, UI work, or any other await can yield back to a signal task.
    this.reserveOkxLifecycleChange()

    if (input.confirmation !== CLOSE_POSITION_CONFIRMATION) {
      this.emitSnapshot()
      throw new Error(`请输入“${CLOSE_POSITION_CONFIRMATION}”以提交真实平仓`)
    }

    let task!: Promise<void>
    task = this.okxLifecycleMutex.runExclusive(async () => {
      const client = this.okx
      try {
        if (!client || !this.okxStream || this.connections.okx.phase !== 'connected') {
          throw new Error('OKX 私有连接尚未就绪，无法安全平仓')
        }
        await this.closePositionInternal(input, client)
      } finally {
        // The OKX client is armed only inside the one close transaction below.
        // Re-lock it and release the controller interlock before the lifecycle
        // mutex admits credential or connection work.
        this.liveArmed = false
        this.armedAt = undefined
        client?.setLiveTradingArmed(false)
        if (this.okx && this.okx !== client) this.okx.setLiveTradingArmed(false)
        if (this.activePositionClose === task) this.activePositionClose = undefined
        this.emitSnapshot()
      }
    })
    this.activePositionClose = task
    try {
      this.emitSnapshot()
    } catch (error) {
      // A renderer/listener failure cannot release the close interlock or skip
      // the mandatory client re-lock inside the exclusive operation.
      this.lastError = `平仓互锁状态展示失败：${errorText(error)}`
    }
    await task
  }

  private async closePositionInternal(
    input: ClosePositionInput,
    client: OkxV5Client
  ): Promise<void> {
    const instrumentId = input.instrumentId.trim().toUpperCase()
    if (this.pendingPositionCloses.has(instrumentId)) {
      throw new Error('该仓位已有平仓请求等待最终状态，请勿重复提交')
    }
    try {
      await this.refreshPositions(client)
    } catch (error) {
      await this.disarmLiveTrading('平仓前无法刷新持仓，已自动锁定实盘').catch(() => undefined)
      throw error
    }
    if (!this.positions.some((position) => position.instrumentId === instrumentId)) {
      throw new Error('该仓位已不存在，请刷新后再试')
    }
    if (
      this.okx !== client ||
      !this.okxStream ||
      this.connections.okx.phase !== 'connected'
    ) {
      throw new Error('平仓前 OKX 私有连接已变化，请确认连接后重试')
    }

    this.pendingPositionCloses.set(instrumentId, {
      instrumentId,
      state: 'submitting',
      submittedAt: this.now()
    })
    try {
      this.decoratePositionsWithPendingCloses()
      this.emitSnapshot()
    } catch (error) {
      this.pendingPositionCloses.delete(instrumentId)
      await this.disarmLiveTrading('本地平仓状态无法记录，未发送平仓请求').catch(() => undefined)
      throw new Error(`本地平仓状态无法记录，未发送平仓请求：${errorText(error)}`)
    }

    let result: Awaited<ReturnType<OkxV5Client['closeEntirePosition']>>
    try {
      // Manual close deliberately does not arm the controller. Only the OKX
      // client receives a short-lived close-scoped capability, while the
      // active/pending close interlocks keep every automated open gate shut.
      this.closeScopedArmedClient = client
      client.setLiveTradingArmed(true)
      const arm = client.armNextLiveTrade('close')
      result = await client.closeEntirePosition({
        instId: instrumentId,
        arm,
        method: 'reduce-only'
      })
    } catch (error) {
      if (error instanceof OkxOrderStateUnknownError && error.operation === 'close') {
        const pending: PendingPositionClose = {
          instrumentId: error.instId,
          clientOrderId: error.clOrdId,
          state: 'unknown',
          submittedAt: this.now()
        }
        this.pendingPositionCloses.set(error.instId, pending)
        try {
          this.decoratePositionsWithPendingCloses()
          this.emitSnapshot()
        } catch {
          // The pending-close interlock above is the authoritative safety fact.
        }
        await this.disarmLiveTrading('平仓结果未知，已锁定实盘并禁止重试').catch(() => undefined)
        await this.audit.write('position_close_state_unknown', 'critical', {
          instrumentId: error.instId,
          clientOrderId: error.clOrdId
        }).catch(() => undefined)
        await this.notify(
          'error',
          '平仓结果未知，禁止重试',
          `${error.instId} 已开始只读对账；在最终状态确认前不能再次平仓`
        ).catch(() => undefined)
        await this.replayEarlyCloseOrderUpdates(pending).catch(() => undefined)
        this.scheduleUnknownOrderReconciliation(client, error)
        throw new Error('OKX 平仓结果未知，已锁定实盘并开始只读对账；请勿重复提交')
      }
      this.pendingPositionCloses.delete(instrumentId)
      try {
        this.decoratePositionsWithPendingCloses()
        this.emitSnapshot()
      } catch {
        // The map interlock has already been cleared for a known-safe failure.
      }
      await this.disarmLiveTrading('平仓请求异常，已自动锁定实盘').catch(() => undefined)
      throw error
    } finally {
      // Never let the risk-reduction capability leak into signal processing.
      this.liveArmed = false
      this.armedAt = undefined
      try {
        client.setLiveTradingArmed(false)
      } finally {
        if (this.closeScopedArmedClient === client) this.closeScopedArmedClient = undefined
      }
    }

    const pending: PendingPositionClose = {
      instrumentId,
      orderId: result.ordId,
      clientOrderId: result.clOrdId,
      state: 'accepted',
      submittedAt: this.now()
    }
    // REST sCode=0 only acknowledges receipt. Persist the authoritative
    // pending-close interlock before any UI, audit, or refresh side effect.
    this.pendingPositionCloses.set(instrumentId, pending)
    let localError: unknown
    const run = async (effect: () => Promise<void>): Promise<void> => {
      try {
        await effect()
      } catch (error) {
        localError ??= error
      }
    }
    await run(async () => {
      this.decoratePositionsWithPendingCloses()
      this.emitSnapshot()
    })
    await run(() => this.audit.write('position_close_submitted', 'critical', {
      instrumentId,
      orderId: result.ordId,
      clientOrderId: result.clOrdId,
      size: result.closedSize,
      executionState: result.executionState
    }))
    await run(() => this.notify(
      'warning',
      '平仓请求已受理',
      `${instrumentId} · reduce-only 市价整仓，等待最终成交状态`
    ))
    await run(() => this.replayEarlyCloseOrderUpdates(pending))
    await run(() => this.refreshPositions(client))
    await this.disarmLiveTrading('平仓请求已受理，等待最终状态后方可重新解锁').catch((error) => {
      localError ??= error
    })
    if (localError) {
      this.lastError = `平仓请求已受理，但本地状态记录异常：${errorText(localError)}`
      await this.notify(
        'error',
        '平仓已受理，但本地记录异常',
        `${instrumentId} 仍处于平仓处理中；请以 OKX 状态为准，禁止重复提交`
      ).catch(() => undefined)
      await this.audit.write('accepted_close_local_side_effect_failed', 'critical', {
        instrumentId,
        orderId: result.ordId,
        clientOrderId: result.clOrdId,
        error: errorText(localError)
      }).catch(() => undefined)
    }
  }

  async clearNotifications(): Promise<void> {
    this.notifications = []
    this.emitSnapshot()
  }

  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.monitoringRevision += 1
    this.monitoring = false
    this.invalidateOkxOpeningCapability()
    const client = this.okx
    const stream = this.okxStream
    await this.telegram?.stop().catch(() => undefined)
    await this.coordinator.finalizePendingRecoveryObservations(
      '应用已关闭，等待连续性校验的消息未进入 AI 分析'
    ).catch(() => undefined)
    if (this.telegram) {
      this.telegram = undefined
      this.telegramLifecycleRevision += 1
    }
    await this.coordinator.shutdown()
    await this.activePositionClose?.catch(() => undefined)
    if (client) {
      await this.reconcileTrackedOrders(client, 'application_shutdown').catch(() => undefined)
    }
    stream?.disconnect()
    if (this.reconciliationTimer) clearTimeout(this.reconciliationTimer)
    this.reconciliationTimer = undefined
    if (this.closeReconciliationTimer) clearTimeout(this.closeReconciliationTimer)
    this.closeReconciliationTimer = undefined
    this.okxStream = undefined
    await this.trackedOrderReconciliation?.catch(() => undefined)
    await this.closeChatGptService()
    await this.audit.write('application_stopped', 'info', {
      pendingOpenOrder: this.coordinator.hasPendingOrder,
      pendingCloseCount: this.pendingPositionCloses.size
    })
  }

  private async finishChatGptLogin(service: ChatGptService, loginId: string): Promise<void> {
    try {
      const result = await service.waitForLogin(loginId)
      if (this.chatgpt !== service) return
      if (!result.success) throw new Error(result.error ?? 'ChatGPT 登录失败')
      this.settings = await this.settingsStore.setFlags({ chatgptConfigured: true })
      this.handleChatGptStatus(service.getStatus())
      await this.audit.write('chatgpt_connected', 'info', {
        model: service.getStatus().selectedModel
      })
      await this.notify('success', 'ChatGPT Plus 已连接', `快速模型：${service.getStatus().selectedModel ?? '自动选择'}`)
    } catch (error) {
      if (this.chatgpt === service) this.setConnection('chatgpt', 'error', errorText(error))
    }
  }

  private handleTelegramStatus(source: TelegramMonitor, status: TelegramStatusEvent): void {
    if (this.closing || this.telegram !== source) return
    if (status.state === 'connected' && !source.liveTradingReadiness.ready) {
      void this.disarmLiveTrading(
        'Telegram 报告已连接但恢复门禁尚未就绪，已保持锁定；请重新连接并人工确认实盘'
      ).catch(() => undefined)
      this.setConnection('telegram', 'error', '连接恢复校验尚未完成')
      return
    }

    const retainLiveArm =
      status.state === 'reconnecting' &&
      this.monitoring &&
      this.liveArmed &&
      Boolean(this.liveArmCapability)
    const newlySuspendedRetainedArm = retainLiveArm && !this.telegramReconnectRetainedArm
    if (newlySuspendedRetainedArm) {
      this.telegramReconnectRetainedArm = true
    } else if (status.state !== 'connected' && status.state !== 'reconnecting') {
      const detail = status.detail ? `（${status.detail}）` : ''
      void this.disarmLiveTrading(
        `Telegram 状态变为 ${status.state}${detail}，已锁定实盘；连接恢复后需人工重新确认`
      ).catch(() => undefined)
    }
    if (status.state === 'connected') {
      const resumedRetainedArm =
        this.telegramReconnectRetainedArm &&
        this.monitoring &&
        this.liveArmed &&
        Boolean(this.liveArmCapability)
      this.telegramReconnectRetainedArm = false
      this.setConnection('telegram', 'connected', status.detail ?? '频道连接正常')
      if (resumedRetainedArm) {
        void this.audit.write('telegram_reconnect_live_resumed', 'warning', {
          monitoringRevision: this.monitoringRevision,
          armRevision: this.liveArmRevision,
          recoveryRevision: source.liveTradingReadiness.revision
        }).catch(() => undefined)
        void this.notify(
          'success',
          'Telegram 已恢复',
          '消息连续性与登录授权校验已通过；仅恢复后新到达的消息可继续触发实盘'
        ).catch(() => undefined)
      }
    } else if (
      status.state === 'connecting' ||
      status.state === 'authenticating' ||
      status.state === 'reconnecting'
    ) {
      this.setConnection('telegram', 'connecting', status.detail ?? status.state)
    } else if (status.state === 'error') {
      this.setConnection('telegram', 'error', status.detail ?? '连接异常')
    } else {
      this.setConnection('telegram', 'disconnected', status.detail ?? status.state)
    }
    if (newlySuspendedRetainedArm) {
      void this.audit.write('telegram_reconnect_live_suspended', 'warning', {
        monitoringRevision: this.monitoringRevision,
        armRevision: this.liveArmRevision
      }).catch(() => undefined)
      void this.notify(
        'warning',
        'Telegram 正在自动重连',
        '网络恢复与消息连续性校验期间不会下单；校验成功后将自动继续实盘监听'
      ).catch(() => undefined)
    }
    if (status.proxyProtocol) {
      this.diagnostics = { ...this.diagnostics, proxyProtocol: status.proxyProtocol }
    }
  }

  private async handleTelegramError(
    source: TelegramMonitor,
    event: TelegramMonitorError
  ): Promise<void> {
    if (this.closing || this.telegram !== source) return
    // Recoverable teleproto errors are diagnostic signals only. Confirmed
    // transport changes are published through handleTelegramStatus(), which
    // remains the single authority that suspends or revokes live trading.
    if (!event.recoverable) {
      this.lastError = event.message
      await this.disarmLiveTrading(
        'Telegram 发生不可恢复错误，已锁定实盘；恢复后需人工重新确认'
      ).catch(() => undefined)
    }
    await this.audit.write('telegram_transport_error', event.recoverable ? 'warning' : 'critical', {
      recoverable: event.recoverable,
      transportErrorKind: event.code,
      monitorState: this.telegram?.state
    }).catch(() => undefined)
    await this.notify(
      event.recoverable ? 'warning' : 'error',
      event.recoverable ? 'Telegram 瞬时通信异常' : 'Telegram 连接异常',
      event.recoverable
        ? `${event.message}；程序将通过连续健康检查确认是否真的断线`
        : event.message
    )
  }

  private handleChatGptStatus(status: ReturnType<ChatGptService['getStatus']>): void {
    const wasQuotaExhausted = this.aiQuotaExhausted
    this.aiModel = status.selectedModel ?? undefined
    this.aiQuotaExhausted = status.quotaExhausted
    this.aiQuotaPercent = status.quotaExhausted ? 100 : rateLimitUsedPercent(status.rateLimits)
    const serviceReady = status.authenticated && status.warmedUp && !status.lastError
    const analysisReady = serviceReady && !status.quotaExhausted
    if (!analysisReady) {
      void this.disarmLiveTrading(
        status.quotaExhausted
          ? 'ChatGPT 额度已用尽，已锁定实盘；Telegram 监听继续运行，额度恢复后需人工重新确认实盘'
          : 'ChatGPT 分析服务已离开就绪状态，已锁定实盘；恢复后需人工重新确认'
      ).catch(() => undefined)
    }
    if (serviceReady) {
      this.setConnection(
        'chatgpt',
        'connected',
        status.quotaExhausted
          ? '额度已用尽：无法进行 AI 分析或自动下单；Telegram 监听仍在运行'
          : `已预热 ${status.selectedModel ?? '快速模型'}${status.busy ? ' · 分析中' : ''}`
      )
    } else if (status.lastError) {
      this.setConnection('chatgpt', 'error', status.lastError)
    } else if (status.authenticated || status.initialized) {
      this.setConnection('chatgpt', 'connecting', status.authenticated ? '模型预热中' : '等待浏览器登录')
    } else {
      this.setConnection('chatgpt', 'disconnected', 'ChatGPT 服务未就绪')
    }
    if (status.lastError) this.lastError = status.lastError
    if (status.quotaExhausted && !wasQuotaExhausted) {
      void this.audit.write('chatgpt_quota_exhausted', 'warning', {
        monitoringContinues: this.monitoring
      }).catch(() => undefined)
      void this.notify(
        'warning',
        'ChatGPT 额度已用尽',
        '当前无法进行 AI 分析或自动下单；Telegram 监听与频道消息接收将继续'
      ).catch(() => undefined)
    }
    this.emitSnapshot()
  }

  private async closeChatGptService(): Promise<void> {
    this.unsubscribeChatGptStatus?.()
    this.unsubscribeChatGptStatus = undefined
    const service = this.chatgpt
    this.chatgpt = undefined
    if (service) await service.close().catch(() => undefined)
    this.aiQuotaExhausted = false
  }

  private createTelegramPrompt(request: TelegramAuthRequest): void {
    const prompt: AuthPrompt = {
      id: randomUUID(),
      kind:
        request.field === 'phoneNumber'
          ? 'telegram_phone'
          : request.field === 'phoneCode'
            ? 'telegram_code'
            : 'telegram_password',
      title:
        request.field === 'phoneNumber'
          ? '输入 Telegram 手机号'
          : request.field === 'phoneCode'
            ? '输入 Telegram 验证码'
            : '输入两步验证密码',
      detail:
        request.field === 'phoneCode'
          ? request.isCodeViaApp
            ? '验证码已发送至 Telegram App'
            : '请输入收到的 Telegram 验证码'
          : request.hint ?? '凭据只在主进程内用于本次登录',
      secret: request.field !== 'phoneNumber'
    }
    this.pendingPrompt = { prompt, field: request.field }
    this.emit('event', { type: 'auth-prompt', payload: prompt })
    this.emitSnapshot()
  }

  private async handleOkxOrders(orders: OkxOrderUpdate[]): Promise<void> {
    for (const order of orders) {
      await this.persistDurableOrderEvidence(order)
      await this.coordinator.handleOrderUpdate({
        clientOrderId: order.clOrdId,
        orderId: order.ordId,
        state: order.state,
        instrumentId: order.instId,
        fillSize: order.fillSz,
        accumulatedFillSize: order.accFillSz,
        averageFillPrice: order.avgPx ?? order.fillPx
      })
      await this.handlePendingCloseOrderUpdate(order)
    }
    await this.refreshPositions().catch(() => undefined)
  }

  private async refreshPositions(client = this.okx): Promise<void> {
    if (!client) throw new Error('OKX 尚未连接')
    if (this.positionRefresh) return this.positionRefresh
    this.positionRefresh = (async () => {
      const raw = await client.getPositions()
      if (this.okx !== client) return
      await this.applyPositionSnapshot(raw)
    })().finally(() => {
      this.positionRefresh = undefined
    })
    return this.positionRefresh
  }

  private async applyPositionSnapshot(raw: OkxPosition[]): Promise<void> {
    const snapshot = okxPositionsToAppPositions(raw, this.okxInstruments)
    if (snapshot.positions.length > 0) {
      this.rememberOkxExposureFacts([
        `旧账户曾检测到 ${snapshot.positions.length} 个 SWAP 持仓`
      ])
    }
    const openInstrumentIds = new Set(snapshot.positions.map((position) => position.instrumentId))
    const confirmedCloses: PendingPositionClose[] = []
    for (const [instrumentId, pending] of this.pendingPositionCloses) {
      if (
        !openInstrumentIds.has(instrumentId) &&
        pending.state !== 'submitting' &&
        pending.state !== 'unknown'
      ) {
        if (pending.clientOrderId) {
          await this.resolveDurableMutation(
            pending.clientOrderId,
            'same_origin_position_effect'
          )
        }
        this.pendingPositionCloses.delete(instrumentId)
        this.rememberFinalizedClose(pending)
        confirmedCloses.push(pending)
      }
    }
    this.positions = snapshot.positions
    this.decoratePositionsWithPendingCloses()
    this.coordinator.reconcilePositions(this.positions)
    if (snapshot.warnings.length) this.lastError = snapshot.warnings.join('；')
    this.emitSnapshot()

    for (const close of confirmedCloses) {
      await this.audit.write('position_close_confirmed_by_position', 'critical', {
        instrumentId: close.instrumentId,
        orderId: close.orderId,
        clientOrderId: close.clientOrderId,
        priorState: close.state
      }).catch((error) => {
        this.lastError = `平仓确认审计写入失败：${errorText(error)}`
      })
      await this.notify(
        'success',
        '仓位已平',
        `${close.instrumentId} 已通过只读持仓刷新确认归零`
      ).catch(() => undefined)
    }
  }

  private decoratePositionsWithPendingCloses(): void {
    this.positions = this.positions.map((position) => {
      const pending = this.pendingPositionCloses.get(position.instrumentId)
      if (!pending) {
        const { closePending: _closePending, closeOrderState: _closeOrderState, ...rest } = position
        return rest
      }
      return {
        ...position,
        closePending: true,
        closeOrderState: pending.state
      }
    })
  }

  private async handlePendingCloseOrderUpdate(order: OkxOrderUpdate): Promise<boolean> {
    const clientOrderId = cleanOkxValue(order.clOrdId)
    const orderId = cleanOkxValue(order.ordId)
    if (
      (clientOrderId && this.finalizedCloseOrderKeys.has(`client:${clientOrderId}`)) ||
      (orderId && this.finalizedCloseOrderKeys.has(`order:${orderId}`))
    ) {
      return false
    }
    const pending = [...this.pendingPositionCloses.values()].find(
      (candidate) =>
        (clientOrderId && candidate.clientOrderId === clientOrderId) ||
        (orderId && candidate.orderId === orderId)
    )
    if (!pending) {
      if (clientOrderId || orderId) this.bufferEarlyCloseOrderUpdate(order)
      return false
    }

    const state = normalizeOkxOrderState(order.state)
    const fingerprint = closeOrderUpdateFingerprint(order)
    if (pending.lastFingerprint === fingerprint) return true
    pending.lastFingerprint = fingerprint
    pending.clientOrderId ??= clientOrderId
    pending.orderId ??= orderId

    if (state === 'live') pending.state = 'live'
    if (state === 'partially_filled') pending.state = 'partially_filled'
    const terminal = Boolean(state && TERMINAL_OKX_ORDER_STATES.has(state))
    const accumulatedFill = positiveNumber(order.accFillSz ?? order.fillSz)
    if (terminal) {
      this.pendingPositionCloses.delete(pending.instrumentId)
      this.rememberFinalizedClose(pending)
    } else {
      this.pendingPositionCloses.set(pending.instrumentId, pending)
    }
    this.decoratePositionsWithPendingCloses()
    this.emitSnapshot()

    await this.audit.write('position_close_state_updated', terminal ? 'critical' : 'info', {
      instrumentId: pending.instrumentId,
      orderId: pending.orderId,
      clientOrderId: pending.clientOrderId,
      state,
      fillSize: order.fillSz,
      accumulatedFillSize: order.accFillSz,
      averageFillPrice: order.avgPx ?? order.fillPx,
      terminal
    }).catch((error) => {
      this.lastError = `平仓状态审计写入失败：${errorText(error)}`
    })

    if (state === 'partially_filled') {
      await this.disarmLiveTrading('平仓单已部分成交，等待最终状态').catch(() => undefined)
      await this.notify(
        'warning',
        '平仓单部分成交',
        `${pending.instrumentId} 已部分成交，禁止重复平仓并继续等待最终状态`
      ).catch(() => undefined)
    } else if (state === 'filled') {
      await this.notify('success', '平仓单已全部成交', `${pending.instrumentId} 已完成平仓`).catch(() => undefined)
    } else if (terminal) {
      const detail = accumulatedFill > 0
        ? `${pending.instrumentId} 部分成交后最终状态为 ${state}，请以当前仓位为准`
        : `${pending.instrumentId} 平仓单最终状态为 ${state}，仓位可能仍存在`
      await this.notify('warning', '平仓单已结束', detail).catch(() => undefined)
    }
    return true
  }

  private bufferEarlyCloseOrderUpdate(order: OkxOrderUpdate): void {
    this.earlyCloseOrderUpdates.push(structuredClone(order))
    while (this.earlyCloseOrderUpdates.length > EARLY_CLOSE_ORDER_UPDATE_LIMIT) {
      this.earlyCloseOrderUpdates.shift()
    }
  }

  private async replayEarlyCloseOrderUpdates(pending: PendingPositionClose): Promise<void> {
    const matches: OkxOrderUpdate[] = []
    for (let index = this.earlyCloseOrderUpdates.length - 1; index >= 0; index -= 1) {
      const update = this.earlyCloseOrderUpdates[index]!
      if (
        (pending.clientOrderId && update.clOrdId === pending.clientOrderId) ||
        (pending.orderId && update.ordId === pending.orderId)
      ) {
        matches.unshift(update)
        this.earlyCloseOrderUpdates.splice(index, 1)
      }
    }
    for (const update of matches) await this.handlePendingCloseOrderUpdate(update)
  }

  private rememberFinalizedClose(pending: PendingPositionClose): void {
    const keys = [
      pending.clientOrderId ? `client:${pending.clientOrderId}` : undefined,
      pending.orderId ? `order:${pending.orderId}` : undefined
    ].filter((value): value is string => Boolean(value))
    for (const key of keys) {
      if (this.finalizedCloseOrderKeys.has(key)) continue
      this.finalizedCloseOrderKeys.add(key)
      this.finalizedCloseOrderKeyOrder.push(key)
    }
    while (this.finalizedCloseOrderKeyOrder.length > FINALIZED_CLOSE_ORDER_KEY_LIMIT) {
      const oldest = this.finalizedCloseOrderKeyOrder.shift()
      if (oldest) this.finalizedCloseOrderKeys.delete(oldest)
    }
  }

  private async reconcileTrackedOrders(client: OkxV5Client, reason: string): Promise<void> {
    if (this.trackedOrderReconciliation) return this.trackedOrderReconciliation
    const task = (async () => {
      const pendingSignal = this.coordinator.pendingOrder
      const pendingCloses = [...this.pendingPositionCloses.values()].filter(
        (pending) => pending.state !== 'submitting'
      )
      if (!pendingSignal && pendingCloses.length === 0) return
      if (this.okx !== client) return

      const [pendingOrders, rawPositions] = await Promise.all([
        client.getPendingOrders(),
        client.getPositions()
      ])
      if (this.okx !== client) return

      if (pendingSignal?.instrumentId) {
        const trackedSignal = {
          instrumentId: pendingSignal.instrumentId,
          orderId: pendingSignal.orderId,
          clientOrderId: pendingSignal.clientOrderId
        }
        const pendingMatch = findTrackedOkxOrder(pendingOrders, trackedSignal)
        const order = pendingMatch ?? await this.queryTrackedOrder(client, trackedSignal)
        if (order) {
          await this.persistDurableOrderEvidence(order)
          await this.coordinator.handleOrderUpdate(toSignalOrderUpdate(order))
        } else if (hasOpenOkxPosition(rawPositions, pendingSignal.instrumentId)) {
          await this.resolveDurableMutation(
            pendingSignal.clientOrderId,
            'same_origin_position_effect'
          )
          await this.coordinator.confirmPendingOrderFromPosition({
            clientOrderId: pendingSignal.clientOrderId,
            instrumentId: pendingSignal.instrumentId
          })
        }
      }

      for (const pending of pendingCloses) {
        const pendingMatch = findTrackedOkxOrder(pendingOrders, pending)
        const order = pendingMatch ?? await this.queryTrackedOrder(client, pending)
        if (order) {
          await this.persistDurableOrderEvidence(order)
          await this.handlePendingCloseOrderUpdate(order)
        }
      }

      if (this.okx !== client) return
      await this.applyPositionSnapshot(rawPositions)
      await this.audit.write('tracked_orders_reconciled', 'info', {
        reason,
        pendingSignal: this.coordinator.hasPendingOrder,
        pendingCloseCount: this.pendingPositionCloses.size
      })
    })()
    this.trackedOrderReconciliation = task
    try {
      await task
    } finally {
      if (this.trackedOrderReconciliation === task) this.trackedOrderReconciliation = undefined
    }
  }

  private async queryTrackedOrder(
    client: OkxV5Client,
    tracked: { instrumentId: string; orderId?: string; clientOrderId?: string }
  ): Promise<OkxOrder | undefined> {
    if (!tracked.orderId && !tracked.clientOrderId) return undefined
    try {
      return await client.getOrder({
        instId: tracked.instrumentId,
        ...(tracked.orderId
          ? { ordId: tracked.orderId }
          : { clOrdId: tracked.clientOrderId! })
      })
    } catch (error) {
      if (error instanceof OkxApiError && ['51603', '51400'].includes(error.code)) return undefined
      throw error
    }
  }

  private handleTrackedOrderReconciliationFailure(client: OkxV5Client, error: unknown): void {
    if (this.okx !== client || this.closing) return
    const detail = `订单只读对账失败：${errorText(error)}`
    this.lastError = detail
    void this.disarmLiveTrading('订单只读对账失败，已锁定实盘').catch(() => undefined)
    void this.audit.write('tracked_orders_reconciliation_failed', 'warning', {
      detail
    }).catch(() => undefined)
    this.emitSnapshot()
  }

  private handlePrivateStreamProcessingFailure(
    client: OkxV5Client,
    stream: OkxPrivateStream,
    scope: string,
    error: unknown
  ): void {
    if (this.okx !== client || this.okxStream !== stream || this.closing) return
    const detail = `OKX 私有数据流${scope}失败：${errorText(error)}`
    this.lastError = detail
    void this.disarmLiveTrading(detail).catch(() => undefined)
    this.setConnection('okx', 'error', detail)
    void this.audit.write('okx_private_stream_processing_failed', 'warning', {
      scope,
      detail
    }).catch(() => undefined)
  }

  private scheduleUnknownOrderReconciliation(
    client: OkxV5Client,
    error: OkxOrderStateUnknownError,
    attempt = 0
  ): void {
    const isClose = error.operation === 'close'
    const currentTimer = isClose ? this.closeReconciliationTimer : this.reconciliationTimer
    if (currentTimer) clearTimeout(currentTimer)
    const delays = [1_500, 3_000, 7_500, 15_000, 30_000]
    const delay = delays[Math.min(attempt, delays.length - 1)]!
    const timer = setTimeout(() => {
      if (isClose) this.closeReconciliationTimer = undefined
      else this.reconciliationTimer = undefined
      void (async () => {
        if (this.okx !== client || !client.requiresOrderReconciliation) return
        try {
          const result = await client.reconcileUnknownOrder(error)
          await this.audit.write('unknown_order_reconciliation', result.safeToClear ? 'critical' : 'warning', {
            operation: error.operation,
            instrumentId: error.instId,
            clientOrderId: error.clOrdId,
            safeToClear: result.safeToClear,
            orderId: result.order?.ordId,
            state: result.order?.state,
            positionCount: result.positions.length,
            reason: result.reason
          })
          if (!result.safeToClear) {
            this.scheduleUnknownOrderReconciliation(client, error, attempt + 1)
            return
          }
          if (result.order) {
            await this.persistDurableOrderEvidence(result.order)
            if (isClose) await this.handlePendingCloseOrderUpdate(result.order)
            else await this.coordinator.handleOrderUpdate(toSignalOrderUpdate(result.order))
          } else {
            // `safeToClear` without an order is only emitted by the service
            // after a visible position effect or its bounded 30-second
            // read-only absence window. Never synthesize absence from a
            // single not-found response in the controller.
            await this.resolveUnknownOrderWithoutExchangeOrder(error, result)
          }
          await this.refreshPositions(client)
          client.confirmOrderReconciled()
          await this.notify(
            'warning',
            '状态未知订单已完成只读对账',
            `${error.instId} · ${result.order?.state ?? (
              isClose
                ? result.positions.length
                  ? '已确认旧平仓请求不存在，仓位仍保留'
                  : '已确认仓位归零'
                : result.positions.length
                  ? '已形成仓位'
                  : '已确认订单不存在'
            )}`
          )
        } catch (reconcileError) {
          this.lastError = `订单对账失败：${errorText(reconcileError)}`
          this.scheduleUnknownOrderReconciliation(client, error, attempt + 1)
        }
      })()
    }, delay)
    if (isClose) this.closeReconciliationTimer = timer
    else this.reconciliationTimer = timer
    timer.unref?.()
  }

  private async resolveUnknownOrderWithoutExchangeOrder(
    error: OkxOrderStateUnknownError,
    result: OkxOrderReconciliationResult
  ): Promise<void> {
    if (!result.safeToClear) {
      throw new Error('拒绝根据单次未找到结果释放未知订单互锁')
    }
    const hasPosition = hasOpenOkxPosition(result.positions, error.instId)
    await this.resolveDurableMutation(
      error.clOrdId,
      error.operation === 'open'
        ? hasPosition
          ? 'same_origin_position_effect'
          : 'same_origin_absence_window'
        : hasPosition
          ? 'same_origin_absence_window'
          : 'same_origin_position_effect'
    )
    if (error.operation === 'open') {
      if (hasPosition) {
        await this.coordinator.confirmPendingOrderFromPosition({
          clientOrderId: error.clOrdId,
          instrumentId: error.instId
        })
      } else {
        await this.coordinator.confirmPendingOrderAbsent({
          clientOrderId: error.clOrdId,
          instrumentId: error.instId,
          reason: result.reason
        })
      }
      return
    }

    const pending = this.pendingPositionCloses.get(error.instId)
    if (!pending || pending.clientOrderId !== error.clOrdId) return
    this.pendingPositionCloses.delete(error.instId)
    this.rememberFinalizedClose(pending)
    this.decoratePositionsWithPendingCloses()
    this.emitSnapshot()

    if (hasPosition) {
      await this.audit.write('position_close_absence_confirmed', 'critical', {
        instrumentId: error.instId,
        clientOrderId: error.clOrdId,
        reason: result.reason
      })
      await this.notify(
        'warning',
        '未知平仓请求已确认不存在',
        `${error.instId} 经过安全等待窗口仍保有仓位；旧平仓请求不会重发`
      )
    } else {
      await this.audit.write('position_close_confirmed_by_reconciliation', 'critical', {
        instrumentId: error.instId,
        clientOrderId: error.clOrdId,
        reason: result.reason
      })
      await this.notify(
        'success',
        '未知平仓请求已确认完成',
        `${error.instId} 已通过只读持仓对账确认归零`
      )
    }
  }

  private async handleOkxMutationLifecycle(
    client: OkxV5Client,
    event: Readonly<OkxMutationLifecycleEvent>
  ): Promise<void> {
    return this.mutationJournalLifecycleMutex.runExclusive(
      () => this.handleOkxMutationLifecycleUnlocked(client, event)
    )
  }

  private async handleOkxMutationLifecycleUnlocked(
    client: OkxV5Client,
    event: Readonly<OkxMutationLifecycleEvent>
  ): Promise<void> {
    const accountFingerprint = this.okxAccountFingerprints.get(client)
    if (!accountFingerprint) {
      this.invalidateOkxOpeningCapability()
      throw new Error('OKX 账户缺少持久化订单恢复身份，已在发送前阻止 mutation')
    }
    try {
      if (event.phase === 'prepared') {
        if (this.finalizedDurableMutationIds.has(event.clOrdId)) {
          throw new Error('OKX 重用了本进程已终态的客户订单号')
        }
        this.durableMutations = await this.mutationJournal.begin({
          operation: event.operation,
          accountFingerprint,
          instId: event.instId,
          clOrdId: event.clOrdId,
          createdAt: event.createdAt,
          intentExpiresAt: event.intentExpiresAt
        })
        return
      }
      if (this.finalizedDurableMutationIds.has(event.clOrdId)) {
        if (
          this.finalizedDurableInstrumentIdsByClient.get(event.clOrdId) !== event.instId ||
          this.finalizedDurableOperationsByClient.get(event.clOrdId) !== event.operation
        ) {
          throw new Error('OKX late lifecycle 与已终态订单身份冲突')
        }
        if (
          event.phase === 'accepted' &&
          (
            !event.ordId ||
            this.finalizedDurableOrderIdsByClient.get(event.clOrdId) !== event.ordId
          )
        ) {
          throw new Error('OKX late ACK 与已终态订单的交易所订单号冲突')
        }
        return
      }
      const lifecycleRecord = this.durableMutations.find(
        (record) => record.clOrdId === event.clOrdId
      )
      if (
        lifecycleRecord &&
        (
          lifecycleRecord.operation !== event.operation ||
          lifecycleRecord.instId !== event.instId ||
          lifecycleRecord.createdAt !== event.createdAt ||
          lifecycleRecord.intentExpiresAt !== event.intentExpiresAt
        )
      ) {
        throw new Error('OKX mutation lifecycle 与持久化订单身份不一致')
      }
      if (event.phase === 'transmitting') {
        if (event.exchangeExpiresAt === undefined) {
          throw new Error('OKX mutation 缺少 exchange expTime 证据')
        }
        this.durableMutations = await this.mutationJournal.markTransmissionStarted({
          clOrdId: event.clOrdId,
          updatedAt: event.updatedAt,
          exchangeExpiresAt: event.exchangeExpiresAt
        })
        return
      }
      if (event.phase === 'accepted') {
        if (!event.ordId) throw new Error('OKX mutation ACK 缺少 ordId')
        this.durableMutations = await this.mutationJournal.markAccepted({
          clOrdId: event.clOrdId,
          ordId: event.ordId,
          updatedAt: event.updatedAt
        })
        if (await this.resolveObservedTerminalMutationUnlocked(event.clOrdId)) return
        await this.replayEarlyDurableOrderUpdatesUnlocked(event.clOrdId, event.ordId)
        return
      }
      if (event.phase === 'unknown') {
        this.durableMutations = await this.mutationJournal.markUnknown({
          clOrdId: event.clOrdId,
          updatedAt: event.updatedAt
        })
        await this.resolveObservedTerminalMutationUnlocked(event.clOrdId)
        return
      }
      if (!event.terminalEvidence) {
        throw new Error('OKX terminal mutation 事件缺少终态证据')
      }
      const terminalRecord = this.durableMutations.find(
        (record) => record.clOrdId === event.clOrdId
      )
      if (
        ['not_transmitted', 'rejected'].includes(event.terminalEvidence) &&
        terminalRecord &&
        (
          terminalRecord.ordId !== undefined ||
          terminalRecord.reconciliationState !== 'not_started'
        )
      ) {
        throw new Error('OKX mutation 拒绝结果与已观察到的订单证据冲突')
      }
      const resolution = await this.mutationJournal.resolve(
        event.clOrdId,
        event.terminalEvidence === 'not_transmitted'
          ? 'not_transmitted'
          : 'terminal_order'
      )
      this.durableMutations = resolution.records
      if (resolution.removed) {
        this.rememberFinalizedDurableMutation(
          event.clOrdId,
          terminalRecord?.ordId,
          false,
          terminalRecord?.instId ?? event.instId,
          terminalRecord?.operation ?? event.operation
        )
      }
    } catch (error) {
      this.invalidateOkxOpeningCapability()
      if (error instanceof MutationJournalConflictError) {
        this.emitSnapshotSafely()
        throw new Error(error.message)
      }
      this.failMutationJournal()
      throw new Error('本地订单恢复日志写入失败，已锁定全部实盘 mutation')
    }
  }

  private async persistDurableOrderEvidence(
    order: OkxOrderUpdate,
    source: 'runtime' | 'startup_recovery' = 'runtime'
  ): Promise<void> {
    return this.mutationJournalLifecycleMutex.runExclusive(
      () => this.persistDurableOrderEvidenceUnlocked(order, source)
    )
  }

  private async persistDurableOrderEvidenceUnlocked(
    order: OkxOrderUpdate,
    source: 'runtime' | 'startup_recovery' = 'runtime'
  ): Promise<void> {
    const clientOrderId = cleanOkxValue(order.clOrdId)
    const orderId = cleanOkxValue(order.ordId)
    if (clientOrderId && this.finalizedDurableMutationIds.has(clientOrderId)) {
      if (
        order.instType !== 'SWAP' ||
        this.finalizedDurableInstrumentIdsByClient.get(clientOrderId) !== order.instId
      ) {
        this.failMutationJournal()
        throw new Error('OKX late 订单证据与已终态合约身份冲突')
      }
      const finalizedOrderId = this.finalizedDurableOrderIdsByClient.get(clientOrderId)
      if (
        finalizedOrderId === undefined &&
        this.finalizedDurableMutationsPermittingOrderBinding.has(clientOrderId) &&
        orderId !== undefined
      ) {
        const finalizedClientOrderId = this.finalizedDurableClientIdsByOrder.get(orderId)
        if (
          finalizedClientOrderId !== undefined &&
          finalizedClientOrderId !== clientOrderId
        ) {
          this.failMutationJournal()
          throw new Error('OKX late 订单证据与已终态客户订单号冲突')
        }
        this.rememberFinalizedDurableMutation(clientOrderId, orderId, true)
        return
      }
      if (finalizedOrderId === undefined || finalizedOrderId !== orderId) {
        this.failMutationJournal()
        throw new Error('OKX late 订单证据与已终态交易所订单号冲突')
      }
      return
    }
    if (orderId && this.finalizedDurableMutationIds.has(`order:${orderId}`)) {
      const finalizedClientOrderId = this.finalizedDurableClientIdsByOrder.get(orderId)
      if (
        clientOrderId !== undefined &&
        finalizedClientOrderId !== undefined &&
        finalizedClientOrderId !== clientOrderId
      ) {
        this.failMutationJournal()
        throw new Error('OKX late 订单证据与已终态客户订单号冲突')
      }
      if (
        order.instType !== 'SWAP' ||
        finalizedClientOrderId === undefined ||
        this.finalizedDurableInstrumentIdsByClient.get(finalizedClientOrderId) !== order.instId
      ) {
        this.failMutationJournal()
        throw new Error('OKX late 订单证据与已终态合约身份冲突')
      }
      return
    }
    const record = this.durableMutations.find(
      (candidate) =>
        (clientOrderId && candidate.clOrdId === clientOrderId) ||
        (orderId && candidate.ordId === orderId)
    )
    if (!record) {
      if (clientOrderId || orderId) this.bufferEarlyDurableOrderUpdate(order)
      return
    }
    if (order.instType !== 'SWAP' || order.instId !== record.instId) {
      this.failMutationJournal()
      throw new Error('OKX 订单证据与持久化合约不一致')
    }
    if (clientOrderId && clientOrderId !== record.clOrdId) {
      this.failMutationJournal()
      throw new Error('OKX 订单证据与持久化客户订单号不一致')
    }
    if (!orderId || (record.ordId !== undefined && orderId !== record.ordId)) {
      this.failMutationJournal()
      throw new Error('OKX 订单证据与持久化交易所订单号不一致')
    }
    const state = normalizeOkxOrderState(order.state)
    if (!state) {
      this.failMutationJournal()
      throw new Error('OKX 订单证据缺少可验证状态')
    }
    try {
      if (TERMINAL_OKX_ORDER_STATES.has(state)) {
        if (record.lifecycleState === 'prepared') {
          throw new Error('OKX 订单证据在 transmission commit 前出现')
        }
        if (
          record.ordId === undefined &&
          record.lifecycleState === 'transmitting' &&
          !(
            source === 'startup_recovery' &&
            this.startupDurableMutationIds.has(record.clOrdId)
          )
        ) {
          this.durableMutations = await this.mutationJournal.markOrderObserved({
            clOrdId: record.clOrdId,
            ordId: orderId,
            orderState: state,
            pending: false,
            updatedAt: this.now()
          })
          return
        }
        const resolution = await this.mutationJournal.resolve(
          record.clOrdId,
          'terminal_order'
        )
        this.durableMutations = resolution.records
        if (resolution.removed) {
          this.rememberFinalizedDurableMutation(
            record.clOrdId,
            orderId,
            false,
            record.instId,
            record.operation
          )
        }
        return
      }
      this.durableMutations = await this.mutationJournal.markOrderObserved({
        clOrdId: record.clOrdId,
        ordId: orderId,
        orderState: state,
        pending: state === 'live' || state === 'partially_filled',
        updatedAt: this.now()
      })
    } catch (error) {
      if (error instanceof MutationJournalConflictError) {
        if (this.finalizedDurableMutationIds.has(record.clOrdId)) return
      }
      this.failMutationJournal()
      throw new Error('OKX 订单证据无法原子写入恢复日志')
    }
  }

  private async resolveDurableMutation(
    clientOrderId: string,
    evidence: DurableMutationResolutionEvidence
  ): Promise<void> {
    return this.mutationJournalLifecycleMutex.runExclusive(
      () => this.resolveDurableMutationUnlocked(clientOrderId, evidence)
    )
  }

  private async resolveDurableMutationUnlocked(
    clientOrderId: string,
    evidence: DurableMutationResolutionEvidence
  ): Promise<void> {
    const record = this.durableMutations.find(
      (candidate) => candidate.clOrdId === clientOrderId
    )
    if (!record) return
    try {
      const resolution = await this.mutationJournal.resolve(clientOrderId, evidence)
      this.durableMutations = resolution.records
      if (resolution.removed) {
        this.rememberFinalizedDurableMutation(
          clientOrderId,
          record.ordId,
          record.ordId === undefined && evidence === 'same_origin_position_effect',
          record.instId,
          record.operation
        )
      }
    } catch {
      this.failMutationJournal()
      throw new Error('订单终态证据无法原子提交，互锁保持生效')
    }
  }

  private async recoverDurableMutations(
    client: OkxV5Client,
    verification: OkxAccountVerification,
    accountFingerprint: string
  ): Promise<void> {
    if (this.durableMutations.length === 0) return
    if (
      this.durableMutations.some(
        (record) => record.accountFingerprint !== accountFingerprint
      )
    ) {
      throw new Error('当前 OKX 子账户与持久化未决订单不匹配，恢复日志保持锁定')
    }

    for (const record of [...this.durableMutations]) {
      const pendingMatch = verification.pendingSwapOrders.find(
        (order) => order.instId === record.instId && order.clOrdId === record.clOrdId
      )
      const order = pendingMatch ?? await this.queryRecoveredMutationOrder(client, record)
      const positions = await client.getPositions(record.instId)
      const positionEffectObserved = record.operation === 'open'
        ? hasOpenOkxPosition(positions, record.instId)
        : !hasOpenOkxPosition(positions, record.instId)

      if (order) {
        if (
          order.instId !== record.instId ||
          order.clOrdId !== record.clOrdId ||
          (record.ordId !== undefined && order.ordId !== record.ordId)
        ) {
          throw new Error('OKX 返回的恢复订单身份与 journal 不一致')
        }
        await this.persistDurableOrderEvidence(order, 'startup_recovery')
      } else {
        await this.markDurableRecoveryNotFound(record.clOrdId, positionEffectObserved)
      }

      await this.audit.write('durable_mutation_read_only_recovery', 'warning', {
        operation: record.operation,
        instrumentId: record.instId,
        clientOrderId: record.clOrdId,
        matchedOrder: Boolean(order),
        orderState: order?.state,
        positionEffectObserved,
        remainsLocked: this.durableMutations.some(
          (candidate) => candidate.clOrdId === record.clOrdId
        )
      }).catch(() => undefined)
    }

    if (this.durableMutations.length > 0) {
      throw new Error(
        `仍有 ${this.durableMutations.length} 笔持久化订单未取得终态；新 client 的未找到结果不会自动解除互锁`
      )
    }
  }

  private async queryRecoveredMutationOrder(
    client: OkxV5Client,
    record: DurableMutationRecord
  ): Promise<OkxOrder | undefined> {
    try {
      return await client.getOrder({
        instId: record.instId,
        clOrdId: record.clOrdId
      })
    } catch (error) {
      if (error instanceof OkxApiError && ['51603', '51400'].includes(error.code)) {
        return undefined
      }
      throw error
    }
  }

  private rememberFinalizedDurableMutation(
    clientOrderId: string,
    orderId?: string,
    permitsLateOrderBinding = false,
    instrumentId?: string,
    operation?: DurableMutationRecord['operation']
  ): void {
    if (instrumentId !== undefined) {
      this.finalizedDurableInstrumentIdsByClient.set(clientOrderId, instrumentId)
    }
    if (operation !== undefined) {
      this.finalizedDurableOperationsByClient.set(clientOrderId, operation)
    }
    if (!this.finalizedDurableOrderIdsByClient.has(clientOrderId)) {
      this.finalizedDurableOrderIdsByClient.set(clientOrderId, orderId)
    } else if (
      orderId !== undefined &&
      this.finalizedDurableOrderIdsByClient.get(clientOrderId) === undefined
    ) {
      this.finalizedDurableOrderIdsByClient.set(clientOrderId, orderId)
    }
    if (orderId !== undefined) {
      this.finalizedDurableClientIdsByOrder.set(orderId, clientOrderId)
      this.finalizedDurableMutationsPermittingOrderBinding.delete(clientOrderId)
    } else if (permitsLateOrderBinding) {
      this.finalizedDurableMutationsPermittingOrderBinding.add(clientOrderId)
    }
    for (const key of [clientOrderId, orderId ? `order:${orderId}` : undefined]) {
      if (!key || this.finalizedDurableMutationIds.has(key)) continue
      this.finalizedDurableMutationIds.add(key)
      this.finalizedDurableMutationIdOrder.push(key)
    }
    while (this.finalizedDurableMutationIdOrder.length > FINALIZED_CLOSE_ORDER_KEY_LIMIT) {
      const oldest = this.finalizedDurableMutationIdOrder.shift()
      if (oldest) {
        this.finalizedDurableMutationIds.delete(oldest)
        if (oldest.startsWith('order:')) {
          this.finalizedDurableClientIdsByOrder.delete(oldest.slice('order:'.length))
        } else {
          this.finalizedDurableOrderIdsByClient.delete(oldest)
          this.finalizedDurableMutationsPermittingOrderBinding.delete(oldest)
          this.finalizedDurableInstrumentIdsByClient.delete(oldest)
          this.finalizedDurableOperationsByClient.delete(oldest)
        }
      }
    }
  }

  private async markDurableRecoveryNotFound(
    clientOrderId: string,
    positionEffectObserved: boolean
  ): Promise<void> {
    return this.mutationJournalLifecycleMutex.runExclusive(async () => {
      if (!this.durableMutations.some((record) => record.clOrdId === clientOrderId)) return
      try {
        this.durableMutations = await this.mutationJournal.markRecoveryNotFound({
          clOrdId: clientOrderId,
          updatedAt: this.now(),
          positionEffectObserved
        })
      } catch {
        this.failMutationJournal()
        throw new Error('启动订单恢复证据无法写入 journal')
      }
    })
  }

  private async resolveObservedTerminalMutationUnlocked(clientOrderId: string): Promise<boolean> {
    const record = this.durableMutations.find(
      (candidate) => candidate.clOrdId === clientOrderId
    )
    if (!record?.lastOrderState || !TERMINAL_OKX_ORDER_STATES.has(record.lastOrderState)) {
      return false
    }
    const resolution = await this.mutationJournal.resolve(clientOrderId, 'terminal_order')
    this.durableMutations = resolution.records
    if (resolution.removed) {
      this.rememberFinalizedDurableMutation(
        clientOrderId,
        record.ordId,
        false,
        record.instId,
        record.operation
      )
    }
    return resolution.removed
  }

  private bufferEarlyDurableOrderUpdate(order: OkxOrderUpdate): void {
    this.earlyDurableOrderUpdates.push(structuredClone(order))
    while (this.earlyDurableOrderUpdates.length > EARLY_CLOSE_ORDER_UPDATE_LIMIT) {
      this.earlyDurableOrderUpdates.shift()
    }
  }

  private async replayEarlyDurableOrderUpdatesUnlocked(
    clientOrderId: string,
    orderId: string
  ): Promise<void> {
    const matches: OkxOrderUpdate[] = []
    for (let index = this.earlyDurableOrderUpdates.length - 1; index >= 0; index -= 1) {
      const update = this.earlyDurableOrderUpdates[index]!
      if (cleanOkxValue(update.clOrdId) === clientOrderId || cleanOkxValue(update.ordId) === orderId) {
        matches.unshift(update)
        this.earlyDurableOrderUpdates.splice(index, 1)
      }
    }
    for (const update of matches) await this.persistDurableOrderEvidenceUnlocked(update)
  }

  private failMutationJournal(): void {
    this.mutationJournalFailure ??= '本地订单恢复日志不可用，已禁止任何实盘 mutation'
    this.lastError = this.mutationJournalFailure
    this.invalidateOkxOpeningCapability()
    this.emitSnapshotSafely()
    void this.audit.write('mutation_journal_failed_closed', 'critical', {
      unresolvedMutationCount: this.durableMutations.length
    }).catch(() => undefined)
  }

  private emitSnapshotSafely(): void {
    if (!this.initialized) return
    try {
      this.emitSnapshot()
    } catch {
      // The main-process interlock above is authoritative even if a listener fails.
    }
  }

  private reserveOkxLifecycleChange(): void {
    this.okxLifecycleRevision += 1
    this.invalidateOkxOpeningCapability()
  }

  private currentSignalTradeAuthorization(): SignalTradeAuthorizationToken | undefined {
    const telegramMonitor = this.telegram
    const telegramReadiness = telegramMonitor?.liveTradingReadiness
    if (
      !this.monitoring ||
      !this.liveArmed ||
      !this.liveArmCapability ||
      this.aiQuotaExhausted ||
      !telegramMonitor ||
      !telegramReadiness?.ready
    ) {
      return undefined
    }
    return Object.freeze({
      capability: this.liveArmCapability,
      armRevision: this.liveArmRevision,
      monitoringRevision: this.monitoringRevision,
      telegramLifecycleRevision: this.telegramLifecycleRevision,
      telegramRecoveryRevision: telegramReadiness.revision,
      telegramMonitor
    })
  }

  private assertSignalTradeAuthorization(
    expected: SignalTradeAuthorizationToken,
    client: OkxV5Client
  ): void {
    if (
      !sameSignalTradeAuthorization(this.currentSignalTradeAuthorization(), expected) ||
      this.emergencyStopped ||
      this.okx !== client ||
      this.connections.okx.phase !== 'connected' ||
      !client.isLiveTradingArmed ||
      this.hasPositionCloseInterlock()
    ) {
      throw new Error('消息到达后的实盘授权、Telegram 连接或 OKX 安全状态已变化')
    }
  }

  private invalidateOkxOpeningCapability(): void {
    this.liveArmRevision += 1
    this.liveArmCapability = undefined
    this.telegramReconnectRetainedArm = false
    this.liveArmed = false
    this.armedAt = undefined
    if (this.okx && this.okx !== this.closeScopedArmedClient) {
      this.okx.setLiveTradingArmed(false)
    }
  }

  private rememberOkxExposureFacts(facts: readonly string[]): void {
    if (facts.length === 0) return
    this.okxCredentialExposureStatus = 'exposure_seen'
    for (const fact of facts) this.okxCredentialExposureFacts.add(fact)
  }

  private captureCurrentOkxExposureFacts(): void {
    const facts: string[] = []
    if (this.positions.length > 0) facts.push(`旧账户曾检测到 ${this.positions.length} 个 SWAP 持仓`)
    if (this.coordinator.hasPendingOrder) facts.push('旧账户有开仓订单等待最终状态或只读对账')
    if (this.activePositionClose) facts.push('旧账户有平仓操作正在提交')
    if (this.pendingPositionCloses.size > 0) {
      facts.push(`旧账户有 ${this.pendingPositionCloses.size} 个平仓订单等待最终状态或只读对账`)
    }
    if (this.okx?.requiresOrderReconciliation) facts.push('旧账户有结果未知订单等待只读对账')
    if (this.durableMutations.length > 0) {
      facts.push(`旧账户有 ${this.durableMutations.length} 笔持久化订单等待只读对账`)
    }
    if (this.mutationJournalFailure) facts.push('本地订单恢复日志无法验证')
    this.rememberOkxExposureFacts(facts)
  }

  private rememberOkxVerificationExposure(verification: OkxAccountVerification): void {
    const facts: string[] = []
    if (verification.pendingSwapOrders.length > 0) {
      facts.push(`旧账户曾检测到 ${verification.pendingSwapOrders.length} 个普通 SWAP 未完成订单`)
    }
    const pendingAlgoOrders = verification.pendingSwapAlgoOrders ?? []
    if (pendingAlgoOrders.length > 0) {
      facts.push(`旧账户曾检测到 ${pendingAlgoOrders.length} 个 SWAP 策略未完成订单`)
    }
    this.rememberOkxExposureFacts(facts)
  }

  private updateOkxExposureStatusAfterConnectedVerification(
    client: OkxV5Client,
    verification: OkxAccountVerification
  ): void {
    const facts = this.okxCredentialChangeBlockers()
    if (this.positions.length > 0) facts.push(`旧账户仍有 ${this.positions.length} 个 SWAP 持仓`)
    if (verification.pendingSwapOrders.length > 0) {
      facts.push(`旧账户仍有 ${verification.pendingSwapOrders.length} 个普通 SWAP 未完成订单`)
    }
    const pendingAlgoOrders = verification.pendingSwapAlgoOrders ?? []
    if (pendingAlgoOrders.length > 0) {
      facts.push(`旧账户仍有 ${pendingAlgoOrders.length} 个 SWAP 策略未完成订单`)
    }
    if (this.okx !== client || !this.okxStream) facts.push('旧账户连接在核验期间发生变化')
    if (facts.length > 0) {
      this.rememberOkxExposureFacts(facts)
      return
    }
    this.okxCredentialExposureStatus = 'verified_clear'
    this.okxCredentialExposureFacts.clear()
  }

  private async verifyOldOkxAccountIsClearForCredentialChange(
    client: OkxV5Client
  ): Promise<void> {
    const assertStableAndUnblocked = (): void => {
      if (
        this.okx !== client ||
        !this.okxStream ||
        this.connections.okx.phase !== 'connected'
      ) {
        throw new Error('旧账户连接在凭据更换核验期间发生变化，请重新连接旧账户后再试')
      }
      const blockers = this.okxCredentialChangeBlockers()
      if (blockers.length > 0) {
        this.rememberOkxExposureFacts(blockers)
        throw new Error(blockers.join('；'))
      }
    }

    assertStableAndUnblocked()
    let positions: OkxPosition[]
    let pendingOrders: OkxOrder[]
    let pendingAlgoOrders: Awaited<ReturnType<OkxV5Client['getPendingAlgoOrders']>>
    try {
      [positions, pendingOrders, pendingAlgoOrders] = await Promise.all([
        client.getPositions(),
        client.getPendingOrders(),
        client.getPendingAlgoOrders()
      ])
    } catch (error) {
      if (this.okxCredentialExposureStatus !== 'exposure_seen') {
        this.okxCredentialExposureStatus = 'unverified'
      }
      throw new Error(`旧账户实时只读暴露核验失败，凭据未更换：${errorText(error)}`)
    }

    assertStableAndUnblocked()
    const facts: string[] = []
    const invalidPositionCount = positions.filter(
      (position) =>
        position.instType !== 'SWAP' ||
        typeof position.pos !== 'string' ||
        position.pos.trim().length === 0 ||
        !Number.isFinite(Number(position.pos))
    ).length
    if (invalidPositionCount > 0) {
      facts.push(`旧账户返回 ${invalidPositionCount} 条无法明确判定为零仓位的持仓记录`)
    }
    const openPositionCount = positions.filter(
      (position) => position.instType === 'SWAP' && isOpenOkxPosition(position)
    ).length
    if (openPositionCount > 0) facts.push(`旧账户仍有 ${openPositionCount} 个 SWAP 持仓`)
    if (pendingOrders.length > 0) {
      facts.push(`旧账户仍有 ${pendingOrders.length} 个普通 SWAP 未完成订单`)
    }
    if (pendingAlgoOrders.length > 0) {
      facts.push(`旧账户仍有 ${pendingAlgoOrders.length} 个 SWAP 策略未完成订单`)
    }
    if (facts.length > 0) {
      this.rememberOkxExposureFacts(facts)
      throw new Error(facts.join('；'))
    }

    // Synchronize the renderer/local coordinator with the exact fresh empty
    // position response before the final state check. A queued manual close
    // sets its active interlock synchronously and is therefore caught below.
    await this.applyPositionSnapshot(positions)
    assertStableAndUnblocked()
    this.okxCredentialExposureStatus = 'verified_clear'
    this.okxCredentialExposureFacts.clear()
  }

  private assertOldOkxAccountStillClearForCredentialChange(client: OkxV5Client): void {
    if (
      this.okx !== client ||
      !this.okxStream ||
      this.connections.okx.phase !== 'connected'
    ) {
      throw new Error('旧账户连接在凭据更换最终检查前发生变化，凭据未更换')
    }
    const blockers = this.okxCredentialChangeBlockers()
    if (this.positions.length > 0) blockers.push(`旧账户仍有 ${this.positions.length} 个 SWAP 持仓`)
    if (this.okxCredentialExposureStatus !== 'verified_clear') {
      blockers.push('旧账户暴露状态在最终检查前发生变化')
    }
    if (blockers.length > 0) {
      this.rememberOkxExposureFacts(blockers)
      throw new Error(blockers.join('；'))
    }
  }

  private armBlockers(): string[] {
    const blockers = this.connectionBlockers()
    blockers.push(...this.mutationJournalBlockers())
    if (this.aiQuotaExhausted) blockers.push('ChatGPT 额度已用尽，当前无法分析或下单')
    if (this.telegram && !this.telegram.liveTradingReadiness.ready) {
      blockers.push('Telegram 正在校验断线补拉')
    }
    if (!this.monitoring) blockers.push('监听尚未开启')
    if (this.emergencyStopped) blockers.push('当前处于紧急停止状态，请先重新开启监听')
    if (this.coordinator.hasPendingOrder) blockers.push('开仓订单仍在等待最终状态或只读对账')
    if (this.activePositionClose) blockers.push('平仓操作正在提交，请等待其完成')
    if (this.pendingPositionCloses.size > 0) blockers.push('平仓订单仍在处理中，请等待最终状态')
    if (this.okx?.requiresOrderReconciliation) blockers.push('OKX 存在结果未知订单，必须先完成只读对账')
    if (!this.secretStore.available) blockers.push('系统安全存储不可用')
    if (process.platform === 'linux' && this.secretStore.backend === 'basic_text') {
      blockers.push('Linux 安全存储回退到 basic_text，禁止实盘')
    }
    return [...new Set(blockers)]
  }

  private okxCredentialChangeBlockers(): string[] {
    const blockers: string[] = [...this.mutationJournalBlockers()]
    if (this.coordinator.hasPendingOrder) blockers.push('开仓订单仍在等待最终状态或只读对账')
    if (this.activePositionClose) blockers.push('平仓操作正在提交，请等待其完成')
    if (this.pendingPositionCloses.size > 0) blockers.push('平仓订单仍在等待最终状态或只读对账')
    if (this.okx?.requiresOrderReconciliation) blockers.push('OKX 存在结果未知订单，必须先完成只读对账')
    return blockers
  }

  private mutationJournalBlockers(): string[] {
    const blockers: string[] = []
    if (this.mutationJournalFailure) blockers.push(this.mutationJournalFailure)
    if (this.durableMutations.length > 0) {
      blockers.push(`有 ${this.durableMutations.length} 笔重启前订单 mutation 等待只读对账`)
    }
    return blockers
  }

  private hasPositionCloseInterlock(): boolean {
    return Boolean(this.activePositionClose) || this.pendingPositionCloses.size > 0
  }

  private connectionBlockers(): string[] {
    const labels: Array<[keyof AppSnapshot['connections'], string]> = [
      ['telegram', 'Telegram 未连接'],
      ['chatgpt', 'ChatGPT 未连接或未预热'],
      ['okx', 'OKX 未连接']
    ]
    return labels
      .filter(([key]) => this.connections[key].phase !== 'connected')
      .map(([, label]) => label)
  }

  private requireOkx(): OkxV5Client {
    if (!this.okx || this.connections.okx.phase !== 'connected') throw new Error('OKX 尚未连接')
    return this.okx
  }

  private captureOkxRoutes(client: OkxV5Client): void {
    const selectedAt = this.now()
    this.okxRoutes = {
      rest: routeStatus(
        client.restRouteSelection,
        this.okxRoutes.rest,
        this.settings.proxy,
        selectedAt
      ),
      privateWs: routeStatus(
        client.privateWebSocketRouteSelection,
        this.okxRoutes.privateWs,
        this.settings.proxy,
        selectedAt
      )
    }
    this.emitSnapshot()
  }

  private async auditOkxRoute(
    scope: 'rest' | 'private_ws',
    route: OkxRouteStatus
  ): Promise<void> {
    if (route.kind === 'unselected') return
    await this.audit.write('okx_route_selected', 'info', {
      scope,
      kind: route.kind,
      protocol: route.protocol,
      endpoint: route.endpoint,
      selectedAt: route.selectedAt
    })
  }

  private async readJsonSecret<T>(key: string): Promise<T | undefined> {
    const value = await this.secretStore.get(key)
    if (!value) return undefined
    try {
      return JSON.parse(value) as T
    } catch {
      throw new Error('加密凭据格式损坏，请重新保存')
    }
  }

  private setConnection(
    key: keyof AppSnapshot['connections'],
    phase: ConnectionPhase,
    detail?: string
  ): void {
    const label: Record<ConnectionPhase, string> = {
      not_configured: '未配置',
      disconnected: '未连接',
      connecting: '连接中',
      connected: '已连接',
      error: '异常'
    }
    this.connections = {
      ...this.connections,
      [key]: connection(phase, label[phase], this.now(), detail)
    }
    this.emitSnapshot()
  }

  private async notify(
    level: NotificationItem['level'],
    title: string,
    detail: string
  ): Promise<void> {
    const item: NotificationItem = {
      id: randomUUID(),
      level,
      title,
      detail,
      createdAt: this.now()
    }
    this.notifications = [item, ...this.notifications].slice(0, MAX_NOTIFICATION_HISTORY)
    if (this.settings.notificationsEnabled) {
      try {
        this.options.showDesktopNotification?.(title, detail)
      } catch {
        // Desktop notification failures do not affect the trading state.
      }
    }
    this.emit('event', { type: 'notification', payload: item })
    this.emitSnapshot()
  }

  private emitSnapshot(): void {
    if (!this.initialized || this.closing) return
    this.emit('event', { type: 'snapshot', payload: this.getSnapshot() })
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('应用尚未初始化')
  }
}

function cleanOkxValue(value: string | undefined): string | undefined {
  const cleaned = value?.trim()
  return cleaned || undefined
}

function normalizeOkxOrderState(value: string | undefined): string | undefined {
  const state = cleanOkxValue(value)?.toLowerCase()
  const normalized = state === 'cancelled' ? 'canceled' : state
  return normalized && OBSERVABLE_OKX_ORDER_STATES.has(normalized)
    ? normalized
    : undefined
}

function positiveNumber(value: string | undefined): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function closeOrderUpdateFingerprint(order: OkxOrderUpdate): string {
  return [
    cleanOkxValue(order.clOrdId),
    cleanOkxValue(order.ordId),
    normalizeOkxOrderState(order.state),
    cleanOkxValue(order.tradeId),
    cleanOkxValue(order.fillSz),
    cleanOkxValue(order.accFillSz),
    cleanOkxValue(order.avgPx ?? order.fillPx),
    cleanOkxValue(order.uTime)
  ].join('|')
}

function findTrackedOkxOrder(
  orders: readonly OkxOrder[],
  tracked: { orderId?: string; clientOrderId?: string }
): OkxOrder | undefined {
  return orders.find(
    (order) =>
      (tracked.orderId && order.ordId === tracked.orderId) ||
      (tracked.clientOrderId && order.clOrdId === tracked.clientOrderId)
  )
}

function hasOpenOkxPosition(positions: readonly OkxPosition[], instrumentId: string): boolean {
  return positions.some(
    (position) =>
      position.instId === instrumentId &&
      isOpenOkxPosition(position)
  )
}

function isOpenOkxPosition(position: OkxPosition): boolean {
  return Number.isFinite(Number(position.pos)) && Number(position.pos) !== 0
}

function sameOkxCredentials(
  left: OkxCredentialsInput,
  right: OkxCredentialsInput
): boolean {
  return left.apiKey === right.apiKey &&
    left.secretKey === right.secretKey &&
    left.passphrase === right.passphrase
}

function toSignalOrderUpdate(order: OkxOrderUpdate): {
  clientOrderId?: string
  orderId?: string
  state?: string
  instrumentId?: string
  fillSize?: string
  accumulatedFillSize?: string
  averageFillPrice?: string
} {
  return {
    clientOrderId: order.clOrdId,
    orderId: order.ordId,
    state: order.state,
    instrumentId: order.instId,
    fillSize: order.fillSz,
    accumulatedFillSize: order.accFillSz,
    averageFillPrice: order.avgPx ?? order.fillPx
  }
}

function connection(
  phase: ConnectionPhase,
  label: string,
  lastChangedAt: number,
  detail?: string
): ConnectionStatus {
  return { phase, label, detail, lastChangedAt }
}

function emptyOkxRoutes(): OkxRoutes {
  return {
    rest: { kind: 'unselected', detail: '尚未为本次连接选择 REST 路由' },
    privateWs: { kind: 'unselected', detail: '尚未为本次连接选择私有 WebSocket 路由' }
  }
}

function routeStatus(
  selected: OkxRouteSelection | undefined,
  previous: OkxRouteStatus,
  proxy: PublicSettings['proxy'],
  selectedAt: number
): OkxRouteStatus {
  if (!selected) return previous.kind === 'unselected' ? previous : { kind: 'unselected' }
  if (selected.route === 'direct') {
    return {
      kind: 'direct',
      selectedAt: previous.kind === selected.route ? previous.selectedAt : selectedAt,
      detail: '应用未注入代理；系统 VPN 或 TUN 仍可能接管实际出口'
    }
  }
  return {
    kind: 'proxy',
    protocol: selected.proxyProtocol,
    endpoint: safeProxyEndpoint(proxy),
    selectedAt: previous.kind === selected.route ? previous.selectedAt : selectedAt,
    detail: '已为本次 OKX 连接固定使用应用内 Clash 路由'
  }
}

function okxRoutesSummary(routes: OkxRoutes): string {
  return `REST：${okxRouteLabel(routes.rest)}；私有 WebSocket：${okxRouteLabel(routes.privateWs)}`
}

function okxRouteLabel(route: OkxRouteStatus): string {
  if (route.kind === 'direct') return '应用直连'
  if (route.kind === 'proxy') {
    const protocol = route.protocol === 'socks5' ? 'SOCKS5' : 'HTTP'
    return `Clash ${protocol}${route.endpoint ? ` ${route.endpoint}` : ''}`
  }
  return '未选择'
}

function safeProxyEndpoint(proxy: PublicSettings['proxy']): string {
  const host = proxy.host.trim()
  const safeHost = host && !host.includes('@') && /^[A-Za-z0-9.:[\]-]+$/.test(host)
    ? host
    : '[configured-host]'
  return `${safeHost}:${proxy.port}`
}

function proxyUrlForChild(proxy: PublicSettings['proxy']): string {
  const protocol = proxy.protocol === 'socks5' ? 'socks5' : 'http'
  return `${protocol}://${proxy.host}:${proxy.port}`
}

function maskPhone(phone: string): string {
  const normalized = phone.trim()
  if (normalized.length <= 6) return '***'
  return `${normalized.slice(0, 3)}****${normalized.slice(-3)}`
}

function rateLimitUsedPercent(value: ChatGptRateLimits | null): number | undefined {
  if (!value) return undefined
  const queue: unknown[] = [value]
  const visited = new Set<unknown>()
  let maximumUsedPercent: number | undefined
  while (queue.length) {
    const current = queue.shift()
    if (!current || typeof current !== 'object' || visited.has(current)) continue
    visited.add(current)
    for (const [key, child] of Object.entries(current)) {
      if (/^(usedPercent|percentUsed)$/i.test(key) && typeof child === 'number' && Number.isFinite(child)) {
        const usedPercent = Math.max(0, Math.min(100, child))
        maximumUsedPercent = Math.max(maximumUsedPercent ?? 0, usedPercent)
      }
      if (/^(remainingPercent|percentRemaining)$/i.test(key) && typeof child === 'number' && Number.isFinite(child)) {
        const usedPercent = Math.max(0, Math.min(100, 100 - child))
        maximumUsedPercent = Math.max(maximumUsedPercent ?? 0, usedPercent)
      }
      if (child && typeof child === 'object') queue.push(child)
    }
  }
  return maximumUsedPercent
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function okxConnectionErrorDetail(
  error: unknown,
  credentials: OkxCredentialsInput
): string {
  if (error instanceof OkxTransportError) {
    const stageLabels: Record<OkxTransportError['stage'], string> = {
      public_time: '公共时间接口',
      account_config: '账户配置接口',
      pending_orders: '未完成订单接口',
      pending_algo_orders: '未完成策略订单接口',
      instruments: '合约列表接口',
      positions: '持仓接口',
      ticker: '行情接口',
      leverage_info: '杠杆信息接口',
      set_leverage: '设置杠杆接口',
      place_order: '下单接口',
      close_position: '平仓接口',
      order_details: '订单详情接口',
      private_ws_connect: '私有 WebSocket 连接',
      private_ws_auth: '私有 WebSocket 登录',
      private_ws_subscribe: '私有 WebSocket 订阅',
      private_ws_heartbeat: '私有 WebSocket 心跳',
      unknown: '网络接口'
    }
    const categoryLabels: Record<OkxTransportError['category'], string> = {
      dns: 'DNS 解析失败',
      tls: 'TLS 握手失败',
      timeout: '连接超时',
      connection: 'TCP 或代理连接失败',
      unknown: '网络连接失败'
    }
    const route = error.route === 'proxy'
      ? `Clash ${error.proxyProtocol === 'socks5' ? 'SOCKS5' : 'HTTP'}`
      : error.route === 'direct'
        ? '应用直连'
        : '当前路由'
    return `OKX ${stageLabels[error.stage]}通过 ${route} 连接失败：${categoryLabels[error.category]}`
  }
  return redactOkxConnectionError(errorText(error), credentials)
}

function okxTransportAuditFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof OkxTransportError)) return {}
  return {
    transportStage: error.stage,
    transportCategory: error.category,
    attemptedRoute: error.route,
    proxyProtocol: error.proxyProtocol
  }
}

function redactOkxConnectionError(
  value: string,
  credentials: OkxCredentialsInput
): string {
  let redacted = value
  for (const secret of [credentials.apiKey, credentials.secretKey, credentials.passphrase]) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]')
  }
  return redacted.slice(0, 800)
}
