import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import net, { type Socket } from 'node:net'

import { TelegramClient } from 'teleproto'
import { NewMessage, Raw, type NewMessageEvent } from 'teleproto/events/index.js'
import { UpdateConnectionState } from 'teleproto/network/index.js'
import { ConnectionTCPFull } from 'teleproto/network/connection/index.js'
import { StringSession } from 'teleproto/sessions/index.js'
import type { Api } from 'teleproto'
import type { SocketInterface } from 'teleproto/extensions/index.js'
import type { TelegramClientParams } from 'teleproto/client/telegramBaseClient.js'
import type { SignalTradeAuthorizationToken } from './signal-coordinator'

import {
  BoundedMessageDeduplicator,
  extractTelegramSignalMessage,
  normalizeTelegramUsername,
  telegramMessageKey,
  type TelegramSignalMessage,
} from './telegram-message'

export type TelegramMonitorState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'reconnecting'
  | 'stopping'
  | 'stopped'
  | 'error'

export type TelegramProxyProtocol = 'auto' | 'socks5' | 'http'
export type TelegramAuthField = 'phoneNumber' | 'phoneCode' | 'password'

export interface TelegramProxyConfig {
  protocol?: TelegramProxyProtocol
  host?: string
  port?: number
  username?: string
  password?: string
  timeoutSeconds?: number
}

/** Implement this with Electron safeStorage/keytar or another OS-backed secret store. */
export interface TelegramSecretStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete?(key: string): Promise<void>
}

export interface TelegramAuthCallbacks {
  phoneNumber?: string | (() => Promise<string>)
  phoneCode?: (isCodeViaApp?: boolean) => Promise<string>
  password?: (hint?: string) => Promise<string>
  /** Return true to abort teleproto's authentication retry loop. */
  onError?: (error: Error) => boolean | void | Promise<boolean | void>
}

export interface TelegramStatusEvent {
  state: TelegramMonitorState
  at: string
  detail?: string
  proxyProtocol?: Exclude<TelegramProxyProtocol, 'auto'>
}

export interface TelegramAuthRequest {
  field: TelegramAuthField
  at: string
  hint?: string
  isCodeViaApp?: boolean
}

export interface TelegramMonitorError {
  at: string
  message: string
  code?: string
  recoverable: boolean
  cause: Error
}

export interface TelegramIgnoredMessage {
  at: string
  messageId?: number
  reason: 'historical' | 'duplicate' | 'empty-or-invalid'
}

export interface TelegramMonitorCallbacks {
  /**
   * Display-only notification for a raw live update held behind startup or
   * recovery verification. It never carries a trading authorization token.
   */
  onMessageObserved?: (message: TelegramSignalMessage) => void | Promise<void>
  onMessage?: (
    message: TelegramSignalMessage,
    context: TelegramMessageDispatchContext,
  ) => void | Promise<void>
  onStatus?: (status: TelegramStatusEvent) => void | Promise<void>
  onAuthRequired?: (request: TelegramAuthRequest) => void | Promise<void>
  onError?: (error: TelegramMonitorError) => void | Promise<void>
  onIgnoredMessage?: (event: TelegramIgnoredMessage) => void | Promise<void>
}

export interface TelegramMonitorOptions {
  apiId: number
  apiHash: string
  secretStore: TelegramSecretStore
  auth?: TelegramAuthCallbacks
  callbacks?: TelegramMonitorCallbacks
  /**
   * Captures the controller's process-local live-trading capability in the
   * synchronous NewMessage event turn, before any Telegram FIFO or callback
   * scheduling delay. Throwing or returning undefined fails closed.
   */
  captureAuthorization?: () => SignalTradeAuthorizationToken | undefined
  channel?: string
  proxy?: TelegramProxyConfig | false
  sessionSecretKey?: string
  connectionRetries?: number
  reconnectRetries?: number
  reconnectDelayMs?: number
  healthCheckIntervalMs?: number
  catchUpLimit?: number
  deduplicationCapacity?: number
  stopDrainTimeoutMs?: number
}

export interface TelegramLiveTradingReadiness {
  ready: boolean
  revision: number
}

export interface TelegramMessageDispatchContext {
  readonly authorizationToken?: SignalTradeAuthorizationToken
}

interface TelegramEventMap {
  message: [TelegramSignalMessage]
  status: [TelegramStatusEvent]
  'auth-required': [TelegramAuthRequest]
  error: [TelegramMonitorError]
  ignored: [TelegramIgnoredMessage]
}

interface QueuedTelegramMessage {
  raw: Api.Message
  /** Local wall-clock time at which this update entered our transport queue. */
  receivedAt: Date
  /** Recovery/startup replay may be analyzed and displayed, but never traded. */
  recovered: boolean
  /** Authorization as it existed when the raw live update entered the process. */
  authorizationToken?: SignalTradeAuthorizationToken
}

const DEFAULT_CHANNEL = 'BWEnews'
const DEFAULT_SESSION_KEY = 'telegram.string-session'
const DEFAULT_PROXY_HOST = '127.0.0.1'
const DEFAULT_PROXY_PORT = 7890
const DISCONNECT_CONFIRMATION_CHECKS = 2
const MAX_RECOVERY_BUFFER_MESSAGES = 5_000
const DEFAULT_STOP_DRAIN_TIMEOUT_MS = 2_000

export class TelegramMonitor extends EventEmitter<TelegramEventMap> {
  private client?: TelegramClient
  private channelEntity?: Api.TypeUser | Api.TypeChat
  private eventBuilder?: NewMessage
  private eventHandler?: (event: NewMessageEvent) => Promise<void>
  private connectionEventBuilder?: Raw
  private connectionEventHandler?: (event: unknown) => void
  private healthTimer?: NodeJS.Timeout
  private recoveryConfirmationTimer?: NodeJS.Timeout
  private healthCheckPromise?: Promise<void>
  private startPromise?: Promise<void>
  private stopRequested = false
  private reconnecting = false
  private recoveryPending = false
  private recoveryPromise?: Promise<void>
  private recoveryRevision = 0
  private recoveryMessageBuffer: QueuedTelegramMessage[] = []
  private recoveryBufferOverflow = false
  private disconnectedChecks = 0
  private startupBaselineId = 0
  private lastSeenMessageId = 0
  private recoveryFromMessageId?: number
  private bufferingInitialMessages = false
  private initialMessageBuffer: QueuedTelegramMessage[] = []
  private lastSavedSession = ''
  private processingTail: Promise<void> = Promise.resolve()
  private readonly messageDispatches = new Set<Promise<void>>()
  private stateValue: TelegramMonitorState = 'idle'
  private activeProxyProtocol?: Exclude<TelegramProxyProtocol, 'auto'>
  private readonly deduplicator: BoundedMessageDeduplicator
  private readonly observationDeduplicator: BoundedMessageDeduplicator
  private authBroker = new AuthPromptBroker((request) => this.notifyAuthRequired(request))

