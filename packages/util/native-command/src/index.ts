/**
 * Shared host-native OS primitives: no-shell command execution and stable
 * process-incarnation inspection. A library, not a plugin — no ctx, no state,
 * no events.
 * @module @deepseek-ai/dsh-native-command
 */

import { execFile } from 'node:child_process'
import { cachedProcessIncarnation } from './process-incarnation-cache.ts'
import { SYSTEM_PROCESS_RUNTIME } from './system-process-runtime.ts'

declare const PROCESS_INCARNATION: unique symbol

/** Stable identity of one OS process lifetime, distinct across PID reuse. */
export type ProcessIncarnation = string & { readonly [PROCESS_INCARNATION]: true }

/** Injectable synchronous host boundary used by process-incarnation inspection. */
export interface ProcessIncarnationRuntime {
  /** Node platform whose native mechanism is available. */
  readonly platform: NodeJS.Platform
  /** Probe whether a PID currently names a process. */
  signal(pid: number): void
  /** Read one host pseudo-file as UTF-8. */
  readFile(path: string): string
  /** Read one Darwin process's microsecond creation time through libproc. */
  darwinStart(pid: number): string | null
  /** Read one Windows process's 100-nanosecond creation time through Kernel32. */
  windowsStart(pid: number): string | null
}

function errnoIs(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function processExists(pid: number, runtime: ProcessIncarnationRuntime): boolean {
  try {
    runtime.signal(pid)
    return true
  } catch (error) {
    if (errnoIs(error, 'ESRCH')) return false
    if (errnoIs(error, 'EPERM')) return true
    throw error
  }
}

function nativeIncarnation(
  pid: number,
  runtime: ProcessIncarnationRuntime,
  readStart: (pid: number) => string | null,
  prefix: string,
): ProcessIncarnation | null {
  const value = readStart(pid)
  if (value === null) {
    if (!processExists(pid, runtime)) return null
    throw new Error(`process incarnation is unavailable for live PID ${String(pid)}`)
  }
  if (value.length === 0 || value.length > 96 || !/^\d+(?::\d+)?$/.test(value)) {
    throw new Error(`process incarnation query returned malformed output for PID ${String(pid)}`)
  }
  return `${prefix}:${value}` as ProcessIncarnation
}

/**
 * Read the stable lifetime identity of one live PID.
 * @param pid - positive safe process identifier.
 * @param runtime - host boundary; omitted for the current operating system.
 * @returns a stable incarnation, or `null` when the PID is absent.
 */
export function readProcessIncarnation(
  pid: number,
  runtime: ProcessIncarnationRuntime = SYSTEM_PROCESS_RUNTIME,
): ProcessIncarnation | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('process PID must be a positive safe integer')
  if (!processExists(pid, runtime)) return null
  if (runtime.platform === 'linux') {
    let stat: string
    let bootId: string
    try {
      stat = runtime.readFile(`/proc/${String(pid)}/stat`)
      bootId = runtime.readFile('/proc/sys/kernel/random/boot_id').trim()
    } catch (error) {
      if (errnoIs(error, 'ENOENT') && !processExists(pid, runtime)) return null
      throw error
    }
    const commandEnd = stat.lastIndexOf(')')
    const fields = commandEnd < 0 ? [] : stat.slice(commandEnd + 1).trim().split(/\s+/)
    const startTicks = fields[19]
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bootId)
      || startTicks === undefined || !/^\d+$/.test(startTicks)) {
      throw new Error(`process incarnation files are malformed for PID ${String(pid)}`)
    }
    return `linux:${bootId}:${startTicks}` as ProcessIncarnation
  }
  if (runtime.platform === 'win32') {
    return nativeIncarnation(pid, runtime, target => runtime.windowsStart(target), 'win32')
  }
  if (runtime.platform === 'darwin') {
    return nativeIncarnation(pid, runtime, target => runtime.darwinStart(target), 'darwin')
  }
  throw new Error(`process incarnation is unsupported on ${runtime.platform}`)
}

/**
 * Validate a persisted process-incarnation token before using it for ownership.
 * @param value - durable value to validate.
 * @returns whether the value is a supported bounded token.
 */
export function isProcessIncarnation(value: unknown): value is ProcessIncarnation {
  return typeof value === 'string' && value.length <= 256 && (
    /^linux:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:\d+$/.test(value)
    || /^win32:\d+:\d+$/.test(value)
    || /^darwin:\d+:\d+$/.test(value)
  )
}

const ownProcessIncarnation: { value?: ProcessIncarnation } = {}

/**
 * Return this process lifetime's cached host identity.
 * @returns the non-null incarnation for `process.pid`.
 */
export function currentProcessIncarnation(): ProcessIncarnation {
  return cachedProcessIncarnation(
    ownProcessIncarnation,
    () => readProcessIncarnation(process.pid),
  )
}

/** Testable command boundary; native implementations never invoke a shell. */
export type NativeCommandRunner = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<{ stdout: string; stderr: string }>

/**
 * Run a host command with utf8 stdio, abort propagation, and Windows hide.
 * @param command - executable path or PATH name.
 * @param args - argv (never a shell string).
 * @param signal - caller/connection lifetime; abort terminates the child.
 * @returns captured stdout/stderr on exit 0.
 */
export const runNativeCommand: NativeCommandRunner = (command, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', signal, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure = Object.assign(new Error(error.message, { cause: error }), {
            code: error.code,
            stdout,
            stderr,
          })
          reject(failure)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
