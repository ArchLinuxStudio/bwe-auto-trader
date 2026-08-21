import { Buffer } from 'node:buffer'
import https from 'node:https'
import net, { type Socket } from 'node:net'
import tls, { type TLSSocket } from 'node:tls'

import type { NetworkDiagnostics, ProxySettings } from '../../shared/types'

export type DetectedProxyProtocol = 'socks5' | 'http'

export interface NetworkDiagnosticsRunOptions {
  signal?: AbortSignal
  /** Timeout for each individual network operation. */
  timeoutMs?: number
}

export interface RunNetworkDiagnosticsOptions
  extends NetworkDiagnosticsRunOptions,
    NetworkDiagnosticsServiceOptions {
  proxy: ProxySettings
}

export interface NetworkDiagnosticsProbeContext {
  signal: AbortSignal
}

/**
 * Injectable network boundary. Tests and offline builds can replace every
 * operation without changing process-wide proxy configuration.
 */
export interface NetworkDiagnosticsProbes {
  checkProxyTcp(proxy: ProxySettings, context: NetworkDiagnosticsProbeContext): Promise<boolean>
  checkProxyProtocol(
    proxy: ProxySettings,
    protocol: DetectedProxyProtocol,
    context: NetworkDiagnosticsProbeContext,
  ): Promise<boolean>
  getDirectIp(context: NetworkDiagnosticsProbeContext): Promise<string | undefined>
  getProxiedIp(
    proxy: ProxySettings,
    protocol: DetectedProxyProtocol,
    context: NetworkDiagnosticsProbeContext,
  ): Promise<string | undefined>
  checkOkxDirect(context: NetworkDiagnosticsProbeContext): Promise<boolean>
}

export interface NetworkDiagnosticsServiceOptions {
  probes?: Partial<NetworkDiagnosticsProbes>
  timeoutMs?: number
  now?: () => number
}

interface ProbeResult<T> {
  value?: T
  error?: string
}

interface ProxyFlowResult {
  reachable: boolean
  protocol?: DetectedProxyProtocol
  ip?: string
  issue?: string
}

interface HttpResponseData {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 1024 * 1024
const IP_ENDPOINT = new URL('https://api.ipify.org/?format=json')
const OKX_TIME_ENDPOINT = new URL('https://openapi.okx.com/api/v5/public/time')

export class NetworkDiagnosticsService {
  private readonly probes: NetworkDiagnosticsProbes
  private readonly defaultTimeoutMs: number
  private readonly now: () => number

  constructor(options: NetworkDiagnosticsServiceOptions = {}) {
    const defaults = createNodeNetworkDiagnosticsProbes()
    this.probes = { ...defaults, ...options.probes }
    this.defaultTimeoutMs = normalizeTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this.now = options.now ?? Date.now
  }

