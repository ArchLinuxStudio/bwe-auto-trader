import { createHmac, randomBytes } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import net, { type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import tls from 'node:tls'
import { SocksClient } from 'socks'
import WebSocket from 'ws'
import type { AppPosition, ProxySettings } from '../../shared/types'

/**
 * OKX V5 integration for the desktop main process.
 *
 * Security invariants:
 * - Production endpoints are used, but live trading starts DISARMED.
 * - Every state-changing trade needs a short-lived, single-use capability.
 * - A credential-free public-time probe selects one REST route before any
 *   authenticated request. That route is immutable for the client lifetime.
 * - A private WebSocket independently prefers direct transport and may select
 *   the configured Clash proxy only before its socket handshake opens.
 * - Withdrawal endpoints are deliberately not represented by this module.
 *
 * An OKX key used here should have only `Read` and `Trade` permissions and
 * should belong to the dedicated sub-account. Binding the key to a known IP is
 * still recommended, but it is not an application-level connection or order
 * prerequisite. If OKX reports `Withdraw` permission, the client emits a
 * warning but does not block connection because this module exposes no
 * withdrawal operation.
 */

export const OKX_PRODUCTION_REST_URL = 'https://openapi.okx.com'
export const OKX_PRODUCTION_PRIVATE_WS_URL =
  'wss://ws.okx.com:8443/ws/v5/private'

export type OkxDirection = 'LONG' | 'SHORT'
export type OkxTradeArmScope = 'open' | 'close'
export type OkxNetworkRoute = 'direct' | 'proxy'
export type OkxProxyProtocol = Exclude<ProxySettings['protocol'], 'auto'>
export type OkxTransportCategory =
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'connection'
  | 'unknown'
export type OkxTransportStage =
  | 'public_time'
  | 'account_config'
  | 'pending_orders'
  | 'pending_algo_orders'
  | 'instruments'
  | 'positions'
  | 'ticker'
  | 'leverage_info'
  | 'set_leverage'
  | 'place_order'
  | 'close_position'
  | 'order_details'
  | 'private_ws_connect'
  | 'private_ws_auth'
  | 'private_ws_subscribe'
  | 'private_ws_heartbeat'
  | 'unknown'

export interface OkxRouteSelection {
  route: OkxNetworkRoute
  proxyProtocol?: OkxProxyProtocol
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>

export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate?: () => void
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface OkxWebSocketOptions {
  perMessageDeflate: false
  agent?: https.Agent
}

export type WebSocketFactory = (
  url: string,
  options: OkxWebSocketOptions
) => WebSocketLike

export interface OkxCredentials {
  apiKey: string
  secretKey: string
  passphrase: string
}

export interface OkxClientOptions {
  credentials: OkxCredentials
  restBaseUrl?: string
  privateWebSocketUrl?: string
  /**
   * Optional Clash route. It is considered only during initial route
   * selection and is never used as a per-request retry path.
   */
  proxy?: ProxySettings | false
  /** Intended only for tests; represents a strictly direct transport. */
  fetchImpl?: FetchLike
  /** Intended only for tests; represents the configured proxy transport. */
  proxyFetchImpl?: FetchLike
  webSocketFactory?: WebSocketFactory
  proxyWebSocketFactory?: WebSocketFactory
  now?: () => number
  randomId?: () => string
  lookupImpl?: typeof dnsLookup
  requestTimeoutMs?: number
  directProbeTimeoutMs?: number
  /**
   * Permits custom endpoints and injected network transports only in an
   * explicit test rig. Never set this in the packaged application.
   */
  allowCustomEndpointsForTesting?: boolean
}

export interface OkxEnvelope<T> {
  code: string
  msg: string
  data: T[]
  inTime?: string
  outTime?: string
}

export interface OkxAccountConfig {
  acctLv: string
  posMode: string
  perm: string | string[]
  type: string
  uid?: string
  mainUid?: string
  ip?: string
  [key: string]: unknown
}

export interface OkxAccountVerification {
  ok: boolean
  config: OkxAccountConfig
  checks: {
    hasReadPermission: boolean
    hasTradePermission: boolean
    hasNoWithdrawPermission: boolean
    isSubAccount: boolean
    isNetPositionMode: boolean
    supportsDerivatives: boolean
    supportsIsolatedSwapTrading: boolean
    hasNoPendingSwapOrders: boolean
    /** Present on clients that also audit untriggered strategy orders. */
    hasNoPendingSwapAlgoOrders?: boolean
  }
  pendingSwapOrders: OkxOrder[]
  /** Untriggered conditional/trigger/trailing/iceberg/TWAP/chase orders. */
  pendingSwapAlgoOrders?: OkxAlgoOrder[]
  errors: string[]
  warnings: string[]
}

export interface OkxInstrument {
  instType: string
  instId: string
  uly?: string
  instFamily?: string
  baseCcy?: string
  quoteCcy?: string
  settleCcy?: string
  ctVal?: string
  ctMult?: string
  ctValCcy?: string
  ctType?: string
  lotSz: string
  minSz: string
  tickSz?: string
  maxMktSz?: string
  state: string
  [key: string]: unknown
}

export interface OkxTicker {
  instType: string
  instId: string
  last: string
  lastSz?: string
  askPx?: string
  bidPx?: string
  open24h?: string
  high24h?: string
  low24h?: string
  vol24h?: string
  ts: string
  [key: string]: unknown
}

export interface OkxPosition {
  instType: string
  instId: string
  posId?: string
  posSide: 'net' | 'long' | 'short' | string
  pos: string
  mgnMode: 'isolated' | 'cross' | string
  avgPx?: string
  markPx?: string
  upl?: string
  uplRatio?: string
  lever?: string
  liqPx?: string
  cTime?: string
  uTime?: string
  [key: string]: unknown
}

export interface OkxOrderUpdate {
  instType?: string
  instId?: string
  ordId?: string
  clOrdId?: string
  side?: string
  posSide?: string
  state?: string
  fillPx?: string
  fillSz?: string
  tradeId?: string
  accFillSz?: string
  avgPx?: string
  fillTime?: string
  uTime?: string
  code?: string
  msg?: string
  [key: string]: unknown
}

export interface OkxOrder extends OkxOrderUpdate {
  instType: string
  instId: string
  ordId: string
  clOrdId: string
  state: string
  ordType?: string
  sz?: string
  accFillSz?: string
  cTime?: string
  uTime?: string
}

export interface OkxAlgoOrder {
  instType: string
  instId: string
  algoId: string
  ordType: string
  state?: string
  cTime?: string
  uTime?: string
  [key: string]: unknown
}

export interface OkxAccountUpdate {
  [key: string]: unknown
}

export interface OkxDirectConnectionReport {
  checkedAt: string
  okxHost: string
  resolvedAddresses: string[]
  okxReachable: boolean
  publicIp?: string
  publicIpProvider?: string
  proxyEnvironmentVariablesPresent: string[]
  warnings: string[]
}

export interface OkxDirectConnectionProbeOptions {
  restBaseUrl?: string
  ipEchoUrl?: string
  fetchImpl?: FetchLike
  lookupImpl?: typeof dnsLookup
  now?: () => number
  requestTimeoutMs?: number
}

export interface OkxOrderSizing {
  contracts: string
  estimatedNotionalUsdt: number
  targetNotionalUsdt: number
  priceUsed: string
  contractValue: string
  contractMultiplier: string
  lotSize: string
  minimumSize: string
  maximumMarketSize?: string
}

export interface OkxOrderPreview extends OkxOrderSizing {
  instId: string
  direction: OkxDirection
  side: 'buy' | 'sell'
  tdMode: 'isolated'
  ordType: 'market'
  leverage: '1'
  preparedAt: number
}

export interface LiveTradeArm {
  readonly token: string
  readonly scope: OkxTradeArmScope
  readonly runtimeArmed: true
  readonly expiresAt: number
}

export interface PlaceOkxMarketOrderInput {
  symbolOrInstId: string
  direction: OkxDirection
  targetNotionalUsdt?: number
  arm: LiveTradeArm
}

export interface OkxPlacedOrder extends OkxOrderPreview {
  ordId: string
  clOrdId: string
  /** REST accepted the request; execution still needs WS/REST confirmation. */
  executionState: 'pending_confirmation'
  submittedAt: number
}

export interface CloseOkxPositionInput {
  instId: string
  arm: LiveTradeArm
  /**
   * `reduce-only` obtains the full current size and sends a reduceOnly market
   * order. `close-position` is retained in the input type for compatibility
   * but is rejected because that endpoint has no clOrdId for safe ambiguous
   * result reconciliation. Positions are limited to isolated net mode.
   */
  method?: 'reduce-only' | 'close-position'
}

export interface PrepareOkxMarketOrderInput {
  symbolOrInstId: string
  direction: OkxDirection
  targetNotionalUsdt?: number
}

export interface PreparedOkxMarketOrder extends OkxOrderPreview {
  readonly intentToken: string
  readonly expiresAt: number
}

export interface SubmitPreparedOkxMarketOrderInput {
  intent: PreparedOkxMarketOrder
  arm: LiveTradeArm
}

export interface OkxCloseResult {
  instId: string
  method: 'reduce-only' | 'close-position'
  ordId?: string
  clOrdId?: string
  closedSize?: string
  /** REST accepted the request; the position may still be partially open. */
  executionState: 'pending_confirmation'
  requestedAt: number
}

export interface AppPositionSnapshot {
  positions: AppPosition[]
  warnings: string[]
}

export interface OkxPrivateStreamOptions {
  autoReconnect?: boolean
  reconnectDelayMs?: number
  connectTimeoutMs?: number
  heartbeatIntervalMs?: number
}

export type OkxPrivateStreamStatus =
  | 'connecting'
  | 'authenticating'
  | 'subscribing'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'

interface OkxPrivateStreamEventMap {
  ready: []
  orders: [OkxOrderUpdate[]]
  positions: [OkxPosition[]]
  account: [OkxAccountUpdate[]]
  update: [
    {
      channel: 'orders' | 'positions' | 'account'
      data: unknown[]
    }
  ]
  status: [OkxPrivateStreamStatus]
  error: [Error]
}

interface ArmRecord {
  scope: OkxTradeArmScope
  expiresAt: number
  generation: number
}

interface OrderIntentRecord {
  preview: OkxOrderPreview
  expiresAt: number
}

interface UnknownOrderRecord {
  error: OkxOrderStateUnknownError
  clearAuthorized: boolean
}

interface Fraction {
  numerator: bigint
  denominator: bigint
}

interface OkxOrderResponseItem {
  ordId: string
  clOrdId: string
  tag?: string
  ts?: string
  sCode: string
  sMsg: string
}

export class OkxApiError extends Error {
  readonly code: string
  readonly httpStatus?: number

  constructor(message: string, code: string, httpStatus?: number) {
    super(message)
    this.name = 'OkxApiError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export class OkxConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OkxConfigurationError'
  }
}

export class OkxOrderSizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OkxOrderSizeError'
  }
}

export class OkxLiveTradingNotArmedError extends Error {
  constructor(message = 'OKX live trading is not armed') {
    super(message)
    this.name = 'OkxLiveTradingNotArmedError'
  }
}

export class OkxTradeOperationInProgressError extends Error {
  constructor() {
    super('Another OKX trade mutation is already in progress')
    this.name = 'OkxTradeOperationInProgressError'
  }
}

export class OkxOrderStateUnknownError extends Error {
  readonly instId: string
  readonly clOrdId: string
  readonly operation: OkxTradeArmScope
  readonly detectedAt: number

  constructor(
    instId: string,
    clOrdId: string,
    operation: OkxTradeArmScope = 'open',
    detectedAt = Date.now()
  ) {
    super(
      `OKX ${operation} order submission state is unknown for ${instId} (${clOrdId}); reconcile it before any new trade`
    )
    this.name = 'OkxOrderStateUnknownError'
    this.instId = instId
    this.clOrdId = clOrdId
    this.operation = operation
    this.detectedAt = detectedAt
  }
}

export interface OkxOrderReconciliationResult {
  safeToClear: boolean
  order?: OkxOrder
  positions: OkxPosition[]
  reason: string
}

export class OkxTransportError extends OkxApiError {
  readonly stage: OkxTransportStage
  readonly category: OkxTransportCategory
  readonly route?: OkxNetworkRoute
  readonly proxyProtocol?: OkxProxyProtocol

