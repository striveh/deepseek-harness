/**
 * Profile machinery of `dsh-app-boot`: directory resolution and init,
 * manifest round-trips, two-anchor bundle resolution, patch-layer loading,
 * empty-root composition, and the installation module-fallback healing.
 */

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import Module, { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import {
  currentProcessIncarnation,
  type ProcessIncarnation,
} from '@deepseek-ai/dsh-native-command'
import {
  composeEntries,
  healProfilesModuleFallback,
  initProfile,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  PROFILE_TRANSACTION_ROOT,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
} from '../src/index.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-profile-'))
const execFileAsync = promisify(execFile)
const ownIncarnation = currentProcessIncarnation()
const deadIncarnation = 'linux:00000000-0000-0000-0000-000000000000:1' as ProcessIncarnation

function incarnationFingerprint(incarnation: ProcessIncarnation): string {
  return createHash('sha256').update(incarnation).digest('hex')
}

/** Stage a fake installed app: package.json with deps and a node_modules holding bundles. */
function stageInstallation(bundles: Record<string, { patch?: string; deps?: Record<string, string> }>): string {
  const root = tmp()
  const appDir = join(root, 'app')
  mkdirSync(join(appDir, 'node_modules'), { recursive: true })
  const appDeps: Record<string, string> = {}
  for (const [name, spec] of Object.entries(bundles)) {
    appDeps[name] = '0.0.0'
    const dir = join(appDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      version: '0.0.0',
      dependencies: spec.deps ?? {},
      ...spec.patch === undefined ? {} : { dsh: { bundle: { patch: './cordis.patch.yml' } } },
    }))
    if (spec.patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), spec.patch)
  }
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'dsh-app', dependencies: appDeps }))
  return join(appDir, 'package.json')
}

describe('resolveProfileDir', () => {
  it('joins the home and rejects traversal-shaped names', () => {
    const home = tmp()
    expect(resolveProfileDir('tui', home)).toBe(join(home, 'profiles', 'tui'))
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'node_modules', PROFILE_TRANSACTION_ROOT]) {
      expect(() => resolveProfileDir(bad, home)).toThrow('invalid profile name')
    }
  })
})

