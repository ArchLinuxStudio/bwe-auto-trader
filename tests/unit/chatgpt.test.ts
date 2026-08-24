import { describe, expect, it, vi } from 'vitest'

import {
  ChatGptService,
  parseSignalOutput,
  selectFastestModel,
  type AppServerNotification,
  type AppServerRequestOptions,
  type CodexAppServerTransport,
} from '../../src/main/services/chatgpt'

interface RequestCall {
  method: string
  params: unknown
  options: AppServerRequestOptions | undefined
}

class MockTransport implements CodexAppServerTransport {
  readonly calls: RequestCall[] = []
  readonly notifications: Array<{ method: string; params: unknown }> = []
  started = false
  closed = false
  private readonly listeners = new Set<(notification: AppServerNotification) => void>()
  private readonly handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>()

  handle(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void {
    this.handlers.set(method, handler)
  }

  emit(method: string, params?: unknown): void {
    for (const listener of this.listeners) listener({ method, params })
  }

  async start(): Promise<void> {
    this.started = true
  }

  async request<T>(method: string, params?: unknown, options?: AppServerRequestOptions): Promise<T> {
    this.calls.push({ method, params, options })
    if (options?.signal?.aborted) throw abortError()
    const handler = this.handlers.get(method)
    if (!handler) throw new Error(`Unexpected request: ${method}`)

    const result = await Promise.race([
      Promise.resolve(handler(params)),
      ...(options?.signal
        ? [
            new Promise<never>((_, reject) => {
              options.signal?.addEventListener('abort', () => reject(abortError()), { once: true })
            }),
          ]
        : []),
    ])
    return result as T
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params })
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function configuredTransport(): MockTransport {
  const transport = new MockTransport()
  transport.handle('initialize', () => ({ userAgent: 'mock' }))
  transport.handle('account/read', () => ({
    account: { type: 'chatgpt', email: 'test@example.com', planType: 'plus' },
    requiresOpenaiAuth: true,
  }))
  transport.handle('model/list', () => ({
    data: [
      {
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        isDefault: true,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
      },
      {
        id: 'gpt-5.6-luna',
        model: 'gpt-5.6-luna',
        supportedReasoningEfforts: [
          { reasoningEffort: 'none' },
          { reasoningEffort: 'low' },
        ],
      },
    ],
    nextCursor: null,
  }))
  transport.handle('account/rateLimits/read', () => ({
    rateLimits: { primary: { usedPercent: 10 }, rateLimitReachedType: null },
  }))
  transport.handle('thread/start', () => ({ thread: { id: 'thread-1' } }))
  transport.handle('turn/interrupt', () => ({}))
  return transport
}

describe('ChatGptService', () => {
  it('initializes the protocol, selects the low-latency model, and prewarms a thread', async () => {
    const transport = configuredTransport()
    const service = new ChatGptService({ transport })

    await service.start()

    expect(transport.started).toBe(true)
    expect(transport.calls.map((call) => call.method)).toEqual([
      'initialize',
      'account/read',
      'model/list',
      'account/rateLimits/read',
      'thread/start',
    ])
    expect(transport.notifications).toContainEqual({ method: 'initialized', params: undefined })
    const initializeCall = transport.calls.find((call) => call.method === 'initialize')
    expect(initializeCall?.params).toMatchObject({
      clientInfo: { name: 'bwe_auto_trader' },
      capabilities: { optOutNotificationMethods: expect.arrayContaining(['item/agentMessage/delta']) },
    })
    expect(service.getStatus()).toMatchObject({
      initialized: true,
      authenticated: true,
      warmedUp: true,
      selectedModel: 'gpt-5.6-luna',
      reasoningEffort: 'none',
    })

    const threadCall = transport.calls.find((call) => call.method === 'thread/start')
    expect(threadCall?.params).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      config: {
        web_search: 'disabled',
        features: { shell_tool: false, web_search: false, plugins: false },
      },
    })
  })