  constructor(options: {
    stage?: OkxTransportStage
    category?: OkxTransportCategory
    route?: OkxNetworkRoute
    proxyProtocol?: OkxProxyProtocol
  } = {}) {
    const stage = options.stage ?? 'unknown'
    const category = options.category ?? 'unknown'
    const route = options.route
    const proxyProtocol = options.proxyProtocol
    super(
      `OKX ${transportStageLabel(stage)} network request failed` +
        `${route ? ` via ${route}` : ''}` +
        `${proxyProtocol ? `/${proxyProtocol}` : ''} (${category})`,
      'TRANSPORT_ERROR'
    )
    this.name = 'OkxTransportError'
    this.stage = stage
    this.category = category
    this.route = route
    this.proxyProtocol = proxyProtocol
  }
}

export class OkxEndpointSecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OkxEndpointSecurityError'
  }
}

function normalizeCredentials(credentials: OkxCredentials): OkxCredentials {
  const normalized = {
    apiKey: credentials.apiKey.trim(),
    secretKey: credentials.secretKey.trim(),
    passphrase: credentials.passphrase
  }

  if (
    !normalized.apiKey ||
    !normalized.secretKey ||
    !normalized.passphrase
  ) {
    throw new OkxConfigurationError(
      'OKX API key, secret key, and passphrase are all required'
    )
  }

  return normalized
}

function parseOkxPermissions(value: unknown): Set<string> {
  let rawPermissions: string[] = []
  if (Array.isArray(value)) {
    rawPermissions = value.filter((entry): entry is string => typeof entry === 'string')
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (Array.isArray(parsed)) {
          rawPermissions = parsed.filter((entry): entry is string => typeof entry === 'string')
        }
      } catch {
        // Fall back to delimiter parsing below for non-JSON strings.
      }
    }
    if (rawPermissions.length === 0) rawPermissions = [trimmed]
  }

  return new Set(
    rawPermissions
      .flatMap((permission) => permission.split(/[,，;；|]/))
      .map((permission) => permission.trim().toLowerCase())
      .filter(Boolean)
  )
}

function redactOkxSecrets(
  value: unknown,
  credentials: OkxCredentials
): string {
  let text = value instanceof Error ? value.message : String(value)
  for (const secret of [
    credentials.apiKey,
    credentials.secretKey,
    credentials.passphrase
  ]) {
    if (secret) text = text.split(secret).join('[REDACTED]')
  }
  return text
    .replace(
      /((?:OK-ACCESS-(?:KEY|SIGN|PASSPHRASE)|apiKey|secretKey|passphrase)\s*[:=]\s*)[^\s,;"'}]+/gi,
      '$1[REDACTED]'
    )
    .slice(0, 500)
}

interface ProxyTransportCandidate {
  selection: OkxRouteSelection
  fetchImpl: FetchLike
  webSocketFactory: WebSocketFactory
}

const MAX_OKX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_PROXY_RESPONSE_HEADER_BYTES = 64 * 1024
const UNKNOWN_ORDER_ABSENCE_CONFIRMATION_MS = 30_000
const MAX_PRIVATE_ORDER_DEDUP_KEYS = 10_000
const OKX_PENDING_ALGO_ORDER_TYPE_QUERIES = [
  'conditional,oco',
  'trigger',
  'move_order_stop',
  'chase',
  'iceberg',
  'twap',
  'smart_iceberg'
] as const
const OKX_PENDING_ALGO_ORDER_TYPES = new Set([
  'conditional',
  'oco',
  'trigger',
  'move_order_stop',
  'chase',
  'iceberg',
  'twap',
  'smart_iceberg'
])

function transportStageLabel(stage: OkxTransportStage): string {
  const labels: Record<OkxTransportStage, string> = {
    public_time: 'public time',
    account_config: 'account configuration',
    pending_orders: 'pending orders',
    pending_algo_orders: 'pending strategy orders',
    instruments: 'instruments',
    positions: 'positions',
    ticker: 'ticker',
    leverage_info: 'leverage information',
    set_leverage: 'set leverage',
    place_order: 'place order',
    close_position: 'close position',
    order_details: 'order details',
    private_ws_connect: 'private WebSocket connection',
    private_ws_auth: 'private WebSocket authentication',
    private_ws_subscribe: 'private WebSocket subscription',
    private_ws_heartbeat: 'private WebSocket heartbeat',
    unknown: 'unknown-stage'
  }
  return labels[stage]
}

function restStageForPath(path: string): OkxTransportStage {
  const stages: Record<string, OkxTransportStage> = {
    '/api/v5/public/time': 'public_time',
    '/api/v5/account/config': 'account_config',
    '/api/v5/trade/orders-pending': 'pending_orders',
    '/api/v5/trade/orders-algo-pending': 'pending_algo_orders',
    '/api/v5/public/instruments': 'instruments',
    '/api/v5/account/positions': 'positions',
    '/api/v5/market/ticker': 'ticker',
    '/api/v5/account/leverage-info': 'leverage_info',
    '/api/v5/account/set-leverage': 'set_leverage',
    '/api/v5/trade/close-position': 'close_position'
  }
  if (path === '/api/v5/trade/order') return 'place_order'
  return stages[path] ?? 'unknown'
}

function classifyTransportError(error: unknown): OkxTransportCategory {
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; current && depth < 5 && !seen.has(current); depth += 1) {
    seen.add(current)
    const record = current as {
      code?: unknown
      name?: unknown
      message?: unknown
      cause?: unknown
    }
    const code = typeof record.code === 'string' ? record.code.toUpperCase() : ''
    const name = typeof record.name === 'string' ? record.name.toLowerCase() : ''
    const message = typeof record.message === 'string' ? record.message.toLowerCase() : ''
    if (
      name === 'aborterror' ||
      code === 'ETIMEDOUT' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      /\b(?:timed? ?out|timeout)\b/.test(message)
    ) {
      return 'timeout'
    }
    if (['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'EAI_FAIL'].includes(code)) return 'dns'
    if (
      code.startsWith('ERR_TLS') ||
      code.startsWith('CERT_') ||
      [
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_GET_ISSUER_CERT',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'HOSTNAME_MISMATCH'
      ].includes(code) ||
      /\b(?:tls|ssl|certificate)\b/.test(message)
    ) {
      return 'tls'
    }
    if (
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'EPIPE',
        'ECONNABORTED'
      ].includes(code)
    ) {
      return 'connection'
    }
    current = record.cause
  }
  return 'unknown'
}

function validateOkxProxy(proxy: ProxySettings | false | undefined): ProxySettings | undefined {
  if (proxy === false || proxy === undefined) return undefined
  const host = proxy.host.trim()
  if (!host || /\s|@|:\/\//.test(host)) {
    throw new OkxConfigurationError(
      'OKX proxy host must be a hostname or IP address without credentials'
    )
  }
  if (!Number.isSafeInteger(proxy.port) || proxy.port < 1 || proxy.port > 65_535) {
    throw new OkxConfigurationError('OKX proxy port must be between 1 and 65535')
  }
  if (!['auto', 'socks5', 'http'].includes(proxy.protocol)) {
    throw new OkxConfigurationError('OKX proxy protocol must be auto, socks5, or http')
  }
  return { host, port: proxy.port, protocol: proxy.protocol }
}

function normalizePositiveTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new OkxConfigurationError(`${label} must be a positive number`)
  }
  return Math.floor(value)
}

function proxyProtocols(proxy: ProxySettings): OkxProxyProtocol[] {
  return proxy.protocol === 'auto' ? ['socks5', 'http'] : [proxy.protocol]
}

function createProxyTransportCandidates(
  proxy: ProxySettings,
  connectTimeoutMs: number
): ProxyTransportCandidate[] {
  return proxyProtocols(proxy).map((protocol) => {
    const agent = new OkxProxyHttpsAgent(proxy, protocol, connectTimeoutMs)
    return {
      selection: { route: 'proxy', proxyProtocol: protocol },
      fetchImpl: createNodeHttpsFetch(agent),
      webSocketFactory: (url, options) =>
        defaultWebSocketFactory(url, { ...options, agent })
    }
  })
}

export class OkxProxyHttpsAgent extends https.Agent {
  constructor(
    private readonly proxy: ProxySettings,
    private readonly proxyProtocol: OkxProxyProtocol,
    private readonly connectTimeoutMs: number
  ) {
    super({ keepAlive: true, maxSockets: 8 })
  }

  override createConnection(
    options: https.RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void
  ): Duplex | null | undefined {
    const host = String(options.servername ?? options.hostname ?? options.host ?? '')
    const port = Number(options.port ?? 443)
    if (!host || !Number.isSafeInteger(port)) {
      callback?.(new Error('Invalid proxy tunnel destination'), undefined as unknown as Duplex)
      return undefined
    }
    void openProxyTunnel(
      this.proxy,
      this.proxyProtocol,
      host,
      port,
      this.connectTimeoutMs
    )
      .then((socket) => openTlsTunnel(socket, host, this.connectTimeoutMs))
      .then((socket) => callback?.(null, socket))
      .catch((error: unknown) =>
        callback?.(
          error instanceof Error ? error : new Error('Proxy connection failed'),
          undefined as unknown as Duplex
        )
      )
    return undefined
  }
}

async function openProxyTunnel(
  proxy: ProxySettings,
  protocol: OkxProxyProtocol,
  destinationHost: string,
  destinationPort: number,
  timeoutMs: number
): Promise<Socket> {
  if (protocol === 'socks5') {
    const result = await SocksClient.createConnection({
      command: 'connect',
      destination: { host: destinationHost, port: destinationPort },
      proxy: { host: proxy.host, port: proxy.port, type: 5 },
      timeout: timeoutMs,
      set_tcp_nodelay: true
    })
    return result.socket
  }
  return openHttpConnectTunnel(proxy, destinationHost, destinationPort, timeoutMs)
}