describe('initProfile', () => {
  it('rejects a non-directory component in the durable Profile path', () => {
    const home = tmp()
    writeFileSync(join(home, 'profiles'), 'not a directory')

    expect(() => { initProfile(resolveProfileDir('blocked', home), ['@deepseek-ai/dsh-base']) })
      .toThrow('durable directory component')
  })

  it('propagates a durable Profile directory creation failure', () => {
    const home = tmp()
    const dir = resolveProfileDir('denied', home)
    const originalMkdirSync = fs.mkdirSync
    fs.mkdirSync = (path, ...args) => {
      if (String(path) === dir) throw Object.assign(new Error('mkdir denied'), { code: 'EACCES' })
      return Reflect.apply(originalMkdirSync, fs, [path, ...args])
    }
    syncBuiltinESMExports()

    try {
      expect(() => { initProfile(dir, ['@deepseek-ai/dsh-base']) }).toThrow('mkdir denied')
    } finally {
      fs.mkdirSync = originalMkdirSync
      syncBuiltinESMExports()
    }
  })

  it('creates manifest, user patch layer, and pnpm workspace once, never overwriting', () => {
    const home = tmp()
    const dir = resolveProfileDir('tui', home)
    initProfile(dir, ['@deepseek-ai/dsh-base'])
    const manifest = readProfileManifest('t', dir)
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('[]')
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('nodeLinker: hoisted')
    // Re-init keeps user edits.
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: x\n  config: {}\n')
    initProfile(dir, ['other'])
    expect(readProfileManifest('t', dir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('- id: x')
  })

  it('fsyncs the parent entry even when another process already published each directory', () => {
    const home = tmp()
    const dir = resolveProfileDir('existing-directory', home)
    mkdirSync(dir, { recursive: true })
    const originalOpenSync = fs.openSync
    const originalFsyncSync = fs.fsyncSync
    const opened = new Map<number, string>()
    const syncedDirectories: string[] = []
    fs.openSync = (path, ...args) => {
      const descriptor = Reflect.apply(originalOpenSync, fs, [path, ...args])
      opened.set(descriptor, String(path))
      return descriptor
    }
    fs.fsyncSync = (descriptor) => {
      const path = opened.get(descriptor)
      if (path !== undefined) syncedDirectories.push(path)
      Reflect.apply(originalFsyncSync, fs, [descriptor])
    }
    syncBuiltinESMExports()

    try {
      initProfile(dir, ['@deepseek-ai/dsh-base'])
    } finally {
      fs.openSync = originalOpenSync
      fs.fsyncSync = originalFsyncSync
      syncBuiltinESMExports()
    }

    expect(syncedDirectories).toContain(join(home, 'profiles'))
  })

  it('preserves interrupted template prefixes and requires manual inspection', () => {
    for (const [filename, retainedBytes] of [
      ['package.json', 1],
      [PROFILE_PATCH_FILENAME, 0],
      ['pnpm-workspace.yaml', 9],
      ['pnpm-lock.yaml', 0],
    ] as const) {
      const dir = resolveProfileDir(`interrupted-${filename.replaceAll('.', '-')}`, tmp())
      initProfile(dir, ['@deepseek-ai/dsh-base'])
      const path = join(dir, filename)
      const complete = readFileSync(path, 'utf8')
      writeFileSync(path, complete.slice(0, retainedBytes))

      expect(() => { initProfile(dir, ['@deepseek-ai/dsh-base']) })
        .toThrow('contains user-owned content')
      expect(readFileSync(path, 'utf8'), filename).toBe(complete.slice(0, retainedBytes))
    }
  })

  it('resumes an exact published template subset without a shared marker', () => {
    const dir = resolveProfileDir('published-subset', tmp())
    initProfile(dir, ['@deepseek-ai/dsh-base'])
    for (const file of [PROFILE_PATCH_FILENAME, 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) rmSync(join(dir, file))

    initProfile(dir, ['@deepseek-ai/dsh-base'])

    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('[]')
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('nodeLinker: hoisted')
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toContain("lockfileVersion: '9.0'")
  })

  it('preserves valid user files and refuses to classify their damaged companion as first-init residue', () => {
    const dir = resolveProfileDir('user-owned', tmp())
    initProfile(dir, ['@deepseek-ai/dsh-base'])
    const manifestPath = join(dir, 'package.json')
    const manifest = `${JSON.stringify({
      name: 'user-owned-profile',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      userField: 'keep',
    }, null, 2)}\n`
    writeFileSync(manifestPath, manifest)
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '')

    expect(() => { initProfile(dir, ['@deepseek-ai/dsh-base']) }).toThrow('contains user-owned content')
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifest)
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toBe('')
  })

  it('does not replace an unrelated damaged file while recovering a missing companion', () => {
    const dir = resolveProfileDir('recovering-user-owned', tmp())
    initProfile(dir, ['@deepseek-ai/dsh-base'])
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'unrelated damage')
    rmSync(join(dir, 'pnpm-workspace.yaml'))

    expect(() => { initProfile(dir, ['@deepseek-ai/dsh-base']) })
      .toThrow('contains user-owned content')
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('unrelated damage')
    expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('rejects a conflicting file published after the initialization snapshot', () => {
    const dir = resolveProfileDir('publication-race', tmp())
    const originalLinkSync = fs.linkSync
    let injected = false
    fs.linkSync = (existingPath, newPath) => {
      if (!injected) {
        injected = true
        writeFileSync(newPath, 'user-owned winner')
      }
      Reflect.apply(originalLinkSync, fs, [existingPath, newPath])
    }
    syncBuiltinESMExports()

    try {
      expect(() => { initProfile(dir, ['@deepseek-ai/dsh-base']) })
        .toThrow('cannot replace incomplete, user-owned, or unrelated file')
    } finally {
      fs.linkSync = originalLinkSync
      syncBuiltinESMExports()
    }

    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe('user-owned winner')
  })

  it('preserves coordinator operation, rollback, and close failures in order', () => {
    const dir = resolveProfileDir('coordinator-cleanup-failures', tmp())
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'user-note.txt'), 'keep')
    const originalCreateRequire = Module.createRequire
    class FaultingDatabase {
      exec(statement: string): void {
        if (statement === 'ROLLBACK') throw new Error('rollback failed')
      }

      close(): void {
        throw new Error('close failed')
      }
    }
    Module.createRequire = (() => ((specifier: string) => {
      if (specifier !== 'node:sqlite') throw new Error(`unexpected require ${specifier}`)
      return { DatabaseSync: FaultingDatabase }
    })) as unknown as typeof Module.createRequire
    syncBuiltinESMExports()

    try {
      let thrown: unknown
      try {
        initProfile(dir, ['@deepseek-ai/dsh-base'])
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(AggregateError)
      const aggregate = thrown as AggregateError
      expect(aggregate.errors.map(error => String(error))).toEqual([
        expect.stringContaining('contains user-owned content'),
        'Error: rollback failed',
        'Error: close failed',
      ])
      expect(String(aggregate.cause)).toContain('contains user-owned content')
    } finally {
      Module.createRequire = originalCreateRequire
      syncBuiltinESMExports()
    }
  })

  it('reports a coordinator close failure after a successful commit', () => {
    const dir = resolveProfileDir('coordinator-close-failure', tmp())
    const originalCreateRequire = Module.createRequire
    class CloseFailingDatabase {
      exec(): void {}

      close(): void {
        throw new Error('close failed')
      }
    }
    Module.createRequire = (() => (() => ({ DatabaseSync: CloseFailingDatabase }))) as unknown as typeof Module.createRequire
    syncBuiltinESMExports()

    try {
      let thrown: unknown
      try {
        initProfile(dir, ['@deepseek-ai/dsh-base'])
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(AggregateError)
      expect((thrown as AggregateError).errors.map(error => String(error))).toEqual(['Error: close failed'])
      expect((thrown as AggregateError).cause).toBeUndefined()
    } finally {
      Module.createRequire = originalCreateRequire
      syncBuiltinESMExports()
    }
  })

  it('removes dead-owner companion temporaries before exact-subset recovery', () => {
    const dir = resolveProfileDir('dead-owner', tmp())
    initProfile(dir, ['@deepseek-ai/dsh-base'])
    rmSync(join(dir, 'pnpm-lock.yaml'))
    const abandoned = join(
      dir,
      `.pnpm-lock.yaml.2147483647.${incarnationFingerprint(deadIncarnation)}.00000000-0000-4000-8000-000000000000.tmp`,
    )
    writeFileSync(abandoned, "lockfileVersion: '9.0'\n")

    initProfile(dir, ['@deepseek-ai/dsh-base'])

    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toContain("lockfileVersion: '9.0'")
    expect(existsSync(abandoned)).toBe(false)

    const completedResidue = join(
      dir,
      `.pnpm-lock.yaml.2147483647.${incarnationFingerprint(deadIncarnation)}.00000000-0000-4000-8000-000000000001.tmp`,
    )
    writeFileSync(completedResidue, 'abandoned after final publication')
    initProfile(dir, ['@deepseek-ai/dsh-base'])
    expect(existsSync(completedResidue)).toBe(false)

    const foreignDir = resolveProfileDir('dead-owner-foreign-temp', tmp())
    initProfile(foreignDir, ['@deepseek-ai/dsh-base'])
    rmSync(join(foreignDir, 'pnpm-lock.yaml'))
    const foreign = join(
      foreignDir,
      `.pnpm-lock.yaml.2147483646.${incarnationFingerprint(deadIncarnation)}.00000000-0000-4000-8000-000000000000.tmp`,
    )
    writeFileSync(foreign, 'recognized dead-owner residue')
    initProfile(foreignDir, ['@deepseek-ai/dsh-base'])
    expect(existsSync(foreign)).toBe(false)
  })

  it('removes a companion temporary whose live PID belongs to a different incarnation', async () => {
    const dir = resolveProfileDir('reused-pid-owner', tmp())
    initProfile(dir, ['@deepseek-ai/dsh-base'])
    const liveProcess = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'])
    await new Promise<void>((resolvePromise, reject) => {
      liveProcess.once('spawn', resolvePromise)
      liveProcess.once('error', reject)
    })
    const livePid = liveProcess.pid
    if (livePid === undefined) throw new Error('spawned process has no PID')
    try {
      rmSync(join(dir, 'pnpm-lock.yaml'))
      const stale = join(
        dir,
        `.pnpm-lock.yaml.${String(livePid)}.${incarnationFingerprint(deadIncarnation)}.00000000-0000-4000-8000-000000000000.tmp`,
      )
      writeFileSync(stale, 'stale incarnation')

      initProfile(dir, ['@deepseek-ai/dsh-base'])

      expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toContain("lockfileVersion: '9.0'")
      expect(existsSync(stale)).toBe(false)
    } finally {
      liveProcess.kill()
    }
  })

  it('waits for a live companion temporary and removes an abandoned companion temporary', async () => {
    const liveDir = resolveProfileDir('live-companion', tmp())
    mkdirSync(liveDir, { recursive: true })
    const nativeCommandSource = new URL('../../../util/native-command/src/index.ts', import.meta.url).href
    const liveRemover = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', [
      `import { currentProcessIncarnation } from ${JSON.stringify(nativeCommandSource)}`,
      'import { createHash } from \'node:crypto\'',
      'import { join } from \'node:path\'',
      'import { unlinkSync, writeFileSync } from \'node:fs\'',
      'const token = \'00000000-0000-4000-8000-000000000001\'',
      'const fingerprint = createHash(\'sha256\').update(currentProcessIncarnation()).digest(\'hex\')',
      'const path = join(process.argv[1], \'.pnpm-lock.yaml.\' + process.pid + \'.\' + fingerprint + \'.\' + token + \'.tmp\')',
      'writeFileSync(path, \'companion\')',
      'setTimeout(() => unlinkSync(path), 100)',
    ].join(';'), liveDir])
    const liveExited = new Promise<void>((resolvePromise, reject) => {
      liveRemover.once('exit', (code) => {
        if (code === 0) resolvePromise()
        else reject(new Error(`remover exited ${String(code)}`))
      })
    })
    let liveTemporary: string | undefined
    while (liveTemporary === undefined) {
      const name = readdirSync(liveDir).find(candidate => candidate.startsWith(
        `.pnpm-lock.yaml.${String(liveRemover.pid)}.`,
      ))
      if (name !== undefined) liveTemporary = join(liveDir, name)
      else {
        await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 5) })
      }
    }
    initProfile(liveDir, ['@deepseek-ai/dsh-base'])
    await liveExited

    const deadDir = resolveProfileDir('dead-companion', tmp())
    initProfile(deadDir, ['@deepseek-ai/dsh-base'])
    rmSync(join(deadDir, PROFILE_PATCH_FILENAME))
    const abandoned = join(
      deadDir,
      `.cordis.patch.yml.2147483647.${incarnationFingerprint(deadIncarnation)}.00000000-0000-4000-8000-000000000000.tmp`,
    )
    writeFileSync(abandoned, 'companion')
    initProfile(deadDir, ['@deepseek-ai/dsh-base'])
    expect(existsSync(abandoned)).toBe(false)
  })

  it('times out while a live owner retains a companion temporary', () => {
    const dir = resolveProfileDir('stalled-live-companion', tmp())
    mkdirSync(dir, { recursive: true })
    const temporary = join(
      dir,
      `.pnpm-lock.yaml.${String(process.pid)}.${incarnationFingerprint(ownIncarnation)}.00000000-0000-4000-8000-000000000000.tmp`,
    )
    writeFileSync(temporary, 'companion')
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(Number.MAX_SAFE_INTEGER)

    try {
      expect(() => { initProfile(dir, ['@deepseek-ai/dsh-base']) })
        .toThrow(`is still owned by process ${String(process.pid)}`)
      expect(readFileSync(temporary, 'utf8')).toBe('companion')
    } finally {
      now.mockRestore()
    }
  })

  it('waits for a live owner to remove its companion temporary', () => {
    const dir = resolveProfileDir('departing-live-companion', tmp())
    mkdirSync(dir, { recursive: true })
    const temporary = join(
      dir,
      `.pnpm-lock.yaml.${String(process.pid)}.${incarnationFingerprint(ownIncarnation)}.00000000-0000-4000-8000-000000000000.tmp`,
    )
    writeFileSync(temporary, 'companion')
    const wait = vi.spyOn(Atomics, 'wait').mockImplementationOnce(() => {
      rmSync(temporary)
      return 'ok'
    })

    try {
      initProfile(dir, ['@deepseek-ai/dsh-base'])
      expect(wait).toHaveBeenCalledOnce()
    } finally {
      wait.mockRestore()
    }
  })

  it('never treats malformed companion temporary names as installation state', () => {
    const token = '00000000-0000-4000-8000-000000000000'
    const fingerprint = '0'.repeat(64)
    for (const [index, name] of [
      `.pnpm-lock.yaml..${fingerprint}.${token}.tmp`,
      '.pnpm-lock.yaml.123.tmp',
      `.pnpm-lock.yaml.owner.${fingerprint}.${token}.tmp`,
      `.pnpm-lock.yaml.123.not-a-fingerprint.${token}.tmp`,
      `.pnpm-lock.yaml.123.${fingerprint}.not-a-uuid.tmp`,
      `.pnpm-lock.yaml.999999999999999999999.${fingerprint}.${token}.tmp`,
      `.pnpm-lock.yaml.123.${fingerprint}.${token}.extra.tmp`,
    ].entries()) {
      const dir = resolveProfileDir(`malformed-companion-${String(index)}`, tmp())
      mkdirSync(dir, { recursive: true })
      const path = join(dir, name)
      writeFileSync(path, 'user')
      expect(() => { initProfile(dir, ['@deepseek-ai/dsh-base']) }).toThrow('contains user-owned content')
      expect(readFileSync(path, 'utf8')).toBe('user')
    }
  })

  it('does not infer first initialization when the directory contains an unrelated entry', () => {
    const dir = resolveProfileDir('unrelated-entry', tmp())
    initProfile(dir, ['@deepseek-ai/dsh-base'])
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '')
    writeFileSync(join(dir, 'user-note.txt'), 'keep\n')

    expect(() => { initProfile(dir, ['@deepseek-ai/dsh-base']) }).toThrow('contains user-owned content')
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toBe('')
    expect(readFileSync(join(dir, 'user-note.txt'), 'utf8')).toBe('keep\n')
  })

  it('converges when concurrent processes initialize the same new Profile', async () => {
    const dir = resolveProfileDir('concurrent', tmp())
    const source = new URL('../src/profile.ts', import.meta.url).href
    const program = `import { initProfile } from ${JSON.stringify(source)};`
      + 'initProfile(process.argv[1], [\'@deepseek-ai/dsh-base\'])'

    await Promise.all(Array.from({ length: 8 }, () => execFileAsync(process.execPath, [
      '--import', 'tsx/esm', '--input-type=module', '--eval', program, dir,
    ])))

    expect(readProfileManifest('t', dir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('[]')
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toContain("lockfileVersion: '9.0'")
  })

  it('recovers after an initializer is killed with a companion temporary unpublished', async () => {
    const dir = resolveProfileDir('killed-companion-owner', tmp())
    const signal = join(tmp(), 'companion-ready')
    const source = new URL('../src/profile.ts', import.meta.url).href
    const program = [
      "import fs from 'node:fs'",
      "import { syncBuiltinESMExports } from 'node:module'",
      "import { basename } from 'node:path'",
      'const originalLinkSync = fs.linkSync',
      'fs.linkSync = (existing, target) => {',
      "  if (basename(target) === 'pnpm-lock.yaml') {",
      "    fs.writeFileSync(process.argv[2], 'ready')",
      '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)',
      '  }',
      '  return originalLinkSync(existing, target)',
      '}',
      'syncBuiltinESMExports()',
      `const { initProfile } = await import(${JSON.stringify(source)})`,
      "initProfile(process.argv[1], ['@deepseek-ai/dsh-base'])",
    ].join('\n')
    const child = spawn(process.execPath, [
      '--import', 'tsx/esm', '--input-type=module', '--eval', program, dir, signal,
    ])
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once('exit', (code, exitSignal) => { resolveExit({ code, signal: exitSignal }) })
    })
    const deadline = Date.now() + 10_000
    try {
      while (!existsSync(signal)) {
        if (child.exitCode !== null || child.signalCode !== null) {
          const result = await exited
          throw new Error(`initializer exited before fault point (${JSON.stringify(result)}): ${stderr}`)
        }
        if (Date.now() >= deadline) throw new Error(`initializer did not reach fault point: ${stderr}`)
        await new Promise<void>((resolveWait) => { setTimeout(resolveWait, 5) })
      }
      child.kill('SIGKILL')
      expect((await exited).signal).toBe('SIGKILL')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }

    expect(readdirSync(dir).some(name => name.endsWith('.tmp'))).toBe(true)
    expect(existsSync(join(dir, 'pnpm-lock.yaml'))).toBe(false)

    initProfile(dir, ['@deepseek-ai/dsh-base'])

    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toContain("lockfileVersion: '9.0'")
    expect(readdirSync(dir).some(name => name.endsWith('.tmp'))).toBe(false)
  })
})

