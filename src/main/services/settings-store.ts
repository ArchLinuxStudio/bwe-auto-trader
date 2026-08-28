import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import type { PublicSettings, SettingsUpdateInput } from '../../shared/types'
import { normalizeChannelUsername, settingsUpdateSchema } from '../../shared/validation'

export class SettingsStore {
  private readonly filePath: string
  private state: PublicSettings | null = null
  private writeTail: Promise<void> = Promise.resolve()

  constructor(userDataDirectory: string) {
    this.filePath = path.join(userDataDirectory, 'settings.v1.json')
  }

  async read(): Promise<PublicSettings> {
    if (this.state) return structuredClone(this.state)
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<PublicSettings>
      this.state = mergeSettings(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await this.quarantineBrokenFile().catch(() => undefined)
      }
      this.state = structuredClone(DEFAULT_SETTINGS)
    }
    return structuredClone(this.state)
  }

  async update(input: SettingsUpdateInput): Promise<PublicSettings> {
    const value = settingsUpdateSchema.parse(input)
    const current = await this.read()
    const next: PublicSettings = {
      ...current,
      ...value,
      proxy: { ...current.proxy, ...(value.proxy ?? {}) },
      trading: {
        ...current.trading,
        ...(value.trading ?? {}),
        channelUsername: normalizeChannelUsername(
          value.trading?.channelUsername ?? current.trading.channelUsername
        )
      }
    }
    await this.save(next)
    return structuredClone(next)
  }

  async setFlags(flags: Partial<Pick<PublicSettings,
    'okxConfigured' | 'telegramConfigured' | 'chatgptConfigured' | 'telegramApiId' | 'telegramPhoneHint'
  >>): Promise<PublicSettings> {
    const next = { ...(await this.read()), ...flags }
    await this.save(next)
    return structuredClone(next)
  }

  private async save(value: PublicSettings): Promise<void> {
    this.state = structuredClone(value)
    const operation = async (): Promise<void> => {
      await mkdir(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.tmp`
      await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
      await rename(temporary, this.filePath)
    }
    const next = this.writeTail.then(operation, operation)
    this.writeTail = next.catch(() => undefined)
    await next
  }

  private async quarantineBrokenFile(): Promise<void> {
    await rename(this.filePath, `${this.filePath}.broken-${Date.now()}`)
  }
}

function mergeSettings(value: Partial<PublicSettings>): PublicSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...value,
    proxy: { ...DEFAULT_SETTINGS.proxy, ...(value.proxy ?? {}) },
    trading: { ...DEFAULT_SETTINGS.trading, ...(value.trading ?? {}) },
    // This flag is only a startup hint. App Server account/read remains the
    // authority for whether a saved ChatGPT session is actually authenticated.
    chatgptConfigured: value.chatgptConfigured === true
  }
}
