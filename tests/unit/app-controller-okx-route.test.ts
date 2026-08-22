import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'secret_service',
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}))

import { AppController, type AppControllerOptions } from '../../src/main/app-controller'
import type {
  CloseOkxPositionInput,
  OkxAlgoOrder,
  OkxOrderUpdate,
  OkxOrder,
  OkxAccountVerification,
  OkxClientOptions,
  OkxCloseResult,
  OkxPosition,
  OkxPrivateStream,
  OkxV5Client
} from '../../src/main/services/okx'
import { OkxOrderStateUnknownError, OkxTransportError } from '../../src/main/services/okx'
import type { SignalTradeAuthorizationToken } from '../../src/main/services/signal-coordinator'
import type { AppPosition, SignalRecord, TelegramMessagePayload } from '../../src/shared/types'

const temporaryDirectories: string[] = []

function installReadyTelegram(controller: AppController): void {
  ;(controller as unknown as {
    telegram?: {
      readonly liveTradingReadiness: { ready: boolean; revision: number }
      stop(): Promise<void>
    }
  }).telegram = {
    liveTradingReadiness: { ready: true, revision: 0 },
    stop: vi.fn(async () => undefined)
  }
}

function captureSignalAuthorization(
  controller: AppController
): SignalTradeAuthorizationToken | undefined {
  return (controller as unknown as {
    currentSignalTradeAuthorization(): SignalTradeAuthorizationToken | undefined
  }).currentSignalTradeAuthorization()
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('AppController OKX route integration', () => {
  it('refuses to replace OKX credentials while any order interlock is active, then allows it after safe terminal state', async () => {
    const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'bwe-controller-credential-guard-'))
    temporaryDirectories.push(userDataDirectory)

    let requiresOrderReconciliation = false
    const streamDisconnect = vi.fn()
    const stream = Object.assign(new EventEmitter(), {
      connect: vi.fn(async () => undefined),
      disconnect: streamDisconnect
    }) as unknown as OkxPrivateStream
    const fakeClient = {
      get restRouteSelection() { return { route: 'direct' as const } },
      get privateWebSocketRouteSelection() { return { route: 'direct' as const } },
      get requiresOrderReconciliation() { return requiresOrderReconciliation },
      verifyAccountConfiguration: vi.fn(async () => healthyVerification()),
      setLiveTradingArmed: vi.fn(),
      getInstruments: vi.fn(async () => []),
      getPositions: vi.fn(async () => []),
      getPendingOrders: vi.fn(async () => []),
      getPendingAlgoOrders: vi.fn(async () => []),
      createPrivateStream: vi.fn(() => stream)
    } as unknown as OkxV5Client
    const controller = new AppController({
      userDataDirectory,
      version: 'test',
      openExternal: async () => undefined,
      createOkxClient: () => fakeClient
    })
    await controller.initialize()

    const originalCredentials = {
      apiKey: 'api-key-original-sensitive',
      secretKey: 'secret-original-sensitive',
      passphrase: 'passphrase-original-sensitive'
    }
    const replacementCredentials = {
      apiKey: 'api-key-replacement-sensitive',
      secretKey: 'secret-replacement-sensitive',
      passphrase: 'passphrase-replacement-sensitive'
    }
    await controller.saveOkxCredentials(originalCredentials)
    await controller.connectOkx()
    await expect(controller.saveOkxCredentials(originalCredentials)).resolves.toBeUndefined()
    expect(controller.getSnapshot().connections.okx.phase).toBe('connected')
    expect(streamDisconnect).not.toHaveBeenCalled()

    const internals = controller as unknown as {
      coordinator: {
        pendingClientOrderId?: string
        hasPendingOrder: boolean
      }
      activePositionClose?: Promise<void>
      pendingPositionCloses: Map<string, {
        instrumentId: string
        clientOrderId?: string
        state: 'accepted'
        submittedAt: number
      }>
      okx?: OkxV5Client
      secretStore: {
        get(key: string): Promise<string | undefined>
      }
    }
    const savedCredentials = async () => {
      const raw = await internals.secretStore.get('okx.credentials.v1')
      return raw ? JSON.parse(raw) as typeof originalCredentials : undefined
    }
    const expectRejectedWithoutMutation = async (expectedDetail: string) => {
      await expect(controller.saveOkxCredentials(replacementCredentials)).rejects.toThrow(expectedDetail)
      expect(await savedCredentials()).toEqual(originalCredentials)
      expect(internals.okx).toBe(fakeClient)
      expect(controller.getSnapshot().connections.okx.phase).toBe('connected')
      expect(streamDisconnect).not.toHaveBeenCalled()
    }

    internals.coordinator.pendingClientOrderId = 'bwe-opening-pending'
    await expectRejectedWithoutMutation('开仓订单仍在等待最终状态或只读对账')
    expect(internals.coordinator.hasPendingOrder).toBe(true)
    internals.coordinator.pendingClientOrderId = undefined

    let resolveActiveClose!: () => void
    const activeClose = new Promise<void>((resolve) => { resolveActiveClose = resolve })
    internals.activePositionClose = activeClose
    await expectRejectedWithoutMutation('平仓操作正在提交，请等待其完成')
    expect(internals.activePositionClose).toBe(activeClose)
    resolveActiveClose()
    await activeClose
    internals.activePositionClose = undefined

    internals.pendingPositionCloses.set('ABC-USDT-SWAP', {
      instrumentId: 'ABC-USDT-SWAP',
      clientOrderId: 'bwe-close-pending',
      state: 'accepted',
      submittedAt: 1_700_000_000_000
    })
    await expectRejectedWithoutMutation('平仓订单仍在等待最终状态或只读对账')
    expect(internals.pendingPositionCloses.has('ABC-USDT-SWAP')).toBe(true)
    internals.pendingPositionCloses.clear()

    requiresOrderReconciliation = true
    await expectRejectedWithoutMutation('OKX 存在结果未知订单，必须先完成只读对账')
    expect(requiresOrderReconciliation).toBe(true)

    requiresOrderReconciliation = false
    await expect(controller.saveOkxCredentials(replacementCredentials)).resolves.toBeUndefined()
    expect(await savedCredentials()).toEqual(replacementCredentials)
    expect(internals.okx).toBeUndefined()
    expect(controller.getSnapshot().connections.okx.phase).toBe('disconnected')
    expect(streamDisconnect).toHaveBeenCalledOnce()

    await controller.dispose()
  })

  it('keeps the old secret and connection when a fresh credential-change check finds a SWAP position', async () => {
    const test = await createCredentialLifecycleHarness()
    test.setPositions([lifecycleTestPosition()])

    await expect(
      test.controller.saveOkxCredentials(test.replacementCredentials)
    ).rejects.toThrow('旧账户仍有 1 个 SWAP 持仓')

    test.setPositions([{ ...lifecycleTestPosition(), instType: 'SPOT', pos: '0' }])
    await expect(
      test.controller.saveOkxCredentials(test.replacementCredentials)
    ).rejects.toThrow('无法明确判定为零仓位')
    test.setPositions([{ ...lifecycleTestPosition(), pos: '' }])
    await expect(
      test.controller.saveOkxCredentials(test.replacementCredentials)
    ).rejects.toThrow('无法明确判定为零仓位')

    expect(await test.savedCredentials()).toEqual(test.originalCredentials)
    expect(test.controller.getSnapshot().connections.okx.phase).toBe('connected')
    expect(test.stream.disconnect).not.toHaveBeenCalled()
    await test.controller.dispose()
  })

  it('remembers an observed old-account position after disconnect and requires reconnect before replacement', async () => {
    const test = await createCredentialLifecycleHarness({
      initialPositions: [lifecycleTestPosition()]
    })
    expect(test.controller.getSnapshot().positions).toHaveLength(1)

    await test.controller.disconnectOkx()
    expect(test.controller.getSnapshot().positions).toHaveLength(0)
    await expect(
      test.controller.saveOkxCredentials(test.replacementCredentials)
    ).rejects.toThrow('必须先使用旧凭据重新连接旧账户')

    expect(await test.savedCredentials()).toEqual(test.originalCredentials)
    await test.controller.dispose()
  })

  it('blocks replacement on ordinary pending orders and every supported pending algo type', async () => {
    const test = await createCredentialLifecycleHarness()
    test.setPendingOrders([{
      instType: 'SWAP',
      instId: 'ABC-USDT-SWAP',
      ordId: 'ordinary-pending-1',
      clOrdId: 'ordinary-client-1',
      state: 'live'
    }])
    const algoTypes = [
      'conditional',
      'oco',
      'trigger',
      'move_order_stop',
      'iceberg',
      'twap',
      'smart_iceberg',
      'chase'
    ]
    test.setPendingAlgoOrders(algoTypes.map((ordType, index) => ({
      instType: 'SWAP',
      instId: 'ABC-USDT-SWAP',
      algoId: `algo-${index}`,
      ordType
    })))

    await expect(
      test.controller.saveOkxCredentials(test.replacementCredentials)
    ).rejects.toThrow('旧账户仍有 1 个普通 SWAP 未完成订单；旧账户仍有 8 个 SWAP 策略未完成订单')

    expect(test.getPendingOrders).toHaveBeenCalled()
    expect(test.getPendingAlgoOrders).toHaveBeenCalled()
    expect(await test.savedCredentials()).toEqual(test.originalCredentials)
    expect(test.stream.disconnect).not.toHaveBeenCalled()
    await test.controller.dispose()
  })

  it('serializes save with a concurrent close and does not erase the close interlock', async () => {
    const test = await createCredentialLifecycleHarness({
      initialPositions: [lifecycleTestPosition()]
    })
    let resolveCredentialPositions!: (positions: OkxPosition[]) => void
    const credentialPositionsGate = new Promise<OkxPosition[]>((resolve) => {
      resolveCredentialPositions = resolve
    })
    const callsBeforeSave = test.getPositions.mock.calls.length
    test.getPositions.mockImplementationOnce(() => credentialPositionsGate)

    const saving = test.controller.saveOkxCredentials(test.replacementCredentials)
    await vi.waitFor(() => expect(test.getPositions.mock.calls.length).toBe(callsBeforeSave + 1))
    const closing = test.controller.closePosition({
      instrumentId: 'ABC-USDT-SWAP',
      confirmation: '确认平仓'
    })
    resolveCredentialPositions([])

    await expect(saving).rejects.toThrow('平仓操作正在提交')
    await expect(closing).resolves.toBeUndefined()
    expect(test.closeEntirePosition).toHaveBeenCalledOnce()
    expect(test.controller.getSnapshot().positions[0]).toMatchObject({
      instrumentId: 'ABC-USDT-SWAP',
      closePending: true
    })
    expect(await test.savedCredentials()).toEqual(test.originalCredentials)
    expect(test.controller.getSnapshot().connections.okx.phase).toBe('connected')
    await test.controller.dispose()
  })

  it('does not let an earlier arm operation re-arm while credential replacement is reserved', async () => {
    const test = await createCredentialLifecycleHarness()
    test.internals.setConnection('telegram', 'connected', 'test')
    test.internals.setConnection('chatgpt', 'connected', 'test')
    await test.controller.startMonitoring()
    let resolveArmPositions!: (positions: OkxPosition[]) => void
    const armPositionsGate = new Promise<OkxPosition[]>((resolve) => {
      resolveArmPositions = resolve
    })
    const callsBeforeArm = test.getPositions.mock.calls.length
    test.getPositions.mockImplementationOnce(() => armPositionsGate)

    const arming = test.controller.armLiveTrading('确认实盘')
    await vi.waitFor(() => expect(test.getPositions.mock.calls.length).toBe(callsBeforeArm + 1))
    const saving = test.controller.saveOkxCredentials(test.replacementCredentials)
    resolveArmPositions([])

    await expect(arming).rejects.toThrow('OKX 连接在交易前检查期间发生变化')
    await expect(saving).resolves.toBeUndefined()
    expect(test.setLiveTradingArmed.mock.calls.some(([armed]) => armed === true)).toBe(false)
    expect(await test.savedCredentials()).toEqual(test.replacementCredentials)
    await test.controller.dispose()
  })

  it('blocks arming during Telegram recovery and rechecks its revision after OKX awaits', async () => {
    const test = await createCredentialLifecycleHarness()
    test.internals.setConnection('telegram', 'connected', 'test')
    test.internals.setConnection('chatgpt', 'connected', 'test')
    await test.controller.startMonitoring()

    let telegramReadiness = { ready: false, revision: 1 }
    test.internals.telegram = {
      get liveTradingReadiness() {
        return { ...telegramReadiness }
      },
      stop: vi.fn(async () => undefined)
    }
    expect(test.controller.getSnapshot().safety.armBlockers).toContain('Telegram 正在校验断线补拉')
    await expect(test.controller.armLiveTrading('确认实盘')).rejects.toThrow('Telegram 正在校验断线补拉')

    telegramReadiness = { ready: true, revision: 1 }
    let resolvePositions!: (positions: OkxPosition[]) => void
    const positionsGate = new Promise<OkxPosition[]>((resolve) => {
      resolvePositions = resolve
    })
    const callsBeforeArm = test.getPositions.mock.calls.length
    test.getPositions.mockImplementationOnce(() => positionsGate)
    const arming = test.controller.armLiveTrading('确认实盘')
    await vi.waitFor(() => expect(test.getPositions.mock.calls.length).toBe(callsBeforeArm + 1))
    telegramReadiness = { ready: true, revision: 2 }
    resolvePositions([])

    await expect(arming).rejects.toThrow('Telegram 正在恢复')
    expect(test.setLiveTradingArmed.mock.calls.some(([armed]) => armed === true)).toBe(false)
    await test.controller.dispose()
  })

  it('keeps an in-flight opening POST unknown after OKX disconnect and client replacement', async () => {
    const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'bwe-controller-inflight-unknown-'))
    temporaryDirectories.push(userDataDirectory)
    const now = 1_700_000_000_000
    let rejectOldSubmission!: (reason?: unknown) => void
    const oldSubmission = new Promise<never>((_resolve, reject) => {
      rejectOldSubmission = reject
    })
    let oldRuntimeArmed = false
    let oldRequiresOrderReconciliation = false
    const oldReconcileUnknownOrder = vi.fn()
    const newReconcileUnknownOrder = vi.fn()

    const makeStream = () => Object.assign(new EventEmitter(), {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn()
    }) as unknown as OkxPrivateStream
    const oldStream = makeStream()
    const newStream = makeStream()
    const oldSubmitPreparedMarketOrder = vi.fn(() => oldSubmission)
    const oldClient = {
      get restRouteSelection() { return { route: 'direct' as const } },
      get privateWebSocketRouteSelection() { return { route: 'direct' as const } },
      get isLiveTradingArmed() { return oldRuntimeArmed },
      get requiresOrderReconciliation() { return oldRequiresOrderReconciliation },
      verifyAccountConfiguration: vi.fn(async () => healthyVerification()),
      setLiveTradingArmed: vi.fn((armed: boolean) => { oldRuntimeArmed = armed }),
      getInstruments: vi.fn(async () => []),
      getPositions: vi.fn(async () => []),
      getPendingOrders: vi.fn(async () => []),
      getOrder: vi.fn(async () => undefined),
      createPrivateStream: vi.fn(() => oldStream),
      prepareMarketOrder: vi.fn(async () => ({
        intentToken: 'intent-old-inflight',
        expiresAt: now + 10_000
      })),
      armNextLiveTrade: vi.fn((scope: 'open' | 'close') => ({
        token: `arm-old-${scope}`,
        scope,
        runtimeArmed: true as const,
        expiresAt: now + 10_000
      })),
      submitPreparedMarketOrder: oldSubmitPreparedMarketOrder,
      reconcileUnknownOrder: oldReconcileUnknownOrder
    } as unknown as OkxV5Client
    const newClient = {
      get restRouteSelection() { return { route: 'direct' as const } },
      get privateWebSocketRouteSelection() { return { route: 'direct' as const } },
      get isLiveTradingArmed() { return false },
      get requiresOrderReconciliation() { return false },
      verifyAccountConfiguration: vi.fn(async () => healthyVerification()),
      setLiveTradingArmed: vi.fn(),
      getInstruments: vi.fn(async () => []),
      getPositions: vi.fn(async () => []),
      getPendingOrders: vi.fn(async () => []),
      getOrder: vi.fn(async () => undefined),
      createPrivateStream: vi.fn(() => newStream),
      reconcileUnknownOrder: newReconcileUnknownOrder
    } as unknown as OkxV5Client
    const createOkxClient = vi.fn()
      .mockReturnValueOnce(oldClient)
      .mockReturnValueOnce(newClient)
    const controller = new AppController({
      userDataDirectory,
      version: 'test',
      openExternal: async () => undefined,
      now: () => now,
      createOkxClient,
      analyzeSignal: async () => ({
        symbols: ['ABC'],
        decision: 'LONG',
        confidence: 0.99,
        reason: 'test listing',
        status: 'ok',
        model: 'test-fast',
        latencyMs: 1,
        analyzedAt: new Date(now).toISOString()
      })
    })
    await controller.initialize()
    const originalCredentials = {
      apiKey: 'api-key-inflight-original-sensitive',
      secretKey: 'secret-inflight-original-sensitive',
      passphrase: 'passphrase-inflight-original-sensitive'
    }
    await controller.saveOkxCredentials(originalCredentials)
    await controller.connectOkx()

    const internals = controller as unknown as {
      setConnection(
        key: 'telegram' | 'chatgpt' | 'okx',
        phase: 'connected',
        detail?: string
      ): void
      coordinator: {
        process(
          message: TelegramMessagePayload,
          authorizationToken?: SignalTradeAuthorizationToken
        ): Promise<SignalRecord | undefined>
        hasPendingOrder: boolean
      }
      scheduleUnknownOrderReconciliation(
        client: OkxV5Client,
        error: OkxOrderStateUnknownError,
        attempt?: number
      ): void
      secretStore: {
        get(key: string): Promise<string | undefined>
      }
    }
    const scheduleReconciliation = vi.spyOn(internals, 'scheduleUnknownOrderReconciliation')
    installReadyTelegram(controller)
    internals.setConnection('telegram', 'connected', 'test')
    internals.setConnection('chatgpt', 'connected', 'test')
    await controller.startMonitoring()
    await controller.armLiveTrading('确认实盘')

    const processing = internals.coordinator.process({
      channelId: 'bwe',
      messageId: 9101,
      channelUsername: 'BWEnews',
      text: 'Coinbase will list ABC',
      date: now,
      receivedAt: now,
      permalink: 'https://t.me/BWEnews/9101'
    }, captureSignalAuthorization(controller))
    await vi.waitFor(() => expect(oldSubmitPreparedMarketOrder).toHaveBeenCalledOnce())

    await controller.disconnectOkx()
    await controller.connectOkx()
    expect(createOkxClient).toHaveBeenCalledTimes(2)
    oldRequiresOrderReconciliation = true
    rejectOldSubmission(new OkxOrderStateUnknownError(
      'ABC-USDT-SWAP',
      'bwe-old-inflight-1',
      'open',
      now
    ))

    await expect(processing).resolves.toMatchObject({
      stage: 'submitted',
      instrumentId: 'ABC-USDT-SWAP',
      clientOrderId: 'bwe-old-inflight-1',
      orderState: 'unknown'
    })
    expect(internals.coordinator.hasPendingOrder).toBe(true)
    expect(controller.getSnapshot().signals[0]).toMatchObject({
      stage: 'submitted',
      orderState: 'unknown',
      clientOrderId: 'bwe-old-inflight-1'
    })
    expect(scheduleReconciliation).not.toHaveBeenCalled()
    expect(oldReconcileUnknownOrder).not.toHaveBeenCalled()
    expect(newReconcileUnknownOrder).not.toHaveBeenCalled()

    await expect(controller.saveOkxCredentials({
      apiKey: 'api-key-inflight-replacement-sensitive',
      secretKey: 'secret-inflight-replacement-sensitive',
      passphrase: 'passphrase-inflight-replacement-sensitive'
    })).rejects.toThrow('开仓订单仍在等待最终状态或只读对账')
    expect(JSON.parse((await internals.secretStore.get('okx.credentials.v1'))!)).toEqual(originalCredentials)
    expect(createOkxClient).toHaveBeenCalledTimes(2)

    await controller.dispose()
  })

  it('passes the saved proxy, exposes fixed REST/WS routes, disconnects on proxy changes, and audits no credentials', async () => {
    const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'bwe-controller-route-'))
    temporaryDirectories.push(userDataDirectory)

    const createdWith: OkxClientOptions[] = []
    let privateWsRoute: { route: 'direct' | 'proxy'; proxyProtocol?: 'http' | 'socks5' } | undefined
    const streamConnect = vi.fn(async () => {
      privateWsRoute = { route: 'direct' }
    })
    const streamDisconnect = vi.fn()
    const stream = Object.assign(new EventEmitter(), {
      connect: streamConnect,
      disconnect: streamDisconnect
    }) as unknown as OkxPrivateStream

    const verification: OkxAccountVerification = {
      ok: true,
      config: {
        acctLv: '2',
        posMode: 'net_mode',
        perm: 'read_only,trade',
        type: '1',
        ip: ''
      },
      checks: {
        hasReadPermission: true,
        hasTradePermission: true,
        hasNoWithdrawPermission: true,
        isSubAccount: true,
        isNetPositionMode: true,
        supportsDerivatives: true,
        supportsIsolatedSwapTrading: true,
        hasNoPendingSwapOrders: true
      },
      pendingSwapOrders: [],
      errors: [],
      warnings: []
    }

    const fakeClient = {
      get restRouteSelection() { return { route: 'proxy' as const, proxyProtocol: 'http' as const } },
      get privateWebSocketRouteSelection() { return privateWsRoute },
      verifyAccountConfiguration: vi.fn(async () => verification),
      setLiveTradingArmed: vi.fn(),
      getInstruments: vi.fn(async () => []),
      getPositions: vi.fn(async () => []),
      createPrivateStream: vi.fn(() => stream)
    } as unknown as OkxV5Client

    const controller = new AppController({
      userDataDirectory,
      version: 'test',
      openExternal: async () => undefined,
      now: () => 1_700_000_000_000,
      createOkxClient: (options) => {
        createdWith.push(options)
        return fakeClient
      }
    })
    await controller.initialize()

    const apiKey = 'api-key-sensitive-value'
    const secretKey = 'secret-sensitive-value'
    const passphrase = 'passphrase-sensitive-value'
    await controller.saveOkxCredentials({ apiKey, secretKey, passphrase })
    await controller.connectOkx()

    expect(createdWith).toHaveLength(1)
    expect(createdWith[0]?.proxy).toEqual({
      host: '127.0.0.1',
      port: 7890,
      protocol: 'auto'
    })
    expect(controller.getSnapshot().okxRoutes).toMatchObject({
      rest: {
        kind: 'proxy',
        protocol: 'http',
        endpoint: '127.0.0.1:7890'
      },
      privateWs: { kind: 'direct' }
    })

    await controller.updateSettings({ proxy: { port: 7891 } })
    expect(streamDisconnect).toHaveBeenCalled()
    expect(controller.getSnapshot().connections.okx.phase).toBe('disconnected')
    expect(controller.getSnapshot().okxRoutes).toEqual({
      rest: { kind: 'unselected', detail: '尚未为本次连接选择 REST 路由' },
      privateWs: { kind: 'unselected', detail: '尚未为本次连接选择私有 WebSocket 路由' }
    })

    await controller.dispose()
    const audit = await readFile(path.join(userDataDirectory, 'audit', 'events.jsonl'), 'utf8')
    expect(audit).toContain('okx_route_selected')
    expect(audit).toContain('127.0.0.1:7890')
    expect(audit).not.toContain(apiKey)
    expect(audit).not.toContain(secretKey)
    expect(audit).not.toContain(passphrase)
  })

  it('turns structured transport failures into a persistent safe Chinese detail', async () => {
    const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'bwe-controller-error-'))
    temporaryDirectories.push(userDataDirectory)

    const fakeClient = {
      restRouteSelection: undefined,
      privateWebSocketRouteSelection: undefined,
      verifyAccountConfiguration: vi.fn(async () => {
        throw new OkxTransportError({
          stage: 'public_time',
          category: 'dns',
          route: 'proxy',
          proxyProtocol: 'http'
        })
      }),
      setLiveTradingArmed: vi.fn()
    } as unknown as OkxV5Client
    const controller = new AppController({
      userDataDirectory,
      version: 'test',
      openExternal: async () => undefined,
      createOkxClient: () => fakeClient
    })
    await controller.initialize()

    const credentials = {
      apiKey: 'api-key-sensitive-value',
      secretKey: 'secret-sensitive-value',
      passphrase: 'passphrase-sensitive-value'
    }
    await controller.saveOkxCredentials(credentials)
    await expect(controller.connectOkx()).rejects.toThrow(
      'OKX 公共时间接口通过 Clash HTTP 连接失败：DNS 解析失败'
    )
    expect(controller.getSnapshot()).toMatchObject({
      connections: {
        okx: {
          phase: 'error',
          detail: 'OKX 公共时间接口通过 Clash HTTP 连接失败：DNS 解析失败'
        }
      },
      lastError: 'OKX 公共时间接口通过 Clash HTTP 连接失败：DNS 解析失败'
    })

    await controller.dispose()
    const audit = await readFile(path.join(userDataDirectory, 'audit', 'events.jsonl'), 'utf8')
    expect(audit).toContain('"transportStage":"public_time"')
    expect(audit).toContain('"transportCategory":"dns"')
    for (const secret of Object.values(credentials)) expect(audit).not.toContain(secret)
  })

  it('keeps REST acceptance pending until one deduplicated WS fill and locks immediately on stream error', async () => {
    const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'bwe-controller-trade-loop-'))
    temporaryDirectories.push(userDataDirectory)
    let now = 1_700_000_000_000
    let runtimeArmed = false
    const stream = Object.assign(new EventEmitter(), {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn()
    }) as unknown as OkxPrivateStream
    const getPositions = vi.fn(async () => [])
    const submitPreparedMarketOrder = vi.fn(async () => ({
      instId: 'ABC-USDT-SWAP',
      direction: 'LONG' as const,
      side: 'buy' as const,
      tdMode: 'isolated' as const,
      ordType: 'market' as const,
      leverage: '1' as const,
      preparedAt: now,
      contracts: '1',
      estimatedNotionalUsdt: 10,
      targetNotionalUsdt: 10,
      priceUsed: '10',
      contractValue: '1',
      contractMultiplier: '1',
      lotSize: '1',
      minimumSize: '1',
      ordId: 'order-loop-1',
      clOrdId: 'bwe-loop-1',
      executionState: 'pending_confirmation' as const,
      submittedAt: now
    }))
    const fakeClient = {
      get restRouteSelection() { return { route: 'direct' as const } },
      get privateWebSocketRouteSelection() { return { route: 'direct' as const } },
      get isLiveTradingArmed() { return runtimeArmed },
      get requiresOrderReconciliation() { return false },
      verifyAccountConfiguration: vi.fn(async () => healthyVerification()),
      setLiveTradingArmed: vi.fn((armed: boolean) => { runtimeArmed = armed }),
      getInstruments: vi.fn(async () => []),
      getPositions,
      getPendingOrders: vi.fn(async () => []),
      getOrder: vi.fn(async () => undefined),
      createPrivateStream: vi.fn(() => stream),
      prepareMarketOrder: vi.fn(async () => ({
        intentToken: 'intent-loop-1',
        expiresAt: now + 10_000
      })),
      armNextLiveTrade: vi.fn((scope: 'open' | 'close') => ({
        token: `arm-${scope}`,
        scope,
        runtimeArmed: true as const,
        expiresAt: now + 10_000
      })),
      submitPreparedMarketOrder
    } as unknown as OkxV5Client
    const controller = new AppController({
      userDataDirectory,
      version: 'test',
      openExternal: async () => undefined,
      now: () => now,
      createOkxClient: () => fakeClient,
      analyzeSignal: async () => ({
        symbols: ['ABC'],
        decision: 'LONG',
        confidence: 0.99,
        reason: 'test listing',
        status: 'ok',
        model: 'test-fast',
        latencyMs: 1,
        analyzedAt: new Date(now).toISOString()
      })
    })
    await controller.initialize()
    await controller.saveOkxCredentials({
      apiKey: 'api-key-loop-sensitive',
      secretKey: 'secret-loop-sensitive',
      passphrase: 'passphrase-loop-sensitive'
    })
    await controller.connectOkx()

    const internals = controller as unknown as {
      setConnection(
        key: 'telegram' | 'chatgpt' | 'okx',
        phase: 'connected',
        detail?: string
      ): void
      coordinator: {
        process(
          message: TelegramMessagePayload,
          authorizationToken?: SignalTradeAuthorizationToken
        ): Promise<SignalRecord | undefined>
      }
      handleTelegramStatus(status: {
        state: 'connected' | 'reconnecting'
        at: string
        detail?: string
      }): void
      handleTelegramError(event: {
        at: string
        message: string
        code?: string
        recoverable: boolean
        cause: Error
      }): Promise<void>
      handleChatGptStatus(status: {
        initialized: boolean
        authenticated: boolean
        busy: boolean
        warmedUp: boolean
        account: null
        selectedModel: string | null
        reasoningEffort: string | null
        rateLimits: null
        lastError: string | null
      }): void
    }
    installReadyTelegram(controller)
    internals.setConnection('telegram', 'connected', 'test')
    internals.setConnection('chatgpt', 'connected', 'test')
    await controller.startMonitoring()
    await controller.armLiveTrading('确认实盘')

    await internals.handleTelegramError({
      at: new Date(now).toISOString(),
      message: 'test recoverable RPC warning',
      code: 'RPC_TRANSIENT',
      recoverable: true,
      cause: new Error('test recoverable RPC warning')
    })
    expect(controller.getSnapshot()).toMatchObject({
      connections: { telegram: { phase: 'connected' } },
      safety: { liveArmed: true }
    })

    internals.handleTelegramStatus({
      state: 'reconnecting',
      at: new Date(now).toISOString(),
      detail: 'test reconnect'
    })
    expect(controller.getSnapshot()).toMatchObject({
      connections: { telegram: { phase: 'connecting' } },
      safety: { liveArmed: false }
    })
    internals.handleTelegramStatus({
      state: 'connected',
      at: new Date(now).toISOString(),
      detail: 'test restored'
    })
    expect(controller.getSnapshot().safety.liveArmed).toBe(false)
    await controller.armLiveTrading('确认实盘')

    internals.handleChatGptStatus({
      initialized: true,
      authenticated: true,
      busy: false,
      warmedUp: true,
      account: null,
      selectedModel: 'test-fast',
      reasoningEffort: null,
      rateLimits: null,
      lastError: 'test model unavailable'
    })
    expect(controller.getSnapshot()).toMatchObject({
      connections: { chatgpt: { phase: 'error' } },
      safety: { liveArmed: false }
    })
    internals.handleChatGptStatus({
      initialized: true,
      authenticated: true,
      busy: false,
      warmedUp: true,
      account: null,
      selectedModel: 'test-fast',
      reasoningEffort: null,
      rateLimits: null,
      lastError: null
    })
    expect(controller.getSnapshot().safety.liveArmed).toBe(false)
    await controller.armLiveTrading('确认实盘')

    const payload: TelegramMessagePayload = {
      channelId: 'bwe',
      messageId: 9001,
      channelUsername: 'BWEnews',
      text: 'Coinbase will list ABC',
      date: now,
      receivedAt: now,
      permalink: 'https://t.me/BWEnews/9001'
    }
    await expect(internals.coordinator.process(
      payload,
      captureSignalAuthorization(controller)
    )).resolves.toMatchObject({
      stage: 'submitted',
      clientOrderId: 'bwe-loop-1'
    })
    expect(submitPreparedMarketOrder).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().signals[0]).toMatchObject({ stage: 'submitted' })
    expect(controller.getSnapshot().signals[0]?.orderState).toBeUndefined()

    const filled: OkxOrderUpdate = {
      instId: 'ABC-USDT-SWAP',
      ordId: 'order-loop-1',
      clOrdId: 'bwe-loop-1',
      state: 'filled',
      fillSz: '1',
      accFillSz: '1',
      avgPx: '10',
      tradeId: 'trade-loop-1',
      uTime: String(now)
    }
    stream.emit('orders', [filled])
    await vi.waitFor(() => {
      expect(controller.getSnapshot().signals[0]).toMatchObject({
        stage: 'filled',
        orderState: 'filled',
        filledContracts: '1'
      })
    })
    const auditPath = path.join(userDataDirectory, 'audit', 'events.jsonl')
    await vi.waitFor(async () => {
      expect(await readFile(auditPath, 'utf8')).toContain('order_state_updated')
    })
    const notificationsAfterFill = controller.getSnapshot().notifications.length
    const refreshesAfterFill = getPositions.mock.calls.length
    const auditAfterFill = await readFile(auditPath, 'utf8')
    const stateAuditCount = auditAfterFill.match(/"event":"order_state_updated"/g)?.length ?? 0

    stream.emit('orders', [filled])
    await vi.waitFor(() => expect(getPositions.mock.calls.length).toBeGreaterThan(refreshesAfterFill))
    expect(controller.getSnapshot().notifications).toHaveLength(notificationsAfterFill)
    const auditAfterDuplicate = await readFile(auditPath, 'utf8')
    expect(auditAfterDuplicate.match(/"event":"order_state_updated"/g)?.length ?? 0).toBe(stateAuditCount)
    expect(submitPreparedMarketOrder).toHaveBeenCalledOnce()

    stream.emit('error', new Error('test stream disconnected'))
    await vi.waitFor(() => {
      expect(controller.getSnapshot()).toMatchObject({
        connections: { okx: { phase: 'error' } },
        safety: { liveArmed: false }
      })
    })
    await expect(controller.armLiveTrading('确认实盘')).rejects.toThrow('OKX 尚未连接')

    await controller.dispose()
  })

  it('allows an explicitly confirmed reduce-only close while monitoring, AI, and emergency gates are off', async () => {
    const test = await createPositionCloseHarness()

    // This simultaneously represents stopped monitoring, disconnected AI,
    // and the emergency-stop state. Risk reduction must remain available.
    await test.controller.emergencyStop()
    expect(test.controller.getSnapshot()).toMatchObject({
      connections: { chatgpt: { phase: 'disconnected' } },
      safety: {
        monitoring: false,
        emergencyStopped: true,
        liveArmed: false
      }
    })

    await expect(test.controller.closePosition({
      instrumentId: 'ABC-USDT-SWAP',
      confirmation: '确认平仓'
    })).resolves.toBeUndefined()

    expect(test.closeEntirePosition).toHaveBeenCalledOnce()
    expect(test.closeEntirePosition).toHaveBeenCalledWith(expect.objectContaining({
      instId: 'ABC-USDT-SWAP',
      method: 'reduce-only',
      arm: expect.objectContaining({ scope: 'close' })
    }))
    expect(test.runtimeArmed()).toBe(false)
    expect(test.controller.getSnapshot().safety.liveArmed).toBe(false)

    await test.controller.dispose()
  })

  it('rejects an incorrect close confirmation without sending an OKX request', async () => {
    const test = await createPositionCloseHarness()

    await expect(test.controller.closePosition({
      instrumentId: 'ABC-USDT-SWAP',
      confirmation: '确认'
    })).rejects.toThrow('请输入“确认平仓”')

    expect(test.closeEntirePosition).not.toHaveBeenCalled()
    expect(test.armNextLiveTrade).not.toHaveBeenCalled()
    expect(test.runtimeArmed()).toBe(false)
    expect(test.controller.getSnapshot().safety.liveArmed).toBe(false)

    await test.controller.dispose()
  })

  it('invalidates old opening authorization synchronously and blocks signals for the full close transaction', async () => {
    let resolveClose!: (value: {
      instId: string
      method: 'reduce-only'
      ordId: string
      clOrdId: string
      closedSize: string
      executionState: 'pending_confirmation'
      requestedAt: number
    }) => void
    const closeGate = new Promise<{
      instId: string
      method: 'reduce-only'
      ordId: string
      clOrdId: string
      closedSize: string
      executionState: 'pending_confirmation'
      requestedAt: number
    }>((resolve) => {
      resolveClose = resolve
    })
    const analyzeSignal = vi.fn(async () => ({
      symbols: ['XYZ'],
      decision: 'LONG' as const,
      confidence: 0.99,
      reason: 'test signal',
      status: 'ok' as const,
      model: 'test-fast',
      latencyMs: 1,
      analyzedAt: new Date(1_700_000_000_000).toISOString()
    }))
    const test = await createPositionCloseHarness({
      analyzeSignal,
      closeEntirePosition: async () => closeGate
    })
    const internals = test.controller as unknown as {
      setConnection(
        key: 'telegram' | 'chatgpt' | 'okx',
        phase: 'connected',
        detail?: string
      ): void
      coordinator: {
        process(
          message: TelegramMessagePayload,
          authorizationToken?: SignalTradeAuthorizationToken
        ): Promise<SignalRecord | undefined>
      }
    }
    internals.setConnection('telegram', 'connected', 'test')
    internals.setConnection('chatgpt', 'connected', 'test')
    await test.controller.startMonitoring()
    await test.controller.armLiveTrading('确认实盘')
    expect(test.controller.getSnapshot().safety.liveArmed).toBe(true)

    const closing = test.controller.closePosition({
      instrumentId: 'ABC-USDT-SWAP',
      confirmation: '确认平仓'
    })
    // No await is needed: the public close boundary disarms both layers before
    // it yields to the position refresh.
    expect(test.controller.getSnapshot().safety.liveArmed).toBe(false)

    await vi.waitFor(() => expect(test.closeEntirePosition).toHaveBeenCalledOnce())
    expect(test.controller.getSnapshot().safety.canArm).toBe(false)
    await expect(test.controller.armLiveTrading('确认实盘')).rejects.toThrow('平仓')

    const payload: TelegramMessagePayload = {
      channelId: 'bwe',
      messageId: 9201,
      channelUsername: 'BWEnews',
      text: 'Coinbase will list XYZ',
      date: 1_700_000_000_000,
      receivedAt: 1_700_000_000_000,
      permalink: 'https://t.me/BWEnews/9201'
    }
    await expect(internals.coordinator.process(
      payload,
      captureSignalAuthorization(test.controller)
    )).resolves.toBeUndefined()
    expect(analyzeSignal).not.toHaveBeenCalled()
    expect(test.prepareMarketOrder).not.toHaveBeenCalled()
    expect(test.submitPreparedMarketOrder).not.toHaveBeenCalled()

    resolveClose({
      instId: 'ABC-USDT-SWAP',
      method: 'reduce-only',
      ordId: 'close-order-gated',
      clOrdId: 'bwe-close-gated',
      closedSize: '1',
      executionState: 'pending_confirmation',
      requestedAt: 1_700_000_000_000
    })
    await closing
    expect(test.runtimeArmed()).toBe(false)
    expect(test.setLiveTradingArmed).toHaveBeenLastCalledWith(false)
    expect(test.controller.getSnapshot().safety.liveArmed).toBe(false)

    await test.controller.dispose()
  })

  it('blocks a signal already inside opening preflight without canceling the confirmed close capability', async () => {
    let resolvePrepare!: (value: unknown) => void
    const prepareGate = new Promise<unknown>((resolve) => {
      resolvePrepare = resolve
    })
    let resolveClose!: (value: OkxCloseResult) => void
    const closeGate = new Promise<OkxCloseResult>((resolve) => {
      resolveClose = resolve
    })
    const test = await createPositionCloseHarness({
      positionPresent: false,
      analyzeSignal: async () => ({
        symbols: ['XYZ'],
        decision: 'LONG',
        confidence: 0.99,
        reason: 'test signal already in preflight',
        status: 'ok',
        model: 'test-fast',
        latencyMs: 1,
        analyzedAt: new Date(1_700_000_000_000).toISOString()
      }),
      prepareMarketOrder: async () => prepareGate,
      closeEntirePosition: async () => closeGate
    })
    const internals = test.controller as unknown as {
      setConnection(
        key: 'telegram' | 'chatgpt' | 'okx',
        phase: 'connected',
        detail?: string
      ): void
      coordinator: {
        process(
          message: TelegramMessagePayload,
          authorizationToken?: SignalTradeAuthorizationToken
        ): Promise<SignalRecord | undefined>
      }
    }
    internals.setConnection('telegram', 'connected', 'test')
    internals.setConnection('chatgpt', 'connected', 'test')
    await test.controller.startMonitoring()
    await test.controller.armLiveTrading('确认实盘')

    const signal = internals.coordinator.process({
      channelId: 'bwe',
      messageId: 9202,
      channelUsername: 'BWEnews',
      text: 'Coinbase will list XYZ',
      date: 1_700_000_000_000,
      receivedAt: 1_700_000_000_000,
      permalink: 'https://t.me/BWEnews/9202'
    }, captureSignalAuthorization(test.controller))
    await vi.waitFor(() => expect(test.prepareMarketOrder).toHaveBeenCalledOnce())

    // Make the close target visible only after the signal has crossed its
    // position read. This deterministically exercises the controller's own
    // post-preview safety gate rather than only the coordinator's early gate.
    test.setPositionPresent(true)
    const closing = test.controller.closePosition({
      instrumentId: 'ABC-USDT-SWAP',
      confirmation: '确认平仓'
    })
    await vi.waitFor(() => expect(test.closeEntirePosition).toHaveBeenCalledOnce())
    expect(test.runtimeArmed()).toBe(true)

    resolvePrepare({ intentToken: 'old-open-intent', expiresAt: 1_700_000_010_000 })
    await expect(signal).resolves.toMatchObject({ stage: 'failed' })
    expect(test.submitPreparedMarketOrder).not.toHaveBeenCalled()
    // The failed old signal runs the generic disarm hook. It must leave the
    // already-confirmed, close-scoped capability intact until the close ends.
    expect(test.runtimeArmed()).toBe(true)
    expect(test.controller.getSnapshot().safety.liveArmed).toBe(false)

    resolveClose({
      instId: 'ABC-USDT-SWAP',
      method: 'reduce-only',
      ordId: 'close-order-preflight-race',
      clOrdId: 'bwe-close-preflight-race',
      closedSize: '1',
      executionState: 'pending_confirmation',
      requestedAt: 1_700_000_000_000
    })
    await closing
    expect(test.runtimeArmed()).toBe(false)
    expect(test.setLiveTradingArmed).toHaveBeenLastCalledWith(false)

    await test.controller.dispose()
  })

  it('clears a locally unknown close only from a safe reconciled absence result', async () => {
    const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'bwe-controller-close-absence-'))
    temporaryDirectories.push(userDataDirectory)
    const controller = new AppController({
      userDataDirectory,
      version: 'test',
      openExternal: async () => undefined,
      now: () => 1_700_000_030_000
    })
    await controller.initialize()
    const position: AppPosition = {
      instrumentId: 'ABC-USDT-SWAP',
      direction: 'long',
      contracts: 1,
      averagePrice: 10,
      markPrice: 10,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
      leverage: 1,
      marginMode: 'isolated',
      closePending: true,
      closeOrderState: 'unknown',
      updatedAt: 1_700_000_030_000
    }
    const internals = controller as unknown as {
      positions: AppPosition[]
      pendingPositionCloses: Map<string, {
        instrumentId: string
        clientOrderId?: string
        state: 'unknown'
        submittedAt: number
      }>
      resolveUnknownOrderWithoutExchangeOrder(
        error: OkxOrderStateUnknownError,
        result: {
          safeToClear: boolean
          positions: Array<{
            instType: string
            instId: string
            posSide: string
            pos: string
            mgnMode: string
          }>
          reason: string
        }
      ): Promise<void>
    }
    internals.positions = [position]
    internals.pendingPositionCloses.set('ABC-USDT-SWAP', {
      instrumentId: 'ABC-USDT-SWAP',
      clientOrderId: 'bwe-close-absent-1',
      state: 'unknown',
      submittedAt: 1_700_000_000_000
    })
    const error = new OkxOrderStateUnknownError(
      'ABC-USDT-SWAP',
      'bwe-close-absent-1',
      'close',
      1_700_000_000_000
    )
    await expect(internals.resolveUnknownOrderWithoutExchangeOrder(error, {
      safeToClear: false,
      positions: [],
      reason: 'Only one not-found observation'
    })).rejects.toThrow('拒绝根据单次未找到结果')
    expect(internals.pendingPositionCloses.size).toBe(1)

    await internals.resolveUnknownOrderWithoutExchangeOrder(error, {
      safeToClear: true,
      positions: [{
        instType: 'SWAP',
        instId: 'ABC-USDT-SWAP',
        posSide: 'net',
        pos: '1',
        mgnMode: 'isolated'
      }],
      reason: 'No matching order after the bounded consistency window'
    })

    expect(internals.pendingPositionCloses.size).toBe(0)
    expect(controller.getSnapshot().positions[0]).not.toHaveProperty('closePending')
    const audit = await readFile(path.join(userDataDirectory, 'audit', 'events.jsonl'), 'utf8')
    expect(audit).toContain('position_close_absence_confirmed')
    await controller.dispose()
  })
})