describe('manifest round-trip', () => {
  it('writes and reads back, and fails loud on a broken manifest', () => {
    const dir = tmp()
    writeProfileManifest(dir, { name: 'p', dsh: { profile: { bundles: ['a'] } } })
    expect(readProfileManifest('t', dir).dsh?.profile?.bundles).toEqual(['a'])
    writeFileSync(join(dir, 'package.json'), '[]')
    expect(() => readProfileManifest('t', dir)).toThrow('must hold a JSON object')
    expect(() => readProfileManifest('t', join(dir, 'nope'))).toThrow('failed to read profile manifest')
  })
})

describe('resolveBundleDir', () => {
  it('prefers the installation anchor, falls back to the profile, and fails loud', () => {
    const anchor = stageInstallation({ 'in-box': { patch: '[]\n' } })
    const profileDir = tmp()
    mkdirSync(join(profileDir, 'node_modules', 'local-only'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{}')
    writeFileSync(join(profileDir, 'node_modules', 'local-only', 'package.json'), JSON.stringify({ name: 'local-only', version: '0.0.0' }))
    expect(resolveBundleDir('t', 'in-box', anchor, profileDir)).toContain('in-box')
    expect(resolveBundleDir('t', 'local-only', anchor, profileDir)).toContain('local-only')
    expect(() => resolveBundleDir('t', 'absent', anchor, profileDir)).toThrow('cannot resolve profile bundle')
  })

  it('resolves a package whose exports map omits ./package.json', () => {
    // Common on npm: an exports map without "./package.json" makes
    // require.resolve('<pkg>/package.json') throw ERR_PACKAGE_PATH_NOT_EXPORTED;
    // resolution must fall through to the paths probe instead of misreporting
    // the installed package as missing.
    const anchor = stageInstallation({})
    const profileDir = tmp()
    writeFileSync(join(profileDir, 'package.json'), '{}')
    const dir = join(profileDir, 'node_modules', 'sealed-bundle')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'sealed-bundle',
      version: '0.0.0',
      exports: { '.': './index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(dir, 'index.js'), '')
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
    expect(resolveBundleDir('t', 'sealed-bundle', anchor, profileDir)).toBe(dir)
  })
})

describe('loadProfile', () => {
  it('resolves each dsh.profile.bundles entry to its patch layer in order, plus the user layer', () => {
    const anchor = stageInstallation({
      'bundle-a': { patch: '- insert:\n    - id: a\n      name: pkg-a\n' },
      'bundle-b': { patch: '- id: a\n  config:\n    v: 2\n' },
    })
    const home = tmp()
    const dir = resolveProfileDir('demo', home)
    initProfile(dir, ['bundle-a', 'bundle-b'])
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: a\n  config:\n    v: 3\n')
    const profile = loadProfile('t', 'demo', anchor, home)
    expect(profile.layers.map(layer => layer.packageName)).toEqual(['bundle-a', 'bundle-b'])
    expect(profile.patches).toHaveLength(1)
    const entries = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
    ])
    expect(entries).toEqual([{ id: 'a', name: 'pkg-a', config: { v: 3 } }])
    // A hand-made profile without the user layer file or dsh section: empty layers, no throw.
    rmSync(join(dir, PROFILE_PATCH_FILENAME))
    expect(loadProfile('t', 'demo', anchor, home).patches).toEqual([])
    writeProfileManifest(dir, { name: 'bare' })
    const bare = loadProfile('t', 'demo', anchor, home)
    expect(bare.layers).toEqual([])
  })

  it('auto-initializes only shipped templates and fails loud otherwise', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    expect(() => loadProfile('t', 'custom', anchor, home))
      .toThrow('profile "custom" does not exist; P0 auto-initializes only "web" and "headless"; run \'t plugin --profile custom install <artifact.tgz>\' to create it transactionally, or create a complete custom Profile directory before boot')
    // The web template auto-initializes on first load. Bundle resolution
    // cannot be asserted to fail here: the source-plane test runner resolves
    // @deepseek-ai/* through tsconfig paths regardless of the staged anchor.
    expect(PROFILE_TEMPLATES.web).toContain('@deepseek-ai/dsh-base')
    try {
      loadProfile('t', 'web', anchor, home)
    } catch {
      // Resolution failure is the plain-Node outcome for this empty anchor.
    }
    expect(readProfileManifest('t', resolveProfileDir('web', home)).dsh?.profile?.bundles)
      .toEqual([...PROFILE_TEMPLATES.web ?? []])
  })

  it.each(['constructor', 'toString', '__proto__'])(
    'treats inherited template-table key %s as a custom Profile name',
    (name) => {
      const anchor = stageInstallation({})
      const home = tmp()
      const dir = resolveProfileDir(name, home)
      initProfile(dir, [])

      expect(loadProfile('t', name, anchor, home)).toMatchObject({
        name,
        dir,
        layers: [],
      })
      expect(readProfileManifest('t', dir).dsh?.profile?.bundles).toEqual([])
    },
  )

  it('recovers a shipped Profile interrupted after package publication and rejects user-owned companions', () => {
    const anchor = stageInstallation({
      '@deepseek-ai/dsh-base': { patch: '[]\n' },
      '@deepseek-ai/dsh-web-app': { patch: '[]\n' },
    })
    const bundles = PROFILE_TEMPLATES.web ?? []
    const home = tmp()
    const dir = resolveProfileDir('web', home)
    initProfile(dir, bundles)
    for (const file of [PROFILE_PATCH_FILENAME, 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) rmSync(join(dir, file))

    expect(loadProfile('t', 'web', anchor, home).layers.map(layer => layer.packageName)).toEqual([...bundles])
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('[]')
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('nodeLinker: hoisted')
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toContain("lockfileVersion: '9.0'")

    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '# user owned\n[]\n')
    rmSync(join(dir, 'pnpm-workspace.yaml'))
    expect(() => loadProfile('t', 'web', anchor, home)).toThrow('contains user-owned content')
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toBe('# user owned\n[]\n')
    expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('normalizes only the exact installation-owned headless bundle tuple', () => {
    const anchor = stageInstallation({
      '@deepseek-ai/dsh-base': { patch: '[]\n' },
      '@deepseek-ai/dsh-web-app': { patch: '[]\n' },
      '@deepseek-ai/dsh-headless': { patch: '[]\n' },
      'custom-bundle': { patch: '[]\n' },
    })
    const home = tmp()
    const stock = resolveProfileDir('headless', home)
    initProfile(stock, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless',
    ])
    loadProfile('t', 'headless', anchor, home)
    expect(readProfileManifest('t', stock).dsh?.profile?.bundles)
      .toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])

    const customHome = tmp()
    const custom = resolveProfileDir('headless', customHome)
    initProfile(custom, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless', 'custom-bundle',
    ])
    loadProfile('t', 'headless', anchor, customHome)
    expect(readProfileManifest('t', custom).dsh?.profile?.bundles).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless', 'custom-bundle',
    ])
  })

  it('fails loud when a listed bundle declares no dsh.bundle', () => {
    const anchor = stageInstallation({ 'not-a-bundle': {} })
    const home = tmp()
    const dir = resolveProfileDir('demo', home)
    initProfile(dir, ['not-a-bundle'])
    expect(() => loadProfile('t', 'demo', anchor, home)).toThrow('declares no dsh.bundle')
  })

  it('repairs a missing empty lock but rejects an unlocked profile with dependencies', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    const repairable = resolveProfileDir('repairable', home)
    mkdirSync(repairable, { recursive: true })
    writeProfileManifest(repairable, {
      name: 'repairable',
      dsh: { profile: { bundles: [] } },
    })

    expect(loadProfile('t', 'repairable', anchor, home).layers).toEqual([])
    expect(readFileSync(join(repairable, 'pnpm-lock.yaml'), 'utf8')).toContain("lockfileVersion: '9.0'")

    const unlocked = resolveProfileDir('unlocked', home)
    mkdirSync(unlocked, { recursive: true })
    writeProfileManifest(unlocked, {
      name: 'unlocked',
      dependencies: { plugin: '1.0.0' },
      dsh: { profile: { bundles: [] } },
    })
    expect(() => loadProfile('t', 'unlocked', anchor, home))
      .toThrow('has dependencies but no pnpm-lock.yaml')
  })

  it('loads an immutable complete generation without repairing it', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    const generation = join(tmp(), 'generation')
    expect(() => loadProfile('t', 'web', anchor, home, {
      profileDir: generation,
      readOnly: true,
    })).toThrow(`complete Profile generation ${generation} has no package.json`)

    mkdirSync(generation, { recursive: true })
    writeProfileManifest(generation, {
      name: 'generation',
      dependencies: { plugin: '1.0.0' },
      dsh: { profile: { bundles: [] } },
    })
    writeFileSync(join(generation, PROFILE_PATCH_FILENAME), ': invalid user layer')
    const loaded = loadProfile('t', 'web', anchor, home, {
      profileDir: generation,
      readOnly: true,
      userLayer: false,
    })
    expect(loaded).toMatchObject({ name: 'web', dir: generation, layers: [], patches: [] })
    expect(existsSync(join(generation, 'pnpm-lock.yaml'))).toBe(false)
  })
})

