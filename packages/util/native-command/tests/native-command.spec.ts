import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  currentProcessIncarnation,
  isProcessIncarnation,
  readProcessIncarnation,
  runNativeCommand,
  type ProcessIncarnation,
  type ProcessIncarnationRuntime,
} from '@deepseek-ai/dsh-native-command'
import * as invariant from '../src/invariant.ts'
import { cachedProcessIncarnation } from '../src/process-incarnation-cache.ts'
import {
  queryDarwinProcessStart,
  queryWindowsProcessStart,
  type DarwinProcessStartQuery,
  type WindowsProcessStartQuery,
} from '../src/process-start-query.ts'
import { SYSTEM_PROCESS_RUNTIME } from '../src/system-process-runtime.ts'
import { runWindowsHandleQuery } from '../src/windows-handle.ts'

const node = process.execPath

describe('Windows native handle cleanup', () => {
  it('returns only after cleanup succeeds and otherwise preserves the query failure', () => {
    expect(runWindowsHandleQuery(() => 'created', () => 1)).toBe('created')

    const primary = new Error('query failed')
    expect(() => runWindowsHandleQuery(() => { throw primary }, () => 1)).toThrow(primary)
  })

  it('fails when CloseHandle rejects an otherwise successful query', () => {
    const close = vi.fn(() => 0)

    expect(() => runWindowsHandleQuery(() => 'created', close)).toThrow(/CloseHandle failed/)
    expect(close).toHaveBeenCalledOnce()
  })

  it('retains a query failure before a CloseHandle failure', () => {
    const primary = new Error('GetProcessTimes failed')
    const close = vi.fn(() => 0)
    let caught: unknown

    try {
      runWindowsHandleQuery(() => { throw primary }, close)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    const errors = (caught as AggregateError).errors as unknown[]
    expect(errors[0]).toBe(primary)
    expect(errors[1]).toBeInstanceOf(Error)
    expect((errors[1] as Error).message).toMatch(/CloseHandle failed/)
    expect((caught as Error).cause).toBe(primary)
    expect(close).toHaveBeenCalledOnce()
  })

  it('wraps a thrown CloseHandle binding failure', () => {
    const bindingFailure = new Error('ffi failure')
    let caught: unknown

    try {
      runWindowsHandleQuery(() => 'created', () => { throw bindingFailure })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/CloseHandle threw/)
    expect((caught as Error).cause).toBe(bindingFailure)
  })
})

function darwinQuery(
  overrides: Partial<DarwinProcessStartQuery> = {},
): DarwinProcessStartQuery {
  return {
    recordSize: 136,
    query: () => 136,
    decode: () => ({ pid: 42, seconds: 1_787_727_600n, microseconds: 123_456n }),
    ...overrides,
  }
}

function windowsQuery(
  overrides: Partial<WindowsProcessStartQuery<bigint, string>> = {},
): WindowsProcessStartQuery<bigint, string> {
  return {
    openProcess: () => 42n,
    allocateTimes: () => ({
      creation: 'creation',
      exit: 'exit',
      kernel: 'kernel',
      user: 'user',
    }),
    getProcessTimes: () => 1,
    decodeCreation: () => ({ high: 31_234_567, low: 89_101_112 }),
    closeHandle: () => 1,
    ...overrides,
  }
}

describe('native process-start query decisions', () => {
  it('validates Darwin byte counts and returned PIDs before formatting creation time', () => {
    expect(queryDarwinProcessStart(42, darwinQuery()))
      .toBe('1787727600:123456')

    const decodeAfterShortRead = vi.fn(() => ({ pid: 42, seconds: 1, microseconds: 2 }))
    expect(queryDarwinProcessStart(42, darwinQuery({
      query: () => 135,
      decode: decodeAfterShortRead,
    }))).toBeNull()
    expect(decodeAfterShortRead).not.toHaveBeenCalled()

    expect(queryDarwinProcessStart(42, darwinQuery({
      decode: () => ({ pid: 43, seconds: 1, microseconds: 2 }),
    }))).toBeNull()
  })

  it('rejects every Win32 invalid-handle spelling without allocating query buffers', () => {
    for (const handle of [null, 0n, -1n, 0xFFFFFFFFFFFFFFFFn]) {
      const allocateTimes = vi.fn(() => ({
        creation: 'creation',
        exit: 'exit',
        kernel: 'kernel',
        user: 'user',
      }))
      expect(queryWindowsProcessStart(42, windowsQuery({
        openProcess: () => handle,
        allocateTimes,
      }))).toBeNull()
      expect(allocateTimes).not.toHaveBeenCalled()
    }
  })

  it('formats Windows FILETIME words and closes only after the query', () => {
    const order: string[] = []
    expect(queryWindowsProcessStart(42, windowsQuery({
      getProcessTimes: () => {
        order.push('query')
        return 1
      },
      decodeCreation: (buffer) => {
        order.push(`decode:${buffer}`)
        return { high: 31_234_567, low: 89_101_112 }
      },
      closeHandle: () => {
        order.push('close')
        return 1
      },
    }))).toBe('31234567:89101112')
    expect(order).toEqual(['query', 'decode:creation', 'close'])
  })

  it('returns null for a failed GetProcessTimes call and still closes the handle', () => {
    const decodeCreation = vi.fn(() => ({ high: 1, low: 2 }))
    const closeHandle = vi.fn(() => 1)
    expect(queryWindowsProcessStart(42, windowsQuery({
      getProcessTimes: () => 0,
      decodeCreation,
      closeHandle,
    }))).toBeNull()
    expect(decodeCreation).not.toHaveBeenCalled()
    expect(closeHandle).toHaveBeenCalledOnce()
  })
})

describe('runNativeCommand', () => {
  it('captures utf8 stdout and stderr on exit 0', async () => {
    const result = await runNativeCommand(
      node,
      ['-e', 'process.stdout.write("out✓"); process.stderr.write("err")'],
      new AbortController().signal,
    )
    expect(result).toEqual({ stdout: 'out✓', stderr: 'err' })
  })

  it('rejects a non-zero exit with code, stdout, and stderr attached', async () => {
    const failure = await runNativeCommand(
      node,
      ['-e', 'process.stdout.write("partial"); process.stderr.write("boom"); process.exit(3)'],
      new AbortController().signal,
    ).then(() => { throw new Error('unexpected resolve') }, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 3, stdout: 'partial', stderr: 'boom' })
    expect((failure as Error).cause).toBeInstanceOf(Error)
  })

  it('rejects a missing executable with the spawn ENOENT code', async () => {
    const failure = await runNativeCommand(
      'dsh-definitely-missing-command',
      [],
      new AbortController().signal,
    ).then(() => { throw new Error('unexpected resolve') }, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'ENOENT' })
  })

  it('terminates the child when the signal aborts', async () => {
    const abort = new AbortController()
    const pending = runNativeCommand(node, ['-e', 'setTimeout(() => {}, 60_000)'], abort.signal)
    abort.abort()
    const failure = await pending.then(() => { throw new Error('unexpected resolve') }, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as { code?: unknown }).code).toBe('ABORT_ERR')
  })
})

