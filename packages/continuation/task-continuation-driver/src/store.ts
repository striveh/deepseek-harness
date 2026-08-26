/** SQLite-backed atomic claim records for task-continuation recovery. @module @deepseek-ai/dsh-task-continuation-driver/src/store */

import { lstat, mkdir, open, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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
  type ContinuationId,
  type TaskContinuationClaim,
  type TaskContinuationRevision,
  type TaskContinuationState,
} from '@deepseek-ai/dsh-task-continuation'
import {
  normalizeContinuationAgentOptions,
  sameContinuationAgentOptions,
} from './options.ts'

const APPLICATION_ID = 0x44544331
const SCHEMA_VERSION = 4
const DATABASE_FILE = 'claims.sqlite'
const ACTIVE_STATES: readonly TaskContinuationState[] = ['pending', 'ready', 'consumed']
const ALL_STATES: readonly TaskContinuationState[] = [
  ...ACTIVE_STATES,
  'claimed',
  'canceled',
  'superseded',
  'expired',
  'invalid',
]

const CLAIMS_CREATE_SQL = `CREATE TABLE claims (
  continuation_id TEXT PRIMARY KEY NOT NULL,
  caller_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending','ready','consumed','claimed','canceled','superseded','expired','invalid')),
  dispatch_message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  original_message_id TEXT NOT NULL,
  need_digest TEXT NOT NULL,
  task_revision TEXT NOT NULL,
  verifier_id TEXT NOT NULL,
  verification_payload_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
  agent_provider TEXT,
  agent_model TEXT,
  agent_max_tokens INTEGER CHECK (agent_max_tokens IS NULL OR agent_max_tokens > 0),
  superseded_by_task_revision TEXT,
  dispatch_owner_id TEXT,
  dispatch_incarnation INTEGER NOT NULL CHECK (dispatch_incarnation >= 0),
  dispatch_lease_expires_at_ms INTEGER CHECK (dispatch_lease_expires_at_ms IS NULL OR dispatch_lease_expires_at_ms >= 0),
  UNIQUE (caller_id, mutation_id),
  CHECK (
    (state = 'pending' AND record_revision = 0)
    OR (state = 'ready' AND record_revision = 1)
    OR (state = 'consumed' AND record_revision = 2)
    OR (state = 'claimed' AND record_revision = 3)
    OR (state IN ('canceled','superseded','expired','invalid') AND record_revision BETWEEN 1 AND 3)
  ),
  CHECK ((state = 'superseded') = (superseded_by_task_revision IS NOT NULL)),
  CHECK ((dispatch_owner_id IS NULL) = (dispatch_lease_expires_at_ms IS NULL)),
  CHECK (dispatch_owner_id IS NULL OR (dispatch_owner_id <> '' AND state = 'consumed'))
) STRICT`

const CLAIM_COLUMNS = [
  ['continuation_id', 'TEXT', 1, 1],
  ['caller_id', 'TEXT', 1, 0],
  ['mutation_id', 'TEXT', 1, 0],
  ['record_revision', 'INTEGER', 1, 0],
  ['state', 'TEXT', 1, 0],
  ['dispatch_message_id', 'TEXT', 1, 0],
  ['session_id', 'TEXT', 1, 0],
  ['original_message_id', 'TEXT', 1, 0],
  ['need_digest', 'TEXT', 1, 0],
  ['task_revision', 'TEXT', 1, 0],
  ['verifier_id', 'TEXT', 1, 0],
  ['verification_payload_digest', 'TEXT', 1, 0],
  ['created_at_ms', 'INTEGER', 1, 0],
  ['updated_at_ms', 'INTEGER', 1, 0],
  ['expires_at_ms', 'INTEGER', 1, 0],
  ['agent_provider', 'TEXT', 0, 0],
  ['agent_model', 'TEXT', 0, 0],
  ['agent_max_tokens', 'INTEGER', 0, 0],
  ['superseded_by_task_revision', 'TEXT', 0, 0],
  ['dispatch_owner_id', 'TEXT', 0, 0],
  ['dispatch_incarnation', 'INTEGER', 1, 0],
  ['dispatch_lease_expires_at_ms', 'INTEGER', 0, 0],
].map(([name, type, notnull, pk], cid) => ({ cid, name, type, notnull, dflt_value: null, pk, hidden: 0 }))

const CLAIM_INDEXES = [
  { seq: 0, name: 'sqlite_autoindex_claims_2', unique: 1, origin: 'u', partial: 0 },
  { seq: 1, name: 'sqlite_autoindex_claims_1', unique: 1, origin: 'pk', partial: 0 },
]

const CLAIM_MUTATION_INDEX = [
  { seqno: 0, cid: 1, name: 'caller_id', desc: 0, coll: 'BINARY', key: 1 },
  { seqno: 1, cid: 2, name: 'mutation_id', desc: 0, coll: 'BINARY', key: 1 },
  { seqno: 2, cid: -1, name: null, desc: 0, coll: 'BINARY', key: 0 },
]

