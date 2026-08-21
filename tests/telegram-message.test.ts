import { describe, expect, it, vi } from 'vitest'

import {
  BoundedMessageDeduplicator,
  extractTelegramSignalMessage,
  normalizeTelegramUsername,
  telegramMessageKey,
  toTelegramMessagePayload,
} from '../src/main/services/telegram-message'

describe('extractTelegramSignalMessage', () => {
  it('extracts a channel post and normalizes its public URL', () => {
    const result = extractTelegramSignalMessage(
      {
        id: 42,
        message: '  Binance will list TEST.\r\nTrading opens soon.  ',
        date: 1_700_000_000,
        postAuthor: ' BWE ',
      },
      {
        channelUsername: 'https://t.me/BWEnews/',
        channelId: '1234',
        channelTitle: 'BWE News',
        receivedAt: new Date('2026-08-12T01:00:00.000Z'),
      },
    )

    expect(result).toEqual({
      channelUsername: 'BWEnews',
      channelId: '1234',
      channelTitle: 'BWE News',
      messageId: 42,
      text: 'Binance will list TEST.\nTrading opens soon.',
      publishedAt: '2023-11-14T22:13:20.000Z',
      receivedAt: '2026-08-12T01:00:00.000Z',
      url: 'https://t.me/BWEnews/42',
      hasMedia: false,
      mediaKind: undefined,
      postAuthor: 'BWE',
    })
  })

  it('uses the GramJS message field as a photo caption', () => {
    const result = extractTelegramSignalMessage(
      {
        id: 7,
        message: 'BTC ETF approved',
        date: new Date('2026-08-12T01:00:00.000Z'),
        media: { className: 'MessageMediaPhoto' },
      },
      { channelUsername: '@BWEnews', receivedAt: new Date('2026-08-12T01:00:01.000Z') },
    )

    expect(result?.text).toBe('BTC ETF approved')
    expect(result?.hasMedia).toBe(true)
    expect(result?.mediaKind).toBe('MessageMediaPhoto')
  })

  it('maps a transport event to the app payload contract', () => {
    const signal = extractTelegramSignalMessage(
      { id: 12, message: 'Listing announcement', date: 1_700_000_000 },
      {
        channelUsername: 'BWEnews',
        channelId: '9001',
        receivedAt: new Date('2026-08-12T01:00:00.000Z'),
      },
    )

    expect(toTelegramMessagePayload(signal!)).toEqual({
      channelId: '9001',
      messageId: 12,
      channelUsername: 'BWEnews',
      text: 'Listing announcement',
      date: 1_700_000_000_000,
      receivedAt: Date.parse('2026-08-12T01:00:00.000Z'),
      permalink: 'https://t.me/BWEnews/12',
    })
  })

  it.each([
    [{ id: 0, message: 'invalid id' }],
    [{ id: 1, message: '   ' }],
    [{ message: 'missing id' }],
  ])('rejects empty or invalid posts', (raw) => {
    expect(extractTelegramSignalMessage(raw, { channelUsername: 'BWEnews' })).toBeNull()
  })

  it('uses the current time only when Telegram did not provide a date', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-12T08:00:00.000Z'))
    const result = extractTelegramSignalMessage(
      { id: 9, message: 'news' },
      { channelUsername: 'BWEnews' },
    )
    expect(result?.publishedAt).toBe('2026-08-12T08:00:00.000Z')
    expect(result?.receivedAt).toBe('2026-08-12T08:00:00.000Z')
    vi.useRealTimers()
  })
})

describe('BoundedMessageDeduplicator', () => {
  it('accepts a message key once', () => {
    const deduplicator = new BoundedMessageDeduplicator()
    expect(deduplicator.accept('bwenews:1')).toBe(true)
    expect(deduplicator.accept('bwenews:1')).toBe(false)
    expect(deduplicator.size).toBe(1)
  })

  it('evicts the oldest key at its capacity', () => {
    const deduplicator = new BoundedMessageDeduplicator(2)
    deduplicator.accept('bwenews:1')
    deduplicator.accept('bwenews:2')
    deduplicator.accept('bwenews:3')

    expect(deduplicator.has('bwenews:1')).toBe(false)
    expect(deduplicator.has('bwenews:2')).toBe(true)
    expect(deduplicator.has('bwenews:3')).toBe(true)
  })
})

describe('Telegram message identifiers', () => {
  it('normalizes supported channel forms', () => {
    expect(normalizeTelegramUsername('@BWEnews')).toBe('BWEnews')
    expect(normalizeTelegramUsername('https://t.me/BWEnews/')).toBe('BWEnews')
    expect(telegramMessageKey('@BWEnews', 3)).toBe('bwenews:3')
  })
})
