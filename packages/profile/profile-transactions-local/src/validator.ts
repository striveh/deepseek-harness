/**
 * Provider-owned real Loader validation for staged Profile generations.
 * The parent bounds one detached child; the child boots admitted Web code
 * against disposable launch state and the exact application install anchor.
 * @module @deepseek-ai/dsh-profile-transactions-local/validator
 */

import { spawn, spawnSync } from 'node:child_process'
import { lstatSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  boot,
  composeEntries,
  loadLayeredEnv,
  loadProfile,
  PROFILE_ROOT_FILENAME,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { profileId } from '@deepseek-ai/dsh-profile-transactions'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Exact application package file used by Profile bundle resolution. */
    dshInstallAnchor?: string
  }
}

/** Hidden argv discriminator routed by the product CLI to {@link runProfileValidatorChild}. */
export const PROFILE_VALIDATOR_ARG = '--dsh-internal-profile-validate'
/** Default wall-clock budget for one isolated Loader validation. */
export const DEFAULT_PROFILE_VALIDATION_TIMEOUT_MS = 30_000
/** Largest validation timeout Node can schedule without clamping it to 1 ms. */
export const MAX_PROFILE_VALIDATION_TIMEOUT_MS = MAX_TIMER_DELAY_MS
const MAX_DIAGNOSTIC_BYTES = 64 * 1024
const VALIDATION_ROOT = '[]\n'
const VALIDATOR_LAUNCH_ENV_NAMES = new Set([
  'COMSPEC',
  'LANG',
  'LANGUAGE',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'WINDIR',
])

/**
 * Build the validator child's credential-minimized launch environment.
 * Provider endpoints, proxy authorities, credential-file pointers, Node
 * injection options, Harness state, and every non-required ambient name are
 * omitted. Candidate code still has the host process's filesystem and network
 * authority; this only prevents implicit environment inheritance.
 * @returns a fresh environment containing process-launch, locale, and temporary-directory names only.
 */
export function profileValidatorChildEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(scrubbedParentEnv())) {
    const normalized = name.toUpperCase()
    if (VALIDATOR_LAUNCH_ENV_NAMES.has(normalized) || normalized.startsWith('LC_')) {
      environment[name] = value
    }
  }
  return environment
}

/**
 * Validate the exact application file used as the production bundle-resolution anchor.
 * @param installAnchor - configured absolute regular-file path.
 * @returns the unchanged valid path.
 */
export function assertProfileValidatorInstallAnchor(installAnchor: string): string {
  let regular = false
  try {
    regular = lstatSync(installAnchor).isFile()
  } catch (_invalidPath: unknown) {
    // A missing or unreadable anchor is the same load-time misconfiguration.
  }
  if (!isAbsolute(installAnchor) || !regular) {
    throw new Error(`profile transactions: validator installAnchor must be an absolute regular file: ${installAnchor}`)
  }
  return installAnchor
}