function openHttpConnectTunnel(
  proxy: ProxySettings,
  destinationHost: string,
  destinationPort: number,
  timeoutMs: number
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = net.createConnection({ host: proxy.host, port: proxy.port })
    let settled = false
    let headers = Buffer.alloc(0)
    const timer = setTimeout(
      () => fail(Object.assign(new Error('Proxy timeout'), { code: 'ETIMEDOUT' })),
      timeoutMs
    )
    timer.unref?.()

    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('connect', onConnect)
      socket.off('data', onData)
      socket.off('error', fail)
      socket.off('close', onClose)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(error instanceof Error ? error : new Error('Proxy connection failed'))
    }
    const onClose = (): void => fail(new Error('Proxy connection closed'))
    const onConnect = (): void => {
      const authority = `${destinationHost}:${destinationPort}`
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: Keep-Alive\r\n\r\n`
      )
    }
    const onData = (chunk: Buffer): void => {
      headers = Buffer.concat([headers, chunk])
      if (headers.length > MAX_PROXY_RESPONSE_HEADER_BYTES) {
        fail(new Error('Proxy response headers exceeded limit'))
        return
      }
      const end = headers.indexOf('\r\n\r\n')
      if (end < 0) return
      const statusLine =
        headers.subarray(0, end).toString('latin1').split('\r\n', 1)[0] ?? ''
      if (!/^HTTP\/\d(?:\.\d)?\s+2\d\d(?:\s|$)/i.test(statusLine)) {
        fail(new Error('Proxy CONNECT rejected'))
        return
      }
      if (headers.length !== end + 4) {
        fail(new Error('Proxy CONNECT returned unexpected tunnel bytes'))
        return
      }
      settled = true
      cleanup()
      resolve(socket)
    }

    socket.once('connect', onConnect)
    socket.on('data', onData)
    socket.once('error', fail)
    socket.once('close', onClose)
  })
}

function openTlsTunnel(socket: Socket, hostname: string, timeoutMs: number): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    const secureSocket = tls.connect({
      socket,
      servername: hostname,
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1']
    })
    let settled = false
    const timer = setTimeout(() => {
      fail(Object.assign(new Error('TLS timeout'), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    timer.unref?.()
    const cleanup = (): void => {
      clearTimeout(timer)
      secureSocket.off('secureConnect', onSecureConnect)
      secureSocket.off('error', fail)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      secureSocket.destroy()
      reject(error instanceof Error ? error : new Error('TLS connection failed'))
    }
    const onSecureConnect = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(secureSocket)
    }
    secureSocket.once('secureConnect', onSecureConnect)
    secureSocket.once('error', fail)
  })
}

function createNodeHttpsFetch(agent: https.Agent | false): FetchLike {
  return async (input, init = {}) => {
    const url = new URL(input)
    if (url.protocol !== 'https:') throw new Error('Only HTTPS is supported')
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const body = requestBodyBuffer(init.body)
    return new Promise<Response>((resolve, reject) => {
      let settled = false
      const request = https.request(
        {
          protocol: 'https:',
          hostname: url.hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: init.method ?? 'GET',
          headers,
          agent
        },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            size += buffer.length
            if (size > MAX_OKX_RESPONSE_BYTES) {
              request.destroy(new Error('OKX response exceeded size limit'))
              return
            }
            chunks.push(buffer)
          })
          response.once('error', finishReject)
          response.once('end', () => {
            if (settled) return
            settled = true
            cleanup()
            const responseHeaders = new Headers()
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) {
                for (const entry of value) responseHeaders.append(name, entry)
              } else if (value !== undefined) responseHeaders.set(name, String(value))
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode ?? 500,
                statusText: response.statusMessage,
                headers: responseHeaders
              })
            )
          })
        }
      )
      const cleanup = (): void => init.signal?.removeEventListener('abort', onAbort)
      const finishReject = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onAbort = (): void => {
        const error = Object.assign(new Error('Request timed out'), { name: 'AbortError' })
        request.destroy(error)
      }
      request.once('error', finishReject)
      if (init.signal?.aborted) onAbort()
      else init.signal?.addEventListener('abort', onAbort, { once: true })
      if (body) request.write(body)
      request.end()
    })
  }
}

function requestBodyBuffer(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof URLSearchParams) return Buffer.from(body.toString())
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  }
  throw new TypeError('Unsupported OKX request body type')
}

export function createOkxRestSignature(
  secretKey: string,
  timestamp: string,
  method: string,
  requestPathWithQuery: string,
  body = ''
): string {
  const prehash = `${timestamp}${method.toUpperCase()}${requestPathWithQuery}${body}`
  return createHmac('sha256', secretKey).update(prehash).digest('base64')
}

export function createOkxWebSocketLoginSignature(
  secretKey: string,
  epochSeconds: string
): string {
  return createOkxRestSignature(
    secretKey,
    epochSeconds,
    'GET',
    '/users/self/verify'
  )
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left
  let b = right < 0n ? -right : right
  while (b !== 0n) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a
}

function simplifyFraction(value: Fraction): Fraction {
  if (value.denominator === 0n) {
    throw new OkxOrderSizeError('Numeric denominator cannot be zero')
  }
  const sign = value.denominator < 0n ? -1n : 1n
  const divisor = gcd(value.numerator, value.denominator)
  return {
    numerator: (value.numerator / divisor) * sign,
    denominator: (value.denominator / divisor) * sign
  }
}

function decimalToFraction(value: string | number): Fraction {
  const raw = String(value).trim().toLowerCase()
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/.exec(raw)
  if (!match) {
    throw new OkxOrderSizeError(`Invalid decimal value: ${raw}`)
  }

  const sign = match[1] === '-' ? -1n : 1n
  const integer = match[2] ?? '0'
  const fraction = match[3] ?? ''
  const exponent = Number.parseInt(match[4] ?? '0', 10)
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, '')
  let numerator = BigInt(digits || '0') * sign
  let denominator = 10n ** BigInt(fraction.length)

  if (exponent > 0) {
    numerator *= 10n ** BigInt(exponent)
  } else if (exponent < 0) {
    denominator *= 10n ** BigInt(-exponent)
  }

  return simplifyFraction({ numerator, denominator })
}

function multiplyFractions(...values: Fraction[]): Fraction {
  return simplifyFraction(
    values.reduce<Fraction>(
      (result, value) => ({
        numerator: result.numerator * value.numerator,
        denominator: result.denominator * value.denominator
      }),
      { numerator: 1n, denominator: 1n }
    )
  )
}

function compareFractions(left: Fraction, right: Fraction): number {
  const difference =
    left.numerator * right.denominator - right.numerator * left.denominator
  return difference < 0n ? -1 : difference > 0n ? 1 : 0
}

function fractionToDecimal(value: Fraction, maximumPlaces = 18): string {
  const simplified = simplifyFraction(value)
  const negative = simplified.numerator < 0n
  const numerator = negative ? -simplified.numerator : simplified.numerator
  const whole = numerator / simplified.denominator
  let remainder = numerator % simplified.denominator
  if (remainder === 0n) return `${negative ? '-' : ''}${whole}`

  let fraction = ''
  for (let index = 0; index < maximumPlaces && remainder !== 0n; index += 1) {
    remainder *= 10n
    fraction += String(remainder / simplified.denominator)
    remainder %= simplified.denominator
  }

  return `${negative ? '-' : ''}${whole}.${fraction.replace(/0+$/, '')}`
}

/**
 * Converts a USDT target into linear-contract count and always rounds down to
 * the exchange lot size. It never rounds up to satisfy minimum order size.
 */
export function calculateUsdtSwapOrderSize(input: {
  targetNotionalUsdt: number
  price: string
  contractValue: string
  contractMultiplier?: string
  lotSize: string
  minimumSize: string
  maximumMarketSize?: string
}): OkxOrderSizing {
  const target = decimalToFraction(input.targetNotionalUsdt)
  const price = decimalToFraction(input.price)
  const contractValue = decimalToFraction(input.contractValue)
  const contractMultiplier = decimalToFraction(
    input.contractMultiplier?.trim() || '1'
  )
  const lotSize = decimalToFraction(input.lotSize)
  const minimumSize = decimalToFraction(input.minimumSize)
  const maximumMarketSize = input.maximumMarketSize?.trim()
    ? decimalToFraction(input.maximumMarketSize)
    : undefined

  for (const [label, value] of [
    ['target notional', target],
    ['price', price],
    ['contract value', contractValue],
    ['contract multiplier', contractMultiplier],
    ['lot size', lotSize],
    ['minimum size', minimumSize],
    ...(maximumMarketSize
      ? ([['maximum market size', maximumMarketSize]] as const)
      : [])
  ] as const) {
    if (value.numerator <= 0n) {
      throw new OkxOrderSizeError(`${label} must be greater than zero`)
    }
  }

  // OKX sizes FUTURES/SWAP in contracts. A linear USDT contract's base
  // quantity is ctVal * ctMult, so its USDT notional is that value * price.
  // floor((target / (price * ctVal * ctMult)) / lotSize) * lotSize
  const denominator = multiplyFractions(
    price,
    contractValue,
    contractMultiplier,
    lotSize
  )
  const lotCount =
    (target.numerator * denominator.denominator) /
    (target.denominator * denominator.numerator)
  const contracts = multiplyFractions(
    { numerator: lotCount, denominator: 1n },
    lotSize
  )

  if (
    contracts.numerator === 0n ||
    compareFractions(contracts, minimumSize) < 0
  ) {
    throw new OkxOrderSizeError(
      `Target ${input.targetNotionalUsdt} USDT is below the instrument minimum after rounding down; refusing to increase it`
    )
  }

  if (
    maximumMarketSize &&
    compareFractions(contracts, maximumMarketSize) > 0
  ) {
    throw new OkxOrderSizeError(
      `Target ${input.targetNotionalUsdt} USDT exceeds the instrument maximum market-order size; refusing to cap it silently`
    )
  }

  const actualNotional = multiplyFractions(
    contracts,
    contractValue,
    contractMultiplier,
    price
  )
  return {
    contracts: fractionToDecimal(contracts),
    estimatedNotionalUsdt: Number(fractionToDecimal(actualNotional)),
    targetNotionalUsdt: input.targetNotionalUsdt,
    priceUsed: input.price,
    contractValue: input.contractValue,
    contractMultiplier: input.contractMultiplier?.trim() || '1',
    lotSize: input.lotSize,
    minimumSize: input.minimumSize,
    ...(input.maximumMarketSize?.trim()
      ? { maximumMarketSize: input.maximumMarketSize }
      : {})
  }
}

export function okxPositionsToAppPositions(
  positions: readonly OkxPosition[],
  instruments: readonly OkxInstrument[] = []
): AppPositionSnapshot {
  const instrumentsById = new Map(
    instruments.map((instrument) => [instrument.instId, instrument])
  )
  const result: AppPosition[] = []
  const warnings: string[] = []

  for (const position of positions) {
    if (position.instType !== 'SWAP' || !isNonZeroPosition(position)) continue
    const signedContracts = Number(position.pos)
    const averagePrice = Number(position.avgPx)
    const markPrice = Number(position.markPx)
    const unrealizedPnl = Number(position.upl)
    const unrealizedPnlPercent = Number(position.uplRatio) * 100
    const leverage = Number(position.lever)
    if (
      !Number.isFinite(signedContracts) ||
      !Number.isFinite(averagePrice) ||
      !Number.isFinite(markPrice) ||
      !Number.isFinite(unrealizedPnl) ||
      !Number.isFinite(unrealizedPnlPercent) ||
      !Number.isFinite(leverage)
    ) {
      warnings.push(`Skipped malformed OKX position ${position.instId}`)
      continue
    }
    if (position.mgnMode !== 'isolated') {
      warnings.push(
        `${position.instId} uses ${position.mgnMode} margin and is outside the V1 isolated-position policy`
      )
    }
    const instrument = instrumentsById.get(position.instId)
    const contractValue = Number(instrument?.ctVal)
    const contractMultiplier = Number(instrument?.ctMult?.trim() || '1')
    const notionalUsd =
      Number.isFinite(contractValue) &&
      contractValue > 0 &&
      Number.isFinite(contractMultiplier) &&
      contractMultiplier > 0
        ? Math.abs(signedContracts) * contractValue * contractMultiplier * markPrice
        : undefined

    result.push({
      instrumentId: position.instId,
      direction:
        position.posSide === 'short' || signedContracts < 0 ? 'short' : 'long',
      contracts: Math.abs(signedContracts),
      notionalUsd,
      averagePrice,
      markPrice,
      unrealizedPnl,
      unrealizedPnlPercent,
      leverage,
      marginMode:
        position.mgnMode === 'isolated' ? 'isolated' : ('cross' as const),
      updatedAt: Number(position.uTime || position.cTime || Date.now())
    })
  }

  return { positions: result, warnings }
}

function proxyEnvironmentVariablesPresent(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy'
  ].filter((name) => Boolean(env[name]))
}

async function fetchWithAbortTimeout(
  fetchImpl: FetchLike,
  requestTimeoutMs: number,
  input: string | URL,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
  timeout.unref?.()
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Credential-free optional diagnostic for the UI. It resolves the configured
 * OKX host, contacts OKX's public clock, and reports the public IP observed on
 * the runtime's current route. The result is informational and must not gate
 * connecting, arming, or trading.
 */
export async function probeOkxDirectConnection(
  options: OkxDirectConnectionProbeOptions = {}
): Promise<OkxDirectConnectionReport> {
  const restBaseUrl = new URL(
    options.restBaseUrl ?? OKX_PRODUCTION_REST_URL
  ).origin
  const ipEchoUrl = options.ipEchoUrl ?? 'https://api.ipify.org?format=json'
  if (!restBaseUrl.startsWith('https://')) {
    throw new OkxEndpointSecurityError('OKX REST URL must use HTTPS')
  }
  if (!ipEchoUrl.startsWith('https://')) {
    throw new OkxEndpointSecurityError('Public IP echo URL must use HTTPS')
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const lookupImpl = options.lookupImpl ?? dnsLookup
  const now = options.now ?? Date.now
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000
  const checkedAt = new Date(now()).toISOString()
  const okxHost = new URL(restBaseUrl).hostname
  const warnings: string[] = []
  let resolvedAddresses: string[] = []
  let okxReachable = false
  let publicIp: string | undefined

  try {
    const records = await lookupImpl(okxHost, { all: true })
    resolvedAddresses = records.map((record) => record.address)
  } catch (error) {
    warnings.push(`OKX DNS lookup failed: ${safeErrorMessage(error)}`)
  }

  try {
    const timeUrl = new URL('/api/v5/public/time', restBaseUrl)
    const response = await fetchWithAbortTimeout(
      fetchImpl,
      requestTimeoutMs,
      timeUrl,
      { method: 'GET', redirect: 'error', cache: 'no-store' }
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const envelope = parseJson<OkxEnvelope<{ ts: string }>>(
      await response.text(),
      'OKX time probe'
    )
    okxReachable =
      envelope.code === '0' && Number.isFinite(Number(envelope.data[0]?.ts))
    if (!okxReachable) throw new Error(envelope.msg || 'invalid time response')
  } catch (error) {
    warnings.push(`OKX REST diagnostic failed: ${safeErrorMessage(error)}`)
  }

  try {
    const response = await fetchWithAbortTimeout(
      fetchImpl,
      requestTimeoutMs,
      ipEchoUrl,
      { method: 'GET', redirect: 'error', cache: 'no-store' }
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    try {
      publicIp = (JSON.parse(text) as { ip?: string }).ip?.trim()
    } catch {
      publicIp = text.trim()
    }
    if (!publicIp) throw new Error('provider returned an empty IP')
  } catch (error) {
    warnings.push(`Public IP check failed: ${safeErrorMessage(error)}`)
  }

  const proxyVariables = proxyEnvironmentVariablesPresent()
  if (proxyVariables.length > 0) {
    warnings.push(
      `Proxy environment detected (${proxyVariables.join(', ')}); OKX may follow the runtime's configured route`
    )
  }

  return {
    checkedAt,
    okxHost,
    resolvedAddresses,
    okxReachable,
    publicIp,
    publicIpProvider: publicIp ? new URL(ipEchoUrl).hostname : undefined,
    proxyEnvironmentVariablesPresent: proxyVariables,
    warnings
  }
}

