import {
  type FormEvent,
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import type {
  AppEvent,
  AppPosition,
  AppSnapshot,
  AuthPrompt,
  ConnectionPhase,
  ConnectionStatus,
  DesktopApi,
  IpcResult,
  NetworkDiagnostics,
  NotificationItem,
  OkxCredentialsInput,
  PublicSettings,
  SettingsUpdateInput,
  SignalRecord,
  SignalStage,
  TelegramCredentialsInput,
  TradeDecision,
} from '@shared/types'
import { presentNetworkDiagnostics } from './network-diagnostics-view'

type View = 'dashboard' | 'settings'
type ToastItem = NotificationItem & { local?: boolean }

const EMPTY_STATUS: ConnectionStatus = {
  phase: 'not_configured',
  label: '未配置',
  lastChangedAt: 0,
}

const EMPTY_OKX_ROUTES: AppSnapshot['okxRoutes'] = {
  rest: { kind: 'unselected' },
  privateWs: { kind: 'unselected' },
}

const EMPTY_SETTINGS: PublicSettings = {
  proxy: { host: '127.0.0.1', port: 7890, protocol: 'auto' },
  trading: {
    channelUsername: 'BWEnews',
    orderNotionalUsdt: 10,
    leverage: 1,
    cooldownMinutes: 60,
    aiTimeoutMs: 10_000,
    maxConcurrentPositions: 1,
    marginMode: 'isolated',
    positionMode: 'net',
  },
  okxConfigured: false,
  telegramConfigured: false,
  chatgptConfigured: false,
  notificationsEnabled: true,
  soundsEnabled: true,
}

const EMPTY_SNAPSHOT: AppSnapshot = {
  version: '0.1.8',
  connections: {
    telegram: EMPTY_STATUS,
    chatgpt: EMPTY_STATUS,
    okx: EMPTY_STATUS,
  },
  safety: {
    liveArmed: false,
    monitoring: false,
    emergencyStopped: false,
    canArm: false,
    armBlockers: ['等待本机服务初始化'],
  },
  settings: EMPTY_SETTINGS,
  diagnostics: {
    proxyReachable: false,
    okxDirect: false,
  },
  okxRoutes: EMPTY_OKX_ROUTES,
  positions: [],
  signals: [],
  notifications: [],
  aiQuotaExhausted: false,
}

const PHASE_LABELS: Record<ConnectionPhase, string> = {
  not_configured: '未配置',
  disconnected: '已断开',
  connecting: '连接中',
  connected: '已连接',
  error: '异常',
}

const STAGE_META: Record<SignalStage, { label: string; tone: string }> = {
  received: { label: '已接收', tone: 'info' },
  analyzing: { label: 'AI 分析中', tone: 'pending' },
  skipped: { label: '已跳过', tone: 'muted' },
  blocked: { label: '风控拦截', tone: 'warning' },
  submitting: { label: '正在下单', tone: 'pending' },
  submitted: { label: '订单已提交', tone: 'info' },
  filled: { label: '已成交', tone: 'success' },
  failed: { label: '处理失败', tone: 'danger' },
}

const DECISION_META: Record<TradeDecision, { label: string; tone: string; icon: string }> = {
  LONG: { label: '做多', tone: 'success', icon: '↗' },
  SHORT: { label: '做空', tone: 'danger', icon: '↘' },
  SKIP: { label: '跳过', tone: 'muted', icon: '—' },
}

function getDesktopApi(): DesktopApi | undefined {
  return (window as Window & { desktopApi?: DesktopApi }).desktopApi
}

function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(EMPTY_SNAPSHOT)
  const [view, setView] = useState<View>('dashboard')
  const [loading, setLoading] = useState(true)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null)
  const [showLiveDialog, setShowLiveDialog] = useState(false)
  const [showEmergencyDialog, setShowEmergencyDialog] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [safetyBusyActions, setSafetyBusyActions] = useState<ReadonlySet<string>>(() => new Set())
  const actionInFlight = useRef<string | null>(null)
  const safetyActionsInFlight = useRef(new Set<string>())
  const toastTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const soundsEnabledRef = useRef(true)

  useEffect(() => {
    soundsEnabledRef.current = snapshot.settings.soundsEnabled
  }, [snapshot.settings.soundsEnabled])

  const pushToast = useCallback((item: ToastItem): void => {
    setToasts((current) => [item, ...current.filter((toast) => toast.id !== item.id)].slice(0, 4))
    const oldTimer = toastTimers.current.get(item.id)
    if (oldTimer) clearTimeout(oldTimer)
    const timer = setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== item.id))
      toastTimers.current.delete(item.id)
    }, item.level === 'error' ? 8_000 : 5_000)
    toastTimers.current.set(item.id, timer)
  }, [])

  const notifyLocal = useCallback(
    (level: NotificationItem['level'], title: string, detail: string): void => {
      pushToast({
        id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        level,
        title,
        detail,
        createdAt: Date.now(),
        local: true,
      })
    },
    [pushToast],
  )

  useEffect(() => {
    const api = getDesktopApi()
    if (!api) {
      setLoading(false)
      setFatalError('桌面服务尚未注入。请通过安装后的桌面程序启动，不要直接打开网页文件。')
      return
    }

    let active = true
    const applyEvent = (event: AppEvent): void => {
      if (!active) return
      if (event.type === 'snapshot') {
        setSnapshot(event.payload)
        setAuthPrompt(event.payload.pendingAuthPrompt ?? null)
      } else if (event.type === 'notification') {
        pushToast(event.payload)
        if (soundsEnabledRef.current) playNotificationTone(event.payload.level)
      } else if (event.type === 'auth-prompt') {
        setAuthPrompt(event.payload)
      }
    }

    const unsubscribe = api.onEvent(applyEvent)
    void api
      .getSnapshot()
      .then((result) => {
        if (!active) return
        if (result.ok && result.value) {
          setSnapshot(result.value)
          setAuthPrompt(result.value.pendingAuthPrompt ?? null)
        } else {
          setFatalError(result.error ?? '无法读取程序状态')
        }
      })
      .catch((error: unknown) => {
        if (active) setFatalError(errorText(error))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
      unsubscribe()
      for (const timer of toastTimers.current.values()) clearTimeout(timer)
      toastTimers.current.clear()
    }
  }, [pushToast])

  const runAction = useCallback(
    async <T,>(
      key: string,
      action: () => Promise<IpcResult<T>>,
      successMessage?: string,
    ): Promise<IpcResult<T>> => {
      if (actionInFlight.current) return { ok: false, error: '另一项操作正在进行' }
      actionInFlight.current = key
      setBusyAction(key)
      try {
        const result = await action()
        if (!result.ok) {
          notifyLocal('error', '操作未完成', result.error ?? '未知错误')
        } else if (successMessage) {
          notifyLocal('success', '操作成功', successMessage)
        }
        return result
      } catch (error) {
        const detail = errorText(error)
        notifyLocal('error', '程序通信失败', detail)
        return { ok: false, error: detail }
      } finally {
        if (actionInFlight.current === key) actionInFlight.current = null
        setBusyAction((current) => (current === key ? null : current))
      }
    },
    [notifyLocal],
  )

  const runSafetyAction = useCallback(
    async <T,>(
      key: string,
      action: () => Promise<IpcResult<T>>,
      successMessage?: string,
    ): Promise<IpcResult<T>> => {
      if (safetyActionsInFlight.current.has(key)) {
        return { ok: false, error: '该安全操作正在进行' }
      }

      safetyActionsInFlight.current.add(key)
      setSafetyBusyActions((current) => new Set(current).add(key))
      try {
        const result = await action()
        if (!result.ok) {
          notifyLocal('error', '安全操作未完成', result.error ?? '未知错误')
        } else if (successMessage) {
          notifyLocal('success', '操作成功', successMessage)
        }
        return result
      } catch (error) {
        const detail = errorText(error)
        notifyLocal('error', '程序通信失败', detail)
        return { ok: false, error: detail }
      } finally {
        safetyActionsInFlight.current.delete(key)
        setSafetyBusyActions((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      }
    },
    [notifyLocal],
  )

  const toggleMonitoring = async (): Promise<void> => {
    const api = getDesktopApi()
    if (!api) return
    if (snapshot.safety.monitoring) {
      await runAction('monitor', () => api.stopMonitoring(), '监听已停止，不再处理新消息')
    } else {
      await runAction('monitor', () => api.startMonitoring(), '开始监听 @BWEnews 的新消息')
    }
  }

  const disarmLive = async (): Promise<void> => {
    const api = getDesktopApi()
    if (!api) return
    await runSafetyAction('disarm', () => api.disarmLiveTrading(), '实盘权限已锁定')
  }

  const confirmEmergencyStop = async (): Promise<void> => {
    const api = getDesktopApi()
    if (!api) return
    const result = await runSafetyAction(
      'emergency',
      () => api.emergencyStop(),
      '监听与自动下单已立即停止；已有仓位不会自动平仓',
    )
    if (result.ok) setShowEmergencyDialog(false)
  }

  const totalPnl = snapshot.positions.reduce((sum, position) => sum + position.unrealizedPnl, 0)
  const chatGptDisplayStatus = quotaAwareChatGptStatus(snapshot)
  const connectedCount = Object.values(snapshot.connections).filter(
    (connection) => connection.phase === 'connected',
  ).length

  if (loading) {
    return <LoadingScreen />
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            <LogoMark />
          </div>
          <div>
            <div className="brand-name">BWE Trader</div>
            <div className="brand-caption">News execution console</div>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          <button
            className={`nav-item ${view === 'dashboard' ? 'active' : ''}`}
            onClick={() => setView('dashboard')}
          >
            <DashboardIcon />
            <span>交易台</span>
          </button>
          <button
            className={`nav-item ${view === 'settings' ? 'active' : ''}`}
            onClick={() => setView('settings')}
          >
            <SettingsIcon />
            <span>连接与设置</span>
            {connectedCount < 3 && <span className="nav-badge">{3 - connectedCount}</span>}
          </button>
        </nav>

        <div className="sidebar-spacer" />

        <div className={`mode-card ${snapshot.safety.liveArmed ? 'armed' : ''}`}>
          <div className="mode-card-top">
            <span className="eyebrow">执行模式</span>
            <span className={`pulse-dot ${snapshot.safety.liveArmed ? 'danger' : 'safe'}`} />
          </div>
          <strong>{snapshot.safety.liveArmed ? '实盘已解锁' : '安全锁定'}</strong>
          <p>
            {snapshot.safety.liveArmed
              ? '符合风控的信号将提交真实订单'
              : '分析照常运行，不会提交真实订单'}
          </p>
        </div>

        <div className="version-row">
          <span>本机运行</span>
          <span>v{snapshot.version}</span>
        </div>
      </aside>

      <main className="main-stage">
        <header className="topbar">
          <div className="page-heading">
            <span className="page-kicker">{view === 'dashboard' ? 'LIVE DESK' : 'CONTROL CENTER'}</span>
            <h1>{view === 'dashboard' ? '新闻交易台' : '连接与策略设置'}</h1>
          </div>

          <div className="topbar-statuses">
            <ConnectionPill name="Telegram" status={snapshot.connections.telegram} icon={<TelegramIcon />} />
            <ConnectionPill
              name="ChatGPT"
              status={chatGptDisplayStatus}
              displayLabel={snapshot.aiQuotaExhausted ? '额度用尽' : undefined}
              icon={<SparkIcon />}
            />
            <ConnectionPill name="OKX" status={snapshot.connections.okx} icon={<OkxIcon />} />
          </div>

          <div className="topbar-actions">
            <button
              className={`button monitor-button ${snapshot.safety.monitoring ? 'is-running' : ''}`}
              disabled={Boolean(busyAction)}
              onClick={() => void toggleMonitoring()}
            >
              {busyAction === 'monitor' ? (
                <Spinner />
              ) : snapshot.safety.monitoring ? (
                <StopIcon />
              ) : (
                <PlayIcon />
              )}
              {snapshot.safety.monitoring ? '停止监听' : snapshot.safety.emergencyStopped ? '重新开始监听' : '开始监听'}
            </button>

            {snapshot.safety.liveArmed ? (
              <button
                className="button button-outline danger-outline live-arm-button"
                disabled={safetyBusyActions.has('disarm')}
                onClick={() => void disarmLive()}
              >
                {safetyBusyActions.has('disarm') && <Spinner />}
                {safetyBusyActions.has('disarm') ? '正在锁定' : '锁定实盘'}
              </button>
            ) : (
              <button
                className="button button-outline live-arm-button"
                disabled={Boolean(busyAction) || !snapshot.safety.canArm}
                onClick={() => setShowLiveDialog(true)}
                title={snapshot.safety.armBlockers.join('；')}
              >
                <LockIcon />
                解锁实盘
              </button>
            )}

            <button
              className="icon-button emergency-button"
              aria-label="紧急停止"
              title="紧急停止"
              disabled={safetyBusyActions.has('emergency')}
              onClick={() => setShowEmergencyDialog(true)}
            >
              <PowerIcon />
              <span className="emergency-label">急停</span>
            </button>
          </div>
        </header>

        {fatalError && (
          <div className="fatal-banner" role="alert">
            <WarningIcon />
            <div>
              <strong>桌面服务不可用</strong>
              <span>{fatalError}</span>
            </div>
          </div>
        )}

        {snapshot.safety.emergencyStopped && (
          <div className="emergency-banner" role="alert">
            <span className="emergency-symbol">!</span>
            <div>
              <strong>紧急停止已生效</strong>
              <span>监听和自动下单均已停止。已有仓位仍需手动处理。</span>
            </div>
            <button onClick={() => setView('settings')}>检查连接</button>
          </div>
        )}

        <div className="content-scroll">
          {view === 'dashboard' ? (
            <DashboardView
              snapshot={snapshot}
              totalPnl={totalPnl}
              safetyBusyActions={safetyBusyActions}
              onClosePosition={async (position, confirmation) => {
                const api = getDesktopApi()
                if (!api) return false

                const currentPosition = snapshot.positions.find(
                  (candidate) => candidate.instrumentId === position.instrumentId,
                )
                if (snapshot.connections.okx.phase !== 'connected') {
                  notifyLocal('error', '无法平仓', 'OKX 当前未连接，请恢复连接后重试')
                  return false
                }
                if (!currentPosition) {
                  notifyLocal('error', '无法平仓', `${position.instrumentId} 当前已无可平仓位`)
                  return false
                }
                if (currentPosition.closePending) return false

                const closeKey = `close-${position.instrumentId}`
                const input = {
                  instrumentId: position.instrumentId,
                  confirmation,
                }
                const result = await runSafetyAction(
                  closeKey,
                  () => api.closePosition(input),
                  `${position.instrumentId} 平仓指令已提交`,
                )
                return result.ok
              }}
              onOpenSettings={() => setView('settings')}
            />
          ) : (
            <SettingsView
              snapshot={snapshot}
              busyAction={busyAction}
              runAction={runAction}
              notifyLocal={notifyLocal}
            />
          )}
        </div>
      </main>

      <ToastStack
        items={toasts}
        onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
      />

      {authPrompt && (
        <AuthPromptDialog
          prompt={authPrompt}
          busy={busyAction === 'auth'}
          onSubmit={async (value) => {
            const api = getDesktopApi()
            if (!api) return
            const result = await runAction('auth', () => api.submitAuthPrompt(authPrompt.id, value))
            if (result.ok) setAuthPrompt(null)
          }}
          onCancel={async () => {
            const api = getDesktopApi()
            if (!api) return
            const result = await runAction('auth', () => api.cancelAuthPrompt(authPrompt.id))
            if (result.ok) setAuthPrompt(null)
          }}
        />
      )}

      {showLiveDialog && (
        <LiveConfirmDialog
          blockers={snapshot.safety.armBlockers}
          busy={busyAction === 'arm'}
          trading={snapshot.settings.trading}
          onCancel={() => setShowLiveDialog(false)}
          onConfirm={async (confirmation) => {
            const api = getDesktopApi()
            if (!api) return
            const result = await runAction(
              'arm',
              () => api.armLiveTrading(confirmation),
              '实盘已解锁，请持续关注仓位与连接状态',
            )
            if (result.ok) setShowLiveDialog(false)
          }}
        />
      )}

      {showEmergencyDialog && (
        <ConfirmDialog
          tone="danger"
          title="确认紧急停止？"
          description="程序将立即停止监听并禁止新的自动下单。已有仓位不会自动平仓。"
          confirmLabel="立即停止"
          busy={safetyBusyActions.has('emergency')}
          onCancel={() => setShowEmergencyDialog(false)}
          onConfirm={() => void confirmEmergencyStop()}
        />
      )}
    </div>
  )
}

function DashboardView({
  snapshot,
  totalPnl,
  safetyBusyActions,
  onClosePosition,
  onOpenSettings,
}: {
  snapshot: AppSnapshot
  totalPnl: number
  safetyBusyActions: ReadonlySet<string>
  onClosePosition: (position: AppPosition, confirmation: '确认平仓') => Promise<boolean>
  onOpenSettings: () => void
}): JSX.Element {
  const [closeTarget, setCloseTarget] = useState<AppPosition | null>(null)
  const latestSignal = snapshot.signals[0]
  const processedToday = snapshot.signals.filter((signal) => isToday(signal.createdAt)).length
  const filledToday = snapshot.signals.filter(
    (signal) => isToday(signal.createdAt) && signal.stage === 'filled',
  ).length
  const currentCloseTarget = closeTarget
    ? snapshot.positions.find((position) => position.instrumentId === closeTarget.instrumentId)
    : undefined

  useEffect(() => {
    if (closeTarget && !currentCloseTarget) setCloseTarget(null)
  }, [closeTarget, currentCloseTarget])

  return (
    <div className="dashboard-layout">
      <section className="overview-strip">
        <MetricCard
          label="监听频道"
          value={`@${snapshot.settings.trading.channelUsername}`}
          subvalue={snapshot.safety.monitoring ? '实时监听中' : '当前已暂停'}
          tone={snapshot.safety.monitoring ? 'success' : 'neutral'}
          icon={<BroadcastIcon />}
        />
        <MetricCard
          label="今日消息"
          value={processedToday.toString()}
          subvalue={`${filledToday} 条触发成交`}
          tone="info"
          icon={<MessageIcon />}
        />
        <MetricCard
          label="专用子账户持仓"
          value={snapshot.positions.length.toString()}
          subvalue={`上限 ${snapshot.settings.trading.maxConcurrentPositions} 个`}
          tone={snapshot.positions.length ? 'warning' : 'neutral'}
          icon={<PositionIcon />}
        />
        <MetricCard
          label="未实现盈亏"
          value={`${totalPnl >= 0 ? '+' : ''}${formatMoney(totalPnl)} USDT`}
          subvalue={snapshot.positions.length ? '按 OKX 标记价格' : '该子账户当前没有持仓'}
          tone={totalPnl > 0 ? 'success' : totalPnl < 0 ? 'danger' : 'neutral'}
          icon={<ChartIcon />}
        />
      </section>

      <section className="primary-grid">
        <div className="panel feed-panel">
          <PanelHeader
            eyebrow="TELEGRAM → AI → OKX"
            title="信号时间线"
            aside={
              <div className="live-indicator">
                <span className={snapshot.safety.monitoring ? 'active' : ''} />
                {snapshot.safety.monitoring ? '仅处理新消息' : '监听已暂停'}
              </div>
            }
          />
          <div className="panel-body feed-body">
            {snapshot.signals.length ? (
              <div className="signal-list">
                {snapshot.signals.map((signal, index) => (
                  <SignalCard key={signal.id} signal={signal} newest={index === 0} />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<MessageIcon />}
                title="等待第一条新消息"
                description="启动监听后，@BWEnews 的新消息会在这里依次展示 AI 判断、风控结果和订单状态。"
                action={
                  <button className="text-button" onClick={onOpenSettings}>
                    检查连接配置 <ArrowIcon />
                  </button>
                }
              />
            )}
          </div>
        </div>

        <div className="right-stack">
          <div className="panel positions-panel">
            <PanelHeader
              eyebrow="SUBACCOUNT POSITIONS"
              title="专用子账户持仓"
              aside={
                <span className={`pnl-total ${totalPnl >= 0 ? 'positive' : 'negative'}`}>
                  {totalPnl >= 0 ? '+' : ''}{formatMoney(totalPnl)} U
                </span>
              }
            />
            <div className="panel-body position-body">
              {snapshot.positions.length ? (
                <div className="position-list">
                  {snapshot.positions.map((position) => (
                    <PositionCard
                      key={position.instrumentId}
                      position={position}
                      closing={safetyBusyActions.has(`close-${position.instrumentId}`)}
                      okxConnected={snapshot.connections.okx.phase === 'connected'}
                      onClose={() => setCloseTarget(position)}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  compact
                  icon={<PositionIcon />}
                  title="该子账户当前没有持仓"
                  description="这里显示独立 OKX 子账户当前的全部 SWAP 持仓，不代表每个仓位都由本程序创建。"
                />
              )}
            </div>
          </div>

          <SafetyCard snapshot={snapshot} latestSignal={latestSignal} />
        </div>
      </section>

      {currentCloseTarget && (
        <ClosePositionConfirmDialog
          key={currentCloseTarget.instrumentId}
          position={currentCloseTarget}
          okxConnected={snapshot.connections.okx.phase === 'connected'}
          busy={safetyBusyActions.has(`close-${currentCloseTarget.instrumentId}`) || Boolean(currentCloseTarget.closePending)}
          onCancel={() => setCloseTarget(null)}
          onConfirm={(confirmation) => {
            void onClosePosition(currentCloseTarget, confirmation).then((ok) => {
              if (ok) setCloseTarget(null)
            })
          }}
        />
      )}
    </div>
  )
}

function SettingsView({
  snapshot,
  busyAction,
  runAction,
  notifyLocal,
}: {
  snapshot: AppSnapshot
  busyAction: string | null
  runAction: <T>(key: string, action: () => Promise<IpcResult<T>>, successMessage?: string) => Promise<IpcResult<T>>
  notifyLocal: (level: NotificationItem['level'], title: string, detail: string) => void
}): JSX.Element {
  const [telegram, setTelegram] = useState({
    apiId: snapshot.settings.telegramApiId?.toString() ?? '',
    apiHash: '',
    phoneNumber: '',
  })
  const [okx, setOkx] = useState<OkxCredentialsInput>({ apiKey: '', secretKey: '', passphrase: '' })
  const [settings, setSettings] = useState({
    proxyHost: snapshot.settings.proxy.host,
    proxyPort: snapshot.settings.proxy.port.toString(),
    proxyProtocol: snapshot.settings.proxy.protocol,
    channelUsername: snapshot.settings.trading.channelUsername,
    orderNotionalUsdt: snapshot.settings.trading.orderNotionalUsdt.toString(),
    leverage: snapshot.settings.trading.leverage.toString(),
    cooldownMinutes: snapshot.settings.trading.cooldownMinutes.toString(),
    aiTimeoutSeconds: (snapshot.settings.trading.aiTimeoutMs / 1000).toString(),
    notificationsEnabled: snapshot.settings.notificationsEnabled,
    soundsEnabled: snapshot.settings.soundsEnabled,
  })
  const aiQuotaUsedPercent = typeof snapshot.aiQuotaPercent === 'number'
    ? Math.max(0, Math.min(100, snapshot.aiQuotaPercent))
    : undefined
  const aiQuotaRemainingPercent = typeof aiQuotaUsedPercent === 'number'
    ? Math.round(100 - aiQuotaUsedPercent)
    : undefined

  const api = getDesktopApi()

  const diagnoseNetwork = async (): Promise<void> => {
    if (!api) return
    const result = await runAction('diagnostics', () => api.runNetworkDiagnostics())
    if (!result.ok || !result.value) return

    const presentation = presentNetworkDiagnostics(result.value)
    notifyLocal(
      presentation.incompleteItems.length > 0 ? 'warning' : 'success',
      '网络诊断已完成',
      presentation.incompleteItems.length > 0
        ? `检测流程已完成；以下项目未通过：${presentation.incompleteItems.join('、')}`
        : '直连、Clash 与 OKX 可选端点探针均已通过'
    )
  }

  useEffect(() => {
    setSettings((current) => ({
      ...current,
      proxyHost: snapshot.settings.proxy.host,
      proxyPort: snapshot.settings.proxy.port.toString(),
      proxyProtocol: snapshot.settings.proxy.protocol,
      channelUsername: snapshot.settings.trading.channelUsername,
      orderNotionalUsdt: snapshot.settings.trading.orderNotionalUsdt.toString(),
      leverage: snapshot.settings.trading.leverage.toString(),
      cooldownMinutes: snapshot.settings.trading.cooldownMinutes.toString(),
      aiTimeoutSeconds: (snapshot.settings.trading.aiTimeoutMs / 1000).toString(),
      notificationsEnabled: snapshot.settings.notificationsEnabled,
      soundsEnabled: snapshot.settings.soundsEnabled,
    }))
  }, [snapshot.settings])

  const saveTelegram = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!api) return
    const apiId = Number(telegram.apiId)
    if (!Number.isInteger(apiId) || apiId <= 0 || !telegram.apiHash.trim() || !telegram.phoneNumber.trim()) {
      notifyLocal('warning', 'Telegram 信息不完整', '请填写有效的 api_id、api_hash 和国际格式手机号')
      return
    }
    const input: TelegramCredentialsInput = {
      apiId,
      apiHash: telegram.apiHash.trim(),
      phoneNumber: telegram.phoneNumber.trim(),
    }
    const saved = await runAction('telegram-save', () => api.saveTelegramCredentials(input), 'Telegram 凭据已安全保存')
    if (saved.ok) {
      setTelegram((current) => ({ ...current, apiHash: '' }))
      await runAction('telegram-connect', () => api.connectTelegram(), 'Telegram 登录流程已启动')
    }
  }

  const saveOkx = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!api) return
    if (!okx.apiKey.trim() || !okx.secretKey.trim() || !okx.passphrase.trim()) {
      notifyLocal('warning', 'OKX 信息不完整', '请填写 API Key、Secret Key 和 Passphrase')
      return
    }
    const saved = await runAction(
      'okx-save',
      () => api.saveOkxCredentials({
        apiKey: okx.apiKey.trim(),
        secretKey: okx.secretKey.trim(),
        passphrase: okx.passphrase.trim(),
      }),
      'OKX 子账户凭据已安全保存',
    )
    if (saved.ok) {
      setOkx({ apiKey: '', secretKey: '', passphrase: '' })
      await runAction('okx-connect', () => api.connectOkx(), '正在验证 OKX 子账户与持仓模式')
    }
  }

  const saveStrategy = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!api) return
    const proxyPort = Number(settings.proxyPort)
    const notional = Number(settings.orderNotionalUsdt)
    const leverage = Number(settings.leverage)
    const cooldown = Number(settings.cooldownMinutes)
    const aiTimeout = Number(settings.aiTimeoutSeconds) * 1000
    if (
      !settings.proxyHost.trim() ||
      !settings.channelUsername.replace(/^@/, '').trim() ||
      !Number.isInteger(proxyPort) ||
      proxyPort < 1 ||
      proxyPort > 65535 ||
      !Number.isFinite(notional) ||
      notional <= 0 ||
      !Number.isFinite(leverage) ||
      leverage < 1 ||
      !Number.isFinite(cooldown) ||
      cooldown < 0 ||
      !Number.isFinite(aiTimeout) ||
      aiTimeout < 1_000
    ) {
      notifyLocal('warning', '设置值无效', '请检查代理端口、下单金额、杠杆、冷却与 AI 超时时间')
      return
    }
    const input: SettingsUpdateInput = {
      proxy: {
        host: settings.proxyHost.trim(),
        port: proxyPort,
        protocol: settings.proxyProtocol,
      },
      trading: {
        channelUsername: settings.channelUsername.replace(/^@/, '').trim(),
        orderNotionalUsdt: notional,
        leverage,
        cooldownMinutes: cooldown,
        aiTimeoutMs: aiTimeout,
      },
      notificationsEnabled: settings.notificationsEnabled,
      soundsEnabled: settings.soundsEnabled,
    }
    await runAction('settings-save', () => api.updateSettings(input), '代理与交易参数已更新')
  }

  const loginChatGpt = async (): Promise<void> => {
    if (!api) return
    const result = await runAction('chatgpt-login', () => api.loginChatGpt())
    if (result.ok && result.value) {
      const detail = result.value.userCode
        ? `请在打开的页面输入代码 ${result.value.userCode}`
        : '请在浏览器完成 ChatGPT 登录，完成后返回程序'
      notifyLocal('info', '等待 ChatGPT Plus 授权', detail)
      // The main process already opens the allowlisted system-browser URL.
    }
  }

  return (
    <div className="settings-layout">
      <section className="settings-intro">
        <div>
          <span className="eyebrow">LOCAL-FIRST SECURITY</span>
          <h2>账户密钥只保存在本机</h2>
          <p>程序只使用读取与交易功能，建议 API Key 仅授予 Read＋Trade；程序没有提现功能。连接状态以本机服务的实时校验结果为准。</p>
        </div>
        <DiagnosticsSummary diagnostics={snapshot.diagnostics} />
      </section>

      <div className="settings-grid">
        <SettingsCard
          number="01"
          title="Telegram 个人账号"
          subtitle="监听 @BWEnews 的新频道消息"
          status={snapshot.connections.telegram}
          icon={<TelegramIcon />}
        >
          <form className="form-grid" onSubmit={(event) => void saveTelegram(event)}>
            <Field label="API ID" hint="在 my.telegram.org 获取">
              <input
                inputMode="numeric"
                value={telegram.apiId}
                onChange={(event) => setTelegram((current) => ({ ...current, apiId: event.target.value }))}
                placeholder="12345678"
                autoComplete="off"
              />
            </Field>
            <Field label="API Hash" hint="只在本机加密保存">
              <input
                type="password"
                value={telegram.apiHash}
                onChange={(event) => setTelegram((current) => ({ ...current, apiHash: event.target.value }))}
                placeholder={snapshot.settings.telegramConfigured ? '重新保存时请输入 API Hash' : '32 位 api_hash'}
                autoComplete="new-password"
              />
            </Field>
            <Field label="手机号" hint="使用国际格式">
              <input
                type="tel"
                value={telegram.phoneNumber}
                onChange={(event) => setTelegram((current) => ({ ...current, phoneNumber: event.target.value }))}
                placeholder={snapshot.settings.telegramPhoneHint ? `已保存 ${snapshot.settings.telegramPhoneHint}` : '+86 1XX XXXX XXXX'}
                autoComplete="tel"
              />
            </Field>
            <div className="form-actions span-full">
              {snapshot.connections.telegram.phase === 'connected' ? (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={Boolean(busyAction)}
                  onClick={() => void runAction('telegram-disconnect', () => api?.disconnectTelegram() ?? Promise.resolve({ ok: false }))}
                >
                  断开 Telegram
                </button>
              ) : (
                <>
                  {snapshot.settings.telegramConfigured && (
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={Boolean(busyAction)}
                      onClick={() =>
                        void runAction(
                          'telegram-connect',
                          () => api?.connectTelegram() ?? Promise.resolve({ ok: false }),
                          '正在使用已保存凭据连接 Telegram',
                        )
                      }
                    >
                      {busyAction === 'telegram-connect' ? <Spinner /> : <TelegramIcon />}
                      连接已保存配置
                    </button>
                  )}
                  <button className="button button-primary" disabled={Boolean(busyAction)}>
                    {busyAction === 'telegram-save' ? <Spinner /> : <SaveIcon />}
                    {snapshot.settings.telegramConfigured ? '保存新配置并连接' : '保存并连接'}
                  </button>
                </>
              )}
            </div>
          </form>
        </SettingsCard>

        <SettingsCard
          number="02"
          title="ChatGPT Plus"
          subtitle="通过官方 Codex 登录进行极速新闻分析"
          status={quotaAwareChatGptStatus(snapshot)}
          statusLabel={snapshot.aiQuotaExhausted ? '额度用尽' : undefined}
          icon={<SparkIcon />}
        >
          <div className="account-connect-block">
            <div className="account-graphic chatgpt-graphic"><SparkIcon /></div>
            <div className="account-copy">
              <strong>
                {snapshot.aiQuotaExhausted
                  ? 'ChatGPT 额度已用尽'
                  : snapshot.connections.chatgpt.phase === 'connected'
                    ? 'ChatGPT 已授权'
                    : '使用 ChatGPT 账号登录'}
              </strong>
              <p>
                {snapshot.aiQuotaExhausted
                  ? '当前无法分析或自动下单；Telegram 监听与频道消息接收仍会继续。'
                  : snapshot.connections.chatgpt.phase === 'connected'
                  ? `当前模型：${snapshot.aiModel ?? '自动选择最快可用模型'}`
                  : '不会读取浏览器 Cookie；登录由官方授权页面完成。'}
              </p>
              {typeof aiQuotaUsedPercent === 'number' && typeof aiQuotaRemainingPercent === 'number' && (
                <div className={`quota-row ${snapshot.aiQuotaExhausted ? 'exhausted' : ''}`}>
                  <div className="quota-track"><span style={{ width: `${aiQuotaRemainingPercent}%` }} /></div>
                  <small>
                    {snapshot.aiQuotaExhausted
                      ? '额度已用尽'
                      : `本周期剩余 ${aiQuotaRemainingPercent}% · 每分钟更新`}
                  </small>
                </div>
              )}
            </div>
          </div>
          <div className="form-actions">
            {snapshot.connections.chatgpt.phase === 'connected' ? (
              <button
                className="button button-secondary"
                disabled={Boolean(busyAction)}
                onClick={() => void runAction('chatgpt-disconnect', () => api?.disconnectChatGpt() ?? Promise.resolve({ ok: false }))}
              >
                退出 ChatGPT
              </button>
            ) : (
              <button
                className="button button-primary"
                disabled={Boolean(busyAction)}
                onClick={() => void loginChatGpt()}
              >
                {busyAction === 'chatgpt-login' ? <Spinner /> : <ExternalIcon />}
                登录 ChatGPT Plus
              </button>
            )}
          </div>
        </SettingsCard>

        <SettingsCard
          number="03"
          title="OKX 独立子账户"
          subtitle="USDT 永续 · 逐仓 · 单向持仓"
          status={snapshot.connections.okx}
          icon={<OkxIcon />}
        >
          {snapshot.connections.okx.phase === 'error' && (
            <div className="connection-error-panel" role="alert" aria-live="polite">
              <CrossIcon />
              <div>
                <strong>OKX 连接未完成</strong>
                <span>{snapshot.connections.okx.detail?.trim() || snapshot.connections.okx.label}</span>
              </div>
            </div>
          )}
          <OkxRoutesSummary routes={snapshot.okxRoutes ?? EMPTY_OKX_ROUTES} />
          <form className="form-grid" onSubmit={(event) => void saveOkx(event)}>
            <Field label="API Key">
              <input
                type="password"
                value={okx.apiKey}
                onChange={(event) => setOkx((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder={snapshot.settings.okxConfigured ? '已保存；重新填写可替换' : 'OKX API Key'}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Secret Key">
              <input
                type="password"
                value={okx.secretKey}
                onChange={(event) => setOkx((current) => ({ ...current, secretKey: event.target.value }))}
                placeholder="OKX Secret Key"
                autoComplete="new-password"
              />
            </Field>
            <Field label="Passphrase">
              <input
                type="password"
                value={okx.passphrase}
                onChange={(event) => setOkx((current) => ({ ...current, passphrase: event.target.value }))}
                placeholder="创建 API 时设置的密码"
                autoComplete="new-password"
              />
            </Field>
            <div className="security-note span-full">
              <ShieldIcon />
              <span>建议在 OKX 仅授予 Read＋Trade 权限以降低密钥风险；程序未实现任何提现功能。该建议不是静态连接错误；如连接失败，实际原因以上方实时错误为准。</span>
            </div>
            <div className="optional-diagnostic-note span-full">
              <PulseIcon />
              <div>
                <strong>出口 IP 检查为可选诊断</strong>
                <span>
                  可用下方“测试网络”查看当前出口，再自行决定是否加入 OKX API 白名单；未检查或未配置白名单不影响保存此处 API 配置。
                </span>
              </div>
              <small>{presentNetworkDiagnostics(snapshot.diagnostics).directIpStatus}</small>
            </div>
            <div className="form-actions span-full">
              {snapshot.connections.okx.phase === 'connected' ? (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={Boolean(busyAction)}
                  onClick={() => void runAction('okx-disconnect', () => api?.disconnectOkx() ?? Promise.resolve({ ok: false }))}
                >
                  断开 OKX
                </button>
              ) : (
                <>
                  {snapshot.settings.okxConfigured && (
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={Boolean(busyAction)}
                      onClick={() =>
                        void runAction(
                          'okx-connect',
                          () => api?.connectOkx() ?? Promise.resolve({ ok: false }),
                          '正在使用已保存 API 验证 OKX 子账户',
                        )
                      }
                    >
                      {busyAction === 'okx-connect' ? <Spinner /> : <OkxIcon />}
                      连接已保存 API
                    </button>
                  )}
                  <button className="button button-primary" disabled={Boolean(busyAction)}>
                    {busyAction === 'okx-save' ? <Spinner /> : <SaveIcon />}
                    {snapshot.settings.okxConfigured ? '保存新 API 并验证' : '保存并验证'}
                  </button>
                </>
              )}
            </div>
          </form>
        </SettingsCard>

        <SettingsCard
          number="04"
          title="网络与交易参数"
          subtitle="Clash Party 用于 Telegram、AI 与 OKX 直连失败回退"
          icon={<SlidersIcon />}
        >
          <form className="form-grid settings-parameters" onSubmit={(event) => void saveStrategy(event)}>
            <div className="field-group-title span-full">
              <span>代理</span>
              <small>OKX REST 与私有 WS 均直连优先</small>
            </div>
            <div className="network-routing-note span-full">
              <WarningIcon />
              <span>OKX REST 与私有 WebSocket 均自动直连优先；直连失败时各自固定走 Clash，连接期间不再切换。“应用直连”仅表示程序未注入代理，系统 VPN/TUN 仍可能影响实际出口。</span>
            </div>
            <Field label="主机">
              <input
                value={settings.proxyHost}
                onChange={(event) => setSettings((current) => ({ ...current, proxyHost: event.target.value }))}
              />
            </Field>
            <Field label="端口">
              <input
                inputMode="numeric"
                value={settings.proxyPort}
                onChange={(event) => setSettings((current) => ({ ...current, proxyPort: event.target.value }))}
              />
            </Field>
            <Field label="协议">
              <select
                value={settings.proxyProtocol}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    proxyProtocol: event.target.value as 'auto' | 'http' | 'socks5',
                  }))
                }
              >
                <option value="auto">自动检测</option>
                <option value="http">HTTP</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </Field>

            <div className="field-group-title span-full with-rule">
              <span>策略</span>
              <small>首版安全约束</small>
            </div>
            <Field label="频道">
              <input
                value={settings.channelUsername}
                onChange={(event) => setSettings((current) => ({ ...current, channelUsername: event.target.value }))}
              />
            </Field>
            <Field label="每单名义价值" suffix="USDT">
              <input
                inputMode="decimal"
                value={settings.orderNotionalUsdt}
                disabled
              />
            </Field>
            <Field label="杠杆" suffix="x">
              <input
                inputMode="decimal"
                value={settings.leverage}
                disabled
              />
            </Field>
            <Field label="同币冷却" suffix="分钟">
              <input
                inputMode="numeric"
                value={settings.cooldownMinutes}
                onChange={(event) => setSettings((current) => ({ ...current, cooldownMinutes: event.target.value }))}
              />
            </Field>
            <Field label="AI 超时" suffix="秒">
              <input
                inputMode="decimal"
                value={settings.aiTimeoutSeconds}
                onChange={(event) => setSettings((current) => ({ ...current, aiTimeoutSeconds: event.target.value }))}
              />
            </Field>
            <Field label="持仓模式">
              <input value="逐仓 · 单向 · 最多 1 仓" disabled />
            </Field>

            <div className="toggle-grid span-full">
              <Toggle
                label="桌面通知"
                description="下单、跳过与错误状态"
                checked={settings.notificationsEnabled}
                onChange={(checked) => setSettings((current) => ({ ...current, notificationsEnabled: checked }))}
              />
              <Toggle
                label="提示音"
                description="关键交易状态播报"
                checked={settings.soundsEnabled}
                onChange={(checked) => setSettings((current) => ({ ...current, soundsEnabled: checked }))}
              />
            </div>

            <div className="form-actions span-full settings-footer">
              <button
                type="button"
                className="button button-secondary"
                disabled={Boolean(busyAction)}
                onClick={() => void diagnoseNetwork()}
              >
                {busyAction === 'diagnostics' ? <Spinner /> : <PulseIcon />}
                可选：测试网络出口
              </button>
              <button className="button button-primary" disabled={Boolean(busyAction)}>
                {busyAction === 'settings-save' ? <Spinner /> : <SaveIcon />}
                保存设置
              </button>
            </div>
          </form>
        </SettingsCard>
      </div>
    </div>
  )
}