  constructor(private readonly options: TelegramMonitorOptions) {
    super()
    validateOptions(options)
    this.deduplicator = new BoundedMessageDeduplicator(options.deduplicationCapacity)
    this.observationDeduplicator = new BoundedMessageDeduplicator(options.deduplicationCapacity)
    // Keep callback-only integrations from triggering EventEmitter's special
    // unhandled "error" behavior. Consumer error listeners still run normally.
    super.on('error', () => undefined)
  }

  get state(): TelegramMonitorState {
    return this.stateValue
  }

  get connected(): boolean {
    return this.liveTradingReadiness.ready
  }

  get liveTradingReadiness(): TelegramLiveTradingReadiness {
    return {
      ready: Boolean(
        this.client?.connected &&
        this.stateValue === 'connected' &&
        !this.recoveryPending &&
        !this.reconnecting &&
        !this.recoveryPromise,
      ),
      revision: this.recoveryRevision,
    }
  }

  get channelUsername(): string {
    return normalizeTelegramUsername(this.options.channel ?? DEFAULT_CHANNEL)
  }

  get proxyProtocol(): Exclude<TelegramProxyProtocol, 'auto'> | undefined {
    return this.activeProxyProtocol
  }

  start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise
    }
    if (this.connected) {
      return Promise.resolve()
    }

    if (this.client) {
      // A prior failed start may leave a partially initialized client behind.
      // Dispose it before constructing a fresh StringSession/client pair.
      const staleClient = this.client
      this.client = undefined
      this.startPromise = staleClient
        .destroy()
        .catch(() => undefined)
        .then(() => this.startInternal())
        .finally(() => {
          this.startPromise = undefined
        })
      return this.startPromise
    }

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    this.authBroker.cancel('Telegram monitor stopped')
    this.setState('stopping')
    this.clearHealthTimer()
    this.clearRecoveryConfirmationTimer()

    const client = this.client
    if (client && this.eventBuilder && this.eventHandler) {
      client.removeEventHandler(this.eventHandler, this.eventBuilder)
    }
    if (client && this.connectionEventBuilder && this.connectionEventHandler) {
      client.removeEventHandler(this.connectionEventHandler, this.connectionEventBuilder)
    }

    const healthCheckToDrain = this.healthCheckPromise
    const recoveryToDrain = this.recoveryPromise
    const drains: Promise<unknown>[] = [
      this.processingTail.catch(() => undefined),
      this.awaitMessageDispatches(),
      this.persistSession().catch((error) => this.reportError(error, false)),
    ]
    if (client) drains.push(client.destroy().catch((error) => this.reportError(error, false)))
    if (healthCheckToDrain) drains.push(healthCheckToDrain.catch(() => undefined))
    if (recoveryToDrain) drains.push(recoveryToDrain.catch(() => undefined))
    // Start destroy immediately, then bound the whole drain. A broken injected
    // callback or a TCP dial that ignores destroy must not make Stop hang
    // forever; stopRequested and the controller's synchronous disarm remain the
    // authoritative fail-closed gates for any task that finishes later.
    await settleWithin(
      Promise.allSettled(drains).then(() => undefined),
      this.options.stopDrainTimeoutMs ?? DEFAULT_STOP_DRAIN_TIMEOUT_MS,
    )

    this.client = undefined
    this.channelEntity = undefined
    this.eventBuilder = undefined
    this.eventHandler = undefined
    this.connectionEventBuilder = undefined
    this.connectionEventHandler = undefined
    this.activeProxyProtocol = undefined
    this.reconnecting = false
    this.recoveryPending = false
    this.recoveryPromise = undefined
    this.recoveryRevision = 0
    this.recoveryMessageBuffer = []
    this.recoveryBufferOverflow = false
    this.disconnectedChecks = 0
    this.recoveryFromMessageId = undefined
    this.bufferingInitialMessages = false
    this.initialMessageBuffer = []
    this.deduplicator.clear()
    this.observationDeduplicator.clear()
    this.setState('stopped')
  }

  provideAuth(field: TelegramAuthField, value: string): boolean {
    return this.authBroker.provide(field, value)
  }

  providePhoneNumber(phoneNumber: string): boolean {
    return this.provideAuth('phoneNumber', phoneNumber)
  }

  providePhoneCode(code: string): boolean {
    return this.provideAuth('phoneCode', code)
  }

  providePassword(password: string): boolean {
    return this.provideAuth('password', password)
  }

  cancelAuthentication(reason = 'Authentication cancelled'): void {
    this.authBroker.cancel(reason)
  }

  private async startInternal(): Promise<void> {
    this.stopRequested = false
    this.clearRecoveryConfirmationTimer()
    this.authBroker = new AuthPromptBroker((request) => this.notifyAuthRequired(request))
    this.deduplicator.clear()
    this.observationDeduplicator.clear()
    this.startupBaselineId = 0
    this.lastSeenMessageId = 0
    this.reconnecting = false
    this.recoveryPending = false
    this.recoveryPromise = undefined
    this.recoveryRevision = 0
    this.recoveryMessageBuffer = []
    this.recoveryBufferOverflow = false
    this.disconnectedChecks = 0
    this.recoveryFromMessageId = undefined
    this.bufferingInitialMessages = false
    this.initialMessageBuffer = []
    this.processingTail = Promise.resolve()
    this.setState('connecting', `Connecting to @${this.channelUsername}`)

    try {
      const storedSession = (await this.options.secretStore.get(this.sessionSecretKey())) ?? ''
      this.lastSavedSession = storedSession
      const connectedClient = await this.connectWithProxyFallback(storedSession)
      this.client = connectedClient
      await this.persistSession()
      if (this.stopRequested) {
        await connectedClient.destroy().catch(() => undefined)
        return
      }

      this.channelEntity = await this.client.getEntity(this.channelUsername)
      const latestMessages = await this.client.getMessages(this.channelEntity, { limit: 1 })
      const latest = latestMessages[0]
      this.startupBaselineId = latest?.id ?? 0
      this.lastSeenMessageId = this.startupBaselineId

      this.bufferingInitialMessages = true
      this.eventBuilder = new NewMessage({ chats: [this.channelEntity], incoming: true })
      this.eventHandler = (event) => this.handleNewMessageEvent(event)
      this.client.addEventHandler(this.eventHandler, this.eventBuilder)

      // Close the small race between reading the baseline and registering the
      // handler. Collect the whole range before dispatching anything so a
      // later-page failure cannot leak a partial recovery into trading.
      const caughtUpMessages = await this.collectCatchUpMessages(this.startupBaselineId)
      this.installConnectionStateHandler(this.client)
      const startupConnectionRevision = this.recoveryRevision
      await this.persistSession()
      const startupAuthorized = this.client.connected && (await this.client.checkAuthorization())
      if (
        !startupAuthorized ||
        !this.client.connected ||
        this.recoveryPending ||
        this.recoveryRevision !== startupConnectionRevision
      ) {
        throw new Error('Telegram session is not connected and authorized after startup')
      }

      // Finish readiness and open the initial buffer in one synchronous turn.
      // This prevents a post from reaching the controller before the monitor
      // has actually published its connected state.
      const bufferedMessages = this.initialMessageBuffer
      this.initialMessageBuffer = []
      this.bufferingInitialMessages = false
      this.setState('connected', `Listening to @${this.channelUsername}`)
      this.startHealthTimer()
      for (const message of mergeQueuedMessages(caughtUpMessages, bufferedMessages)) {
        void this.enqueueRawMessage(
          message.raw,
          message.receivedAt,
          message.recovered,
          message.authorizationToken,
        )
      }
      await this.processingTail
    } catch (cause) {
      if (this.stopRequested) {
        return
      }
      this.setState('error', errorMessage(cause))
      this.clearRecoveryConfirmationTimer()
      await this.reportError(cause, false)
      const failedClient = this.client
      this.client = undefined
      await failedClient?.destroy().catch(() => undefined)
      throw asError(cause)
    }
  }

  private async connectWithProxyFallback(storedSession: string): Promise<TelegramClient> {
    const protocols = this.proxyProtocolsToTry()
    let lastError: unknown

    for (let index = 0; index < protocols.length; index += 1) {
      const protocol = protocols[index]!
      const client = this.createClient(storedSession, protocol)
      this.client = client
      this.activeProxyProtocol = this.options.proxy === false ? undefined : protocol
      let authWasRequested = false

      try {
        client.onError = async (error) => {
          if (!this.stopRequested) {
            // teleproto uses this as a generic recoverable error hook, not as a
            // definitive transport-close event. Let the health checker own
            // connection-state transitions so a harmless RPC/keepalive error
            // cannot revoke live authorization by itself.
            await this.reportError(error, true)
          }
        }

        this.setState(
          'connecting',
          this.options.proxy === false ? 'Connecting directly' : `Connecting through ${protocol.toUpperCase()}`,
        )
        await client.start({
          phoneNumber: async () => {
            authWasRequested = true
            this.setState('authenticating', 'Telegram phone number required')
            return this.resolvePhoneNumber()
          },
          phoneCode: async (isCodeViaApp) => {
            authWasRequested = true
            this.setState('authenticating', 'Telegram login code required')
            return this.resolvePhoneCode(isCodeViaApp)
          },
          password: async (hint) => {
            authWasRequested = true
            this.setState('authenticating', 'Telegram two-step verification password required')
            return this.resolvePassword(hint)
          },
          onError: async (error) => {
            await this.reportError(error, true)
            return (await this.options.auth?.onError?.(error)) ?? false
          },
        })
        return client
      } catch (error) {
        lastError = error
        await client.destroy().catch(() => undefined)
        const hasFallback = index < protocols.length - 1
        if (!hasFallback || authWasRequested || !isLikelyProxyOrNetworkError(error)) {
          throw error
        }
        this.setState('connecting', `${protocol.toUpperCase()} failed; trying HTTP CONNECT`)
      }
    }

    throw asError(lastError ?? new Error('Unable to connect to Telegram'))
  }

  private createClient(
    storedSession: string,
    proxyProtocol: Exclude<TelegramProxyProtocol, 'auto'>,
  ): TelegramClient {
    const proxy = this.proxyConfig()
    const useProxy = this.options.proxy !== false
    const clientParams = {
      connection: ConnectionTCPFull,
      connectionRetries: this.options.connectionRetries ?? 5,
      reconnectRetries: this.options.reconnectRetries ?? 5,
      retryDelay: this.options.reconnectDelayMs ?? 1_000,
      // The application owns reconnect/catch-up sequencing. Letting teleproto
      // reconnect in parallel can expose residual updates before our cursor is
      // verified and can race a manual client.connect() call.
      autoReconnect: false,
      ...(useProxy
        ? {
            proxy: {
              ip: proxy.host,
              port: proxy.port,
              socksType: 5 as const,
              timeout: proxy.timeoutSeconds,
              username: proxy.username,
              password: proxy.password,
            },
          }
        : {}),
      ...(useProxy && proxyProtocol === 'http'
        ? { networkSocket: HttpConnectSocket }
        : {}),
    } satisfies TelegramClientParams

    return new TelegramClient(
      new StringSession(storedSession),
      this.options.apiId,
      this.options.apiHash,
      clientParams,
    )
  }

  private async resolvePhoneNumber(): Promise<string> {
    const value = this.options.auth?.phoneNumber
    if (typeof value === 'string') {
      return value
    }
    if (value) {
      return value()
    }
    return this.authBroker.request({ field: 'phoneNumber', at: new Date().toISOString() })
  }

  private async resolvePhoneCode(isCodeViaApp?: boolean): Promise<string> {
    if (this.options.auth?.phoneCode) {
      return this.options.auth.phoneCode(isCodeViaApp)
    }
    return this.authBroker.request({
      field: 'phoneCode',
      at: new Date().toISOString(),
      isCodeViaApp,
    })
  }

  private async resolvePassword(hint?: string): Promise<string> {
    if (this.options.auth?.password) {
      return this.options.auth.password(hint)
    }
    return this.authBroker.request({ field: 'password', at: new Date().toISOString(), hint })
  }

  private enqueueRawMessage(
    raw: Api.Message,
    receivedAt = new Date(),
    recovered = false,
    authorizationToken?: SignalTradeAuthorizationToken,
  ): Promise<void> {
    if (this.recoveryPending || this.reconnecting) {
      if (this.bufferRecoveryMessage(raw, receivedAt, authorizationToken)) {
        this.observeBufferedRawMessage(raw, receivedAt)
      }
      return Promise.resolve()
    }

    const operation = this.processingTail.then(() =>
      this.processRawMessage(raw, receivedAt, recovered, authorizationToken),
    )
    this.processingTail = operation.catch((error) => this.reportError(error, true))
    return operation
  }

  private async handleNewMessageEvent(event: NewMessageEvent): Promise<void> {
    // This must remain the first synchronous operation in the raw event
    // callback. A later arm/re-arm must never authorize an update that was
    // already received while locked or under an older capability epoch.
    let authorizationToken: SignalTradeAuthorizationToken | undefined
    try {
      authorizationToken = this.options.captureAuthorization?.()
    } catch (error) {
      void this.reportError(error, true)
    }
    // Capture this before any ordered processing. A slow AI request for an
    // earlier post must never make a later Telegram update look newer than it
    // really is.
    const queuedMessage: QueuedTelegramMessage = {
      raw: event.message,
      receivedAt: new Date(),
      recovered: this.bufferingInitialMessages || this.recoveryPending || this.reconnecting,
      authorizationToken,
    }
    if (this.bufferingInitialMessages) {
      this.initialMessageBuffer.push(queuedMessage)
      this.observeBufferedRawMessage(queuedMessage.raw, queuedMessage.receivedAt)
      return
    }
    void this.enqueueRawMessage(
      queuedMessage.raw,
      queuedMessage.receivedAt,
      queuedMessage.recovered,
      queuedMessage.authorizationToken,
    )
  }

  private async processRawMessage(
    raw: Api.Message,
    receivedAt: Date,
    recovered: boolean,
    authorizationToken?: SignalTradeAuthorizationToken,
  ): Promise<void> {
    if (this.stopRequested) {
      return
    }

    // The gate may have closed while this item was already waiting on the FIFO
    // processing chain. Preserve it for the atomic recovery merge instead of
    // consuming its dedupe key or silently losing it.
    if (this.recoveryPending || this.reconnecting) {
      if (this.bufferRecoveryMessage(raw, receivedAt, authorizationToken)) {
        this.observeBufferedRawMessage(raw, receivedAt)
      }
      return
    }

    const id = raw.id
    if (!Number.isSafeInteger(id) || id <= 0) {
      await this.notifyIgnored({
        at: new Date().toISOString(),
        messageId: id,
        reason: 'empty-or-invalid',
      })
      return
    }
    if (id <= this.startupBaselineId) {
      await this.notifyIgnored({ at: new Date().toISOString(), messageId: id, reason: 'historical' })
      return
    }
    const key = telegramMessageKey(this.channelUsername, id)
    if (!this.deduplicator.accept(key)) {
      await this.notifyIgnored({ at: new Date().toISOString(), messageId: id, reason: 'duplicate' })
      return
    }
    this.lastSeenMessageId = Math.max(this.lastSeenMessageId, id)

    const channel = this.channelEntity as unknown as {
      id?: { toString(): string } | number | string
      title?: string
    }
    const signal = extractTelegramSignalMessage(raw, {
      channelUsername: this.channelUsername,
      channelId: channel?.id?.toString(),
      channelTitle: channel?.title,
      receivedAt,
      recovered,
    })
    if (!signal) {
      await this.notifyIgnored({
        at: new Date().toISOString(),
        messageId: id,
        reason: 'empty-or-invalid',
      })
      return
    }

    this.dispatchMessage(signal, { authorizationToken })
  }

  private observeBufferedRawMessage(raw: Api.Message, receivedAt: Date): void {
    if (this.stopRequested || !this.options.callbacks?.onMessageObserved) return
    const id = raw.id
    if (!Number.isSafeInteger(id) || id <= 0 || id <= this.startupBaselineId) return

    const channel = this.channelEntity as unknown as {
      id?: { toString(): string } | number | string
      title?: string
    }
    const signal = extractTelegramSignalMessage(raw, {
      channelUsername: this.channelUsername,
      channelId: channel?.id?.toString(),
      channelTitle: channel?.title,
      receivedAt,
      recovered: true,
    })
    if (!signal) return

    const key = telegramMessageKey(this.channelUsername, id)
    if (!this.observationDeduplicator.accept(key)) return
    this.dispatchObservedMessage(signal)
  }

  private async catchUpMessages(fromMessageId = this.lastSeenMessageId): Promise<void> {
    const messages = await this.collectCatchUpMessages(fromMessageId)
    await Promise.all(
      messages.map((message) =>
        this.enqueueRawMessage(
          message.raw,
          message.receivedAt,
          message.recovered,
          message.authorizationToken,
        ),
      ),
    )
  }

  private async collectCatchUpMessages(
    fromMessageId = this.lastSeenMessageId,
  ): Promise<QueuedTelegramMessage[]> {
    const client = this.client
    const channel = this.channelEntity
    if (!client) throw new Error('Telegram client is unavailable during catch-up')
    if (!channel) throw new Error('Telegram channel is unavailable during catch-up')
    if (!client.connected) throw new Error('Telegram disconnected before catch-up')

    const batchSize = this.options.catchUpLimit ?? 100
    let cursor = fromMessageId
    const collected = new Map<number, QueuedTelegramMessage>()
    while (!this.stopRequested) {
      if (this.client !== client || this.channelEntity !== channel || !client.connected) {
        throw new Error('Telegram connection changed during catch-up')
      }
      const messages = await client.getMessages(channel, {
        limit: batchSize,
        minId: cursor,
        reverse: true,
      })
      if (this.client !== client || this.channelEntity !== channel || !client.connected) {
        throw new Error('Telegram disconnected during catch-up')
      }
      if (messages.length === 0) break

      // All posts in this response entered the local process together. Their
      // Telegram publication timestamps remain in each raw message and let the
      // trading layer reject stale reconnect history independently.
      const receivedAt = new Date()
      let nextCursor = cursor
      for (const message of messages) {
        if (!Number.isSafeInteger(message.id) || message.id <= 0) {
          throw new Error('Telegram catch-up returned an invalid message id')
        }
        nextCursor = Math.max(nextCursor, message.id)
        if (message.id > fromMessageId && !collected.has(message.id)) {
          collected.set(message.id, { raw: message, receivedAt, recovered: true })
        }
      }
      if (messages.length < batchSize) break
      if (nextCursor <= cursor) {
        throw new Error('Telegram catch-up cursor did not advance')
      }
      cursor = nextCursor
    }
    if (this.stopRequested) throw new Error('Telegram catch-up cancelled')
    return [...collected.values()].sort((left, right) => left.raw.id - right.raw.id)
  }

  private startHealthTimer(): void {
    this.clearHealthTimer()
    const interval = this.options.healthCheckIntervalMs ?? 5_000
    this.healthTimer = setInterval(() => {
      void this.healthCheck()
    }, interval)
    this.healthTimer.unref?.()
  }

  private clearHealthTimer(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = undefined
    }
  }

  private scheduleRecoveryConfirmation(): void {
    if (this.recoveryConfirmationTimer || this.stopRequested) return
    const interval = this.options.healthCheckIntervalMs ?? 5_000
    this.recoveryConfirmationTimer = setTimeout(() => {
      this.recoveryConfirmationTimer = undefined
      if (this.stopRequested || !this.recoveryPending) return
      this.disconnectedChecks = DISCONNECT_CONFIRMATION_CHECKS
      this.publishConfirmedReconnect('Telegram recovery exceeded one health interval')
    }, interval)
    this.recoveryConfirmationTimer.unref?.()
  }

  private clearRecoveryConfirmationTimer(): void {
    if (!this.recoveryConfirmationTimer) return
    clearTimeout(this.recoveryConfirmationTimer)
    this.recoveryConfirmationTimer = undefined
  }

  private healthCheck(): Promise<void> {
    if (this.healthCheckPromise) return this.healthCheckPromise

    const operation = this.healthCheckInternal()
    let tracked: Promise<void>
    tracked = operation.finally(() => {
      if (this.healthCheckPromise === tracked) this.healthCheckPromise = undefined
    })
    this.healthCheckPromise = tracked
    return tracked
  }

  private async healthCheckInternal(): Promise<void> {
    const client = this.client
    if (this.stopRequested || !client) return
    if (this.recoveryPromise) return

    if (!client.connected) {
      this.recordFailedConnectionSample()
      if (this.disconnectedChecks >= DISCONNECT_CONFIRMATION_CHECKS) {
        this.publishConfirmedReconnect()
        await this.beginRecovery().catch(() => undefined)
      }
      return
    }

    if (this.recoveryPending) {
      await this.beginRecovery().catch(() => undefined)
      return
    }

    const probeRevision = this.recoveryRevision
    let authorized = false
    try {
      authorized = await client.checkAuthorization()
    } catch (error) {
      await this.reportError(error, true)
    }
    if (
      this.stopRequested ||
      this.client !== client ||
      this.recoveryRevision !== probeRevision ||
      this.recoveryPending
    ) {
      return
    }
    if (!authorized) {
      this.recordFailedConnectionSample()
      if (this.disconnectedChecks >= DISCONNECT_CONFIRMATION_CHECKS) {
        this.publishConfirmedReconnect('Telegram authorization probe failed twice')
        await this.beginRecovery().catch(() => undefined)
      }
      return
    }

    await this.persistSession().catch((error) => this.reportError(error, true))
  }

  private installConnectionStateHandler(client: TelegramClient): void {
    this.connectionEventBuilder = new Raw({ types: [UpdateConnectionState] })
    this.connectionEventHandler = (event: unknown) => {
      if (!(event instanceof UpdateConnectionState) || this.stopRequested) return

      if (event.state === UpdateConnectionState.broken || event.state === UpdateConnectionState.disconnected) {
        this.markRecoveryPending()
        return
      }
      if (
        event.state === UpdateConnectionState.connected &&
        this.recoveryPending &&
        (this.stateValue === 'connected' || this.stateValue === 'reconnecting')
      ) {
        void this.beginRecovery().catch(() => undefined)
      }
    }
    client.addEventHandler(this.connectionEventHandler, this.connectionEventBuilder)
  }

  private markRecoveryPending(): void {
    this.recoveryRevision += 1
    if (this.recoveryPending) return

    this.recoveryPending = true
    this.recoveryFromMessageId = this.lastSeenMessageId
    this.recoveryMessageBuffer = []
    this.recoveryBufferOverflow = false
    this.disconnectedChecks = Math.max(1, this.disconnectedChecks)
    this.scheduleRecoveryConfirmation()
  }

  private recordFailedConnectionSample(): void {
    if (!this.recoveryPending) {
      this.markRecoveryPending()
      return
    }
    this.recoveryRevision += 1
    this.disconnectedChecks = Math.min(
      DISCONNECT_CONFIRMATION_CHECKS,
      Math.max(1, this.disconnectedChecks) + 1,
    )
  }

  private publishConfirmedReconnect(
    detail = 'Telegram connection lost on consecutive health checks',
  ): void {
    this.reconnecting = true
    this.clearRecoveryConfirmationTimer()
    if (this.stateValue !== 'reconnecting') this.setState('reconnecting', detail)
  }

  private beginRecovery(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise

    const operation = this.recoverConnection().catch(async (error) => {
      if (!this.stopRequested) {
        this.disconnectedChecks = Math.min(
          DISCONNECT_CONFIRMATION_CHECKS,
          Math.max(1, this.disconnectedChecks) + 1,
        )
        if (this.disconnectedChecks >= DISCONNECT_CONFIRMATION_CHECKS) {
          this.publishConfirmedReconnect('Telegram recovery could not be verified')
        }
        await this.reportError(error, true)
      }
      throw error
    })
    let tracked: Promise<void>
    tracked = operation.finally(() => {
      if (this.recoveryPromise === tracked) this.recoveryPromise = undefined
    })
    this.recoveryPromise = tracked
    return tracked
  }

  private async recoverConnection(): Promise<void> {
    const client = this.client
    if (!client) throw new Error('Telegram client is unavailable during recovery')
    if (!this.channelEntity) throw new Error('Telegram channel is unavailable during recovery')
    if (!this.recoveryPending) return

    // An overflowed residual buffer is not authoritative: the frozen channel
    // cursor is. Discard it before a retry and rebuild the range from Telegram,
    // while the live handler captures a fresh residual buffer for this attempt.
    if (this.recoveryBufferOverflow) {
      this.recoveryMessageBuffer = []
      this.recoveryBufferOverflow = false
    }
    const recoveryCursor = this.recoveryFromMessageId ?? this.lastSeenMessageId
    if (!client.connected) await client.connect()
    if (this.stopRequested) throw new Error('Telegram recovery cancelled')
    if (!client.connected || !(await client.checkAuthorization())) {
      throw new Error('Telegram session is not connected and authorized')
    }

    // connect() may rotate through several DC addresses and emit a transient
    // disconnected update before a later internal attempt succeeds. Snapshot
    // only after that whole connection/authentication phase; from this point
    // onward, a new negative update invalidates the catch-up window.
    const recoveryRevision = this.recoveryRevision
    const caughtUpMessages = await this.collectCatchUpMessages(recoveryCursor)
    const authorizationStillValid = client.connected && (await client.checkAuthorization())
    if (
      this.stopRequested ||
      this.client !== client ||
      recoveryRevision !== this.recoveryRevision ||
      !client.connected ||
      !authorizationStillValid
    ) {
      throw new Error('Telegram connection changed while recovery was being verified')
    }
    if (this.recoveryBufferOverflow) {
      throw new Error('Telegram recovery buffer exceeded its safety limit')
    }

    // No await is allowed between taking the residual-buffer snapshot and
    // opening the gate. JavaScript's run-to-completion semantics make this an
    // atomic hand-off with the live NewMessage handler.
    const recoveredMessages = mergeQueuedMessages(caughtUpMessages, this.recoveryMessageBuffer)
    this.recoveryMessageBuffer = []
    this.recoveryBufferOverflow = false
    this.recoveryPending = false
    this.clearRecoveryConfirmationTimer()
    this.recoveryFromMessageId = undefined
    this.disconnectedChecks = 0
    const reconnectWasPublished = this.stateValue === 'reconnecting'
    this.reconnecting = false
    // Append the entire recovered range to the FIFO in one synchronous turn.
    // A live NewMessage callback cannot interleave a newer id between two
    // recovered ids before all of them have reserved their queue positions.
    const recoveryDispatches = recoveredMessages.map((message) =>
      this.enqueueRawMessage(
        message.raw,
        message.receivedAt,
        message.recovered,
        message.authorizationToken,
      ),
    )
    if (reconnectWasPublished) {
      this.setState('connected', `Reconnected to @${this.channelUsername}`)
    }

    await Promise.all(recoveryDispatches)
    await this.persistSession().catch((error) => this.reportError(error, true))
  }

  private bufferRecoveryMessage(
    raw: Api.Message,
    receivedAt: Date,
    authorizationToken?: SignalTradeAuthorizationToken,
  ): boolean {
    if (this.stopRequested || this.recoveryBufferOverflow) return false
    if (this.recoveryMessageBuffer.length >= MAX_RECOVERY_BUFFER_MESSAGES) {
      this.recoveryBufferOverflow = true
      return false
    }
    this.recoveryMessageBuffer.push({ raw, receivedAt, recovered: true, authorizationToken })
    return true
  }

  private async persistSession(): Promise<void> {
    const saved = (this.client?.session as StringSession | undefined)?.save()
    if (typeof saved !== 'string' || !saved || saved === this.lastSavedSession) {
      return
    }
    await this.options.secretStore.set(this.sessionSecretKey(), saved)
    this.lastSavedSession = saved
  }

  private sessionSecretKey(): string {
    return this.options.sessionSecretKey ?? DEFAULT_SESSION_KEY
  }

  private proxyConfig(): Required<Pick<TelegramProxyConfig, 'host' | 'port' | 'timeoutSeconds'>> &
    Pick<TelegramProxyConfig, 'username' | 'password'> {
    const proxy = this.options.proxy === false ? {} : (this.options.proxy ?? {})
    return {
      host: proxy.host ?? DEFAULT_PROXY_HOST,
      port: proxy.port ?? DEFAULT_PROXY_PORT,
      timeoutSeconds: proxy.timeoutSeconds ?? 5,
      username: proxy.username,
      password: proxy.password,
    }
  }

  private proxyProtocolsToTry(): Array<Exclude<TelegramProxyProtocol, 'auto'>> {
    if (this.options.proxy === false) {
      // The protocol is ignored when no proxy is configured.
      return ['socks5']
    }
    const protocol = this.options.proxy?.protocol ?? 'auto'
    return protocol === 'auto' ? ['socks5', 'http'] : [protocol]
  }

  private setState(state: TelegramMonitorState, detail?: string): void {
    this.stateValue = state
    const event: TelegramStatusEvent = {
      state,
      at: new Date().toISOString(),
      detail,
      proxyProtocol: this.options.proxy === false ? undefined : this.activeProxyProtocol,
    }
    this.emitSafely('status', event)
    void this.invokeCallback(this.options.callbacks?.onStatus, event)
  }

  private async notifyAuthRequired(request: TelegramAuthRequest): Promise<void> {
    this.emitSafely('auth-required', request)
    await this.options.callbacks?.onAuthRequired?.(request)
  }

  private async notifyIgnored(event: TelegramIgnoredMessage): Promise<void> {
    this.emitSafely('ignored', event)
    await this.invokeCallback(this.options.callbacks?.onIgnoredMessage, event)
  }

  private dispatchMessage(
    message: TelegramSignalMessage,
    context: TelegramMessageDispatchContext,
  ): void {
    this.scheduleMessageDelivery(() => this.deliverMessage(message, context))
  }

  private dispatchObservedMessage(message: TelegramSignalMessage): void {
    this.scheduleMessageDelivery(() => this.deliverObservedMessage(message))
  }

  private scheduleMessageDelivery(deliver: () => Promise<void>): void {
    // setImmediate deliberately leaves the transport Promise chain first. This
    // keeps a slow AI/network callback from delaying validation and dispatch of
    // later Telegram updates. Display-only observations use the same bounded
    // drain so shutdown cannot strand their callbacks.
    const task = new Promise<void>((resolve) => {
      setImmediate(() => {
        void deliver()
          .catch((error) => this.reportError(error, true))
          .finally(resolve)
      })
    })
    this.messageDispatches.add(task)
    void task.finally(() => {
      this.messageDispatches.delete(task)
    })
  }

  private async deliverObservedMessage(message: TelegramSignalMessage): Promise<void> {
    if (this.stopRequested) return
    await this.invokeCallback(this.options.callbacks?.onMessageObserved, message)
  }

  private async deliverMessage(
    message: TelegramSignalMessage,
    context: TelegramMessageDispatchContext,
  ): Promise<void> {
    if (this.stopRequested) return
    this.emitSafely('message', message)
    try {
      await this.options.callbacks?.onMessage?.(message, context)
    } catch (error) {
      await this.reportError(error, true)
    }
  }

  private async awaitMessageDispatches(): Promise<void> {
    // processingTail has already drained before this is called, so no new
    // dispatches can be registered while the monitor is stopping.
    await Promise.allSettled([...this.messageDispatches])
  }

  private async reportError(cause: unknown, recoverable: boolean): Promise<void> {
    const error = asError(cause)
    const event: TelegramMonitorError = {
      at: new Date().toISOString(),
      message: error.message,
      code: readErrorCode(cause),
      recoverable,
      cause: error,
    }
    // Error reporting must never poison the ordered message queue if a UI
    // listener itself fails.
    try {
      this.emit('error', event)
    } catch {
      // A callback error is isolated from the Telegram connection.
    }
    try {
      await this.options.callbacks?.onError?.(event)
    } catch {
      // Avoid recursively reporting an error thrown by the error reporter.
    }
  }

  private emitSafely<K extends keyof TelegramEventMap>(eventName: K, value: TelegramEventMap[K][0]): void {
    try {
      // Node's conditional typed-EventEmitter overload does not accept a
      // generic tuple spread, while every event in this map has one payload.
      ;(this as unknown as EventEmitter).emit(eventName, value)
    } catch (error) {
      void this.reportError(error, true)
    }
  }

  private async invokeCallback<T>(
    callback: ((value: T) => void | Promise<void>) | undefined,
    value: T,
  ): Promise<void> {
    if (!callback) return
    try {
      await callback(value)
    } catch (error) {
      await this.reportError(error, true)
    }
  }
}