const CLAIM_PRIMARY_INDEX = [
  { seqno: 0, cid: 0, name: 'continuation_id', desc: 0, coll: 'BINARY', key: 1 },
  { seqno: 1, cid: -1, name: null, desc: 0, coll: 'BINARY', key: 0 },
]

type DatabaseSyncConstructor = typeof import('node:sqlite')['DatabaseSync']
type DatabaseSync = import('node:sqlite').DatabaseSync

/** Inputs used to create the first immutable record revision. */
export type NewContinuationRecord = Omit<TaskContinuationClaim, 'recordRevision' | 'state' | 'updatedAtMs'>

/** Result of an atomic caller-key reservation. */
export interface ContinuationReservation {
  readonly claim: TaskContinuationClaim
  readonly created: boolean
}

/** Atomic state transition with optional record and task fences. */
export interface ContinuationTransition {
  readonly id: ContinuationId
  readonly from: readonly TaskContinuationState[]
  readonly to: TaskContinuationState
  readonly updatedAtMs: number
  readonly expectedRecordRevision?: number
  readonly expectedSessionId?: SessionId
  readonly expectedTaskRevision?: TaskContinuationRevision
  readonly supersededByTaskRevision?: TaskContinuationRevision
}

/** Exact cross-process authority for one recoverable consumed dispatch. */
export interface ContinuationDispatchLease {
  readonly continuationId: ContinuationId
  readonly recordRevision: number
  readonly ownerId: string
  readonly incarnation: number
  readonly expiresAtMs: number
}

/** Private persisted lease metadata, including the last monotonic incarnation after release. */
interface StoredDispatchLease {
  readonly ownerId: string | undefined
  readonly incarnation: number
  readonly expiresAtMs: number | undefined
}

/** Filesystem operations whose ordering admits only a durably named store root. */
export interface ContinuationStoreFileSystem {
  /** Create exactly one directory without replacing an existing entry. */
  mkdir(path: string): Promise<void>
  /** Read one path while following its final symbolic link. */
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>
  /** Read one path without following its final symbolic link. */
  lstat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>
  /** Flush one directory's entries to stable storage. */
  syncDirectory(path: string): Promise<void>
}

const DEFAULT_FILE_SYSTEM: ContinuationStoreFileSystem = {
  mkdir: path => mkdir(path, { mode: 0o700 }),
  stat: path => stat(path),
  lstat: path => lstat(path),
  syncDirectory: async (path) => {
    const handle = await open(path, 'r')
    let primary: unknown
    try {
      await handle.sync()
    } catch (error: unknown) {
      primary = error
    }
    try {
      await handle.close()
    } catch (error: unknown) {
      if (primary !== undefined) {
        throw new AggregateError([primary, error], 'directory sync and close failed', { cause: primary })
      }
      throw error
    }
    if (primary instanceof Error) throw primary
    /* v8 ignore next -- Node FileHandle.sync rejects with Error; this normalizes nonconforming adapters. */
    if (primary !== undefined) throw new Error('directory sync failed', { cause: primary })
  },
}

/** Stable corruption error for a database row that violates the version-1 codec. */
export class TaskContinuationStoreCorruptionError extends Error {
  /** Stable machine-readable corruption code. */
  readonly code = 'TASK_CONTINUATION_STORE_CORRUPT'
}

/** Durable record store using one cross-process SQLite writer reservation per transition. */
export class DurableTaskContinuationStore {
  private readonly path: string
  private readonly closedError = new Error('task continuation store is closed')
  private database: DatabaseSync | undefined
  private opening: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private closed = false

  /**
   * @param root - configurable directory containing the continuation database.
   * @param busyTimeoutMs - maximum SQLite writer-reservation wait.
   * @param fileSystem - filesystem operations used for root admission and directory durability.
   * @param platform - platform used only to classify unsupported Windows directory flushes.
   */
  constructor(
    root: string,
    private readonly busyTimeoutMs: number,
    private readonly fileSystem: ContinuationStoreFileSystem = DEFAULT_FILE_SYSTEM,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.path = join(resolve(root), DATABASE_FILE)
  }

  /**
   * Open and strictly validate the versioned database unless this store has closed.
   * @returns fulfillment after schema and durability pragmas are active.
   */
  initialize(): Promise<void> {
    if (this.closed) return Promise.reject(this.closedError)
    if (this.opening !== undefined) return this.opening
    const opened: { current?: Promise<void> } = {}
    const opening = this.open().catch((error: unknown) => {
      /* v8 ignore else -- every concurrent initialize caller shares this exact in-flight promise. */
      if (this.opening === opened.current) this.opening = undefined
      throw error
    })
    opened.current = opening
    this.opening = opening
    return opening
  }

  /**
   * Open durable state only when a prior process already created it.
   * @returns whether an existing database was opened and validated.
   */
  async initializeIfPresent(): Promise<boolean> {
    if (this.closed) throw this.closedError
    try {
      await this.fileSystem.lstat(this.path)
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return false
      throw error
    }
    await this.initialize()
    return true
  }

  /**
   * Terminalize this store, drain any in-flight open, and close its process-owned connection.
   * @returns fulfillment after no open can publish another connection.
   */
  close(): Promise<void> {
    this.closed = true
    return (this.closing ??= this.finishClose())
  }