  async run(
    proxy: ProxySettings,
    options: NetworkDiagnosticsRunOptions = {},
  ): Promise<NetworkDiagnostics> {
    throwIfAborted(options.signal)
    const timeoutMs = normalizeTimeout(options.timeoutMs ?? this.defaultTimeoutMs)
    const checkedAt = this.now()

    const validationIssue = validateProxySettings(proxy)
    if (validationIssue) {
      return {
        proxyReachable: false,
        okxDirect: false,
        checkedAt,
        detail: validationIssue,
      }
    }

    const directIpPromise = this.captureProbe(
      'Direct IP lookup',
      timeoutMs,
      options.signal,
      (signal) => this.probes.getDirectIp({ signal }),
    )
    const okxPromise = this.captureProbe(
      'OKX direct check',
      timeoutMs,
      options.signal,
      (signal) => this.probes.checkOkxDirect({ signal }),
    )
    const proxyPromise = this.runProxyFlow(proxy, timeoutMs, options.signal)

    const [directIp, okx, proxyResult] = await Promise.all([
      directIpPromise,
      okxPromise,
      proxyPromise,
    ])
    throwIfAborted(options.signal)

    const issues: string[] = []
    const optionalWarnings: string[] = []
    if (directIp.error) issues.push(directIp.error)
    if (!directIp.error && !directIp.value) issues.push('Direct IP lookup returned no valid IP address')
    // The OKX public endpoint is an informational, direct-path probe. Keep its
    // result in `okxDirect`, but do not present an unavailable endpoint as a
    // failure of the proxy/direct-IP diagnostics themselves.
    if (okx.error) optionalWarnings.push(`Optional warning: ${okx.error}`)
    else if (okx.value !== true) {
      optionalWarnings.push('Optional warning: OKX direct check returned an invalid response')
    }
    if (proxyResult.issue) issues.push(proxyResult.issue)

    const successSummary =
      issues.length === 0 && proxyResult.protocol
        ? `Proxy reachable via ${proxyResult.protocol.toUpperCase()}; optional OKX endpoint check succeeded`
        : undefined
    const detailParts =
      issues.length > 0
        ? [...issues, ...optionalWarnings]
        : okx.value === true
          ? successSummary
            ? [successSummary]
            : []
          : [
              ...(proxyResult.protocol
                ? [`Proxy reachable via ${proxyResult.protocol.toUpperCase()}`]
                : []),
              ...optionalWarnings,
            ]

    return {
      proxyReachable: proxyResult.reachable,
      proxyProtocol: proxyResult.protocol,
      directIp: directIp.value,
      proxiedIp: proxyResult.ip,
      okxDirect: okx.value === true,
      checkedAt,
      detail: detailParts.length > 0 ? detailParts.join('; ') : undefined,
    }
  }