function parseJson<T>(body: string, context: string): T {
  try {
    return JSON.parse(body) as T
  } catch {
    throw new OkxApiError(`${context} returned invalid JSON`, 'INVALID_JSON')
  }
}

function normalizeInstrumentId(symbolOrInstId: string): string {
  const normalized = symbolOrInstId.trim().toUpperCase()
  if (/^[A-Z0-9]{1,24}$/.test(normalized)) {
    return `${normalized}-USDT-SWAP`
  }
  if (/^[A-Z0-9]{1,24}-USDT-SWAP$/.test(normalized)) {
    return normalized
  }
  throw new OkxConfigurationError(
    `Invalid USDT perpetual instrument or symbol: ${symbolOrInstId}`
  )
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function messageDataToString(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      'utf8'
    )
  }
  return undefined
}

function isNonZeroPosition(position: OkxPosition): boolean {
  const numericPosition = Number(position.pos)
  return Number.isFinite(numericPosition) && numericPosition !== 0
}

function defaultWebSocketFactory(
  url: string,
  options: OkxWebSocketOptions
): WebSocketLike {
  return new WebSocket(url, options) as unknown as WebSocketLike
}

export class OkxV5Client {
  readonly restBaseUrl: string
  readonly privateWebSocketUrl: string

  private readonly credentials: OkxCredentials
  private readonly directFetchImpl: FetchLike
  private readonly proxyTransportCandidates: ProxyTransportCandidate[]
  private readonly webSocketFactory: WebSocketFactory
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly lookupImpl: typeof dnsLookup
  private readonly requestTimeoutMs: number
  private readonly directProbeTimeoutMs: number
  private selectedRestFetchImpl?: FetchLike
  private restRoute?: OkxRouteSelection
  private privateWebSocketRoute?: OkxRouteSelection
  private restRouteSelectionPromise?: Promise<void>
  private serverTimeOffsetMs = 0
  private hasSynchronizedTime = false
  private lastTimeSyncAtMs = 0
  private liveArmed = false
  private liveArmGeneration = 0
  private readonly liveArms = new Map<string, ArmRecord>()
  private liveArmSequence = 0
  private readonly issuedClientOrderIds = new Set<string>()
  private clientOrderSequence = 0
  private orderIntentSequence = 0
  private readonly orderIntents = new Map<string, OrderIntentRecord>()
  private accountVerifiedForOpening = false
  private tradeMutationInProgress = false
  private unknownOrderRecord?: UnknownOrderRecord

  constructor(options: OkxClientOptions) {
    if (
      (
        options.fetchImpl ||
        options.proxyFetchImpl ||
        options.webSocketFactory ||
        options.proxyWebSocketFactory
      ) &&
      !options.allowCustomEndpointsForTesting
    ) {
      throw new OkxEndpointSecurityError(
        'Injected OKX network transports are allowed only in explicit test mode'
      )
    }

    this.credentials = normalizeCredentials(options.credentials)
    this.restBaseUrl = new URL(
      options.restBaseUrl ?? OKX_PRODUCTION_REST_URL
    ).origin
    this.privateWebSocketUrl = new URL(
      options.privateWebSocketUrl ?? OKX_PRODUCTION_PRIVATE_WS_URL
    ).toString()

    if (!this.restBaseUrl.startsWith('https://')) {
      throw new OkxEndpointSecurityError('OKX REST URL must use HTTPS')
    }
    if (!this.privateWebSocketUrl.startsWith('wss://')) {
      throw new OkxEndpointSecurityError('OKX private WebSocket URL must use WSS')
    }
    if (!options.allowCustomEndpointsForTesting) {
      if (this.restBaseUrl !== OKX_PRODUCTION_REST_URL) {
        throw new OkxEndpointSecurityError(
          `Production OKX REST endpoint must be ${OKX_PRODUCTION_REST_URL}`
        )
      }
      if (this.privateWebSocketUrl !== OKX_PRODUCTION_PRIVATE_WS_URL) {
        throw new OkxEndpointSecurityError(
          `Production OKX private WebSocket endpoint must be ${OKX_PRODUCTION_PRIVATE_WS_URL}`
        )
      }
    }

    this.requestTimeoutMs = normalizePositiveTimeout(
      options.requestTimeoutMs ?? 10_000,
      'OKX request timeout'
    )
    this.directProbeTimeoutMs = normalizePositiveTimeout(
      options.directProbeTimeoutMs ?? 2_500,
      'OKX direct probe timeout'
    )
    const proxy = validateOkxProxy(options.proxy)
    const generatedProxyCandidates = proxy
      ? createProxyTransportCandidates(proxy, this.requestTimeoutMs)
      : []
    if ((options.proxyFetchImpl || options.proxyWebSocketFactory) && !proxy) {
      throw new OkxConfigurationError(
        'An OKX proxy must be configured when injecting a proxy transport'
      )
    }
    if (proxy && (options.proxyFetchImpl || options.proxyWebSocketFactory)) {
      const generated = generatedProxyCandidates[0]
      if (!generated) throw new OkxConfigurationError('Could not create OKX proxy transport')
      this.proxyTransportCandidates = [
        {
          selection: {
            route: 'proxy',
            proxyProtocol: proxy.protocol === 'auto' ? 'http' : proxy.protocol
          },
          fetchImpl: options.proxyFetchImpl ?? generated.fetchImpl,
          webSocketFactory:
            options.proxyWebSocketFactory ?? generated.webSocketFactory
        }
      ]
    } else {
      this.proxyTransportCandidates = generatedProxyCandidates
    }
    this.directFetchImpl = options.fetchImpl ?? createNodeHttpsFetch(false)
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory
    this.now = options.now ?? Date.now
    this.randomId =
      options.randomId ?? (() => randomBytes(8).toString('hex'))
    this.lookupImpl = options.lookupImpl ?? dnsLookup
  }

  get isLiveTradingArmed(): boolean {
    return this.liveArmed
  }

  get requiresOrderReconciliation(): boolean {
    return this.unknownOrderRecord !== undefined
  }

  get restRouteSelection(): OkxRouteSelection | undefined {
    return this.restRoute ? { ...this.restRoute } : undefined
  }

  get privateWebSocketRouteSelection(): OkxRouteSelection | undefined {
    return this.privateWebSocketRoute
      ? { ...this.privateWebSocketRoute }
      : undefined
  }

  /**
   * Must be driven by an explicit UI/runtime confirmation. Disarming also
   * invalidates every issued one-time capability.
   */
  setLiveTradingArmed(armed: boolean): void {
    // Every state transition advances the generation. Previously issued
    // capabilities cannot become valid again after disarm/re-arm.
    this.liveArmGeneration += 1
    this.liveArmed = armed
    this.liveArms.clear()
    this.orderIntents.clear()
  }

  /**
   * Issues a capability for exactly one open/close request. The capability is
   * valid for at most 30 seconds by default and cannot be reused.
   */
  armNextLiveTrade(
    scope: OkxTradeArmScope,
    ttlMs = 30_000
  ): LiveTradeArm {
    if (!this.liveArmed) throw new OkxLiveTradingNotArmedError()
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 60_000) {
      throw new OkxConfigurationError(
        'Live trade arm TTL must be between 1 and 60,000 milliseconds'
      )
    }

