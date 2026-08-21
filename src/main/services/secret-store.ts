import { safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

interface SecretEnvelope {
  version: 1
  encrypted: Record<string, string>
}

/** OS-backed encryption at rest. The application refuses to persist plaintext. */
export class SecretStore {
  private readonly filePath: string
  private cache: SecretEnvelope | null = null
  private writeTail: Promise<void> = Promise.resolve()

  constructor(userDataDirectory: string) {
    this.filePath = path.join(userDataDirectory, 'secrets.v1.json')
  }

  get available(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  get backend(): string {
    return process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os'
  }

  async get(key: string): Promise<string | undefined> {
    this.assertSecureStorage()
    const state = await this.load()
    const encoded = state.encrypted[key]
    if (!encoded) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    } catch {
      throw new Error(`无法解密本机凭据：${key}`)
    }
  }

  async set(key: string, value: string): Promise<void> {
    this.assertSecureStorage()
    await this.enqueue(async () => {
      const state = await this.load()
      state.encrypted[key] = safeStorage.encryptString(value).toString('base64')
      await this.flush(state)
    })
  }

  async delete(key: string): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.load()
      delete state.encrypted[key]
      await this.flush(state)
    })
  }

  private assertSecureStorage(): void {
    if (!this.available) throw new Error('系统安全存储不可用，已拒绝保存敏感凭据')
    if (process.platform === 'linux' && this.backend === 'basic_text') {
      throw new Error('Linux 密钥环不可用，basic_text 不允许保存交易凭据')
    }
  }

  private async load(): Promise<SecretEnvelope> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as SecretEnvelope
      if (parsed.version !== 1 || typeof parsed.encrypted !== 'object') throw new Error('bad file')
      this.cache = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('本机凭据文件损坏，未加载任何密钥')
      }
      this.cache = { version: 1, encrypted: {} }
    }
    return this.cache
  }

  private async flush(state: SecretEnvelope): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeTail.then(operation, operation)
    this.writeTail = next.catch(() => undefined)
    await next
  }
}