  it('returns a strict structured signal and never exposes an order action', async () => {
    const transport = configuredTransport()
    transport.handle('turn/start', () => {
      queueMicrotask(() => {
        transport.emit('item/completed', {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'agentMessage',
            phase: 'final_answer',
            text: JSON.stringify({
              symbols: ['BTC'],
              decision: 'LONG',
              confidence: 0.91,
              reason: 'ETF approval is bullish',
            }),
          },
        })
        transport.emit('turn/completed', {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', items: [] },
        })
      })
      return { turn: { id: 'turn-1', status: 'inProgress' } }
    })
    const service = new ChatGptService({ transport })

    const result = await service.analyze('Breaking: Bitcoin spot ETF approved')

    expect(result).toMatchObject({
      symbols: ['BTC'],
      decision: 'LONG',
      confidence: 0.91,
      status: 'ok',
      model: 'gpt-5.6-luna',
    })
    expect(result).not.toHaveProperty('order')

    const turnCall = transport.calls.find(
      (call) =>
        call.method === 'turn/start' &&
        typeof call.params === 'object' &&
        call.params !== null &&
        'input' in call.params,
    )
    expect(turnCall?.params).toMatchObject({
      model: 'gpt-5.6-luna',
      effort: 'none',
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'readOnly',
        access: { type: 'restricted', includePlatformDefaults: true, readableRoots: [] },
      },
      outputSchema: {
        required: ['symbols', 'decision', 'confidence', 'reason'],
        additionalProperties: false,
      },
    })
    expect(JSON.stringify(turnCall?.params)).not.toContain('placeOrder')
  })

  it('interrupts a timed-out turn and returns a typed SKIP result', async () => {
    const transport = configuredTransport()
    transport.handle('turn/start', () => ({ turn: { id: 'slow-turn', status: 'inProgress' } }))
    const service = new ChatGptService({ transport, timeoutMs: 20 })

    const result = await service.analyze('A message that never completes')
    await vi.waitFor(() => {
      expect(transport.calls.some((call) => call.method === 'turn/interrupt')).toBe(true)
    })

    expect(result).toMatchObject({
      symbols: [],
      decision: 'SKIP',
      confidence: 0,
      status: 'skipped',
      failureCode: 'timeout',
    })
  })

  it('detects secondary quota exhaustion and preserves it across sparse updates', async () => {
    const transport = configuredTransport()
    let secondaryUsedPercent = 100
    let spendControlReached = false
    transport.handle('account/rateLimits/read', () => ({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 12 },
        secondary: { usedPercent: secondaryUsedPercent },
        rateLimitReachedType: null,
        spendControlReached,
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: { usedPercent: 12 },
          secondary: { usedPercent: secondaryUsedPercent },
          rateLimitReachedType: null,
          spendControlReached,
        },
      },
    }))
    const service = new ChatGptService({ transport })

    await service.start()
    expect(service.getStatus()).toMatchObject({
      quotaExhausted: true,
      lastError: null,
    })
    await expect(service.analyze('Message while weekly quota is exhausted')).resolves.toMatchObject({
      decision: 'SKIP',
      status: 'skipped',
      failureCode: 'quota_exceeded',
    })
    expect(transport.calls.some((call) => call.method === 'turn/start')).toBe(false)

    transport.emit('account/rateLimits/updated', {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 20 },
        secondary: null,
        spendControlReached: null,
      },
    })
    expect(service.getStatus()).toMatchObject({
      quotaExhausted: true,
      rateLimits: {
        rateLimits: {
          primary: { usedPercent: 20 },
          secondary: { usedPercent: 100 },
        },
        rateLimitsByLimitId: {
          codex: { secondary: { usedPercent: 100 } },
        },
      },
    })

    secondaryUsedPercent = 30
    transport.emit('account/rateLimits/updated', {
      rateLimits: {
        limitId: 'codex',
        secondary: { usedPercent: 30 },
        spendControlReached: null,
      },
    })
    await vi.waitFor(() => expect(service.getStatus()).toMatchObject({
      quotaExhausted: false,
      rateLimits: {
        rateLimits: { secondary: { usedPercent: 30 } },
        rateLimitsByLimitId: {
          codex: { secondary: { usedPercent: 30 } },
        },
      },
    }))

    spendControlReached = true
    transport.emit('account/rateLimits/updated', {
      rateLimits: { limitId: 'codex', spendControlReached: true },
    })
    expect(service.getStatus().quotaExhausted).toBe(true)

    transport.emit('account/rateLimits/updated', {
      rateLimits: { limitId: 'codex', spendControlReached: null },
    })
    await vi.waitFor(() => expect(service.getStatus().quotaExhausted).toBe(true))

    spendControlReached = false
    transport.emit('account/rateLimits/updated', {
      rateLimits: { limitId: 'codex', spendControlReached: false },
    })
    await vi.waitFor(() => expect(service.getStatus().quotaExhausted).toBe(false))
  })

  it('keeps known exhaustion while a recovery refresh is pending or fails', async () => {
    const transport = configuredTransport()
    const failedRefresh = deferred<unknown>()
    const recoveredRefresh = deferred<unknown>()
    let readCount = 0
    transport.handle('account/rateLimits/read', () => {
      readCount += 1
      if (readCount === 1) {
        return { rateLimits: { secondary: { usedPercent: 100 } } }
      }
      if (readCount === 2) return failedRefresh.promise
      if (readCount === 3) return recoveredRefresh.promise
      throw new Error(`Unexpected rate-limit read ${readCount}`)
    })
    const service = new ChatGptService({ transport })

    await service.start()
    expect(service.getStatus().quotaExhausted).toBe(true)

    transport.emit('account/rateLimits/updated', {
      rateLimits: { secondary: { usedPercent: 25 } },
    })
    await vi.waitFor(() => expect(readCount).toBe(2))
    expect(service.getStatus().quotaExhausted).toBe(true)

    failedRefresh.reject(new Error('rate-limit refresh unavailable'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(service.getStatus().quotaExhausted).toBe(true)

    transport.emit('account/rateLimits/updated', {
      rateLimits: { secondary: { usedPercent: 20 } },
    })
    await vi.waitFor(() => expect(readCount).toBe(3))
    expect(service.getStatus().quotaExhausted).toBe(true)

    recoveredRefresh.resolve({
      rateLimits: { secondary: { usedPercent: 20 } },
    })
    await vi.waitFor(() => expect(service.getStatus().quotaExhausted).toBe(false))
  })

  it('discards a stale recovery read superseded by a newer exhaustion notification', async () => {
    const transport = configuredTransport()
    const staleRecovery = deferred<unknown>()
    const latestRefresh = deferred<unknown>()
    let readCount = 0
    transport.handle('account/rateLimits/read', () => {
      readCount += 1
      if (readCount === 1) {
        return { rateLimits: { secondary: { usedPercent: 100 } } }
      }
      if (readCount === 2) return staleRecovery.promise
      if (readCount === 3) return latestRefresh.promise
      throw new Error(`Unexpected rate-limit read ${readCount}`)
    })
    const service = new ChatGptService({ transport })

    await service.start()
    const observedQuotaStates: boolean[] = []
    service.onStatus((status) => observedQuotaStates.push(status.quotaExhausted))

    transport.emit('account/rateLimits/updated', {
      rateLimits: { secondary: { usedPercent: 20 } },
    })
    await vi.waitFor(() => expect(readCount).toBe(2))

    transport.emit('account/rateLimits/updated', {
      rateLimits: { secondary: { usedPercent: 100 } },
    })
    staleRecovery.resolve({
      rateLimits: { secondary: { usedPercent: 20 } },
    })

    await vi.waitFor(() => expect(readCount).toBe(3))
    expect(service.getStatus().quotaExhausted).toBe(true)
    expect(observedQuotaStates).not.toContain(false)

    latestRefresh.resolve({
      rateLimits: { secondary: { usedPercent: 100 } },
    })
    await vi.waitFor(() => expect(service.getStatus().rateLimits).toMatchObject({
      rateLimits: { secondary: { usedPercent: 100 } },
    }))
    expect(service.getStatus().quotaExhausted).toBe(true)
    expect(observedQuotaStates).not.toContain(false)
  })

  it('does not let the initial full read overwrite newer exhaustion evidence', async () => {
    const transport = configuredTransport()
    const staleInitialRead = deferred<unknown>()
    const latestRefresh = deferred<unknown>()
    let readCount = 0
    transport.handle('account/rateLimits/read', () => {
      readCount += 1
      if (readCount === 1) return staleInitialRead.promise
      if (readCount === 2) return latestRefresh.promise
      throw new Error(`Unexpected rate-limit read ${readCount}`)
    })
    const service = new ChatGptService({ transport })

    const start = service.start()
    await vi.waitFor(() => expect(readCount).toBe(1))
    transport.emit('account/rateLimits/updated', {
      rateLimits: { secondary: { usedPercent: 100 } },
    })
    const observedQuotaStates: boolean[] = []
    service.onStatus((status) => observedQuotaStates.push(status.quotaExhausted))

    staleInitialRead.resolve({
      rateLimits: { secondary: { usedPercent: 10 } },
    })
    await vi.waitFor(() => expect(readCount).toBe(2))
    expect(service.getStatus().quotaExhausted).toBe(true)
    expect(observedQuotaStates).not.toContain(false)

    latestRefresh.resolve({
      rateLimits: { secondary: { usedPercent: 100 } },
    })
    await start
    await vi.waitFor(() => expect(service.getStatus().rateLimits).toMatchObject({
      rateLimits: { secondary: { usedPercent: 100 } },
    }))
    expect(service.getStatus().quotaExhausted).toBe(true)
    expect(observedQuotaStates).not.toContain(false)
  })

  it('does not let a public full read overwrite newer exhaustion evidence', async () => {
    const transport = configuredTransport()
    const stalePublicRead = deferred<unknown>()
    const latestRefresh = deferred<unknown>()
    let readCount = 0
    transport.handle('account/rateLimits/read', () => {
      readCount += 1
      if (readCount === 1) {
        return { rateLimits: { secondary: { usedPercent: 10 } } }
      }
      if (readCount === 2) return stalePublicRead.promise
      if (readCount === 3) return latestRefresh.promise
      throw new Error(`Unexpected rate-limit read ${readCount}`)
    })
    const service = new ChatGptService({ transport })

    await service.start()
    const publicRead = service.readRateLimits()
    await vi.waitFor(() => expect(readCount).toBe(2))
    transport.emit('account/rateLimits/updated', {
      rateLimits: { secondary: { usedPercent: 100 } },
    })
    const observedQuotaStates: boolean[] = []
    service.onStatus((status) => observedQuotaStates.push(status.quotaExhausted))

    stalePublicRead.resolve({
      rateLimits: { secondary: { usedPercent: 10 } },
    })
    await expect(publicRead).resolves.toMatchObject({
      rateLimits: { secondary: { usedPercent: 100 } },
    })
    await vi.waitFor(() => expect(readCount).toBe(3))
    expect(service.getStatus().quotaExhausted).toBe(true)
    expect(observedQuotaStates).not.toContain(false)

    latestRefresh.resolve({
      rateLimits: { secondary: { usedPercent: 100 } },
    })
    await vi.waitFor(() => expect(service.getStatus().rateLimits).toMatchObject({
      rateLimits: { secondary: { usedPercent: 100 } },
    }))
    expect(service.getStatus().quotaExhausted).toBe(true)
    expect(observedQuotaStates).not.toContain(false)
  })

  it('recognizes the structured usage-limit code and waits for authoritative recovery before analyzing again', async () => {
    const transport = configuredTransport()
    let now = 1_000
    let rateLimitReadCount = 0
    transport.handle('account/rateLimits/read', () => {
      rateLimitReadCount += 1
      if (rateLimitReadCount === 1) {
        return { rateLimits: { secondary: { usedPercent: 10 } } }
      }
      if (rateLimitReadCount === 2) {
        return { rateLimits: { secondary: { usedPercent: 100 } } }
      }
      return { rateLimits: { secondary: { usedPercent: 10 } } }
    })
    let turnNumber = 0
    transport.handle('turn/start', () => {
      turnNumber += 1
      const turnId = `quota-turn-${turnNumber}`
      queueMicrotask(() => {
        transport.emit('turn/completed', {
          turn: turnNumber === 1
            ? {
                id: turnId,
                status: 'failed',
                error: {
                  message: 'Request rejected',
                  codexErrorInfo: 'usageLimitExceeded',
                },
              }
            : {
                id: turnId,
                status: 'completed',
                items: [
                  {
                    type: 'agentMessage',
                    phase: 'final_answer',
                    text: JSON.stringify({
                      symbols: [],
                      decision: 'SKIP',
                      confidence: 0.1,
                      reason: 'Neutral',
                    }),
                  },
                ],
              },
        })
      })
      return { turn: { id: turnId, status: 'inProgress' } }
    })
    const service = new ChatGptService({
      transport,
      now: () => now,
      quotaRefreshIntervalMs: 100,
    })

    await expect(service.analyze('First message')).resolves.toMatchObject({
      decision: 'SKIP',
      failureCode: 'quota_exceeded',
    })
    await vi.waitFor(() => expect(rateLimitReadCount).toBe(2))
    expect(service.getStatus()).toMatchObject({ quotaExhausted: true, lastError: null })

    await expect(service.analyze('Message before authoritative recovery')).resolves.toMatchObject({
      decision: 'SKIP',
      failureCode: 'quota_exceeded',
    })
    expect(turnNumber).toBe(1)
    expect(rateLimitReadCount).toBe(2)

    now += 100
    await expect(service.analyze('Message that triggers a throttled quota refresh')).resolves.toMatchObject({
      decision: 'SKIP',
      failureCode: 'quota_exceeded',
    })
    await vi.waitFor(() => expect(rateLimitReadCount).toBe(3))
    await vi.waitFor(() => expect(service.getStatus().quotaExhausted).toBe(false))

    await expect(service.analyze('Quota has recovered')).resolves.toMatchObject({
      decision: 'SKIP',
      status: 'skipped',
      reason: 'Neutral',
    })
    expect(turnNumber).toBe(2)
  })

  it('does not let an older successful turn clear newer exhaustion evidence', async () => {
    const transport = configuredTransport()
    let rateLimitReadCount = 0
    transport.handle('account/rateLimits/read', () => {
      rateLimitReadCount += 1
      return rateLimitReadCount === 1
        ? { rateLimits: { secondary: { usedPercent: 10 } } }
        : { rateLimits: { secondary: { usedPercent: 100 } } }
    })
    transport.handle('turn/start', () => ({
      turn: { id: 'in-flight-before-exhaustion', status: 'inProgress' },
    }))
    const service = new ChatGptService({ transport })

    const analysis = service.analyze('BTC ETF approved')
    await vi.waitFor(() => {
      expect(transport.calls.some((call) => call.method === 'turn/start')).toBe(true)
    })

    transport.emit('account/rateLimits/updated', {
      rateLimits: { secondary: { usedPercent: 100 } },
    })
    expect(service.getStatus().quotaExhausted).toBe(true)

    transport.emit('turn/completed', {
      turn: {
        id: 'in-flight-before-exhaustion',
        status: 'completed',
        items: [
          {
            type: 'agentMessage',
            phase: 'final_answer',
            text: JSON.stringify({
              symbols: ['BTC'],
              decision: 'LONG',
              confidence: 0.9,
              reason: 'Bullish',
            }),
          },
        ],
      },
    })

    await expect(analysis).resolves.toMatchObject({
      decision: 'SKIP',
      status: 'skipped',
      failureCode: 'quota_exceeded',
    })
    expect(service.getStatus().quotaExhausted).toBe(true)
  })

  it('updates the matching limit-id bucket without overwriting the backward-compatible root', async () => {
    const transport = configuredTransport()
    let modelBucketUsedPercent = 100
    transport.handle('account/rateLimits/read', () => ({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 10 },
        secondary: { usedPercent: 20 },
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: { usedPercent: 10 },
          secondary: { usedPercent: 20 },
        },
        'model-fast': {
          limitId: 'model-fast',
          primary: { usedPercent: 5 },
          secondary: { usedPercent: modelBucketUsedPercent },
        },
      },
    }))
    const service = new ChatGptService({ transport })

    await service.start()
    expect(service.getStatus().quotaExhausted).toBe(true)

    modelBucketUsedPercent = 25
    transport.emit('account/rateLimits/updated', {
      rateLimits: {
        limitId: 'model-fast',
        secondary: { usedPercent: 25 },
      },
    })

    await vi.waitFor(() => expect(service.getStatus()).toMatchObject({
      quotaExhausted: false,
      rateLimits: {
        rateLimits: {
          limitId: 'codex',
          secondary: { usedPercent: 20 },
        },
        rateLimitsByLimitId: {
          'model-fast': {
            limitId: 'model-fast',
            secondary: { usedPercent: 25 },
          },
        },
      },
    }))
  })

  it('fails closed on malformed structured output', async () => {
    const transport = configuredTransport()
    transport.handle('turn/start', () => {
      queueMicrotask(() => {
        transport.emit('item/completed', {
          turnId: 'bad-turn',
          item: { type: 'agentMessage', text: '{"decision":"LONG"}' },
        })
        transport.emit('turn/completed', {
          turn: { id: 'bad-turn', status: 'completed', items: [] },
        })
      })
      return { turn: { id: 'bad-turn' } }
    })
    const service = new ChatGptService({ transport })

    await expect(service.analyze('Incomplete output please')).resolves.toMatchObject({
      decision: 'SKIP',
      failureCode: 'invalid_response',
    })
  })

  it('exposes browser and device-code login flows', async () => {
    const transport = new MockTransport()
    transport.handle('initialize', () => ({}))
    transport.handle('account/read', () => ({ account: null, requiresOpenaiAuth: true }))
    transport.handle('account/login/start', (params) => {
      const type = (params as { type: string }).type
      return type === 'chatgpt'
        ? { type, loginId: 'browser-id', authUrl: 'https://chatgpt.com/auth' }
        : {
            type,
            loginId: 'device-id',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'ABCD-1234',
          }
    })
    const service = new ChatGptService({ transport })

    await expect(service.startBrowserLogin()).resolves.toMatchObject({
      loginId: 'browser-id',
      authUrl: 'https://chatgpt.com/auth',
    })
    await expect(service.startDeviceCodeLogin()).resolves.toMatchObject({
      loginId: 'device-id',
      userCode: 'ABCD-1234',
    })
  })

  it('waits for login completion and refreshes account, models, limits, and warm thread', async () => {
    const transport = new MockTransport()
    let authenticated = false
    transport.handle('initialize', () => ({}))
    transport.handle('account/read', () => ({
      account: authenticated
        ? { type: 'chatgpt', email: 'plus@example.com', planType: 'plus' }
        : null,
      requiresOpenaiAuth: true,
    }))
    transport.handle('account/login/start', () => ({
      type: 'chatgpt',
      loginId: 'login-1',
      authUrl: 'https://chatgpt.com/auth',
    }))
    transport.handle('model/list', () => ({
      data: [{ model: 'classifier-mini', supportedReasoningEfforts: [{ reasoningEffort: 'none' }] }],
      nextCursor: null,
    }))
    transport.handle('account/rateLimits/read', () => ({ rateLimits: {} }))
    transport.handle('thread/start', () => ({ thread: { id: 'thread-after-login' } }))
    const service = new ChatGptService({ transport })

    const login = await service.startBrowserLogin()
    const completion = service.waitForLogin(login.loginId)
    authenticated = true
    transport.emit('account/login/completed', {
      loginId: login.loginId,
      success: true,
      error: null,
    })

    await expect(completion).resolves.toEqual({ loginId: 'login-1', success: true, error: null })
    expect(service.getStatus()).toMatchObject({
      authenticated: true,
      warmedUp: true,
      selectedModel: 'classifier-mini',
      reasoningEffort: 'none',
    })
  })

  it('serializes concurrent analyses on the persistent thread', async () => {
    const transport = configuredTransport()
    let activeTurns = 0
    let maximumConcurrentTurns = 0
    let turnNumber = 0
    transport.handle('turn/start', () => {
      activeTurns += 1
      maximumConcurrentTurns = Math.max(maximumConcurrentTurns, activeTurns)
      turnNumber += 1
      const turnId = `turn-${turnNumber}`
      setTimeout(() => {
        transport.emit('turn/completed', {
          turn: {
            id: turnId,
            status: 'completed',
            items: [
              {
                type: 'agentMessage',
                phase: 'final_answer',
                text: JSON.stringify({
                  symbols: [],
                  decision: 'SKIP',
                  confidence: 0.2,
                  reason: 'Neutral',
                }),
              },
            ],
          },
        })
        activeTurns -= 1
      }, 5)
      return { turn: { id: turnId, status: 'inProgress' } }
    })
    const service = new ChatGptService({ transport })

    const [first, second] = await Promise.all([service.analyze('first'), service.analyze('second')])

    expect(first.decision).toBe('SKIP')
    expect(second.decision).toBe('SKIP')
    expect(maximumConcurrentTurns).toBe(1)
    expect(transport.calls.filter((call) => call.method === 'thread/start')).toHaveLength(1)
  })
})

