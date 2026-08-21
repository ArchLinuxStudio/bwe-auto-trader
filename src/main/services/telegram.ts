import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import net, { type Socket } from 'node:net'

import { TelegramClient } from 'telegram'
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js'
import { ConnectionTCPFull } from 'telegram/network/connection/index.js'
import { StringSession } from 'telegram/sessions/index.js'
import type { Api } from 'telegram'
import type { PromisedNetSockets } from 'telegram/extensions/index.js'

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
  /** Return true to abort GramJS' authentication retry loop. */
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
  onMessage?: (message: TelegramSignalMessage) => void | Promise<void>
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
  channel?: string
  proxy?: TelegramProxyConfig | false
  sessionSecretKey?: string
  connectionRetries?: number
  reconnectRetries?: number
  reconnectDelayMs?: number
  healthCheckIntervalMs?: number
  catchUpLimit?: number
  deduplicationCapacity?: number
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
}

const DEFAULT_CHANNEL = 'BWEnews'
const DEFAULT_SESSION_KEY = 'telegram.string-session'
const DEFAULT_PROXY_HOST = '127.0.0.1'
const DEFAULT_PROXY_PORT = 7890
const DISCONNECT_CONFIRMATION_CHECKS = 2

export class TelegramMonitor extends EventEmitter<TelegramEventMap> {
  private client?: TelegramClient
  private channelEntity?: Api.TypeUser | Api.TypeChat
  private eventBuilder?: NewMessage
  private eventHandler?: (event: NewMessageEvent) => Promise<void>
  private healthTimer?: NodeJS.Timeout
  private startPromise?: Promise<void>
  private stopRequested = false
  private reconnecting = false
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
  private authBroker = new AuthPromptBroker((request) => this.notifyAuthRequired(request))

  constructor(private readonly options: TelegramMonitorOptions) {
    super()
    validateOptions(options)
    this.deduplicator = new BoundedMessageDeduplicator(options.deduplicationCapacity)
    // Keep callback-only integrations from triggering EventEmitter's special
    // unhandled "error" behavior. Consumer error listeners still run normally.
    super.on('error', () => undefined)
  }

  get state(): TelegramMonitorState {
    return this.stateValue
  }