function mergeQueuedMessages(
  ...groups: QueuedTelegramMessage[][]
): QueuedTelegramMessage[] {
  const validMessages = new Map<number, QueuedTelegramMessage>()
  const invalidMessages: QueuedTelegramMessage[] = []
  for (const message of groups.flat()) {
    const id = message.raw.id
    if (!Number.isSafeInteger(id) || id <= 0) {
      invalidMessages.push(message)
      continue
    }
    const existing = validMessages.get(id)
    if (!existing) {
      validMessages.set(id, message)
      continue
    }
    const earliest = message.receivedAt.getTime() < existing.receivedAt.getTime()
      ? message
      : existing
    validMessages.set(id, {
      ...earliest,
      recovered: existing.recovered || message.recovered,
    })
  }
  return [
    ...[...validMessages.values()].sort((left, right) => left.raw.id - right.raw.id),
    ...invalidMessages,
  ]
}

class AuthPromptBroker {
  private pending?: {
    field: TelegramAuthField
    resolve: (value: string) => void
    reject: (error: Error) => void
  }
  private cancelledError?: Error

  constructor(private readonly notify: (request: TelegramAuthRequest) => Promise<void>) {}

  async request(request: TelegramAuthRequest): Promise<string> {
    if (this.cancelledError) {
      throw this.cancelledError
    }
    if (this.pending) {
      throw new Error(`An authentication prompt for ${this.pending.field} is already pending`)
    }

    const response = new Promise<string>((resolve, reject) => {
      this.pending = { field: request.field, resolve, reject }
    })
    try {
      await this.notify(request)
    } catch (error) {
      this.pending = undefined
      throw error
    }
    return response
  }

