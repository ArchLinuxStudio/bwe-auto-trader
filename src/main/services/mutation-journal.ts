import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

export const MUTATION_JOURNAL_FILE_NAME = 'mutation-journal.v1.json'
export const MAX_DURABLE_MUTATIONS = 16
export const MAX_MUTATION_JOURNAL_BYTES = 128 * 1024

export type DurableMutationLifecycleState =
  | 'prepared'
  | 'transmitting'
  | 'accepted'
  | 'live'
  | 'partially_filled'
  | 'unknown'

export type DurableMutationReconciliationState =
  | 'not_started'
  | 'matching_order'
  | 'matching_pending'
  | 'not_found_locked'
  | 'position_effect_only_locked'

export type DurableMutationResolutionEvidence =
  | 'not_transmitted'
  | 'terminal_order'
  | 'same_origin_position_effect'
  | 'same_origin_absence_window'

export interface DurableMutationRecord {
  operation: 'open' | 'close'
  accountFingerprint: string
  instId: string
  clOrdId: string
  ordId?: string
  lifecycleState: DurableMutationLifecycleState
  reconciliationState: DurableMutationReconciliationState
  createdAt: number
  updatedAt: number
  intentExpiresAt: number
  exchangeExpiresAt?: number
  lastReconciledAt?: number
  lastOrderState?: string
  positionEffectObserved?: boolean
}

const timestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const mutationRecordSchema = z.object({
  operation: z.enum(['open', 'close']),
  accountFingerprint: z.string().regex(/^okx-uid-v1:[0-9a-f]{64}$/),
  instId: z.string().regex(/^[A-Z0-9]{1,24}-USDT-SWAP$/),
  clOrdId: z.string().regex(/^[A-Za-z0-9]{4,32}$/),
  ordId: z.string().regex(/^[A-Za-z0-9]{1,64}$/).optional(),
  lifecycleState: z.enum([
    'prepared',
    'transmitting',
    'accepted',
    'live',
    'partially_filled',
    'unknown'
  ]),
  reconciliationState: z.enum([
    'not_started',
    'matching_order',
    'matching_pending',
    'not_found_locked',
    'position_effect_only_locked'
  ]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  intentExpiresAt: timestampSchema,
  exchangeExpiresAt: timestampSchema.optional(),
  lastReconciledAt: timestampSchema.optional(),
  lastOrderState: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
  positionEffectObserved: z.boolean().optional()
}).strict().superRefine((record, context) => {
  const addInvariantIssue = (message: string): void => {
    context.addIssue({ code: z.ZodIssueCode.custom, message })
  }

  if (record.updatedAt < record.createdAt || record.intentExpiresAt < record.createdAt) {
    addInvariantIssue('The durable mutation contains an invalid timestamp sequence')
  }
  if (
    record.lastReconciledAt !== undefined &&
    (record.lastReconciledAt < record.createdAt || record.lastReconciledAt > record.updatedAt)
  ) {
    addInvariantIssue('The durable mutation contains an invalid reconciliation timestamp')
  }

  if (record.lifecycleState === 'prepared') {
    if (
      record.exchangeExpiresAt !== undefined ||
      record.ordId !== undefined ||
      record.reconciliationState !== 'not_started' ||
      record.lastReconciledAt !== undefined ||
      record.lastOrderState !== undefined ||
      record.positionEffectObserved !== undefined
    ) {
      addInvariantIssue('A prepared mutation cannot contain transmission or exchange evidence')
    }
    return
  }

  if (record.exchangeExpiresAt === undefined) {
    addInvariantIssue('A post-prepared mutation must contain its exchange expiry')
  }
  if (
    ['accepted', 'live', 'partially_filled'].includes(record.lifecycleState) &&
    record.ordId === undefined
  ) {
    addInvariantIssue('An acknowledged mutation must contain an immutable order ID')
  }
  if (
    ['transmitting', 'accepted'].includes(record.lifecycleState) &&
    (
      record.reconciliationState !== 'not_started' ||
      record.lastReconciledAt !== undefined ||
      record.lastOrderState !== undefined ||
      record.positionEffectObserved !== undefined
    )
  ) {
    addInvariantIssue('An unreconciled mutation cannot contain reconciliation evidence')
  }
  if (record.lifecycleState === 'transmitting' && record.ordId !== undefined) {
    addInvariantIssue('A transmitting mutation cannot contain acknowledgement identity')
  }
  if (
    ['live', 'partially_filled'].includes(record.lifecycleState) &&
    record.reconciliationState === 'not_started'
  ) {
    addInvariantIssue('An observed live mutation must contain reconciliation evidence')
  }

  if (record.reconciliationState === 'not_started') {
    if (
      record.lastReconciledAt !== undefined ||
      record.lastOrderState !== undefined ||
      record.positionEffectObserved !== undefined
    ) {
      addInvariantIssue('A mutation with no reconciliation cannot contain reconciliation evidence')
    }
  } else if (
    record.reconciliationState === 'matching_order' ||
    record.reconciliationState === 'matching_pending'
  ) {
    if (
      record.lastReconciledAt === undefined ||
      record.lastOrderState === undefined ||
      record.ordId === undefined ||
      record.positionEffectObserved !== undefined
    ) {
      addInvariantIssue('Matching order evidence is incomplete or contradictory')
    }
    if (
      record.reconciliationState === 'matching_pending' &&
      !['live', 'partially_filled'].includes(record.lastOrderState ?? '')
    ) {
      addInvariantIssue('Pending reconciliation must identify a live or partially filled order')
    }
    if (
      record.reconciliationState === 'matching_order' &&
      ['live', 'partially_filled'].includes(record.lastOrderState ?? '')
    ) {
      addInvariantIssue('Non-pending reconciliation cannot identify a pending order state')
    }
  } else if (
    record.lastReconciledAt === undefined ||
    record.positionEffectObserved === undefined
  ) {
    addInvariantIssue('Not-found reconciliation evidence is incomplete or contradictory')
  }
  if (
    record.reconciliationState === 'not_found_locked' &&
    record.positionEffectObserved !== false
  ) {
    addInvariantIssue('Not-found reconciliation cannot claim a position effect')
  }
  if (
    record.reconciliationState === 'position_effect_only_locked' &&
    record.positionEffectObserved !== true
  ) {
    addInvariantIssue('Position-effect reconciliation must record that effect')
  }
})

const mutationJournalSchema = z.object({
  version: z.literal(1),
  records: z.array(mutationRecordSchema).max(MAX_DURABLE_MUTATIONS)
}).strict()

export class MutationJournalIntegrityError extends Error {
  constructor(message = 'The durable order mutation journal could not be verified') {
    super(message)
    this.name = 'MutationJournalIntegrityError'
  }
}

export class MutationJournalConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MutationJournalConflictError'
  }
}

