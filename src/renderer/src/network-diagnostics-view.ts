import type { NetworkDiagnostics } from '../../shared/types'

export type NetworkDiagnosticTone = '' | 'ok' | 'info' | 'optional' | 'warning'

export interface NetworkDiagnosticRow {
  label: string
  value: string
  tone: NetworkDiagnosticTone
}

export interface NetworkDiagnosticsPresentation {
  checked: boolean
  directIpStatus: string
  rows: NetworkDiagnosticRow[]
  addressSummary?: string
  incompleteItems: string[]
}

/**
 * Keeps "not run" distinct from a completed probe that returned a negative
 * or incomplete result. The service records checkedAt for every completed
 * diagnostic run, including partial failures.
 */
export function presentNetworkDiagnostics(
  diagnostics: NetworkDiagnostics
): NetworkDiagnosticsPresentation {
  const checked = typeof diagnostics.checkedAt === 'number'
  const incompleteItems: string[] = []

  if (checked) {
    if (!diagnostics.directIp) incompleteItems.push('直连出口 IP')
    if (!diagnostics.proxyReachable) incompleteItems.push('Clash Party')
    else if (!diagnostics.proxiedIp) incompleteItems.push('代理出口 IP')
    if (!diagnostics.okxDirect) incompleteItems.push('OKX 可选端点')
  }

  return {
    checked,
    directIpStatus: !checked
      ? '尚未检测'
      : diagnostics.directIp
        ? `最近检测 ${diagnostics.directIp}`
        : '已检测，未获取到直连出口 IP',
    rows: [
      {
        label: 'Clash Party',
        value: !checked ? '未验证' : diagnostics.proxyReachable ? '可达' : '检测未通过',
        tone: !checked ? '' : diagnostics.proxyReachable ? 'ok' : 'warning'
      },
      {
        label: '代理协议',
        value: !checked ? '待检测' : diagnostics.proxyProtocol?.toUpperCase() ?? '未识别',
        tone: !checked ? '' : diagnostics.proxyProtocol ? 'ok' : 'warning'
      },
      {
        label: 'OKX 出口（可选）',
        value: !checked ? '未验证' : diagnostics.okxDirect ? '端点可达' : '检测未通过',
        tone: !checked ? 'optional' : diagnostics.okxDirect ? 'info' : 'warning'
      }
    ],
    addressSummary: checked
      ? `直连 ${diagnostics.directIp ?? '未获取'} · 代理 ${diagnostics.proxiedIp ?? '未获取'}`
      : undefined,
    incompleteItems
  }
}