function errno(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function incarnationRuntime(
  overrides: Partial<ProcessIncarnationRuntime> = {},
): ProcessIncarnationRuntime {
  return {
    platform: 'linux',
    signal: () => {},
    readFile: path => path.endsWith('/stat')
      ? `123 (test process) ${Array.from({ length: 20 }, (_, index) => index === 19 ? '456' : '0').join(' ')}`
      : '11111111-1111-4111-8111-111111111111\n',
    darwinStart: () => '1787727600:123456',
    windowsStart: () => '31234567:89101112',
    ...overrides,
  }
}

describe('process incarnation', () => {
  it('exercises the current-host signal and file adapters directly', () => {
    expect(SYSTEM_PROCESS_RUNTIME.platform).toBe(process.platform)
    expect(() => {
      SYSTEM_PROCESS_RUNTIME.signal(process.pid)
    }).not.toThrow()
    expect(SYSTEM_PROCESS_RUNTIME.readFile(fileURLToPath(import.meta.url)))
      .toContain('exercises the current-host signal and file adapters directly')
  })

  it('reads and caches the current host process identity', () => {
    const direct = readProcessIncarnation(process.pid)
    expect(direct).not.toBeNull()
    expect(isProcessIncarnation(direct)).toBe(true)
    expect(currentProcessIncarnation()).toBe(direct)
    expect(currentProcessIncarnation()).toBe(direct)
  })

  it('rejects invalid PIDs and returns null for an absent process', () => {
    for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => readProcessIncarnation(pid, incarnationRuntime())).toThrow(/positive safe integer/)
    }
    expect(readProcessIncarnation(123, incarnationRuntime({
      signal: () => { throw errno('ESRCH') },
    }))).toBeNull()
    const probeFailure = errno('EACCES')
    expect(() => readProcessIncarnation(123, incarnationRuntime({
      signal: () => { throw probeFailure },
    }))).toThrow(probeFailure)
  })

  it('reads Linux boot and start identities and rejects malformed pseudo-files', () => {
    expect(readProcessIncarnation(123, incarnationRuntime()))
      .toBe('linux:11111111-1111-4111-8111-111111111111:456')
    expect(readProcessIncarnation(123, incarnationRuntime({
      signal: () => { throw errno('EPERM') },
    }))).toBe('linux:11111111-1111-4111-8111-111111111111:456')
    for (const readFile of [
      () => 'malformed',
      (path: string) => path.endsWith('/stat') ? '123 no-command-end' : 'not-a-boot-id',
    ]) {
      expect(() => readProcessIncarnation(123, incarnationRuntime({ readFile })))
        .toThrow(/incarnation files are malformed/)
    }
    let probes = 0
    expect(readProcessIncarnation(123, incarnationRuntime({
      signal: () => {
        probes += 1
        if (probes > 1) throw errno('ESRCH')
      },
      readFile: () => { throw errno('ENOENT') },
    }))).toBeNull()
    expect(() => readProcessIncarnation(123, incarnationRuntime({
      readFile: () => { throw errno('EACCES') },
    }))).toThrow(/EACCES/)
  })

  it('reads exact Windows and Darwin native process creation times', () => {
    const windows = incarnationRuntime({
      platform: 'win32',
      windowsStart: () => '31234567:89101112',
    })
    expect(readProcessIncarnation(321, windows)).toBe('win32:31234567:89101112')

    const darwin = incarnationRuntime({
      platform: 'darwin',
      darwinStart: () => '1787727600:123456',
    })
    expect(readProcessIncarnation(654, darwin)).toBe('darwin:1787727600:123456')
  })

  it('distinguishes native query races from malformed or unavailable live-process output', () => {
    let probes = 0
    expect(readProcessIncarnation(123, incarnationRuntime({
      platform: 'darwin',
      signal: () => {
        probes += 1
        if (probes > 1) throw errno('ESRCH')
      },
      darwinStart: () => null,
    }))).toBeNull()
    expect(() => readProcessIncarnation(123, incarnationRuntime({
      platform: 'darwin',
      darwinStart: () => null,
    }))).toThrow(/incarnation is unavailable/)
    for (const output of ['', 'x'.repeat(97), 'bad\noutput', '1:2:3']) {
      expect(() => readProcessIncarnation(123, incarnationRuntime({
        platform: 'darwin',
        darwinStart: () => output,
      }))).toThrow(/malformed output/)
    }
    expect(() => readProcessIncarnation(123, incarnationRuntime({ platform: 'freebsd' })))
      .toThrow(/unsupported on freebsd/)
  })

  it('validates bounded persisted tokens', () => {
    for (const value of [
      'linux:11111111-1111-4111-8111-111111111111:456',
      'win32:31234567:89101112',
      'darwin:1787727600:123456',
    ]) expect(isProcessIncarnation(value)).toBe(true)
    for (const value of [
      null,
      '',
      'x'.repeat(257),
      'linux:not-valid',
      'win32:123',
      'darwin:date',
      'freebsd:1:2',
      'unknown:value',
    ]) {
      expect(isProcessIncarnation(value)).toBe(false)
    }
  })

  it('caches injected identities and fails when the first read reports disappearance', () => {
    const identity = 'darwin:1787727600:123456' as ProcessIncarnation
    const cache: { value?: ProcessIncarnation } = {}
    const read = vi.fn(() => identity)
    expect(cachedProcessIncarnation(cache, read)).toBe(identity)
    expect(cachedProcessIncarnation(cache, read)).toBe(identity)
    expect(read).toHaveBeenCalledOnce()

    expect(() => cachedProcessIncarnation({}, () => null))
      .toThrow(/current process disappeared/)
  })
})

describe('invariant companion', () => {
  it('registers the stateless package ownership installer', async () => {
    const dispose = vi.fn()
    const register = vi.fn((_packageName: string, install: () => void) => {
      install()
      return dispose
    })
    const context = { invariants: { register } } as unknown as Context

    expect(invariant.name).toBe('native-command-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    await expect(invariant.apply(context)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-native-command', expect.any(Function))
  })
})