  /**
   * Insert a new pending claim without replacing an existing identity.
   * @param input - validated first-revision fields.
   * @returns the inserted immutable claim.
   */
  async create(input: NewContinuationRecord): Promise<TaskContinuationClaim> {
    const reserved = await this.createOrGet(input)
    if (!reserved.created) {
      throw new Error(`task continuation mutation "${input.callerId}/${input.mutationId}" already exists`)
    }
    return reserved.claim
  }

  /**
   * Atomically bind a caller key to one immutable record, or return its exact existing binding.
   * @param input - validated first-revision fields with a caller-scoped mutation key.
   * @returns the exact claim and whether this call inserted it.
   */
  async createOrGet(input: NewContinuationRecord): Promise<ContinuationReservation> {
    const database = await this.ready()
    const claim: TaskContinuationClaim = {
      ...input,
      recordRevision: 0,
      state: 'pending',
      updatedAtMs: input.createdAtMs,
    }
    database.exec('BEGIN IMMEDIATE')
    try {
      const existingRow = database.prepare(
        'SELECT * FROM claims WHERE caller_id = ? AND mutation_id = ?',
      ).get(input.callerId, input.mutationId)
      if (existingRow !== undefined) {
        const existing = decodeRow(existingRow)
        assertSameReservation(existing, input)
        database.exec('COMMIT')
        return { claim: existing, created: false }
      }
      database.prepare(`INSERT INTO claims (
        continuation_id, caller_id, mutation_id, record_revision, state, dispatch_message_id, session_id,
        original_message_id, need_digest, task_revision, verifier_id,
        verification_payload_digest, created_at_ms, updated_at_ms, expires_at_ms,
        agent_provider, agent_model, agent_max_tokens, superseded_by_task_revision,
        dispatch_owner_id, dispatch_incarnation, dispatch_lease_expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL)`).run(
        claim.continuationId,
        claim.callerId,
        claim.mutationId,
        claim.recordRevision,
        claim.state,
        claim.dispatchMessageId,
        claim.sessionId,
        claim.originalMessageId,
        claim.needDigest,
        claim.taskRevision,
        claim.verifierId,
        claim.verificationPayloadDigest,
        claim.createdAtMs,
        claim.updatedAtMs,
        claim.expiresAtMs,
        claim.resumeAgentOptions.provider ?? null,
        claim.resumeAgentOptions.model ?? null,
        claim.resumeAgentOptions.maxTokens ?? null,
      )
      database.exec('COMMIT')
      return { claim: Object.freeze(claim), created: true }
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Read one immutable claim.
   * @param id - continuation identity to locate.
   * @returns the decoded claim or `undefined`.
   */
  async get(id: ContinuationId): Promise<TaskContinuationClaim | undefined> {
    const database = await this.ready()
    const row = database.prepare('SELECT * FROM claims WHERE continuation_id = ?').get(id)
    return row === undefined ? undefined : decodeRow(row)
  }

  /**
   * Read one claim through its durable caller idempotency key.
   * @param callerId - stable caller namespace.
   * @param mutationId - caller-scoped mutation identity.
   * @returns the decoded claim, or `undefined` when unreserved.
   */
  async getByMutation(callerId: string, mutationId: string): Promise<TaskContinuationClaim | undefined> {
    const database = await this.ready()
    const row = database.prepare('SELECT * FROM claims WHERE caller_id = ? AND mutation_id = ?')
      .get(callerId, mutationId)
    return row === undefined ? undefined : decodeRow(row)
  }

  /**
   * Read every immutable claim in deterministic creation order.
   * @returns all decoded records.
   */
  async list(): Promise<readonly TaskContinuationClaim[]> {
    const database = await this.ready()
    return database.prepare('SELECT * FROM claims ORDER BY created_at_ms, continuation_id')
      .all().map(decodeRow)
  }

  /**
   * Read whether one Session still has any record capable of dispatch or recovery.
   * @param sessionId - exact Session identity whose active records are queried.
   * @returns whether at least one pending, ready, or consumed record exists.
   */
  async hasActiveForSession(sessionId: SessionId): Promise<boolean> {
    const database = await this.ready()
    return database.prepare(
      "SELECT 1 AS active FROM claims WHERE session_id = ? AND state IN ('pending','ready','consumed') LIMIT 1",
    ).get(sessionId) !== undefined
  }

  /**
   * Acquire or renew one consumed record's cross-process dispatch authority.
   * @param claim - exact consumed record revision to fence.
   * @param ownerId - process incarnation requesting authority.
   * @param nowMs - current epoch milliseconds used to judge expiry.
   * @param expiresAtMs - new exclusive lease deadline.
   * @returns the exact lease, or `undefined` while another live owner holds it.
   */
  async acquireDispatchLease(
    claim: TaskContinuationClaim,
    ownerId: string,
    nowMs: number,
    expiresAtMs: number,
  ): Promise<ContinuationDispatchLease | undefined> {
    assertLeaseInputs(ownerId, nowMs, expiresAtMs)
    const database = await this.ready()
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare('SELECT * FROM claims WHERE continuation_id = ?').get(claim.continuationId)
      if (row === undefined) {
        database.exec('ROLLBACK')
        return undefined
      }
      const current = decodeRow(row)
      const lease = decodeStoredDispatchLease(row)
      if (current.state !== 'consumed' || current.recordRevision !== claim.recordRevision
        || current.sessionId !== claim.sessionId || current.taskRevision !== claim.taskRevision
        || (lease.ownerId !== undefined && lease.ownerId !== ownerId
          && (lease.expiresAtMs ?? 0) > nowMs)) {
        database.exec('ROLLBACK')
        return undefined
      }
      const incarnation = lease.ownerId === ownerId ? lease.incarnation : lease.incarnation + 1
      const result = database.prepare(`UPDATE claims SET
        dispatch_owner_id = ?, dispatch_incarnation = ?, dispatch_lease_expires_at_ms = ?
        WHERE continuation_id = ? AND record_revision = ? AND state = 'consumed'`).run(
        ownerId,
        incarnation,
        expiresAtMs,
        claim.continuationId,
        claim.recordRevision,
      )
      if (Number(result.changes) !== 1) {
        database.exec('ROLLBACK')
        return undefined
      }
      database.exec('COMMIT')
      return Object.freeze({
        continuationId: claim.continuationId,
        recordRevision: claim.recordRevision,
        ownerId,
        incarnation,
        expiresAtMs,
      })
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Extend one exact lease without reviving lost authority.
   * @param lease - owner, incarnation, record, and continuation fences to renew.
   * @param expiresAtMs - requested positive exclusive deadline.
   * @returns the renewed lease, or `undefined` after any fence is lost.
   */
  async renewDispatchLease(
    lease: ContinuationDispatchLease,
    expiresAtMs: number,
  ): Promise<ContinuationDispatchLease | undefined> {
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
      throw new Error('task continuation dispatch lease deadline must be a positive safe integer')
    }
    const database = await this.ready()
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = database.prepare(`UPDATE claims
        SET dispatch_lease_expires_at_ms = MAX(dispatch_lease_expires_at_ms, ?)
        WHERE continuation_id = ? AND record_revision = ? AND state = 'consumed'
          AND dispatch_owner_id = ? AND dispatch_incarnation = ?`).run(
        expiresAtMs,
        lease.continuationId,
        lease.recordRevision,
        lease.ownerId,
        lease.incarnation,
      )
      if (Number(result.changes) !== 1) {
        database.exec('ROLLBACK')
        return undefined
      }
      database.exec('COMMIT')
      return Object.freeze({ ...lease, expiresAtMs })
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Read whether one unexpired exact lease remains authoritative.
   * @param lease - exact owner/incarnation and record fences to inspect.
   * @param nowMs - non-negative epoch milliseconds used to judge expiry.
   * @returns whether the same lease remains present and unexpired.
   */
  async holdsDispatchLease(lease: ContinuationDispatchLease, nowMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error('task continuation dispatch lease clock must be a non-negative safe integer')
    }
    const database = await this.ready()
    const row = database.prepare(`SELECT dispatch_lease_expires_at_ms FROM claims
      WHERE continuation_id = ? AND record_revision = ? AND state = 'consumed'
        AND dispatch_owner_id = ? AND dispatch_incarnation = ?`).get(
      lease.continuationId,
      lease.recordRevision,
      lease.ownerId,
      lease.incarnation,
    )
    if (!isRecord(row)) return false
    const expiresAtMs = row['dispatch_lease_expires_at_ms']
    const normalized = typeof expiresAtMs === 'bigint' ? Number(expiresAtMs) : expiresAtMs
    return Number.isSafeInteger(normalized) && (normalized as number) > nowMs
  }

  /**
   * Read another owner's exact lease deadline for one captured consumed record.
   * @param claim - exact consumed record whose competing deadline is requested.
   * @returns the stored deadline, or `undefined` when the record or lease no longer matches.
   */
  async getDispatchLeaseExpiry(claim: TaskContinuationClaim): Promise<number | undefined> {
    const database = await this.ready()
    const row = database.prepare('SELECT * FROM claims WHERE continuation_id = ?').get(claim.continuationId)
    if (row === undefined) return undefined
    const current = decodeRow(row)
    if (current.state !== 'consumed' || current.recordRevision !== claim.recordRevision
      || current.sessionId !== claim.sessionId || current.taskRevision !== claim.taskRevision) return undefined
    return decodeStoredDispatchLease(row).expiresAtMs
  }

  /**
   * Relinquish one exact lease without disturbing a newer takeover.
   * @param lease - exact owner/incarnation and record fences to release.
   * @returns whether this call removed the matching live lease.
   */
  async releaseDispatchLease(lease: ContinuationDispatchLease): Promise<boolean> {
    const database = await this.ready()
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = database.prepare(`UPDATE claims
        SET dispatch_owner_id = NULL, dispatch_lease_expires_at_ms = NULL
        WHERE continuation_id = ? AND record_revision = ? AND state = 'consumed'
          AND dispatch_owner_id = ? AND dispatch_incarnation = ?`).run(
        lease.continuationId,
        lease.recordRevision,
        lease.ownerId,
        lease.incarnation,
      )
      database.exec('COMMIT')
      return Number(result.changes) === 1
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Commit the at-most-once dispatch barrier before AgentLoop may invoke the model.
   * @param claim - exact consumed claim being admitted.
   * @param lease - exact process incarnation holding dispatch authority.
   * @param nowMs - current epoch milliseconds, which must precede lease expiry.
   * @returns the terminal claimed record, or `undefined` after any lost fence.
   */
  async claimDispatch(
    claim: TaskContinuationClaim,
    lease: ContinuationDispatchLease,
    nowMs: number,
  ): Promise<TaskContinuationClaim | undefined> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error('task continuation dispatch barrier clock must be a non-negative safe integer')
    }
    const database = await this.ready()
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare('SELECT * FROM claims WHERE continuation_id = ?').get(claim.continuationId)
      if (row === undefined) {
        database.exec('ROLLBACK')
        return undefined
      }
      const current = decodeRow(row)
      const storedLease = decodeStoredDispatchLease(row)
      if (current.state !== 'consumed' || current.recordRevision !== claim.recordRevision
        || current.sessionId !== claim.sessionId || current.taskRevision !== claim.taskRevision
        || lease.continuationId !== claim.continuationId || lease.recordRevision !== claim.recordRevision
        || storedLease.expiresAtMs === undefined || storedLease.expiresAtMs <= nowMs
        || storedLease.ownerId !== lease.ownerId || storedLease.incarnation !== lease.incarnation) {
        database.exec('ROLLBACK')
        return undefined
      }
      const updatedAtMs = Math.max(nowMs, current.updatedAtMs, current.createdAtMs)
      const result = database.prepare(`UPDATE claims SET
        record_revision = ?, state = 'claimed', updated_at_ms = ?,
        dispatch_owner_id = NULL, dispatch_lease_expires_at_ms = NULL
        WHERE continuation_id = ? AND record_revision = ? AND state = 'consumed'
          AND dispatch_owner_id = ? AND dispatch_incarnation = ?`).run(
        current.recordRevision + 1,
        updatedAtMs,
        current.continuationId,
        current.recordRevision,
        lease.ownerId,
        lease.incarnation,
      )
      if (Number(result.changes) !== 1) {
        database.exec('ROLLBACK')
        return undefined
      }
      database.exec('COMMIT')
      return Object.freeze({
        ...current,
        recordRevision: current.recordRevision + 1,
        state: 'claimed',
        updatedAtMs,
      })
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Apply one compare-and-set lifecycle transition.
   * @param request - allowed source states, optional exact fences, and target state.
   * @returns the new record when this call won, otherwise `undefined`.
   */
  async transition(request: ContinuationTransition): Promise<TaskContinuationClaim | undefined> {
    const database = await this.ready()
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare('SELECT * FROM claims WHERE continuation_id = ?').get(request.id)
      if (row === undefined) {
        database.exec('ROLLBACK')
        return undefined
      }
      const current = decodeRow(row)
      if (!request.from.includes(current.state)
        || (request.expectedRecordRevision !== undefined
          && current.recordRevision !== request.expectedRecordRevision)
        || (request.expectedSessionId !== undefined && current.sessionId !== request.expectedSessionId)
        || (request.expectedTaskRevision !== undefined
          && current.taskRevision !== request.expectedTaskRevision)) {
        database.exec('ROLLBACK')
        return undefined
      }
      assertTransition(current.state, request.to)
      const replacement = request.to === 'superseded'
        ? taskContinuationRevision(request.supersededByTaskRevision ?? '')
        : undefined
      const updatedAtMs = Math.max(request.updatedAtMs, current.updatedAtMs, current.createdAtMs)
      const result = database.prepare(`UPDATE claims SET
        record_revision = ?, state = ?, updated_at_ms = ?, superseded_by_task_revision = ?,
        dispatch_owner_id = NULL, dispatch_lease_expires_at_ms = NULL
        WHERE continuation_id = ? AND record_revision = ?`).run(
        current.recordRevision + 1,
        request.to,
        updatedAtMs,
        replacement ?? null,
        request.id,
        current.recordRevision,
      )
      if (Number(result.changes) !== 1) {
        database.exec('ROLLBACK')
        return undefined
      }
      database.exec('COMMIT')
      return Object.freeze({
        ...current,
        recordRevision: current.recordRevision + 1,
        state: request.to,
        updatedAtMs,
        ...(replacement === undefined ? {} : { supersededByTaskRevision: replacement }),
      })
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  private async open(): Promise<void> {
    const root = dirname(this.path)
    await ensureDurableDirectory(root, this.fileSystem, this.platform)
    const parent = await this.fileSystem.lstat(root)
    if (!parent.isDirectory()) {
      throw new Error(`task continuation root must be a real directory: ${dirname(this.path)}`)
    }
    try {
      const databaseFile = await this.fileSystem.lstat(this.path)
      if (!databaseFile.isFile()) {
        throw new Error(`task continuation database must be a regular file: ${this.path}`)
      }
    } catch (error: unknown) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    const Database = await loadDatabase()
    const database = new Database(this.path)
    try {
      database.exec(`PRAGMA busy_timeout = ${String(this.busyTimeoutMs)}`)
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = FULL')
      database.exec('PRAGMA foreign_keys = ON')
      database.exec('PRAGMA trusted_schema = OFF')
      initializeSchema(database)
      if (this.closed) throw this.closedError
      this.database = database
    } catch (error: unknown) {
      database.close()
      throw error
    }
  }

  private async ready(): Promise<DatabaseSync> {
    await this.initialize()
    /* v8 ignore next -- close rejects new initialization or drains after an already queued ready continuation. */
    if (this.database === undefined) throw this.closedError
    return this.database
  }

  /** Wait for one opening attempt before releasing its published connection. */
  private async finishClose(): Promise<void> {
    try {
      await this.opening
    } catch (error: unknown) {
      if (error !== this.closedError) throw error
    }
    const database = this.database
    this.database = undefined
    database?.close()
  }
}

/** Load the runtime's built-in SQLite implementation lazily and silence only Node 22's exact SQLite warning. */
async function loadDatabase(): Promise<DatabaseSyncConstructor> {
  const originalEmitWarning = Reflect.get(process, 'emitWarning')
  /* v8 ignore start -- Node 22 alone emits this warning; primary coverage runs on Node 24. */
  Reflect.set(process, 'emitWarning', (warning: string | Error, ...details: unknown[]): void => {
    const warningMessage = warning instanceof Error ? warning.message : warning
    const warningOptions = details[0]
    const warningType = warning instanceof Error
      ? warning.name
      : typeof warningOptions === 'string'
        ? warningOptions
        : typeof warningOptions === 'object' && warningOptions !== null && 'type' in warningOptions
          ? warningOptions.type
          : undefined
    if (warningMessage === 'SQLite is an experimental feature and might change at any time'
      && warningType === 'ExperimentalWarning') return
    Reflect.apply(originalEmitWarning, process, [warning, ...details])
  })
  try {
    return (await import('node:sqlite')).DatabaseSync
  } finally {
    Reflect.set(process, 'emitWarning', originalEmitWarning)
  }
  /* v8 ignore stop */
}

/** Initialize or refuse the exact version-4 schema under one writer reservation. */
function initializeSchema(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    const applicationId = pragmaNumber(database, 'application_id')
    const version = pragmaNumber(database, 'user_version')
    const objects = schemaObjects(database)
    if (version === 0 && applicationId === 0 && objects.length === 0) {
      database.exec(`PRAGMA application_id = ${String(APPLICATION_ID)}`)
      database.exec(CLAIMS_CREATE_SQL)
      database.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
    }
    const validatedApplicationId = pragmaNumber(database, 'application_id')
    const validatedVersion = pragmaNumber(database, 'user_version')
    if (validatedApplicationId !== APPLICATION_ID || validatedVersion !== SCHEMA_VERSION) {
      throw new TaskContinuationStoreCorruptionError(
        `task continuation database has application id ${String(validatedApplicationId)} and version ${String(validatedVersion)}`,
      )
    }
    assertClaimsSchema(database)
    database.exec('COMMIT')
  } catch (error: unknown) {
    database.exec('ROLLBACK')
    throw error
  }
}

function schemaObjects(database: DatabaseSync): unknown[] {
  return database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all()
}

function assertClaimsSchema(database: DatabaseSync): void {
  const objects = schemaObjects(database)
  const normalizedObjects = objects.map((row) => {
    /* v8 ignore next -- node:sqlite schema queries return object rows. */
    if (!isRecord(row)) return row
    const sql = row['sql']
    return {
      type: row['type'],
      name: row['name'],
      tbl_name: row['tbl_name'],
      /* v8 ignore next -- a table's sqlite_schema.sql is always text in node:sqlite. */
      sql: typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : sql,
    }
  })
  const expectedObjects = [{
    type: 'table',
    name: 'claims',
    tbl_name: 'claims',
    sql: CLAIMS_CREATE_SQL.replace(/\s+/g, ' ').trim(),
  }]
  assertExactSchema('objects and CREATE SQL', normalizedObjects, expectedObjects)
  assertExactSchema(
    'claims columns',
    projectSchemaRows(database.prepare('PRAGMA table_xinfo(claims)').all(), [
      'cid', 'name', 'type', 'notnull', 'dflt_value', 'pk', 'hidden',
    ]),
    CLAIM_COLUMNS,
  )
  assertExactSchema(
    'claims indexes',
    projectSchemaRows(database.prepare('PRAGMA index_list(claims)').all(), [
      'seq', 'name', 'unique', 'origin', 'partial',
    ]),
    CLAIM_INDEXES,
  )
  const indexKeys = ['seqno', 'cid', 'name', 'desc', 'coll', 'key'] as const
  assertExactSchema(
    'claims caller-mutation unique index',
    projectSchemaRows(database.prepare('PRAGMA index_xinfo(sqlite_autoindex_claims_2)').all(), indexKeys),
    CLAIM_MUTATION_INDEX,
  )
  assertExactSchema(
    'claims primary-key index',
    projectSchemaRows(database.prepare('PRAGMA index_xinfo(sqlite_autoindex_claims_1)').all(), indexKeys),
    CLAIM_PRIMARY_INDEX,
  )
  for (const row of database.prepare('SELECT * FROM claims').all()) decodeRow(row)
}

function projectSchemaRows(rows: unknown[], keys: readonly string[]): unknown[] {
  return rows.map((row) => {
    /* v8 ignore next -- node:sqlite PRAGMA table/index queries return object rows. */
    if (!isRecord(row)) return row
    return Object.fromEntries(keys.map(key => [key, row[key]]))
  })
}

function assertExactSchema(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TaskContinuationStoreCorruptionError(`task continuation database has unexpected ${label}`)
  }
}

/** Read one numeric PRAGMA result independent of its generated column name. */
function pragmaNumber(database: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const row = database.prepare(`PRAGMA ${name}`).get()
  if (!isRecord(row)) throw new TaskContinuationStoreCorruptionError(`missing ${name}`)
  const value = Object.values(row)[0]
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new TaskContinuationStoreCorruptionError(`invalid ${name}`)
  }
  return Number(value)
}