export function createOkxAccountFingerprint(uid: string | undefined): string {
  const normalized = uid?.trim()
  if (!normalized || !/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) {
    throw new MutationJournalIntegrityError(
      'OKX did not provide a stable non-secret account UID for durable order recovery'
    )
  }
  const digest = createHash('sha256')
    .update('bwe-okx-account-uid-v1\0', 'utf8')
    .update(normalized, 'utf8')
    .digest('hex')
  return `okx-uid-v1:${digest}`
}

interface BeginMutationInput {
  operation: DurableMutationRecord['operation']
  accountFingerprint: string
  instId: string
  clOrdId: string
  createdAt: number
  intentExpiresAt: number
}

interface MutationTimestampInput {
  clOrdId: string
  updatedAt: number
}

interface MarkTransmissionInput extends MutationTimestampInput {
  exchangeExpiresAt: number
}

interface MarkAcceptedInput extends MutationTimestampInput {
  ordId: string
}

interface MarkOrderObservedInput extends MutationTimestampInput {
  ordId?: string
  orderState: string
  pending: boolean
}

interface MarkRecoveryNotFoundInput extends MutationTimestampInput {
  positionEffectObserved: boolean
}

export class MutationJournalStore {
  private readonly filePath: string
  private state?: DurableMutationRecord[]
  private writeTail: Promise<void> = Promise.resolve()
  private failed = false

  constructor(userDataDirectory: string) {
    this.filePath = path.join(userDataDirectory, MUTATION_JOURNAL_FILE_NAME)
  }