    const issuedAt = this.now()
    const sequence = (this.liveArmSequence++).toString(36)
    const token = `${issuedAt.toString(36)}${sequence}${this.randomId()}`
    const expiresAt = issuedAt + ttlMs
    this.liveArms.set(token, {
      scope,
      expiresAt,
      generation: this.liveArmGeneration
    })
    return Object.freeze({
      token,
      scope,
      runtimeArmed: true as const,
      expiresAt
    })
  }

  private consumeLiveTradeArm(
    arm: LiveTradeArm | undefined,
    expectedScope: OkxTradeArmScope
  ): void {
    if (!this.liveArmed || !arm || arm.runtimeArmed !== true) {
      throw new OkxLiveTradingNotArmedError()
    }
    const record = this.liveArms.get(arm.token)
    // Consume before performing any request, including on invalid/expired use.
    this.liveArms.delete(arm.token)
    if (
      !record ||
      record.scope !== expectedScope ||
      record.generation !== this.liveArmGeneration ||
      arm.scope !== expectedScope ||
      record.expiresAt !== arm.expiresAt ||
      this.now() > record.expiresAt
    ) {
      throw new OkxLiveTradingNotArmedError(
        'OKX live trade authorization is invalid, expired, or already used'
      )
    }
  }

  /**
   * Clears the unknown-order interlock only after reconcileUnknownOrder()
   * returned safeToClear for the exact outstanding submission. This method is
   * intentionally incapable of bypassing read-only reconciliation.
   */
  confirmOrderReconciled(): void {
    if (!this.unknownOrderRecord?.clearAuthorized) {
      throw new OkxConfigurationError(
        'The unknown OKX order has not been safely reconciled yet'
      )
    }
    this.unknownOrderRecord = undefined
  }

  correctedNow(): number {
    return this.now() + this.serverTimeOffsetMs
  }

  private async ensureRestRouteSelected(): Promise<void> {
    if (this.selectedRestFetchImpl && this.restRoute) return
    if (!this.restRouteSelectionPromise) {
      this.restRouteSelectionPromise = this.selectRestRoute().finally(() => {
        this.restRouteSelectionPromise = undefined
      })
    }
    await this.restRouteSelectionPromise
  }

  private async selectRestRoute(): Promise<void> {
    let lastFailure: { error: unknown; selection: OkxRouteSelection } = {
      error: new Error('Direct route was not probed'),
      selection: { route: 'direct' }
    }
    try {
      await this.probePublicTime(this.directFetchImpl, this.directProbeTimeoutMs)
      this.selectedRestFetchImpl = this.directFetchImpl
      this.restRoute = { route: 'direct' }
      return
    } catch (error) {
      lastFailure = { error, selection: { route: 'direct' } }
    }

    for (const candidate of this.proxyTransportCandidates) {
      try {
        await this.probePublicTime(candidate.fetchImpl, this.requestTimeoutMs)
        this.selectedRestFetchImpl = candidate.fetchImpl
        this.restRoute = { ...candidate.selection }
        return
      } catch (error) {
        lastFailure = { error, selection: candidate.selection }
      }
    }

    throw new OkxTransportError({
      stage: 'public_time',
      category: classifyTransportError(lastFailure.error),
      route: lastFailure.selection.route,
      proxyProtocol: lastFailure.selection.proxyProtocol
    })
  }

  private async probePublicTime(fetchImpl: FetchLike, timeoutMs: number): Promise<void> {
    const url = new URL('/api/v5/public/time', this.restBaseUrl)
    const response = await fetchWithAbortTimeout(fetchImpl, timeoutMs, url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store'
    })
    if (!response.ok) throw new Error('OKX public time probe returned HTTP error')
    const envelope = parseJson<OkxEnvelope<{ ts: string }>>(
      await response.text(),
      'OKX public time route probe'
    )
    if (
      envelope.code !== '0' ||
      !Array.isArray(envelope.data) ||
      !Number.isFinite(Number(envelope.data[0]?.ts))
    ) {
      throw new Error('OKX public time route probe returned invalid data')
    }
  }

  async syncServerTime(): Promise<number> {
    const startedAt = this.now()
    const response = await this.publicRequest<{ ts: string }>(
      'GET',
      '/api/v5/public/time'
    )
    const finishedAt = this.now()
    const serverTime = Number(response[0]?.ts)
    if (!Number.isFinite(serverTime)) {
      throw new OkxApiError(
        'OKX time response did not contain a valid timestamp',
        'INVALID_TIME'
      )
    }
    const localMidpoint = startedAt + (finishedAt - startedAt) / 2
    this.serverTimeOffsetMs = serverTime - localMidpoint
    this.hasSynchronizedTime = true
    this.lastTimeSyncAtMs = finishedAt
    return this.serverTimeOffsetMs
  }

  async ensureServerTimeSynchronized(): Promise<void> {
    if (
      !this.hasSynchronizedTime ||
      this.now() - this.lastTimeSyncAtMs > 5 * 60_000 ||
      this.now() < this.lastTimeSyncAtMs
    ) {
      await this.syncServerTime()
    }
  }

  async getAccountConfig(): Promise<OkxAccountConfig> {
    const data = await this.privateRequest<OkxAccountConfig>(
      'GET',
      '/api/v5/account/config'
    )
    const config = data[0]
    if (!config) {
      throw new OkxApiError(
        'OKX returned no account configuration',
        'EMPTY_ACCOUNT_CONFIG'
      )
    }
    return config
  }

  async verifyAccountConfiguration(): Promise<OkxAccountVerification> {
    // A failed refresh must never leave a prior successful verification usable.
    this.accountVerifiedForOpening = false
    await this.ensureServerTimeSynchronized()
    const [config, pendingSwapOrders, pendingSwapAlgoOrders] = await Promise.all([
      this.getAccountConfig(),
      this.getPendingOrders(),
      this.getPendingAlgoOrders()
    ])
    const permissions = parseOkxPermissions(config.perm)
    const subAccountTypes = new Set(['1', '2', '5', '9', '12'])
    const checks = {
      hasReadPermission: permissions.has('read_only'),
      hasTradePermission: permissions.has('trade'),
      hasNoWithdrawPermission: !permissions.has('withdraw'),
      isSubAccount: subAccountTypes.has(String(config.type)),
      isNetPositionMode: config.posMode === 'net_mode',
      supportsDerivatives: config.acctLv !== '1',
      supportsIsolatedSwapTrading: ['2', '3'].includes(config.acctLv),
      hasNoPendingSwapOrders:
        pendingSwapOrders.length === 0 && pendingSwapAlgoOrders.length === 0,
      hasNoPendingSwapAlgoOrders: pendingSwapAlgoOrders.length === 0
    }
    const errors: string[] = []
    const warnings: string[] = []

    if (!checks.hasReadPermission) errors.push('API key lacks Read permission')
    if (!checks.hasTradePermission) errors.push('API key lacks Trade permission')
    if (!checks.hasNoWithdrawPermission) {
      warnings.push(
        'OKX reports Withdraw permission on this API key. The program has no withdrawal endpoint, but removing that permission is strongly recommended'
      )
    }
    if (!checks.isSubAccount) {
      errors.push('API key is not associated with a dedicated OKX sub-account')
    }
    if (!checks.isNetPositionMode) {
      errors.push('OKX position mode must be net_mode (one-way position)')
    }
    if (!checks.supportsDerivatives) {
      errors.push('OKX account mode does not support USDT perpetual swaps')
    }
    if (!checks.supportsIsolatedSwapTrading) {
      errors.push(
        'OKX account mode must be Futures mode or Multi-currency margin mode for isolated USDT swaps'
      )
    }
    if (pendingSwapOrders.length > 0) {
      errors.push(
        `Dedicated OKX sub-account has ${pendingSwapOrders.length} unfinished SWAP order(s); cancel or finish them before connecting automation`
      )
    }
    if (!checks.hasNoPendingSwapAlgoOrders) {
      errors.push(
        `Dedicated OKX sub-account has ${pendingSwapAlgoOrders.length} untriggered SWAP strategy order(s); cancel them before connecting automation`
      )
    }
    if (!config.ip) {
      warnings.push('API key has no IP binding; binding its current public exit IP is recommended')
    }
    const verification = {
      ok: errors.length === 0,
      config,
      checks,
      pendingSwapOrders,
      pendingSwapAlgoOrders,
      errors,
      warnings
    }
    this.accountVerifiedForOpening = verification.ok
    return verification
  }

  async getInstruments(instId?: string): Promise<OkxInstrument[]> {
    return this.publicRequest<OkxInstrument>(
      'GET',
      '/api/v5/public/instruments',
      {
        instType: 'SWAP',
        ...(instId ? { instId: normalizeInstrumentId(instId) } : {})
      }
    )
  }

  async getUsdtSwapInstrument(
    symbolOrInstId: string
  ): Promise<OkxInstrument> {
    const instId = normalizeInstrumentId(symbolOrInstId)
    const instruments = await this.getInstruments(instId)
    const instrument = instruments.find((entry) => entry.instId === instId)
    if (!instrument) {
      throw new OkxConfigurationError(`OKX has no instrument ${instId}`)
    }
    if (
      instrument.instType !== 'SWAP' ||
      instrument.settleCcy !== 'USDT' ||
      instrument.ctType !== 'linear'
    ) {
      throw new OkxConfigurationError(
        `${instId} is not a linear USDT-settled perpetual swap`
      )
    }
    if (instrument.state !== 'live') {
      throw new OkxConfigurationError(
        `${instId} is not currently live (state: ${instrument.state})`
      )
    }
    if (!instrument.ctVal) {
      throw new OkxConfigurationError(`${instId} has no contract value`)
    }
    if (instrument.ctMult?.trim()) {
      const contractMultiplier = Number(instrument.ctMult)
      if (!Number.isFinite(contractMultiplier) || contractMultiplier <= 0) {
        throw new OkxConfigurationError(
          `${instId} has an invalid contract multiplier`
        )
      }
    }
    const baseCurrency = instId.split('-')[0]
    if (
      instrument.ctValCcy?.trim() &&
      instrument.ctValCcy.trim().toUpperCase() !== baseCurrency
    ) {
      throw new OkxConfigurationError(
        `${instId} contract value is denominated in ${instrument.ctValCcy}; only base-currency linear sizing is supported`
      )
    }
    return instrument
  }

  async getTicker(symbolOrInstId: string): Promise<OkxTicker> {
    const instId = normalizeInstrumentId(symbolOrInstId)
    const data = await this.publicRequest<OkxTicker>(
      'GET',
      '/api/v5/market/ticker',
      { instId }
    )
    const ticker = data[0]
    if (!ticker || !ticker.last || Number(ticker.last) <= 0) {
      throw new OkxApiError(
        `OKX returned no valid ticker for ${instId}`,
        'INVALID_TICKER'
      )
    }
    return ticker
  }

  async getPositions(instId?: string): Promise<OkxPosition[]> {
    const query: Record<string, string> = { instType: 'SWAP' }
    if (instId) query.instId = normalizeInstrumentId(instId)
    return this.privateRequest<OkxPosition>(
      'GET',
      '/api/v5/account/positions',
      query
    )
  }

  /** Returns every live/uncompleted SWAP order in the dedicated sub-account. */
  async getPendingOrders(instId?: string): Promise<OkxOrder[]> {
    const query: Record<string, string> = { instType: 'SWAP' }
    if (instId) query.instId = normalizeInstrumentId(instId)
    return this.privateRequest<OkxOrder>(
      'GET',
      '/api/v5/trade/orders-pending',
      query
    )
  }

  /**
   * Returns every untriggered SWAP strategy order that can later create or
   * modify exposure. OKX requires ordType on this endpoint. Only conditional
   * and OCO are documented as a combined query; every other supported type is
   * requested independently so an unsupported type fails closed.
   */
  async getPendingAlgoOrders(instId?: string): Promise<OkxAlgoOrder[]> {
    const normalizedInstId = instId ? normalizeInstrumentId(instId) : undefined
    const batches = await Promise.all(
      OKX_PENDING_ALGO_ORDER_TYPE_QUERIES.map(async (ordType) => {
        const orders = await this.privateRequest<OkxAlgoOrder>(
          'GET',
          '/api/v5/trade/orders-algo-pending',
          {
            ordType,
            instType: 'SWAP',
            ...(normalizedInstId ? { instId: normalizedInstId } : {}),
            limit: '100'
          }
        )
        for (const order of orders) {
          if (
            !order ||
            order.instType !== 'SWAP' ||
            !order.instId?.trim() ||
            !order.algoId?.trim() ||
            !OKX_PENDING_ALGO_ORDER_TYPES.has(order.ordType)
          ) {
            throw new OkxApiError(
              'OKX returned an invalid pending SWAP strategy order',
              'INVALID_PENDING_ALGO_ORDER'
            )
          }
        }
        if (orders.length >= 100) {
          // One full page already proves the account is unsafe to automate.
          // Fail explicitly instead of returning a deceptively complete list
          // or risking extra requests against the endpoint's account rate cap.
          throw new OkxConfigurationError(
            `OKX returned at least 100 pending ${ordType} SWAP strategy orders; refusing automation`
          )
        }
        return orders
      })
    )
    return batches.flat()
  }

  /**
   * Queries one order by its immutable OKX order ID or our unique client ID.
   * Supply exactly one identifier. This is the primary recovery primitive for
   * OkxOrderStateUnknownError and never mutates exchange state.
   */
  async getOrder(input: {
    instId: string
    ordId?: string
    clOrdId?: string
  }): Promise<OkxOrder | undefined> {
    const ordId = input.ordId?.trim()
    const clOrdId = input.clOrdId?.trim()
    if (Boolean(ordId) === Boolean(clOrdId)) {
      throw new OkxConfigurationError(
        'Provide exactly one of ordId or clOrdId when querying an OKX order'
      )
    }
    const data = await this.privateRequest<OkxOrder>(
      'GET',
      '/api/v5/trade/order',
      {
        instId: normalizeInstrumentId(input.instId),
        ...(ordId ? { ordId } : { clOrdId: clOrdId! })
      }
    )
    return data[0]
  }

  /**
   * Safe helper for an ambiguous POST response. It never clears the interlock
   * itself: the controller must show/audit this result, then explicitly call
   * confirmOrderReconciled() only when `safeToClear` is true.
   */
  async reconcileUnknownOrder(
    error: OkxOrderStateUnknownError
  ): Promise<OkxOrderReconciliationResult> {
    const record = this.unknownOrderRecord
    if (!record) {
      throw new OkxConfigurationError(
        'No unknown OKX order state is awaiting reconciliation'
      )
    }
    if (record.error !== error) {
      throw new OkxConfigurationError(
        'The supplied OKX error does not identify the outstanding unknown order'
      )
    }
    const [order, positions, pendingOrders] = await Promise.all([
      this.getOrder({ instId: error.instId, clOrdId: error.clOrdId }).catch(
        (queryError) => {
          if (
            queryError instanceof OkxApiError &&
            ['51603', '51400'].includes(queryError.code)
          ) {
            return undefined
          }
          throw queryError
        }
      ),
      this.getPositions(error.instId),
      this.getPendingOrders(error.instId)
    ])
    const matchingOrder =
      order?.instId === error.instId && order.clOrdId === error.clOrdId
        ? order
        : undefined
    const openPositions = positions.filter(
      (position) =>
        position.instId === error.instId && isNonZeroPosition(position)
    )
    const matchingPending = pendingOrders.find(
      (pending) =>
        pending.instId === error.instId && pending.clOrdId === error.clOrdId
    )
    const operationEffectVisible =
      error.operation === 'open'
        ? openPositions.length > 0
        : openPositions.length === 0
    const absenceWindowElapsed =
      this.now() - error.detectedAt >= UNKNOWN_ORDER_ABSENCE_CONFIRMATION_MS

    if (
      matchingOrder ||
      matchingPending ||
      operationEffectVisible ||
      absenceWindowElapsed
    ) {
      record.clearAuthorized = true
      const result: OkxOrderReconciliationResult = {
        safeToClear: true,
        order: matchingOrder ?? matchingPending,
        positions: openPositions,
        reason: matchingOrder
          ? `Order reconciled with state ${matchingOrder.state}`
          : matchingPending
            ? 'Order is still pending on OKX'
            : operationEffectVisible
              ? error.operation === 'open'
                ? 'Order produced an open position'
                : 'The position is now closed'
              : 'No matching order or position effect is visible after the order expiry and consistency window'
      }
      return result
    }
    return {
      safeToClear: false,
      positions: openPositions,
      reason:
        'No matching order or conclusive position effect is visible yet; keep the interlock and retry read-only reconciliation later'
    }
  }

  async getLeverage(instId: string): Promise<unknown[]> {
    return this.privateRequest<unknown>(
      'GET',
      '/api/v5/account/leverage-info',
      { instId: normalizeInstrumentId(instId), mgnMode: 'isolated' }
    )
  }

  async previewMarketOrder(input: {
    symbolOrInstId: string
    direction: OkxDirection
    targetNotionalUsdt?: number
  }): Promise<OkxOrderPreview> {
    const targetNotionalUsdt = input.targetNotionalUsdt ?? 10
    if (input.direction !== 'LONG' && input.direction !== 'SHORT') {
      throw new OkxConfigurationError('Order direction must be LONG or SHORT')
    }
    if (
      !Number.isFinite(targetNotionalUsdt) ||
      targetNotionalUsdt <= 0
    ) {
      throw new OkxOrderSizeError('Target order notional must be positive')
    }

    const [instrument, ticker] = await Promise.all([
      this.getUsdtSwapInstrument(input.symbolOrInstId),
      this.getTicker(input.symbolOrInstId)
    ])
    const side = input.direction === 'LONG' ? 'buy' : 'sell'
    const sidePrice = side === 'buy' ? ticker.askPx : ticker.bidPx
    const price =
      sidePrice?.trim() && Number(sidePrice) > 0 ? sidePrice : ticker.last
    const sizing = calculateUsdtSwapOrderSize({
      targetNotionalUsdt,
      price,
      contractValue: instrument.ctVal!,
      contractMultiplier: instrument.ctMult,
      lotSize: instrument.lotSz,
      minimumSize: instrument.minSz,
      maximumMarketSize: instrument.maxMktSz
    })

    return {
      ...sizing,
      instId: instrument.instId,
      direction: input.direction,
      side,
      tdMode: 'isolated',
      ordType: 'market',
      leverage: '1',
      preparedAt: this.correctedNow()
    }
  }

  async placeMarketOrder(
    input: PlaceOkxMarketOrderInput
  ): Promise<OkxPlacedOrder> {
    this.consumeLiveTradeArm(input.arm, 'open')
    return this.withTradeMutation(async (generation) => {
      this.requireVerifiedAccountForOpening()
      const preview = await this.previewMarketOrder(input)
      return this.submitMarketOrderPreview(
        preview,
        generation,
        input.arm.expiresAt
      )
    })
  }

  /**
   * Safer two-phase entry flow for UI/automation integration. Preparing checks
   * the verified account state and creates a short-lived immutable intent;
   * submitting still requires the independent one-time live-trade arm.
   */
  async prepareMarketOrder(
    input: PrepareOkxMarketOrderInput,
    ttlMs = 10_000
  ): Promise<PreparedOkxMarketOrder> {
    const requestedAt = this.now()
    if (!this.liveArmed) throw new OkxLiveTradingNotArmedError()
    this.requireVerifiedAccountForOpening()
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 30_000) {
      throw new OkxConfigurationError(
        'Order intent TTL must be between 1 and 30,000 milliseconds'
      )
    }
    const preview = await this.previewMarketOrder(input)
    const expiresAt = requestedAt + ttlMs
    if (this.now() > expiresAt) {
      throw new OkxLiveTradingNotArmedError(
        'OKX prepared order intent expired during market-data preview'
      )
    }
    const sequence = (this.orderIntentSequence++).toString(36)
    const intentToken = `${requestedAt.toString(36)}${sequence}${this.randomId()}`
    this.orderIntents.set(intentToken, { preview, expiresAt })
    return Object.freeze({ ...preview, intentToken, expiresAt })
  }

  async submitPreparedMarketOrder(
    input: SubmitPreparedOkxMarketOrderInput
  ): Promise<OkxPlacedOrder> {
    this.consumeLiveTradeArm(input.arm, 'open')
    const record = this.orderIntents.get(input.intent.intentToken)
    this.orderIntents.delete(input.intent.intentToken)
    if (
      !record ||
      record.expiresAt !== input.intent.expiresAt ||
      this.now() > record.expiresAt ||
      !this.sameOrderPreview(record.preview, input.intent)
    ) {
      throw new OkxLiveTradingNotArmedError(
        'OKX order intent is invalid, expired, altered, or already used'
      )
    }
    return this.withTradeMutation((generation) =>
      this.submitMarketOrderPreview(
        record.preview,
        generation,
        record.expiresAt
      )
    )
  }

  private async submitMarketOrderPreview(
    preview: OkxOrderPreview,
    armGeneration: number,
    expiresAt: number
  ): Promise<OkxPlacedOrder> {
    this.requireVerifiedAccountForOpening()
    if (this.unknownOrderRecord) {
      throw new OkxConfigurationError(
        'A prior OKX order has unknown state; reconcile it before trading again'
      )
    }
    const [positionsResponse, pendingOrders, pendingAlgoOrders] = await Promise.all([
      this.getPositions(),
      this.getPendingOrders(),
      this.getPendingAlgoOrders()
    ])
    const positions = positionsResponse.filter(isNonZeroPosition)
    if (positions.length > 0) {
      throw new OkxConfigurationError(
        'The dedicated OKX sub-account already has an open position; refusing another opening order'
      )
    }
    if (pendingOrders.length > 0) {
      throw new OkxConfigurationError(
        'The dedicated OKX sub-account has unfinished SWAP orders; refusing another opening order'
      )
    }
    if (pendingAlgoOrders.length > 0) {
      throw new OkxConfigurationError(
        'The dedicated OKX sub-account has untriggered SWAP strategy orders; refusing another opening order'
      )
    }
    this.assertTradeTransmissionAllowed(armGeneration, expiresAt)
    await this.setOneXLeverage(preview.instId, armGeneration, expiresAt)
    this.assertTradeTransmissionAllowed(armGeneration, expiresAt)
    const clOrdId = this.createClientOrderId()
    const order = await this.submitIdentifiedOrder(
      preview.instId,
      clOrdId,
      'open',
      {
        instId: preview.instId,
        tdMode: 'isolated',
        side: preview.side,
        posSide: 'net',
        ordType: 'market',
        sz: preview.contracts,
        clOrdId
      },
      armGeneration,
      expiresAt
    )
    return {
      ...preview,
      ordId: order.ordId,
      clOrdId,
      executionState: 'pending_confirmation',
      submittedAt: this.correctedNow()
    }
  }

  private sameOrderPreview(
    expected: OkxOrderPreview,
    received: OkxOrderPreview
  ): boolean {
    return (
      expected.instId === received.instId &&
      expected.direction === received.direction &&
      expected.side === received.side &&
      expected.contracts === received.contracts &&
      expected.estimatedNotionalUsdt === received.estimatedNotionalUsdt &&
      expected.targetNotionalUsdt === received.targetNotionalUsdt &&
      expected.priceUsed === received.priceUsed &&
      expected.contractValue === received.contractValue &&
      expected.contractMultiplier === received.contractMultiplier &&
      expected.lotSize === received.lotSize &&
      expected.minimumSize === received.minimumSize &&
      expected.maximumMarketSize === received.maximumMarketSize &&
      expected.preparedAt === received.preparedAt &&
      expected.leverage === received.leverage &&
      expected.tdMode === received.tdMode &&
      expected.ordType === received.ordType
    )
  }

  private requireVerifiedAccountForOpening(): void {
    if (!this.accountVerifiedForOpening) {
      throw new OkxConfigurationError(
        'Verify the OKX API permissions, dedicated sub-account, account mode, and net position mode before opening a live position'
      )
    }
  }

  async closeEntirePosition(
    input: CloseOkxPositionInput
  ): Promise<OkxCloseResult> {
    this.consumeLiveTradeArm(input.arm, 'close')
    return this.withTradeMutation((generation) =>
      this.closeEntirePositionInternal(input, generation, input.arm.expiresAt)
    )
  }

  private async closeEntirePositionInternal(
    input: CloseOkxPositionInput,
    armGeneration: number,
    expiresAt: number
  ): Promise<OkxCloseResult> {
    const instId = normalizeInstrumentId(input.instId)
    const method = input.method ?? 'reduce-only'

    if (this.unknownOrderRecord) {
      throw new OkxConfigurationError(
        'A prior OKX order has unknown state; reconcile it before trading again'
      )
    }

    if (method === 'close-position') {
      throw new OkxConfigurationError(
        'The OKX close-position endpoint is disabled because it provides no client order ID for safe ambiguous-result reconciliation; use reduce-only'
      )
    }

    const [positionsResponse, pendingOrdersResponse, pendingAlgoOrdersResponse] =
      await Promise.all([
        this.getPositions(instId),
        this.getPendingOrders(instId),
        this.getPendingAlgoOrders(instId)
      ])
    // The REST queries are scoped to this instrument. Filter the responses as
    // well so unrelated positions/orders can never prevent a risk-reducing
    // close if OKX returns a broader result set than requested.
    const pendingOrders = pendingOrdersResponse.filter(
      (order) => order.instId === instId
    )
    const pendingAlgoOrders = pendingAlgoOrdersResponse.filter(
      (order) => order.instId === instId
    )
    if (pendingOrders.length > 0) {
      throw new OkxConfigurationError(
        `${instId} already has an unfinished order; refusing a duplicate close request`
      )
    }
    if (pendingAlgoOrders.length > 0) {
      throw new OkxConfigurationError(
        `${instId} already has an untriggered strategy order; cancel or finish it in OKX before closing the position`
      )
    }
    const positions = positionsResponse.filter(
      (position) =>
        position.instId === instId &&
        position.mgnMode === 'isolated' &&
        isNonZeroPosition(position)
    )
    if (positions.length !== 1) {
      throw new OkxConfigurationError(
        positions.length === 0
          ? `No open isolated position exists for ${instId}`
          : `Expected one net position for ${instId}, received ${positions.length}`
      )
    }
    const position = positions[0]!
    if (position.posSide !== 'net') {
      throw new OkxConfigurationError(
        `Cannot reduce ${instId}: account is not using net position mode`
      )
    }
    const numericSize = Number(position.pos)
    const size = position.pos.startsWith('-')
      ? position.pos.slice(1)
      : position.pos
    const clOrdId = this.createClientOrderId()
    this.assertTradeTransmissionAllowed(armGeneration, expiresAt)
    const order = await this.submitIdentifiedOrder(
      instId,
      clOrdId,
      'close',
      {
        instId,
        tdMode: 'isolated',
        side: numericSize > 0 ? 'sell' : 'buy',
        posSide: 'net',
        ordType: 'market',
        sz: size,
        reduceOnly: true,
        clOrdId
      },
      armGeneration,
      expiresAt
    )
    return {
      instId,
      method,
      ordId: order.ordId,
      clOrdId,
      closedSize: size,
      executionState: 'pending_confirmation',
      requestedAt: this.correctedNow()
    }
  }

  private assertTradeTransmissionAllowed(
    expectedGeneration: number,
    expiresAt: number
  ): void {
    this.assertLiveGeneration(expectedGeneration)
    if (this.now() > expiresAt) {
      throw new OkxLiveTradingNotArmedError(
        'OKX live trade authorization or prepared order intent expired before transmission'
      )
    }
  }

  private assertLiveGeneration(expectedGeneration: number): void {
    if (!this.liveArmed || this.liveArmGeneration !== expectedGeneration) {
      throw new OkxLiveTradingNotArmedError(
        'OKX live trading was disarmed before order transmission'
      )
    }
  }

  private async withTradeMutation<T>(
    operation: (generation: number) => Promise<T>
  ): Promise<T> {
    if (this.tradeMutationInProgress) {
      throw new OkxTradeOperationInProgressError()
    }
    this.tradeMutationInProgress = true
    const generation = this.liveArmGeneration
    try {
      this.assertLiveGeneration(generation)
      return await operation(generation)
    } finally {
      this.tradeMutationInProgress = false
    }
  }

  createPrivateStream(
    options: OkxPrivateStreamOptions = {}
  ): OkxPrivateStream {
    const preferredProtocol = this.restRoute?.proxyProtocol
    const proxies = [...this.proxyTransportCandidates].sort((left, right) => {
      if (!preferredProtocol) return 0
      return left.selection.proxyProtocol === preferredProtocol
        ? -1
        : right.selection.proxyProtocol === preferredProtocol
          ? 1
          : 0
    })
    return new OkxPrivateStream(this, this.credentials, {
      routeCandidates: [
        {
          selection: { route: 'direct' },
          factory: this.webSocketFactory
        },
        ...proxies.map((candidate) => ({
          selection: candidate.selection,
          factory: candidate.webSocketFactory
        }))
      ],
      url: this.privateWebSocketUrl,
      routeProbeTimeoutMs: this.directProbeTimeoutMs,
      onRouteSelected: (selection) => {
        this.privateWebSocketRoute = { ...selection }
      },
      ...options
    })
  }

  async checkDirectConnection(
    ipEchoUrl = 'https://api.ipify.org?format=json'
  ): Promise<OkxDirectConnectionReport> {
    const report = await probeOkxDirectConnection({
      restBaseUrl: this.restBaseUrl,
      ipEchoUrl,
      fetchImpl: this.directFetchImpl,
      lookupImpl: this.lookupImpl,
      now: this.now,
      requestTimeoutMs: this.requestTimeoutMs
    })
    if (report.okxReachable) await this.syncServerTime()
    return report
  }

  private createClientOrderId(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const sequence = (this.clientOrderSequence++).toString(36)
      const candidate = `bwe${this.now().toString(36)}${sequence}${this.randomId()}`
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 32)
      if (candidate.length > 3 && !this.issuedClientOrderIds.has(candidate)) {
        this.issuedClientOrderIds.add(candidate)
        return candidate
      }
    }
    throw new OkxConfigurationError('Could not generate a unique client order ID')
  }

  private async setOneXLeverage(
    instId: string,
    armGeneration: number,
    expiresAt: number
  ): Promise<void> {
    await this.privateRequest<unknown>(
      'POST',
      '/api/v5/account/set-leverage',
      undefined,
      { instId, lever: '1', mgnMode: 'isolated' },
      undefined,
      () => this.assertTradeTransmissionAllowed(armGeneration, expiresAt)
    )
  }

  private async submitIdentifiedOrder(
    instId: string,
    clOrdId: string,
    operation: OkxTradeArmScope,
    body: Record<string, unknown>,
    armGeneration: number,
    expiresAt: number
  ): Promise<OkxOrderResponseItem> {
    // Keep time sync outside the ambiguous-result boundary: if this read-only
    // prerequisite fails, the order endpoint was never called.
    await this.ensureServerTimeSynchronized()
    try {
      const response = await this.request<OkxOrderResponseItem>(
        'POST',
        '/api/v5/trade/order',
        undefined,
        body,
        true,
        expiresAt,
        () => this.assertTradeTransmissionAllowed(armGeneration, expiresAt)
      )
      return this.requireSuccessfulOrderResponse(response, clOrdId)
    } catch (error) {
      if (!this.isAmbiguousOrderSubmissionError(error)) throw error
      const unknown = new OkxOrderStateUnknownError(
        instId,
        clOrdId,
        operation,
        this.now()
      )
      this.unknownOrderRecord = { error: unknown, clearAuthorized: false }
      throw unknown
    }
  }

  private isAmbiguousOrderSubmissionError(error: unknown): boolean {
    if (
      error instanceof OkxLiveTradingNotArmedError ||
      error instanceof OkxConfigurationError ||
      error instanceof OkxEndpointSecurityError
    ) {
      return false
    }
    if (error instanceof OkxTransportError) {
      return error.stage === 'place_order'
    }
    if (error instanceof OkxApiError) {
      if (
        [
          'INVALID_JSON',
          'INVALID_RESPONSE',
          'EMPTY_ORDER_RESULT',
          'INVALID_ORDER_ACK'
        ].includes(error.code)
      ) {
        return true
      }
      const status = error.httpStatus
      if (/^HTTP_\d+$/.test(error.code)) return true
      return (
        status === 408 ||
        status === 425 ||
        status === 429 ||
        (status !== undefined && status >= 500)
      )
    }
    // A response-body read failure or other exception after the transmission
    // boundary cannot prove whether OKX accepted the uniquely identified order.
    return true
  }

  private requireSuccessfulOrderResponse(
    response: OkxOrderResponseItem[],
    clOrdId: string
  ): OkxOrderResponseItem {
    const order = response[0]
    if (!order || response.length !== 1) {
      throw new OkxApiError(
        `OKX returned no order result for ${clOrdId}`,
        'EMPTY_ORDER_RESULT'
      )
    }
    if (typeof order.sCode !== 'string') {
      throw new OkxApiError(
        `OKX returned an invalid order acknowledgement for ${clOrdId}`,
        'INVALID_ORDER_ACK'
      )
    }
    if (order.sCode !== '0') {
      throw new OkxApiError(
        redactOkxSecrets(
          order.sMsg || `OKX rejected order ${clOrdId}`,
          this.credentials
        ),
        order.sCode
      )
    }
    if (
      typeof order.ordId !== 'string' ||
      !order.ordId.trim() ||
      order.clOrdId !== clOrdId
    ) {
      throw new OkxApiError(
        `OKX returned an invalid order acknowledgement for ${clOrdId}`,
        'INVALID_ORDER_ACK'
      )
    }
    return order
  }

  private async publicRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    query?: Record<string, string>,
    body?: unknown
  ): Promise<T[]> {
    return this.request<T>(method, path, query, body, false)
  }

  private async privateRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    query?: Record<string, string>,
    body?: unknown,
    expTimeDeadlineAt?: number,
    beforeFetch?: () => void
  ): Promise<T[]> {
    await this.ensureServerTimeSynchronized()
    return this.request<T>(
      method,
      path,
      query,
      body,
      true,
      expTimeDeadlineAt,
      beforeFetch
    )
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, string> | undefined,
    body: unknown,
    authenticated: boolean,
    expTimeDeadlineAt?: number,
    beforeFetch?: () => void
  ): Promise<T[]> {
    await this.ensureRestRouteSelected()
    const fetchImpl = this.selectedRestFetchImpl
    const route = this.restRoute
    if (!fetchImpl || !route) {
      throw new OkxTransportError({
        stage: restStageForPath(path),
        category: 'unknown'
      })
    }
    const url = new URL(path, this.restBaseUrl)
    if (query) {
      for (const [name, value] of Object.entries(query)) {
        url.searchParams.append(name, value)
      }
    }
    const requestPath = `${url.pathname}${url.search}`
    const bodyText = body === undefined ? '' : JSON.stringify(body)
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }

    if (authenticated) {
      const timestamp = new Date(this.correctedNow()).toISOString()
      headers['OK-ACCESS-KEY'] = this.credentials.apiKey
      headers['OK-ACCESS-PASSPHRASE'] = this.credentials.passphrase
      headers['OK-ACCESS-TIMESTAMP'] = timestamp
      headers['OK-ACCESS-SIGN'] = createOkxRestSignature(
        this.credentials.secretKey,
        timestamp,
        method,
        requestPath,
        bodyText
      )
      if (expTimeDeadlineAt !== undefined) {
        const correctedIntentDeadline =
          expTimeDeadlineAt + this.serverTimeOffsetMs
        headers['expTime'] = String(
          Math.floor(
            Math.min(this.correctedNow() + 5_000, correctedIntentDeadline)
          )
        )
      }
    }

    // This is the last synchronous boundary before the transport starts. Live
    // generation and absolute intent/arm expiry are rechecked here after every
    // route/time-sync await and after signing, so emergency disarm wins races.
    beforeFetch?.()

    let response: Response
    try {
      response = await this.fetchWithTimeout(fetchImpl, url, {
        method,
        headers,
        body: bodyText || undefined,
        redirect: 'error',
        cache: 'no-store'
      })
    } catch (error) {
      if (error instanceof OkxApiError) throw error
      // Never propagate fetch/dispatcher errors verbatim: they may include
      // request headers, signatures, or credentials. The fixed stage, route,
      // and coarse category are sufficient for safe diagnostics.
      throw new OkxTransportError({
        stage: restStageForPath(path),
        category: classifyTransportError(error),
        route: route.route,
        proxyProtocol: route.proxyProtocol
      })
    }
    const responseBody = await response.text()
    if (!response.ok) {
      let message = `OKX HTTP ${response.status}`
      let code = `HTTP_${response.status}`
      try {
        const parsed = JSON.parse(responseBody) as { code?: string; msg?: string }
        if (parsed.msg) {
          message = redactOkxSecrets(parsed.msg, this.credentials)
        }
        if (parsed.code) code = parsed.code
      } catch {
        // Do not include arbitrary HTML/body content in application logs.
      }
      throw new OkxApiError(message, code, response.status)
    }

    const envelope = parseJson<OkxEnvelope<T>>(responseBody, 'OKX')
    if (envelope.code !== '0') {
      throw new OkxApiError(
        redactOkxSecrets(
          envelope.msg || `OKX request failed with code ${envelope.code}`,
          this.credentials
        ),
        envelope.code,
        response.status
      )
    }
    if (!Array.isArray(envelope.data)) {
      throw new OkxApiError(
        'OKX response data was not an array',
        'INVALID_RESPONSE'
      )
    }
    return envelope.data
  }

  private async fetchWithTimeout(
    fetchImpl: FetchLike,
    input: string | URL,
    init: RequestInit
  ): Promise<Response> {
    return fetchWithAbortTimeout(
      fetchImpl,
      this.requestTimeoutMs,
      input,
      init
    )
  }
}