/** Decode one strict database row as the public immutable claim. */
function decodeRow(value: unknown): TaskContinuationClaim {
  if (!isRecord(value)) throw new TaskContinuationStoreCorruptionError('claim row is not a record')
  try {
    const state = readString(value, 'state')
    if (!ALL_STATES.includes(state as TaskContinuationState)) throw new Error('invalid state')
    const superseded = value['superseded_by_task_revision']
    if (state === 'superseded') {
      if (typeof superseded !== 'string') throw new Error('missing superseded revision')
    } else if (superseded !== null) {
      throw new Error('unexpected superseded revision')
    }
    decodeStoredDispatchLease(value, state as TaskContinuationState)
    const claim: TaskContinuationClaim = {
      kind: 'task-continuation',
      version: 1,
      continuationId: continuationId(readString(value, 'continuation_id')),
      callerId: taskContinuationCallerId(readString(value, 'caller_id')),
      mutationId: taskContinuationMutationId(readString(value, 'mutation_id')),
      recordRevision: readInteger(value, 'record_revision'),
      state: state as TaskContinuationState,
      dispatchMessageId: MessageId(readNonEmptyString(value, 'dispatch_message_id')),
      resumeAgentOptions: decodeAgentOptions(value),
      sessionId: SessionId(readNonEmptyString(value, 'session_id')),
      originalMessageId: MessageId(readNonEmptyString(value, 'original_message_id')),
      needDigest: continuationDigest(readString(value, 'need_digest')),
      taskRevision: taskContinuationRevision(readString(value, 'task_revision')),
      verifierId: taskContinuationVerifierId(readString(value, 'verifier_id')),
      verificationPayloadDigest: continuationDigest(readString(value, 'verification_payload_digest')),
      createdAtMs: readInteger(value, 'created_at_ms'),
      updatedAtMs: readInteger(value, 'updated_at_ms'),
      expiresAtMs: readInteger(value, 'expires_at_ms'),
      ...(typeof superseded === 'string'
        ? { supersededByTaskRevision: taskContinuationRevision(superseded) }
        : {}),
    }
    if (claim.updatedAtMs < claim.createdAtMs) throw new Error('updatedAt precedes createdAt')
    assertStateRevision(claim.state, claim.recordRevision)
    return Object.freeze(claim)
  } catch (error: unknown) {
    throw new TaskContinuationStoreCorruptionError('invalid task continuation claim row', { cause: error })
  }
}