function SignalCard({ signal, newest }: { signal: SignalRecord; newest: boolean }): JSX.Element {
  const stage = STAGE_META[signal.stage]
  const decision = signal.analysis ? DECISION_META[signal.analysis.decision] : null
  const awaitingTelegramRecovery = signal.stage === 'received' && signal.telegram.recovered === true
  const age = relativeTime(signal.telegram.receivedAt)
  const messageText = signal.telegram.text.trim() || '该消息没有正文内容'

  return (
    <article className={`signal-card ${newest ? 'newest' : ''}`}>
      <div className="timeline-rail">
        <span className={`timeline-node ${stage.tone}`} />
        <span className="timeline-line" />
      </div>
      <div className="signal-content">
        <div className="signal-meta-row">
          <div className="channel-identity">
            <span className="channel-avatar"><TelegramIcon /></span>
            <div>
              <strong>@{signal.telegram.channelUsername}</strong>
              <span>{formatClock(signal.telegram.date)} · {age}</span>
            </div>
          </div>
          <span className={`status-chip ${stage.tone}`}>
            {stage.tone === 'pending' && <Spinner />}
            {stage.label}
          </span>
        </div>

        <p className="signal-message">{messageText}</p>

        {signal.analysis ? (
          <div className="analysis-box">
            <div className={`decision-block ${decision?.tone}`}>
              <span className="decision-arrow">{decision?.icon}</span>
              <div>
                <small>AI 判断</small>
                <strong>{decision?.label}</strong>
              </div>
            </div>
            <div className="analysis-symbols">
              <small>币种</small>
              <div>
                {signal.analysis.symbols.length
                  ? signal.analysis.symbols.map((symbol) => <span key={symbol}>{symbol}</span>)
                  : <span className="muted-token">未识别</span>}
              </div>
            </div>
            <div className="confidence-block">
              <div className="confidence-top">
                <small>置信度</small>
                <strong>{Math.round(signal.analysis.confidence * 100)}%</strong>
              </div>
              <div className="confidence-track">
                <span style={{ width: `${Math.round(signal.analysis.confidence * 100)}%` }} />
              </div>
            </div>
            <p className="analysis-reason">{signal.analysis.reason}</p>
            <div className="analysis-footnote">
              <span>{signal.analysis.model ?? 'ChatGPT 自动模型'}</span>
              <span>{(signal.analysis.latencyMs / 1000).toFixed(2)} 秒</span>
            </div>
          </div>
        ) : (
          <div className="analysis-pending">
            <span className="thinking-orb"><SparkIcon /></span>
            <div>
              <strong>{awaitingTelegramRecovery ? '消息已立即显示' : '正在分析消息'}</strong>
              <small>
                {awaitingTelegramRecovery
                  ? '正在校验 Telegram 断线补拉顺序，确认后再开始 AI 分析'
                  : '最长等待 10 秒，超时将自动跳过'}
              </small>
            </div>
            <span className="loading-dots"><i /><i /><i /></span>
          </div>
        )}

        <div className="signal-result-line">
          <span className={`result-icon ${stage.tone}`}>
            {stage.tone === 'success' ? <CheckIcon /> : stage.tone === 'danger' ? <CrossIcon /> : <InfoIcon />}
          </span>
          <span>{signal.detail}</span>
          {signal.instrumentId && <code>{signal.instrumentId}</code>}
          {signal.orderId && <small>订单 {truncateId(signal.orderId)}</small>}
        </div>
      </div>
    </article>
  )
}