function terminateTree(pid: number): void {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      throw new Error(`profile transactions: taskkill failed with status ${String(result.status)}`)
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

function terminateChild(child: { readonly pid?: number | undefined }): void {
  if (child.pid !== undefined) terminateTree(child.pid)
}

interface ValidatorChildHandles {
  readonly stderr: { destroy(): unknown }
  readonly stdout: { destroy(): unknown }
  unref(): unknown
}

function releaseValidatorChildHandles(child: ValidatorChildHandles): unknown[] {
  const failures: unknown[] = []
  const releases = [
    () => child.stdout.destroy(),
    () => child.stderr.destroy(),
    () => child.unref(),
  ]
  for (const release of releases) {
    try {
      release()
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}

/**
 * Run real Loader activation in a detached child and reject its exact output.
 * This function is the local transaction Provider's validator; Consumers do
 * not supply or replace it.
 * @param profile - named Profile used for bundle-template semantics.
 * @param generationPath - complete staged Profile directory.
 * @param installAnchor - exact application package file used by normal Profile bundle resolution.
 * @param validationTimeoutMs - bounded wall-clock budget for child activation and disposal.
 * @returns after the validator child activates and disposes the candidate.
 */
export function validateProfileGenerationIsolated(
  profile: string,
  generationPath: string,
  installAnchor: string,
  validationTimeoutMs: number,
): Promise<void> {
  profileId(profile)
  if (!isAbsolute(generationPath)) throw new Error('profile transactions: validator generation path must be absolute')
  const anchor = assertProfileValidatorInstallAnchor(installAnchor)
  const entry = process.argv[1]
  if (entry === undefined) throw new Error('profile transactions: cannot locate the launcher entry for Profile validation')
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      ...process.execArgv,
      resolve(entry),
      PROFILE_VALIDATOR_ARG,
      profile,
      generationPath,
      anchor,
    ], {
      detached: process.platform !== 'win32',
      env: profileValidatorChildEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let overflow = false
    let primaryFailure: Error | undefined
    let launchFailure: Error | undefined
    let settled = false
    const rejectFailure = (primary: Error, secondaryFailures: readonly unknown[] = []): void => {
      if (secondaryFailures.length === 0) {
        reject(primary)
      } else {
        reject(new AggregateError(
          [primary, ...secondaryFailures],
          `profile transactions: ${primary.message}; validator termination or local handle release also failed`,
          { cause: primary },
        ))
      }
    }
    const settleFailure = (primary: Error): void => {
      settled = true
      clearTimeout(timer)
      rejectFailure(primary)
    }
    const terminateFor = (primary: Error): void => {
      primaryFailure ??= primary
      try {
        terminateChild(child)
      } catch (error) {
        settled = true
        clearTimeout(timer)
        rejectFailure(primaryFailure, [error, ...releaseValidatorChildHandles(child)])
      }
    }
    const append = (chunk: Buffer): void => {
      if (overflow) return
      output += chunk.toString('utf8')
      if (Buffer.byteLength(output) > MAX_DIAGNOSTIC_BYTES) {
        overflow = true
        terminateFor(new Error('profile transactions: Profile validator exceeded its diagnostic output limit'))
      }
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => {
      if (primaryFailure === undefined && launchFailure === undefined) {
        terminateFor(new Error(`profile transactions: Profile validator exceeded ${String(validationTimeoutMs)} ms`))
      }
    }, validationTimeoutMs)
    timer.unref()
    child.once('error', (error) => {
      clearTimeout(timer)
      launchFailure = error
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (settled) return
      if (primaryFailure !== undefined) {
        settleFailure(primaryFailure)
      } else if (launchFailure !== undefined) {
        settleFailure(launchFailure)
      } else if (code !== 0) {
        const diagnostic = output === '' ? '' : `\n${output.trimEnd()}`
        settleFailure(new Error(
          `profile transactions: isolated Profile Loader validation failed (${signal ?? `exit ${String(code)}`})${diagnostic}`,
        ))
      } else {
        settled = true
        resolvePromise()
      }
    })
  })
}

/**
 * Child-process entry: activate and dispose the staged Web Profile against an
 * isolated Harness home and loopback ephemeral port.
 * @param profile - named Profile.
 * @param generationPath - complete staged Profile directory.
 * @param installAnchor - exact application bundle-resolution anchor.
 * @returns after the candidate tree is disposed.
 */
export async function runProfileValidatorChild(
  profile: string,
  generationPath: string,
  installAnchor: string,
): Promise<void> {
  profileId(profile)
  if (!isAbsolute(generationPath)) throw new Error('profile transactions: validator generation path must be absolute')
  const anchor = assertProfileValidatorInstallAnchor(installAnchor)
  const validationHome = await mkdtemp(join(tmpdir(), 'dsh-profile-validation-'))
  Object.assign(process.env, {
    APPDATA: validationHome,
    DSH_HOME: validationHome,
    HOME: validationHome,
    LOCALAPPDATA: validationHome,
    TEMP: validationHome,
    TMP: validationHome,
    TMPDIR: validationHome,
    USERPROFILE: validationHome,
    XDG_CACHE_HOME: validationHome,
    XDG_CONFIG_HOME: validationHome,
    XDG_DATA_HOME: validationHome,
    XDG_STATE_HOME: validationHome,
  })
  let ctx: Awaited<ReturnType<typeof boot>> | undefined
  let validationFailure: { error: unknown } | undefined
  try {
    const loaded = loadProfile('dsh-profile-validator', profile, anchor, undefined, {
      profileDir: generationPath,
      readOnly: true,
    })
    const patches = [...loaded.layers.flatMap(layer => layer.patches), ...loaded.patches]
    const rows = composeEntries([patches])
    if (!rows.some(row => row.id === 'web-startup')) {
      throw new Error('dsh-profile-validator: P0 real activation supports Web Profiles only')
    }
    const rootConfig = join(validationHome, PROFILE_ROOT_FILENAME)
    writeFileSync(rootConfig, VALIDATION_ROOT, 'utf8')
    const environment = loadLayeredEnv('dsh-profile-validator', validationHome)
    ctx = await boot('dsh-profile-validator', rootConfig, structuredClone(patches), (hostCtx) => {
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
      hostCtx.provide('dshInstallAnchor', anchor)
      provideCmdline(hostCtx, {
        args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
        exit: () => {},
      })
    }, undefined, generationPath)
  } catch (error) {
    validationFailure = { error }
  }
  const cleanupErrors: unknown[] = []
  if (ctx !== undefined) {
    try {
      await ctx.fiber.dispose()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  try {
    await rm(validationHome, { recursive: true, force: true })
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (validationFailure !== undefined) {
    if (cleanupErrors.length === 0) throw validationFailure.error
    throw new AggregateError(
      [validationFailure.error, ...cleanupErrors],
      'dsh-profile-validator: validation failed and cleanup also failed',
    )
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0]
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'dsh-profile-validator: multiple cleanup operations failed')
  }
}
