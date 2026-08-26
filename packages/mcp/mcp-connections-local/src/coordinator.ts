/**
 * SQLite-backed cross-process ownership for MCP desired-state file cycles.
 * The operating system releases SQLite reservations when a process exits, so
 * a killed writer cannot leave a pathname lock that blocks later recovery.
 * @module @deepseek-ai/dsh-mcp-connections-local/coordinator
 */

import { mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

type DatabaseSyncConstructor = typeof import('node:sqlite')['DatabaseSync']

const PROCESS_WRITERS = new Map<string, Promise<void>>()

/** Default wait for another process's MCP state writer reservation. */
export const DEFAULT_MCP_STATE_LOCK_WAIT_MS = 10_000
/** Largest wait accepted by SQLite's signed millisecond interface. */
export const MAX_MCP_STATE_LOCK_WAIT_MS = 2_147_483_647

/** Load Node's SQLite implementation only after durable MCP state exists. */
async function loadDatabase(): Promise<DatabaseSyncConstructor> {
  return (await import('node:sqlite')).DatabaseSync
}

async function canonicalCoordinatorPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    /* v8 ignore next -- a concurrent first writer can publish the database between probes. */
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    return join(await realpath(dirname(path)), basename(path))
  }
}

async function withProcessWriter<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = PROCESS_WRITERS.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise })
  PROCESS_WRITERS.set(key, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (PROCESS_WRITERS.get(key) === current) PROCESS_WRITERS.delete(key)
  }
}

/** Cross-process coordinator whose reservation is released by process death. */
export class McpConnectionCoordinator {
  /** Absolute coordinator file created beside the desired-state file. */
  readonly path: string

  /**
   * Bind one desired-state path and validated lock wait.
   * @param statePath - absolute desired-state file coordinated by this database.
   * @param lockWaitMs - maximum SQLite writer-reservation wait.
   */
  constructor(statePath: string, private readonly lockWaitMs: number) {
    this.path = `${statePath}.coordinator.sqlite`
  }

  /**
   * Run one complete read-repair-write cycle under `BEGIN IMMEDIATE`.
   * @param operation - state operation performed while this process owns the SQLite reservation.
   * @returns the operation result after the reservation commits.
   */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const key = await canonicalCoordinatorPath(this.path)
    return withProcessWriter(key, async () => {
      const Database = await loadDatabase()
      const database = new Database(this.path)
      try {
        database.exec(`PRAGMA busy_timeout = ${String(this.lockWaitMs)}`)
        database.exec('PRAGMA journal_mode = DELETE')
        database.exec('PRAGMA synchronous = FULL')
        database.exec('BEGIN IMMEDIATE')
        try {
          database.exec('CREATE TABLE IF NOT EXISTS writer_reservation (singleton INTEGER PRIMARY KEY CHECK (singleton = 1)) STRICT')
          const result = await operation()
          database.exec('COMMIT')
          return result
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      } finally {
        database.close()
      }
    })
  }
}