/** Reject durable states whose revision cannot be reached by the closed lifecycle. */
function assertStateRevision(state: TaskContinuationState, recordRevision: number): void {
  const valid = (state === 'pending' && recordRevision === 0)
    || (state === 'ready' && recordRevision === 1)
    || (state === 'consumed' && recordRevision === 2)
    || (state === 'claimed' && recordRevision === 3)
    || (['canceled', 'superseded', 'expired', 'invalid'].includes(state)
      && recordRevision >= 1 && recordRevision <= 3)
  if (!valid) throw new Error(`state ${state} cannot have record revision ${String(recordRevision)}`)
}

/** Decode and validate private dispatch-lease columns without exposing them in the claim API. */
function decodeStoredDispatchLease(
  value: unknown,
  knownState?: TaskContinuationState,
): StoredDispatchLease {
  /* v8 ignore next -- every private caller first decodes or checks the same SQLite row as a record. */
  if (!isRecord(value)) throw new TaskContinuationStoreCorruptionError('claim row is not a record')
  const owner = value['dispatch_owner_id']
  const expiry = value['dispatch_lease_expires_at_ms']
  const incarnation = readInteger(value, 'dispatch_incarnation')
  if (owner === null && expiry === null) return { ownerId: undefined, incarnation, expiresAtMs: undefined }
  if (typeof owner !== 'string' || owner === '' || (typeof expiry !== 'number' && typeof expiry !== 'bigint')) {
    throw new Error('invalid dispatch lease')
  }
  const expiresAtMs = typeof expiry === 'bigint' ? Number(expiry) : expiry
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0) throw new Error('invalid dispatch lease expiry')
  const state = knownState ?? readString(value, 'state') as TaskContinuationState
  if (state !== 'consumed') throw new Error('dispatch lease on non-consumed claim')
  return Object.freeze({
    ownerId: owner,
    incarnation,
    expiresAtMs,
  })
}