interface PrivateWebSocketRouteCandidate {
  selection: OkxRouteSelection
  factory: WebSocketFactory
}

interface InternalPrivateStreamOptions extends OkxPrivateStreamOptions {
  routeCandidates: PrivateWebSocketRouteCandidate[]
  url: string
  routeProbeTimeoutMs: number
  onRouteSelected: (selection: OkxRouteSelection) => void
}

/**
 * Emits: `ready`, `orders`, `positions`, `account`, `update`, `status`, `error`.
 * The event payloads are plain OKX data arrays suitable for the main-process
 * state store. Credentials never leave the login frame created internally.
 */
export class OkxPrivateStream extends EventEmitter<OkxPrivateStreamEventMap> {
  private readonly client: OkxV5Client
  private readonly credentials: OkxCredentials
  private readonly routeCandidates: PrivateWebSocketRouteCandidate[]
  private readonly url: string
  private readonly autoReconnect: boolean
  private readonly reconnectDelayMs: number
  private readonly connectTimeoutMs: number
  private readonly heartbeatIntervalMs: number
  private readonly routeProbeTimeoutMs: number
  private readonly onRouteSelected: (selection: OkxRouteSelection) => void
  private socket?: WebSocketLike
  private manualClose = false
  private heartbeat?: NodeJS.Timeout
  private heartbeatAwaitingSince?: number
  private reconnectTimer?: NodeJS.Timeout
  private connectTimer?: NodeJS.Timeout
  private routeProbeTimer?: NodeJS.Timeout
  private activeRouteIndex = 0
  private selectedRouteIndex?: number
  private handshakeStage: OkxTransportStage = 'private_ws_connect'
  private pendingConnect?: {
    resolve: () => void
    reject: (error: Error) => void
  }
  private readonly subscribedChannels = new Set<string>()
  private readonly seenOrderKeys = new Set<string>()
  private readonly seenOrderKeyQueue: string[] = []

