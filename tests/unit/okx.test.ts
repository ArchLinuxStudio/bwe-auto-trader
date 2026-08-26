import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  OKX_PRODUCTION_REST_URL,
  OkxLiveTradingNotArmedError,
  OkxOrderStateUnknownError,
  OkxOrderSizeError,
  OkxEndpointSecurityError,
  OkxProxyHttpsAgent,
  OkxTransportError,
  OkxTradeOperationInProgressError,
  OkxV5Client,
  calculateUsdtSwapOrderSize,
  createOkxRestSignature,
  createOkxWebSocketLoginSignature,
  okxPositionsToAppPositions,
  type FetchLike,
  type OkxMutationLifecycleEvent
} from '../../src/main/services/okx'
import type {
  OkxWebSocketOptions,
  WebSocketLike
} from '../../src/main/services/okx'

const credentials = {
  apiKey: 'test-api-key',
  secretKey: 'test-secret-key',
  passphrase: 'test-passphrase'
}

function okJson(data: unknown[]): Response {
  return new Response(JSON.stringify({ code: '0', msg: '', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

interface TradingHarnessOptions {
  now?: () => number
  onTime?: () => Response | Promise<Response>
  onPositions?: () => Response | Promise<Response>
  onPendingOrders?: (url: URL) => Response | Promise<Response>
  onPendingAlgoOrders?: (url: URL) => Response | Promise<Response>
  onSetLeverage?: (init: RequestInit | undefined) => Response | Promise<Response>
  onOrder?: (
    url: URL,
    init: RequestInit | undefined,
    body: Record<string, unknown>
  ) => Response | Promise<Response>
  onMutationLifecycle?: (
    event: Readonly<OkxMutationLifecycleEvent>
  ) => void | Promise<void>
}

function createTradingHarness(options: TradingHarnessOptions = {}): {
  client: OkxV5Client
  fetchImpl: ReturnType<typeof vi.fn<FetchLike>>
} {
  const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
    const url = new URL(input)
    if (url.pathname === '/api/v5/public/time') {
      return options.onTime?.() ?? okJson([{ ts: String(options.now?.() ?? Date.now()) }])
    }
    if (url.pathname === '/api/v5/account/config') {
      return okJson([
        {
          acctLv: '2',
          posMode: 'net_mode',
          perm: 'read_only,trade',
          type: '1',
          ip: '127.0.0.1'
        }
      ])
    }
    if (url.pathname === '/api/v5/trade/orders-pending') {
      return options.onPendingOrders?.(url) ?? okJson([])
    }
    if (url.pathname === '/api/v5/trade/orders-algo-pending') {
      return options.onPendingAlgoOrders?.(url) ?? okJson([])
    }
    if (url.pathname === '/api/v5/account/positions') {
      return options.onPositions?.() ?? okJson([])
    }
    if (url.pathname === '/api/v5/public/instruments') {
      return okJson([
        {
          instType: 'SWAP',
          instId: 'BTC-USDT-SWAP',
          settleCcy: 'USDT',
          ctType: 'linear',
          ctVal: '0.001',
          ctMult: '1',
          ctValCcy: 'BTC',
          lotSz: '0.1',
          minSz: '0.1',
          maxMktSz: '100000',
          state: 'live'
        }
      ])
    }
    if (url.pathname === '/api/v5/market/ticker') {
      return okJson([
        {
          instType: 'SWAP',
          instId: 'BTC-USDT-SWAP',
          last: '50000',
          askPx: '50000',
          bidPx: '50000',
          ts: String(options.now?.() ?? Date.now())
        }
      ])
    }
    if (url.pathname === '/api/v5/account/set-leverage') {
      return options.onSetLeverage?.(init) ?? okJson([
        { instId: 'BTC-USDT-SWAP', lever: '1', mgnMode: 'isolated' }
      ])
    }
    if (url.pathname === '/api/v5/trade/order') {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {}
      if (options.onOrder) return options.onOrder(url, init, body)
      return okJson([
        {
          ordId: '123456789',
          clOrdId: body.clOrdId,
          sCode: '0',
          sMsg: ''
        }
      ])
    }
    throw new Error(`Unexpected test request: ${url.pathname}`)
  })
  return {
    client: new OkxV5Client({
      credentials,
      fetchImpl,
      allowCustomEndpointsForTesting: true,
      now: options.now,
      randomId: () => 'abcdef0123456789',
      onMutationLifecycle: options.onMutationLifecycle
    }),
    fetchImpl
  }
}

describe('OKX signatures', () => {
  it('signs the exact timestamp + method + path/query + body prehash', () => {
    const timestamp = '2020-12-08T09:08:57.715Z'
    const path = '/api/v5/account/balance?ccy=BTC'
    const body = ''
    const expected = createHmac('sha256', credentials.secretKey)
      .update(`${timestamp}GET${path}${body}`)
      .digest('base64')

    expect(
      createOkxRestSignature(
        credentials.secretKey,
        timestamp,
        'get',
        path,
        body
      )
    ).toBe(expected)
  })

  it('uses the OKX private websocket login prehash', () => {
    const timestamp = '1597026383'
    const expected = createHmac('sha256', credentials.secretKey)
      .update(`${timestamp}GET/users/self/verify`)
      .digest('base64')

    expect(
      createOkxWebSocketLoginSignature(credentials.secretKey, timestamp)
    ).toBe(expected)
  })
})

describe('production endpoint security', () => {
  it('rejects an injected transport unless explicit test mode is enabled', () => {
    const fetchImpl = vi.fn<FetchLike>()
    expect(
      () => new OkxV5Client({ credentials, fetchImpl })
    ).toThrow(OkxEndpointSecurityError)
  })

  it('does not reject construction when Node environment-proxy routing is enabled', () => {
    const previous = process.env.NODE_USE_ENV_PROXY
    process.env.NODE_USE_ENV_PROXY = '1'
    try {
      expect(() => new OkxV5Client({ credentials })).not.toThrow()
    } finally {
      if (previous === undefined) delete process.env.NODE_USE_ENV_PROXY
      else process.env.NODE_USE_ENV_PROXY = previous
    }
  })

  it('keeps production REST and WebSocket endpoints fixed to the official hosts', () => {
    expect(OKX_PRODUCTION_REST_URL).toBe('https://openapi.okx.com')
    expect(
      () =>
        new OkxV5Client({
          credentials,
          restBaseUrl: 'https://example.com',
          privateWebSocketUrl: 'wss://example.com/ws/v5/private'
        })
    ).toThrow(OkxEndpointSecurityError)
  })

  it('selects the injected direct REST transport with a credential-free probe', async () => {
    const previous = process.env.NODE_USE_ENV_PROXY
    process.env.NODE_USE_ENV_PROXY = '1'
    const fetchImpl = vi.fn<FetchLike>(async () =>
      okJson([{ ts: String(Date.now()) }])
    )
    try {
      const client = new OkxV5Client({
        credentials,
        fetchImpl,
        allowCustomEndpointsForTesting: true
      })
      await expect(client.syncServerTime()).resolves.toEqual(expect.any(Number))
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(client.restRouteSelection).toEqual({ route: 'direct' })
    } finally {
      if (previous === undefined) delete process.env.NODE_USE_ENV_PROXY
      else process.env.NODE_USE_ENV_PROXY = previous
    }
  })
})

describe('fixed OKX REST route selection', () => {
  const proxy = { host: '127.0.0.1', port: 7890, protocol: 'http' as const }

  it('preserves the inherited HTTPS agent protocol when a proxy protocol is selected', () => {
    const agent = new OkxProxyHttpsAgent(proxy, 'socks5', 1_000)
    expect((agent as unknown as { protocol: string }).protocol).toBe('https:')
    agent.destroy()
  })

  it('falls back only during the public-time probe and then locks the proxy route', async () => {
    const directFetch = vi.fn<FetchLike>(async () => {
      throw Object.assign(new Error(`getaddrinfo ${credentials.apiKey}`), {
        code: 'ENOTFOUND'
      })
    })
    const proxyFetch = vi.fn<FetchLike>(async (input) => {
      const path = new URL(input).pathname
      if (path === '/api/v5/public/time') {
        return okJson([{ ts: String(Date.now()) }])
      }
      if (path === '/api/v5/account/config') {
        return okJson([
          {
            acctLv: '2',
            posMode: 'net_mode',
            perm: 'read_only,trade',
            type: '1',
            ip: '127.0.0.1'
          }
        ])
      }
      if (path === '/api/v5/trade/orders-pending') return okJson([])
      if (path === '/api/v5/trade/orders-algo-pending') return okJson([])
      throw new Error(`Unexpected test request: ${path}`)
    })
    const client = new OkxV5Client({
      credentials,
      proxy,
      fetchImpl: directFetch,
      proxyFetchImpl: proxyFetch,
      allowCustomEndpointsForTesting: true
    })

    await expect(client.verifyAccountConfiguration()).resolves.toMatchObject({
      ok: true
    })
    expect(client.restRouteSelection).toEqual({
      route: 'proxy',
      proxyProtocol: 'http'
    })
    expect(directFetch).toHaveBeenCalledOnce()
    const paths = proxyFetch.mock.calls.map(([input]) => new URL(input).pathname)
    expect(paths.filter((path) => path === '/api/v5/public/time')).toHaveLength(2)
    expect(paths.filter((path) => path === '/api/v5/account/config')).toHaveLength(1)
    expect(paths.filter((path) => path === '/api/v5/trade/orders-pending')).toHaveLength(1)
    expect(
      paths.filter((path) => path === '/api/v5/trade/orders-algo-pending')
    ).toHaveLength(7)
  })

  it('never retries a failed authenticated request across routes after direct is selected', async () => {
    const secretBearingFailure = Object.assign(
      new Error(
        `getaddrinfo ENOTFOUND ${credentials.apiKey} OK-ACCESS-SIGN=${credentials.secretKey}`
      ),
      { code: 'ENOTFOUND' }
    )
    const directFetch = vi.fn<FetchLike>(async (input) => {
      const path = new URL(input).pathname
      if (path === '/api/v5/public/time') {
        return okJson([{ ts: String(Date.now()) }])
      }
      if (path === '/api/v5/account/positions') throw secretBearingFailure
      throw new Error(`Unexpected test request: ${path}`)
    })
    const proxyFetch = vi.fn<FetchLike>()
    const client = new OkxV5Client({
      credentials,
      proxy,
      fetchImpl: directFetch,
      proxyFetchImpl: proxyFetch,
      allowCustomEndpointsForTesting: true
    })
    await client.syncServerTime()

    const failure = await client.getPositions().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(OkxTransportError)
    expect(failure).toMatchObject({
      stage: 'positions',
      category: 'dns',
      route: 'direct',
      code: 'TRANSPORT_ERROR'
    })
    expect(String((failure as Error).message)).not.toContain(credentials.apiKey)
    expect(String((failure as Error).message)).not.toContain(credentials.secretKey)
    expect(proxyFetch).not.toHaveBeenCalled()
    expect(client.restRouteSelection).toEqual({ route: 'direct' })
  })

  it('reports the actual proxy protocol when every route probe fails', async () => {
    const directFetch = vi.fn<FetchLike>(async () => {
      throw Object.assign(new Error('direct timeout'), { code: 'ETIMEDOUT' })
    })
    const proxyFetch = vi.fn<FetchLike>(async () => {
      throw Object.assign(new Error('proxy timeout'), { code: 'ETIMEDOUT' })
    })
    const client = new OkxV5Client({
      credentials,
      proxy,
      fetchImpl: directFetch,
      proxyFetchImpl: proxyFetch,
      allowCustomEndpointsForTesting: true
    })

    const failure = await client.syncServerTime().catch((error: unknown) => error)
    expect(failure).toMatchObject({
      stage: 'public_time',
      category: 'timeout',
      route: 'proxy',
      proxyProtocol: 'http'
    })
    expect(client.restRouteSelection).toBeUndefined()
  })
})

describe('USDT swap quantity conversion', () => {
  it('rounds contract count down to lotSz without exceeding the target', () => {
    const result = calculateUsdtSwapOrderSize({
      targetNotionalUsdt: 10,
      price: '61234.56',
      contractValue: '0.01',
      lotSize: '0.01',
      minimumSize: '0.01'
    })

    expect(result.contracts).toBe('0.01')
    expect(result.estimatedNotionalUsdt).toBeCloseTo(6.123456, 8)
    expect(result.estimatedNotionalUsdt).toBeLessThanOrEqual(10)
  })

  it('handles very small decimal lot sizes without floating-point rounding up', () => {
    const result = calculateUsdtSwapOrderSize({
      targetNotionalUsdt: 10,
      price: '0.123456789',
      contractValue: '1',
      lotSize: '0.001',
      minimumSize: '0.001'
    })

    expect(result.contracts).toBe('81')
    expect(result.estimatedNotionalUsdt).toBeCloseTo(9.999999909, 9)
  })

  it('refuses to increase the order to satisfy the exchange minimum', () => {
    expect(() =>
      calculateUsdtSwapOrderSize({
        targetNotionalUsdt: 10,
        price: '70000',
        contractValue: '0.01',
        lotSize: '1',
        minimumSize: '1'
      })
    ).toThrow(OkxOrderSizeError)
  })

  it('includes the OKX contract multiplier in contract sizing', () => {
    const result = calculateUsdtSwapOrderSize({
      targetNotionalUsdt: 100,
      price: '10',
      contractValue: '0.5',
      contractMultiplier: '2',
      lotSize: '1',
      minimumSize: '1'
    })

    expect(result).toMatchObject({
      contracts: '10',
      estimatedNotionalUsdt: 100,
      contractMultiplier: '2'
    })
  })

  it('rejects a target above maxMktSz instead of silently capping it', () => {
    expect(() =>
      calculateUsdtSwapOrderSize({
        targetNotionalUsdt: 110,
        price: '10',
        contractValue: '1',
        contractMultiplier: '1',
        lotSize: '1',
        minimumSize: '1',
        maximumMarketSize: '10'
      })
    ).toThrow('maximum market-order size')
  })
})

describe('position conversion', () => {
  it('maps signed net swap positions into renderer-safe app positions', () => {
    const snapshot = okxPositionsToAppPositions(
      [
        {
          instType: 'SWAP',
          instId: 'ETH-USDT-SWAP',
          posSide: 'net',
          pos: '-2',
          mgnMode: 'isolated',
          avgPx: '3500',
          markPx: '3400',
          upl: '2',
          uplRatio: '0.01',
          lever: '1',
          uTime: '1754960400000'
        }
      ],
      [
        {
          instType: 'SWAP',
          instId: 'ETH-USDT-SWAP',
          ctVal: '0.01',
          ctMult: '2',
          lotSz: '1',
          minSz: '1',
          state: 'live'
        }
      ]
    )

    expect(snapshot.warnings).toEqual([])
    expect(snapshot.positions[0]).toMatchObject({
      instrumentId: 'ETH-USDT-SWAP',
      direction: 'short',
      contracts: 2,
      notionalUsd: 136,
      unrealizedPnlPercent: 1,
      marginMode: 'isolated'
    })
  })
})

describe('live trading interlock', () => {
  it('normalizes OKX permission strings and arrays without false Withdraw detection', async () => {
    const permissionShapes: Array<string | string[]> = [
      'read_only,trade',
      ' READ_ONLY ， TRADE ',
      ['read_only', 'trade'],
      '["read_only", "trade"]'
    ]

    for (const perm of permissionShapes) {
      const fetchImpl = vi.fn<FetchLike>(async (input) => {
        const url = new URL(input)
        if (url.pathname === '/api/v5/public/time') {
          return okJson([{ ts: '1754960400000' }])
        }
        if (url.pathname === '/api/v5/account/config') {
          return okJson([{ acctLv: '2', posMode: 'net_mode', perm, type: '1', ip: 'x' }])
        }
        if (url.pathname === '/api/v5/trade/orders-pending') return okJson([])
        if (url.pathname === '/api/v5/trade/orders-algo-pending') return okJson([])
        throw new Error(`Unexpected test request: ${url.pathname}`)
      })
      const client = new OkxV5Client({
        credentials,
        fetchImpl,
        allowCustomEndpointsForTesting: true,
        now: () => 1_754_960_400_000
      })

      await expect(client.verifyAccountConfiguration()).resolves.toMatchObject({
        ok: true,
        checks: {
          hasReadPermission: true,
          hasTradePermission: true,
          hasNoWithdrawPermission: true
        },
        errors: []
      })
    }
  })

  it('reports Withdraw permission as a non-blocking warning', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = new URL(input)
      if (url.pathname === '/api/v5/public/time') {
        return okJson([{ ts: '1754960400000' }])
      }
      if (url.pathname === '/api/v5/account/config') {
        return okJson([
          {
            acctLv: '2',
            posMode: 'net_mode',
            perm: 'read_only,trade,withdraw',
            type: '1',
            ip: 'x'
          }
        ])
      }
      if (url.pathname === '/api/v5/trade/orders-pending') return okJson([])
      if (url.pathname === '/api/v5/trade/orders-algo-pending') return okJson([])
      throw new Error(`Unexpected test request: ${url.pathname}`)
    })
    const client = new OkxV5Client({
      credentials,
      fetchImpl,
      allowCustomEndpointsForTesting: true,
      now: () => 1_754_960_400_000
    })

    await expect(client.verifyAccountConfiguration()).resolves.toMatchObject({
      ok: true,
      checks: { hasNoWithdrawPermission: false },
      errors: [],
      warnings: [expect.stringContaining('Withdraw permission')]
    })
  })

  it('treats an API key IP allowlist as optional during account verification', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = new URL(input)
      if (url.pathname === '/api/v5/public/time') {
        return okJson([{ ts: '1754960400000' }])
      }
      if (url.pathname === '/api/v5/account/config') {
        return okJson([
          {
            acctLv: '2',
            posMode: 'net_mode',
            perm: 'read_only,trade',
            type: '1',
            ip: ''
          }
        ])
      }
      if (url.pathname === '/api/v5/trade/orders-pending') return okJson([])
      if (url.pathname === '/api/v5/trade/orders-algo-pending') return okJson([])
      throw new Error(`Unexpected test request: ${url.pathname}`)
    })
    const client = new OkxV5Client({
      credentials,
      fetchImpl,
      allowCustomEndpointsForTesting: true,
      now: () => 1_754_960_400_000
    })

    await expect(client.verifyAccountConfiguration()).resolves.toMatchObject({
      ok: true,
      errors: [],
      warnings: [expect.stringContaining('IP binding')]
    })
  })

  it('defaults to disarmed and rejects an order before making any request', async () => {
    const fetchImpl = vi.fn<FetchLike>()
    const client = new OkxV5Client({
      credentials,
      fetchImpl,
      allowCustomEndpointsForTesting: true
    })

    expect(client.isLiveTradingArmed).toBe(false)
    await expect(
      client.placeMarketOrder({
        symbolOrInstId: 'BTC',
        direction: 'LONG',
        targetNotionalUsdt: 10,
        arm: undefined as never
      })
    ).rejects.toBeInstanceOf(OkxLiveTradingNotArmedError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('requires a matching single-use arm and never reuses it', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
      const url = new URL(input)
      if (url.pathname === '/api/v5/trade/orders-pending') return okJson([])
      if (url.pathname === '/api/v5/trade/orders-algo-pending') return okJson([])
      if (url.pathname === '/api/v5/public/time') {
        return okJson([{ ts: '1754960400000' }])
      }
      if (url.pathname === '/api/v5/account/config') {
        return okJson([
          {
            acctLv: '2',
            posMode: 'net_mode',
            perm: 'read_only,trade',
            type: '1',
            ip: '203.0.113.10'
          }
        ])
      }
      if (url.pathname === '/api/v5/account/positions') {
        return okJson([])
      }
      if (url.pathname === '/api/v5/public/instruments') {
        return okJson([
          {
            instType: 'SWAP',
            instId: 'BTC-USDT-SWAP',
            settleCcy: 'USDT',
            ctType: 'linear',
            ctVal: '0.001',
            lotSz: '0.1',
            minSz: '0.1',
            state: 'live'
          }
        ])
      }
      if (url.pathname === '/api/v5/market/ticker') {
        return okJson([
          {
            instType: 'SWAP',
            instId: 'BTC-USDT-SWAP',
            last: '50000',
            ts: '1754960400000'
          }
        ])
      }
      if (url.pathname === '/api/v5/account/set-leverage') {
        expect(init?.method).toBe('POST')
        expect((init?.headers as Record<string, string>)?.expTime).toBeUndefined()
        expect(JSON.parse(String(init?.body))).toEqual({
          instId: 'BTC-USDT-SWAP',
          lever: '1',
          mgnMode: 'isolated'
        })
        return okJson([
          {
            instId: 'BTC-USDT-SWAP',
            lever: '1',
            mgnMode: 'isolated'
          }
        ])
      }
      if (url.pathname === '/api/v5/trade/order') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect((init?.headers as Record<string, string>)?.expTime).toBe(
          '1754960405000'
        )
        expect(body).toMatchObject({
          instId: 'BTC-USDT-SWAP',
          tdMode: 'isolated',
          side: 'buy',
          posSide: 'net',
          ordType: 'market',
          sz: '0.2'
        })
        expect(String(body.clOrdId)).toMatch(/^bwe[a-zA-Z0-9]+$/)
        return okJson([
          {
            ordId: '123456789',
            clOrdId: body.clOrdId,
            sCode: '0',
            sMsg: ''
          }
        ])
      }
      throw new Error(`Unexpected test request: ${url.pathname}`)
    })
    const client = new OkxV5Client({
      credentials,
      fetchImpl,
      allowCustomEndpointsForTesting: true,
      now: () => 1_754_960_400_000,
      randomId: () => 'abcdef0123456789'
    })
    await expect(client.verifyAccountConfiguration()).resolves.toMatchObject({
      ok: true
    })
    fetchImpl.mockClear()
    client.setLiveTradingArmed(true)
    const wrongScope = client.armNextLiveTrade('close')

    await expect(
      client.placeMarketOrder({
        symbolOrInstId: 'BTC',
        direction: 'LONG',
        arm: wrongScope
      })
    ).rejects.toBeInstanceOf(OkxLiveTradingNotArmedError)
    expect(fetchImpl).not.toHaveBeenCalled()

    const arm = client.armNextLiveTrade('open')
    const result = await client.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm
    })
    expect(result).toMatchObject({
      ordId: '123456789',
      contracts: '0.2',
      leverage: '1',
      executionState: 'pending_confirmation'
    })

    await expect(
      client.placeMarketOrder({
        symbolOrInstId: 'BTC',
        direction: 'LONG',
        arm
      })
    ).rejects.toBeInstanceOf(OkxLiveTradingNotArmedError)
  })

  it('disarming invalidates an already issued arm', async () => {
    const fetchImpl = vi.fn<FetchLike>()
    const client = new OkxV5Client({
      credentials,
      fetchImpl,
      allowCustomEndpointsForTesting: true
    })
    client.setLiveTradingArmed(true)
    const arm = client.armNextLiveTrade('open')
    client.setLiveTradingArmed(false)

    await expect(
      client.placeMarketOrder({
        symbolOrInstId: 'BTC',
        direction: 'LONG',
        arm
      })
    ).rejects.toBeInstanceOf(OkxLiveTradingNotArmedError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('blocks an armed opening request until account verification succeeds', async () => {
    const fetchImpl = vi.fn<FetchLike>()
    const client = new OkxV5Client({
      credentials,
      fetchImpl,
      allowCustomEndpointsForTesting: true
    })
    client.setLiveTradingArmed(true)
    const arm = client.armNextLiveTrade('open')

    await expect(
      client.placeMarketOrder({
        symbolOrInstId: 'BTC',
        direction: 'LONG',
        arm
      })
    ).rejects.toThrow('Verify the OKX API permissions')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails verification when the sub-account has an unfinished SWAP order', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = new URL(input)
      if (url.pathname === '/api/v5/public/time') {
        return okJson([{ ts: String(Date.now()) }])
      }
      if (url.pathname === '/api/v5/account/config') {
        return okJson([
          { acctLv: '2', posMode: 'net_mode', perm: 'read_only,trade', type: '1', ip: 'x' }
        ])
      }
      if (url.pathname === '/api/v5/trade/orders-pending') {
        return okJson([
          {
            instType: 'SWAP', instId: 'BTC-USDT-SWAP', ordId: 'pending1',
            clOrdId: 'manual1', state: 'live'
          }
        ])
      }
      if (url.pathname === '/api/v5/trade/orders-algo-pending') return okJson([])
      throw new Error(`Unexpected test request: ${url.pathname}`)
    })
    const client = new OkxV5Client({
      credentials,
      fetchImpl,
      allowCustomEndpointsForTesting: true
    })
    const verification = await client.verifyAccountConfiguration()
    expect(verification.ok).toBe(false)
    expect(verification.checks.hasNoPendingSwapOrders).toBe(false)
    expect(verification.pendingSwapOrders).toHaveLength(1)
    expect(verification.errors.join(' ')).toContain('unfinished SWAP')
  })

  it('re-checks pending SWAP orders immediately before opening', async () => {
    let pendingChecks = 0
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = new URL(input)
      if (url.pathname === '/api/v5/public/time') return okJson([{ ts: String(Date.now()) }])
      if (url.pathname === '/api/v5/account/config') {
        return okJson([
          { acctLv: '2', posMode: 'net_mode', perm: 'read_only,trade', type: '1', ip: 'x' }
        ])
      }
      if (url.pathname === '/api/v5/trade/orders-pending') {
        pendingChecks += 1
        return pendingChecks === 1
          ? okJson([])
          : okJson([
              {
                instType: 'SWAP', instId: 'ETH-USDT-SWAP', ordId: 'pending2',
                clOrdId: 'manual2', state: 'partially_filled'
              }
            ])
      }
      if (url.pathname === '/api/v5/trade/orders-algo-pending') return okJson([])
      if (url.pathname === '/api/v5/public/instruments') {
        return okJson([
          {
            instType: 'SWAP', instId: 'BTC-USDT-SWAP', settleCcy: 'USDT',
            ctType: 'linear', ctVal: '0.001', lotSz: '0.1', minSz: '0.1', state: 'live'
          }
        ])
      }
      if (url.pathname === '/api/v5/market/ticker') {
        return okJson([{ instType: 'SWAP', instId: 'BTC-USDT-SWAP', last: '50000', ts: '1' }])
      }
      if (url.pathname === '/api/v5/account/positions') return okJson([])
      if (url.pathname === '/api/v5/trade/order') throw new Error('must not submit')
      throw new Error(`Unexpected test request: ${url.pathname}`)
    })
    const client = new OkxV5Client({
      credentials,
      fetchImpl,
      allowCustomEndpointsForTesting: true
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)
    await expect(
      client.placeMarketOrder({
        symbolOrInstId: 'BTC',
        direction: 'LONG',
        arm: client.armNextLiveTrade('open')
      })
    ).rejects.toThrow('unfinished SWAP orders')
    expect(
      fetchImpl.mock.calls.some(
        ([input]) => new URL(input).pathname === '/api/v5/trade/order'
      )
    ).toBe(false)
  })

  it('queries every documented pending algo type with the required SWAP scope', async () => {
    const { client, fetchImpl } = createTradingHarness()

    await expect(client.getPendingAlgoOrders()).resolves.toEqual([])

    const urls = fetchImpl.mock.calls
      .map(([input]) => new URL(input))
      .filter((url) => url.pathname === '/api/v5/trade/orders-algo-pending')
    expect(urls).toHaveLength(7)
    expect(urls.map((url) => url.searchParams.get('ordType')).sort()).toEqual([
      'chase',
      'conditional,oco',
      'iceberg',
      'move_order_stop',
      'smart_iceberg',
      'trigger',
      'twap'
    ])
    for (const url of urls) {
      expect(url.searchParams.get('instType')).toBe('SWAP')
      expect(url.searchParams.get('limit')).toBe('100')
    }
  })

  it('fails account verification when an untriggered SWAP strategy order exists', async () => {
    const { client } = createTradingHarness({
      onPendingAlgoOrders: (url) =>
        url.searchParams.get('ordType') === 'smart_iceberg'
          ? okJson([
              {
                instType: 'SWAP',
                instId: 'BTC-USDT-SWAP',
                algoId: 'algo-1',
                ordType: 'smart_iceberg',
                state: 'live'
              }
            ])
          : okJson([])
    })

    const verification = await client.verifyAccountConfiguration()

    expect(verification.ok).toBe(false)
    expect(verification.checks.hasNoPendingSwapOrders).toBe(false)
    expect(verification.checks.hasNoPendingSwapAlgoOrders).toBe(false)
    expect(verification.pendingSwapAlgoOrders).toHaveLength(1)
    expect(verification.errors.join(' ')).toContain('untriggered SWAP strategy')
  })

  it('re-checks pending SWAP strategy orders immediately before opening', async () => {
    let smartIcebergChecks = 0
    const { client, fetchImpl } = createTradingHarness({
      onPendingAlgoOrders: (url) => {
        if (url.searchParams.get('ordType') !== 'smart_iceberg') return okJson([])
        smartIcebergChecks += 1
        return smartIcebergChecks === 1
          ? okJson([])
          : okJson([
              {
                instType: 'SWAP',
                instId: 'ETH-USDT-SWAP',
                algoId: 'algo-2',
                ordType: 'smart_iceberg',
                state: 'live'
              }
            ])
      }
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)

    await expect(client.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm: client.armNextLiveTrade('open')
    })).rejects.toThrow('untriggered SWAP strategy orders')
    expect(
      fetchImpl.mock.calls.some(
        ([input, init]) =>
          new URL(input).pathname === '/api/v5/trade/order' &&
          init?.method === 'POST'
      )
    ).toBe(false)
  })

  it('maps pending algo transport failures to their own fail-closed stage', async () => {
    const { client } = createTradingHarness({
      onPendingAlgoOrders: (url) => {
        if (url.searchParams.get('ordType') === 'trigger') {
          throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
        }
        return okJson([])
      }
    })

    await expect(client.verifyAccountConfiguration()).rejects.toMatchObject({
      name: 'OkxTransportError',
      stage: 'pending_algo_orders',
      category: 'connection'
    })
  })

  it('does not ignore an algo type rejected by the account API', async () => {
    const { client } = createTradingHarness({
      onPendingAlgoOrders: (url) =>
        url.searchParams.get('ordType') === 'smart_iceberg'
          ? new Response(JSON.stringify({
              code: '51000',
              msg: 'Parameter ordType error',
              data: []
            }), { status: 200 })
          : okJson([])
    })

    await expect(client.verifyAccountConfiguration()).rejects.toMatchObject({
      code: '51000'
    })
  })

  it('fails closed when a pending algo response reaches the 100-order page limit', async () => {
    const { client } = createTradingHarness({
      onPendingAlgoOrders: (url) =>
        url.searchParams.get('ordType') === 'trigger'
          ? okJson(Array.from({ length: 100 }, (_, index) => ({
              instType: 'SWAP',
              instId: 'BTC-USDT-SWAP',
              algoId: `algo-${index}`,
              ordType: 'trigger',
              state: 'live'
            })))
          : okJson([])
    })

    await expect(client.verifyAccountConfiguration()).rejects.toThrow(
      'at least 100 pending trigger SWAP strategy orders'
    )
  })

  it('rejects concurrent mutation even when each call has a distinct arm', async () => {
    let releasePositions!: () => void
    const positionsGate = new Promise<void>((resolve) => {
      releasePositions = resolve
    })
    const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
      const url = new URL(input)
      if (url.pathname === '/api/v5/trade/orders-pending') return okJson([])
      if (url.pathname === '/api/v5/trade/orders-algo-pending') return okJson([])
      if (url.pathname === '/api/v5/public/time') {
        return okJson([{ ts: '1754960400000' }])
      }
      if (url.pathname === '/api/v5/account/config') {
        return okJson([
          {
            acctLv: '2',
            posMode: 'net_mode',
            perm: 'read_only,trade',
            type: '1',
            ip: '203.0.113.10'
          }
        ])
      }
      if (url.pathname === '/api/v5/public/instruments') {
        return okJson([
          {
            instType: 'SWAP',
            instId: 'BTC-USDT-SWAP',
            settleCcy: 'USDT',
            ctType: 'linear',
            ctVal: '0.001',
            lotSz: '0.1',
            minSz: '0.1',
            state: 'live'
          }
        ])
      }
      if (url.pathname === '/api/v5/market/ticker') {
        return okJson([
          {
            instType: 'SWAP',
            instId: 'BTC-USDT-SWAP',
            last: '50000',
            ts: '1754960400000'
          }
        ])
      }
      if (url.pathname === '/api/v5/account/positions') {
        await positionsGate
        return okJson([])
      }
      if (url.pathname === '/api/v5/account/set-leverage') return okJson([])
      if (url.pathname === '/api/v5/trade/order') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return okJson([
          { ordId: '1', clOrdId: body.clOrdId, sCode: '0', sMsg: '' }
        ])
      }
      throw new Error(`Unexpected test request: ${url.pathname}`)
    })
    const client = new OkxV5Client({
      credentials,
      fetchImpl,
      allowCustomEndpointsForTesting: true
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)
    const first = client.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm: client.armNextLiveTrade('open')
    })
    await vi.waitFor(() => {
      expect(
        fetchImpl.mock.calls.some(
          ([input]) => new URL(input).pathname === '/api/v5/account/positions'
        )
      ).toBe(true)
    })

    await expect(
      client.placeMarketOrder({
        symbolOrInstId: 'BTC',
        direction: 'LONG',
        arm: client.armNextLiveTrade('open')
      })
    ).rejects.toBeInstanceOf(OkxTradeOperationInProgressError)
    releasePositions()
    await expect(first).resolves.toMatchObject({ ordId: '1' })
  })

  it('re-checks live generation after leverage and before order transmission', async () => {
    let client!: OkxV5Client
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = new URL(input)
      if (url.pathname === '/api/v5/trade/orders-pending') return okJson([])
      if (url.pathname === '/api/v5/trade/orders-algo-pending') return okJson([])
      if (url.pathname === '/api/v5/public/time') {
        return okJson([{ ts: '1754960400000' }])
      }
      if (url.pathname === '/api/v5/account/config') {
        return okJson([
          { acctLv: '2', posMode: 'net_mode', perm: 'read_only,trade', type: '1', ip: 'x' }
        ])
      }
      if (url.pathname === '/api/v5/public/instruments') {
        return okJson([
          {
            instType: 'SWAP', instId: 'BTC-USDT-SWAP', settleCcy: 'USDT',
            ctType: 'linear', ctVal: '0.001', lotSz: '0.1', minSz: '0.1', state: 'live'
          }
        ])
      }
      if (url.pathname === '/api/v5/market/ticker') {
        return okJson([{ instType: 'SWAP', instId: 'BTC-USDT-SWAP', last: '50000', ts: '1' }])
      }
      if (url.pathname === '/api/v5/account/positions') return okJson([])
      if (url.pathname === '/api/v5/account/set-leverage') {
        client.setLiveTradingArmed(false)
        return okJson([])
      }
      if (url.pathname === '/api/v5/trade/order') throw new Error('must not send')
      throw new Error(`Unexpected test request: ${url.pathname}`)
    })
    client = new OkxV5Client({
      credentials,
      fetchImpl,
      allowCustomEndpointsForTesting: true
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)

    await expect(
      client.placeMarketOrder({
        symbolOrInstId: 'BTC',
        direction: 'LONG',
        arm: client.armNextLiveTrade('open')
      })
    ).rejects.toBeInstanceOf(OkxLiveTradingNotArmedError)
    expect(
      fetchImpl.mock.calls.some(
        ([input]) => new URL(input).pathname === '/api/v5/trade/order'
      )
    ).toBe(false)
  })

  it('uses the prepare entry time as the absolute intent deadline', async () => {
    let now = 1_754_960_400_000
    const { client, fetchImpl } = createTradingHarness({
      now: () => now,
      onSetLeverage: () => {
        now += 101
        return okJson([
          { instId: 'BTC-USDT-SWAP', lever: '1', mgnMode: 'isolated' }
        ])
      }
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)
    const intent = await client.prepareMarketOrder(
      { symbolOrInstId: 'BTC', direction: 'LONG' },
      100
    )

    await expect(client.submitPreparedMarketOrder({
      intent,
      arm: client.armNextLiveTrade('open')
    })).rejects.toBeInstanceOf(OkxLiveTradingNotArmedError)
    expect(
      fetchImpl.mock.calls.some(
        ([input, init]) =>
          new URL(input).pathname === '/api/v5/trade/order' &&
          init?.method === 'POST'
      )
    ).toBe(false)
    expect(client.requiresOrderReconciliation).toBe(false)
  })

  it('caps OKX expTime at the prepared intent deadline', async () => {
    const now = 1_754_960_400_000
    let submittedExpTime = ''
    const { client } = createTradingHarness({
      now: () => now,
      onOrder: (_url, init, body) => {
        submittedExpTime = (init?.headers as Record<string, string>).expTime ?? ''
        return okJson([
          {
            ordId: 'deadline-order',
            clOrdId: body.clOrdId,
            sCode: '0',
            sMsg: ''
          }
        ])
      }
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)
    const intent = await client.prepareMarketOrder(
      { symbolOrInstId: 'BTC', direction: 'LONG' },
      2_000
    )

    await expect(client.submitPreparedMarketOrder({
      intent,
      arm: client.armNextLiveTrade('open')
    })).resolves.toMatchObject({ executionState: 'pending_confirmation' })
    expect(submittedExpTime).toBe(String(now + 2_000))
  })

  it('runs the application transmission guard at the final order POST boundary', async () => {
    const { client, fetchImpl } = createTradingHarness()
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)
    const intent = await client.prepareMarketOrder(
      { symbolOrInstId: 'BTC', direction: 'LONG' },
      2_000
    )
    let guardCalls = 0

    await expect(client.submitPreparedMarketOrder({
      intent,
      arm: client.armNextLiveTrade('open'),
      transmissionGuard: () => {
        guardCalls += 1
        // Initial submit, preview entry, account-query completion,
        // leverage beforeFetch/after, and pre-order time sync all pass. The
        // seventh call is request()'s last synchronous boundary before POST.
        if (guardCalls >= 7) throw new Error('Telegram revision changed')
      }
    })).rejects.toBeInstanceOf(OkxLiveTradingNotArmedError)

    expect(guardCalls).toBeGreaterThanOrEqual(7)
    expect(
      fetchImpl.mock.calls.some(
        ([input, init]) =>
          new URL(input).pathname === '/api/v5/account/set-leverage' &&
          init?.method === 'POST'
      )
    ).toBe(true)
    expect(
      fetchImpl.mock.calls.some(
        ([input, init]) =>
          new URL(input).pathname === '/api/v5/trade/order' &&
          init?.method === 'POST'
      )
    ).toBe(false)
    expect(client.requiresOrderReconciliation).toBe(false)
  })

  it('awaits the durable transmission marker and then rechecks the final guard before POST', async () => {
    let releaseTransmission!: () => void
    const transmissionGate = new Promise<void>((resolve) => {
      releaseTransmission = resolve
    })
    const events: OkxMutationLifecycleEvent[] = []
    const harness = createTradingHarness({
      onMutationLifecycle: async (event) => {
        events.push({ ...event })
        if (event.phase === 'transmitting') await transmissionGate
      }
    })
    await harness.client.verifyAccountConfiguration()
    harness.client.setLiveTradingArmed(true)
    const intent = await harness.client.prepareMarketOrder(
      { symbolOrInstId: 'BTC', direction: 'LONG' },
      2_000
    )

    const submission = harness.client.submitPreparedMarketOrder({
      intent,
      arm: harness.client.armNextLiveTrade('open')
    })
    await vi.waitFor(() => {
      expect(events.map((event) => event.phase)).toContain('transmitting')
    })
    expect(
      harness.fetchImpl.mock.calls.some(
        ([input]) => new URL(input).pathname === '/api/v5/trade/order'
      )
    ).toBe(false)

    harness.client.setLiveTradingArmed(false)
    releaseTransmission()
    await expect(submission).rejects.toBeInstanceOf(OkxLiveTradingNotArmedError)
    expect(events.map((event) => event.phase)).toEqual([
      'prepared',
      'transmitting',
      'terminal'
    ])
    expect(events.at(-1)).toMatchObject({
      terminalEvidence: 'not_transmitted'
    })
    expect(
      harness.fetchImpl.mock.calls.some(
        ([input]) => new URL(input).pathname === '/api/v5/trade/order'
      )
    ).toBe(false)
  })

  it('persists prepared, transmitting, and ACK evidence before returning success', async () => {
    const now = 1_754_960_400_000
    const events: OkxMutationLifecycleEvent[] = []
    const { client } = createTradingHarness({
      now: () => now,
      onMutationLifecycle: (event) => {
        expect(Object.isFrozen(event)).toBe(true)
        events.push({ ...event })
      }
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)

    await expect(client.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm: client.armNextLiveTrade('open')
    })).resolves.toMatchObject({ ordId: '123456789' })

    expect(events.map((event) => event.phase)).toEqual([
      'prepared',
      'transmitting',
      'accepted'
    ])
    expect(events[0]).toMatchObject({
      operation: 'open',
      instId: 'BTC-USDT-SWAP',
      clOrdId: expect.stringMatching(/^bwe/)
    })
    expect(events[1]).toMatchObject({ exchangeExpiresAt: now + 5_000 })
    expect(events[2]).toMatchObject({ ordId: '123456789' })
  })

  it('keeps the durable precommit and marks unknown after an ambiguous POST', async () => {
    const events: OkxMutationLifecycleEvent[] = []
    const { client } = createTradingHarness({
      onOrder: () => {
        throw new Error('socket reset after write')
      },
      onMutationLifecycle: (event) => {
        events.push({ ...event })
      }
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)

    await expect(client.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm: client.armNextLiveTrade('open')
    })).rejects.toBeInstanceOf(OkxOrderStateUnknownError)
    expect(events.map((event) => event.phase)).toEqual([
      'prepared',
      'transmitting',
      'unknown'
    ])
  })

  it('records a definitive exchange rejection as terminal instead of unknown', async () => {
    const events: OkxMutationLifecycleEvent[] = []
    const { client } = createTradingHarness({
      onOrder: (_url, _init, body) => okJson([{
        ordId: '',
        clOrdId: body.clOrdId,
        sCode: '51000',
        sMsg: 'Parameter error'
      }]),
      onMutationLifecycle: (event) => {
        events.push({ ...event })
      }
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)

    await expect(client.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm: client.armNextLiveTrade('open')
    })).rejects.toThrow('Parameter error')
    expect(events.map((event) => event.phase)).toEqual([
      'prepared',
      'transmitting',
      'terminal'
    ])
    expect(events.at(-1)).toMatchObject({ terminalEvidence: 'rejected' })
    expect(client.requiresOrderReconciliation).toBe(false)
  })

  it('re-checks emergency disarm after a last-moment time sync and before fetch', async () => {
    let now = 1_754_960_400_000
    let timeRequests = 0
    let client!: OkxV5Client
    const harness = createTradingHarness({
      now: () => now,
      onTime: () => {
        timeRequests += 1
        if (timeRequests >= 3) client.setLiveTradingArmed(false)
        return okJson([{ ts: String(now) }])
      },
      onSetLeverage: () => {
        // Moving the injected clock backwards forces submitIdentifiedOrder to
        // resynchronize after leverage, while the arm itself is still valid.
        now -= 1_000
        return okJson([
          { instId: 'BTC-USDT-SWAP', lever: '1', mgnMode: 'isolated' }
        ])
      }
    })
    client = harness.client
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)

    await expect(client.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm: client.armNextLiveTrade('open')
    })).rejects.toBeInstanceOf(OkxLiveTradingNotArmedError)
    expect(timeRequests).toBeGreaterThanOrEqual(3)
    expect(
      harness.fetchImpl.mock.calls.some(
        ([input, init]) =>
          new URL(input).pathname === '/api/v5/trade/order' &&
          init?.method === 'POST'
      )
    ).toBe(false)
    expect(client.requiresOrderReconciliation).toBe(false)
  })

  it('blocks retry after an ambiguous order transport failure', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = new URL(input)
      if (url.pathname === '/api/v5/trade/orders-pending') return okJson([])
      if (url.pathname === '/api/v5/trade/orders-algo-pending') return okJson([])
      if (url.pathname === '/api/v5/public/time') return okJson([{ ts: String(Date.now()) }])
      if (url.pathname === '/api/v5/account/config') {
        return okJson([
          { acctLv: '2', posMode: 'net_mode', perm: 'read_only,trade', type: '1', ip: 'x' }
        ])
      }
      if (url.pathname === '/api/v5/public/instruments') {
        return okJson([
          {
            instType: 'SWAP', instId: 'BTC-USDT-SWAP', settleCcy: 'USDT',
            ctType: 'linear', ctVal: '0.001', lotSz: '0.1', minSz: '0.1', state: 'live'
          }
        ])
      }
      if (url.pathname === '/api/v5/market/ticker') {
        return okJson([{ instType: 'SWAP', instId: 'BTC-USDT-SWAP', last: '50000', ts: '1' }])
      }
      if (url.pathname === '/api/v5/account/positions') return okJson([])
      if (url.pathname === '/api/v5/account/set-leverage') return okJson([])
      if (url.pathname === '/api/v5/trade/order') {
        throw new Error(
          `socket failed ${credentials.apiKey} ${credentials.secretKey} ${credentials.passphrase}`
        )
      }
      throw new Error(`Unexpected test request: ${url.pathname}`)
    })
    const client = new OkxV5Client({
      credentials,
      fetchImpl,
      allowCustomEndpointsForTesting: true
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)

    const firstError = await client
      .placeMarketOrder({
        symbolOrInstId: 'BTC',
        direction: 'LONG',
        arm: client.armNextLiveTrade('open')
      })
      .catch((error: unknown) => error)
    expect(firstError).toBeInstanceOf(OkxOrderStateUnknownError)
    expect(String(firstError)).not.toContain(credentials.apiKey)
    expect(String(firstError)).not.toContain(credentials.secretKey)
    expect(String(firstError)).not.toContain(credentials.passphrase)
    expect(client.requiresOrderReconciliation).toBe(true)

    await expect(
      client.placeMarketOrder({
        symbolOrInstId: 'BTC',
        direction: 'LONG',
        arm: client.armNextLiveTrade('open')
      })
    ).rejects.toThrow('unknown state')
  })

  it('interlocks transient HTTP, invalid JSON, and malformed successful acknowledgements', async () => {
    const cases: Array<[
      string,
      (body: Record<string, unknown>) => Response
    ]> = [
      ['HTTP 408', () => new Response('gateway timeout', { status: 408 })],
      ['HTTP 429', () => new Response('rate limited', { status: 429 })],
      ['HTTP 503', () => new Response('upstream unavailable', { status: 503 })],
      ['invalid JSON', () => new Response('<html>', { status: 200 })],
      ['empty acknowledgement', () => okJson([])],
      [
        'mismatched acknowledgement',
        () => okJson([{ ordId: '123', clOrdId: 'different', sCode: '0', sMsg: '' }])
      ],
      [
        'empty order ID',
        (body) => okJson([{ ordId: '', clOrdId: body.clOrdId, sCode: '0', sMsg: '' }])
      ]
    ]

    for (const [label, response] of cases) {
      const { client } = createTradingHarness({
        onOrder: (_url, _init, body) => response(body)
      })
      await client.verifyAccountConfiguration()
      client.setLiveTradingArmed(true)
      const error = await client.placeMarketOrder({
        symbolOrInstId: 'BTC',
        direction: 'LONG',
        arm: client.armNextLiveTrade('open')
      }).catch((caught: unknown) => caught)

      expect(error, label).toBeInstanceOf(OkxOrderStateUnknownError)
      expect(error, label).toMatchObject({ operation: 'open' })
      expect(client.requiresOrderReconciliation, label).toBe(true)
    }
  })

  it('does not interlock a place order that OKX explicitly rejects with sCode', async () => {
    const { client } = createTradingHarness({
      onOrder: (_url, _init, body) => okJson([
        {
          ordId: '',
          clOrdId: body.clOrdId,
          sCode: '51008',
          sMsg: 'Insufficient balance'
        }
      ])
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)

    await expect(client.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm: client.armNextLiveTrade('open')
    })).rejects.toMatchObject({ code: '51008' })
    expect(client.requiresOrderReconciliation).toBe(false)
  })

  it('treats a parsed OKX business error as definitive but an unparsed HTTP error as ambiguous', async () => {
    const parsed = createTradingHarness({
      onOrder: () => new Response(
        JSON.stringify({ code: '51000', msg: 'Parameter error', data: [] }),
        { status: 400 }
      )
    }).client
    await parsed.verifyAccountConfiguration()
    parsed.setLiveTradingArmed(true)
    await expect(parsed.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm: parsed.armNextLiveTrade('open')
    })).rejects.toMatchObject({ code: '51000' })
    expect(parsed.requiresOrderReconciliation).toBe(false)

    const unparsed = createTradingHarness({
      onOrder: () => new Response('<html>', { status: 400 })
    }).client
    await unparsed.verifyAccountConfiguration()
    unparsed.setLiveTradingArmed(true)
    await expect(unparsed.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm: unparsed.armNextLiveTrade('open')
    })).rejects.toBeInstanceOf(OkxOrderStateUnknownError)
    expect(unparsed.requiresOrderReconciliation).toBe(true)
  })

  it('reconciles an unknown order by clOrdId without mutating exchange state', async () => {
    let client!: OkxV5Client
    let unknownError!: OkxOrderStateUnknownError
    let orderSubmissionFailed = false
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = new URL(input)
      if (url.pathname === '/api/v5/public/time') return okJson([{ ts: String(Date.now()) }])
      if (url.pathname === '/api/v5/account/config') {
        return okJson([
          { acctLv: '2', posMode: 'net_mode', perm: 'read_only,trade', type: '1', ip: 'x' }
        ])
      }
      if (url.pathname === '/api/v5/trade/orders-pending') return okJson([])
      if (url.pathname === '/api/v5/trade/orders-algo-pending') return okJson([])
      if (url.pathname === '/api/v5/public/instruments') {
        return okJson([
          {
            instType: 'SWAP', instId: 'BTC-USDT-SWAP', settleCcy: 'USDT',
            ctType: 'linear', ctVal: '0.001', lotSz: '0.1', minSz: '0.1', state: 'live'
          }
        ])
      }
      if (url.pathname === '/api/v5/market/ticker') {
        return okJson([{ instType: 'SWAP', instId: 'BTC-USDT-SWAP', last: '50000', ts: '1' }])
      }
      if (url.pathname === '/api/v5/account/positions') return okJson([])
      if (url.pathname === '/api/v5/account/set-leverage') return okJson([])
      if (url.pathname === '/api/v5/trade/order' && !orderSubmissionFailed) {
        orderSubmissionFailed = true
        throw new Error('socket closed after write')
      }
      if (url.pathname === '/api/v5/trade/order') {
        expect(url.searchParams.get('clOrdId')).toBe(unknownError.clOrdId)
        return okJson([
          {
            instType: 'SWAP', instId: 'BTC-USDT-SWAP', ordId: 'found1',
            clOrdId: unknownError.clOrdId, state: 'filled'
          }
        ])
      }
      throw new Error(`Unexpected test request: ${url.pathname}`)
    })
    client = new OkxV5Client({
      credentials,
      fetchImpl,
      allowCustomEndpointsForTesting: true
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)
    unknownError = (await client
      .placeMarketOrder({
        symbolOrInstId: 'BTC',
        direction: 'LONG',
        arm: client.armNextLiveTrade('open')
      })
      .catch((error: unknown) => error)) as OkxOrderStateUnknownError

    const reconciliation = await client.reconcileUnknownOrder(unknownError)
    expect(reconciliation).toMatchObject({
      safeToClear: true,
      order: { ordId: 'found1', state: 'filled' },
      positions: []
    })
    expect(client.requiresOrderReconciliation).toBe(true)
    client.confirmOrderReconciled()
    expect(client.requiresOrderReconciliation).toBe(false)
  })

  it('cannot clear or swap the reconciliation identity before read-only evidence is conclusive', async () => {
    let now = 1_754_960_400_000
    const { client } = createTradingHarness({
      now: () => now,
      onOrder: (_url, init) => {
        if (init?.method === 'POST') throw new Error('socket closed after write')
        return new Response(
          JSON.stringify({ code: '51603', msg: 'Order does not exist', data: [] }),
          { status: 200 }
        )
      }
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)
    const unknown = await client.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm: client.armNextLiveTrade('open')
    }).catch((caught: unknown) => caught) as OkxOrderStateUnknownError

    expect(() => client.confirmOrderReconciled()).toThrow('not been safely reconciled')
    await expect(client.reconcileUnknownOrder(
      new OkxOrderStateUnknownError(unknown.instId, unknown.clOrdId)
    )).rejects.toThrow('does not identify')
    await expect(client.reconcileUnknownOrder(unknown)).resolves.toMatchObject({
      safeToClear: false
    })
    expect(() => client.confirmOrderReconciled()).toThrow('not been safely reconciled')

    now += 30_000
    await expect(client.reconcileUnknownOrder(unknown)).resolves.toMatchObject({
      safeToClear: true,
      positions: []
    })
    client.confirmOrderReconciled()
    expect(client.requiresOrderReconciliation).toBe(false)
  })

  it('keeps the unknown interlock when exact order details are malformed after the absence window', async () => {
    let now = 1_754_960_400_000
    let unknown!: OkxOrderStateUnknownError
    const { client } = createTradingHarness({
      now: () => now,
      onOrder: (_url, init) => {
        if (init?.method === 'POST') throw new Error('socket closed after write')
        return okJson([{
          instType: 'SWAP',
          instId: 'ETH-USDT-SWAP',
          ordId: 'conflictingorder',
          clOrdId: unknown.clOrdId,
          state: 'filled'
        }])
      }
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)
    unknown = await client.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm: client.armNextLiveTrade('open')
    }).catch((caught: unknown) => caught) as OkxOrderStateUnknownError

    now += 30_000
    await expect(client.reconcileUnknownOrder(unknown)).rejects.toMatchObject({
      code: 'INVALID_ORDER_DETAILS'
    })
    expect(() => client.confirmOrderReconciled()).toThrow('not been safely reconciled')
  })

  it('keeps the unknown interlock when the pending-order snapshot is malformed or incomplete', async () => {
    let now = 1_754_960_400_000
    let submissionFailed = false
    const { client } = createTradingHarness({
      now: () => now,
      onPendingOrders: (url) => {
        expect(url.searchParams.get('limit')).toBe('100')
        return submissionFailed
          ? okJson([{
              instType: 'SWAP',
              instId: 'not-an-instrument',
              ordId: 'malformedpendingorder',
              clOrdId: 'malformedpending',
              state: 'mystery'
            }])
          : okJson([])
      },
      onOrder: (_url, init) => {
        if (init?.method === 'POST') {
          submissionFailed = true
          throw new Error('socket closed after write')
        }
        return new Response(
          JSON.stringify({ code: '51603', msg: 'Order does not exist', data: [] }),
          { status: 200 }
        )
      }
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)
    const unknown = await client.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm: client.armNextLiveTrade('open')
    }).catch((caught: unknown) => caught) as OkxOrderStateUnknownError

    now += 30_000
    await expect(client.reconcileUnknownOrder(unknown)).rejects.toMatchObject({
      code: 'INVALID_PENDING_ORDER'
    })
    expect(() => client.confirmOrderReconciled()).toThrow('not been safely reconciled')
  })

  it('keeps an unknown close interlocked when position evidence is malformed', async () => {
    let submitted = false
    const { client } = createTradingHarness({
      onPositions: () => okJson([{
        instType: 'SWAP',
        instId: 'BTC-USDT-SWAP',
        posSide: 'net',
        pos: submitted ? '0x0' : '2',
        mgnMode: 'isolated'
      }]),
      onOrder: (_url, init) => {
        if (init?.method === 'POST') {
          submitted = true
          throw new Error('socket closed after write')
        }
        return new Response(
          JSON.stringify({ code: '51603', msg: 'Order does not exist', data: [] }),
          { status: 200 }
        )
      }
    })
    client.setLiveTradingArmed(true)
    const unknown = await client.closeEntirePosition({
      instId: 'BTC-USDT-SWAP',
      arm: client.armNextLiveTrade('close')
    }).catch((caught: unknown) => caught) as OkxOrderStateUnknownError

    await expect(client.reconcileUnknownOrder(unknown)).rejects.toMatchObject({
      code: 'INVALID_SWAP_POSITION'
    })
    expect(() => client.confirmOrderReconciled()).toThrow('not been safely reconciled')
  })

  it('refuses to treat a full ordinary pending-order page as complete', async () => {
    const pending = Array.from({ length: 100 }, (_, index) => ({
      instType: 'SWAP',
      instId: 'BTC-USDT-SWAP',
      ordId: `pendingorder${index}`,
      clOrdId: `pendingclient${index}`,
      state: 'live'
    }))
    const { client } = createTradingHarness({
      onPendingOrders: () => okJson(pending)
    })

    await expect(client.verifyAccountConfiguration()).rejects.toThrow(
      'at least 100 pending SWAP orders'
    )
  })

  it('fails closed on malformed positions before an opening order can reach POST', async () => {
    const malformedPositions = [
      {
        instType: 'SWAP', instId: 'BTC-USDT-SWAP', posSide: 'net',
        pos: '0x0', mgnMode: 'isolated'
      },
      {
        instType: 'SWAP', instId: 'BTC-USDT-SWAP', posSide: 'hedged',
        pos: '0', mgnMode: 'isolated'
      },
      {
        instType: 'SWAP', instId: 'BTC-USDT-SWAP', posSide: 'net',
        pos: '0', mgnMode: 'portfolio'
      },
      {
        instType: 'SWAP', instId: 'not-an-instrument', posSide: 'net',
        pos: '0', mgnMode: 'isolated'
      }
    ]

    for (const malformed of malformedPositions) {
      const { client, fetchImpl } = createTradingHarness({
        onPositions: () => okJson([malformed])
      })
      await client.verifyAccountConfiguration()
      client.setLiveTradingArmed(true)

      await expect(client.placeMarketOrder({
        symbolOrInstId: 'BTC',
        direction: 'LONG',
        arm: client.armNextLiveTrade('open')
      })).rejects.toMatchObject({ code: 'INVALID_SWAP_POSITION' })
      expect(fetchImpl.mock.calls.some(([input, init]) =>
        new URL(input).pathname === '/api/v5/trade/order' && init?.method === 'POST'
      )).toBe(false)
    }
  })

  it('does not collapse a mathematically non-zero position through floating-point underflow', async () => {
    const { client, fetchImpl } = createTradingHarness({
      onPositions: () => okJson([{
        instType: 'SWAP',
        instId: 'BTC-USDT-SWAP',
        posSide: 'net',
        pos: '1e-999',
        mgnMode: 'isolated'
      }])
    })
    await client.verifyAccountConfiguration()
    client.setLiveTradingArmed(true)

    await expect(client.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm: client.armNextLiveTrade('open')
    })).rejects.toThrow('already has an open position')
    expect(fetchImpl.mock.calls.some(([input, init]) =>
      new URL(input).pathname === '/api/v5/trade/order' && init?.method === 'POST'
    )).toBe(false)
  })

  it('keeps an unknown close interlocked for a non-zero position below Number range', async () => {
    let submitted = false
    const { client } = createTradingHarness({
      onPositions: () => okJson([{
        instType: 'SWAP',
        instId: 'BTC-USDT-SWAP',
        posSide: 'net',
        pos: submitted ? '1e-999' : '2',
        mgnMode: 'isolated'
      }]),
      onOrder: (_url, init) => {
        if (init?.method === 'POST') {
          submitted = true
          throw new Error('socket closed after write')
        }
        return new Response(
          JSON.stringify({ code: '51603', msg: 'Order does not exist', data: [] }),
          { status: 200 }
        )
      }
    })
    client.setLiveTradingArmed(true)
    const unknown = await client.closeEntirePosition({
      instId: 'BTC-USDT-SWAP',
      arm: client.armNextLiveTrade('close')
    }).catch((caught: unknown) => caught) as OkxOrderStateUnknownError

    await expect(client.reconcileUnknownOrder(unknown)).resolves.toMatchObject({
      safeToClear: false,
      positions: [{ pos: '1e-999' }]
    })
    expect(() => client.confirmOrderReconciled()).toThrow('not been safely reconciled')
  })

  it('rejects scoped position and pending-order responses for another instrument', async () => {
    let positionSubmissionFailed = false
    const positionHarness = createTradingHarness({
      onPositions: () => positionSubmissionFailed
        ? okJson([{
            instType: 'SWAP',
            instId: 'ETH-USDT-SWAP',
            posSide: 'net',
            pos: '0',
            mgnMode: 'isolated'
          }])
        : okJson([]),
      onOrder: (_url, init) => {
        if (init?.method === 'POST') {
          positionSubmissionFailed = true
          throw new Error('socket closed after write')
        }
        return new Response(
          JSON.stringify({ code: '51603', msg: 'Order does not exist', data: [] }),
          { status: 200 }
        )
      }
    })
    await positionHarness.client.verifyAccountConfiguration()
    positionHarness.client.setLiveTradingArmed(true)
    const positionUnknown = await positionHarness.client.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm: positionHarness.client.armNextLiveTrade('open')
    }).catch((caught: unknown) => caught) as OkxOrderStateUnknownError
    await expect(positionHarness.client.reconcileUnknownOrder(positionUnknown)).rejects.toMatchObject({
      code: 'INVALID_SWAP_POSITION'
    })

    let pendingSubmissionFailed = false
    const pendingHarness = createTradingHarness({
      onPendingOrders: () => pendingSubmissionFailed
        ? okJson([{
            instType: 'SWAP',
            instId: 'ETH-USDT-SWAP',
            ordId: 'wronginstrumentorder1',
            clOrdId: 'wronginstrumentclient1',
            state: 'live'
          }])
        : okJson([]),
      onOrder: (_url, init) => {
        if (init?.method === 'POST') {
          pendingSubmissionFailed = true
          throw new Error('socket closed after write')
        }
        return new Response(
          JSON.stringify({ code: '51603', msg: 'Order does not exist', data: [] }),
          { status: 200 }
        )
      }
    })
    await pendingHarness.client.verifyAccountConfiguration()
    pendingHarness.client.setLiveTradingArmed(true)
    const pendingUnknown = await pendingHarness.client.placeMarketOrder({
      symbolOrInstId: 'BTC',
      direction: 'LONG',
      arm: pendingHarness.client.armNextLiveTrade('open')
    }).catch((caught: unknown) => caught) as OkxOrderStateUnknownError
    await expect(pendingHarness.client.reconcileUnknownOrder(pendingUnknown)).rejects.toMatchObject({
      code: 'INVALID_PENDING_ORDER'
    })
  })

  it('rejects undocumented rejected and failed normal-order states', async () => {
    for (const state of ['rejected', 'failed']) {
      const { client } = createTradingHarness({
        onOrder: (_url, init) => {
          expect(init?.method).toBe('GET')
          return okJson([{
            instType: 'SWAP',
            instId: 'BTC-USDT-SWAP',
            ordId: 'unsupportedstateorder1',
            clOrdId: 'unsupportedstateclient1',
            state
          }])
        }
      })
      await expect(client.getOrder({
        instId: 'BTC-USDT-SWAP',
        clOrdId: 'unsupportedstateclient1'
      })).rejects.toMatchObject({ code: 'INVALID_ORDER_DETAILS' })
    }
  })

  it('accepts legal empty client IDs from external pending and ordId queries', async () => {
    const pendingHarness = createTradingHarness({
      onPendingOrders: () => okJson([{
        instType: 'SWAP',
        instId: 'BTC-USDT-SWAP',
        ordId: 'externalpending1',
        clOrdId: '',
        state: 'partially_filled'
      }])
    })
    await expect(pendingHarness.client.verifyAccountConfiguration()).resolves.toMatchObject({
      ok: false,
      pendingSwapOrders: [{ ordId: 'externalpending1', clOrdId: '' }]
    })

    const detailHarness = createTradingHarness({
      onOrder: (_url, init) => {
        expect(init?.method).toBe('GET')
        return okJson([{
          instType: 'SWAP',
          instId: 'BTC-USDT-SWAP',
          ordId: 'externaldetail1',
          clOrdId: '',
          state: 'filled'
        }])
      }
    })
    await expect(detailHarness.client.getOrder({
      instId: 'BTC-USDT-SWAP',
      ordId: 'externaldetail1'
    })).resolves.toMatchObject({ ordId: 'externaldetail1', clOrdId: '' })
  })
})