function PositionCard({
  position,
  closing,
  okxConnected,
  onClose,
}: {
  position: AppPosition
  closing: boolean
  okxConnected: boolean
  onClose: () => void
}): JSX.Element {
  const positive = position.unrealizedPnl >= 0
  const closePending = Boolean(position.closePending)
  const closeBusy = closing || closePending
  return (
    <article className="position-card">
      <div className="position-heading">
        <div className="instrument-name">
          <span className={`direction-icon ${position.direction}`}>
            {position.direction === 'long' ? '↗' : '↘'}
          </span>
          <div>
            <strong>{position.instrumentId}</strong>
            <span>{position.marginMode === 'isolated' ? '逐仓' : '全仓'} · {position.leverage}x</span>
          </div>
        </div>
        <span className={`direction-badge ${position.direction}`}>
          {position.direction === 'long' ? '多' : '空'}
        </span>
      </div>

      <div className="position-pnl">
        <small>未实现盈亏</small>
        <strong className={positive ? 'positive' : 'negative'}>
          {positive ? '+' : ''}{formatMoney(position.unrealizedPnl)} USDT
        </strong>
        <span className={positive ? 'positive' : 'negative'}>
          {positive ? '+' : ''}{position.unrealizedPnlPercent.toFixed(2)}%
        </span>
      </div>

      <dl className="position-stats">
        <div><dt>张数</dt><dd>{formatNumber(position.contracts)}</dd></div>
        <div><dt>名义价值</dt><dd>{position.notionalUsd ? `${formatMoney(position.notionalUsd)} U` : '—'}</dd></div>
        <div><dt>开仓均价</dt><dd>{formatPrice(position.averagePrice)}</dd></div>
        <div><dt>标记价格</dt><dd>{formatPrice(position.markPrice)}</dd></div>
      </dl>

      <button
        className="close-position-button"
        disabled={closeBusy || !okxConnected}
        title={closePending
          ? `平仓订单仍在处理中：${formatCloseOrderState(position.closeOrderState)}`
          : okxConnected
            ? `确认后对 ${position.instrumentId} 提交 reduce-only 市价整仓平仓`
            : 'OKX 未连接，暂时无法提交平仓'}
        onClick={onClose}
      >
        {closeBusy ? <Spinner /> : <ExitIcon />}
        {closeBusy ? '平仓处理中' : okxConnected ? '整仓市价平仓' : 'OKX 连接后平仓'}
      </button>
      {closePending && (
        <span className="close-order-state" role="status">
          平仓订单状态：{formatCloseOrderState(position.closeOrderState)}
        </span>
      )}
      <small className="position-updated">更新于 {formatClock(position.updatedAt)}</small>
    </article>
  )
}

