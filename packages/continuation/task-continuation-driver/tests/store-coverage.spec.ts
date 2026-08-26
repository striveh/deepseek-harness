import { access, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  TaskContinuationMutationConflictError,
  continuationDigest,
  continuationId,
  taskContinuationCallerId,
  taskContinuationMutationId,
  taskContinuationRevision,
  taskContinuationVerifierId,
  type TaskContinuationClaim,
} from '@deepseek-ai/dsh-task-continuation'
import {
  DurableTaskContinuationStore,
  TaskContinuationStoreCorruptionError,
  type ContinuationStoreFileSystem,
  type NewContinuationRecord,
} from '../src/store.ts'

const APPLICATION_ID = 0x44544331
const SCHEMA_VERSION = 4
const DATABASE_FILE = 'claims.sqlite'
const roots: string[] = []
const stores: DurableTaskContinuationStore[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()))
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function temporaryRoot(prefix = 'dsh-continuation-store-coverage-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function track(store: DurableTaskContinuationStore): DurableTaskContinuationStore {
  stores.push(store)
  return store
}

function record(overrides: Partial<NewContinuationRecord> = {}): NewContinuationRecord {
  return {
    kind: 'task-continuation',
    version: 1,
    continuationId: continuationId('33333333-3333-4333-8333-333333333333'),
    callerId: taskContinuationCallerId('extension-center'),
    mutationId: taskContinuationMutationId('operation-3'),
    dispatchMessageId: MessageId('dispatch-3'),
    resumeAgentOptions: { provider: 'mock', model: 'mock', maxTokens: 512 },
    sessionId: SessionId('session-3'),
    originalMessageId: MessageId('message-3'),
    needDigest: continuationDigest(`sha256:${'a'.repeat(64)}`),
    taskRevision: taskContinuationRevision('revision-3'),
    verifierId: taskContinuationVerifierId('receipt-verifier'),
    verificationPayloadDigest: continuationDigest(`sha256:${'b'.repeat(64)}`),
    createdAtMs: 10,
    expiresAtMs: 10_000,
    ...overrides,
  }
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    continuation_id: '33333333-3333-4333-8333-333333333333',
    caller_id: 'extension-center',
    mutation_id: 'operation-3',
    record_revision: 0,
    state: 'pending',
    dispatch_message_id: 'dispatch-3',
    session_id: 'session-3',
    original_message_id: 'message-3',
    need_digest: `sha256:${'a'.repeat(64)}`,
    task_revision: 'revision-3',
    verifier_id: 'receipt-verifier',
    verification_payload_digest: `sha256:${'b'.repeat(64)}`,
    created_at_ms: 10,
    updated_at_ms: 10,
    expires_at_ms: 10_000,
    agent_provider: 'mock',
    agent_model: 'mock',
    agent_max_tokens: 512,
    superseded_by_task_revision: null,
    dispatch_owner_id: null,
    dispatch_incarnation: 0,
    dispatch_lease_expires_at_ms: null,
    ...overrides,
  }
}

function looseClaimsSchema(database: DatabaseSync): void {
  database.exec(`CREATE TABLE claims (
    continuation_id, caller_id, mutation_id, record_revision, state, dispatch_message_id, session_id,
    original_message_id, need_digest, task_revision, verifier_id, verification_payload_digest,
    created_at_ms, updated_at_ms, expires_at_ms, agent_provider, agent_model, agent_max_tokens,
    superseded_by_task_revision, dispatch_owner_id, dispatch_incarnation, dispatch_lease_expires_at_ms
  )`)
  database.exec(`PRAGMA application_id = ${String(APPLICATION_ID)}`)
  database.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
}

function sqlInput(value: unknown): string | number | bigint | null {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value
  }
  throw new Error('loose continuation fixture accepts only SQLite scalar values')
}

async function storeWithLooseRow(value: Record<string, unknown>): Promise<DurableTaskContinuationStore> {
  const root = await temporaryRoot()
  const database = new DatabaseSync(join(root, DATABASE_FILE))
  looseClaimsSchema(database)
  database.prepare(`INSERT INTO claims VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )`).run(
    sqlInput(value['continuation_id']),
    sqlInput(value['caller_id']),
    sqlInput(value['mutation_id']),
    sqlInput(value['record_revision']),
    sqlInput(value['state']),
    sqlInput(value['dispatch_message_id']),
    sqlInput(value['session_id']),
    sqlInput(value['original_message_id']),
    sqlInput(value['need_digest']),
    sqlInput(value['task_revision']),
    sqlInput(value['verifier_id']),
    sqlInput(value['verification_payload_digest']),
    sqlInput(value['created_at_ms']),
    sqlInput(value['updated_at_ms']),
    sqlInput(value['expires_at_ms']),
    sqlInput(value['agent_provider']),
    sqlInput(value['agent_model']),
    sqlInput(value['agent_max_tokens']),
    sqlInput(value['superseded_by_task_revision']),
    sqlInput(value['dispatch_owner_id']),
    sqlInput(value['dispatch_incarnation']),
    sqlInput(value['dispatch_lease_expires_at_ms']),
  )
  const store = track(new DurableTaskContinuationStore(root, 1_000))
  // Row-codec fixtures intentionally use a loose schema that production
  // initialization rejects. Keep this dedicated connection behind ready().
  Object.assign(store, { database, opening: Promise.resolve() })
  return store
}