  constructor(
    client: OkxV5Client,
    credentials: OkxCredentials,
    options: InternalPrivateStreamOptions
  ) {
    super()
    // Error events should still be observable, but a transient network error
    // must not crash Electron merely because the UI has not attached yet.
    this.on('error', () => undefined)
    this.client = client
    this.credentials = credentials
    this.routeCandidates = options.routeCandidates
    if (this.routeCandidates.length === 0) {
      throw new OkxConfigurationError('OKX private stream has no network route')
    }
    this.url = options.url
    this.autoReconnect = options.autoReconnect ?? true
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000
    this.routeProbeTimeoutMs = options.routeProbeTimeoutMs
    this.onRouteSelected = options.onRouteSelected
  }

  async connect(): Promise<void> {
    if (this.pendingConnect) {
      throw new OkxConfigurationError('OKX private stream is already connecting')
    }
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return

    this.manualClose = false
    await this.client.ensureServerTimeSynchronized()
    return new Promise<void>((resolve, reject) => {
      this.pendingConnect = { resolve, reject }
      this.activeRouteIndex = this.selectedRouteIndex ?? 0
      this.connectTimer = setTimeout(() => {
        const selection = this.activeRouteCandidate()?.selection
        const error = new OkxTransportError({
          stage: this.handshakeStage,
          category: 'timeout',
          route: selection?.route,
          proxyProtocol: selection?.proxyProtocol
        })
        this.rejectPendingConnect(error)
        this.socket?.terminate?.()
        this.socket?.close()
      }, this.connectTimeoutMs)
      this.connectTimer.unref?.()
      this.openSocket()
    })
  }

  disconnect(): void {
    this.manualClose = true
    this.clearTimers()
    const error = new OkxApiError(
      'OKX private stream disconnected',
      'WS_DISCONNECTED'
    )
    this.rejectPendingConnect(error)
    this.socket?.close(1000, 'client disconnect')
    this.socket = undefined
    this.emit('status', 'disconnected')
  }