function healthyVerification(): OkxAccountVerification {
  return {
    ok: true,
    config: {
      acctLv: '2',
      posMode: 'net_mode',
      perm: 'read_only,trade',
      type: '1',
      ip: ''
    },
    checks: {
      hasReadPermission: true,
      hasTradePermission: true,
      hasNoWithdrawPermission: true,
      isSubAccount: true,
      isNetPositionMode: true,
      supportsDerivatives: true,
      supportsIsolatedSwapTrading: true,
      hasNoPendingSwapOrders: true
    },
    pendingSwapOrders: [],
    errors: [],
    warnings: []
  }
}

async function createPositionCloseHarness(options: {
  analyzeSignal?: AppControllerOptions['analyzeSignal']
  closeEntirePosition?: (input: CloseOkxPositionInput) => Promise<OkxCloseResult>
  prepareMarketOrder?: () => Promise<unknown>
  positionPresent?: boolean
} = {}) {
  const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'bwe-controller-close-safety-'))
  temporaryDirectories.push(userDataDirectory)
  const now = 1_700_000_000_000
  let runtimeArmed = false
  let positionPresent = options.positionPresent ?? true
  const stream = Object.assign(new EventEmitter(), {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn()
  }) as unknown as OkxPrivateStream
  const rawPosition: OkxPosition = {
    instType: 'SWAP',
    instId: 'ABC-USDT-SWAP',
    posSide: 'net',
    pos: '1',
    mgnMode: 'isolated',
    avgPx: '10',
    markPx: '10',
    upl: '0',
    uplRatio: '0',
    lever: '1',
    uTime: String(now)
  }
  const setLiveTradingArmed = vi.fn((armed: boolean) => {
    runtimeArmed = armed
  })
  const armNextLiveTrade = vi.fn((scope: 'open' | 'close') => {
    if (!runtimeArmed) throw new Error('test runtime is not armed')
    return {
      token: `arm-${scope}`,
      scope,
      runtimeArmed: true as const,
      expiresAt: now + 30_000
    }
  })
  const closeEntirePosition = vi.fn(async (input: CloseOkxPositionInput) => {
    if (!runtimeArmed) throw new Error('test runtime was disarmed before close')
    if (options.closeEntirePosition) return options.closeEntirePosition(input)
    return {
      instId: input.instId,
      method: 'reduce-only' as const,
      ordId: 'close-order-1',
      clOrdId: 'bwe-close-1',
      closedSize: '1',
      executionState: 'pending_confirmation' as const,
      requestedAt: now
    }
  })
  const prepareMarketOrder = vi.fn(async () => {
    if (options.prepareMarketOrder) return options.prepareMarketOrder()
    return {
      intentToken: 'unexpected-open-intent',
      expiresAt: now + 10_000
    }
  })
  const submitPreparedMarketOrder = vi.fn(async () => {
    throw new Error('unexpected opening order')
  })
  const fakeClient = {
    get restRouteSelection() { return { route: 'direct' as const } },
    get privateWebSocketRouteSelection() { return { route: 'direct' as const } },
    get isLiveTradingArmed() { return runtimeArmed },
    get requiresOrderReconciliation() { return false },
    verifyAccountConfiguration: vi.fn(async () => healthyVerification()),
    setLiveTradingArmed,
    getInstruments: vi.fn(async () => []),
    getPositions: vi.fn(async () => positionPresent ? [structuredClone(rawPosition)] : []),
    getPendingOrders: vi.fn(async () => []),
    getOrder: vi.fn(async () => undefined),
    createPrivateStream: vi.fn(() => stream),
    armNextLiveTrade,
    closeEntirePosition,
    prepareMarketOrder,
    submitPreparedMarketOrder
  } as unknown as OkxV5Client
  const controller = new AppController({
    userDataDirectory,
    version: 'test',
    openExternal: async () => undefined,
    now: () => now,
    createOkxClient: () => fakeClient,
    ...(options.analyzeSignal ? { analyzeSignal: options.analyzeSignal } : {})
  })
  await controller.initialize()
  installReadyTelegram(controller)
  await controller.saveOkxCredentials({
    apiKey: 'api-key-close-sensitive',
    secretKey: 'secret-close-sensitive',
    passphrase: 'passphrase-close-sensitive'
  })
  await controller.connectOkx()

  return {
    controller,
    closeEntirePosition,
    armNextLiveTrade,
    prepareMarketOrder,
    submitPreparedMarketOrder,
    setLiveTradingArmed,
    runtimeArmed: () => runtimeArmed,
    setPositionPresent: (present: boolean) => {
      positionPresent = present
    }
  }
}

