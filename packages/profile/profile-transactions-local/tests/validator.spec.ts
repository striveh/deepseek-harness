import { EventEmitter } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  boot: vi.fn(),
  composeEntries: vi.fn(),
  loadLayeredEnv: vi.fn(),
  loadProfile: vi.fn(),
  provideCmdline: vi.fn<typeof import('@deepseek-ai/dsh-cmdline')['provideCmdline']>(),
  scrubbedParentEnv: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}))

const fsFaults = vi.hoisted(() => ({
  removeValidationHomeError: undefined as Error | undefined,
  removeValidationHomeStarted: undefined as (() => void) | undefined,
}))

vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]).includes('dsh-profile-validation-')) {
        fsFaults.removeValidationHomeStarted?.()
      }
      if (String(args[0]).includes('dsh-profile-validation-') && fsFaults.removeValidationHomeError !== undefined) {
        const failure = fsFaults.removeValidationHomeError
        fsFaults.removeValidationHomeError = undefined
        throw failure
      }
      await actual.rm(...args)
    },
  }
})
vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  boot: mocks.boot,
  composeEntries: mocks.composeEntries,
  loadLayeredEnv: mocks.loadLayeredEnv,
  loadProfile: mocks.loadProfile,
  PROFILE_ROOT_FILENAME: 'cordis.yml',
}))
vi.mock('@deepseek-ai/dsh-cmdline', () => ({ provideCmdline: mocks.provideCmdline }))
vi.mock('@deepseek-ai/dsh-launch-environment', () => ({
  DSH_LAUNCH_ENVIRONMENT_KEY: 'dshLaunchEnvironment',
}))
vi.mock('@deepseek-ai/dsh-subprocess', () => ({ scrubbedParentEnv: mocks.scrubbedParentEnv }))

import {
  DEFAULT_PROFILE_VALIDATION_TIMEOUT_MS,
  PROFILE_VALIDATOR_ARG,
  assertProfileValidatorInstallAnchor,
  profileValidatorChildEnvironment,
  runProfileValidatorChild,
  validateProfileGenerationIsolated as validateProfileGenerationIsolatedWithTimeout,
} from '../src/validator.ts'

function validateProfileGenerationIsolated(
  profile: string,
  generationPath: string,
  installAnchor: string,
  timeoutMs = DEFAULT_PROFILE_VALIDATION_TIMEOUT_MS,
): Promise<void> {
  return validateProfileGenerationIsolatedWithTimeout(profile, generationPath, installAnchor, timeoutMs)
}

class ValidatorOutput extends EventEmitter {
  readonly destroy = vi.fn(() => this)
}

class ValidatorChild extends EventEmitter {
  readonly stdout = new ValidatorOutput()
  readonly stderr = new ValidatorOutput()
  readonly unref = vi.fn(() => this)

  constructor(readonly pid?: number) {
    super()
  }
}

const cleanups: Array<() => Promise<void>> = []
const testTmpdir = tmpdir()
const validationHomeNames = [
  'APPDATA', 'DSH_HOME', 'HOME', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
] as const
let originalPlatform: PropertyDescriptor | undefined
let originalArgv: string[]
let originalHomeEnvironment: Record<string, string | undefined>

beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  originalArgv = [...process.argv]
  originalHomeEnvironment = Object.fromEntries(validationHomeNames.map(name => [name, process.env[name]]))
  mocks.boot.mockReset()
  mocks.composeEntries.mockReset()
  mocks.loadLayeredEnv.mockReset()
  mocks.loadProfile.mockReset()
  mocks.provideCmdline.mockReset()
  mocks.scrubbedParentEnv.mockReset()
  mocks.spawn.mockReset()
  mocks.spawnSync.mockReset()
  fsFaults.removeValidationHomeError = undefined
  fsFaults.removeValidationHomeStarted = undefined
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fsFaults.removeValidationHomeError = undefined
  fsFaults.removeValidationHomeStarted = undefined
  process.argv.splice(0, process.argv.length, ...originalArgv)
  for (const name of validationHomeNames) {
    const value = originalHomeEnvironment[name]
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  if (originalPlatform !== undefined) Object.defineProperty(process, 'platform', originalPlatform)
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function fixture(): Promise<{ root: string; anchor: string; generation: string }> {
  const root = await mkdtemp(join(testTmpdir, 'dsh-profile-validator-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const anchor = join(root, 'package.json')
  const generation = join(root, 'generation')
  await mkdir(generation)
  await writeFile(anchor, '{}\n')
  return { root, anchor, generation }
}

describe('Profile validator parent', () => {
  it('keeps only process, locale, and temporary-directory launch names', () => {
    mocks.scrubbedParentEnv.mockReturnValue({
      PATH: '/bin',
      lang: 'C',
      LC_ALL: 'C.UTF-8',
      TMPDIR: '/tmp',
      DEEPSEEK_API_KEY: 'secret',
      HTTP_PROXY: 'http://proxy',
    })
    expect(profileValidatorChildEnvironment()).toEqual({
      PATH: '/bin',
      lang: 'C',
      LC_ALL: 'C.UTF-8',
      TMPDIR: '/tmp',
    })
  })

  it('accepts only an absolute regular install anchor', async () => {
    const { root, anchor } = await fixture()
    expect(assertProfileValidatorInstallAnchor(anchor)).toBe(anchor)
    expect(() => assertProfileValidatorInstallAnchor('relative.json')).toThrow(/absolute regular file/)
    expect(() => assertProfileValidatorInstallAnchor(join(root, 'missing.json'))).toThrow(/absolute regular file/)
    expect(() => assertProfileValidatorInstallAnchor(root)).toThrow(/absolute regular file/)
  })

  it('validates arguments before launching a child', async () => {
    const { anchor, generation } = await fixture()
    expect(() => validateProfileGenerationIsolated('../bad', generation, anchor)).toThrow(/profile name/)
    expect(() => validateProfileGenerationIsolated('web', 'relative', anchor)).toThrow(/generation path/)
    expect(() => validateProfileGenerationIsolated('web', generation, 'relative')).toThrow(/installAnchor/)
    process.argv.splice(1)
    expect(() => validateProfileGenerationIsolated('web', generation, anchor)).toThrow(/launcher entry/)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('resolves a clean child exit and passes exact isolated launch arguments', async () => {
    const { anchor, generation } = await fixture()
    const child = new ValidatorChild(321)
    mocks.scrubbedParentEnv.mockReturnValue({ PATH: '/bin' })
    mocks.spawn.mockReturnValue(child)
    const result = validateProfileGenerationIsolated('web', generation, anchor)
    child.stdout.emit('data', Buffer.from('ignored success output'))
    child.emit('close', 0, null)
    await expect(result).resolves.toBeUndefined()
    expect(mocks.spawn).toHaveBeenCalledWith(process.execPath, [
      ...process.execArgv,
      expect.any(String),
      PROFILE_VALIDATOR_ARG,
      'web',
      generation,
      anchor,
    ], {
      detached: process.platform !== 'win32',
      env: { PATH: '/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  })

  it('reports launch errors and nonzero exits with bounded diagnostics', async () => {
    const { anchor, generation } = await fixture()
    mocks.scrubbedParentEnv.mockReturnValue({})

    const failedLaunch = new ValidatorChild()
    mocks.spawn.mockReturnValueOnce(failedLaunch)
    const launch = validateProfileGenerationIsolated('web', generation, anchor)
    failedLaunch.emit('error', new Error('spawn denied'))
    failedLaunch.emit('close', null, null)
    await expect(launch).rejects.toThrow('spawn denied')

    const failedExit = new ValidatorChild()
    mocks.spawn.mockReturnValueOnce(failedExit)
    const exited = validateProfileGenerationIsolated('web', generation, anchor)
    failedExit.stderr.emit('data', Buffer.from('loader failed\n'))
    failedExit.emit('close', 3, null)
    await expect(exited).rejects.toThrow(/exit 3.*loader failed/s)

    const signaled = new ValidatorChild()
    mocks.spawn.mockReturnValueOnce(signaled)
    const killed = validateProfileGenerationIsolated('web', generation, anchor)
    signaled.emit('close', null, 'SIGTERM')
    await expect(killed).rejects.toThrow(/SIGTERM/)
  })

  it('kills a detached process tree when diagnostics overflow', async () => {
    vi.useFakeTimers()
    const { anchor, generation } = await fixture()
    mocks.scrubbedParentEnv.mockReturnValue({})
    const child = new ValidatorChild(432)
    mocks.spawn.mockReturnValue(child)
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const result = validateProfileGenerationIsolated('web', generation, anchor)
    child.stdout.emit('data', Buffer.alloc(65 * 1024, 0x61))
    child.stderr.emit('data', Buffer.from('not appended'))
    await vi.advanceTimersByTimeAsync(30_000)
    child.emit('close', null, 'SIGKILL')
    await expect(result).rejects.toThrow(/diagnostic output limit/)
    expect(kill).toHaveBeenCalledWith(-432, 'SIGKILL')
  })

  it('swallows only an absent Unix process and handles a child without a pid', async () => {
    const { anchor, generation } = await fixture()
    mocks.scrubbedParentEnv.mockReturnValue({})
    const absent = Object.assign(new Error('gone'), { code: 'ESRCH' })
    vi.spyOn(process, 'kill').mockImplementation(() => { throw absent })
    const child = new ValidatorChild(543)
    mocks.spawn.mockReturnValueOnce(child)
    const result = validateProfileGenerationIsolated('web', generation, anchor)
    child.stdout.emit('data', Buffer.alloc(65 * 1024))
    child.emit('close', null, 'SIGKILL')
    await expect(result).rejects.toThrow(/diagnostic output limit/)

    const pidless = new ValidatorChild()
    mocks.spawn.mockReturnValueOnce(pidless)
    const withoutPid = validateProfileGenerationIsolated('web', generation, anchor)
    pidless.stdout.emit('data', Buffer.alloc(65 * 1024))
    pidless.emit('close', null, 'SIGKILL')
    await expect(withoutPid).rejects.toThrow(/diagnostic output limit/)
  })

  it('aggregates an unexpected Unix tree-termination failure without throwing from stream callbacks', async () => {
    const { anchor, generation } = await fixture()
    mocks.scrubbedParentEnv.mockReturnValue({})
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    const child = new ValidatorChild(654)
    mocks.spawn.mockReturnValue(child)
    const result = validateProfileGenerationIsolated('web', generation, anchor)
    expect(() => child.stdout.emit('data', Buffer.alloc(65 * 1024))).not.toThrow()
    const failure = await result.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    const failures = (failure as AggregateError).errors as readonly unknown[]
    expect(failures).toHaveLength(2)
    expect((failures[0] as Error).message).toMatch(/diagnostic output limit/)
    expect(failures[1]).toMatchObject({ message: 'denied', code: 'EPERM' })
    expect(child.stdout.destroy).toHaveBeenCalledOnce()
    expect(child.stderr.destroy).toHaveBeenCalledOnce()
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('retains every local handle-release failure after the primary and tree-termination errors', async () => {
    const { anchor, generation } = await fixture()
    mocks.scrubbedParentEnv.mockReturnValue({})
    const terminationFailure = Object.assign(new Error('tree denied'), { code: 'EPERM' })
    const stdoutFailure = new Error('stdout destroy failed')
    const stderrFailure = new Error('stderr destroy failed')
    const unrefFailure = new Error('child unref failed')
    vi.spyOn(process, 'kill').mockImplementation(() => { throw terminationFailure })
    const child = new ValidatorChild(655)
    child.stdout.destroy.mockImplementation(() => { throw stdoutFailure })
    child.stderr.destroy.mockImplementation(() => { throw stderrFailure })
    child.unref.mockImplementation(() => { throw unrefFailure })
    mocks.spawn.mockReturnValue(child)

    const result = validateProfileGenerationIsolated('web', generation, anchor)
    expect(() => child.stdout.emit('data', Buffer.alloc(65 * 1024))).not.toThrow()
    const failure = await result.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    const failures = (failure as AggregateError).errors as readonly unknown[]
    expect(failures).toHaveLength(5)
    expect((failures[0] as Error).message).toMatch(/diagnostic output limit/)
    expect(failures.slice(1)).toEqual([
      terminationFailure,
      stdoutFailure,
      stderrFailure,
      unrefFailure,
    ])
  })

  it('uses taskkill for a Windows child tree', async () => {
    const { anchor, generation } = await fixture()
    mocks.scrubbedParentEnv.mockReturnValue({})
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const child = new ValidatorChild(765)
    mocks.spawn.mockReturnValue(child)
    mocks.spawnSync.mockReturnValue({ status: 0 })
    const result = validateProfileGenerationIsolated('web', generation, anchor)
    child.stdout.emit('data', Buffer.alloc(65 * 1024))
    child.emit('close', null, 'SIGKILL')
    await expect(result).rejects.toThrow(/diagnostic output limit/)
    expect(mocks.spawnSync).toHaveBeenCalledWith('taskkill', ['/PID', '765', '/T', '/F'], { stdio: 'ignore' })
  })

  it('aggregates Windows taskkill launch and status failures without waiting for child close', async () => {
    const { anchor, generation } = await fixture()
    mocks.scrubbedParentEnv.mockReturnValue({})
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const cases = [
      { result: { error: new Error('taskkill launch denied'), status: null }, diagnostic: /taskkill launch denied/ },
      { result: { status: 5 }, diagnostic: /taskkill failed with status 5/ },
    ]
    for (const [index, testCase] of cases.entries()) {
      const child = new ValidatorChild(800 + index)
      mocks.spawn.mockReturnValueOnce(child)
      mocks.spawnSync.mockReturnValueOnce(testCase.result)
      const result = validateProfileGenerationIsolated('web', generation, anchor)
      child.stdout.emit('data', Buffer.alloc(65 * 1024))
      child.emit('close', null, 'SIGKILL')
      const failure = await result.catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(AggregateError)
      const failures = (failure as AggregateError).errors as readonly unknown[]
      expect(failures).toHaveLength(2)
      expect((failures[0] as Error).message).toMatch(/diagnostic output limit/)
      expect((failures[1] as Error).message).toMatch(testCase.diagnostic)
    }
  })

  it('rejects a validator that exceeds its time limit', async () => {
    vi.useFakeTimers()
    const { anchor, generation } = await fixture()
    mocks.scrubbedParentEnv.mockReturnValue({})
    const child = new ValidatorChild(876)
    mocks.spawn.mockReturnValue(child)
    vi.spyOn(process, 'kill').mockReturnValue(true)
    const result = validateProfileGenerationIsolated('web', generation, anchor, 137)
    await vi.advanceTimersByTimeAsync(137)
    child.emit('close', null, 'SIGKILL')
    await expect(result).rejects.toThrow(/exceeded 137 ms/)
    expect(child.stdout.destroy).not.toHaveBeenCalled()
    expect(child.stderr.destroy).not.toHaveBeenCalled()
    expect(child.unref).not.toHaveBeenCalled()
  })
})

describe('Profile validator child', () => {
  it('rejects invalid arguments before creating launch state', async () => {
    const { anchor, generation } = await fixture()
    await expect(runProfileValidatorChild('../bad', generation, anchor)).rejects.toThrow(/profile name/)
    await expect(runProfileValidatorChild('web', 'relative', anchor)).rejects.toThrow(/generation path/)
    await expect(runProfileValidatorChild('web', generation, 'relative')).rejects.toThrow(/installAnchor/)
  })

  it('requires a Web startup row and removes disposable launch state', async () => {
    const { anchor, generation } = await fixture()
    mocks.loadProfile.mockReturnValue({ layers: [{ patches: [['layer']] }], patches: [['leaf']] })
    mocks.composeEntries.mockReturnValue([])
    await expect(runProfileValidatorChild('web', generation, anchor)).rejects.toThrow(/supports Web Profiles only/)
    const loaded = mocks.loadProfile.mock.results[0]?.value as { layers: unknown[] }
    expect(loaded.layers).toHaveLength(1)
    expect(mocks.boot).not.toHaveBeenCalled()
  })

  it('boots and disposes the exact candidate with isolated launch providers', async () => {
    const { anchor, generation } = await fixture()
    const dispose = vi.fn(async () => {})
    const provide = vi.fn()
    const environment = { DEEPSEEK_BASE_URL: 'explicit-loaded-layer' }
    mocks.loadProfile.mockReturnValue({ layers: [{ patches: [['layer']] }], patches: [['leaf']] })
    mocks.composeEntries.mockReturnValue([{ id: 'web-startup' }])
    mocks.loadLayeredEnv.mockReturnValue(environment)
    mocks.boot.mockImplementation(async (
      _name: string,
      rootConfig: string,
      patches: unknown,
      configure: (ctx: { provide: typeof provide }) => Promise<void> | void,
      _meta: string | undefined,
      profileDir: string | undefined,
    ) => {
      expect(await readFile(rootConfig, 'utf8')).toBe('[]\n')
      expect(patches).toEqual([['layer'], ['leaf']])
      expect(profileDir).toBe(generation)
      await configure({ provide })
      const cmdline = mocks.provideCmdline.mock.calls[0]?.[1]
      if (cmdline === undefined) throw new Error('validator did not provide its command line')
      expect(cmdline.args).toEqual(['--host', '127.0.0.1', '--port', '0', '--no-open'])
      cmdline.exit(0)
      return { fiber: { dispose } }
    })

    await expect(runProfileValidatorChild('web', generation, anchor)).resolves.toBeUndefined()
    expect(mocks.loadProfile).toHaveBeenCalledWith('dsh-profile-validator', 'web', anchor, undefined, {
      profileDir: generation,
      readOnly: true,
    })
    expect(provide).toHaveBeenCalledWith('dshLaunchEnvironment', environment)
    expect(provide).toHaveBeenCalledWith('dshInstallAnchor', anchor)
    expect(mocks.provideCmdline).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('removes isolated launch state when candidate disposal rejects', async () => {
    const { anchor, generation } = await fixture()
    const disposeFailure = new Error('dispose rejected')
    mocks.loadProfile.mockReturnValue({ layers: [], patches: [] })
    mocks.composeEntries.mockReturnValue([{ id: 'web-startup' }])
    mocks.loadLayeredEnv.mockReturnValue({})
    mocks.boot.mockResolvedValue({
      fiber: { dispose: vi.fn(async () => { throw disposeFailure }) },
    })

    await expect(runProfileValidatorChild('web', generation, anchor)).rejects.toBe(disposeFailure)
    const validationHome = process.env.DSH_HOME
    expect(validationHome).toContain('dsh-profile-validation-')
    await expect(access(validationHome!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('waits for candidate disposal to settle before removing isolated launch state', async () => {
    const { anchor, generation } = await fixture()
    const disposal = Promise.withResolvers<undefined>()
    let removalStarted = false
    mocks.loadProfile.mockReturnValue({ layers: [], patches: [] })
    mocks.composeEntries.mockReturnValue([{ id: 'web-startup' }])
    mocks.loadLayeredEnv.mockReturnValue({})
    mocks.boot.mockResolvedValue({ fiber: { dispose: vi.fn(() => disposal.promise) } })
    fsFaults.removeValidationHomeStarted = () => { removalStarted = true }

    const validation = runProfileValidatorChild('web', generation, anchor)
    await vi.waitFor(() => { expect(mocks.boot).toHaveBeenCalledOnce() })
    expect(removalStarted).toBe(false)
    disposal.resolve(undefined)
    await expect(validation).resolves.toBeUndefined()
    expect(removalStarted).toBe(true)
  })

  it('aggregates validation and cleanup failures without losing the primary error', async () => {
    const { anchor, generation } = await fixture()
    const validationFailure = new Error('boot rejected first')
    const removalFailure = new Error('validation home removal rejected')
    mocks.loadProfile.mockReturnValue({ layers: [], patches: [] })
    mocks.composeEntries.mockReturnValue([{ id: 'web-startup' }])
    mocks.loadLayeredEnv.mockReturnValue({})
    mocks.boot.mockRejectedValue(validationFailure)
    fsFaults.removeValidationHomeError = removalFailure

    let failure: unknown
    try {
      await runProfileValidatorChild('web', generation, anchor)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([validationFailure, removalFailure])
    const validationHome = process.env.DSH_HOME!
    cleanups.push(() => rm(validationHome, { recursive: true, force: true }))
  })

  it('aggregates independent disposal and removal failures in cleanup order', async () => {
    const { anchor, generation } = await fixture()
    const disposeFailure = new Error('dispose rejected first')
    const removalFailure = new Error('validation home removal rejected second')
    mocks.loadProfile.mockReturnValue({ layers: [], patches: [] })
    mocks.composeEntries.mockReturnValue([{ id: 'web-startup' }])
    mocks.loadLayeredEnv.mockReturnValue({})
    mocks.boot.mockResolvedValue({
      fiber: { dispose: vi.fn(async () => { throw disposeFailure }) },
    })
    fsFaults.removeValidationHomeError = removalFailure

    let failure: unknown
    try {
      await runProfileValidatorChild('web', generation, anchor)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([disposeFailure, removalFailure])
    const validationHome = process.env.DSH_HOME!
    cleanups.push(() => rm(validationHome, { recursive: true, force: true }))
  })

  it('removes launch state when boot fails before returning a context', async () => {
    const { anchor, generation } = await fixture()
    mocks.loadProfile.mockReturnValue({ layers: [], patches: [] })
    mocks.composeEntries.mockReturnValue([{ id: 'web-startup' }])
    mocks.loadLayeredEnv.mockReturnValue({})
    mocks.boot.mockRejectedValue(new Error('boot rejected'))
    await expect(runProfileValidatorChild('web', generation, anchor)).rejects.toThrow('boot rejected')
  })
})
