import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { boot, PROFILE_TEMPLATES, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import {
  profileContentDigest,
  profileId,
  profileMutationId,
  profileTreeDigest,
  type ProfileGenerationId,
  type ProfileSnapshot,
} from '@deepseek-ai/dsh-profile-transactions'
import LocalProfileTransactions, { digestProfileTree } from '@deepseek-ai/dsh-profile-transactions-local'
import { execa } from 'execa'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acknowledgeProfileBoot,
  type ProfileTransactionConsumer,
} from '../src/profile-transactions.ts'
import {
  prepareTransactionalProfile,
  profilePatchesForReload,
  profilePatchIsReloadable,
} from '../src/profile-boot.ts'

const profileTransactionMocks = vi.hoisted(() => ({
  open: vi.fn<(name: string) => Promise<ProfileTransactionConsumer>>(),
}))

vi.mock('../src/profile-transactions.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/profile-transactions.ts')>()
  profileTransactionMocks.open.mockImplementation(name => actual.openProfileTransactionConsumer(name))
  return { ...actual, openProfileTransactionConsumer: profileTransactionMocks.open }
})

const cleanups: Array<() => Promise<void>> = []
const TEST_INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))
const PROFILE_BOOT_SOURCE = fileURLToPath(new URL('../src/profile-boot.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

class StagedProfileFixtureTransactions extends LocalProfileTransactions {
  protected override validateCandidate(): Promise<void> {
    return Promise.resolve()
  }
}

afterEach(async () => {
  profileTransactionMocks.open.mockClear()
  while (cleanups.length > 0) await cleanups.pop()!()
})

function digest(value: string) {
  return profileContentDigest(`sha256:${createHash('sha256').update(value).digest('hex')}`)
}

describe('CLI Profile transaction bootstrap', () => {
  it('disposes an active tree and private root when real watcher setup fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-profile-watcher-failure-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const profileDir = join(home, 'profiles', 'watcher-failure')
    const disposedMarker = join(home, 'disposed')
    await mkdir(profileDir, { recursive: true })
    await Promise.all([
      writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-watcher-failure',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [] } },
      }, null, 2)}\n`),
      writeFile(join(profileDir, 'cordis.patch.yml'), [
        '- insert:',
        '    - id: watcher-setup-failure',
        "      name: './watcher-setup-failure.mjs'",
        '',
      ].join('\n')),
      writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nautoInstallPeers: false\n'),
      writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\nsettings:\n  autoInstallPeers: false\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    dependencies: {}\npackages: {}\nsnapshots: {}\n'),
      writeFile(join(profileDir, 'watcher-setup-failure.mjs'), [
        "import { writeFileSync } from 'node:fs'",
        'export function apply(ctx) {',
        "  ctx.provide('hmr', { registerConfig: () => Promise.reject(new Error('fixture watcher setup failed')) })",
        "  ctx.effect(() => () => { writeFileSync(process.env.WATCHER_DISPOSED_MARKER, 'disposed') })",
        '}',
        '',
      ].join('\n')),
    ])

    const program = `
      import { existsSync, readdirSync } from 'node:fs'
      import { join } from 'node:path'
      const { runProfile } = await import(${JSON.stringify(pathToFileURL(PROFILE_BOOT_SOURCE).href)})
      const failure = await runProfile({
        environment: { get: () => undefined, getFrom: () => undefined },
        profile: 'watcher-failure',
        patchFiles: [],
        args: [],
      }).then(() => undefined, error => error)
      if (!(failure instanceof Error) || !failure.message.includes('fixture watcher setup failed')) {
        throw new Error('watcher setup did not preserve its primary failure')
      }
      if (!existsSync(process.env.WATCHER_DISPOSED_MARKER)) {
        throw new Error('watcher setup failure left the active Profile tree mounted')
      }
      const residues = readdirSync(join(process.env.DSH_HOME, 'profiles'))
        .filter(name => name.startsWith('.dsh-runtime-'))
      if (residues.length !== 0) throw new Error('watcher setup failure left a private runtime root')
      process.stdout.write('watcher-cleanup-ok')
      process.exit(0)
    `
    const result = await execa(process.execPath, [
      '--import', import.meta.resolve('tsx/esm'), '--input-type=module', '--eval', program,
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, DSH_HOME: home, WATCHER_DISPOSED_MARKER: disposedMarker },
      reject: false,
      timeout: 30_000,
      killSignal: 'SIGKILL',
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('watcher-cleanup-ok')
    expect(result.stderr).toBe('')
  })

  it.each(['web', 'headless'] as const)(
    'initializes the shipped %s Profile before its first transaction snapshot',
    async (name) => {
      const home = await mkdtemp(join(tmpdir(), `dsh-profile-first-${name}-`))
      cleanups.push(() => rm(home, { recursive: true, force: true }))
      const previousHome = process.env.DSH_HOME
      process.env.DSH_HOME = home
      cleanups.push(() => {
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
        return Promise.resolve()
      })

      const prepared = await prepareTransactionalProfile(name)
      try {
        const dir = resolveProfileDir(name, home)
        const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
          readonly dsh?: { readonly profile?: { readonly bundles?: readonly string[] } }
        }
        expect(manifest.dsh?.profile?.bundles).toEqual(PROFILE_TEMPLATES[name])
        expect(prepared.profile.dir).toBe(dir)
        expect(prepared.snapshot).toMatchObject({
          revision: 0,
          effectivePath: dir,
          activeGeneration: null,
          lastGoodGeneration: null,
          rollbackGeneration: null,
          bootStatus: 'live',
        })
      } finally {
        prepared.releaseRootConfig()
        await prepared.transactionConsumer.close()
      }
    },
  )

  it('preserves a live private root and recovers dead and PID-reused owners after SIGKILL', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-profile-runtime-recovery-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    cleanups.push(() => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      return Promise.resolve()
    })
    const name = 'runtime-recovery'
    const profilesDir = join(home, 'profiles')
    const profileDir = join(profilesDir, name)
    await mkdir(profileDir, { recursive: true })
    await Promise.all([
      writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
        name: `dsh-profile-${name}`,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [] } },
      }, null, 2)}\n`),
      writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n'),
      writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nautoInstallPeers: false\n'),
      writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\nsettings:\n  autoInstallPeers: false\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    dependencies: {}\npackages: {}\nsnapshots: {}\n'),
    ])
    const reusedPidRoot = join(
      profilesDir,
      `.dsh-runtime-${String(process.pid)}.${'0'.repeat(64)}.00000000-0000-4000-8000-000000000000`,
    )
    await mkdir(reusedPidRoot)
    const ready = join(home, 'runtime-root-ready')
    const program = [
      "import { writeFileSync } from 'node:fs'",
      "import { dirname } from 'node:path'",
      `const { prepareTransactionalProfile } = await import(${JSON.stringify(pathToFileURL(PROFILE_BOOT_SOURCE).href)})`,
      `const prepared = await prepareTransactionalProfile(${JSON.stringify(name)})`,
      `writeFileSync(${JSON.stringify(ready)}, dirname(prepared.rootConfig))`,
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)',
    ].join('\n')
    const child = execa(process.execPath, [
      '--import', import.meta.resolve('tsx/esm'), '--input-type=module', '--eval', program,
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, DSH_HOME: home },
      reject: false,
      timeout: 30_000,
      killSignal: 'SIGKILL',
    })
    const deadline = Date.now() + 10_000
    let childSettled = false
    try {
      while (!existsSync(ready)) {
        if ((child.nodeChildProcess.exitCode ?? null) !== null
          || (child.nodeChildProcess.signalCode ?? null) !== null) {
          throw new Error('private-root owner exited before publishing its ready marker')
        }
        if (Date.now() >= deadline) throw new Error('private-root owner did not publish its ready marker')
        await new Promise<void>((resolveWait) => { setTimeout(resolveWait, 10) })
      }
      const childRoot = await readFile(ready, 'utf8')
      expect((await lstat(childRoot)).isDirectory()).toBe(true)

      const concurrent = await prepareTransactionalProfile(name)
      try {
        expect((await lstat(childRoot)).isDirectory()).toBe(true)
        await expect(lstat(reusedPidRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        concurrent.releaseRootConfig()
        await concurrent.transactionConsumer.close()
      }

      child.kill('SIGKILL')
      await child
      childSettled = true
      expect((await lstat(childRoot)).isDirectory()).toBe(true)

      const recovered = await prepareTransactionalProfile(name)
      try {
        await expect(lstat(childRoot)).rejects.toMatchObject({ code: 'ENOENT' })
        expect((await lstat(dirname(recovered.rootConfig))).isDirectory()).toBe(true)
      } finally {
        recovered.releaseRootConfig()
        await recovered.transactionConsumer.close()
      }
    } finally {
      if (!childSettled) {
        child.kill('SIGKILL')
        await child
      }
    }
  }, 30_000)

  it('reloads an immutable generation selected while a live Profile is loading', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-profile-boot-race-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    cleanups.push(() => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      return Promise.resolve()
    })

    const profile = profileId('web')
    const liveDir = join(home, 'profiles', 'web')
    const activeDir = join(home, 'immutable-generation')
    const liveMarker = join(home, 'live-loaded')
    const activeMarker = join(home, 'active-loaded')
    const manifest = `${JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, null, 2)}\n`
    const workspace = 'packages:\n  - .\nautoInstallPeers: false\n'
    const lockfile = 'lockfileVersion: \'9.0\'\nsettings:\n  autoInstallPeers: false\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    dependencies: {}\npackages: {}\nsnapshots: {}\n'
    const livePatch = '- insert:\n    - id: selected-root\n      name: \'./live-plugin.mjs\'\n'
    const activePatch = '- insert:\n    - id: selected-root\n      name: \'./active-plugin.mjs\'\n'
    await Promise.all([
      mkdir(liveDir, { recursive: true }),
      mkdir(activeDir, { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(liveDir, 'package.json'), manifest),
      writeFile(join(liveDir, 'cordis.patch.yml'), livePatch),
      writeFile(join(liveDir, 'pnpm-workspace.yaml'), workspace),
      writeFile(join(liveDir, 'pnpm-lock.yaml'), lockfile),
      writeFile(join(liveDir, 'live-plugin.mjs'), [
        "import { writeFileSync } from 'node:fs'",
        `export function apply() { writeFileSync(${JSON.stringify(liveMarker)}, 'live') }`,
        '',
      ].join('\n')),
      writeFile(join(activeDir, 'package.json'), manifest),
      writeFile(join(activeDir, 'cordis.patch.yml'), activePatch),
      writeFile(join(activeDir, 'pnpm-workspace.yaml'), workspace),
      writeFile(join(activeDir, 'pnpm-lock.yaml'), lockfile),
      writeFile(join(activeDir, 'active-plugin.mjs'), [
        "import { writeFileSync } from 'node:fs'",
        `export function apply() { writeFileSync(${JSON.stringify(activeMarker)}, 'active') }`,
        '',
      ].join('\n')),
    ])

    const liveSnapshot: ProfileSnapshot = {
      profile,
      revision: 0,
      treeDigest: profileTreeDigest(digestProfileTree(liveDir)),
      effectivePath: liveDir,
      activeGeneration: null,
      lastGoodGeneration: null,
      rollbackGeneration: null,
      bootStatus: 'live',
    }
    const activeGeneration = 'race-selected-generation' as ProfileGenerationId
    const activeSnapshot: ProfileSnapshot = {
      profile,
      revision: 1,
      treeDigest: profileTreeDigest(digestProfileTree(activeDir)),
      effectivePath: activeDir,
      activeGeneration,
      lastGoodGeneration: null,
      rollbackGeneration: null,
      bootStatus: 'pending-restart',
    }
    const snapshot = vi.fn()
      .mockResolvedValueOnce(liveSnapshot)
      .mockResolvedValueOnce(activeSnapshot)
      .mockResolvedValueOnce(activeSnapshot)
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const transactionConsumer = {
      profile,
      transactions: { snapshot },
      close,
    } as unknown as ProfileTransactionConsumer
    profileTransactionMocks.open.mockResolvedValueOnce(transactionConsumer)

    const prepared = await prepareTransactionalProfile('web')
    let loaded: Awaited<ReturnType<typeof boot>> | undefined
    try {
      expect(snapshot).toHaveBeenCalledTimes(3)
      expect(prepared.snapshot).toBe(activeSnapshot)
      expect(prepared.profile.dir).not.toBe(activeDir)
      expect(prepared.profile.patchPath).toBe(join(prepared.profile.dir, 'cordis.patch.yml'))
      expect(prepared.rootBaseUrl).toBe(prepared.profile.dir)
      expect(dirname(prepared.rootBaseUrl)).toBe(dirname(prepared.rootConfig))
      loaded = await boot(
        'dsh-profile-boot-race-test',
        prepared.rootConfig,
        prepared.profile.patches,
        undefined,
        undefined,
        prepared.rootBaseUrl,
      )
      expect(await readFile(activeMarker, 'utf8')).toBe('active')
      await expect(readFile(liveMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await loaded?.fiber.dispose()
      prepared.releaseRootConfig()
      await prepared.transactionConsumer.close()
    }
    expect(close).toHaveBeenCalledOnce()
  })

  it('boots the active immutable generation and acknowledges that exact tree', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-profile-boot-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    cleanups.push(() => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      return Promise.resolve()
    })
    const profilesDir = join(home, 'profiles')
    const profileDir = join(profilesDir, 'web')
    const installed = join(profileDir, 'node_modules', 'owned-package')
    await mkdir(installed, { recursive: true })
    await Promise.all([
      writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: { 'owned-package': '1.0.0' },
        dsh: { profile: { bundles: [] } },
      }, null, 2)}\n`),
      writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n'),
      writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nautoInstallPeers: false\n'),
      writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\nsettings:\n  autoInstallPeers: false\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    dependencies:\n      owned-package:\n        specifier: 1.0.0\n        version: 1.0.0\npackages: {}\nsnapshots: {}\n'),
      writeFile(join(installed, 'package.json'), '{"name":"owned-package","version":"1.0.0"}\n'),
    ])

    const marker = join(home, 'relative-entry-loaded')
    const tamperedImportMarker = join(home, 'tampered-generation-imported')
    const nextPatch = '- insert:\n    - id: relative-entry\n      name: \'./relative-plugin.mjs\'\n'
    const relativePlugin = [
      "import { writeFileSync } from 'node:fs'",
      `export function apply() { writeFileSync(${JSON.stringify(marker)}, 'loaded') }`,
      '',
    ].join('\n')
    await writeFile(join(profileDir, 'relative-plugin.mjs'), relativePlugin)
    const owner = new Context()
    const ownerFiber = owner.plugin(StagedProfileFixtureTransactions, {
      profilesDir,
      installAnchor: TEST_INSTALL_ANCHOR,
    })
    await ownerFiber
    const before = await owner.profileTransactions.snapshot(profileId('web'))
    const staged = await owner.profileTransactions.stage({
      profile: before.profile,
      mutationId: profileMutationId('boot-relative-entry'),
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: {
        operation: 'configure',
        packageName: 'owned-package',
        patch: {
          expectedDigest: digest('[]\n'),
          nextUtf8: nextPatch,
          nextDigest: digest(nextPatch),
        },
      },
    })
    const committed = (await owner.profileTransactions.commit({
      profile: before.profile,
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      generation: staged.generation,
    })).after
    await ownerFiber.dispose()
    await owner.fiber.dispose()

    const activePlugin = join(committed.effectivePath, 'relative-plugin.mjs')
    await writeFile(activePlugin, [
      "import { writeFileSync } from 'node:fs'",
      `export function apply() { writeFileSync(${JSON.stringify(marker)}, 'tampered-executed') }`,
      '',
    ].join('\n'))
    await expect(prepareTransactionalProfile('web')).rejects.toThrow(/tree no longer matches its digest/)
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(activePlugin, relativePlugin)

    const externalRoot = join(home, 'external-root.yml')
    await writeFile(externalRoot, 'outside generation\n')
    await symlink(externalRoot, join(committed.effectivePath, 'cordis.yml'))
    const [prepared, concurrent] = await Promise.all([
      prepareTransactionalProfile('web'),
      prepareTransactionalProfile('web'),
    ])
    expect(prepared.snapshot.activeGeneration).toBe(committed.activeGeneration)
    expect(prepared.profile.dir).not.toBe(committed.effectivePath)
    expect(prepared.rootBaseUrl).toBe(prepared.profile.dir)
    expect(dirname(prepared.rootBaseUrl)).toBe(dirname(prepared.rootConfig))
    expect(concurrent.profile.dir).not.toBe(prepared.profile.dir)
    expect(prepared.rootConfig).not.toBe(join(committed.effectivePath, 'cordis.yml'))
    expect(concurrent.rootConfig).not.toBe(prepared.rootConfig)
    expect((await lstat(prepared.rootConfig)).isFile()).toBe(true)
    expect(await readFile(externalRoot, 'utf8')).toBe('outside generation\n')
    expect(await readFile(prepared.profile.patchPath, 'utf8')).toBe(nextPatch)
    const activePatch = join(committed.effectivePath, 'cordis.patch.yml')
    await writeFile(activePatch, '[]\n')
    expect(profilePatchIsReloadable(prepared.snapshot)).toBe(false)
    expect(profilePatchesForReload(prepared.profile, prepared.snapshot)).toEqual(prepared.profile.patches)
    await writeFile(activePatch, nextPatch)
    await writeFile(activePlugin, [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(tamperedImportMarker)}, 'tampered-import')`,
      'export function apply() {}',
      '',
    ].join('\n'))
    let loaded: Awaited<ReturnType<typeof boot>> | undefined
    try {
      loaded = await boot(
        'dsh-profile-boot-test',
        prepared.rootConfig,
        prepared.profile.patches,
        undefined,
        undefined,
        prepared.rootBaseUrl,
      )
      expect(await readFile(marker, 'utf8')).toBe('loaded')
      await expect(readFile(tamperedImportMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(activePlugin, relativePlugin)
      await acknowledgeProfileBoot(prepared.transactionConsumer, prepared.snapshot)
    } finally {
      await writeFile(activePlugin, relativePlugin)
      await loaded?.fiber.dispose()
      await prepared.transactionConsumer.close()
      await concurrent.transactionConsumer.close()
      prepared.releaseRootConfig()
      concurrent.releaseRootConfig()
      prepared.releaseRootConfig()
    }
    await expect(lstat(prepared.rootConfig)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(concurrent.rootConfig)).rejects.toMatchObject({ code: 'ENOENT' })

    const reopened = new Context()
    const reopenedFiber = reopened.plugin(LocalProfileTransactions, {
      profilesDir,
      installAnchor: TEST_INSTALL_ANCHOR,
    })
    await reopenedFiber
    expect(await reopened.profileTransactions.snapshot(profileId('web'))).toMatchObject({
      activeGeneration: committed.activeGeneration,
      lastGoodGeneration: committed.activeGeneration,
      bootStatus: 'verified',
    })
    await reopenedFiber.dispose()
    await reopened.fiber.dispose()
  })
})
