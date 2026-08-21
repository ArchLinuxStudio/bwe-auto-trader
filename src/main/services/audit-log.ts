import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export interface AuditEntry {
  at: string
  event: string
  severity: 'info' | 'warning' | 'error' | 'critical'
  data?: Record<string, unknown>
}

const SECRET_KEY_PATTERN = /(secret|passphrase|password|api.?hash|api.?key|session|token|code)/i

export class AuditLog {
  private readonly filePath: string
  private tail: Promise<void> = Promise.resolve()

  constructor(userDataDirectory: string) {
    this.filePath = path.join(userDataDirectory, 'audit', 'events.jsonl')
  }

  async write(event: string, severity: AuditEntry['severity'], data?: Record<string, unknown>): Promise<void> {
    const entry: AuditEntry = {
      at: new Date().toISOString(),
      event,
      severity,
      ...(data ? { data: redact(data) as Record<string, unknown> } : {})
    }
    const operation = async (): Promise<void> => {
      await mkdir(path.dirname(this.filePath), { recursive: true })
      await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8')
    }
    const next = this.tail.then(operation, operation)
    this.tail = next.catch(() => undefined)
    await next
  }

  async readRecent(limit = 200): Promise<AuditEntry[]> {
    try {
      const lines = (await readFile(this.filePath, 'utf8')).trim().split(/\r?\n/)
      return lines.slice(-limit).flatMap((line) => {
        try { return [JSON.parse(line) as AuditEntry] } catch { return [] }
      })
    } catch {
      return []
    }
  }
}

function redact(value: unknown, key = ''): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]))
  }
  return value
}
