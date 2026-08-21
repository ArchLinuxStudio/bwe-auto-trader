export interface TelegramRawMessageLike {
  id?: number
  message?: string
  text?: string
  date?: number | Date
  media?: unknown
  postAuthor?: string
}

export interface TelegramMessageContext {
  channelUsername: string
  channelId?: string
  channelTitle?: string
  receivedAt?: Date
}

export interface TelegramSignalMessage {
  channelUsername: string
  channelId?: string
  channelTitle?: string
  messageId: number
  text: string
  publishedAt: string
  receivedAt: string
  url: string
  hasMedia: boolean
  mediaKind?: string
  postAuthor?: string
}

export interface TelegramMessagePayloadLike {
  channelId: string
  messageId: number
  channelUsername: string
  text: string
  date: number
  receivedAt: number
  permalink?: string
}

const EMPTY_MEDIA_KINDS = new Set(['MessageMediaEmpty'])

export function normalizeTelegramUsername(username: string): string {
  return username.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').replace(/\/$/, '')
}

export function telegramMessageKey(channel: string, messageId: number): string {
  return `${normalizeTelegramUsername(channel).toLowerCase()}:${messageId}`
}

export function extractTelegramSignalMessage(
  raw: TelegramRawMessageLike,
  context: TelegramMessageContext,
): TelegramSignalMessage | null {
  const messageId = raw.id
  if (!Number.isSafeInteger(messageId) || (messageId ?? 0) <= 0) {
    return null
  }
  // The guard above narrows the runtime value, but TypeScript cannot infer
  // that through Number.isSafeInteger for an optional number.
  const validMessageId = messageId as number

  // In GramJS, `message` contains both a normal post body and a media caption.
  const text = normalizeMessageText(raw.message ?? raw.text ?? '')
  if (!text) {
    return null
  }

  const channelUsername = normalizeTelegramUsername(context.channelUsername)
  if (!channelUsername) {
    return null
  }

  const publishedAt = normalizePublishedAt(raw.date)
  const receivedAt = context.receivedAt ?? new Date()
  const mediaKind = readMediaKind(raw.media)

  return {
    channelUsername,
    channelId: context.channelId,
    channelTitle: context.channelTitle,
    messageId: validMessageId,
    text,
    publishedAt: publishedAt.toISOString(),
    receivedAt: receivedAt.toISOString(),
    url: `https://t.me/${channelUsername}/${validMessageId}`,
    hasMedia: Boolean(mediaKind),
    mediaKind,
    postAuthor: normalizeOptionalString(raw.postAuthor),
  }
}

export class BoundedMessageDeduplicator {
  private readonly entries = new Map<string, true>()

  constructor(private readonly capacity = 2_048) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError('Deduplicator capacity must be a positive integer')
    }
  }

  /** Returns true only the first time a key is observed. */
  accept(key: string): boolean {
    if (this.entries.has(key)) {
      return false
    }

    this.entries.set(key, true)
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest !== undefined) {
        this.entries.delete(oldest)
      }
    }
    return true
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

/** Converts the rich transport event to the app's compact shared payload shape. */
export function toTelegramMessagePayload(
  message: TelegramSignalMessage,
): TelegramMessagePayloadLike {
  return {
    channelId: message.channelId ?? message.channelUsername,
    messageId: message.messageId,
    channelUsername: message.channelUsername,
    text: message.text,
    date: Date.parse(message.publishedAt),
    receivedAt: Date.parse(message.receivedAt),
    permalink: message.url,
  }
}

function normalizeMessageText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim()
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

function normalizePublishedAt(value: number | Date | undefined): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // GramJS represents Telegram dates as Unix seconds.
    return new Date(value * 1_000)
  }
  return new Date()
}

function readMediaKind(media: unknown): string | undefined {
  if (!media || typeof media !== 'object') {
    return undefined
  }

  const candidate = media as { className?: unknown; constructor?: { name?: unknown } }
  const explicitName = typeof candidate.className === 'string' ? candidate.className : undefined
  const constructorName =
    typeof candidate.constructor?.name === 'string' ? candidate.constructor.name : undefined
  const kind = explicitName || constructorName

  if (!kind || kind === 'Object' || EMPTY_MEDIA_KINDS.has(kind)) {
    return undefined
  }
  return kind
}