  provide(field: TelegramAuthField, value: string): boolean {
    if (!this.pending || this.pending.field !== field || !value.trim()) {
      return false
    }
    const { resolve } = this.pending
    this.pending = undefined
    resolve(value.trim())
    return true
  }

  cancel(reason: string): void {
    this.cancelledError = new Error(reason)
    const pending = this.pending
    this.pending = undefined
    pending?.reject(this.cancelledError)
  }
}

interface HttpProxyShape {
  ip: string
  port: number
  timeout?: number
  username?: string
  password?: string
}

/** Minimal teleproto network-socket adapter for a local HTTP CONNECT proxy. */
class HttpConnectSocket implements SocketInterface {
  private socket?: Socket
  private buffer = Buffer.alloc(0)
  private waiter?: { resolve: () => void; reject: (error: Error) => void }
  private terminalError?: Error
  private closed = true
  private readonly proxy?: HttpProxyShape

  constructor(proxy?: unknown, private readonly keepAliveInterval = 30_000) {
    if (isHttpProxyShape(proxy)) this.proxy = proxy
  }

  async connect(port: number, ip: string, _testServers?: boolean): Promise<this> {
    if (!this.proxy?.ip || !this.proxy.port) {
      throw new Error('HTTP proxy host and port are required')
    }

    const previousSocket = this.socket
    if (previousSocket) {
      previousSocket.removeAllListeners()
      previousSocket.destroy()
    }
    this.socket = undefined
    this.wakeWaiter(new Error('HTTP proxy socket is reconnecting'))
    this.buffer = Buffer.alloc(0)
    this.terminalError = undefined
    this.closed = true

    this.socket = net.createConnection({ host: this.proxy.ip, port: this.proxy.port })
    this.closed = false
    const timeoutMs = (this.proxy.timeout ?? 5) * 1_000

    await new Promise<void>((resolve, reject) => {
      const socket = this.socket!
      let headers = Buffer.alloc(0)
      let settled = false

      const fail = (cause: unknown): void => {
        if (settled) return
        settled = true
        cleanupHandshake()
        const error = asError(cause)
        socket.destroy()
        reject(error)
      }
      const cleanupHandshake = (): void => {
        socket.off('connect', sendConnect)
        socket.off('data', readHeaders)
        socket.off('error', fail)
        socket.off('timeout', onTimeout)
        socket.setTimeout(0)
      }
      const onTimeout = (): void => fail(new Error('HTTP proxy CONNECT timed out'))
      const sendConnect = (): void => {
        socket.setNoDelay(true)
        if (this.keepAliveInterval > 0) {
          socket.setKeepAlive(true, this.keepAliveInterval)
        }
        const authority = formatAuthority(ip, port)
        const auth = this.proxy?.username
          ? `Proxy-Authorization: Basic ${Buffer.from(`${this.proxy.username}:${this.proxy.password ?? ''}`).toString('base64')}\r\n`
          : ''
        socket.write(
          `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: Keep-Alive\r\n${auth}\r\n`,
        )
      }
      const readHeaders = (chunk: Buffer): void => {
        headers = Buffer.concat([headers, chunk])
        const boundary = headers.indexOf('\r\n\r\n')
        if (boundary < 0) {
          if (headers.length > 64 * 1024) fail(new Error('HTTP proxy response headers are too large'))
          return
        }

        const statusLine = headers.subarray(0, boundary).toString('latin1').split('\r\n')[0] ?? ''
        const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1]
        if (status !== '200') {
          fail(new Error(`HTTP proxy CONNECT failed: ${statusLine || 'invalid response'}`))
          return
        }

        settled = true
        cleanupHandshake()
        const remainder = headers.subarray(boundary + 4)
        this.installSocketListeners(socket)
        if (remainder.length > 0) this.pushData(remainder)
        resolve()
      }

      socket.once('connect', sendConnect)
      socket.on('data', readHeaders)
      socket.once('error', fail)
      socket.once('timeout', onTimeout)
      socket.setTimeout(timeoutMs)
    })
    return this
  }

  async readExactly(length: number): Promise<Buffer> {
    while (this.buffer.length < length) {
      await this.waitForData()
    }
    return this.consume(length)
  }

  async read(length: number): Promise<Buffer> {
    if (this.buffer.length === 0) {
      await this.waitForData()
    }
    return this.consume(Math.min(length, this.buffer.length))
  }

  async readAll(): Promise<Buffer> {
    if (this.buffer.length === 0) {
      await this.waitForData()
    }
    return this.consume(this.buffer.length)
  }

  write(data: Buffer): void {
    if (this.closed || !this.socket) {
      throw new Error('HTTP proxy socket is closed')
    }
    this.socket.write(data)
  }

  async close(): Promise<void> {
    this.closed = true
    this.terminalError = new Error('HTTP proxy socket is closed')
    const socket = this.socket
    this.socket = undefined
    socket?.destroy()
    socket?.unref()
    this.wakeWaiter(this.terminalError)
  }

  toString(): string {
    return 'HttpConnectSocket'
  }

  private installSocketListeners(socket: Socket): void {
    socket.on('data', (chunk) => this.pushData(chunk))
    socket.on('error', (error) => {
      if (this.socket !== socket) return
      this.terminalError = error
      this.wakeWaiter(error)
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.closed = true
      this.terminalError ??= new Error('HTTP proxy socket closed')
      this.wakeWaiter(this.terminalError)
    })
  }

  private pushData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.wakeWaiter()
  }

  private consume(length: number): Buffer {
    const result = this.buffer.subarray(0, length)
    this.buffer = this.buffer.subarray(length)
    return result
  }

  private waitForData(): Promise<void> {
    if (this.buffer.length > 0) return Promise.resolve()
    if (this.terminalError) return Promise.reject(this.terminalError)
    if (this.waiter) return Promise.reject(new Error('Concurrent reads are not supported'))
    return new Promise<void>((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  private wakeWaiter(error?: Error): void {
    const waiter = this.waiter
    this.waiter = undefined
    if (!waiter) return
    if (error) waiter.reject(error)
    else waiter.resolve()
  }
}

function isHttpProxyShape(value: unknown): value is HttpProxyShape {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<HttpProxyShape>
  return typeof candidate.ip === 'string' && Number.isSafeInteger(candidate.port)
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function validateOptions(options: TelegramMonitorOptions): void {
  if (!Number.isSafeInteger(options.apiId) || options.apiId <= 0) {
    throw new TypeError('Telegram apiId must be a positive integer')
  }
  if (!options.apiHash.trim()) {
    throw new TypeError('Telegram apiHash is required')
  }
  if (!options.secretStore) {
    throw new TypeError('A secretStore is required; sessions must not be stored as plaintext')
  }
  const channel = normalizeTelegramUsername(options.channel ?? DEFAULT_CHANNEL)
  if (!/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(channel)) {
    throw new TypeError('Telegram channel must be a valid public username')
  }
  if (options.proxy !== false) {
    const port = options.proxy?.port ?? DEFAULT_PROXY_PORT
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
      throw new TypeError('Telegram proxy port must be between 1 and 65535')
    }
  }
  if (
    options.catchUpLimit !== undefined &&
    (!Number.isSafeInteger(options.catchUpLimit) || options.catchUpLimit <= 0)
  ) {
    throw new TypeError('Telegram catchUpLimit must be a positive integer')
  }
  if (
    options.healthCheckIntervalMs !== undefined &&
    (!Number.isSafeInteger(options.healthCheckIntervalMs) || options.healthCheckIntervalMs < 1_000)
  ) {
    throw new TypeError('Telegram healthCheckIntervalMs must be at least 1000')
  }
  if (
    options.stopDrainTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.stopDrainTimeoutMs) || options.stopDrainTimeoutMs <= 0)
  ) {
    throw new TypeError('Telegram stopDrainTimeoutMs must be a positive integer')
  }
}

function isLikelyProxyOrNetworkError(cause: unknown): boolean {
  const error = asError(cause)
  const code = readErrorCode(cause) ?? ''
  return /ECONN|ETIMEDOUT|EHOST|ENET|ECONNRESET|EPIPE/i.test(code) ||
    /connect|socket|proxy|timed? ?out|network|not connected|connection closed|EOF/i.test(error.message)
}

function readErrorCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== 'object') return undefined
  const value = (cause as { code?: unknown; errorMessage?: unknown }).code ??
    (cause as { errorMessage?: unknown }).errorMessage
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

function errorMessage(cause: unknown): string {
  return asError(cause).message
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function formatAuthority(host: string, port: number): string {
  return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`
}

export type { TelegramSignalMessage } from './telegram-message'