/** Require an exact positive lease interval and process identity before a SQLite write. */
function assertLeaseInputs(ownerId: string, nowMs: number, expiresAtMs: number): void {
  if (ownerId === '') throw new Error('task continuation dispatch lease owner must be non-empty')
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) {
    throw new Error('task continuation dispatch lease interval must use increasing safe epoch milliseconds')
  }
}

/** Create ancestry one component at a time and prove each parent entry durable. */
async function ensureDurableDirectory(
  path: string,
  fileSystem: ContinuationStoreFileSystem,
  platform: NodeJS.Platform,
): Promise<void> {
  const ancestry: string[] = []
  for (let current = resolve(path); dirname(current) !== current; current = dirname(current)) ancestry.push(current)
  for (const directory of ancestry.reverse()) {
    try {
      await fileSystem.mkdir(directory)
    } catch (error: unknown) {
      if (!isErrno(error, 'EEXIST')) throw error
      const entry = await fileSystem.stat(directory)
      if (!entry.isDirectory()) {
        throw new Error(`task continuation durable directory component is not a directory: ${directory}`)
      }
    }
    try {
      await fileSystem.syncDirectory(dirname(directory))
    } catch (error: unknown) {
      if (!isUnsupportedWindowsDirectorySync(error, platform)) throw error
    }
  }
}