function SafetyCard({ snapshot, latestSignal }: { snapshot: AppSnapshot; latestSignal?: SignalRecord }): JSX.Element {
  const checks = [
    { label: '最多同时 1 个仓位', ok: snapshot.positions.length < snapshot.settings.trading.maxConcurrentPositions },
    { label: '同币 60 分钟冷却', ok: true },
    { label: 'OKX 直连优先，失败固定走 Clash', ok: true },
    { label: 'AI 10 秒超时即跳过', ok: true },
  ]
  return (
    <div className="panel safety-panel">
      <PanelHeader eyebrow="SAFETY GATE" title="下单保护" aside={<ShieldIcon />} />
      <div className="safety-body">
        <div className="safety-checks">
          {checks.map((check) => (
            <div key={check.label} className={check.ok ? 'ok' : 'blocked'}>
              <span>{check.ok ? <CheckIcon /> : <CrossIcon />}</span>
              <p>{check.label}</p>
            </div>
          ))}
        </div>
        <div className="last-action">
          <small>最近处理</small>
          <strong>{latestSignal ? STAGE_META[latestSignal.stage].label : '暂无记录'}</strong>
          <span>{latestSignal?.detail ?? '开始监听后显示最新处理结果'}</span>
        </div>
      </div>
    </div>
  )
}