  private async runProxyFlow(
    proxy: ProxySettings,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<ProxyFlowResult> {
    const tcp = await this.captureProbe('Proxy TCP check', timeoutMs, externalSignal, (signal) =>
      this.probes.checkProxyTcp(proxy, { signal }),
    )
    if (tcp.error) return { reachable: false, issue: tcp.error }
    if (tcp.value !== true) {
      return { reachable: false, issue: 'Proxy TCP port is not reachable' }
    }

    const protocols: DetectedProxyProtocol[] =
      proxy.protocol === 'auto' ? ['socks5', 'http'] : [proxy.protocol]
    const protocolErrors: string[] = []
    let detectedProtocol: DetectedProxyProtocol | undefined

    for (const protocol of protocols) {
      const probe = await this.captureProbe(
        `${protocol.toUpperCase()} proxy check`,
        timeoutMs,
        externalSignal,
        (signal) => this.probes.checkProxyProtocol(proxy, protocol, { signal }),
      )
      if (probe.value === true) {
        detectedProtocol = protocol
        break
      }
      if (probe.error) protocolErrors.push(probe.error)
    }

    if (!detectedProtocol) {
      const suffix = protocolErrors.length > 0 ? `: ${protocolErrors.join(', ')}` : ''
      return {
        reachable: true,
        issue: `Proxy port is reachable but no supported protocol was detected${suffix}`,
      }
    }

    const proxyIp = await this.captureProbe(
      'Proxy IP lookup',
      timeoutMs,
      externalSignal,
      (signal) => this.probes.getProxiedIp(proxy, detectedProtocol, { signal }),
    )

    return {
      reachable: true,
      protocol: detectedProtocol,
      ip: proxyIp.value,
      issue:
        proxyIp.error ??
        (!proxyIp.value ? 'Proxy IP lookup returned no valid IP address' : undefined),
    }
  }

  private async captureProbe<T>(
    label: string,
    timeoutMs: number,
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<ProbeResult<T>> {
    try {
      return { value: await runWithTimeout(label, timeoutMs, externalSignal, operation) }
    } catch (error) {
      if (externalSignal?.aborted) throw createAbortError(externalSignal.reason)
      return { error: `${label} failed: ${safeErrorMessage(error)}` }
    }
  }
}

export async function runNetworkDiagnostics(
  options: RunNetworkDiagnosticsOptions,
): Promise<NetworkDiagnostics> {
  const service = new NetworkDiagnosticsService(options)
  return service.run(options.proxy, options)
}

export function createNodeNetworkDiagnosticsProbes(): NetworkDiagnosticsProbes {
  return {
    async checkProxyTcp(proxy, { signal }) {
      const socket = await openTcpSocket(proxy.host, proxy.port, signal)
      socket.destroy()
      return true
    },

    async checkProxyProtocol(proxy, protocol, { signal }) {
      const socket = await openProxyTunnel(proxy, protocol, IP_ENDPOINT.hostname, 443, signal)
      socket.destroy()
      return true
    },

    async getDirectIp({ signal }) {
      const response = await directHttpsGet(IP_ENDPOINT, signal)
      return parseIpResponse(response)
    },

    async getProxiedIp(proxy, protocol, { signal }) {
      const socket = await openProxyTunnel(proxy, protocol, IP_ENDPOINT.hostname, 443, signal)
      const secureSocket = await openTlsSocket(socket, IP_ENDPOINT.hostname, signal)
      const response = await requestOverTlsSocket(secureSocket, IP_ENDPOINT, signal)
      return parseIpResponse(response)
    },

    async checkOkxDirect({ signal }) {
      // directHttpsGet uses node:https with agent:false and never consults or
      // mutates HTTP_PROXY/HTTPS_PROXY/ALL_PROXY.
      const response = await directHttpsGet(OKX_TIME_ENDPOINT, signal)
      if (response.statusCode < 200 || response.statusCode >= 300) return false
      const payload = parseJson(response.body) as {
        code?: unknown
        data?: Array<{ ts?: unknown }>
      }
      return (
        payload?.code === '0' &&
        Array.isArray(payload.data) &&
        typeof payload.data[0]?.ts === 'string' &&
        /^\d{10,}$/.test(payload.data[0].ts)
      )
    },
  }
}

async function runWithTimeout<T>(
  label: string,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfAborted(externalSignal)
  const controller = new AbortController()
  let timedOut = false
  let abortExternal: (() => void) | undefined

  if (externalSignal) {
    abortExternal = () => controller.abort(externalSignal.reason)
    externalSignal.addEventListener('abort', abortExternal, { once: true })
  }

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DiagnosticsTimeoutError(label, timeoutMs))
  }, timeoutMs)
  timer.unref?.()

  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(controller.signal.reason ?? createAbortError()),
      { once: true },
    )
  })

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      aborted,
    ])
  } catch (error) {
    if (externalSignal?.aborted) throw createAbortError(externalSignal.reason)
    if (timedOut) throw new DiagnosticsTimeoutError(label, timeoutMs)
    throw error
  } finally {
    clearTimeout(timer)
    if (externalSignal && abortExternal) {
      externalSignal.removeEventListener('abort', abortExternal)
    }
  }
}

class DiagnosticsTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`)
    this.name = 'TimeoutError'
  }
}

async function openProxyTunnel(
  proxy: ProxySettings,
  protocol: DetectedProxyProtocol,
  destinationHost: string,
  destinationPort: number,
  signal: AbortSignal,
): Promise<Socket> {
  return protocol === 'socks5'
    ? openSocks5Tunnel(proxy, destinationHost, destinationPort, signal)
    : openHttpConnectTunnel(proxy, destinationHost, destinationPort, signal)
}

async function openSocks5Tunnel(
  proxy: ProxySettings,
  destinationHost: string,
  destinationPort: number,
  signal: AbortSignal,
): Promise<Socket> {
  const socket = await openTcpSocket(proxy.host, proxy.port, signal)
  const reader = new BufferedSocketReader(socket, signal)
  try {
    socket.write(Buffer.from([0x05, 0x01, 0x00]))
    const greeting = await reader.readExactly(2)
    if (greeting[0] !== 0x05 || greeting[1] !== 0x00) {
      throw new Error('SOCKS5 no-authentication handshake was rejected')
    }

    const hostname = Buffer.from(destinationHost, 'utf8')
    if (hostname.length === 0 || hostname.length > 255) {
      throw new Error('SOCKS5 destination hostname is invalid')
    }
    const request = Buffer.alloc(7 + hostname.length)
    request.set([0x05, 0x01, 0x00, 0x03, hostname.length], 0)
    hostname.copy(request, 5)
    request.writeUInt16BE(destinationPort, 5 + hostname.length)
    socket.write(request)

    const response = await reader.readExactly(4)
    if (response[0] !== 0x05 || response[1] !== 0x00 || response[2] !== 0x00) {
      throw new Error(`SOCKS5 CONNECT was rejected with code ${response[1] ?? 'unknown'}`)
    }
    const addressType = response[3]
    if (addressType === undefined) throw new Error('SOCKS5 response omitted its address type')
    await consumeSocksAddress(reader, addressType)
    reader.release()
    return socket
  } catch (error) {
    reader.dispose()
    socket.destroy()
    throw error
  }
}

async function consumeSocksAddress(reader: BufferedSocketReader, addressType: number): Promise<void> {
  if (addressType === 0x01) await reader.readExactly(4)
  else if (addressType === 0x04) await reader.readExactly(16)
  else if (addressType === 0x03) {
    const length = (await reader.readExactly(1))[0]
    if (length === undefined) throw new Error('SOCKS5 response omitted its domain length')
    await reader.readExactly(length)
  } else {
    throw new Error(`SOCKS5 returned an unsupported address type ${addressType}`)
  }
  await reader.readExactly(2)
}

async function openHttpConnectTunnel(
  proxy: ProxySettings,
  destinationHost: string,
  destinationPort: number,
  signal: AbortSignal,
): Promise<Socket> {
  const socket = await openTcpSocket(proxy.host, proxy.port, signal)
  const reader = new BufferedSocketReader(socket, signal)
  const authority = formatAuthority(destinationHost, destinationPort)
  try {
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: Keep-Alive\r\n\r\n`,
    )
    const header = (await reader.readUntil(Buffer.from('\r\n\r\n'), 64 * 1024)).toString('latin1')
    const statusLine = header.split('\r\n', 1)[0] ?? ''
    if (!/^HTTP\/\d(?:\.\d)?\s+2\d\d(?:\s|$)/i.test(statusLine)) {
      throw new Error(`HTTP CONNECT was rejected (${sanitizeHttpStatus(statusLine)})`)
    }
    reader.release()
    return socket
  } catch (error) {
    reader.dispose()
    socket.destroy()
    throw error
  }
}

