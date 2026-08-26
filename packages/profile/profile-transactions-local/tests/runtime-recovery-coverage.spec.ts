import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LocalProfileMutationConflictError,
  LocalProfileTransactionStore,
  digestProfileTree,
  type StoreSnapshot,
} from '../src/runtime.ts'

const EMPTY_LOCK = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: false
  excludeLinksFromLockfile: false
importers:
  .:
    dependencies: {}
packages: {}
snapshots: {}
`
const FORMAT_VERSION = 2
const COORDINATOR_APPLICATION_ID = 0x44505432
const COORDINATOR_SCHEMA_VERSION = 4
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const OPERATION = '44444444-4444-4444-8444-444444444444'
const D = '55555555-5555-4555-8555-555555555555'
const COMMIT_MUTATION_ID = 'commit-recovery'
const COMMIT_NEXT_UTF8 = '[]\n'
const COMMIT_NEXT_DIGEST = `sha256:${createHash('sha256').update(COMMIT_NEXT_UTF8).digest('hex')}`
const COMMIT_MUTATION = {
  operation: 'configure',
  packageName: 'example',
  patch: {
    expectedDigest: ZERO_DIGEST,
    nextUtf8: COMMIT_NEXT_UTF8,
    nextDigest: COMMIT_NEXT_DIGEST,
  },
} as const
const COMMIT_REQUEST_DIGEST = `sha256:${createHash('sha256').update(JSON.stringify({
  profile: 'web',
  mutation: COMMIT_MUTATION,
})).digest('hex')}`
const TEST_INSTALL_ANCHOR = fileURLToPath(import.meta.url)
const cleanups: Array<() => Promise<void>> = []

interface Pointer {
  profile: string
  revision: number
  activeGeneration: string | null
  lastGoodGeneration: string | null
  rollbackGeneration: string | null
}

interface RuntimeInternals {
  assertExpected(snapshot: StoreSnapshot, revision: number, treeDigest: string): void
  assertCommitOperationRecord(record: unknown, before: Pointer, after: Pointer): void
  assertSameStage(record: unknown, request: unknown): void
  readCompleteGeneration(profile: string, generation: string, verifyTree: boolean): unknown
  generationSummary(record: unknown): unknown
  recordMutationSemanticDigest(record: unknown): string
  recordCommitOperationLocked(
    database: DatabaseSync,
    record: unknown,
    requestDigest: string,
    before: Pointer,
    after: Pointer,
  ): void
  readCommitOperationForRecordLocked(database: DatabaseSync, record: unknown): unknown
  pointerOperationsReferenceGenerationLocked(
    database: DatabaseSync,
    profile: string,
    generation: string,
  ): boolean
  cleanupCommittedJournal(profile: string, expectedOperation?: string): Promise<void>
  readRestoreOperationLocked(
    database: DatabaseSync,
    request: { readonly profile: string; readonly mutationId: string },
  ): unknown
  recordRestoreOperationLocked(
    database: DatabaseSync,
    mutationId: string,
    requestDigest: string,
    before: Pointer,
    after: Pointer,
  ): void
  assertJournalEvidence(
    journal: unknown,
    database?: { prepare(sql: string): { get(...values: unknown[]): unknown } },
  ): unknown
  withWriterLock<T>(profile: string, operation: (database: DatabaseSync) => T): Promise<T>
  withRecoveredWriterLock<T>(profile: string, operation: (database: DatabaseSync, state: Pointer) => T): Promise<T>
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function scratch(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-profile-recovery-${label}-`))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function writeProfile(profilePath: string): Promise<void> {
  await mkdir(profilePath, { recursive: true })
  await Promise.all([
    writeFile(join(profilePath, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, null, 2)}\n`),
    writeFile(join(profilePath, 'cordis.patch.yml'), '[]\n'),
    writeFile(join(profilePath, 'pnpm-workspace.yaml'), 'packages:\n  - .\n'),
    writeFile(join(profilePath, 'pnpm-lock.yaml'), EMPTY_LOCK),
  ])
}

async function fixture(label: string): Promise<{
  profilesDir: string
  statePath: string
  journalPath: string
  coordinatorPath: string
  local: LocalProfileTransactionStore
  internal: RuntimeInternals
}> {
  const root = await scratch(label)
  const profilesDir = join(root, 'profiles')
  await writeProfile(join(profilesDir, 'web'))
  const transactionDir = join(profilesDir, '.dsh-profile-transactions', 'web')
  const local = new LocalProfileTransactionStore({ profilesDir, installAnchor: TEST_INSTALL_ANCHOR, lockWaitMs: 100 })
  return {
    profilesDir,
    statePath: join(transactionDir, 'state.json'),
    journalPath: join(transactionDir, 'journal.json'),
    coordinatorPath: join(transactionDir, 'writer.sqlite'),
    local,
    internal: local as unknown as RuntimeInternals,
  }
}

async function writeDocument(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function pointer(overrides: Partial<Pointer> = {}): Pointer {
  return {
    profile: 'web',
    revision: 0,
    activeGeneration: null,
    lastGoodGeneration: null,
    rollbackGeneration: null,
    ...overrides,
  }
}

function stateDocument(value: Pointer): Record<string, unknown> {
  return { formatVersion: FORMAT_VERSION, ...value }
}

function acknowledgementJournal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: FORMAT_VERSION,
    operation: OPERATION,
    kind: 'acknowledge-boot',
    mutationId: null,
    requestDigest: null,
    profile: 'web',
    before: pointer({ revision: 1, activeGeneration: A, lastGoodGeneration: B, rollbackGeneration: C }),
    after: pointer({ revision: 2, activeGeneration: A, lastGoodGeneration: A, rollbackGeneration: B }),
    ...overrides,
  }
}

function commitJournal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: FORMAT_VERSION,
    operation: OPERATION,
    kind: 'commit',
    mutationId: COMMIT_MUTATION_ID,
    requestDigest: COMMIT_REQUEST_DIGEST,
    profile: 'web',
    before: pointer(),
    after: pointer({ revision: 1, activeGeneration: A, lastGoodGeneration: B }),
    ...overrides,
  }
}

async function prepareCommitRecovery(
  profilesDir: string,
  internal: RuntimeInternals,
): Promise<Record<string, unknown>> {
  const baseline = await writeGeneration(profilesDir, B)
  await writeGeneration(profilesDir, A, {
    record: {
      mutationId: COMMIT_MUTATION_ID,
      source: 'mutation',
      basedOnGeneration: null,
      basedOnTreeDigest: baseline.record.treeDigest,
      mutation: COMMIT_MUTATION,
    },
  })
  await internal.withWriterLock('web', (database) => {
    database.prepare(`INSERT INTO stage_reservations (
      mutation_id, request_digest, generation, status,
      owner_pid, owner_incarnation, owner_token, updated_at_ms
    ) VALUES (?, ?, ?, 'complete', NULL, NULL, NULL, ?)`).run(
      COMMIT_MUTATION_ID, ZERO_DIGEST, A, Date.now(),
    )
  })
  return commitJournal()
}

function restoreJournal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: FORMAT_VERSION,
    operation: OPERATION,
    kind: 'restore',
    mutationId: 'restore-recovery',
    requestDigest: ZERO_DIGEST,
    profile: 'web',
    before: pointer({ revision: 3, activeGeneration: A, lastGoodGeneration: B, rollbackGeneration: C }),
    after: pointer({ revision: 4, activeGeneration: B, lastGoodGeneration: B, rollbackGeneration: C }),
    ...overrides,
  }
}

async function writeGeneration(
  profilesDir: string,
  generation: string,
  options: {
    readonly record?: Record<string, unknown>
    readonly prepare?: (profilePath: string) => Promise<void>
  } = {},
): Promise<{ profilePath: string; recordPath: string; record: Record<string, unknown> }> {
  const generationRoot = join(profilesDir, '.dsh-profile-transactions', 'web', 'generations', generation)
  const profilePath = join(generationRoot, 'profile')
  await writeProfile(profilePath)
  await options.prepare?.(profilePath)
  const treeDigest = digestProfileTree(profilePath)
  const record = {
    formatVersion: FORMAT_VERSION,
    profile: 'web',
    generation,
    mutationId: null,
    source: 'baseline',
    basedOnRevision: 0,
    basedOnGeneration: null,
    basedOnTreeDigest: treeDigest,
    treeDigest,
    mutation: null,
    ...options.record,
  }
  const recordPath = join(generationRoot, 'generation.json')
  await writeDocument(recordPath, record)
  return { profilePath, recordPath, record }
}

async function writePointerGenerations(
  profilesDir: string,
): Promise<Map<string, Awaited<ReturnType<typeof writeGeneration>>>> {
  const generations = await Promise.all([A, B, C].map(generation => writeGeneration(profilesDir, generation)))
  return new Map(generations.map(generation => [generation.record.generation as string, generation]))
}

function fakeDatabase(value: unknown): DatabaseSync {
  return {
    prepare: () => ({ get: () => value }),
  } as unknown as DatabaseSync
}

describe('corrupt pointer and journal state', () => {
  it('rejects malformed state documents and all pointer fields', async () => {
    const { statePath, local } = await fixture('state')
    const valid = stateDocument(pointer())
    const cases: Array<readonly [unknown, RegExp]> = [
      [null, /unsupported or malformed state file/],
      [{ ...valid, formatVersion: 1 }, /unsupported or malformed state file/],
      [{ ...valid, unexpected: true }, /invalid state Profile/],
      [{ ...valid, profile: 'other' }, /invalid state Profile/],
      [{ ...valid, revision: -1 }, /invalid state revision/],
      [{ ...valid, revision: 1.5 }, /invalid state revision/],
      [{ ...valid, activeGeneration: 'bad' }, /invalid state activeGeneration/],
      [{ ...valid, lastGoodGeneration: 'bad' }, /invalid state lastGoodGeneration/],
      [{ ...valid, rollbackGeneration: 'bad' }, /invalid state rollbackGeneration/],
      [{ ...valid, activeGeneration: A }, /unreachable state pointer state/],
      [{ ...valid, lastGoodGeneration: B }, /unreachable state pointer state/],
      [{ ...valid, rollbackGeneration: C }, /unreachable state pointer state/],
      [{ ...valid, revision: 1 }, /unreachable state pointer state/],
      [{ ...valid, revision: 1, activeGeneration: A, lastGoodGeneration: B, rollbackGeneration: B },
        /unreachable state pointer state/],
    ]
    for (const [document, diagnostic] of cases) {
      await writeDocument(statePath, document)
      expect(() => local.snapshot('web')).toThrow(diagnostic)
    }
    await writeFile(statePath, '{')
    expect(() => local.snapshot('web')).toThrow(SyntaxError)
  })

  it('rejects malformed journal header fields and nested pointers', async () => {
    const { statePath, journalPath, local } = await fixture('journal-header')
    await writeDocument(statePath, stateDocument(pointer({
      revision: 1,
      activeGeneration: A,
      lastGoodGeneration: B,
      rollbackGeneration: C,
    })))
    const base = acknowledgementJournal()
    const cases: Array<readonly [unknown, RegExp]> = [
      [null, /unsupported or malformed journal file/],
      [{ ...base, formatVersion: 1 }, /unsupported or malformed journal file/],
      [{ ...base, unexpected: true }, /unsupported or malformed journal file/],
      [{ ...base, profile: 'other' }, /unsupported or malformed journal file/],
      [{ ...base, operation: 1 }, /unsupported or malformed journal file/],
      [{ ...base, operation: 'bad' }, /unsupported or malformed journal file/],
      [{ ...base, kind: 'unknown' }, /unsupported or malformed journal file/],
      [{ ...base, mutationId: 1 }, /unsupported or malformed journal file/],
      [{ ...base, mutationId: 'bad id' }, /unsupported or malformed journal file/],
      [{ ...base, requestDigest: 1 }, /unsupported or malformed journal file/],
      [{ ...base, requestDigest: 'bad' }, /unsupported or malformed journal file/],
      [{ ...base, mutationId: 'paired', requestDigest: null }, /unsupported or malformed journal file/],
      [{ ...base, mutationId: null, requestDigest: ZERO_DIGEST }, /unsupported or malformed journal file/],
      [{ ...base, mutationId: 'paired', requestDigest: ZERO_DIGEST }, /unsupported or malformed journal file/],
      [{ ...base, kind: 'restore' }, /unsupported or malformed journal file/],
      [{ ...base, before: null }, /invalid journal before Profile/],
      [{ ...base, before: { ...(base.before as Pointer), unexpected: true } }, /invalid journal before Profile/],
      [{ ...base, before: { ...(base.before as Pointer), profile: 'other' } }, /invalid journal before Profile/],
      [{ ...base, before: { ...(base.before as Pointer), revision: -1 } }, /invalid journal before revision/],
      [{ ...base, before: { ...(base.before as Pointer), activeGeneration: 'bad' } }, /invalid journal before activeGeneration/],
      [{ ...base, after: null }, /invalid journal after Profile/],
      [{ ...base, after: { ...(base.after as Pointer), lastGoodGeneration: 'bad' } }, /invalid journal after lastGoodGeneration/],
    ]
    for (const [document, diagnostic] of cases) {
      await writeDocument(journalPath, document)
      expect(() => local.snapshot('web')).toThrow(diagnostic)
    }
  })

  it('rejects every illegal commit, restore, and boot-acknowledgement transition', async () => {
    const { journalPath, local } = await fixture('journal-transition')
    const commit = commitJournal({
      before: pointer({ revision: 3, activeGeneration: A, lastGoodGeneration: B, rollbackGeneration: C }),
      after: pointer({ revision: 4, activeGeneration: D, lastGoodGeneration: B, rollbackGeneration: C }),
    })
    const restore = restoreJournal()
    const acknowledge = acknowledgementJournal()
    const cases: Array<readonly [Record<string, unknown>, RegExp]> = [
      [{ ...acknowledge, after: { ...(acknowledge.after as Pointer), revision: 3 } }, /journal revision is not monotonic/],
      [{ ...commit, after: { ...(commit.after as Pointer), activeGeneration: null } },
        /unreachable journal after pointer state/],
      [{ ...commit, after: { ...(commit.after as Pointer), activeGeneration: A } }, /malformed commit journal transition/],
      [{ ...commit, after: { ...(commit.after as Pointer), activeGeneration: B } }, /malformed commit journal transition/],
      [{ ...commit, after: { ...(commit.after as Pointer), activeGeneration: C } }, /malformed commit journal transition/],
      [{ ...commit, after: { ...(commit.after as Pointer), lastGoodGeneration: null } },
        /unreachable journal after pointer state/],
      [{ ...commit, after: { ...(commit.after as Pointer), lastGoodGeneration: A } }, /malformed commit journal transition/],
      [{ ...commit, after: { ...(commit.after as Pointer), rollbackGeneration: B } },
        /unreachable journal after pointer state/],
      [{ ...restore, after: { ...(restore.after as Pointer), activeGeneration: null } },
        /unreachable journal after pointer state/],
      [{ ...restore, after: { ...(restore.after as Pointer), activeGeneration: A } }, /malformed restore journal transition/],
      [{ ...restore, after: { ...(restore.after as Pointer), activeGeneration: C } }, /malformed restore journal transition/],
      [{ ...restore, after: { ...(restore.after as Pointer), lastGoodGeneration: C } },
        /unreachable journal after pointer state/],
      [{ ...restore, after: { ...(restore.after as Pointer), rollbackGeneration: A } }, /malformed restore journal transition/],
      [{ ...acknowledge, after: { ...(acknowledge.after as Pointer), activeGeneration: null } },
        /unreachable journal after pointer state/],
      [{ ...acknowledge, after: { ...(acknowledge.after as Pointer), activeGeneration: C } }, /malformed boot acknowledgement/],
      [{ ...acknowledge, after: { ...(acknowledge.after as Pointer), lastGoodGeneration: B } },
        /unreachable journal after pointer state/],
      [{ ...acknowledge, after: { ...(acknowledge.after as Pointer), rollbackGeneration: C } }, /malformed boot acknowledgement/],
      [{
        ...acknowledge,
        before: pointer({ revision: 1, activeGeneration: A, lastGoodGeneration: A, rollbackGeneration: B }),
        after: pointer({ revision: 2, activeGeneration: A, lastGoodGeneration: A, rollbackGeneration: A }),
      }, /unreachable journal after pointer state/],
      [{
        ...commitJournal(),
        before: pointer({ lastGoodGeneration: B }),
        after: pointer({ revision: 1, activeGeneration: A, lastGoodGeneration: B }),
      }, /unreachable journal before pointer state/],
      [{
        ...restore,
        before: pointer({ revision: 3, activeGeneration: A, lastGoodGeneration: A, rollbackGeneration: C }),
        after: pointer({ revision: 4, activeGeneration: A, lastGoodGeneration: A, rollbackGeneration: C }),
      }, /malformed restore journal transition/],
    ]
    for (const [document, diagnostic] of cases) {
      await writeDocument(journalPath, document)
      expect(() => local.snapshot('web')).toThrow(diagnostic)
    }
  })

  it('projects either side of a valid journal and rejects an unrelated state', async () => {
    const { profilesDir, statePath, journalPath, local } = await fixture('journal-projection')
    await writePointerGenerations(profilesDir)
    const journal = acknowledgementJournal()
    await writeDocument(journalPath, journal)
    await writeDocument(statePath, stateDocument(journal.before as Pointer))
    await expect(local.snapshot('web')).resolves.toMatchObject({ revision: 2, lastGoodGeneration: A })
    await writeDocument(statePath, stateDocument(journal.after as Pointer))
    await expect(local.snapshot('web')).resolves.toMatchObject({ revision: 2, lastGoodGeneration: A })
    await writeDocument(statePath, stateDocument(pointer({
      revision: 9,
      activeGeneration: A,
      lastGoodGeneration: B,
      rollbackGeneration: C,
    })))
    expect(() => local.snapshot('web')).toThrow(/journal does not continue/)
  })
})

describe('journal recovery and durable restore receipts', () => {
  it('rejects restore journal evidence that collides with staging or changes its request digest', async () => {
    const current = await fixture('restore-evidence')
    await writePointerGenerations(current.profilesDir)
    const collisionDatabase = {
      prepare: () => ({ get: () => ({ collision: 1 }) }),
    }
    expect(() => current.internal.assertJournalEvidence(restoreJournal(), collisionDatabase))
      .toThrow(/restore journal collides with a staging reservation/)
    expect(() => current.internal.assertJournalEvidence(restoreJournal()))
      .toThrow(/restore journal request digest does not match its before state/)
  })

  it('recovers both journal windows and removes only the correlated journal', async () => {
    for (const stateSide of ['before', 'after'] as const) {
      const { profilesDir, statePath, journalPath, internal } = await fixture(`recover-${stateSide}`)
      const journal = await prepareCommitRecovery(profilesDir, internal)
      await writeDocument(statePath, stateDocument(journal[stateSide] as Pointer))
      await writeDocument(journalPath, journal)
      await expect(internal.withRecoveredWriterLock('web', () => 'recovered')).resolves.toBe('recovered')
      await expect(access(journalPath)).rejects.toThrow()
      expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject(journal.after as Pointer)
    }

    const acknowledgement = await fixture('recover-acknowledgement')
    await writePointerGenerations(acknowledgement.profilesDir)
    const journal = acknowledgementJournal()
    await writeDocument(acknowledgement.statePath, stateDocument(journal.before as Pointer))
    await writeDocument(acknowledgement.journalPath, journal)
    await expect(acknowledgement.internal.withRecoveredWriterLock('web', () => 'recovered'))
      .resolves.toBe('recovered')
    await expect(access(acknowledgement.journalPath)).rejects.toThrow()
  })

  it('rejects a correlated commit journal whose semantic identity changed', async () => {
    const current = await fixture('recover-commit-identity')
    const journal = await prepareCommitRecovery(current.profilesDir, current.internal)
    await writeDocument(current.statePath, stateDocument(journal.before as Pointer))
    await writeDocument(current.journalPath, { ...journal, requestDigest: ZERO_DIGEST })
    await expect(current.internal.withRecoveredWriterLock('web', () => undefined))
      .rejects.toThrow(/commit journal does not match its generation mutation/)
  })

  it('rejects unrelated recovery state and guarded journal cleanup relationships', async () => {
    const mismatch = await fixture('recover-mismatch')
    const initial = await mismatch.local.snapshot('web')
    expect(() => {
      mismatch.internal.assertExpected(initial, 1, initial.treeDigest)
    })
      .toThrow(/profile revision conflict/)
    await writeDocument(mismatch.statePath, stateDocument(pointer({
      revision: 9,
      activeGeneration: A,
      lastGoodGeneration: B,
      rollbackGeneration: C,
    })))
    await writeDocument(mismatch.journalPath, acknowledgementJournal())
    await expect(mismatch.internal.withRecoveredWriterLock('web', () => undefined)).rejects.toThrow(/journal does not continue/)

    const operationRace = await fixture('cleanup-operation')
    const acknowledgement = acknowledgementJournal()
    await writeDocument(operationRace.statePath, stateDocument(acknowledgement.after as Pointer))
    await writeDocument(operationRace.journalPath, acknowledgement)
    await operationRace.internal.cleanupCommittedJournal('web', A)
    await expect(access(operationRace.journalPath)).resolves.toBeUndefined()
    await operationRace.internal.cleanupCommittedJournal('web', OPERATION)
    await expect(access(operationRace.journalPath)).rejects.toThrow()

    const stateRace = await fixture('cleanup-state')
    await writeDocument(stateRace.statePath, stateDocument(acknowledgement.before as Pointer))
    await writeDocument(stateRace.journalPath, acknowledgement)
    await expect(stateRace.internal.cleanupCommittedJournal('web', OPERATION)).rejects.toThrow(/not durably published/)

    const empty = await fixture('cleanup-empty')
    await expect(empty.internal.cleanupCommittedJournal('web')).resolves.toBeUndefined()
  })

  it('reconstructs a restore receipt during recovery and requires it before cleanup', async () => {
    const recovered = await fixture('restore-recovered')
    const generations = await writePointerGenerations(recovered.profilesDir)
    const beforeTreeDigest = generations.get(A)?.record.treeDigest
    if (typeof beforeTreeDigest !== 'string') throw new Error('missing active generation digest')
    const requestDigest = `sha256:${createHash('sha256').update(JSON.stringify({
      profile: 'web',
      expectedRevision: 3,
      expectedTreeDigest: beforeTreeDigest,
    })).digest('hex')}`
    const journal = restoreJournal({ requestDigest })
    await writeDocument(recovered.statePath, stateDocument(journal.before as Pointer))
    await writeDocument(recovered.journalPath, journal)
    await expect(recovered.internal.withRecoveredWriterLock('web', () => 'done')).resolves.toBe('done')
    await recovered.internal.withWriterLock('web', (database) => {
      expect(recovered.internal.readRestoreOperationLocked(
        database,
        { profile: 'web', mutationId: 'restore-recovery' },
      )).toMatchObject({ operation: 'restore', restartRequired: true })
    })

    const missing = await fixture('restore-missing-receipt')
    await writeDocument(missing.statePath, stateDocument(journal.after as Pointer))
    await writeDocument(missing.journalPath, journal)
    await expect(missing.internal.cleanupCommittedJournal('web', OPERATION)).rejects.toThrow(/no durable operation receipt/)
  })

  it('rejects malformed, conflicting, or internally inconsistent restore receipt rows', async () => {
    const { internal } = await fixture('restore-row')
    const request = { profile: 'web', mutationId: 'restore-row' }
    expect(internal.readRestoreOperationLocked(fakeDatabase(undefined), request)).toBeUndefined()
    for (const value of [
      null,
      { kind: 'other', request_digest: ZERO_DIGEST, receipt_json: '{}' },
      { kind: 'restore', request_digest: 1, receipt_json: '{}' },
      { kind: 'restore', request_digest: ZERO_DIGEST, receipt_json: 1 },
    ]) {
      expect(() => internal.readRestoreOperationLocked(fakeDatabase(value), request))
        .toThrow(/malformed pointer operation receipt/)
    }
    expect(() => internal.readRestoreOperationLocked(fakeDatabase({
      kind: 'restore', request_digest: 'not-a-digest', receipt_json: '{}',
    }), request)).toThrow(/malformed pointer operation receipt/)
    expect(() => internal.readRestoreOperationLocked(fakeDatabase({
      kind: 'restore', request_digest: ZERO_DIGEST, receipt_json: '{',
    }), request)).toThrow(/malformed pointer operation receipt JSON/)
    expect(() => internal.readRestoreOperationLocked(fakeDatabase({
      kind: 'restore', request_digest: ZERO_DIGEST, receipt_json: '[]',
    }), request)).toThrow(/malformed pointer operation receipt document/)
    expect(() => internal.readRestoreOperationLocked(fakeDatabase({
      kind: 'restore',
      request_digest: ZERO_DIGEST,
      receipt_json: JSON.stringify({ before: pointer(), after: pointer({ revision: 1 }), unexpected: true }),
    }), request)).toThrow(/malformed pointer operation receipt document/)
    expect(() => internal.readRestoreOperationLocked(fakeDatabase({
      kind: 'restore', request_digest: ZERO_DIGEST, receipt_json: JSON.stringify({ before: null, after: null }),
    }), request)).toThrow(/invalid restore receipt before Profile/)
    expect(() => internal.readRestoreOperationLocked(fakeDatabase({
      kind: 'restore',
      request_digest: ZERO_DIGEST,
      receipt_json: JSON.stringify({
        before: pointer({ revision: 1, activeGeneration: A, lastGoodGeneration: B, rollbackGeneration: C }),
        after: pointer({ revision: 3, activeGeneration: B, lastGoodGeneration: B, rollbackGeneration: C }),
      }),
    }), request)).toThrow(/journal revision is not monotonic/)
    expect(() => internal.readRestoreOperationLocked(fakeDatabase({
      kind: 'restore',
      request_digest: ZERO_DIGEST,
      receipt_json: JSON.stringify({
        before: pointer({ revision: 1, activeGeneration: A, lastGoodGeneration: B, rollbackGeneration: C }),
        after: pointer({ revision: 2, activeGeneration: C, lastGoodGeneration: B, rollbackGeneration: C }),
      }),
    }), request)).toThrow(/malformed restore journal transition/)
    expect(() => internal.readRestoreOperationLocked(fakeDatabase({
      kind: 'commit',
      request_digest: ZERO_DIGEST,
      receipt_json: JSON.stringify({
        before: pointer(),
        after: pointer({ revision: 1, activeGeneration: A, lastGoodGeneration: B }),
      }),
    }), request)).toThrow(LocalProfileMutationConflictError)
  })

  it('rejects inconsistent commit evidence, digests, replays, and pointer identities', async () => {
    const current = await fixture('commit-evidence')
    const baseline = await writeGeneration(current.profilesDir, B)
    const record = {
      formatVersion: FORMAT_VERSION,
      profile: 'web',
      generation: A,
      mutationId: COMMIT_MUTATION_ID,
      source: 'mutation',
      basedOnRevision: 0,
      basedOnGeneration: null,
      basedOnTreeDigest: baseline.record.treeDigest,
      treeDigest: baseline.record.treeDigest,
      mutation: COMMIT_MUTATION,
    }
    const before = pointer()
    const after = pointer({ revision: 1, activeGeneration: A, lastGoodGeneration: B })

    expect(() => {
      current.internal.assertCommitOperationRecord({ ...record, source: 'baseline' }, before, after)
    }).toThrow(/does not match its generation record/)
    expect(() => {
      current.internal.assertCommitOperationRecord(record, before, { ...after, lastGoodGeneration: null })
    }).toThrow(/no immutable base evidence/)
    expect(() => {
      current.internal.assertCommitOperationRecord({ ...record, basedOnTreeDigest: ZERO_DIGEST }, before, after)
    }).toThrow(/base digest does not match immutable evidence/)
    expect(() => current.internal.recordMutationSemanticDigest({ ...record, source: 'baseline', mutation: null }))
      .toThrow(/baseline generation has no mutation identity/)

    await writeGeneration(current.profilesDir, A, { record })
    await current.internal.withWriterLock('web', (database) => {
      database.prepare(`INSERT INTO stage_reservations (
        mutation_id, request_digest, generation, status,
        owner_pid, owner_incarnation, owner_token, updated_at_ms
      ) VALUES (?, ?, ?, 'complete', NULL, NULL, NULL, ?)`).run(
        COMMIT_MUTATION_ID, ZERO_DIGEST, A, Date.now(),
      )
    })
    const complete = current.internal.readCompleteGeneration('web', A, true)
    await expect(current.internal.withWriterLock('web', (database) => {
      current.internal.recordCommitOperationLocked(database, complete, ZERO_DIGEST, before, after)
    })).rejects.toThrow(/commit request digest does not match its generation mutation/)

    const restoreCollision = fakeDatabase({
      kind: 'restore',
      request_digest: ZERO_DIGEST,
      receipt_json: JSON.stringify({
        before: pointer({ revision: 2, activeGeneration: A, lastGoodGeneration: B }),
        after: pointer({ revision: 3, activeGeneration: B, lastGoodGeneration: B }),
      }),
    })
    expect(() => current.internal.readCommitOperationForRecordLocked(restoreCollision, complete))
      .toThrow(LocalProfileMutationConflictError)

    const malformedCommit = fakeDatabase({
      kind: 'commit',
      request_digest: COMMIT_REQUEST_DIGEST,
      receipt_json: JSON.stringify({
        before: pointer(),
        after: pointer({ revision: 1, activeGeneration: A, lastGoodGeneration: A }),
      }),
    })
    expect(() => current.internal.readCommitOperationForRecordLocked(malformedCommit, complete))
      .toThrow(/malformed commit journal transition/)

    const malformedRows = {
      prepare: () => ({ all: () => [{ mutation_id: 1 }] }),
    } as unknown as DatabaseSync
    expect(() => current.internal.pointerOperationsReferenceGenerationLocked(malformedRows, 'web', A))
      .toThrow(/malformed pointer operation identity/)

    expect(() => {
      current.internal.assertSameStage(record, {
        profile: 'web',
        mutationId: COMMIT_MUTATION_ID,
        expectedRevision: 1,
        expectedTreeDigest: record.basedOnTreeDigest,
        mutation: COMMIT_MUTATION,
      })
    }).toThrow(LocalProfileMutationConflictError)
  })

  it('rejects restore identities colliding with stages or inconsistent inserted rows', async () => {
    const { internal } = await fixture('restore-record')
    const before = pointer({ revision: 1, activeGeneration: A, lastGoodGeneration: B, rollbackGeneration: C })
    const after = pointer({ revision: 2, activeGeneration: B, lastGoodGeneration: B, rollbackGeneration: C })
    const stageConflict = {
      prepare: () => ({ get: () => ({ present: 1 }) }),
    } as unknown as DatabaseSync
    expect(() => {
      internal.recordRestoreOperationLocked(stageConflict, 'restore-record', ZERO_DIGEST, before, after)
    })
      .toThrow(LocalProfileMutationConflictError)

    let query = 0
    const inconsistent = {
      prepare: () => {
        query += 1
        if (query === 1) return { get: () => undefined }
        if (query === 2) return { run: () => ({ changes: 1 }) }
        return { get: () => ({ kind: 'restore', request_digest: 'different', receipt_json: '{}' }) }
      },
    } as unknown as DatabaseSync
    expect(() => {
      internal.recordRestoreOperationLocked(inconsistent, 'restore-record', ZERO_DIGEST, before, after)
    })
      .toThrow(LocalProfileMutationConflictError)
  })
})

describe('generation record recovery admission', () => {
  it('rejects malformed generation envelope fields and inconsistent source metadata', async () => {
    const { profilesDir, internal } = await fixture('generation-envelope')
    const generation = await writeGeneration(profilesDir, A)
    const valid = generation.record
    const cases: Array<readonly [unknown, RegExp]> = [
      [null, /absent, incomplete, or malformed/],
      [{ ...valid, formatVersion: 1 }, /absent, incomplete, or malformed/],
      [{ ...valid, unexpected: true }, /absent, incomplete, or malformed/],
      [{ ...valid, profile: 'other' }, /absent, incomplete, or malformed/],
      [{ ...valid, generation: B }, /absent, incomplete, or malformed/],
      [{ ...valid, source: 'other' }, /absent, incomplete, or malformed/],
      [{ ...valid, mutationId: 1 }, /absent, incomplete, or malformed/],
      [{ ...valid, mutationId: 'bad id' }, /absent, incomplete, or malformed/],
      [{ ...valid, basedOnRevision: -1 }, /absent, incomplete, or malformed/],
      [{ ...valid, basedOnRevision: 1.5 }, /absent, incomplete, or malformed/],
      [{ ...valid, basedOnTreeDigest: 1 }, /absent, incomplete, or malformed/],
      [{ ...valid, treeDigest: 1 }, /absent, incomplete, or malformed/],
      [{ ...valid, basedOnGeneration: 1 }, /absent, incomplete, or malformed/],
      [{ ...valid, basedOnGeneration: 'bad' }, /absent, incomplete, or malformed/],
      [{ ...valid, basedOnTreeDigest: 'bad' }, /generation base tree digest/],
      [{ ...valid, treeDigest: 'bad' }, /generation tree digest/],
      [{ ...valid, source: 'mutation', mutationId: 'missing-mutation' }, /source and mutation disagree/],
      [{ ...valid, mutationId: 'baseline-with-id' }, /source and mutation disagree/],
    ]
    for (const [document, diagnostic] of cases) {
      await writeDocument(generation.recordPath, document)
      expect(() => internal.readCompleteGeneration('web', A, false)).toThrow(diagnostic)
    }
    await writeFile(generation.recordPath, '{')
    expect(() => internal.readCompleteGeneration('web', A, false)).toThrow(SyntaxError)
  })

  it('strictly decodes configure and artifact mutation metadata', async () => {
    const { profilesDir, internal } = await fixture('generation-mutation')
    const artifactFile = '.dsh-artifacts/artifact.tgz'
    const body = Buffer.from('artifact')
    const generation = await writeGeneration(profilesDir, A, {
      prepare: async (profilePath) => {
        await mkdir(join(profilePath, '.dsh-artifacts'))
        await writeFile(join(profilePath, artifactFile), body)
        await mkdir(join(profilePath, '.dsh-artifacts', 'directory'))
      },
    })
    const artifactMutation = {
      operation: 'install',
      kind: 'bundle',
      packageName: '@example/recovered',
      version: '1.0.0',
      digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      integrity: 'sha512-valid',
      artifactFile,
      bytes: body.byteLength,
    }
    const record = {
      ...generation.record,
      source: 'mutation',
      mutationId: 'generation-mutation',
      mutation: artifactMutation,
    }
    await writeDocument(generation.recordPath, record)
    expect(internal.readCompleteGeneration('web', A, false)).toMatchObject({ mutation: artifactMutation })

    const mutationCases: Array<readonly [unknown, RegExp]> = [
      [null, /source and mutation disagree/],
      [{}, /malformed generation mutation metadata/],
      [{ operation: 1, packageName: 'example' }, /malformed generation mutation metadata/],
      [{ operation: 'uninstall', packageName: 'example', unexpected: true }, /malformed uninstall mutation metadata/],
      [{ operation: 'uninstall', packageName: 1 }, /malformed generation mutation metadata/],
      [{ operation: 'uninstall', packageName: 'bad name' }, /exact npm package name/],
      [{ operation: 'configure', packageName: 'example', patch: null }, /malformed configure mutation metadata/],
      [{ operation: 'configure', packageName: 'example', patch: { expectedDigest: ZERO_DIGEST, nextUtf8: '[]\n', nextDigest: ZERO_DIGEST }, unexpected: true }, /malformed configure mutation metadata/],
      [{ operation: 'configure', packageName: 'example', patch: { expectedDigest: ZERO_DIGEST, nextUtf8: '[]\n', nextDigest: ZERO_DIGEST, unexpected: true } }, /malformed configure mutation metadata/],
      [{ operation: 'configure', packageName: 'example', patch: { expectedDigest: 1, nextUtf8: '[]\n', nextDigest: ZERO_DIGEST } }, /malformed configure mutation metadata/],
      [{ operation: 'configure', packageName: 'example', patch: { expectedDigest: ZERO_DIGEST, nextUtf8: 1, nextDigest: ZERO_DIGEST } }, /malformed configure mutation metadata/],
      [{ operation: 'configure', packageName: 'example', patch: { expectedDigest: ZERO_DIGEST, nextUtf8: '[]\n', nextDigest: 1 } }, /malformed configure mutation metadata/],
      [{ operation: 'configure', packageName: 'example', patch: { expectedDigest: 'bad', nextUtf8: '[]\n', nextDigest: ZERO_DIGEST } }, /expected Profile patch digest/],
      [{ operation: 'configure', packageName: 'example', patch: { expectedDigest: ZERO_DIGEST, nextUtf8: '[]\n', nextDigest: ZERO_DIGEST } }, /nextDigest does not match/],
      [{ ...artifactMutation, operation: 'other' }, /malformed artifact mutation metadata/],
      [{ ...artifactMutation, unexpected: true }, /malformed artifact mutation metadata/],
      [{ ...artifactMutation, kind: 'other' }, /malformed artifact mutation metadata/],
      [{ ...artifactMutation, version: 1 }, /malformed artifact mutation metadata/],
      [{ ...artifactMutation, digest: 1 }, /malformed artifact mutation metadata/],
      [{ ...artifactMutation, integrity: 1 }, /malformed artifact mutation metadata/],
      [{ ...artifactMutation, artifactFile: 1 }, /malformed artifact mutation metadata/],
      [{ ...artifactMutation, bytes: -1 }, /malformed artifact mutation metadata/],
      [{ ...artifactMutation, bytes: 1.5 }, /malformed artifact mutation metadata/],
      [{ ...artifactMutation, version: 'v1.0.0' }, /exact SemVer/],
      [{ ...artifactMutation, digest: 'bad' }, /stored artifact digest/],
      [{ ...artifactMutation, integrity: 'bad' }, /malformed stored artifact integrity/],
      [{ ...artifactMutation, artifactFile: '../../outside.tgz' }, /absent or escapes/],
      [{ ...artifactMutation, artifactFile: '.dsh-artifacts/missing.tgz' }, /ENOENT/],
      [{ ...artifactMutation, artifactFile: '.dsh-artifacts/directory' }, /absent or escapes/],
      [{ ...artifactMutation, digest: `sha256:${'1'.repeat(64)}` }, /no longer matches its digest/],
      [{ ...artifactMutation, bytes: body.byteLength + 1 }, /no longer matches its digest/],
    ]
    for (const [mutation, diagnostic] of mutationCases) {
      await writeDocument(generation.recordPath, { ...record, mutation })
      expect(() => internal.readCompleteGeneration('web', A, false)).toThrow(diagnostic)
    }

    const nextUtf8 = '[]\n'
    const contentDigest = `sha256:${createHash('sha256').update(nextUtf8).digest('hex')}`
    await writeDocument(generation.recordPath, {
      ...record,
      mutation: {
        operation: 'configure',
        packageName: 'example',
        patch: { expectedDigest: ZERO_DIGEST, nextUtf8, nextDigest: contentDigest },
      },
    })
    const configured = internal.readCompleteGeneration('web', A, false)
    expect(configured).toMatchObject({
      mutation: { operation: 'configure', packageName: 'example' },
    })
    expect(internal.generationSummary(configured)).toMatchObject({
      mutation: { operation: 'configure', packageName: 'example' },
    })
    await writeDocument(generation.recordPath, {
      ...record,
      mutation: { operation: 'uninstall', packageName: 'example' },
    })
    expect(internal.readCompleteGeneration('web', A, false)).toMatchObject({
      mutation: { operation: 'uninstall', packageName: 'example' },
    })
    expect(internal.generationSummary(internal.readCompleteGeneration('web', A, false))).toMatchObject({
      mutation: { operation: 'uninstall', packageName: 'example' },
    })
  })

  it('rejects source mismatches and a post-record tree mutation', async () => {
    const { profilesDir, internal } = await fixture('generation-tree')
    const body = Buffer.from('artifact')
    const generation = await writeGeneration(profilesDir, A, {
      prepare: async (profilePath) => {
        await mkdir(join(profilePath, '.dsh-artifacts'))
        await writeFile(join(profilePath, '.dsh-artifacts/artifact.tgz'), body)
      },
    })
    const mutation = {
      operation: 'install',
      kind: 'bundle',
      packageName: 'example',
      version: '1.0.0',
      digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      integrity: 'sha512-valid',
      artifactFile: '.dsh-artifacts/artifact.tgz',
      bytes: body.byteLength,
    }
    await writeDocument(generation.recordPath, { ...generation.record, mutation })
    expect(() => internal.readCompleteGeneration('web', A, false)).toThrow(/source and mutation disagree/)
    await writeDocument(generation.recordPath, {
      ...generation.record,
      source: 'mutation',
      mutationId: null,
      mutation,
    })
    expect(() => internal.readCompleteGeneration('web', A, false)).toThrow(/source and mutation disagree/)

    await writeDocument(generation.recordPath, generation.record)
    await writeFile(join(generation.profilePath, 'cordis.patch.yml'), '# changed\n[]\n')
    expect(() => internal.readCompleteGeneration('web', A, true)).toThrow(/tree no longer matches its digest/)
  })
})

describe('coordinator corruption admission', () => {
  it('rejects each independently malformed persistent schema identity', async () => {
    const pointerSchema = `CREATE TABLE pointer_operations (
      mutation_id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('commit','restore')),
      request_digest TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
    ) STRICT`
    const stageSchema = `CREATE TABLE stage_reservations (
      mutation_id TEXT PRIMARY KEY NOT NULL,
      request_digest TEXT NOT NULL,
      generation TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('building','complete')),
      owner_pid INTEGER,
      owner_incarnation TEXT,
      owner_token TEXT,
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      CHECK ((status = 'building') = (
        owner_pid IS NOT NULL AND owner_incarnation IS NOT NULL AND owner_token IS NOT NULL
      ))
    ) STRICT`
    const currentIdentity = (database: DatabaseSync): void => {
      database.exec(`PRAGMA application_id = ${String(COORDINATOR_APPLICATION_ID)}`)
      database.exec(`PRAGMA user_version = ${String(COORDINATOR_SCHEMA_VERSION)}`)
    }
    const cases: Array<(database: DatabaseSync) => void> = [
      (database) => { database.exec('PRAGMA application_id = 1') },
      (database) => {
        database.exec(`PRAGMA application_id = ${String(COORDINATOR_APPLICATION_ID)}`)
        database.exec('PRAGMA user_version = 1')
      },
      (database) => {
        database.exec(`PRAGMA application_id = ${String(COORDINATOR_APPLICATION_ID)}`)
        database.exec(`PRAGMA user_version = ${String(COORDINATOR_SCHEMA_VERSION)}`)
        database.exec('CREATE TABLE only_one (id INTEGER)')
      },
      (database) => {
        database.exec(`PRAGMA application_id = ${String(COORDINATOR_APPLICATION_ID)}`)
        database.exec(`PRAGMA user_version = ${String(COORDINATOR_SCHEMA_VERSION)}`)
        database.exec('CREATE TABLE aaa (id INTEGER)')
        database.exec('CREATE TABLE stage_reservations (id INTEGER)')
      },
      (database) => {
        database.exec(`PRAGMA application_id = ${String(COORDINATOR_APPLICATION_ID)}`)
        database.exec(`PRAGMA user_version = ${String(COORDINATOR_SCHEMA_VERSION)}`)
        database.exec('CREATE TABLE pointer_operations (id INTEGER)')
        database.exec('CREATE TABLE zzz (id INTEGER)')
      },
      (database) => {
        currentIdentity(database)
        database.exec(`CREATE TABLE stage_reservations (
          mutation_id TEXT PRIMARY KEY,
          request_digest TEXT,
          generation TEXT UNIQUE,
          status TEXT,
          owner_pid INTEGER,
          owner_incarnation TEXT,
          owner_token TEXT,
          updated_at_ms INTEGER
        )`)
        database.exec(`CREATE TABLE pointer_operations (
          mutation_id TEXT PRIMARY KEY,
          kind TEXT,
          request_digest TEXT,
          receipt_json TEXT,
          updated_at_ms INTEGER
        )`)
      },
      (database) => {
        currentIdentity(database)
        database.exec(stageSchema.replace('owner_token TEXT,', 'owner_token TEXT,\n      unexpected TEXT,'))
        database.exec(pointerSchema)
      },
      (database) => {
        currentIdentity(database)
        database.exec(stageSchema.replace('generation TEXT UNIQUE NOT NULL', 'generation TEXT NOT NULL'))
        database.exec(pointerSchema)
      },
    ]
    for (const [index, configure] of cases.entries()) {
      const current = await fixture(`coordinator-${String(index)}`)
      await mkdir(dirname(current.coordinatorPath), { recursive: true })
      const database = new DatabaseSync(current.coordinatorPath)
      configure(database)
      database.close()
      await expect(current.internal.withWriterLock('web', () => undefined))
        .rejects.toThrow(/coordinator schema is unsupported or malformed/)
    }
  })
})