  get connected(): boolean {
    return Boolean(this.client?.connected && this.stateValue === 'connected')
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
    if (this.client && this.client.connected) {
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

    const client = this.client
    if (client && this.eventBuilder && this.eventHandler) {
      client.removeEventHandler(this.eventHandler, this.eventBuilder)
    }

    await this.processingTail.catch(() => undefined)
    await this.awaitMessageDispatches()
    await this.persistSession().catch((error) => this.reportError(error, false))
    if (client) {
      await client.destroy().catch((error) => this.reportError(error, false))
    }

    this.client = undefined
    this.channelEntity = undefined
    this.eventBuilder = undefined
    this.eventHandler = undefined
    this.activeProxyProtocol = undefined
    this.reconnecting = false
    this.disconnectedChecks = 0
    this.recoveryFromMessageId = undefined
    this.bufferingInitialMessages = false
    this.initialMessageBuffer = []
    this.deduplicator.clear()
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
    this.authBroker = new AuthPromptBroker((request) => this.notifyAuthRequired(request))
    this.deduplicator.clear()
    this.startupBaselineId = 0
    this.lastSeenMessageId = 0
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
      this.eventHandler = async (event) => {
        // Capture this before any ordered processing. A slow AI request for an
        // earlier post must never make a later Telegram update look newer than
        // it really is.
        const queuedMessage: QueuedTelegramMessage = {
          raw: event.message,
          receivedAt: new Date(),
        }
        if (this.bufferingInitialMessages) {
          this.initialMessageBuffer.push(queuedMessage)
          return
        }
        void this.enqueueRawMessage(queuedMessage.raw, queuedMessage.receivedAt)
      }
      this.client.addEventHandler(this.eventHandler, this.eventBuilder)

      // Close the small race between reading the baseline and registering the handler.
      await this.catchUpMessages(this.startupBaselineId)
      const bufferedMessages = this.initialMessageBuffer.sort(
        (left, right) => left.raw.id - right.raw.id,
      )
      this.initialMessageBuffer = []
      this.bufferingInitialMessages = false
      for (const message of bufferedMessages) {
        void this.enqueueRawMessage(message.raw, message.receivedAt)
      }
      await this.processingTail
      await this.persistSession()
      this.setState('connected', `Listening to @${this.channelUsername}`)
      this.startHealthTimer()
    } catch (cause) {
      if (this.stopRequested) {
        return
      }
      this.setState('error', errorMessage(cause))
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
            // GramJS uses this as a generic recoverable error hook, not as a
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
      autoReconnect: true,
      useWSS: false,
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
        ? { networkSocket: HttpConnectSocket as unknown as typeof PromisedNetSockets }
        : {}),
    }

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
    verifiedRecovery = false,
  ): Promise<void> {
    const operation = this.processingTail.then(() =>
      this.processRawMessage(raw, receivedAt, verifiedRecovery),
    )
    this.processingTail = operation.catch((error) => this.reportError(error, true))
    return operation
  }

  private async processRawMessage(
    raw: Api.Message,
    receivedAt: Date,
    verifiedRecovery: boolean,
  ): Promise<void> {
    if (this.stopRequested) {
      return
    }

    // A single negative `client.connected` sample is treated as a suspected
    // outage until the next health check. Do not dispatch updates from
    // GramJS' residual queue during that window; a successful recovery runs a
    // cursor-based catch-up and processes the same message with its original
    // Telegram publication time.
    if (!verifiedRecovery && (this.disconnectedChecks > 0 || this.reconnecting)) {
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
    })
    if (!signal) {
      await this.notifyIgnored({
        at: new Date().toISOString(),
        messageId: id,
        reason: 'empty-or-invalid',
      })
      return
    }

    this.dispatchMessage(signal)
  }

  private async catchUpMessages(fromMessageId = this.lastSeenMessageId): Promise<void> {
    const client = this.client
    const channel = this.channelEntity
    if (!client || !channel || !client.connected) {
      return
    }

    const batchSize = this.options.catchUpLimit ?? 100
    let cursor = fromMessageId
    while (!this.stopRequested) {
      const messages = await client.getMessages(channel, {
        limit: batchSize,
        minId: cursor,
        reverse: true,
      })
      if (messages.length === 0) return

      // All posts in this response entered the local process together. Their
      // Telegram publication timestamps remain in each raw message and let the
      // trading layer reject stale reconnect history independently.
      const receivedAt = new Date()
      let nextCursor = cursor
      for (const message of messages) {
        nextCursor = Math.max(nextCursor, message.id)
        await this.enqueueRawMessage(message, receivedAt, true)
      }
      if (messages.length < batchSize || nextCursor <= cursor) return
      cursor = nextCursor
    }
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

  private async healthCheck(): Promise<void> {
    const client = this.client
    if (this.stopRequested || !client || this.reconnecting) {
      return
    }

    if (client.connected) {
      const needsCatchUp = this.disconnectedChecks > 0 || this.stateValue === 'reconnecting'
      const reconnectWasPublished = this.stateValue === 'reconnecting'
      this.disconnectedChecks = 0
      if (needsCatchUp) {
        try {
          await this.catchUpMessages(this.recoveryFromMessageId ?? this.lastSeenMessageId)
          this.recoveryFromMessageId = undefined
        } catch (error) {
          await this.reportError(error, true)
          return
        }
        if (reconnectWasPublished) {
          this.setState('connected', `Reconnected to @${this.channelUsername}`)
        }
      }
      await this.persistSession().catch((error) => this.reportError(error, true))
      return
    }

    this.disconnectedChecks += 1
    if (this.disconnectedChecks === 1) {
      // Freeze the recovery cursor at the first observed outage. Events may
      // still be delivered out of GramJS' update queue while reconnecting.
      this.recoveryFromMessageId = this.lastSeenMessageId
    }
    // One false sample can be a brief Clash/GramJS flag transition. Give the
    // transport one complete health interval to recover before publishing a
    // real connection change to the safety controller.
    if (this.disconnectedChecks < DISCONNECT_CONFIRMATION_CHECKS) {
      return
    }

    this.setState('reconnecting', 'Telegram connection lost on consecutive health checks')

    this.reconnecting = true
    try {
      await client.connect()
      if (!(await client.checkAuthorization())) {
        throw new Error('Telegram session is no longer authorized')
      }
      await this.catchUpMessages(this.recoveryFromMessageId ?? this.lastSeenMessageId)
      await this.persistSession()
      this.recoveryFromMessageId = undefined
      this.disconnectedChecks = 0
      this.setState('connected', `Reconnected to @${this.channelUsername}`)
    } catch (error) {
      await this.reportError(error, true)
    } finally {
      this.reconnecting = false
    }
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

  private dispatchMessage(message: TelegramSignalMessage): void {
    // setImmediate deliberately leaves the transport Promise chain first. This
    // keeps a slow AI/network callback from delaying validation and dispatch of
    // later Telegram updates while retaining FIFO callback start order.
    const task = new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.deliverMessage(message)
          .catch((error) => this.reportError(error, true))
          .finally(resolve)
      })
    })
    this.messageDispatches.add(task)
    void task.finally(() => {
      this.messageDispatches.delete(task)
    })
  }

  private async deliverMessage(message: TelegramSignalMessage): Promise<void> {
    if (this.stopRequested) return
    this.emitSafely('message', message)
    await this.invokeCallback(this.options.callbacks?.onMessage, message)
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

/** Minimal GramJS network-socket adapter for a local HTTP CONNECT proxy. */
class HttpConnectSocket {
  private socket?: Socket
  private buffer = Buffer.alloc(0)
  private waiter?: { resolve: () => void; reject: (error: Error) => void }
  private terminalError?: Error
  private closed = true

  constructor(private readonly proxy?: HttpProxyShape) {}

  async connect(port: number, ip: string): Promise<this> {
    if (!this.proxy?.ip || !this.proxy.port) {
      throw new Error('HTTP proxy host and port are required')
    }

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
    this.socket?.destroy()
    this.socket?.unref()
    this.wakeWaiter(this.terminalError)
  }

  toString(): string {
    return 'HttpConnectSocket'
  }

  private installSocketListeners(socket: Socket): void {
    socket.on('data', (chunk) => this.pushData(chunk))
    socket.on('error', (error) => {
      this.terminalError = error
      this.wakeWaiter(error)
    })
    socket.on('close', () => {
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
