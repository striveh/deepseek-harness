/**
 * Atomic checksummed state storage and digest-chained recovery journal for the
 * local MCP connection provider.
 * @module @deepseek-ai/dsh-mcp-connections-local/persistence
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  McpConnectionIdempotencyError,
  isMcpConnectionDigest,
  isMcpJsonObject,
  mcpConnectionMutationId,
  parseExactMcpJsonObject,
  type McpConnectionMutationId,
  type McpConnectionMutationReceipt,
} from '@deepseek-ai/dsh-mcp-connections'
import {
  MCP_CONNECTION_STATE_VERSION,
  cloneStoredState,
  digestCanonical,
  emptyStoredState,
  parseMcpConnectionMutationReceipt,
  parseStateEnvelope,
  serializeStateEnvelope,
  type StoredMcpConnectionsState,
} from './state.ts'
import {
  DEFAULT_MCP_STATE_LOCK_WAIT_MS,
  McpConnectionCoordinator,
} from './coordinator.ts'

interface JournalEntryCore {
  version: typeof MCP_CONNECTION_STATE_VERSION
  sequence: number
  kind: 'mutation' | 'recovery'
  previousDigest: string | null
  stateDigest: string
  mutationId?: McpConnectionMutationId
  requestDigest?: string
  receipt?: McpConnectionMutationReceipt
}

interface JournalEntry extends JournalEntryCore {
  digest: string
}

interface JournalHead {
  sequence: number
  digest: string | null
  stateDigest: string | null
}

/** Durable publication step exposed only to exact filesystem fault tests. */
export type McpConnectionPersistenceStep =
  | 'directory-created'
  | 'directory-entry-synced'
  | 'file-synced'
  | 'file-renamed'
  | 'parent-directory-synced'
  | 'temp-cleanup-starting'
  | 'journal-appended'
  | 'journal-synced'
  | 'journal-parent-directory-synced'

/** Internal fault hooks for exercising exact durable-publication windows. */
export interface McpConnectionPersistenceHooks {
  /**
   * Observe or fail at one named durable-publication or cleanup step.
   * @param step - exact durable-publication or cleanup step.
   * @param path - final file or newly created directory governed by the step.
   */
  afterStep?(step: McpConnectionPersistenceStep, path: string): void
}

/** Result of loading or mutating durable state, including any deterministic repair labels. */
export interface DurableStateResult {
  /** Authoritative desired state after recovery. */
  state: StoredMcpConnectionsState
  /** Stable labels describing repairs performed while holding the writer lock. */
  recoveries: readonly string[]
}

/** Result of one durable mutation or exact idempotent replay. */
export interface DurableMutationResult extends DurableStateResult {
  /** Exact original or newly committed receipt. */
  receipt: McpConnectionMutationReceipt
  /** Whether an existing exact idempotency entry supplied the receipt. */
  replayed: boolean
}

/** Checksummed file store with a last-good copy and an independently repairable journal. */
export class McpConnectionFileStore {
  private readonly lastGoodPath: string
  private readonly journalPath: string
  private readonly coordinator: McpConnectionCoordinator

  /**
   * Bind the store to one absolute desired-state file.
   * @param statePath - authoritative desired-state file.
   * @param lockWaitMs - maximum SQLite writer-reservation wait.
   */
  constructor(
    private readonly statePath: string,
    lockWaitMs = DEFAULT_MCP_STATE_LOCK_WAIT_MS,
    private readonly hooks: McpConnectionPersistenceHooks = {},
  ) {
    this.lastGoodPath = `${statePath}.last-good`
    this.journalPath = `${statePath}.journal`
    this.coordinator = new McpConnectionCoordinator(statePath, lockWaitMs)
  }