  private openSocket(): void {
    this.subscribedChannels.clear()
    this.handshakeStage = 'private_ws_connect'
    this.emit('status', 'connecting')
    const candidate = this.activeRouteCandidate()
    if (!candidate) {
      this.rejectPendingConnect(
        new OkxTransportError({
          stage: 'private_ws_connect',
          category: 'unknown'
        })
      )
      return
    }
    let socket: WebSocketLike
    try {
      socket = candidate.factory(this.url, { perMessageDeflate: false })
    } catch (error) {
      if (this.tryNextRoute(undefined, error)) return
      const normalized = this.transportError(error, 'private_ws_connect')
      this.rejectPendingConnect(normalized)
      this.emit('error', normalized)
      return
    }
    this.socket = socket

    socket.on('open', () => this.onOpen(socket))
    socket.on('message', (data: unknown) => this.onMessage(socket, data))
    socket.on('error', (error: unknown) => this.onError(socket, error))
    socket.on('close', (code: unknown, reason: unknown) =>
      this.onClose(socket, code, reason)
    )
    this.armRouteProbeTimeout(socket)
  }

  private onOpen(socket: WebSocketLike): void {
    if (socket !== this.socket) return
    this.clearRouteProbeTimer()
    if (this.selectedRouteIndex === undefined) {
      this.selectedRouteIndex = this.activeRouteIndex
      const selection = this.activeRouteCandidate()?.selection
      if (selection) this.onRouteSelected({ ...selection })
    }
    this.handshakeStage = 'private_ws_auth'
    this.emit('status', 'authenticating')
    const timestamp = String(Math.floor(this.client.correctedNow() / 1_000))
    this.send({
      op: 'login',
      args: [
        {
          apiKey: this.credentials.apiKey,
          passphrase: this.credentials.passphrase,
          timestamp,
          sign: createOkxWebSocketLoginSignature(
            this.credentials.secretKey,
            timestamp
          )
        }
      ]
    })
  }

  private onMessage(socket: WebSocketLike, data: unknown): void {
    if (socket !== this.socket) return
    const text = messageDataToString(data)
    if (!text) return
    this.heartbeatAwaitingSince = undefined
    if (text === 'pong') return

    let message: Record<string, unknown>
    try {
      message = JSON.parse(text) as Record<string, unknown>
    } catch {
      this.emit(
        'error',
        new OkxApiError('Invalid OKX WebSocket JSON', 'WS_INVALID_JSON')
      )
      return
    }

    const event = typeof message.event === 'string' ? message.event : undefined
    if (event === 'error') {
      const error = new OkxApiError(
        redactOkxSecrets(message.msg ?? 'OKX WebSocket error', this.credentials),
        String(message.code ?? 'WS_ERROR')
      )
      this.rejectPendingConnect(error)
      this.emit('error', error)
      return
    }
    if (event === 'login') {
      if (String(message.code ?? '') !== '0') {
        const error = new OkxApiError(
          redactOkxSecrets(
            message.msg ?? 'OKX WebSocket login failed',
            this.credentials
          ),
          String(message.code ?? 'WS_LOGIN_FAILED')
        )
        this.rejectPendingConnect(error)
        this.emit('error', error)
        this.socket?.close()
        return
      }
      this.handshakeStage = 'private_ws_subscribe'
      this.emit('status', 'subscribing')
      this.send({
        id: `sub${Date.now().toString(36)}`,
        op: 'subscribe',
        args: [
          { channel: 'orders', instType: 'SWAP' },
          { channel: 'positions', instType: 'SWAP' },
          { channel: 'account' }
        ]
      })
      return
    }
    if (event === 'subscribe') {
      const argument = message.arg as { channel?: string } | undefined
      const channel = argument?.channel
      const responseCode =
        typeof message.code === 'string' ? message.code.trim() : ''
      if (
        (responseCode !== '' && responseCode !== '0') ||
        !channel ||
        !['orders', 'positions', 'account'].includes(channel)
      ) {
        const error = new OkxApiError(
          redactOkxSecrets(
            message.msg ?? 'OKX WebSocket subscription failed',
            this.credentials
          ),
          String(message.code ?? 'WS_SUBSCRIBE_FAILED')
        )
        this.rejectPendingConnect(error)
        this.emit('error', error)
        this.socket?.close()
        return
      }
      this.subscribedChannels.add(channel)
      if (
        ['orders', 'positions', 'account'].every((channel) =>
          this.subscribedChannels.has(channel)
        )
      ) {
        this.handshakeStage = 'private_ws_subscribe'
        this.resolvePendingConnect()
        this.emit('status', 'connected')
        this.emit('ready')
        this.startHeartbeat()
      }
      return
    }

    const argument = message.arg as { channel?: string } | undefined
    const channel = argument?.channel
    const updates = Array.isArray(message.data) ? message.data : []
    if (channel === 'orders') {
      const uniqueOrders = (updates as OkxOrderUpdate[]).filter((update) =>
        this.acceptOrderUpdate(update)
      )
      if (uniqueOrders.length > 0) {
        this.emit('orders', uniqueOrders)
        this.emit('update', { channel, data: uniqueOrders })
      }
      return
    }
    if (channel === 'positions') this.emit('positions', updates as OkxPosition[])
    if (channel === 'account') this.emit('account', updates as OkxAccountUpdate[])
    if (channel === 'positions' || channel === 'account') {
      // Do not emit the raw authenticated WS envelope. Only the documented
      // channel/data contract crosses into controller/audit code.
      this.emit('update', { channel, data: updates })
    }
  }

  private acceptOrderUpdate(update: OkxOrderUpdate): boolean {
    if (!update || typeof update !== 'object') return false
    const instId = typeof update.instId === 'string' ? update.instId : ''
    const state = typeof update.state === 'string' ? update.state : ''
    const orderId =
      (typeof update.ordId === 'string' && update.ordId.trim()) ||
      (typeof update.clOrdId === 'string' && update.clOrdId.trim()) ||
      ''
    const tradeId = typeof update.tradeId === 'string'
      ? update.tradeId.trim()
      : ''
    if (tradeId) {
      if (!this.rememberOrderKey(`fill:${instId}:${tradeId}`)) return false
      // A later replay can omit tradeId while retaining the terminal state.
      // Remember both identities now so that mixed-shape duplicates cannot
      // pass through a second time; the current distinct fill is still emitted.
      if (orderId && state === 'filled') {
        this.rememberOrderKey(`filled:${instId}:${orderId}`)
      }
      if (orderId && (state === 'canceled' || state === 'mmp_canceled')) {
        this.rememberOrderKey(`terminal:${state}:${instId}:${orderId}`)
      }
      return true
    }

    if (!orderId) return true
    if (state === 'filled') {
      return this.rememberOrderKey(`filled:${instId}:${orderId}`)
    }
    if (state === 'canceled' || state === 'mmp_canceled') {
      return this.rememberOrderKey(`terminal:${state}:${instId}:${orderId}`)
    }
    return true
  }

  private rememberOrderKey(key: string): boolean {
    if (this.seenOrderKeys.has(key)) return false
    this.seenOrderKeys.add(key)
    this.seenOrderKeyQueue.push(key)
    while (this.seenOrderKeyQueue.length > MAX_PRIVATE_ORDER_DEDUP_KEYS) {
      const oldest = this.seenOrderKeyQueue.shift()
      if (oldest) this.seenOrderKeys.delete(oldest)
    }
    return true
  }

  private onError(socket: WebSocketLike, error: unknown): void {
    if (socket !== this.socket) return
    if (this.tryNextRoute(socket, error)) return
    const normalized = this.transportError(error, this.handshakeStage)
    this.rejectPendingConnect(normalized)
    this.emit('error', normalized)
  }

  private onClose(socket: WebSocketLike, code: unknown, _reason: unknown): void {
    if (socket !== this.socket) return
    if (
      this.tryNextRoute(
        socket,
        Object.assign(new Error('WebSocket closed before opening'), {
          code: typeof code === 'number' ? `WS_${code}` : 'WS_CLOSED'
        })
      )
    ) {
      return
    }
    this.stopHeartbeat()
    this.socket = undefined
    this.subscribedChannels.clear()
    const safeCode = typeof code === 'number' && Number.isInteger(code)
      ? String(code)
      : 'unknown'
    const error = new OkxApiError(
      `OKX private WebSocket closed (code ${safeCode})`,
      'WS_CLOSED'
    )
    this.rejectPendingConnect(error)
    this.emit('status', 'disconnected')

    if (!this.manualClose && this.autoReconnect && !this.reconnectTimer) {
      this.emit('status', 'reconnecting')
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined
        void this.reconnect()
      }, this.reconnectDelayMs)
      this.reconnectTimer.unref?.()
    }
  }

  private async reconnect(): Promise<void> {
    if (this.manualClose) return
    try {
      await this.client.syncServerTime()
      this.openSocket()
      this.armReconnectHandshakeTimeout()
    } catch (error) {
      const normalized = error instanceof OkxTransportError
        ? error
        : this.transportError(error, this.handshakeStage)
      this.emit(
        'error',
        normalized
      )
      if (!this.manualClose && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined
          void this.reconnect()
        }, this.reconnectDelayMs)
        this.reconnectTimer.unref?.()
      }
    }
  }

  private activeRouteCandidate(): PrivateWebSocketRouteCandidate | undefined {
    const index = this.selectedRouteIndex ?? this.activeRouteIndex
    return this.routeCandidates[index]
  }

  private tryNextRoute(socket: WebSocketLike | undefined, _error: unknown): boolean {
    if (
      this.manualClose ||
      this.selectedRouteIndex !== undefined ||
      this.activeRouteIndex + 1 >= this.routeCandidates.length
    ) {
      return false
    }
    if (socket && socket !== this.socket) return true
    this.clearRouteProbeTimer()
    if (socket) {
      this.socket = undefined
      socket.terminate?.()
      socket.close()
    }
    this.activeRouteIndex += 1
    this.openSocket()
    return true
  }

  private transportError(
    error: unknown,
    stage: OkxTransportStage
  ): OkxTransportError {
    const selection = this.activeRouteCandidate()?.selection
    return new OkxTransportError({
      stage,
      category: classifyTransportError(error),
      route: selection?.route,
      proxyProtocol: selection?.proxyProtocol
    })
  }

  private armRouteProbeTimeout(socket: WebSocketLike): void {
    this.clearRouteProbeTimer()
    if (
      this.selectedRouteIndex !== undefined ||
      this.activeRouteIndex + 1 >= this.routeCandidates.length
    ) {
      return
    }
    this.routeProbeTimer = setTimeout(() => {
      this.routeProbeTimer = undefined
      if (socket !== this.socket) return
      this.tryNextRoute(
        socket,
        Object.assign(new Error('WebSocket route probe timed out'), {
          code: 'ETIMEDOUT'
        })
      )
    }, this.routeProbeTimeoutMs)
    this.routeProbeTimer.unref?.()
  }

  private clearRouteProbeTimer(): void {
    if (this.routeProbeTimer) clearTimeout(this.routeProbeTimer)
    this.routeProbeTimer = undefined
  }

  private send(message: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new OkxApiError('OKX WebSocket is not open', 'WS_NOT_OPEN')
    }
    this.socket.send(JSON.stringify(message))
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        const now = this.client.correctedNow()
        if (
          this.heartbeatAwaitingSince !== undefined &&
          now - this.heartbeatAwaitingSince >= this.heartbeatIntervalMs
        ) {
          const error = this.transportError(
            Object.assign(new Error('OKX WebSocket heartbeat timed out'), {
              code: 'ETIMEDOUT'
            }),
            'private_ws_heartbeat'
          )
          this.emit('error', error)
          const socket = this.socket
          if (socket.terminate) socket.terminate()
          else socket.close()
          return
        }
        this.heartbeatAwaitingSince = now
        this.socket.send('ping')
      }
    }, this.heartbeatIntervalMs)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.heartbeatAwaitingSince = undefined
  }

  private clearTimers(): void {
    this.stopHeartbeat()
    this.clearRouteProbeTimer()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.reconnectTimer = undefined
    this.connectTimer = undefined
  }

  private resolvePendingConnect(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = undefined
    this.pendingConnect?.resolve()
    this.pendingConnect = undefined
  }

  private rejectPendingConnect(error: Error): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = undefined
    this.pendingConnect?.reject(error)
    this.pendingConnect = undefined
  }

  private armReconnectHandshakeTimeout(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined
      if (this.subscribedChannels.size < 3) {
        this.emit(
          'error',
          new OkxApiError(
            'OKX private WebSocket reconnect handshake timed out',
            'WS_TIMEOUT'
          )
        )
        this.socket?.terminate?.()
        this.socket?.close()
      }
    }, this.connectTimeoutMs)
    this.connectTimer.unref?.()
  }
}