function openTcpSocket(host: string, port: number, signal: AbortSignal): Promise<Socket> {
  throwIfAborted(signal)
  return new Promise<Socket>((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    let settled = false

    const cleanup = (): void => {
      socket.off('connect', onConnect)
      socket.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onConnect = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(socket)
    }
    const onError = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(error)
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(createAbortError(signal.reason))
    }

    socket.once('connect', onConnect)
    socket.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function openTlsSocket(socket: Socket, hostname: string, signal: AbortSignal): Promise<TLSSocket> {
  throwIfAborted(signal)
  return new Promise<TLSSocket>((resolve, reject) => {
    const secureSocket = tls.connect({ socket, servername: hostname })
    let settled = false

    const cleanup = (): void => {
      secureSocket.off('secureConnect', onSecureConnect)
      secureSocket.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onSecureConnect = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(secureSocket)
    }
    const onError = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      secureSocket.destroy()
      reject(error)
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      secureSocket.destroy()
      reject(createAbortError(signal.reason))
    }

    secureSocket.once('secureConnect', onSecureConnect)
    secureSocket.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function requestOverTlsSocket(
  socket: TLSSocket,
  url: URL,
  signal: AbortSignal,
): Promise<HttpResponseData> {
  const path = `${url.pathname}${url.search}`
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: application/json,text/plain\r\nConnection: close\r\n\r\n`,
  )
  const raw = await collectSocket(socket, signal)
  return parseRawHttpResponse(raw)
}

function directHttpsGet(url: URL, signal: AbortSignal): Promise<HttpResponseData> {
  throwIfAborted(signal)
  return new Promise<HttpResponseData>((resolve, reject) => {
    const request = https.request(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        headers: {
          accept: 'application/json,text/plain',
          connection: 'close',
          'user-agent': 'BWE-Auto-Trader/0.1 network-diagnostics',
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buffer.length
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('HTTPS response exceeded the size limit'))
            return
          }
          chunks.push(buffer)
        })
        response.once('end', () => {
          cleanup()
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          })
        })
        response.once('error', onError)
      },
    )

    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onAbort = (): void => {
      request.destroy(createAbortError(signal.reason))
    }
    request.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    request.end()
  })
}

function collectSocket(socket: Socket, signal: AbortSignal): Promise<Buffer> {
  throwIfAborted(signal)
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0

    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('close', onClose)
      socket.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onData = (chunk: Buffer): void => {
      size += chunk.length
      if (size > MAX_RESPONSE_BYTES) {
        onError(new Error('HTTPS response exceeded the size limit'))
        socket.destroy()
        return
      }
      chunks.push(chunk)
    }
    const finish = (): void => {
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    const onEnd = (): void => finish()
    const onClose = (): void => finish()
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onAbort = (): void => {
      cleanup()
      socket.destroy()
      reject(createAbortError(signal.reason))
    }

    socket.on('data', onData)
    socket.once('end', onEnd)
    socket.once('close', onClose)
    socket.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

class BufferedSocketReader {
  private buffer = Buffer.alloc(0)
  private waiter?: { resolve: () => void; reject: (error: Error) => void }
  private terminalError?: Error
  private released = false

  constructor(
    private readonly socket: Socket,
    private readonly signal: AbortSignal,
  ) {
    throwIfAborted(signal)
    socket.on('data', this.onData)
    socket.once('error', this.onError)
    socket.once('close', this.onClose)
    signal.addEventListener('abort', this.onAbort, { once: true })
  }

  async readExactly(size: number): Promise<Buffer> {
    while (this.buffer.length < size) await this.waitForData()
    return this.consume(size)
  }

  async readUntil(delimiter: Buffer, maxBytes: number): Promise<Buffer> {
    while (true) {
      const index = this.buffer.indexOf(delimiter)
      if (index >= 0) return this.consume(index + delimiter.length)
      if (this.buffer.length > maxBytes) throw new Error('Proxy response headers are too large')
      await this.waitForData()
    }
  }

  release(): void {
    if (this.released) return
    const remainder = this.buffer
    this.buffer = Buffer.alloc(0)
    this.detach()
    if (remainder.length > 0) this.socket.unshift(remainder)
  }

  dispose(): void {
    if (this.released) return
    this.buffer = Buffer.alloc(0)
    this.detach()
  }

  private detach(): void {
    this.released = true
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onError)
    this.socket.off('close', this.onClose)
    this.signal.removeEventListener('abort', this.onAbort)
    this.rejectWaiter(new Error('Socket reader was released'))
  }

  private consume(size: number): Buffer {
    const value = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    return value
  }

  private waitForData(): Promise<void> {
    if (this.buffer.length > 0) return Promise.resolve()
    if (this.terminalError) return Promise.reject(this.terminalError)
    if (this.waiter) return Promise.reject(new Error('Concurrent socket reads are not supported'))
    return new Promise<void>((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  private wakeWaiter(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.resolve()
  }

  private rejectWaiter(error: Error): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.reject(error)
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.wakeWaiter()
  }

  private readonly onError = (error: Error): void => {
    this.terminalError = error
    this.rejectWaiter(error)
  }

  private readonly onClose = (): void => {
    const error = new Error('Proxy socket closed unexpectedly')
    this.terminalError = error
    this.rejectWaiter(error)
  }

  private readonly onAbort = (): void => {
    const error = createAbortError(this.signal.reason)
    this.terminalError = error
    this.socket.destroy()
    this.rejectWaiter(error)
  }
}

function parseRawHttpResponse(raw: Buffer): HttpResponseData {
  const boundary = raw.indexOf('\r\n\r\n')
  if (boundary < 0) throw new Error('HTTPS response omitted its headers')
  const headerText = raw.subarray(0, boundary).toString('latin1')
  const lines = headerText.split('\r\n')
  const statusLine = lines.shift() ?? ''
  const statusCode = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1] ?? 0)
  if (!statusCode) throw new Error('HTTPS response had an invalid status line')

  const headers: Record<string, string> = {}
  for (const line of lines) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
  }
  let body = raw.subarray(boundary + 4)
  if (/\bchunked\b/i.test(headers['transfer-encoding'] ?? '')) body = decodeChunkedBody(body)
  return { statusCode, headers, body }
}

function decodeChunkedBody(input: Buffer): Buffer {
  const chunks: Buffer[] = []
  let offset = 0
  while (offset < input.length) {
    const lineEnd = input.indexOf('\r\n', offset)
    if (lineEnd < 0) throw new Error('Chunked HTTPS response is truncated')
    const sizeText = input.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0]?.trim() ?? ''
    const size = Number.parseInt(sizeText, 16)
    if (!Number.isFinite(size) || size < 0) throw new Error('Chunked HTTPS response is invalid')
    offset = lineEnd + 2
    if (size === 0) break
    if (offset + size + 2 > input.length) throw new Error('Chunked HTTPS response is truncated')
    chunks.push(input.subarray(offset, offset + size))
    offset += size + 2
  }
  return Buffer.concat(chunks)
}

function parseIpResponse(response: HttpResponseData): string | undefined {
  if (response.statusCode < 200 || response.statusCode >= 300) return undefined
  const text = response.body.toString('utf8').trim()
  let candidate = text
  try {
    const json = JSON.parse(text) as { ip?: unknown }
    if (typeof json.ip === 'string') candidate = json.ip.trim()
  } catch {
    // The endpoint may return a plain-text IP.
  }
  return net.isIP(candidate) ? candidate : undefined
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
}

function validateProxySettings(proxy: ProxySettings): string | undefined {
  if (!proxy || typeof proxy.host !== 'string' || !proxy.host.trim()) {
    return 'Proxy host is required'
  }
  if (/\s|@|:\/\//.test(proxy.host)) {
    return 'Proxy host must be a hostname or IP address without credentials'
  }
  if (!Number.isSafeInteger(proxy.port) || proxy.port < 1 || proxy.port > 65_535) {
    return 'Proxy port must be between 1 and 65535'
  }
  if (!['auto', 'socks5', 'http'].includes(proxy.protocol)) {
    return 'Proxy protocol must be auto, socks5, or http'
  }
  return undefined
}

function normalizeTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new TypeError('Network diagnostics timeoutMs must be a positive number')
  }
  return Math.floor(value)
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/(proxy-authorization\s*:\s*)([^\r\n]+)/gi, '$1[redacted]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=_-]+/gi, 'Basic [redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300)
}

function sanitizeHttpStatus(statusLine: string): string {
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+([^\r\n]{0,80}))?/i.exec(statusLine)
  return match ? `${match[1]}${match[2] ? ` ${match[2]}` : ''}` : 'invalid response'
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal.reason)
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  const error = new Error(reason instanceof Error ? reason.message : 'The operation was aborted')
  error.name = 'AbortError'
  return error
}

function formatAuthority(host: string, port: number): string {
  return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`
}