  async read(): Promise<DurableMutationRecord[]> {
    const operation = async (): Promise<DurableMutationRecord[]> => {
      this.assertHealthy()
      try {
        return structuredClone(await this.load())
      } catch (error) {
        if (!(error instanceof MutationJournalConflictError)) this.failed = true
        throw error
      }
    }
    const pending = this.writeTail.then(operation, operation)
    this.writeTail = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  async begin(input: BeginMutationInput): Promise<DurableMutationRecord[]> {
    return this.mutate((records) => {
      if (records.length > 0) {
        throw new MutationJournalConflictError(
          'A durable OKX mutation is already unresolved; refusing another mutation'
        )
      }
      const record = mutationRecordSchema.parse({
        ...input,
        lifecycleState: 'prepared',
        reconciliationState: 'not_started',
        updatedAt: input.createdAt
      })
      records.push(record)
    })
  }

  async markTransmissionStarted(input: MarkTransmissionInput): Promise<DurableMutationRecord[]> {
    return this.updateRecord(input.clOrdId, (record) => {
      if (!['prepared', 'transmitting'].includes(record.lifecycleState)) {
        throw new MutationJournalIntegrityError(
          'A durable mutation cannot return to the transmitting phase'
        )
      }
      if (
        record.exchangeExpiresAt !== undefined &&
        record.exchangeExpiresAt !== input.exchangeExpiresAt
      ) {
        throw new MutationJournalIntegrityError(
          'The durable mutation received conflicting exchange expiry evidence'
        )
      }
      record.updatedAt = nextTimestamp(record, input.updatedAt)
      record.exchangeExpiresAt = input.exchangeExpiresAt
      if (record.lifecycleState === 'prepared') record.lifecycleState = 'transmitting'
    })
  }

  async markAccepted(input: MarkAcceptedInput): Promise<DurableMutationRecord[]> {
    return this.updateRecord(input.clOrdId, (record) => {
      record.updatedAt = nextTimestamp(record, input.updatedAt)
      bindOrderId(record, input.ordId)
      if (['prepared', 'transmitting'].includes(record.lifecycleState)) {
        record.lifecycleState = 'accepted'
      }
    })
  }

  async markUnknown(input: MutationTimestampInput): Promise<DurableMutationRecord[]> {
    return this.updateRecord(input.clOrdId, (record) => {
      record.updatedAt = nextTimestamp(record, input.updatedAt)
      if (['prepared', 'transmitting', 'accepted'].includes(record.lifecycleState)) {
        record.lifecycleState = 'unknown'
      }
    })
  }

  async markOrderObserved(input: MarkOrderObservedInput): Promise<DurableMutationRecord[]> {
    const normalizedOrderState = normalizeOrderState(input.orderState)
    return this.updateRecord(input.clOrdId, (record) => {
      if (input.ordId) bindOrderId(record, input.ordId)
      if (
        record.lastReconciledAt !== undefined &&
        input.updatedAt < record.lastReconciledAt
      ) {
        return
      }
      const observedAt = nextTimestamp(record, input.updatedAt)
      record.updatedAt = observedAt
      record.lastReconciledAt = observedAt
      record.lastOrderState = normalizedOrderState
      delete record.positionEffectObserved
      record.reconciliationState = input.pending ? 'matching_pending' : 'matching_order'
      if (normalizedOrderState === 'partially_filled') {
        record.lifecycleState = 'partially_filled'
      } else if (
        normalizedOrderState === 'live' &&
        record.lifecycleState !== 'partially_filled'
      ) {
        record.lifecycleState = 'live'
      } else if (
        !['live', 'partially_filled'].includes(record.lifecycleState)
      ) {
        record.lifecycleState = 'unknown'
      }
    })
  }

  async markRecoveryNotFound(input: MarkRecoveryNotFoundInput): Promise<DurableMutationRecord[]> {
    return this.updateRecord(input.clOrdId, (record) => {
      if (
        record.lastReconciledAt !== undefined &&
        input.updatedAt < record.lastReconciledAt
      ) {
        return
      }
      const observedAt = nextTimestamp(record, input.updatedAt)
      record.updatedAt = observedAt
      record.lastReconciledAt = observedAt
      record.positionEffectObserved = input.positionEffectObserved
      record.reconciliationState = input.positionEffectObserved
        ? 'position_effect_only_locked'
        : 'not_found_locked'
      if (!['live', 'partially_filled'].includes(record.lifecycleState)) {
        record.lifecycleState = 'unknown'
      }
    })
  }

  async resolve(
    clOrdId: string,
    evidence: DurableMutationResolutionEvidence
  ): Promise<{ records: DurableMutationRecord[]; removed: boolean }> {
    let removed = false
    const records = await this.mutate((draft) => {
      const index = draft.findIndex((record) => record.clOrdId === clOrdId)
      if (index < 0) return
      const record = draft[index]!
      if (
        evidence === 'not_transmitted' &&
        !['prepared', 'transmitting'].includes(record.lifecycleState)
      ) {
        throw new MutationJournalConflictError(
          'Only a pre-fetch mutation can be resolved as not transmitted'
        )
      }
      draft.splice(index, 1)
      removed = true
    })
    return { records, removed }
  }

  async resolvePreparedBeforeTransmission(): Promise<{
    records: DurableMutationRecord[]
    removedClientOrderIds: string[]
  }> {
    const removedClientOrderIds: string[] = []
    const records = await this.mutate((draft) => {
      for (let index = draft.length - 1; index >= 0; index -= 1) {
        const record = draft[index]!
        if (record.lifecycleState !== 'prepared') continue
        removedClientOrderIds.unshift(record.clOrdId)
        draft.splice(index, 1)
      }
    }, false)
    return { records, removedClientOrderIds }
  }

  private async updateRecord(
    clOrdId: string,
    update: (record: DurableMutationRecord) => void
  ): Promise<DurableMutationRecord[]> {
    return this.mutate((records) => {
      const record = records.find((candidate) => candidate.clOrdId === clOrdId)
      if (!record) {
        throw new MutationJournalConflictError(
          `No durable OKX mutation exists for client order ${clOrdId}`
        )
      }
      update(record)
    })
  }

  private async mutate(
    mutation: (records: DurableMutationRecord[]) => void,
    forceWrite = true
  ): Promise<DurableMutationRecord[]> {
    const operation = async (): Promise<DurableMutationRecord[]> => {
      this.assertHealthy()
      const current = await this.load()
      const next = structuredClone(current)
      mutation(next)
      const parsed = mutationJournalSchema.parse({ version: 1, records: next }).records
      if (forceWrite || JSON.stringify(parsed) !== JSON.stringify(current)) {
        await this.persist(parsed)
      }
      this.state = structuredClone(parsed)
      return structuredClone(parsed)
    }
    const pending = this.writeTail.then(operation, operation)
    this.writeTail = pending.then(
      () => undefined,
      (error) => {
        if (!(error instanceof MutationJournalConflictError)) this.failed = true
      }
    )
    return pending
  }

  private async load(): Promise<DurableMutationRecord[]> {
    if (this.state) return this.state
    try {
      const fileStats = await stat(this.filePath)
      if (fileStats.size > MAX_MUTATION_JOURNAL_BYTES) {
        throw new MutationJournalIntegrityError(
          'The durable order mutation journal exceeds its size limit'
        )
      }
      const serialized = await readFile(this.filePath, 'utf8')
      if (Buffer.byteLength(serialized, 'utf8') > MAX_MUTATION_JOURNAL_BYTES) {
        throw new MutationJournalIntegrityError(
          'The durable order mutation journal exceeds its size limit'
        )
      }
      const parsed = mutationJournalSchema.parse(
        JSON.parse(serialized) as unknown
      )
      const clientOrderIds = new Set<string>()
      const exchangeOrderIds = new Set<string>()
      for (const record of parsed.records) {
        if (clientOrderIds.has(record.clOrdId)) {
          throw new MutationJournalIntegrityError(
            'The durable order mutation journal contains duplicate client order IDs'
          )
        }
        clientOrderIds.add(record.clOrdId)
        if (record.ordId) {
          if (exchangeOrderIds.has(record.ordId)) {
            throw new MutationJournalIntegrityError(
              'The durable order mutation journal contains duplicate exchange order IDs'
            )
          }
          exchangeOrderIds.add(record.ordId)
        }
      }
      this.state = structuredClone(parsed.records)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = []
      } else if (error instanceof MutationJournalIntegrityError) {
        throw error
      } else {
        throw new MutationJournalIntegrityError()
      }
    }
    return this.state
  }