interface FakeStatement {
  get(...values: unknown[]): unknown
}

interface FakeDatabase {
  close(): void
  exec(sql: string): void
  prepare(sql: string): FakeStatement
}

function storeWithFakeRow(value: unknown): DurableTaskContinuationStore {
  const database: FakeDatabase = {
    close() {},
    exec() {},
    prepare: () => ({ get: () => value }),
  }
  const store = track(new DurableTaskContinuationStore('/unused/task-continuation-store', 1_000))
  Object.assign(store, { database, opening: Promise.resolve() })
  return store
}

function createRawDatabase(root: string): DatabaseSync {
  return new DatabaseSync(join(root, DATABASE_FILE))
}

function durableComponents(path: string): string[] {
  const components: string[] = []
  for (let current = resolve(path); dirname(current) !== current; current = dirname(current)) components.push(current)
  return components.reverse()
}

function realFileSystem(syncDirectory: ContinuationStoreFileSystem['syncDirectory']): ContinuationStoreFileSystem {
  return {
    mkdir: path => mkdir(path, { mode: 0o700 }),
    stat: path => stat(path),
    lstat: path => lstat(path),
    syncDirectory,
  }
}

describe('durable task continuation store coverage', () => {
  it('creates a root component by component and flushes each publishing parent before SQLite', async () => {
    const base = await temporaryRoot()
    const root = join(base, 'shared', 'claims', 'runtime')
    const synced: string[] = []
    const fileSystem = realFileSystem((path) => {
      synced.push(path)
      return Promise.resolve()
    })
    const expected = durableComponents(root).map(dirname)
    const store = track(new DurableTaskContinuationStore(root, 1_000, fileSystem))
    await store.initialize()
    expect(synced).toEqual(expected)

    const defaultRoot = join(base, 'default', 'nested')
    const defaultStore = track(new DurableTaskContinuationStore(defaultRoot, 1_000))
    await expect(defaultStore.initialize()).resolves.toBeUndefined()
    await expect(access(join(defaultRoot, DATABASE_FILE))).resolves.toBeUndefined()

    const failingRoot = join(base, 'failed', 'nested')
    const failedSyncs: string[] = []
    const failingParent = join(base, 'failed')
    const failingFileSystem = realFileSystem((path) => {
      failedSyncs.push(path)
      return path === failingParent
        ? Promise.reject(new Error('directory fsync failed'))
        : Promise.resolve()
    })
    const failing = track(new DurableTaskContinuationStore(failingRoot, 1_000, failingFileSystem))
    await expect(failing.initialize()).rejects.toThrow('directory fsync failed')
    const failingExpected = durableComponents(failingRoot).map(dirname)
    expect(failedSyncs).toEqual(failingExpected.slice(0, failingExpected.indexOf(failingParent) + 1))
    await expect(access(join(failingRoot, DATABASE_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('flushes every parent when a competing creator wins all EEXIST directory races', async () => {
    const base = await temporaryRoot()
    const root = join(base, 'competing', 'claims')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const mkdirAttempts: string[] = []
    const synced: string[] = []
    const fileSystem: ContinuationStoreFileSystem = {
      mkdir: async (path) => {
        mkdirAttempts.push(path)
        await mkdir(path, { mode: 0o700 })
      },
      stat: path => stat(path),
      lstat: path => lstat(path),
      syncDirectory: (path) => {
        synced.push(path)
        return Promise.resolve()
      },
    }
    const store = track(new DurableTaskContinuationStore(root, 1_000, fileSystem))
    await store.initialize()
    const components = durableComponents(root)
    expect(mkdirAttempts).toEqual(components)
    expect(synced).toEqual(components.map(dirname))
    await expect(access(join(root, DATABASE_FILE))).resolves.toBeUndefined()
  })

  it('accepts only documented Windows directory-handle limitations during first initialization', async () => {
    const base = await temporaryRoot()
    const fileSystemFor = (code: string): ContinuationStoreFileSystem => realFileSystem(
      () => Promise.reject(Object.assign(new Error(`directory sync ${code}`), { code })),
    )

    for (const code of ['EACCES', 'EINVAL', 'ENOTSUP', 'EPERM']) {
      const root = join(base, `windows-${code}`)
      const store = track(new DurableTaskContinuationStore(root, 1_000, fileSystemFor(code), 'win32'))
      await expect(store.initialize()).resolves.toBeUndefined()
      await expect(access(join(root, DATABASE_FILE))).resolves.toBeUndefined()
    }

    for (const [platform, code] of [['linux', 'EINVAL'], ['win32', 'EIO']] as const) {
      const root = join(base, `${platform}-${code}`)
      const store = track(new DurableTaskContinuationStore(root, 1_000, fileSystemFor(code), platform))
      await expect(store.initialize()).rejects.toMatchObject({ code })
      await expect(access(join(root, DATABASE_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('detects absence and reopens existing durable state without creating it', async () => {
    const root = await temporaryRoot()
    const absent = track(new DurableTaskContinuationStore(root, 1_000))
    await expect(absent.initializeIfPresent()).resolves.toBe(false)
    await absent.close()

    const creator = track(new DurableTaskContinuationStore(root, 1_000))
    await creator.initialize()
    await creator.close()

    const existing = track(new DurableTaskContinuationStore(root, 1_000))
    await expect(existing.initializeIfPresent()).resolves.toBe(true)

    const fileRoot = join(await temporaryRoot(), 'not-a-directory')
    await writeFile(fileRoot, 'file')
    const invalid = track(new DurableTaskContinuationStore(fileRoot, 1_000))
    await expect(invalid.initializeIfPresent()).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('terminalizes close while an open is in flight and prevents post-close publication', async () => {
    const root = await temporaryRoot()
    const began = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let blocked = false
    const fileSystem: ContinuationStoreFileSystem = {
      mkdir: path => mkdir(path, { mode: 0o700 }),
      stat: path => stat(path),
      lstat: async (path) => {
        if (path === root && !blocked) {
          blocked = true
          began.resolve(undefined)
          await release.promise
        }
        return lstat(path)
      },
      syncDirectory: () => Promise.resolve(),
    }
    const store = track(new DurableTaskContinuationStore(root, 1_000, fileSystem))
    const closeDatabase = vi.spyOn(DatabaseSync.prototype, 'close')
    const initializing = store.initialize()
    const initialization = expect(initializing).rejects.toThrow('task continuation store is closed')
    await began.promise

    let settled = false
    const closing = store.close()
    const observedClose = closing.then(
      () => { settled = true },
      () => { settled = true },
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    release.resolve(undefined)
    await initialization
    await expect(closing).resolves.toBeUndefined()
    await observedClose
    expect(closeDatabase).toHaveBeenCalledOnce()
    await expect(store.initialize()).rejects.toThrow('task continuation store is closed')
    await expect(store.initializeIfPresent()).rejects.toThrow('task continuation store is closed')
    await expect(store.list()).rejects.toThrow('task continuation store is closed')
    await expect(store.close()).resolves.toBeUndefined()
  })

  it('waits for and surfaces a real in-flight open failure during close', async () => {
    const root = await temporaryRoot()
    const began = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const openFailure = new Error('continuation open failed during close')
    let blocked = false
    const fileSystem: ContinuationStoreFileSystem = {
      mkdir: path => mkdir(path, { mode: 0o700 }),
      stat: path => stat(path),
      lstat: async (path) => {
        if (path === root && !blocked) {
          blocked = true
          began.resolve(undefined)
          await release.promise
        }
        return lstat(path)
      },
      syncDirectory: () => Promise.resolve(),
    }
    const store = new DurableTaskContinuationStore(root, 1_000, fileSystem)
    const initializing = store.initialize()
    const initialization = expect(initializing).rejects.toBe(openFailure)
    await began.promise
    const closing = store.close()
    const closed = expect(closing).rejects.toBe(openFailure)

    release.reject(openFailure)
    await initialization
    await closed
    await expect(store.initialize()).rejects.toThrow('task continuation store is closed')
  })

  it('rejects non-directory roots and non-file database entries', async () => {
    const target = await temporaryRoot('dsh-continuation-store-target-')
    const linkParent = await temporaryRoot('dsh-continuation-store-link-parent-')
    const link = join(linkParent, 'root-link')
    await symlink(target, link)
    const linked = track(new DurableTaskContinuationStore(link, 1_000))
    await expect(linked.initialize()).rejects.toThrow('root must be a real directory')

    const directoryRoot = await temporaryRoot()
    await mkdir(join(directoryRoot, DATABASE_FILE))
    const directoryDatabase = track(new DurableTaskContinuationStore(directoryRoot, 1_000))
    await expect(directoryDatabase.initialize()).rejects.toThrow('database must be a regular file')

    const malformedRoot = await temporaryRoot()
    await writeFile(join(malformedRoot, DATABASE_FILE), 'not sqlite')
    const malformed = track(new DurableTaskContinuationStore(malformedRoot, 1_000))
    await expect(malformed.initialize()).rejects.toThrow()
  })

  it('rejects non-directory ancestry, mkdir faults, and a root replaced during publication', async () => {
    const base = await temporaryRoot()
    const blocked = join(base, 'blocked')
    const blockedRoot = join(blocked, 'claims')
    await writeFile(blocked, 'not a directory')
    await expect(track(new DurableTaskContinuationStore(blockedRoot, 1_000)).initialize())
      .rejects.toThrow(`durable directory component is not a directory: ${blocked}`)

    const mkdirFailure = Object.assign(new Error('mkdir denied'), { code: 'EACCES' })
    const deniedFileSystem: ContinuationStoreFileSystem = {
      mkdir: () => Promise.reject(mkdirFailure),
      stat: vi.fn(),
      lstat: vi.fn(),
      syncDirectory: vi.fn(),
    }
    await expect(track(new DurableTaskContinuationStore(join(base, 'denied'), 1_000, deniedFileSystem)).initialize())
      .rejects.toBe(mkdirFailure)

    const swappedRoot = join(base, 'swapped')
    const swappedFileSystem: ContinuationStoreFileSystem = {
      mkdir: () => Promise.resolve(),
      stat: vi.fn(),
      lstat: () => Promise.resolve({ isDirectory: () => false, isFile: () => true }),
      syncDirectory: () => Promise.resolve(),
    }
    await expect(track(new DurableTaskContinuationStore(swappedRoot, 1_000, swappedFileSystem)).initialize())
      .rejects.toThrow(`root must be a real directory: ${swappedRoot}`)
  })

  it('strictly rejects application, version, and object-schema mismatches', async () => {
    const cases: Array<(database: DatabaseSync) => void> = [
      (database) => {
        database.exec('PRAGMA application_id = 1')
        database.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
      },
      (database) => {
        database.exec(`PRAGMA application_id = ${String(APPLICATION_ID)}`)
        database.exec('PRAGMA user_version = 1')
      },
      (database) => {
        database.exec('CREATE TABLE preexisting (value)')
      },
      (database) => {
        database.exec('CREATE TABLE unexpected (value)')
        database.exec(`PRAGMA application_id = ${String(APPLICATION_ID)}`)
        database.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
      },
      (database) => {
        database.exec(`PRAGMA application_id = ${String(APPLICATION_ID)}`)
        database.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
      },
    ]
    for (const configure of cases) {
      const root = await temporaryRoot()
      const database = createRawDatabase(root)
      configure(database)
      database.close()
      const store = track(new DurableTaskContinuationStore(root, 1_000))
      await expect(store.initialize()).rejects.toBeInstanceOf(TaskContinuationStoreCorruptionError)
      await expect(store.initialize()).rejects.toMatchObject({ code: 'TASK_CONTINUATION_STORE_CORRUPT' })
    }
  })

  it('rejects loose and extra claims schemas carrying the current version', async () => {
    const looseRoot = await temporaryRoot()
    const loose = createRawDatabase(looseRoot)
    looseClaimsSchema(loose)
    loose.close()
    await expect(track(new DurableTaskContinuationStore(looseRoot, 1_000)).initialize())
      .rejects.toBeInstanceOf(TaskContinuationStoreCorruptionError)

    const extraRoot = await temporaryRoot()
    const creator = track(new DurableTaskContinuationStore(extraRoot, 1_000))
    await creator.initialize()
    await creator.close()
    const extra = createRawDatabase(extraRoot)
    extra.exec('ALTER TABLE claims ADD COLUMN extra TEXT')
    extra.close()
    await expect(track(new DurableTaskContinuationStore(extraRoot, 1_000)).initialize())
      .rejects.toBeInstanceOf(TaskContinuationStoreCorruptionError)
  })

  it('rolls back interrupted schema initialization and retries the failed open on the same live store', async () => {
    const root = await temporaryRoot()
    const exec: unknown = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'exec')?.value
    if (typeof exec !== 'function') throw new Error('DatabaseSync.exec is unavailable')
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('PRAGMA user_version = ')) throw new Error('schema initialization interrupted')
      Reflect.apply(exec, this, [sql])
    })
    const interrupted = track(new DurableTaskContinuationStore(root, 1_000))
    await expect(interrupted.initialize()).rejects.toThrow('schema initialization interrupted')
    vi.restoreAllMocks()

    const database = createRawDatabase(root)
    expect(database.prepare('PRAGMA application_id').get()).toEqual(expect.objectContaining({ application_id: 0 }))
    expect(database.prepare('PRAGMA user_version').get()).toEqual(expect.objectContaining({ user_version: 0 }))
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'claims'").get()).toBeUndefined()
    database.close()

    await expect(interrupted.initialize()).resolves.toBeUndefined()
    await expect(interrupted.create(record())).resolves.toMatchObject({ state: 'pending' })
  })

  it('rejects state-revision tampering in both the strict schema and reopen row validation', async () => {
    const root = await temporaryRoot()
    const creator = track(new DurableTaskContinuationStore(root, 1_000))
    await creator.create(record())
    await creator.close()
    const strict = createRawDatabase(root)
    expect(() => { strict.exec("UPDATE claims SET state = 'claimed' WHERE state = 'pending'") })
      .toThrow(/CHECK constraint failed/)
    strict.exec('PRAGMA ignore_check_constraints = ON')
    strict.exec("UPDATE claims SET state = 'claimed' WHERE state = 'pending'")
    strict.close()

    const reopened = track(new DurableTaskContinuationStore(root, 1_000))
    await expect(reopened.initialize()).rejects.toBeInstanceOf(TaskContinuationStoreCorruptionError)
    await expect(reopened.initialize()).rejects.toMatchObject({ code: 'TASK_CONTINUATION_STORE_CORRUPT' })
  })

  it('validates impossible PRAGMA result types at the SQLite adapter seam', async () => {
    for (const pragmaValue of [undefined, { application_id: 'bad' }, { application_id: BigInt(APPLICATION_ID) }]) {
      const root = await temporaryRoot()
      vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementationOnce(() => (
        { get: () => pragmaValue } as unknown as ReturnType<DatabaseSync['prepare']>
      ))
      const store = track(new DurableTaskContinuationStore(root, 1_000))
      await expect(store.initialize()).rejects.toBeInstanceOf(TaskContinuationStoreCorruptionError)
      vi.restoreAllMocks()
    }
  })

  it('reserves caller mutations idempotently across concurrent stores', async () => {
    const root = await temporaryRoot()
    const first = track(new DurableTaskContinuationStore(root, 1_000))
    const second = track(new DurableTaskContinuationStore(root, 1_000))
    await Promise.all([first.initialize(), second.initialize()])

    const reservations = await Promise.all([first.createOrGet(record()), second.createOrGet(record())])
    expect(reservations.map(reservation => reservation.created).sort()).toEqual([false, true])
    expect(reservations[0]?.claim).toEqual(reservations[1]?.claim)
    await expect(first.getByMutation('extension-center', 'operation-3'))
      .resolves.toMatchObject({ continuationId: record().continuationId })
    await expect(first.getByMutation('missing', 'missing')).resolves.toBeUndefined()
    await expect(first.get(continuationId('44444444-4444-4444-8444-444444444444')))
      .resolves.toBeUndefined()
    await expect(first.list()).resolves.toHaveLength(1)
    await expect(first.create(record())).rejects.toThrow('already exists')
  })

  it('validates every durable dispatch-lease fence and write failure', async () => {
    const root = await temporaryRoot()
    const store = track(new DurableTaskContinuationStore(root, 1_000))
    const pending = await store.create(record())
    const ready = await store.transition({
      id: pending.continuationId,
      from: ['pending'],
      to: 'ready',
      updatedAtMs: 11,
    })
    if (ready === undefined) throw new Error('ready fixture transition lost')
    const consumed = await store.transition({
      id: ready.continuationId,
      from: ['ready'],
      to: 'consumed',
      updatedAtMs: 12,
    })
    if (consumed === undefined) throw new Error('consumed fixture transition lost')
    const missing = Object.freeze({
      ...consumed,
      continuationId: continuationId('12121212-1212-4212-8212-121212121212'),
    })

    await expect(store.acquireDispatchLease(consumed, '', 20, 120)).rejects.toThrow('owner must be non-empty')
    const invalidLeases: ReadonlyArray<readonly [number, number]> = [
      [-1, 120],
      [20.5, 120],
      [20, 20],
      [20, Number.NaN],
    ]
    for (const [nowMs, expiresAtMs] of invalidLeases) {
      await expect(store.acquireDispatchLease(consumed, 'host-a', nowMs, expiresAtMs))
        .rejects.toThrow('increasing safe epoch milliseconds')
    }
    await expect(store.acquireDispatchLease(missing, 'host-a', 20, 120)).resolves.toBeUndefined()
    await expect(store.claimDispatch(missing, {
      continuationId: missing.continuationId,
      recordRevision: missing.recordRevision,
      ownerId: 'host-a',
      incarnation: 1,
      expiresAtMs: 120,
    }, 30)).resolves.toBeUndefined()

    const firstLease = await store.acquireDispatchLease(consumed, 'host-a', 20, 120)
    if (firstLease === undefined) throw new Error('first lease fixture lost')
    await expect(store.getDispatchLeaseExpiry(consumed)).resolves.toBe(120)
    await expect(store.getDispatchLeaseExpiry({ ...consumed, recordRevision: 99 })).resolves.toBeUndefined()
    await expect(store.getDispatchLeaseExpiry(missing)).resolves.toBeUndefined()
    const sameOwner = await store.acquireDispatchLease(consumed, 'host-a', 30, 130)
    expect(sameOwner).toMatchObject({ incarnation: firstLease.incarnation, expiresAtMs: 130 })
    if (sameOwner === undefined) throw new Error('same-owner lease fixture lost')
    for (const nowMs of [-1, 1.5, Number.NaN]) {
      await expect(store.holdsDispatchLease(sameOwner, nowMs)).rejects.toThrow('non-negative safe integer')
    }
    for (const expiresAtMs of [0, -1, 1.5, Number.NaN]) {
      await expect(store.renewDispatchLease(sameOwner, expiresAtMs)).rejects.toThrow('positive safe integer')
    }
    await expect(store.releaseDispatchLease(sameOwner)).resolves.toBe(true)
    await expect(store.getDispatchLeaseExpiry(consumed)).resolves.toBeUndefined()
    await expect(store.claimDispatch(consumed, sameOwner, 40)).resolves.toBeUndefined()
    await expect(store.claimDispatch(consumed, sameOwner, -1)).rejects.toThrow('non-negative safe integer')

    const liveLease = await store.acquireDispatchLease(consumed, 'host-a', 40, 140)
    if (liveLease === undefined) throw new Error('live lease fixture lost')
    const ignored = createRawDatabase(root)
    ignored.exec(`CREATE TRIGGER ignore_lease_update BEFORE UPDATE ON claims
      BEGIN SELECT RAISE(IGNORE); END`)
    ignored.close()
    await expect(store.acquireDispatchLease(consumed, 'host-a', 50, 150)).resolves.toBeUndefined()
    await expect(store.renewDispatchLease(liveLease, 150)).resolves.toBeUndefined()
    await expect(store.releaseDispatchLease(liveLease)).resolves.toBe(false)
    await expect(store.claimDispatch(consumed, liveLease, 50)).resolves.toBeUndefined()
    const dropIgnored = createRawDatabase(root)
    dropIgnored.exec('DROP TRIGGER ignore_lease_update')
    dropIgnored.close()

    const failed = createRawDatabase(root)
    failed.exec(`CREATE TRIGGER fail_lease_update BEFORE UPDATE ON claims
      BEGIN SELECT RAISE(ABORT, 'lease write failed'); END`)
    failed.close()
    await expect(store.acquireDispatchLease(consumed, 'host-a', 50, 150)).rejects.toThrow('lease write failed')
    await expect(store.renewDispatchLease(liveLease, 150)).rejects.toThrow('lease write failed')
    await expect(store.releaseDispatchLease(liveLease)).rejects.toThrow('lease write failed')
    await expect(store.claimDispatch(consumed, liveLease, 50)).rejects.toThrow('lease write failed')
  })

  it('decodes bigint and non-record dispatch lease query results', async () => {
    const lease = {
      continuationId: record().continuationId,
      recordRevision: 2,
      ownerId: 'host-a',
      incarnation: 1,
      expiresAtMs: 120,
    }
    const bigint = storeWithFakeRow({ dispatch_lease_expires_at_ms: 120n })
    await expect(bigint.holdsDispatchLease(lease, 119)).resolves.toBe(true)
    const missing = storeWithFakeRow(null)
    await expect(missing.holdsDispatchLease(lease, 119)).resolves.toBe(false)

    const bigintRow = storeWithFakeRow(row({
      state: 'consumed',
      record_revision: 2,
      dispatch_owner_id: 'host-a',
      dispatch_incarnation: 1,
      dispatch_lease_expires_at_ms: 120n,
    }))
    const decoded = await bigintRow.get(record().continuationId)
    if (decoded === undefined) throw new Error('bigint lease fixture disappeared')
    await expect(bigintRow.getDispatchLeaseExpiry(decoded)).resolves.toBe(120)
  })

  it('rejects every immutable caller-key replay mismatch and preserves ignored live fields', async () => {
    const root = await temporaryRoot()
    const store = track(new DurableTaskContinuationStore(root, 1_000))
    await store.create(record())
    const conflicts: NewContinuationRecord[] = [
      record({ sessionId: SessionId('different-session') }),
      record({ originalMessageId: MessageId('different-message') }),
      record({ needDigest: continuationDigest(`sha256:${'c'.repeat(64)}`) }),
      record({ taskRevision: taskContinuationRevision('different-revision') }),
      record({ verifierId: taskContinuationVerifierId('different-verifier') }),
      record({ verificationPayloadDigest: continuationDigest(`sha256:${'d'.repeat(64)}`) }),
      record({ expiresAtMs: 20_000 }),
      record({ resumeAgentOptions: { provider: 'other', model: 'mock', maxTokens: 512 } }),
      record({ resumeAgentOptions: { provider: 'mock', model: 'other', maxTokens: 512 } }),
      record({ resumeAgentOptions: { provider: 'mock', model: 'mock', maxTokens: 1024 } }),
    ]
    for (const conflict of conflicts) {
      await expect(store.createOrGet(conflict)).rejects.toBeInstanceOf(TaskContinuationMutationConflictError)
    }

    const replay = await store.createOrGet(record({
      continuationId: continuationId('55555555-5555-4555-8555-555555555555'),
      dispatchMessageId: MessageId('different-dispatch'),
      createdAtMs: 99,
    }))
    expect(replay).toMatchObject({ created: false, claim: { continuationId: record().continuationId } })

    await expect(store.create(record({
      mutationId: taskContinuationMutationId('other-mutation'),
    }))).rejects.toThrow()
  })

  it('covers lookup-key corruption that a real UNIQUE index cannot return', async () => {
    const mismatches = [
      { caller_id: 'other-caller' },
      { mutation_id: 'other-mutation' },
    ]
    for (const mismatch of mismatches) {
      const store = storeWithFakeRow(row(mismatch))
      await expect(store.createOrGet(record())).rejects.toBeInstanceOf(TaskContinuationMutationConflictError)
    }
  })

  it('persists empty resume routes and orders records deterministically', async () => {
    const root = await temporaryRoot()
    const store = track(new DurableTaskContinuationStore(root, 1_000))
    const later = record({
      continuationId: continuationId('66666666-6666-4666-8666-666666666666'),
      mutationId: taskContinuationMutationId('later'),
      resumeAgentOptions: {},
      createdAtMs: 20,
    })
    const earlier = record({
      continuationId: continuationId('77777777-7777-4777-8777-777777777777'),
      mutationId: taskContinuationMutationId('earlier'),
      resumeAgentOptions: {},
      createdAtMs: 10,
    })
    await store.create(later)
    await store.create(earlier)
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ mutationId: 'earlier', resumeAgentOptions: {} }),
      expect.objectContaining({ mutationId: 'later', resumeAgentOptions: {} }),
    ])
  })

  it('applies every transition fence and terminal replacement form', async () => {
    const root = await temporaryRoot()
    const store = track(new DurableTaskContinuationStore(root, 1_000))
    const pending = await store.create(record())
    await expect(store.transition({
      id: continuationId('88888888-8888-4888-8888-888888888888'),
      from: ['pending'],
      to: 'ready',
      updatedAtMs: 11,
    })).resolves.toBeUndefined()
    await expect(store.transition({ id: pending.continuationId, from: ['ready'], to: 'consumed', updatedAtMs: 11 }))
      .resolves.toBeUndefined()
    await expect(store.transition({
      id: pending.continuationId,
      from: ['pending'],
      to: 'ready',
      expectedRecordRevision: 1,
      updatedAtMs: 11,
    })).resolves.toBeUndefined()
    await expect(store.transition({
      id: pending.continuationId,
      from: ['pending'],
      to: 'ready',
      expectedRecordRevision: 0,
      expectedSessionId: SessionId('wrong'),
      updatedAtMs: 11,
    })).resolves.toBeUndefined()
    await expect(store.transition({
      id: pending.continuationId,
      from: ['pending'],
      to: 'ready',
      expectedRecordRevision: 0,
      expectedSessionId: pending.sessionId,
      expectedTaskRevision: taskContinuationRevision('wrong'),
      updatedAtMs: 11,
    })).resolves.toBeUndefined()

    const ready = await store.transition({
      id: pending.continuationId,
      from: ['pending'],
      to: 'ready',
      expectedRecordRevision: 0,
      expectedSessionId: pending.sessionId,
      expectedTaskRevision: pending.taskRevision,
      updatedAtMs: 11,
    })
    const consumed = await store.transition({
      id: pending.continuationId,
      from: ['ready'],
      to: 'consumed',
      updatedAtMs: 12,
    })
    await expect(store.transition({
      id: pending.continuationId,
      from: ['consumed'],
      to: 'claimed',
      updatedAtMs: 13,
    })).resolves.toMatchObject({ state: 'claimed', recordRevision: 3 })
    expect(ready).toMatchObject({ state: 'ready' })
    expect(consumed).toMatchObject({ state: 'consumed' })

    const supersededInput = record({
      continuationId: continuationId('99999999-9999-4999-8999-999999999999'),
      mutationId: taskContinuationMutationId('superseded'),
    })
    await store.create(supersededInput)
    await expect(store.transition({
      id: supersededInput.continuationId,
      from: ['pending'],
      to: 'superseded',
      supersededByTaskRevision: taskContinuationRevision('replacement'),
      updatedAtMs: 14,
    })).resolves.toMatchObject({ state: 'superseded', supersededByTaskRevision: 'replacement' })

    const missingReplacement = record({
      continuationId: continuationId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      mutationId: taskContinuationMutationId('missing-replacement'),
    })
    await store.create(missingReplacement)
    await expect(store.transition({
      id: missingReplacement.continuationId,
      from: ['pending'],
      to: 'superseded',
      updatedAtMs: 15,
    })).rejects.toThrow('task revision must be')
  })

  it('clamps rollback-prone wall-clock updates and handles a real zero-change update', async () => {
    const root = await temporaryRoot()
    const store = track(new DurableTaskContinuationStore(root, 1_000))
    const pending = await store.create(record())
    await expect(store.transition({
      id: pending.continuationId,
      from: ['pending'],
      to: 'ready',
      updatedAtMs: 9,
    })).resolves.toMatchObject({ state: 'ready', recordRevision: 1, updatedAtMs: 10 })

    const external = createRawDatabase(root)
    external.exec(`CREATE TRIGGER ignore_claim_update BEFORE UPDATE ON claims
      BEGIN SELECT RAISE(IGNORE); END`)
    external.close()
    await expect(store.transition({
      id: pending.continuationId,
      from: ['ready'],
      to: 'consumed',
      updatedAtMs: 11,
    })).resolves.toBeUndefined()
    await expect(store.get(pending.continuationId)).resolves.toMatchObject({ state: 'ready', recordRevision: 1 })
  })

  it('rejects invalid transitions after decoding terminal records', async () => {
    const root = await temporaryRoot()
    const store = track(new DurableTaskContinuationStore(root, 1_000))
    const pending = await store.create(record())
    await store.transition({ id: pending.continuationId, from: ['pending'], to: 'canceled', updatedAtMs: 11 })
    await expect(store.transition({
      id: pending.continuationId,
      from: ['canceled'],
      to: 'expired',
      updatedAtMs: 12,
    })).rejects.toThrow('invalid task continuation transition')
  })

  it('strictly decodes valid superseded, empty-route, and bigint adapter rows', async () => {
    const superseded = await storeWithLooseRow(row({
      state: 'superseded',
      record_revision: 1,
      superseded_by_task_revision: 'replacement',
      agent_provider: null,
      agent_model: null,
      agent_max_tokens: null,
    }))
    await expect(superseded.get(record().continuationId)).resolves.toMatchObject({
      state: 'superseded',
      supersededByTaskRevision: taskContinuationRevision('replacement'),
      resumeAgentOptions: {},
    } satisfies Partial<TaskContinuationClaim>)

    const bigint = storeWithFakeRow(row({
      record_revision: 0n,
      agent_max_tokens: 512n,
    }))
    await expect(bigint.get(record().continuationId)).resolves.toMatchObject({
      recordRevision: 0,
      resumeAgentOptions: { maxTokens: 512 },
    })

    const leased = await storeWithLooseRow(row({
      state: 'consumed',
      record_revision: 2,
      dispatch_owner_id: 'host-a',
      dispatch_incarnation: 1n,
      dispatch_lease_expires_at_ms: 120n,
    }))
    await expect(leased.list()).resolves.toEqual([expect.objectContaining({ state: 'consumed' })])
  })

  it('wraps every externally representable corrupt row class', async () => {
    const corruptRows: Record<string, unknown>[] = [
      row({ state: 'unknown' }),
      row({ state: 'superseded', superseded_by_task_revision: null }),
      row({ superseded_by_task_revision: 'unexpected' }),
      row({ continuation_id: 3 }),
      row({ dispatch_message_id: '' }),
      row({ record_revision: -1 }),
      row({ record_revision: 'invalid' }),
      row({ state: 'pending', record_revision: 3 }),
      row({ state: 'ready', record_revision: 0 }),
      row({ state: 'consumed', record_revision: 99 }),
      row({ state: 'claimed', record_revision: 0 }),
      row({ state: 'canceled', record_revision: 0 }),
      row({ state: 'consumed', record_revision: 2, dispatch_owner_id: '', dispatch_lease_expires_at_ms: 20 }),
      row({ state: 'consumed', record_revision: 2, dispatch_owner_id: 3, dispatch_lease_expires_at_ms: 20 }),
      row({ state: 'consumed', record_revision: 2, dispatch_owner_id: 'host', dispatch_lease_expires_at_ms: '20' }),
      row({ state: 'consumed', record_revision: 2, dispatch_owner_id: 'host', dispatch_lease_expires_at_ms: -1 }),
      row({ state: 'ready', record_revision: 1, dispatch_owner_id: 'host', dispatch_lease_expires_at_ms: 20 }),
      row({ updated_at_ms: 9 }),
      row({ agent_provider: 3 }),
      row({ agent_provider: '' }),
      row({ agent_model: 3 }),
      row({ agent_model: '' }),
      row({ agent_max_tokens: 'invalid' }),
      row({ agent_max_tokens: -1 }),
      row({ agent_max_tokens: 1_000_001 }),
    ]
    for (const corruptRow of corruptRows) {
      const store = await storeWithLooseRow(corruptRow)
      try {
        await store.list()
        expect.unreachable('corrupt row was accepted')
      } catch (error: unknown) {
        expect(error).toMatchObject({ code: 'TASK_CONTINUATION_STORE_CORRUPT' })
        expect((error as Error).cause).toBeInstanceOf(Error)
      }
    }
  })

  it('defends against non-record rows that SQLite statements cannot produce', async () => {
    for (const value of ['not-a-record', null, []]) {
      const store = storeWithFakeRow(value)
      await expect(store.get(record().continuationId)).rejects.toBeInstanceOf(TaskContinuationStoreCorruptionError)
    }
  })

  it('rejects initialization and reads after the process-owned connection is closed', async () => {
    const root = await temporaryRoot()
    const store = track(new DurableTaskContinuationStore(root, 1_000))
    await store.initialize()
    await store.close()
    await expect(store.initialize()).rejects.toThrow('store is closed')
    await expect(store.get(record().continuationId)).rejects.toThrow('store is closed')
  })
})
