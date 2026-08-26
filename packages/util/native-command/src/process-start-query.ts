/**
 * Cross-platform decisions over injected native process-start queries.
 * @module @deepseek-ai/dsh-native-command/process-start-query
 */

import { runWindowsHandleQuery } from './windows-handle.ts'

/** Decoded `proc_bsdinfo` fields required for process incarnation. */
export interface DarwinProcessStartRecord {
  /** PID stored in the returned record. */
  readonly pid: number
  /** Creation-time whole seconds. */
  readonly seconds: number | bigint
  /** Creation-time microseconds. */
  readonly microseconds: number | bigint
}

/** Injectable libproc query used by Darwin process-start inspection. */
export interface DarwinProcessStartQuery {
  /** Exact byte count of one `proc_bsdinfo` record. */
  readonly recordSize: number
  /** Fill the caller-owned native buffer and return the byte count. */
  query(pid: number): number
  /** Decode the filled native buffer. */
  decode(): DarwinProcessStartRecord
}

/**
 * Read and validate one Darwin process creation time.
 * @param pid - process identifier passed to libproc.
 * @param runtime - injected query and decode operations.
 * @returns seconds and microseconds, or `null` when libproc did not return the requested process.
 */
export function queryDarwinProcessStart(
  pid: number,
  runtime: DarwinProcessStartQuery,
): string | null {
  if (runtime.query(pid) !== runtime.recordSize) return null
  const record = runtime.decode()
  if (record.pid !== pid) return null
  return `${String(record.seconds)}:${String(record.microseconds)}`
}

/** Native buffers supplied to one `GetProcessTimes` call. */
export interface WindowsProcessTimeBuffers<Buffer> {
  /** Process creation time. */
  readonly creation: Buffer
  /** Process exit time. */
  readonly exit: Buffer
  /** Kernel-mode CPU time. */
  readonly kernel: Buffer
  /** User-mode CPU time. */
  readonly user: Buffer
}

/** Decoded Windows creation-time fields. */
export interface WindowsProcessStartRecord {
  /** High 32 bits of the FILETIME value. */
  readonly high: number
  /** Low 32 bits of the FILETIME value. */
  readonly low: number
}

/** Injectable Win32 operations used by process-start inspection. */
export interface WindowsProcessStartQuery<Handle extends bigint, Buffer> {
  /** Open one process for limited-information queries. */
  openProcess(pid: number): Handle | null
  /** Allocate the four FILETIME buffers required by `GetProcessTimes`. */
  allocateTimes(): WindowsProcessTimeBuffers<Buffer>
  /** Fill the supplied FILETIME buffers; zero means failure. */
  getProcessTimes(handle: Handle, buffers: WindowsProcessTimeBuffers<Buffer>): number
  /** Decode the creation FILETIME buffer. */
  decodeCreation(buffer: Buffer): WindowsProcessStartRecord
  /** Close the opened process handle; nonzero means success. */
  closeHandle(handle: Handle): number
}

function invalidWindowsHandle(value: bigint | null): boolean {
  return value === null || value === 0n || value === -1n || value === 0xFFFFFFFFFFFFFFFFn
}

/**
 * Read one Windows process creation time and require handle cleanup.
 * @param pid - process identifier passed to `OpenProcess`.
 * @param runtime - injected Win32 query operations.
 * @returns high and low FILETIME words, or `null` when the process cannot be queried.
 */
export function queryWindowsProcessStart<Handle extends bigint, Buffer>(
  pid: number,
  runtime: WindowsProcessStartQuery<Handle, Buffer>,
): string | null {
  const handle = runtime.openProcess(pid)
  if (invalidWindowsHandle(handle)) return null
  const liveHandle = handle as Handle
  return runWindowsHandleQuery(() => {
    const buffers = runtime.allocateTimes()
    if (runtime.getProcessTimes(liveHandle, buffers) === 0) return null
    const record = runtime.decodeCreation(buffers.creation)
    return `${String(record.high)}:${String(record.low)}`
  }, () => runtime.closeHandle(liveHandle))
}