  private async persist(records: readonly DurableMutationRecord[]): Promise<void> {
    const directory = path.dirname(this.filePath)
    const temporaryPath = `${this.filePath}.tmp`
    await mkdir(directory, { recursive: true })
    const handle = await open(temporaryPath, 'w', 0o600)
    try {
      await handle.writeFile(
        `${JSON.stringify({ version: 1, records }, null, 2)}\n`,
        { encoding: 'utf8' }
      )
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, this.filePath)
    if (process.platform !== 'win32') {
      const directoryHandle = await open(directory, 'r')
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    }
  }

  private assertHealthy(): void {
    if (this.failed) {
      throw new MutationJournalIntegrityError(
        'The durable order mutation journal is unavailable after an earlier failure'
      )
    }
  }
}

function nextTimestamp(record: DurableMutationRecord, candidate: number): number {
  timestampSchema.parse(candidate)
  return Math.max(record.updatedAt, candidate)
}

function bindOrderId(record: DurableMutationRecord, orderId: string): void {
  if (record.ordId !== undefined && record.ordId !== orderId) {
    throw new MutationJournalIntegrityError(
      'The durable mutation received conflicting exchange order IDs'
    )
  }
  record.ordId = orderId
}

function normalizeOrderState(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^cancelled$/, 'canceled')
  if (!/^[a-z0-9_]{1,40}$/.test(normalized)) {
    throw new MutationJournalIntegrityError(
      'OKX returned an invalid order state during durable reconciliation'
    )
  }
  return normalized
}
