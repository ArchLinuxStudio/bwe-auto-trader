import { describe, expect, it } from 'vitest'

import { presentNetworkDiagnostics } from '../../src/renderer/src/network-diagnostics-view'

describe('network diagnostics presentation', () => {
  it('shows an untouched diagnostic as not checked', () => {
    const view = presentNetworkDiagnostics({ proxyReachable: false, okxDirect: false })

    expect(view.checked).toBe(false)
    expect(view.directIpStatus).toBe('尚未检测')
    expect(view.rows.map((row) => row.value)).toEqual(['未验证', '待检测', '未验证'])
    expect(view.addressSummary).toBeUndefined()
    expect(view.incompleteItems).toEqual([])
  })

  it('shows completed negative probes as failures even when checkedAt is zero', () => {
    const view = presentNetworkDiagnostics({
      proxyReachable: false,
      okxDirect: false,
      checkedAt: 0,
      detail: 'probes completed with failures'
    })

    expect(view.checked).toBe(true)
    expect(view.directIpStatus).toBe('已检测，未获取到直连出口 IP')
    expect(view.rows).toEqual([
      { label: 'Clash Party', value: '检测未通过', tone: 'warning' },
      { label: '代理协议', value: '未识别', tone: 'warning' },
      { label: 'OKX 出口（可选）', value: '检测未通过', tone: 'warning' }
    ])
    expect(view.addressSummary).toBe('直连 未获取 · 代理 未获取')
    expect(view.incompleteItems).toEqual(['直连出口 IP', 'Clash Party', 'OKX 可选端点'])
  })

  it('shows successful probes and their detected addresses', () => {
    const view = presentNetworkDiagnostics({
      proxyReachable: true,
      proxyProtocol: 'socks5',
      directIp: '203.0.113.10',
      proxiedIp: '198.51.100.20',
      okxDirect: true,
      checkedAt: 123
    })

    expect(view.checked).toBe(true)
    expect(view.directIpStatus).toBe('最近检测 203.0.113.10')
    expect(view.rows.map((row) => row.value)).toEqual(['可达', 'SOCKS5', '端点可达'])
    expect(view.addressSummary).toBe('直连 203.0.113.10 · 代理 198.51.100.20')
    expect(view.incompleteItems).toEqual([])
  })
})