  /**
   * Load, recover, and return current durable state.
   * @returns authoritative state and any repair labels after the writer lock releases.
   */
  async load(): Promise<DurableStateResult> {
    await ensureDurableDirectory(dirname(this.statePath), this.hooks)
    if (!await this.durableStateMayExist()) {
      return { state: emptyStoredState(), recoveries: [] }
    }
    return this.coordinator.run(async () => {
      const loaded = await this.loadUnderLock()
      return { state: loaded.state, recoveries: loaded.recoveries }
    })
  }

  /**
   * Apply one serialized mutation under the cross-process writer lock.
   * An exact mutation-id replay returns its original receipt without calling
   * `transform`; a mismatched replay rejects before state changes.
   * @param mutationId - durable idempotency key.
   * @param requestDigest - canonical digest of the complete operation request.
   * @param transform - pure desired-state mutation executed only for a new key.
   * @param validateCommit - optional synchronous acceptance check run after transform and before the mutation's durable writes.
   * @returns authoritative post-mutation state, receipt, replay flag, and repair labels.
   */
  async mutate(
    mutationId: McpConnectionMutationId,
    requestDigest: string,
    transform: (state: StoredMcpConnectionsState) => {
      next: StoredMcpConnectionsState
      receipt: McpConnectionMutationReceipt
    },
    validateCommit?: () => void,
  ): Promise<DurableMutationResult> {
    await ensureDurableDirectory(dirname(this.statePath), this.hooks)
    return this.coordinator.run(async () => {
      const loaded = await this.loadUnderLock()
      const prior = loaded.state.mutations.find(entry => entry.mutationId === mutationId)
      if (prior !== undefined) {
        if (prior.requestDigest !== requestDigest) throw new McpConnectionIdempotencyError(mutationId)
        return { state: loaded.state, recoveries: loaded.recoveries, receipt: prior.receipt, replayed: true }
      }

      const { next, receipt } = transform(cloneStoredState(loaded.state))
      validateCommit?.()
      next.mutations.push({ mutationId, requestDigest, receipt })
      const text = serializeStateEnvelope(next)
      await writeFileDurable(this.statePath, text, this.hooks)
      await writeFileDurable(this.lastGoodPath, text, this.hooks)
      await this.appendJournal(loaded.journalHead, {
        version: MCP_CONNECTION_STATE_VERSION,
        sequence: loaded.journalHead.sequence + 1,
        kind: 'mutation',
        previousDigest: loaded.journalHead.digest,
        stateDigest: digestCanonical(next),
        mutationId,
        requestDigest,
        receipt,
      })
      return { state: next, recoveries: loaded.recoveries, receipt, replayed: false }
    })
  }