function DiagnosticsSummary({ diagnostics }: { diagnostics: NetworkDiagnostics }): JSX.Element {
  const presentation = presentNetworkDiagnostics(diagnostics)
  return (
    <div className="diagnostics-summary">
      {presentation.rows.map((row) => (
        <div key={row.label}>
          <span className={row.tone} />
          <small>{row.label}</small>
          <strong>{row.value}</strong>
        </div>
      ))}
      {presentation.checked && diagnostics.checkedAt !== undefined && (
        <p title={diagnostics.detail}>
          检测 {formatClock(diagnostics.checkedAt)} · {presentation.addressSummary}
        </p>
      )}
    </div>
  )
}

function OkxRoutesSummary({ routes }: { routes: AppSnapshot['okxRoutes'] }): JSX.Element {
  return (
    <div className="okx-routes-summary" aria-label="OKX 本次连接路由">
      <div className="okx-routes-heading">
        <strong>本次连接路由</strong>
        <small>REST 与私有 WS 独立检测，选中后锁定</small>
      </div>
      <div className="okx-route-grid">
        <OkxRouteRow label="REST API" route={routes.rest} />
        <OkxRouteRow label="Private WS" route={routes.privateWs} />
      </div>
      <p>“应用直连”表示程序未注入 Clash；系统 VPN/TUN 仍可能接管实际出口。</p>
    </div>
  )
}

