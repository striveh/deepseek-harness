/**
 * Win32 Kernel32 ABI binding for process creation time.
 * @module @deepseek-ai/dsh-native-command/windows-process-start
 */

import koffi from 'koffi'
import { queryWindowsProcessStart, type WindowsProcessTimeBuffers } from './process-start-query.ts'

type NativePointer = bigint & { readonly __nativePointer: unique symbol }

interface WindowsProcessBindings {
  openProcess(access: number, inherit: number, pid: number): NativePointer | null
  getProcessTimes(
    processHandle: NativePointer,
    creation: NativePointer,
    exit: NativePointer,
    kernel: NativePointer,
    user: NativePointer,
  ): number
  closeHandle(handle: NativePointer): number
}

const WINDOWS_FILETIME = koffi.struct({ dwLowDateTime: 'uint32', dwHighDateTime: 'uint32' })
const WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
let windowsBindings: WindowsProcessBindings | undefined

function getWindowsBindings(): WindowsProcessBindings {
  if (windowsBindings !== undefined) return windowsBindings
  const library = koffi.load('kernel32.dll')
  const pointer = koffi.pointer('void')
  windowsBindings = {
    openProcess: library.func('__stdcall', 'OpenProcess', pointer, ['uint32', 'int', 'uint32']),
    getProcessTimes: library.func('__stdcall', 'GetProcessTimes', 'int', [
      pointer,
      koffi.pointer(WINDOWS_FILETIME),
      koffi.pointer(WINDOWS_FILETIME),
      koffi.pointer(WINDOWS_FILETIME),
      koffi.pointer(WINDOWS_FILETIME),
    ]),
    closeHandle: library.func('__stdcall', 'CloseHandle', 'int', [pointer]),
  }
  return windowsBindings
}

function allocateFileTimes(): WindowsProcessTimeBuffers<NativePointer> {
  return {
    creation: koffi.alloc(WINDOWS_FILETIME, 1) as NativePointer,
    exit: koffi.alloc(WINDOWS_FILETIME, 1) as NativePointer,
    kernel: koffi.alloc(WINDOWS_FILETIME, 1) as NativePointer,
    user: koffi.alloc(WINDOWS_FILETIME, 1) as NativePointer,
  }
}

/**
 * Read one Windows process's 100-nanosecond creation time through Kernel32.
 * @param pid - process identifier to inspect.
 * @returns high and low FILETIME words, or `null` when Kernel32 cannot return the process.
 */
export function readWindowsProcessStart(pid: number): string | null {
  const bindings = getWindowsBindings()
  return queryWindowsProcessStart(pid, {
    openProcess: target => bindings.openProcess(WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION, 0, target),
    allocateTimes: allocateFileTimes,
    getProcessTimes: (handle, buffers) => bindings.getProcessTimes(
      handle,
      buffers.creation,
      buffers.exit,
      buffers.kernel,
      buffers.user,
    ),
    decodeCreation: (creation) => {
      const record = koffi.decode(creation, WINDOWS_FILETIME) as {
        dwLowDateTime: number
        dwHighDateTime: number
      }
      return { high: record.dwHighDateTime, low: record.dwLowDateTime }
    },
    closeHandle: handle => bindings.closeHandle(handle),
  })
}
