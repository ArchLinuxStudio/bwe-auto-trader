import { z } from 'zod'

export const telegramCredentialsSchema = z.object({
  apiId: z.number().int().positive().max(2_147_483_647),
  apiHash: z.string().trim().min(20).max(128),
  phoneNumber: z.string().trim().min(6).max(32)
})

export const okxCredentialsSchema = z.object({
  apiKey: z.string().trim().min(8).max(128),
  secretKey: z.string().trim().min(8).max(256),
  passphrase: z.string().min(1).max(128)
})

export const settingsUpdateSchema = z.object({
  proxy: z
    .object({
      host: z.string().trim().min(1).max(253).optional(),
      port: z.number().int().min(1).max(65_535).optional(),
      protocol: z.enum(['auto', 'socks5', 'http']).optional()
    })
    .optional(),
  trading: z
    .object({
      channelUsername: z.string().trim().regex(/^@?[A-Za-z0-9_]{5,32}$/).optional(),
      orderNotionalUsdt: z.literal(10).optional(),
      leverage: z.literal(1).optional(),
      cooldownMinutes: z.number().int().min(0).max(1440).optional(),
      aiTimeoutMs: z.number().int().min(1000).max(30_000).optional(),
      maxConcurrentPositions: z.literal(1).optional(),
      marginMode: z.literal('isolated').optional(),
      positionMode: z.literal('net').optional()
    })
    .optional(),
  notificationsEnabled: z.boolean().optional(),
  soundsEnabled: z.boolean().optional()
})

export function normalizeChannelUsername(value: string): string {
  return value.trim().replace(/^@/, '')
}
