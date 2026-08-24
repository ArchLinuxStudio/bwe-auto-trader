import net, { type Server } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  NetworkDiagnosticsService,
  createNodeNetworkDiagnosticsProbes,
  runNetworkDiagnostics,
  type DetectedProxyProtocol,
  type NetworkDiagnosticsProbes,
} from '../../src/main/services/network-diagnostics'
import type { ProxySettings } from '../../src/shared/types'

const proxy: ProxySettings = { host: '127.0.0.1', port: 7890, protocol: 'auto' }
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
  vi.useRealTimers()
})

function mockProbes(overrides: Partial<NetworkDiagnosticsProbes> = {}): NetworkDiagnosticsProbes {
  return {
    checkProxyTcp: vi.fn(async () => true),
    checkProxyProtocol: vi.fn(async (_proxy, protocol) => protocol === 'socks5'),
    getDirectIp: vi.fn(async () => '203.0.113.10'),
    getProxiedIp: vi.fn(async () => '198.51.100.20'),
    checkOkxDirect: vi.fn(async () => true),
    ...overrides,
  }
}

describe('NetworkDiagnosticsService', () => {
  it('exposes the controller-friendly runNetworkDiagnostics options API', async () => {
    const probes = mockProbes()
    const result = await runNetworkDiagnostics({
      proxy,
      probes,
      timeoutMs: 200,
      now: () => 123,
    })

    expect(result).toMatchObject({
      proxyReachable: true,
      proxyProtocol: 'socks5',
      okxDirect: true,
      checkedAt: 123,
    })
  })

  it('auto-detects SOCKS5 and returns the shared NetworkDiagnostics shape', async () => {
    const probes = mockProbes()
    const service = new NetworkDiagnosticsService({
      probes,
      now: () => 1_754_960_400_000,
    })

    await expect(service.run(proxy)).resolves.toEqual({
      proxyReachable: true,
      proxyProtocol: 'socks5',
      directIp: '203.0.113.10',
      proxiedIp: '198.51.100.20',
      okxDirect: true,
      checkedAt: 1_754_960_400_000,
      detail: 'Proxy reachable via SOCKS5; optional OKX endpoint check succeeded',
    })
    expect(probes.checkProxyProtocol).toHaveBeenCalledTimes(1)
    expect(probes.checkProxyProtocol).toHaveBeenCalledWith(
      proxy,
      'socks5',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('falls back from SOCKS5 to HTTP CONNECT in auto mode', async () => {
    const attempted: DetectedProxyProtocol[] = []
    const probes = mockProbes({
      checkProxyProtocol: vi.fn(async (_proxy, protocol) => {
        attempted.push(protocol)
        return protocol === 'http'
      }),
    })

    const result = await new NetworkDiagnosticsService({ probes }).run(proxy)

    expect(attempted).toEqual(['socks5', 'http'])
    expect(result).toMatchObject({ proxyReachable: true, proxyProtocol: 'http' })
  })

  it('reports an unavailable OKX direct check only as an optional warning', async () => {
    const probes = mockProbes({ checkOkxDirect: vi.fn(async () => false) })

    const result = await new NetworkDiagnosticsService({ probes }).run(proxy)

    expect(result).toMatchObject({
      proxyReachable: true,
      proxyProtocol: 'socks5',
      directIp: '203.0.113.10',
      proxiedIp: '198.51.100.20',
      okxDirect: false,
      checkedAt: expect.any(Number),
    })
    expect(result.detail).toBe(
      'Proxy reachable via SOCKS5; Optional warning: OKX direct check returned an invalid response',
    )
    expect(probes.checkOkxDirect).toHaveBeenCalledTimes(1)
  })

  it('does not attempt a protocol or proxy-IP request when the TCP port is unreachable', async () => {
    const probes = mockProbes({ checkProxyTcp: vi.fn(async () => false) })
    const result = await new NetworkDiagnosticsService({ probes }).run(proxy)

    expect(result.proxyReachable).toBe(false)
    expect(result.proxyProtocol).toBeUndefined()
    expect(result.proxiedIp).toBeUndefined()
    expect(result.detail).toContain('Proxy TCP port is not reachable')
    expect(probes.checkProxyProtocol).not.toHaveBeenCalled()
    expect(probes.getProxiedIp).not.toHaveBeenCalled()
  })

  it('keeps partial results and redacts credentials from diagnostic errors', async () => {
    const probes = mockProbes({
      getDirectIp: vi.fn(async () => {
        throw new Error(
          'request https://alice:secret@example.test failed Proxy-Authorization: Basic abc123',
        )
      }),
      getProxiedIp: vi.fn(async () => undefined),
      checkOkxDirect: vi.fn(async () => false),
    })

    const result = await new NetworkDiagnosticsService({ probes }).run(proxy)

    expect(result).toMatchObject({
      proxyReachable: true,
      proxyProtocol: 'socks5',
      directIp: undefined,
      proxiedIp: undefined,
      okxDirect: false,
    })
    expect(result.detail).toContain('Direct IP lookup failed')
    expect(result.detail).toContain('Proxy IP lookup returned no valid IP address')
    expect(result.detail).toContain(
      'Optional warning: OKX direct check returned an invalid response',
    )
    expect(result.detail).not.toContain('alice')
    expect(result.detail).not.toContain('secret')
    expect(result.detail).not.toContain('abc123')
  })

  it('times out a probe even if an injected dependency ignores its AbortSignal', async () => {
    vi.useFakeTimers()
    const probes = mockProbes({
      getDirectIp: vi.fn(() => new Promise<string>(() => undefined)),
    })
    const pending = new NetworkDiagnosticsService({ probes }).run(proxy, { timeoutMs: 50 })

    await vi.advanceTimersByTimeAsync(50)
    const result = await pending

    expect(result.directIp).toBeUndefined()
    expect(result.detail).toContain('Direct IP lookup timed out after 50ms')
  })

  it('rejects with AbortError when the caller cancels diagnostics', async () => {
    const controller = new AbortController()
    const probes = mockProbes({
      getDirectIp: vi.fn(async ({ signal }) => {
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        return undefined
      }),
    })
    const pending = new NetworkDiagnosticsService({ probes }).run(proxy, {
      signal: controller.signal,
    })

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects credential-bearing proxy host input before starting any probe', async () => {
    const probes = mockProbes()
    const result = await new NetworkDiagnosticsService({ probes }).run({
      host: 'alice:secret@127.0.0.1',
      port: 7890,
      protocol: 'auto',
    })

    expect(result).toMatchObject({ proxyReachable: false, okxDirect: false })
    expect(result.detail).toBe('Proxy host must be a hostname or IP address without credentials')
    expect(probes.checkProxyTcp).not.toHaveBeenCalled()
  })
})

describe('Node proxy probes', () => {
  it('performs the SOCKS5 negotiation against a local TCP server', async () => {
    const server = net.createServer((socket) => {
      let stage = 0
      socket.on('data', (data) => {
        if (stage === 0) {
          expect([...data]).toEqual([0x05, 0x01, 0x00])
          stage = 1
          socket.write(Buffer.from([0x05, 0x00]))
        } else {
          expect(data[0]).toBe(0x05)
          expect(data[1]).toBe(0x01)
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]))
        }
      })
    })
    const port = await listen(server)
    const probes = createNodeNetworkDiagnosticsProbes()

    await expect(
      probes.checkProxyProtocol(
        { host: '127.0.0.1', port, protocol: 'auto' },
        'socks5',
        { signal: new AbortController().signal },
      ),
    ).resolves.toBe(true)
  })

  it('performs an HTTP CONNECT negotiation without a Proxy-Authorization header', async () => {
    let request = ''
    const server = net.createServer((socket) => {
      socket.on('data', (data) => {
        request += data.toString('latin1')
        if (request.includes('\r\n\r\n')) {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        }
      })
    })
    const port = await listen(server)
    const probes = createNodeNetworkDiagnosticsProbes()

    await expect(
      probes.checkProxyProtocol(
        { host: '127.0.0.1', port, protocol: 'auto' },
        'http',
        { signal: new AbortController().signal },
      ),
    ).resolves.toBe(true)
    expect(request).toContain('CONNECT api.ipify.org:443 HTTP/1.1')
    expect(request.toLowerCase()).not.toContain('proxy-authorization')
  })
})

function listen(server: Server): Promise<number> {
  servers.push(server)
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('Server did not bind to TCP'))
      else resolve(address.port)
    })
  })
}