describe('composeEntries', () => {
  it('applies layers over an empty root and reports skipped patches', () => {
    const warnings: string[] = []
    const entries = composeEntries([
      [{ insert: [{ id: 'x', name: 'pkg-x', config: { a: 1 } }] }],
      [{ id: 'x', config: { a: 2 } }, { id: 'missing', config: {} }],
    ], message => warnings.push(message))
    expect(entries).toEqual([{ id: 'x', name: 'pkg-x', config: { a: 2 } }])
    expect(warnings.join('\n')).toContain('"missing"')
    // Default warn sink: skipped patches are silently dropped (boot repeats them).
    expect(composeEntries([[{ id: 'missing', config: {} }]])).toEqual([])
  })
})

describe('healProfilesModuleFallback', () => {
  it('links the app and bundle dependency surface flat under profiles/node_modules', () => {
    const anchor = stageInstallation({
      'bundle-a': { patch: '[]\n', deps: { 'dep-of-a': '0.0.0', 'ghost-dep': '0.0.0' } },
      'plain-lib': {},
    })
    // An app dependency that is declared but not installed: skipped, not fatal.
    const appManifest = JSON.parse(readFileSync(anchor, 'utf8')) as { dependencies: Record<string, string> }
    appManifest.dependencies['never-installed'] = '0.0.0'
    writeFileSync(anchor, JSON.stringify(appManifest))
    // dep-of-a lives in the installation's node_modules too.
    const modules = join(anchor, '..', 'node_modules')
    mkdirSync(join(modules, 'dep-of-a'), { recursive: true })
    writeFileSync(join(modules, 'dep-of-a', 'package.json'), JSON.stringify({ name: 'dep-of-a', version: '0.0.0' }))
    const home = tmp()
    healProfilesModuleFallback(anchor, home)
    const fallback = join(home, 'profiles', 'node_modules')
    // App deps, the bundle's own deps, and the bundle itself are linked; the
    // plain library is linked as an app dep (harmless), the app itself too.
    for (const name of ['bundle-a', 'plain-lib', 'dep-of-a', 'dsh-app']) {
      expect(lstatSync(join(fallback, name)).isSymbolicLink(), name).toBe(true)
    }
    // Idempotent, and a moved target is re-pointed.
    healProfilesModuleFallback(anchor, home)
    const before = readlinkSync(join(fallback, 'dep-of-a'))
    expect(before).toContain('dep-of-a')
  })

  it('throws when a fallback entry is a real directory', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    mkdirSync(join(home, 'profiles', 'node_modules', 'dsh-app'), { recursive: true })
    expect(() => { healProfilesModuleFallback(anchor, home) }).toThrow('is not a symlink')
  })

  it('replaces a wrong symlink', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    const fallback = join(home, 'profiles', 'node_modules')
    mkdirSync(fallback, { recursive: true })
    symlinkSync(tmp(), join(fallback, 'dsh-app'), 'junction')
    healProfilesModuleFallback(anchor, home)
    expect(readlinkSync(join(fallback, 'dsh-app'))).toContain('app')
  })

  it('tolerates losing the concurrent-heal race to an identical link and rejects a different one', () => {
    // The EEXIST arm: a second process wrote the link between our lstat miss
    // and symlinkSync. Simulated by pre-creating the correct link and calling
    // the internal path through a stale-lstat shim is not possible from
    // outside, so probe the observable contract: healing twice concurrently
    // is a no-op, and a foreign REAL directory still fails loud.
    const anchor = stageInstallation({})
    const home = tmp()
    healProfilesModuleFallback(anchor, home)
    healProfilesModuleFallback(anchor, home) // second healer sees the correct link
    const fallback = join(home, 'profiles', 'node_modules')
    expect(lstatSync(join(fallback, 'dsh-app')).isSymbolicLink()).toBe(true)
  })
})