  /**
   * Whether authority or an in-flight/previous coordinator can order this load after a writer.
   * @returns `true` when the load must enter SQLite coordination.
   */
  private async durableStateMayExist(): Promise<boolean> {
    for (const path of [this.statePath, this.lastGoodPath, this.journalPath, this.coordinator.path]) {
      try {
        await lstat(path)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return false
  }

  private async loadUnderLock(): Promise<{
    state: StoredMcpConnectionsState
    recoveries: string[]
    journalHead: JournalHead
  }> {
    const recoveries: string[] = []
    const currentText = await readOptional(this.statePath)
    const backupText = await readOptional(this.lastGoodPath)
    let state: StoredMcpConnectionsState

    if (currentText === undefined) {
      if (backupText === undefined) {
        const journalText = await readOptional(this.journalPath)
        if (journalText !== undefined && journalText.length > 0) {
          throw new Error(`mcp-connections-local: state and last-good files are missing while journal exists at ${this.journalPath}`)
        }
        state = emptyStoredState()
      } else {
        state = parseStateEnvelope(backupText, this.lastGoodPath)
        await writeFileDurable(this.statePath, serializeStateEnvelope(state), this.hooks)
        recoveries.push('state-restored-from-last-good')
      }
    } else {
      let currentIsAuthoritative = false
      try {
        state = parseStateEnvelope(currentText, this.statePath)
        currentIsAuthoritative = true
      } catch (currentError) {
        if (backupText === undefined) {
          throw new Error(`mcp-connections-local: current state is corrupt and no last-good state exists at ${this.statePath}`, { cause: currentError })
        }
        try {
          state = parseStateEnvelope(backupText, this.lastGoodPath)
        } catch (backupError) {
          throw new AggregateError(
            [currentError, backupError],
            `mcp-connections-local: current and last-good state are corrupt at ${this.statePath}`,
          )
        }
        await preserveCorrupt(this.statePath, currentText, this.hooks)
        await writeFileDurable(this.statePath, serializeStateEnvelope(state), this.hooks)
        recoveries.push('state-restored-from-last-good')
      }
      if (currentIsAuthoritative) recoveries.push(...await this.reconcileLastGood(state, backupText))
    }

    const repaired = await this.repairJournal(digestCanonical(state), state.revision)
    recoveries.push(...repaired.recoveries)
    return { state, recoveries, journalHead: repaired.head }
  }

  private async reconcileLastGood(
    state: StoredMcpConnectionsState,
    backupText: string | undefined,
  ): Promise<string[]> {
    const stateDigest = digestCanonical(state)
    if (backupText !== undefined) {
      try {
        const backup = parseStateEnvelope(backupText, this.lastGoodPath)
        if (digestCanonical(backup) === stateDigest) return []
      } catch {
        await preserveCorrupt(this.lastGoodPath, backupText, this.hooks)
      }
    }
    await writeFileDurable(this.lastGoodPath, serializeStateEnvelope(state), this.hooks)
    return ['last-good-reconciled-to-state']
  }

  private async repairJournal(stateDigest: string, stateRevision: number): Promise<{
    head: JournalHead
    recoveries: string[]
  }> {
    const text = await readOptional(this.journalPath) ?? ''
    const parsed = parseJournalPrefix(text)
    const recoveries: string[] = []
    let head = parsed.head
    if (parsed.invalidSuffix.length > 0) {
      await preserveCorrupt(this.journalPath, parsed.invalidSuffix, this.hooks)
      await writeFileDurable(this.journalPath, parsed.validText, this.hooks)
      recoveries.push('journal-invalid-suffix-truncated')
    }
    if (stateRevision > 0 && head.stateDigest !== stateDigest) {
      const entry = await this.appendJournal(head, {
        version: MCP_CONNECTION_STATE_VERSION,
        sequence: head.sequence + 1,
        kind: 'recovery',
        previousDigest: head.digest,
        stateDigest,
      })
      head = { sequence: entry.sequence, digest: entry.digest, stateDigest: entry.stateDigest }
      recoveries.push('journal-reconciled-to-state')
    }
    return { head, recoveries }
  }

  private async appendJournal(head: JournalHead, core: JournalEntryCore): Promise<JournalEntry> {
    if (core.previousDigest !== head.digest || core.sequence !== head.sequence + 1) {
      throw new Error('mcp-connections-local: journal append does not extend the validated head')
    }
    const entry: JournalEntry = { ...core, digest: digestCanonical(core) }
    await appendJournalDurable(this.journalPath, `${JSON.stringify(entry)}\n`, this.hooks)
    return entry
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code
}

function notifyStep(
  hooks: McpConnectionPersistenceHooks,
  step: McpConnectionPersistenceStep,
  path: string,
): void {
  hooks.afterStep?.(step, path)
}

/** Flush one directory entry namespace where Node exposes a directory handle. */
async function syncDirectory(path: string): Promise<void> {
  /* v8 ignore next -- Node cannot open directory handles on Windows; file fsync and atomic replace remain portable. */
  if (process.platform === 'win32') return
  /* v8 ignore start -- Windows cannot exercise directory fsync; POSIX fault tests cover this peer. */
  const handle = await open(path, 'r')
  let primary: unknown
  try {
    await handle.sync()
  } catch (error) {
    primary = error
  }
  try {
    await handle.close()
  } catch (error) {
    if (primary !== undefined) {
      throw combinedFailure(primary, error, 'mcp-connections-local: directory sync and descriptor cleanup failed')
    }
    throw error
  }
  if (primary instanceof Error) throw primary
  if (primary !== undefined) throw new Error('mcp-connections-local: directory sync failed', { cause: primary })
  /* v8 ignore stop */
}

/** Create private ancestry and prove each component entry durable, including an EEXIST race winner. */
async function ensureDurableDirectory(
  path: string,
  hooks: McpConnectionPersistenceHooks,
): Promise<void> {
  const ancestry: string[] = []
  for (let current = resolve(path); dirname(current) !== current; current = dirname(current)) ancestry.push(current)
  for (const directory of ancestry.reverse()) {
    let created = false
    try {
      await mkdir(directory, { mode: 0o700 })
      created = true
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
      if (!(await stat(directory)).isDirectory()) {
        throw new Error(`mcp-connections-local: durable parent is not a directory at ${directory}`)
      }
    }
    if (created) notifyStep(hooks, 'directory-created', directory)
    await syncDirectory(dirname(directory))
    notifyStep(hooks, 'directory-entry-synced', directory)
  }
}

function combinedFailure(primary: unknown, cleanup: unknown, message: string): AggregateError {
  return new AggregateError([primary, cleanup], message, { cause: primary })
}

async function writeAndSync(
  handle: FileHandle,
  content: string,
  hooks: McpConnectionPersistenceHooks,
  path: string,
): Promise<void> {
  let primary: unknown
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    notifyStep(hooks, 'file-synced', path)
  } catch (error) {
    primary = error
  }
  try {
    await handle.close()
  } catch (error) {
    /* v8 ignore start -- Node FileHandle close faults require an injected OS descriptor failure. */
    if (primary !== undefined) {
      throw combinedFailure(primary, error, 'mcp-connections-local: durable file write and descriptor cleanup failed')
    }
    throw error
    /* v8 ignore stop */
  }
  if (primary instanceof Error) throw primary
  if (primary !== undefined) throw new Error('mcp-connections-local: durable file write failed', { cause: primary })
}

/** Write, fsync, atomically replace, and flush the containing directory. */
async function writeFileDurable(
  path: string,
  content: string,
  hooks: McpConnectionPersistenceHooks,
): Promise<void> {
  await ensureDurableDirectory(dirname(path), hooks)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    await writeAndSync(handle, content, hooks, path)
    await rename(temporary, path)
    notifyStep(hooks, 'file-renamed', path)
    await syncDirectory(dirname(path))
    notifyStep(hooks, 'parent-directory-synced', path)
  } catch (error) {
    try {
      notifyStep(hooks, 'temp-cleanup-starting', path)
      await rm(temporary, { force: true })
    } catch (cleanupError) {
      throw combinedFailure(error, cleanupError, 'mcp-connections-local: durable file publication and temp cleanup failed')
    }
    throw error
  }
}

/** Append one complete journal line, then flush the file and its namespace. */
async function appendJournalDurable(
  path: string,
  line: string,
  hooks: McpConnectionPersistenceHooks,
): Promise<void> {
  await ensureDurableDirectory(dirname(path), hooks)
  const handle = await open(path, 'a', 0o600)
  let primary: unknown
  try {
    await handle.writeFile(line, 'utf8')
    notifyStep(hooks, 'journal-appended', path)
    await handle.sync()
    notifyStep(hooks, 'journal-synced', path)
  } catch (error) {
    primary = error
  }
  try {
    await handle.close()
  } catch (error) {
    /* v8 ignore start -- Node FileHandle close faults require an injected OS descriptor failure. */
    if (primary !== undefined) {
      throw combinedFailure(primary, error, 'mcp-connections-local: journal append and descriptor cleanup failed')
    }
    throw error
    /* v8 ignore stop */
  }
  if (primary instanceof Error) throw primary
  if (primary !== undefined) throw new Error('mcp-connections-local: journal append failed', { cause: primary })
  await syncDirectory(dirname(path))
  notifyStep(hooks, 'journal-parent-directory-synced', path)
}

function parseJournalPrefix(text: string): { validText: string; invalidSuffix: string; head: JournalHead } {
  let offset = 0
  let validEnd = 0
  let head: JournalHead = { sequence: 0, digest: null, stateDigest: null }
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset)
    if (newline < 0) break
    const line = text.slice(offset, newline)
    let entry: JournalEntry
    try {
      entry = parseJournalEntry(line, head)
    } catch {
      break
    }
    head = { sequence: entry.sequence, digest: entry.digest, stateDigest: entry.stateDigest }
    offset = newline + 1
    validEnd = offset
  }
  return { validText: text.slice(0, validEnd), invalidSuffix: text.slice(validEnd), head }
}

