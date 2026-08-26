/**
 * Current-host adapter for process-incarnation inspection.
 * @module @deepseek-ai/dsh-native-command/system-process-runtime
 */

import { readFileSync } from 'node:fs'
import { readDarwinProcessStart } from './darwin-process-start.ts'
import type { ProcessIncarnationRuntime } from './index.ts'
import { readWindowsProcessStart } from './windows-process-start.ts'

function signalProcess(pid: number): void {
  process.kill(pid, 0)
}

function readProcessFile(path: string): string {
  return readFileSync(path, 'utf8')
}

/** Current operating system operations used by process-incarnation inspection. */
export const SYSTEM_PROCESS_RUNTIME: ProcessIncarnationRuntime = {
  platform: process.platform,
  signal: signalProcess,
  readFile: readProcessFile,
  darwinStart: readDarwinProcessStart,
  windowsStart: readWindowsProcessStart,
}
