/**
 * Darwin libproc ABI binding for process creation time.
 * @module @deepseek-ai/dsh-native-command/darwin-process-start
 */

import koffi from 'koffi'
import { queryDarwinProcessStart } from './process-start-query.ts'

const PROC_PIDTBSDINFO = 3
const DARWIN_BSD_INFO = koffi.struct({
  pbi_flags: 'uint32',
  pbi_status: 'uint32',
  pbi_xstatus: 'uint32',
  pbi_pid: 'uint32',
  pbi_ppid: 'uint32',
  pbi_uid: 'uint32',
  pbi_gid: 'uint32',
  pbi_ruid: 'uint32',
  pbi_rgid: 'uint32',
  pbi_svuid: 'uint32',
  pbi_svgid: 'uint32',
  rfu_1: 'uint32',
  pbi_comm: koffi.array('char', 16),
  pbi_name: koffi.array('char', 32),
  pbi_nfiles: 'uint32',
  pbi_pgid: 'uint32',
  pbi_pjobc: 'uint32',
  e_tdev: 'uint32',
  e_tpgid: 'uint32',
  pbi_nice: 'int32',
  pbi_start_tvsec: 'uint64',
  pbi_start_tvusec: 'uint64',
})

type DarwinProcPidInfo = (pid: number, flavor: number, arg: bigint, buffer: unknown, size: number) => number
let darwinProcPidInfo: DarwinProcPidInfo | undefined

function getDarwinProcPidInfo(): DarwinProcPidInfo {
  darwinProcPidInfo ??= koffi.load('/usr/lib/libproc.dylib').func(
    'int proc_pidinfo(int pid, int flavor, uint64 arg, void *buffer, int buffersize)',
  ) as unknown as DarwinProcPidInfo
  return darwinProcPidInfo
}

/**
 * Read one Darwin process's microsecond creation time through libproc.
 * @param pid - process identifier to inspect.
 * @returns seconds and microseconds, or `null` when libproc cannot return the process.
 */
export function readDarwinProcessStart(pid: number): string | null {
  const procPidInfo = getDarwinProcPidInfo()
  const buffer: unknown = koffi.alloc(DARWIN_BSD_INFO, 1)
  return queryDarwinProcessStart(pid, {
    recordSize: DARWIN_BSD_INFO.size,
    query: target => procPidInfo(target, PROC_PIDTBSDINFO, 0n, buffer, DARWIN_BSD_INFO.size),
    decode: () => {
      const record = koffi.decode(buffer, DARWIN_BSD_INFO) as {
        pbi_pid: number
        pbi_start_tvsec: number | bigint
        pbi_start_tvusec: number | bigint
      }
      return {
        pid: record.pbi_pid,
        seconds: record.pbi_start_tvsec,
        microseconds: record.pbi_start_tvusec,
      }
    },
  })
}