function parseJournalEntry(line: string, head: JournalHead): JournalEntry {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch (cause) {
    throw new Error('invalid journal JSON', { cause })
  }
  if (!isMcpJsonObject(raw)) throw new TypeError('journal entry must be an object')
  if (raw.kind !== 'mutation' && raw.kind !== 'recovery') throw new Error('journal kind is unsupported')
  const object = parseExactMcpJsonObject(
    raw,
    raw.kind === 'mutation'
      ? ['version', 'sequence', 'kind', 'previousDigest', 'stateDigest', 'mutationId', 'requestDigest', 'receipt', 'digest']
      : ['version', 'sequence', 'kind', 'previousDigest', 'stateDigest', 'digest'],
    '$journal',
  )
  const digest = object.digest
  if (typeof digest !== 'string' || !isMcpConnectionDigest(digest)) throw new TypeError('journal digest is invalid')
  const { digest: _digest, ...core } = object
  if (digestCanonical(core) !== digest) throw new Error('journal digest mismatch')
  if (core.version !== MCP_CONNECTION_STATE_VERSION) throw new Error('journal version is unsupported')
  if (!Number.isSafeInteger(core.sequence) || (core.sequence as number) !== head.sequence + 1) throw new Error('journal sequence is not contiguous')
  if (core.previousDigest !== head.digest) throw new Error('journal digest chain is broken')
  if (typeof core.stateDigest !== 'string' || !isMcpConnectionDigest(core.stateDigest)) throw new Error('journal state digest is invalid')
  if (core.kind === 'mutation') {
    if (typeof core.mutationId !== 'string') throw new TypeError('journal mutation id must be a string')
    if (typeof core.requestDigest !== 'string' || !isMcpConnectionDigest(core.requestDigest)) {
      throw new TypeError('journal request digest must be a SHA-256 digest')
    }
    const mutationId = mcpConnectionMutationId(core.mutationId)
    const receipt = parseMcpConnectionMutationReceipt(core.receipt, '$journal.receipt')
    if (receipt.mutationId !== mutationId) throw new Error('journal receipt mutation id does not match its entry')
    return {
      version: MCP_CONNECTION_STATE_VERSION,
      sequence: core.sequence as number,
      kind: 'mutation',
      previousDigest: core.previousDigest as string | null,
      stateDigest: core.stateDigest,
      mutationId,
      requestDigest: core.requestDigest,
      receipt,
      digest,
    }
  }
  return {
    version: MCP_CONNECTION_STATE_VERSION,
    sequence: core.sequence as number,
    kind: 'recovery',
    previousDigest: core.previousDigest as string | null,
    stateDigest: core.stateDigest,
    digest,
  }
}

async function preserveCorrupt(
  path: string,
  text: string,
  hooks: McpConnectionPersistenceHooks,
): Promise<void> {
  const evidencePath = `${path}.corrupt-${digestCanonical(text).slice(0, 16)}`
  await writeFileDurable(evidencePath, text, hooks)
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
}