/** Whether Windows rejected only its unsupported directory-handle flush operation. */
function isUnsupportedWindowsDirectorySync(error: unknown, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    && ['EACCES', 'EINVAL', 'ENOTSUP', 'EPERM'].some(code => isErrno(error, code))
}

/** Reject a caller-key replay that changes any immutable reservation input. */
function assertSameReservation(existing: TaskContinuationClaim, input: NewContinuationRecord): void {
  if (existing.callerId !== input.callerId
    || existing.mutationId !== input.mutationId
    || existing.sessionId !== input.sessionId
    || existing.originalMessageId !== input.originalMessageId
    || existing.needDigest !== input.needDigest
    || existing.taskRevision !== input.taskRevision
    || existing.verifierId !== input.verifierId
    || existing.verificationPayloadDigest !== input.verificationPayloadDigest
    || existing.expiresAtMs !== input.expiresAtMs
    || !sameContinuationAgentOptions(existing.resumeAgentOptions, input.resumeAgentOptions)) {
    throw new TaskContinuationMutationConflictError(existing.callerId, existing.mutationId)
  }
}

/** Decode optional model-route fields used only for cold Agent resume. */
function decodeAgentOptions(row: Record<string, unknown>): TaskContinuationClaim['resumeAgentOptions'] {
  const provider = row['agent_provider']
  const model = row['agent_model']
  const maxTokens = row['agent_max_tokens']
  if (provider !== null && (typeof provider !== 'string' || provider === '')) throw new Error('invalid agent_provider')
  if (model !== null && (typeof model !== 'string' || model === '')) throw new Error('invalid agent_model')
  const normalizedMaxTokens = maxTokens === null ? undefined : typeof maxTokens === 'bigint' ? Number(maxTokens) : maxTokens
  if (normalizedMaxTokens !== undefined
    && (!Number.isSafeInteger(normalizedMaxTokens) || (normalizedMaxTokens as number) <= 0)) {
    throw new Error('invalid agent_max_tokens')
  }
  return normalizeContinuationAgentOptions({
    ...(typeof provider === 'string' ? { provider } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof normalizedMaxTokens === 'number' ? { maxTokens: normalizedMaxTokens } : {}),
  })
}

/** Enforce the closed single-use state machine. */
function assertTransition(from: TaskContinuationState, to: TaskContinuationState): void {
  const valid = (from === 'pending' && ['ready', 'canceled', 'superseded', 'expired', 'invalid'].includes(to))
    || (from === 'ready' && ['consumed', 'canceled', 'superseded', 'expired', 'invalid'].includes(to))
    || (from === 'consumed' && ['claimed', 'canceled', 'superseded', 'expired', 'invalid'].includes(to))
  if (!valid) throw new Error(`invalid task continuation transition ${from} -> ${to}`)
}

/** Read one integer-valued SQLite column. */
function readInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  const number = typeof value === 'bigint' ? Number(value) : value
  if (!Number.isSafeInteger(number) || (number as number) < 0) throw new Error(`invalid ${key}`)
  return number as number
}

/** Read one string-valued SQLite column. */
function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`invalid ${key}`)
  return value
}

/** Read one non-empty string-valued SQLite column. */
function readNonEmptyString(row: Record<string, unknown>, key: string): string {
  const value = readString(row, key)
  if (value === '') throw new Error(`empty ${key}`)
  return value
}

/** Whether an unknown value is a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether an unknown error carries one filesystem code. */
function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code
}