function OkxRouteRow({ label, route }: { label: string; route: AppSnapshot['okxRoutes']['rest'] }): JSX.Element {
  const proxyProtocol = route.protocol === 'socks5' ? 'SOCKS5' : route.protocol === 'http' ? 'HTTP' : 'AUTO'
  const routeLabel = route.kind === 'direct'
    ? '应用直连'
    : route.kind === 'proxy'
      ? `Clash ${proxyProtocol}${route.endpoint ? `（${route.endpoint}）` : ''}`
      : '待检测'

  return (
    <div className={`okx-route-row ${route.kind}`} title={route.detail}>
      <i aria-hidden="true" />
      <div>
        <small>{label}</small>
        <strong>{routeLabel}</strong>
        {route.detail && <span>{route.detail}</span>}
      </div>
      <div className="okx-route-meta">
        {route.selectedAt && <time dateTime={normalizeDate(route.selectedAt).toISOString()}>{formatClock(route.selectedAt)}</time>}
      </div>
    </div>
  )
}

function SettingsCard({
  number,
  title,
  subtitle,
  status,
  statusLabel,
  icon,
  children,
}: {
  number: string
  title: string
  subtitle: string
  status?: ConnectionStatus
  statusLabel?: string
  icon: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section className="settings-card">
      <div className="settings-card-header">
        <div className="settings-number">{number}</div>
        <div className="settings-icon">{icon}</div>
        <div className="settings-title">
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        {status && <ConnectionBadge status={status} displayLabel={statusLabel} />}
      </div>
      <div className="settings-card-body">{children}</div>
    </section>
  )
}

