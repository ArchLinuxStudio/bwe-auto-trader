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