describe('signal parsing and model choice', () => {
  it('coerces a multi-symbol directional answer to SKIP', () => {
    expect(
      parseSignalOutput(
        JSON.stringify({
          symbols: ['BTC', 'ETH'],
          decision: 'LONG',
          confidence: 0.8,
          reason: 'Market-wide catalyst',
        }),
      ),
    ).toMatchObject({ decision: 'SKIP', symbols: ['BTC', 'ETH'] })
  })

  it('rejects additional properties and out-of-range confidence', () => {
    expect(
      parseSignalOutput(
        JSON.stringify({ symbols: ['BTC'], decision: 'LONG', confidence: 1.1, reason: 'x' }),
      ),
    ).toBeNull()
    expect(
      parseSignalOutput(
        JSON.stringify({
          symbols: ['BTC'],
          decision: 'LONG',
          confidence: 0.9,
          reason: 'x',
          orderSize: 10,
        }),
      ),
    ).toBeNull()
  })

  it('prefers a small model with none effort over a flagship default', () => {
    expect(
      selectFastestModel([
        {
          model: 'flagship-sol',
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
        },
        {
          model: 'classifier-mini',
          supportedReasoningEfforts: [{ reasoningEffort: 'none' }],
        },
      ]),
    ).toEqual({ model: 'classifier-mini', effort: 'none' })
  })
})