function Field({ label, hint, suffix, children }: { label: string; hint?: string; suffix?: string; children: ReactNode }): JSX.Element {
  return (
    <label className="form-field">
      <span className="field-label">{label}{hint && <small>{hint}</small>}</span>
      <span className={`input-wrap ${suffix ? 'with-suffix' : ''}`}>
        {children}
        {suffix && <span className="input-suffix">{suffix}</span>}
      </span>
    </label>
  )
}

function Toggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (checked: boolean) => void }): JSX.Element {
  return (
    <label className="toggle-row">
      <span><strong>{label}</strong><small>{description}</small></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  )
}

function ConnectionPill({
  name,
  status,
  displayLabel,
  icon,
}: {
  name: string
  status: ConnectionStatus
  displayLabel?: string
  icon: ReactNode
}): JSX.Element {
  return (
    <div className={`connection-pill ${status.phase}`} title={status.detail}>
      <span className="connection-icon">{icon}</span>
      <span className="connection-copy"><small>{name}</small><strong>{displayLabel ?? PHASE_LABELS[status.phase]}</strong></span>
      <span className="connection-dot" />
    </div>
  )
}

function ConnectionBadge({ status, displayLabel }: { status: ConnectionStatus; displayLabel?: string }): JSX.Element {
  return <span className={`connection-badge ${status.phase}`}><i />{displayLabel ?? PHASE_LABELS[status.phase]}</span>
}

function quotaAwareChatGptStatus(snapshot: AppSnapshot): ConnectionStatus {
  if (!snapshot.aiQuotaExhausted) return snapshot.connections.chatgpt
  return {
    ...snapshot.connections.chatgpt,
    phase: 'error',
    label: '额度用尽',
    detail: '无法进行 AI 分析或自动下单；Telegram 监听与频道消息接收仍会继续',
  }
}

function MetricCard({ label, value, subvalue, tone, icon }: { label: string; value: string; subvalue: string; tone: string; icon: ReactNode }): JSX.Element {
  return (
    <div className={`metric-card ${tone}`}>
      <span className="metric-icon">{icon}</span>
      <div><small>{label}</small><strong>{value}</strong><span>{subvalue}</span></div>
    </div>
  )
}

function PanelHeader({ eyebrow, title, aside }: { eyebrow: string; title: string; aside?: ReactNode }): JSX.Element {
  return (
    <header className="panel-header">
      <div><span>{eyebrow}</span><h2>{title}</h2></div>
      {aside && <div className="panel-aside">{aside}</div>}
    </header>
  )
}

function EmptyState({ icon, title, description, action, compact = false }: { icon: ReactNode; title: string; description: string; action?: ReactNode; compact?: boolean }): JSX.Element {
  return (
    <div className={`empty-state ${compact ? 'compact' : ''}`}>
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  )
}

function ToastStack({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: string) => void }): JSX.Element {
  return (
    <div className="toast-stack" aria-live="polite">
      {items.map((item) => (
        <article key={item.id} className={`toast ${item.level}`}>
          <span className="toast-icon">
            {item.level === 'success' ? <CheckIcon /> : item.level === 'error' ? <CrossIcon /> : item.level === 'warning' ? <WarningIcon /> : <InfoIcon />}
          </span>
          <div><strong>{item.title}</strong><p>{item.detail}</p><small>{relativeTime(item.createdAt)}</small></div>
          <button aria-label="关闭通知" onClick={() => onDismiss(item.id)}>×</button>
        </article>
      ))}
    </div>
  )
}

function AuthPromptDialog({ prompt, busy, onSubmit, onCancel }: { prompt: AuthPrompt; busy: boolean; onSubmit: (value: string) => void; onCancel: () => void }): JSX.Element {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])
  return (
    <ModalShell>
      <form className="dialog" onSubmit={(event) => { event.preventDefault(); if (value.trim()) onSubmit(value.trim()) }}>
        <div className="dialog-icon info"><TelegramIcon /></div>
        <span className="eyebrow">TELEGRAM AUTH</span>
        <h2>{prompt.title}</h2>
        <p>{prompt.detail}</p>
        <label className="dialog-input-label">
          {prompt.kind === 'telegram_code' ? '验证码' : prompt.kind === 'telegram_password' ? '两步验证密码' : '手机号'}
          <input
            ref={inputRef}
            type={prompt.secret ? 'password' : prompt.kind === 'telegram_phone' ? 'tel' : 'text'}
            inputMode={prompt.kind === 'telegram_code' ? 'numeric' : undefined}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={prompt.kind === 'telegram_code' ? '输入 Telegram 验证码' : '请输入'}
            autoComplete={prompt.secret ? 'current-password' : 'one-time-code'}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="button button-secondary" disabled={busy} onClick={onCancel}>取消</button>
          <button className="button button-primary" disabled={busy || !value.trim()}>{busy && <Spinner />}提交</button>
        </div>
      </form>
    </ModalShell>
  )
}

function LiveConfirmDialog({
  blockers,
  busy,
  trading,
  onCancel,
  onConfirm,
}: {
  blockers: string[]
  busy: boolean
  trading: PublicSettings['trading']
  onCancel: () => void
  onConfirm: (confirmation: string) => void
}): JSX.Element {
  const [confirmation, setConfirmation] = useState('')
  const valid = confirmation === '确认实盘'
  return (
    <ModalShell>
      <form className="dialog danger-dialog" onSubmit={(event) => { event.preventDefault(); if (valid) onConfirm(confirmation) }}>
        <div className="dialog-icon danger"><LockIcon /></div>
        <span className="eyebrow">LIVE TRADING</span>
        <h2>解锁真实资金交易</h2>
        <p>解锁后，符合规则的频道消息会在 AI 分析后直接以市价提交到 OKX 子账户。</p>
        <div className="risk-list">
          <div><WarningIcon /><span>每单约 {formatMoney(trading.orderNotionalUsdt)} USDT，{trading.leverage}x 杠杆，最多同时 {trading.maxConcurrentPositions} 个仓位</span></div>
          <div><WarningIcon /><span>当前没有自动止损、止盈或超时平仓</span></div>
          <div><WarningIcon /><span>程序退出后，已有仓位会继续存在</span></div>
        </div>
        {blockers.length > 0 && <div className="blocker-box"><strong>当前仍有阻止项</strong>{blockers.map((item) => <span key={item}>• {item}</span>)}</div>}
        <label className="dialog-input-label">
          输入 <code>确认实盘</code> 继续
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="确认实盘" autoFocus />
        </label>
        <div className="dialog-actions">
          <button type="button" className="button button-secondary" disabled={busy} onClick={onCancel}>保持锁定</button>
          <button className="button button-danger" disabled={busy || !valid || blockers.length > 0}>{busy && <Spinner />}确认解锁</button>
        </div>
      </form>
    </ModalShell>
  )
}

