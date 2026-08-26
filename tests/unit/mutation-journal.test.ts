import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MUTATION_JOURNAL_FILE_NAME,
  MAX_MUTATION_JOURNAL_BYTES,
  MutationJournalConflictError,
  MutationJournalIntegrityError,
  MutationJournalStore,
  createOkxAccountFingerprint
} from '../../src/main/services/mutation-journal'

const temporaryDirectories: string[] = []
const createdAt = 1_700_000_000_000
const accountFingerprint = createOkxAccountFingerprint('sub-account-uid-1')

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function createStore(): Promise<{
  directory: string
  store: MutationJournalStore
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'bwe-mutation-journal-'))
  temporaryDirectories.push(directory)
  return { directory, store: new MutationJournalStore(directory) }
}

function beginInput(clOrdId = 'bwejournal1') {
  return {
    operation: 'open' as const,
    accountFingerprint,
    instId: 'BTC-USDT-SWAP',
    clOrdId,
    createdAt,
    intentExpiresAt: createdAt + 10_000
  }
}

describe('MutationJournalStore', () => {
  it('atomically records the mutation before transmission and persists monotonic lifecycle state', async () => {
    const { directory, store } = await createStore()

    await store.begin(beginInput())
    await store.markTransmissionStarted({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 1,
      exchangeExpiresAt: createdAt + 5_000
    })
    await store.markOrderObserved({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 3,
      ordId: '123456789',
      orderState: 'partially_filled',
      pending: true
    })
    await store.markAccepted({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 2,
      ordId: '123456789'
    })
    await store.markUnknown({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 4
    })

    await expect(store.read()).resolves.toEqual([
      expect.objectContaining({
        accountFingerprint,
        lifecycleState: 'partially_filled',
        reconciliationState: 'matching_pending',
        ordId: '123456789',
        exchangeExpiresAt: createdAt + 5_000,
        updatedAt: createdAt + 4
      })
    ])

    const files = await readdir(directory)
    expect(files).toEqual([MUTATION_JOURNAL_FILE_NAME])
    const serialized = await readFile(
      path.join(directory, MUTATION_JOURNAL_FILE_NAME),
      'utf8'
    )
    expect(serialized).not.toContain('sub-account-uid-1')
    expect(serialized).not.toMatch(/api.?key|secret|passphrase/i)
  })

  it('refuses a second unresolved mutation instead of evicting the first', async () => {
    const { store } = await createStore()
    await store.begin(beginInput())

    await expect(store.begin({
      ...beginInput('bwejournal2'),
      operation: 'close'
    })).rejects.toBeInstanceOf(MutationJournalConflictError)
    await expect(store.read()).resolves.toHaveLength(1)
  })

  it('serializes the first read with a concurrent first mutation', async () => {
    const { store } = await createStore()

    const initialRead = store.read()
    const mutation = store.begin(beginInput())

    await expect(initialRead).resolves.toEqual([])
    await expect(mutation).resolves.toEqual([
      expect.objectContaining({ clOrdId: 'bwejournal1', lifecycleState: 'prepared' })
    ])
    await expect(store.read()).resolves.toHaveLength(1)
  })

  it('clears only a pre-transmission prepared record during startup recovery', async () => {
    const prepared = await createStore()
    await prepared.store.begin(beginInput('bweprepared'))
    await expect(prepared.store.resolvePreparedBeforeTransmission()).resolves.toMatchObject({
      records: [],
      removedClientOrderIds: ['bweprepared']
    })

    const transmitting = await createStore()
    await transmitting.store.begin(beginInput('bwetransmitting'))
    await transmitting.store.markTransmissionStarted({
      clOrdId: 'bwetransmitting',
      updatedAt: createdAt + 1,
      exchangeExpiresAt: createdAt + 5_000
    })
    await expect(transmitting.store.resolvePreparedBeforeTransmission()).resolves.toMatchObject({
      removedClientOrderIds: []
    })
    await expect(transmitting.store.read()).resolves.toEqual([
      expect.objectContaining({ lifecycleState: 'transmitting' })
    ])
  })

  it('keeps a cross-client not-found result locked even when a position effect is visible', async () => {
    const { store } = await createStore()
    await store.begin(beginInput())
    await store.markTransmissionStarted({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 1,
      exchangeExpiresAt: createdAt + 5_000
    })
    await store.markRecoveryNotFound({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 30_000,
      positionEffectObserved: true
    })

    await expect(store.read()).resolves.toEqual([
      expect.objectContaining({
        lifecycleState: 'unknown',
        reconciliationState: 'position_effect_only_locked',
        positionEffectObserved: true
      })
    ])
  })

  it('keeps prior order history while allowing later matching evidence to supersede not-found state', async () => {
    const { store } = await createStore()
    await store.begin(beginInput())
    await store.markTransmissionStarted({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 1,
      exchangeExpiresAt: createdAt + 5_000
    })
    await store.markAccepted({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 2,
      ordId: 'rediscoveredorder1'
    })
    await store.markOrderObserved({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 3,
      ordId: 'rediscoveredorder1',
      orderState: 'partially_filled',
      pending: true
    })
    await store.markRecoveryNotFound({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 4,
      positionEffectObserved: true
    })
    await expect(store.read()).resolves.toEqual([
      expect.objectContaining({
        reconciliationState: 'position_effect_only_locked',
        lastOrderState: 'partially_filled',
        positionEffectObserved: true
      })
    ])

    await store.markOrderObserved({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 5,
      ordId: 'rediscoveredorder1',
      orderState: 'partially_filled',
      pending: true
    })
    await expect(store.read()).resolves.toEqual([
      expect.objectContaining({
        reconciliationState: 'matching_pending',
        lastOrderState: 'partially_filled'
      })
    ])
    expect((await store.read())[0]).not.toHaveProperty('positionEffectObserved')
  })

  it('removes a record only through an explicit evidence-bearing resolution', async () => {
    const { store } = await createStore()
    await store.begin(beginInput())
    await store.markTransmissionStarted({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 1,
      exchangeExpiresAt: createdAt + 5_000
    })

    await expect(store.resolve('bwejournal1', 'not_transmitted')).resolves.toMatchObject({
      records: [],
      removed: true
    })

    const acknowledged = await createStore()
    await acknowledged.store.begin(beginInput('bweacknowledged'))
    await acknowledged.store.markTransmissionStarted({
      clOrdId: 'bweacknowledged',
      updatedAt: createdAt + 1,
      exchangeExpiresAt: createdAt + 5_000
    })
    await acknowledged.store.markAccepted({
      clOrdId: 'bweacknowledged',
      updatedAt: createdAt + 2,
      ordId: 'acknowledgedorder1'
    })
    await expect(acknowledged.store.resolve('bweacknowledged', 'not_transmitted'))
      .rejects.toBeInstanceOf(MutationJournalConflictError)
    await expect(acknowledged.store.resolve('bweacknowledged', 'terminal_order'))
      .resolves.toMatchObject({ records: [], removed: true })
  })

  it('treats an exchange order ID as immutable once observed', async () => {
    const { directory, store } = await createStore()
    await store.begin(beginInput())
    await store.markTransmissionStarted({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 1,
      exchangeExpiresAt: createdAt + 5_000
    })
    await store.markAccepted({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 2,
      ordId: 'immutableorder1'
    })

    await expect(store.markOrderObserved({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 3,
      ordId: 'conflictingorder2',
      orderState: 'live',
      pending: true
    })).rejects.toBeInstanceOf(MutationJournalIntegrityError)
    await expect(new MutationJournalStore(directory).read()).resolves.toEqual([
      expect.objectContaining({ ordId: 'immutableorder1', lifecycleState: 'accepted' })
    ])
  })

  it('treats the committed exchange expiry as immutable lifecycle evidence', async () => {
    const { directory, store } = await createStore()
    await store.begin(beginInput())
    await store.markTransmissionStarted({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 1,
      exchangeExpiresAt: createdAt + 5_000
    })
    await expect(store.markTransmissionStarted({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 2,
      exchangeExpiresAt: createdAt + 5_000
    })).resolves.toEqual([
      expect.objectContaining({
        lifecycleState: 'transmitting',
        exchangeExpiresAt: createdAt + 5_000
      })
    ])

    await expect(store.markTransmissionStarted({
      clOrdId: 'bwejournal1',
      updatedAt: createdAt + 3,
      exchangeExpiresAt: createdAt + 6_000
    })).rejects.toBeInstanceOf(MutationJournalIntegrityError)
    await expect(store.read()).rejects.toBeInstanceOf(MutationJournalIntegrityError)
    await expect(new MutationJournalStore(directory).read()).resolves.toEqual([
      expect.objectContaining({ exchangeExpiresAt: createdAt + 5_000 })
    ])

    const advanced = await createStore()
    await advanced.store.begin(beginInput('bweadvancedexpiry'))
    await advanced.store.markTransmissionStarted({
      clOrdId: 'bweadvancedexpiry',
      updatedAt: createdAt + 1,
      exchangeExpiresAt: createdAt + 5_000
    })
    await advanced.store.markAccepted({
      clOrdId: 'bweadvancedexpiry',
      updatedAt: createdAt + 2,
      ordId: 'advancedexpiryorder1'
    })
    await expect(advanced.store.markTransmissionStarted({
      clOrdId: 'bweadvancedexpiry',
      updatedAt: createdAt + 3,
      exchangeExpiresAt: createdAt + 5_000
    })).rejects.toBeInstanceOf(MutationJournalIntegrityError)
    await expect(new MutationJournalStore(advanced.directory).read()).resolves.toEqual([
      expect.objectContaining({
        lifecycleState: 'accepted',
        ordId: 'advancedexpiryorder1',
        exchangeExpiresAt: createdAt + 5_000
      })
    ])
  })

  it('fails closed on schema-valid fields with contradictory lifecycle evidence', async () => {
    const { directory, store } = await createStore()
    const filePath = path.join(directory, MUTATION_JOURNAL_FILE_NAME)
    await writeFile(filePath, JSON.stringify({
      version: 1,
      records: [{
        ...beginInput('bwecontradictory'),
        updatedAt: createdAt,
        lifecycleState: 'prepared',
        reconciliationState: 'matching_order',
        exchangeExpiresAt: createdAt + 5_000,
        ordId: 'shouldnotexist',
        lastReconciledAt: createdAt,
        lastOrderState: 'filled'
      }]
    }), 'utf8')

    await expect(store.read()).rejects.toBeInstanceOf(MutationJournalIntegrityError)
    await expect(readFile(filePath, 'utf8')).resolves.toContain('shouldnotexist')
  })

  it('rejects a post-prepared record without the committed exchange expiry', async () => {
    const { directory, store } = await createStore()
    const filePath = path.join(directory, MUTATION_JOURNAL_FILE_NAME)
    await writeFile(filePath, JSON.stringify({
      version: 1,
      records: [{
        ...beginInput('bwemissingexpiry'),
        updatedAt: createdAt + 1,
        lifecycleState: 'accepted',
        reconciliationState: 'not_started',
        ordId: 'acceptedwithoutexpiry'
      }]
    }), 'utf8')

    await expect(store.read()).rejects.toBeInstanceOf(MutationJournalIntegrityError)
    await expect(readFile(filePath, 'utf8')).resolves.toContain('acceptedwithoutexpiry')
  })

  it('rejects contradictory post-transmission lifecycle and reconciliation combinations', async () => {
    const invalidRecords = [
      {
        ...beginInput('bwetransmittingack'),
        updatedAt: createdAt + 1,
        lifecycleState: 'transmitting',
        reconciliationState: 'not_started',
        exchangeExpiresAt: createdAt + 5_000,
        ordId: 'impossibleearlyack1'
      },
      {
        ...beginInput('bwelivewithoutevidence'),
        updatedAt: createdAt + 2,
        lifecycleState: 'live',
        reconciliationState: 'not_started',
        exchangeExpiresAt: createdAt + 5_000,
        ordId: 'livewithoutevidence1'
      },
      {
        ...beginInput('bwewrongabsenceflag'),
        updatedAt: createdAt + 3,
        lifecycleState: 'unknown',
        reconciliationState: 'not_found_locked',
        exchangeExpiresAt: createdAt + 5_000,
        lastReconciledAt: createdAt + 3,
        positionEffectObserved: true
      }
    ]

    for (const record of invalidRecords) {
      const { directory, store } = await createStore()
      await writeFile(
        path.join(directory, MUTATION_JOURNAL_FILE_NAME),
        JSON.stringify({ version: 1, records: [record] }),
        'utf8'
      )
      await expect(store.read()).rejects.toBeInstanceOf(MutationJournalIntegrityError)
    }
  })

  it('rejects duplicate exchange order IDs even when client order IDs differ', async () => {
    const { directory, store } = await createStore()
    const record = {
      ...beginInput('bweduplicateord1'),
      updatedAt: createdAt + 2,
      lifecycleState: 'accepted',
      reconciliationState: 'not_started',
      exchangeExpiresAt: createdAt + 5_000,
      ordId: 'duplicateexchangeid1'
    }
    await writeFile(
      path.join(directory, MUTATION_JOURNAL_FILE_NAME),
      JSON.stringify({
        version: 1,
        records: [
          record,
          { ...record, clOrdId: 'bweduplicateord2' }
        ]
      }),
      'utf8'
    )

    await expect(store.read()).rejects.toBeInstanceOf(MutationJournalIntegrityError)
  })

  it('fails closed on malformed data and never replaces it with an empty journal', async () => {
    const { directory, store } = await createStore()
    const filePath = path.join(directory, MUTATION_JOURNAL_FILE_NAME)
    await writeFile(filePath, '{"version":1,"records":[{"clOrdId":"broken"}]}', 'utf8')

    await expect(store.read()).rejects.toBeInstanceOf(MutationJournalIntegrityError)
    await expect(store.begin(beginInput())).rejects.toBeInstanceOf(MutationJournalIntegrityError)
    await expect(readFile(filePath, 'utf8')).resolves.toContain('"clOrdId":"broken"')
  })

  it('rejects an oversized journal before parsing it', async () => {
    const { directory, store } = await createStore()
    await writeFile(
      path.join(directory, MUTATION_JOURNAL_FILE_NAME),
      'x'.repeat(MAX_MUTATION_JOURNAL_BYTES + 1),
      'utf8'
    )

    await expect(store.read()).rejects.toThrow('size limit')
  })

  it('derives a stable non-secret account identity and rejects a missing UID', () => {
    expect(createOkxAccountFingerprint(' sub-account-uid-1 ')).toBe(accountFingerprint)
    expect(accountFingerprint).not.toContain('sub-account-uid-1')
    expect(() => createOkxAccountFingerprint(undefined))
      .toThrow(MutationJournalIntegrityError)
  })
})
