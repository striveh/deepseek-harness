import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CHILD_PID_FILE = 'validator-child.pid'

function collect(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let value = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => { value += String(chunk) })
    stream.on('end', () => { resolvePromise(value) })
    stream.on('error', reject)
  })
}

async function waitForChildPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      const pid = Number.parseInt((await readFile(path, 'utf8')).trim(), 10)
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid validator child pid: ${String(pid)}`)
      return pid
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (Date.now() >= deadline) throw new Error('validator child did not publish its pid')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
    }
  }
}

async function waitForClose(child: ChildProcess): Promise<readonly [number | null, NodeJS.Signals | null]> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => {
    timeout.reject(new Error('validator parent retained child handles after tree termination failed'))
  }, 6_000)
  const close = new Promise<readonly [number | null, NodeJS.Signals | null]>((resolvePromise) => {
    child.once('close', (code, signal) => { resolvePromise([code, signal]) })
  })
  try {
    return await Promise.race([close, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

describe.skipIf(process.platform === 'win32')('Profile validator parent handle release', () => {
  it('lets a real parent process exit after an injected process-group kill failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-validator-handles-'))
    const generationPath = join(root, 'generation')
    const installAnchor = join(root, 'package.json')
    const pidPath = join(generationPath, CHILD_PID_FILE)
    await mkdir(generationPath)
    await writeFile(installAnchor, '{}\n')
    const worker = fileURLToPath(new URL('./validator-handle-release-worker.ts', import.meta.url))
    const parent = spawn(process.execPath, [
      '--no-warnings',
      '--import', import.meta.resolve('tsx/esm'),
      worker,
      generationPath,
      installAnchor,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = collect(parent.stdout)
    const stderr = collect(parent.stderr)
    let validatorPid: number | undefined
    try {
      validatorPid = await waitForChildPid(pidPath)
      const close = await waitForClose(parent)
      expect(close[0], await stderr).toBe(0)
      expect(JSON.parse(await stdout)).toEqual([
        'profile transactions: Profile validator exceeded 2000 ms',
        'injected tree kill failure',
      ])
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        parent.kill('SIGKILL')
        await once(parent, 'close').catch(() => {})
      }
      if (validatorPid === undefined) {
        try {
          validatorPid = Number.parseInt((await readFile(pidPath, 'utf8')).trim(), 10)
        } catch (_missingPid: unknown) {
          // No validator child reached its entry, so there is no recorded process to clean up.
        }
      }
      if (validatorPid !== undefined && Number.isSafeInteger(validatorPid) && validatorPid > 0) {
        try {
          process.kill(validatorPid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 12_000)
})