function ClosePositionConfirmDialog({
  position,
  okxConnected,
  busy,
  onCancel,
  onConfirm,
}: {
  position: AppPosition
  okxConnected: boolean
  busy: boolean
  onCancel: () => void
  onConfirm: (confirmation: '确认平仓') => void
}): JSX.Element {
  const [confirmation, setConfirmation] = useState('')
  const valid = confirmation === '确认平仓'
  const directionLabel = position.direction === 'long' ? '多单' : '空单'

  return (
    <ModalShell>
      <form
        className="dialog danger-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid && !busy && okxConnected) onConfirm('确认平仓')
        }}
      >
        <div className="dialog-icon danger"><ExitIcon /></div>
        <span className="eyebrow">REDUCE-ONLY MARKET CLOSE</span>
        <h2>确认平仓 {position.instrumentId}</h2>
        <p>
          将对 <strong>{position.instrumentId}</strong> 提交仅减仓（reduce-only）市价单，整仓关闭当前
          {formatNumber(position.contracts)} 张{directionLabel}。
        </p>
        <div className="risk-list close-position-risk-list">
          <div><WarningIcon /><span>交易对：{position.instrumentId}；只处理该交易对的当前仓位，不影响其他交易对</span></div>
          <div><WarningIcon /><span>仅减仓整仓平仓，不会用于开新仓、加仓或反向建仓</span></div>
          <div><WarningIcon /><span>订单按市价提交，最终成交价格可能因行情波动产生滑点</span></div>
        </div>
        {!okxConnected && (
          <div className="blocker-box" role="alert">
            <strong>OKX 当前未连接</strong>
            <span>恢复 OKX 连接后才能提交本次平仓。</span>
          </div>
        )}
        <label className="dialog-input-label">
          输入 <code>确认平仓</code> 后才能提交
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder="确认平仓"
            autoComplete="off"
            autoFocus
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="button button-secondary" onClick={onCancel}>
            {busy ? '关闭窗口' : '取消'}
          </button>
          <button className="button button-danger" disabled={busy || !valid || !okxConnected}>
            {busy && <Spinner />}{busy ? '平仓处理中' : '提交整仓平仓'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

function ConfirmDialog({ tone, title, description, confirmLabel, busy, onCancel, onConfirm }: { tone: 'danger' | 'info'; title: string; description: string; confirmLabel: string; busy: boolean; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  return (
    <ModalShell>
      <div className="dialog compact-dialog">
        <div className={`dialog-icon ${tone}`}>{tone === 'danger' ? <WarningIcon /> : <InfoIcon />}</div>
        <h2>{title}</h2>
        <p>{description}</p>
        <div className="dialog-actions">
          <button className="button button-secondary" disabled={busy} onClick={onCancel}>取消</button>
          <button className={tone === 'danger' ? 'button button-danger' : 'button button-primary'} disabled={busy} onClick={onConfirm}>{busy && <Spinner />}{confirmLabel}</button>
        </div>
      </div>
    </ModalShell>
  )
}

function ModalShell({ children }: { children: ReactNode }): JSX.Element {
  return <div className="modal-backdrop"><div className="modal-center">{children}</div></div>
}

function LoadingScreen(): JSX.Element {
  return (
    <div className="loading-screen">
      <div className="loading-logo"><LogoMark /></div>
      <div className="loading-copy"><strong>BWE Trader</strong><span>正在加载本机交易服务…</span></div>
      <div className="loading-bar"><span /></div>
    </div>
  )
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 }).format(value)
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const digits = value >= 1_000 ? 2 : value >= 1 ? 4 : 8
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value)
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(normalizeDate(timestamp))
}

function relativeTime(timestamp: number): string {
  const date = normalizeDate(timestamp).getTime()
  const seconds = Math.max(0, Math.round((Date.now() - date) / 1_000))
  if (seconds < 10) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function normalizeDate(timestamp: number): Date {
  return new Date(timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp)
}

function isToday(timestamp: number): boolean {
  const date = normalizeDate(timestamp)
  const today = new Date()
  return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
}

function truncateId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
}

function formatCloseOrderState(value?: string): string {
  const normalized = value?.trim().toLowerCase()
  const labels: Record<string, string> = {
    submitting: '正在提交',
    acknowledged: '交易所已受理',
    live: '等待成交',
    partially_filled: '部分成交',
    reconciling: '正在对账',
    unknown: '成交状态待确认',
  }
  return normalized ? labels[normalized] ?? value!.trim() : '等待交易所更新'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function playNotificationTone(level: NotificationItem['level']): void {
  try {
    const AudioContextClass = window.AudioContext
    if (!AudioContextClass) return
    const context = new AudioContextClass()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = level === 'error' ? 'sawtooth' : 'sine'
    oscillator.frequency.value = level === 'success' ? 660 : level === 'error' ? 220 : 440
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.06, context.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.17)
    oscillator.addEventListener('ended', () => void context.close(), { once: true })
  } catch {
    // Sound is optional and must never affect trading or notifications.
  }
}

function SvgIcon({ children, viewBox = '0 0 24 24' }: { children: ReactNode; viewBox?: string }): JSX.Element {
  return <svg viewBox={viewBox} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">{children}</svg>
}

function LogoMark(): JSX.Element { return <SvgIcon><path d="M5 5h5l2 3 2-3h5l-4 7 4 7h-5l-2-3-2 3H5l4-7-4-7Z" fill="currentColor"/><path d="M12 3v18" stroke="currentColor" strokeWidth="1.2" opacity=".35"/></SvgIcon> }
function DashboardIcon(): JSX.Element { return <SvgIcon><rect x="3" y="3" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.7"/><rect x="14" y="3" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.7"/><rect x="3" y="14" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.7"/><rect x="14" y="14" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.7"/></SvgIcon> }
function SettingsIcon(): JSX.Element { return <SvgIcon><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.07 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63h.01A1.7 1.7 0 0 0 10 3.07V3h4v.08A1.7 1.7 0 0 0 15.03 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9v.01A1.7 1.7 0 0 0 20.93 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></SvgIcon> }
function TelegramIcon(): JSX.Element { return <SvgIcon><path d="m21 4-3 16-6-4-3 3-1-5-5-2 18-8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="m8 14 9-7-6 8.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></SvgIcon> }
function SparkIcon(): JSX.Element { return <SvgIcon><path d="M12 3c.6 4.7 3.3 7.4 8 8-4.7.6-7.4 3.3-8 8-.6-4.7-3.3-7.4-8-8 4.7-.6 7.4-3.3 8-8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M19 2v4M21 4h-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></SvgIcon> }
function OkxIcon(): JSX.Element { return <SvgIcon><rect x="3" y="3" width="7" height="7" rx="1" fill="currentColor"/><rect x="14" y="3" width="7" height="7" rx="1" fill="currentColor" opacity=".55"/><rect x="3" y="14" width="7" height="7" rx="1" fill="currentColor" opacity=".55"/><rect x="14" y="14" width="7" height="7" rx="1" fill="currentColor"/></SvgIcon> }
function PlayIcon(): JSX.Element { return <SvgIcon><path d="m8 5 11 7-11 7V5Z" fill="currentColor"/></SvgIcon> }
function StopIcon(): JSX.Element { return <SvgIcon><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></SvgIcon> }
function LockIcon(): JSX.Element { return <SvgIcon><rect x="5" y="10" width="14" height="11" rx="3" stroke="currentColor" strokeWidth="1.7"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></SvgIcon> }
function PowerIcon(): JSX.Element { return <SvgIcon><path d="M12 3v9" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M7 5.8a8 8 0 1 0 10 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></SvgIcon> }
function BroadcastIcon(): JSX.Element { return <SvgIcon><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9.2 9.2 0 0 0 0 13M18.5 5.5a9.2 9.2 0 0 1 0 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></SvgIcon> }
function MessageIcon(): JSX.Element { return <SvgIcon><path d="M4 5h16v12H9l-5 4V5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M8 9h8M8 13h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></SvgIcon> }
function PositionIcon(): JSX.Element { return <SvgIcon><path d="M4 19V9M10 19V4M16 19v-7M22 19H2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><path d="m4 7 6-4 6 6 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></SvgIcon> }
function ChartIcon(): JSX.Element { return <SvgIcon><path d="M3 19h18M5 16l4-5 4 3 6-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><path d="M15 6h4v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></SvgIcon> }
function ArrowIcon(): JSX.Element { return <SvgIcon><path d="M5 12h14M14 7l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></SvgIcon> }
function CheckIcon(): JSX.Element { return <SvgIcon><path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></SvgIcon> }
function CrossIcon(): JSX.Element { return <SvgIcon><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></SvgIcon> }
function InfoIcon(): JSX.Element { return <SvgIcon><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7"/><path d="M12 11v6M12 7.5v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></SvgIcon> }
function WarningIcon(): JSX.Element { return <SvgIcon><path d="M12 3 2.5 20h19L12 3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M12 9v5M12 17v.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></SvgIcon> }
function ShieldIcon(): JSX.Element { return <SvgIcon><path d="M12 3 4.5 6v5.5c0 4.7 3 8 7.5 9.5 4.5-1.5 7.5-4.8 7.5-9.5V6L12 3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="m8.5 12 2.2 2.2 4.8-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></SvgIcon> }
function SlidersIcon(): JSX.Element { return <SvgIcon><path d="M4 7h6M14 7h6M4 17h10M18 17h2M10 4v6M14 14v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><circle cx="10" cy="7" r="2" fill="currentColor"/><circle cx="16" cy="17" r="2" fill="currentColor"/></SvgIcon> }
function ExternalIcon(): JSX.Element { return <SvgIcon><path d="M13 5h6v6M19 5l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/><path d="M17 14v5H5V7h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></SvgIcon> }
function PulseIcon(): JSX.Element { return <SvgIcon><path d="M3 12h4l2-6 4 12 2-6h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></SvgIcon> }
function SaveIcon(): JSX.Element { return <SvgIcon><path d="M5 3h12l3 3v15H4V3h1Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M8 3v6h8V3M8 21v-7h8v7" stroke="currentColor" strokeWidth="1.5"/></SvgIcon> }
function ExitIcon(): JSX.Element { return <SvgIcon><path d="M10 5H5v14h5M13 8l4 4-4 4M17 12H9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></SvgIcon> }
function Spinner(): JSX.Element { return <span className="spinner" aria-label="处理中" /> }

export default App