describe('full-position reduce-only close', () => {
  it('closes the exact signed net position with the opposite side and reduceOnly', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const mutationEvents: OkxMutationLifecycleEvent[] = []
    const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
      const url = new URL(input)
      if (url.pathname === '/api/v5/trade/orders-pending') return okJson([])
      if (url.pathname === '/api/v5/trade/orders-algo-pending') return okJson([])
      if (url.pathname === '/api/v5/public/time') {
        return okJson([{ ts: String(Date.now()) }])
      }
      if (url.pathname === '/api/v5/account/positions') {
        return okJson([
          {
            instType: 'SWAP',
            instId: 'ETH-USDT-SWAP',
            posSide: 'net',
            pos: '-2.5',
            mgnMode: 'isolated'
          }
        ])
      }
      if (url.pathname === '/api/v5/trade/order') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        requestBodies.push(body)
        return okJson([
          { ordId: 'close-1', clOrdId: body.clOrdId, sCode: '0', sMsg: '' }
        ])
      }
      throw new Error(`Unexpected test request: ${url.pathname}`)
    })
    const client = new OkxV5Client({
      credentials,
      fetchImpl,
      allowCustomEndpointsForTesting: true,
      onMutationLifecycle: (event) => {
        mutationEvents.push({ ...event })
      }
    })
    client.setLiveTradingArmed(true)
    const result = await client.closeEntirePosition({
      instId: 'ETH-USDT-SWAP',
      arm: client.armNextLiveTrade('close')
    })

    expect(result).toMatchObject({
      instId: 'ETH-USDT-SWAP',
      method: 'reduce-only',
      ordId: 'close-1',
      closedSize: '2.5',
      executionState: 'pending_confirmation'
    })
    expect(requestBodies).toHaveLength(1)
    expect(requestBodies[0]).toMatchObject({
      instId: 'ETH-USDT-SWAP',
      tdMode: 'isolated',
      side: 'buy',
      posSide: 'net',
      ordType: 'market',
      sz: '2.5',
      reduceOnly: true
    })
    expect(mutationEvents.map((event) => event.phase)).toEqual([
      'prepared',
      'transmitting',
      'accepted'
    ])
    expect(mutationEvents[0]).toMatchObject({
      operation: 'close',
      instId: 'ETH-USDT-SWAP'
    })
    const pendingOrderUrl = fetchImpl.mock.calls
      .map(([input]) => new URL(input))
      .find((url) => url.pathname === '/api/v5/trade/orders-pending')
    expect(pendingOrderUrl?.searchParams.get('instType')).toBe('SWAP')
    expect(pendingOrderUrl?.searchParams.get('instId')).toBe('ETH-USDT-SWAP')
    const pendingAlgoUrls = fetchImpl.mock.calls
      .map(([input]) => new URL(input))
      .filter((url) => url.pathname === '/api/v5/trade/orders-algo-pending')
    expect(pendingAlgoUrls).toHaveLength(7)
    expect(pendingAlgoUrls.map((url) => url.searchParams.get('ordType')).sort())
      .toEqual([
        'chase',
        'conditional,oco',
        'iceberg',
        'move_order_stop',
        'smart_iceberg',
        'trigger',
        'twap'
      ])
    for (const url of pendingAlgoUrls) {
      expect(url.searchParams.get('instType')).toBe('SWAP')
      expect(url.searchParams.get('instId')).toBe('ETH-USDT-SWAP')
      expect(url.searchParams.get('limit')).toBe('100')
    }
  })

  it('uses lexical position sign and a trimmed unsigned size for reduce-only close', async () => {
    const cases = [
      { position: ' +1e-999 ', expectedSide: 'sell' },
      { position: ' -1e-999 ', expectedSide: 'buy' }
    ] as const

    for (const testCase of cases) {
      let submittedBody!: Record<string, unknown>
      const { client } = createTradingHarness({
        onPositions: () => okJson([{
          instType: 'SWAP',
          instId: 'BTC-USDT-SWAP',
          posSide: 'net',
          pos: testCase.position,
          mgnMode: 'isolated'
        }]),
        onOrder: (_url, init, body) => {
          expect(init?.method).toBe('POST')
          submittedBody = body
          return okJson([{
            ordId: 'lexicalcloseorder1',
            clOrdId: body.clOrdId,
            sCode: '0',
            sMsg: ''
          }])
        }
      })
      client.setLiveTradingArmed(true)

      await expect(client.closeEntirePosition({
        instId: 'BTC-USDT-SWAP',
        arm: client.armNextLiveTrade('close')
      })).resolves.toMatchObject({ closedSize: '1e-999' })
      expect(submittedBody).toMatchObject({
        side: testCase.expectedSide,
        sz: '1e-999',
        reduceOnly: true
      })
    }
  })

  it('interlocks an ambiguous reduce-only close and requires matching-order reconciliation', async () => {
    const { client } = createTradingHarness({
      onPositions: () => okJson([
        {
          instType: 'SWAP',
          instId: 'BTC-USDT-SWAP',
          posSide: 'net',
          pos: '-2',
          mgnMode: 'isolated'
        }
      ]),
      onOrder: (_url, init) => {
        if (init?.method === 'POST') throw new Error('socket closed after write')
        return new Response(
          JSON.stringify({ code: '51603', msg: 'Order does not exist', data: [] }),
          { status: 200 }
        )
      }
    })
    client.setLiveTradingArmed(true)
    const error = await client.closeEntirePosition({
      instId: 'BTC-USDT-SWAP',
      arm: client.armNextLiveTrade('close')
    }).catch((caught: unknown) => caught) as OkxOrderStateUnknownError

    expect(error).toBeInstanceOf(OkxOrderStateUnknownError)
    expect(error.operation).toBe('close')
    expect(client.requiresOrderReconciliation).toBe(true)
    await expect(client.reconcileUnknownOrder(error)).resolves.toMatchObject({
      safeToClear: false,
      positions: [{ pos: '-2' }]
    })
    expect(() => client.confirmOrderReconciled()).toThrow('not been safely reconciled')
  })

  it('refuses a duplicate close while the instrument already has a pending order', async () => {
    const { client, fetchImpl } = createTradingHarness({
      onPositions: () => okJson([
        {
          instType: 'SWAP',
          instId: 'BTC-USDT-SWAP',
          posSide: 'net',
          pos: '2',
          mgnMode: 'isolated'
        }
      ]),
      onPendingOrders: () => okJson([
        {
          instType: 'SWAP',
          instId: 'BTC-USDT-SWAP',
          ordId: 'pendingclose',
          clOrdId: 'manualclose',
          state: 'live'
        }
      ])
    })
    client.setLiveTradingArmed(true)

    await expect(client.closeEntirePosition({
      instId: 'BTC-USDT-SWAP',
      arm: client.armNextLiveTrade('close')
    })).rejects.toThrow('unfinished order')
    expect(
      fetchImpl.mock.calls.some(
        ([input, init]) =>
          new URL(input).pathname === '/api/v5/trade/order' &&
          init?.method === 'POST'
      )
    ).toBe(false)
  })

  it('refuses a close while the instrument has an untriggered strategy order', async () => {
    const { client, fetchImpl } = createTradingHarness({
      onPositions: () => okJson([
        {
          instType: 'SWAP',
          instId: 'BTC-USDT-SWAP',
          posSide: 'net',
          pos: '2',
          mgnMode: 'isolated'
        }
      ]),
      onPendingAlgoOrders: (url) =>
        url.searchParams.get('ordType') === 'trigger'
          ? okJson([
              {
                instType: 'SWAP',
                instId: 'BTC-USDT-SWAP',
                algoId: 'pending-trigger',
                ordType: 'trigger',
                state: 'live'
              }
            ])
          : okJson([])
    })
    client.setLiveTradingArmed(true)

    await expect(client.closeEntirePosition({
      instId: 'BTC-USDT-SWAP',
      arm: client.armNextLiveTrade('close')
    })).rejects.toThrow(
      'untriggered strategy order; cancel or finish it in OKX'
    )
    expect(
      fetchImpl.mock.calls.some(
        ([input, init]) =>
          new URL(input).pathname === '/api/v5/trade/order' &&
          init?.method === 'POST'
      )
    ).toBe(false)
  })

  it('does not let another instrument pending orders block a risk-reducing close', async () => {
    const { client, fetchImpl } = createTradingHarness({
      onPositions: () => okJson([
        {
          instType: 'SWAP',
          instId: 'BTC-USDT-SWAP',
          posSide: 'net',
          pos: '2',
          mgnMode: 'isolated'
        }
      ]),
      onPendingOrders: () => okJson([
        {
          instType: 'SWAP',
          instId: 'ETH-USDT-SWAP',
          ordId: 'otherorder',
          clOrdId: 'otherclientorder',
          state: 'live'
        }
      ]),
      onPendingAlgoOrders: (url) =>
        url.searchParams.get('ordType') === 'smart_iceberg'
          ? okJson([
              {
                instType: 'SWAP',
                instId: 'ETH-USDT-SWAP',
                algoId: 'other-algo',
                ordType: 'smart_iceberg',
                state: 'live'
              }
            ])
          : okJson([])
    })
    client.setLiveTradingArmed(true)

    await expect(client.closeEntirePosition({
      instId: 'BTC-USDT-SWAP',
      arm: client.armNextLiveTrade('close')
    })).resolves.toMatchObject({
      instId: 'BTC-USDT-SWAP',
      closedSize: '2',
      executionState: 'pending_confirmation'
    })
    expect(
      fetchImpl.mock.calls.filter(
        ([input, init]) =>
          new URL(input).pathname === '/api/v5/trade/order' &&
          init?.method === 'POST'
      )
    ).toHaveLength(1)
  })

  it('fails a close closed when the pending strategy query has a network failure', async () => {
    const { client, fetchImpl } = createTradingHarness({
      onPositions: () => okJson([
        {
          instType: 'SWAP',
          instId: 'BTC-USDT-SWAP',
          posSide: 'net',
          pos: '2',
          mgnMode: 'isolated'
        }
      ]),
      onPendingAlgoOrders: (url) => {
        if (url.searchParams.get('ordType') === 'trigger') {
          throw Object.assign(new Error('connection reset'), {
            code: 'ECONNRESET'
          })
        }
        return okJson([])
      }
    })
    client.setLiveTradingArmed(true)

    await expect(client.closeEntirePosition({
      instId: 'BTC-USDT-SWAP',
      arm: client.armNextLiveTrade('close')
    })).rejects.toMatchObject({
      name: 'OkxTransportError',
      stage: 'pending_algo_orders',
      category: 'connection'
    })
    expect(
      fetchImpl.mock.calls.some(
        ([input, init]) =>
          new URL(input).pathname === '/api/v5/trade/order' &&
          init?.method === 'POST'
      )
    ).toBe(false)
  })

  it('fails a close closed when OKX rejects a pending strategy query', async () => {
    const { client, fetchImpl } = createTradingHarness({
      onPositions: () => okJson([
        {
          instType: 'SWAP',
          instId: 'BTC-USDT-SWAP',
          posSide: 'net',
          pos: '2',
          mgnMode: 'isolated'
        }
      ]),
      onPendingAlgoOrders: (url) =>
        url.searchParams.get('ordType') === 'trigger'
          ? new Response(JSON.stringify({
              code: '50011',
              msg: 'Rate limit reached',
              data: []
            }), { status: 200 })
          : okJson([])
    })
    client.setLiveTradingArmed(true)

    await expect(client.closeEntirePosition({
      instId: 'BTC-USDT-SWAP',
      arm: client.armNextLiveTrade('close')
    })).rejects.toMatchObject({ code: '50011' })
    expect(
      fetchImpl.mock.calls.some(
        ([input, init]) =>
          new URL(input).pathname === '/api/v5/trade/order' &&
          init?.method === 'POST'
      )
    ).toBe(false)
  })

  it('disables the unidentifiable close-position endpoint', async () => {
    const { client, fetchImpl } = createTradingHarness()
    client.setLiveTradingArmed(true)

    await expect(client.closeEntirePosition({
      instId: 'BTC-USDT-SWAP',
      method: 'close-position',
      arm: client.armNextLiveTrade('close')
    })).rejects.toThrow('no client order ID')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

class FakeWebSocket implements WebSocketLike {
  readyState = 0
  readonly sent: string[] = []
  private readonly listeners = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >()

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const entries = this.listeners.get(event) ?? []
    entries.push(listener)
    this.listeners.set(event, entries)
    return this
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''))
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

describe('private websocket callback contract', () => {
  it('does not reject private WebSocket startup when Node environment-proxy routing is enabled', async () => {
    const previous = process.env.NODE_USE_ENV_PROXY
    process.env.NODE_USE_ENV_PROXY = '1'
    const socket = new FakeWebSocket()
    const fetchImpl = vi.fn<FetchLike>(async () =>
      okJson([{ ts: String(Date.now()) }])
    )
    const webSocketFactory = vi.fn(() => socket)
    const client = new OkxV5Client({
      credentials,
      fetchImpl,
      webSocketFactory,
      allowCustomEndpointsForTesting: true
    })
    const stream = client.createPrivateStream({ autoReconnect: false })
    try {
      const connecting = stream.connect()
      await vi.waitFor(() => expect(webSocketFactory).toHaveBeenCalledOnce())
      socket.readyState = 1
      socket.emit('open')
      socket.emit('message', JSON.stringify({ event: 'login', code: '0', msg: '' }))
      for (const channel of ['orders', 'positions', 'account']) {
        socket.emit(
          'message',
          JSON.stringify({ event: 'subscribe', arg: { channel } })
        )
      }
      await expect(connecting).resolves.toBeUndefined()
    } finally {
      stream.disconnect()
      if (previous === undefined) delete process.env.NODE_USE_ENV_PROXY
      else process.env.NODE_USE_ENV_PROXY = previous
    }
  })

  it('emits typed channel data without exposing the raw authenticated envelope', async () => {
    const socket = new FakeWebSocket()
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = new URL(input)
      if (url.pathname === '/api/v5/public/time') {
        return okJson([{ ts: String(Date.now()) }])
      }
      throw new Error(`Unexpected test request: ${url.pathname}`)
    })
    const webSocketFactory = vi.fn(
      (_url: string, options: OkxWebSocketOptions): WebSocketLike => {
        expect(options.perMessageDeflate).toBe(false)
        return socket
      }
    )
    const client = new OkxV5Client({
      credentials,
      fetchImpl,
      webSocketFactory,
      allowCustomEndpointsForTesting: true
    })
    const stream = client.createPrivateStream({ autoReconnect: false })
    const updates: unknown[] = []
    stream.on('update', (update) => updates.push(update))
    const connecting = stream.connect()
    await vi.waitFor(() => expect(webSocketFactory).toHaveBeenCalledOnce())
    socket.readyState = 1
    socket.emit('open')
    const login = JSON.parse(socket.sent[0]!) as Record<string, unknown>
    expect(login.op).toBe('login')

    socket.emit(
      'message',
      JSON.stringify({ event: 'login', code: '0', msg: '' })
    )
    for (const channel of ['orders', 'positions', 'account']) {
      socket.emit(
        'message',
        JSON.stringify({ event: 'subscribe', code: '0', arg: { channel } })
      )
    }
    await expect(connecting).resolves.toBeUndefined()
    socket.emit(
      'message',
      JSON.stringify({
        arg: { channel: 'positions' },
        data: [{ instId: 'BTC-USDT-SWAP', pos: '1' }],
        privateInternalValue: credentials.secretKey
      })
    )

    expect(updates).toEqual([
      {
        channel: 'positions',
        data: [{ instId: 'BTC-USDT-SWAP', pos: '1' }]
      }
    ])
    expect(JSON.stringify(updates)).not.toContain(credentials.secretKey)
    stream.disconnect()
  })

  it('deduplicates fills by tradeId and terminal order states by ordId', async () => {
    const socket = new FakeWebSocket()
    const webSocketFactory = vi.fn(() => socket)
    const client = new OkxV5Client({
      credentials,
      fetchImpl: vi.fn<FetchLike>(async () =>
        okJson([{ ts: String(Date.now()) }])
      ),
      webSocketFactory,
      allowCustomEndpointsForTesting: true
    })
    const stream = client.createPrivateStream({ autoReconnect: false })
    const orders: unknown[] = []
    const rawUpdates: unknown[] = []
    stream.on('orders', (batch) => orders.push(...batch))
    stream.on('update', (update) => rawUpdates.push(update))
    const connecting = stream.connect()
    await vi.waitFor(() => expect(webSocketFactory).toHaveBeenCalledOnce())
    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', JSON.stringify({ event: 'login', code: '0', msg: '' }))
    for (const channel of ['orders', 'positions', 'account']) {
      socket.emit(
        'message',
        JSON.stringify({ event: 'subscribe', code: '0', arg: { channel } })
      )
    }
    await expect(connecting).resolves.toBeUndefined()

    const firstBatch = [
      {
        instId: 'BTC-USDT-SWAP',
        ordId: 'order-1',
        tradeId: 'trade-1',
        state: 'partially_filled'
      },
      {
        instId: 'BTC-USDT-SWAP',
        ordId: 'order-2',
        tradeId: '',
        state: 'filled'
      },
      {
        instId: 'BTC-USDT-SWAP',
        ordId: 'order-3',
        state: 'canceled'
      }
    ]
    socket.emit(
      'message',
      JSON.stringify({ arg: { channel: 'orders' }, data: firstBatch })
    )
    socket.emit(
      'message',
      JSON.stringify({ arg: { channel: 'orders' }, data: firstBatch })
    )
    const terminalWithTradeId = {
      instId: 'BTC-USDT-SWAP',
      ordId: 'order-4',
      tradeId: 'trade-4',
      state: 'filled'
    }
    socket.emit(
      'message',
      JSON.stringify({
        arg: { channel: 'orders' },
        data: [terminalWithTradeId]
      })
    )
    socket.emit(
      'message',
      JSON.stringify({
        arg: { channel: 'orders' },
        data: [{ instId: 'BTC-USDT-SWAP', ordId: 'order-4', state: 'filled' }]
      })
    )

    expect(orders).toEqual([...firstBatch, terminalWithTradeId])
    expect(rawUpdates).toEqual([
      { channel: 'orders', data: firstBatch },
      { channel: 'orders', data: [terminalWithTradeId] }
    ])
    stream.disconnect()
  })

  it('rejects a failed or malformed subscription acknowledgement', async () => {
    const socket = new FakeWebSocket()
    const webSocketFactory = vi.fn(() => socket)
    const client = new OkxV5Client({
      credentials,
      fetchImpl: vi.fn<FetchLike>(async () =>
        okJson([{ ts: String(Date.now()) }])
      ),
      webSocketFactory,
      allowCustomEndpointsForTesting: true
    })
    const stream = client.createPrivateStream({ autoReconnect: false })
    const connecting = stream.connect()
    await vi.waitFor(() => expect(webSocketFactory).toHaveBeenCalledOnce())
    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', JSON.stringify({ event: 'login', code: '0', msg: '' }))
    socket.emit(
      'message',
      JSON.stringify({
        event: 'subscribe',
        code: '60012',
        msg: 'Invalid request',
        arg: { channel: 'orders' }
      })
    )

    await expect(connecting).rejects.toMatchObject({ code: '60012' })
    stream.disconnect()
  })

  it('redacts credentials from websocket errors before observers receive them', async () => {
    const socket = new FakeWebSocket()
    let factoryCalled = false
    const fetchImpl = vi.fn<FetchLike>(async () =>
      okJson([{ ts: String(Date.now()) }])
    )
    const client = new OkxV5Client({
      credentials,
      fetchImpl,
      webSocketFactory: () => {
        factoryCalled = true
        return socket
      },
      allowCustomEndpointsForTesting: true
    })
    const stream = client.createPrivateStream({ autoReconnect: false })
    const errors: Error[] = []
    stream.on('error', (error) => errors.push(error))
    const connecting = stream.connect()
    await vi.waitFor(() => expect(factoryCalled).toBe(true))
    socket.readyState = 1
    socket.emit('open')
    socket.emit(
      'message',
      JSON.stringify({
        event: 'error',
        code: '60009',
        msg: `bad ${credentials.apiKey} ${credentials.secretKey} ${credentials.passphrase}`
      })
    )
    await expect(connecting).rejects.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).not.toContain(credentials.apiKey)
    expect(errors[0]?.message).not.toContain(credentials.secretKey)
    expect(errors[0]?.message).not.toContain(credentials.passphrase)
    stream.disconnect()
  })

  it('selects the proxy only when the preferred direct WebSocket fails before open', async () => {
    const directSocket = new FakeWebSocket()
    const proxySocket = new FakeWebSocket()
    const fetchImpl = vi.fn<FetchLike>(async () =>
      okJson([{ ts: String(Date.now()) }])
    )
    const directFactory = vi.fn(() => directSocket)
    const proxyFactory = vi.fn(() => proxySocket)
    const client = new OkxV5Client({
      credentials,
      proxy: { host: '127.0.0.1', port: 7890, protocol: 'http' },
      fetchImpl,
      proxyFetchImpl: vi.fn<FetchLike>(),
      webSocketFactory: directFactory,
      proxyWebSocketFactory: proxyFactory,
      allowCustomEndpointsForTesting: true
    })
    const stream = client.createPrivateStream({ autoReconnect: false })
    const connecting = stream.connect()
    await vi.waitFor(() => expect(directFactory).toHaveBeenCalledOnce())
    directSocket.emit(
      'error',
      Object.assign(new Error(`connect failed ${credentials.secretKey}`), {
        code: 'ECONNREFUSED'
      })
    )
    await vi.waitFor(() => expect(proxyFactory).toHaveBeenCalledOnce())
    proxySocket.readyState = 1
    proxySocket.emit('open')
    proxySocket.emit(
      'message',
      JSON.stringify({ event: 'login', code: '0', msg: '' })
    )
    for (const channel of ['orders', 'positions', 'account']) {
      proxySocket.emit(
        'message',
        JSON.stringify({ event: 'subscribe', code: '0', arg: { channel } })
      )
    }

    await expect(connecting).resolves.toBeUndefined()
    expect(client.privateWebSocketRouteSelection).toEqual({
      route: 'proxy',
      proxyProtocol: 'http'
    })
    stream.disconnect()
  })

  it('does not cross routes after the direct WebSocket has opened', async () => {
    const directSocket = new FakeWebSocket()
    const proxySocket = new FakeWebSocket()
    const fetchImpl = vi.fn<FetchLike>(async () =>
      okJson([{ ts: String(Date.now()) }])
    )
    const directFactory = vi.fn(() => directSocket)
    const proxyFactory = vi.fn(() => proxySocket)
    const client = new OkxV5Client({
      credentials,
      proxy: { host: '127.0.0.1', port: 7890, protocol: 'http' },
      fetchImpl,
      proxyFetchImpl: vi.fn<FetchLike>(),
      webSocketFactory: directFactory,
      proxyWebSocketFactory: proxyFactory,
      allowCustomEndpointsForTesting: true
    })
    const stream = client.createPrivateStream({ autoReconnect: false })
    const connecting = stream.connect()
    await vi.waitFor(() => expect(directFactory).toHaveBeenCalledOnce())
    directSocket.readyState = 1
    directSocket.emit('open')
    directSocket.emit(
      'message',
      JSON.stringify({ event: 'login', code: '60009', msg: 'Login failed' })
    )

    await expect(connecting).rejects.toThrow('Login failed')
    expect(client.privateWebSocketRouteSelection).toEqual({ route: 'direct' })
    expect(proxyFactory).not.toHaveBeenCalled()
    stream.disconnect()
  })
})