async function createCredentialLifecycleHarness(options: {
  initialPositions?: OkxPosition[]
} = {}) {
  const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'bwe-controller-credential-lifecycle-'))
  temporaryDirectories.push(userDataDirectory)
  const now = 1_700_000_000_000
  let positions = structuredClone(options.initialPositions ?? [])
  let pendingOrders: OkxOrder[] = []
  let pendingAlgoOrders: OkxAlgoOrder[] = []
  let runtimeArmed = false
  const stream = Object.assign(new EventEmitter(), {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn()
  }) as unknown as OkxPrivateStream
  const getPositions = vi.fn(async () => structuredClone(positions))
  const getPendingOrders = vi.fn(async () => structuredClone(pendingOrders))
  const getPendingAlgoOrders = vi.fn(async () => structuredClone(pendingAlgoOrders))
  const setLiveTradingArmed = vi.fn((armed: boolean) => {
    runtimeArmed = armed
  })
  const closeEntirePosition = vi.fn(async (input: CloseOkxPositionInput): Promise<OkxCloseResult> => ({
    instId: input.instId,
    method: 'reduce-only',
    ordId: 'close-lifecycle-order',
    clOrdId: 'bwe-close-lifecycle',
    closedSize: '1',
    executionState: 'pending_confirmation',
    requestedAt: now
  }))
  const fakeClient = {
    get restRouteSelection() { return { route: 'direct' as const } },
    get privateWebSocketRouteSelection() { return { route: 'direct' as const } },
    get isLiveTradingArmed() { return runtimeArmed },
    get requiresOrderReconciliation() { return false },
    verifyAccountConfiguration: vi.fn(async () => healthyVerification()),
    setLiveTradingArmed,
    getInstruments: vi.fn(async () => []),
    getPositions,
    getPendingOrders,
    getPendingAlgoOrders,
    getOrder: vi.fn(async () => undefined),
    createPrivateStream: vi.fn(() => stream),
    armNextLiveTrade: vi.fn((scope: 'open' | 'close') => ({
      token: `arm-${scope}`,
      scope,
      runtimeArmed: true as const,
      expiresAt: now + 30_000
    })),
    closeEntirePosition
  } as unknown as OkxV5Client
  const controller = new AppController({
    userDataDirectory,
    version: 'test',
    openExternal: async () => undefined,
    now: () => now,
    createOkxClient: () => fakeClient
  })
  await controller.initialize()
  installReadyTelegram(controller)
  const originalCredentials = {
    apiKey: 'api-key-lifecycle-original-sensitive',
    secretKey: 'secret-lifecycle-original-sensitive',
    passphrase: 'passphrase-lifecycle-original-sensitive'
  }
  const replacementCredentials = {
    apiKey: 'api-key-lifecycle-replacement-sensitive',
    secretKey: 'secret-lifecycle-replacement-sensitive',
    passphrase: 'passphrase-lifecycle-replacement-sensitive'
  }
  await controller.saveOkxCredentials(originalCredentials)
  await controller.connectOkx()
  const internals = controller as unknown as {
    setConnection(
      key: 'telegram' | 'chatgpt' | 'okx',
      phase: 'connected',
      detail?: string
    ): void
    secretStore: { get(key: string): Promise<string | undefined> }
    telegram?: {
      readonly liveTradingReadiness: { ready: boolean; revision: number }
      stop(): Promise<void>
    }
  }

  return {
    controller,
    originalCredentials,
    replacementCredentials,
    getPositions,
    getPendingOrders,
    getPendingAlgoOrders,
    closeEntirePosition,
    setLiveTradingArmed,
    stream,
    internals,
    setPositions: (next: OkxPosition[]) => { positions = structuredClone(next) },
    setPendingOrders: (next: OkxOrder[]) => { pendingOrders = structuredClone(next) },
    setPendingAlgoOrders: (next: OkxAlgoOrder[]) => { pendingAlgoOrders = structuredClone(next) },
    savedCredentials: async () => {
      const raw = await internals.secretStore.get('okx.credentials.v1')
      return raw ? JSON.parse(raw) as typeof originalCredentials : undefined
    }
  }
}

function lifecycleTestPosition(): OkxPosition {
  return {
    instType: 'SWAP',
    instId: 'ABC-USDT-SWAP',
    posSide: 'net',
    pos: '1',
    mgnMode: 'isolated',
    avgPx: '10',
    markPx: '10',
    upl: '0',
    uplRatio: '0',
    lever: '1'
  }
}
