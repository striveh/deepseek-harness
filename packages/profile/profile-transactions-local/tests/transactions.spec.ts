import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import {
  ProfileContentConflictError,
  ProfileMutationConflictError,
  ProfileRevisionConflictError,
  ProfileTransactions,
  ProfileTreeConflictError,
  profileArtifactDigest,
  profileContentDigest,
  profileId,
  profileMutationId,
  type ExactProfileArtifactMutation,
  type ExactProfileMutation,
  type ProfileSnapshot,
} from '@deepseek-ai/dsh-profile-transactions'
import { create } from 'tar'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import LocalProfileTransactions from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []
const TEST_INSTALL_ANCHOR = fileURLToPath(import.meta.url)
const execFileAsync = promisify(execFile)
let mutationSequence = 0

function nextMutationId(label = 'test') {
  mutationSequence += 1
  return profileMutationId(`${label}-${String(mutationSequence)}`)
}
const EMPTY_LOCK = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: false
  excludeLinksFromLockfile: false
importers:
  .:
    dependencies: {}
packages: {}
snapshots: {}
`

let validateCandidate: (generationPath: string) => void | Promise<void> = () => {}

class TestingLocalProfileTransactions extends LocalProfileTransactions {
  protected override async validateCandidate(_profile: string, generationPath: string): Promise<void> {
    await validateCandidate(generationPath)
  }
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

beforeEach(() => {
  validateCandidate = () => {}
  mutationSequence = 0
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-profile-transactions-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function makeProfile(profilesDir: string, name = 'web', bundles: readonly string[] = []): Promise<string> {
  const dir = join(profilesDir, name)
  await mkdir(dir, { recursive: true })
  await Promise.all([
    writeFile(join(dir, 'package.json'), `${JSON.stringify({
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles } },
    }, null, 2)}\n`),
    writeFile(join(dir, 'cordis.patch.yml'), '[]\n'),
    writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nautoInstallPeers: false\n'),
    writeFile(join(dir, 'pnpm-lock.yaml'), EMPTY_LOCK),
  ])
  return dir
}

async function artifact(
  root: string,
  operation: 'install' | 'update',
  version: string,
  options: { kind?: 'package' | 'bundle'; lifecycle?: boolean; packageName?: string } = {},
): Promise<ExactProfileArtifactMutation> {
  const source = join(root, `source-${version}`)
  const packageRoot = join(source, 'package')
  await mkdir(packageRoot, { recursive: true })
  await Promise.all([
    writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: options.packageName ?? '@example/profile-bundle',
      version,
      peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' },
      ...options.lifecycle === true && { scripts: { install: 'touch forbidden' } },
      ...options.kind !== 'package' && { dsh: { bundle: { patch: './cordis.patch.yml' } } },
    }, null, 2)}\n`),
    writeFile(join(packageRoot, 'cordis.patch.yml'), '[]\n'),
    writeFile(join(packageRoot, 'index.js'), 'export const marker = true\n'),
  ])
  const path = join(root, `profile-bundle-${version}.tgz`)
  await create({ cwd: source, file: path, gzip: true, portable: true }, ['package'])
  const bytes = await readFile(path)
  return {
    operation,
    kind: options.kind ?? 'bundle',
    packageName: options.packageName ?? '@example/profile-bundle',
    version,
    artifact: {
      path,
      digest: profileArtifactDigest(`sha256:${createHash('sha256').update(bytes).digest('hex')}`),
    },
  }
}

async function installationBundle(
  root: string,
  packageName: string,
  marker: string,
): Promise<string> {
  const installation = join(root, 'installation')
  const anchor = join(installation, 'package.json')
  const packageRoot = join(installation, 'node_modules', packageName)
  const startup = join(packageRoot, 'startup.mjs')
  await mkdir(packageRoot, { recursive: true })
  await Promise.all([
    writeFile(anchor, '{"name":"fixture-installation","private":true}\n'),
    writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: packageName,
      version: '9.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2)}\n`),
    writeFile(join(packageRoot, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: web-startup',
      `      name: ${JSON.stringify(startup)}`,
      '',
    ].join('\n')),
    writeFile(startup, [
      "import { writeFileSync } from 'node:fs'",
      `export function apply() { writeFileSync(${JSON.stringify(marker)}, 'installation') }`,
      '',
    ].join('\n')),
  ])
  return anchor
}

async function boot(
  profilesDir: string,
  installAnchor: string = TEST_INSTALL_ANCHOR,
): Promise<{ ctx: Context; dispose(): Promise<void> }> {
  const ctx = new Context()
  const fiber = ctx.plugin(TestingLocalProfileTransactions, {
    profilesDir,
    installAnchor,
    lockWaitMs: 5_000,
  })
  await fiber
  return {
    ctx,
    async dispose() {
      await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

async function stageCommit(
  ctx: Context,
  before: ProfileSnapshot,
  mutation: ExactProfileArtifactMutation | { operation: 'uninstall'; packageName: string },
): Promise<ProfileSnapshot> {
  const staged = await ctx.profileTransactions.stage({
    profile: before.profile,
    mutationId: nextMutationId('stage-commit'),
    expectedRevision: before.revision,
    expectedTreeDigest: before.treeDigest,
    mutation,
  })
  return (await ctx.profileTransactions.commit({
    profile: before.profile,
    expectedRevision: before.revision,
    expectedTreeDigest: before.treeDigest,
    generation: staged.generation,
  })).after
}

async function acknowledge(ctx: Context, snapshot: ProfileSnapshot): Promise<ProfileSnapshot> {
  return (await ctx.profileTransactions.acknowledgeBoot({
    profile: snapshot.profile,
    expectedRevision: snapshot.revision,
    expectedTreeDigest: snapshot.treeDigest,
    generation: snapshot.activeGeneration!,
  })).after
}

describe('local complete Profile generation transactions', () => {
  it('publishes a literal protocol revision and rejects same-name or wrong-version probes', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const app = await boot(profilesDir)
    cleanups.push(() => app.dispose())
    const supportsProfileTransactions = (value: unknown): value is ProfileTransactions =>
      value instanceof ProfileTransactions && value.protocolVersion === 1
    expect(supportsProfileTransactions(app.ctx.profileTransactions)).toBe(true)
    expect(supportsProfileTransactions({ name: 'profileTransactions', protocolVersion: 1 })).toBe(false)
    const wrongVersion = Object.create(ProfileTransactions.prototype) as { protocolVersion: number }
    wrongVersion.protocolVersion = 2
    expect(supportsProfileTransactions(wrongVersion)).toBe(false)
  })

  it('rejects a missing, relative, or directory validator install anchor at provider load', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    await mkdir(profilesDir)
    const cases: Array<{ readonly config: unknown; readonly diagnostic: RegExp }> = [
      {
        config: { profilesDir },
        diagnostic: /installAnchor.*required|required.*installAnchor/,
      },
      {
        config: { profilesDir, installAnchor: 'relative/package.json' },
        diagnostic: /installAnchor must be an absolute regular file/,
      },
      {
        config: { profilesDir, installAnchor: root },
        diagnostic: /installAnchor must be an absolute regular file/,
      },
    ]
    for (const { config, diagnostic } of cases) {
      const ctx = new Context()
      await expect(ctx.plugin(LocalProfileTransactions, config as never)).rejects.toThrow(diagnostic)
      await ctx.fiber.dispose()
    }
  })

  it('keeps an unmanaged snapshot read-only and captures the live Profile as the first recovery baseline', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const app = await boot(profilesDir)
    cleanups.push(() => app.dispose())
    const profile = profileId('web')

    const before = await app.ctx.profileTransactions.snapshot(profile)
    expect(before).toMatchObject({ revision: 0, activeGeneration: null, bootStatus: 'live' })
    await expect(access(join(profilesDir, '.dsh-profile-transactions'))).rejects.toThrow()

    let candidatePath = ''
    validateCandidate = async (generationPath) => {
      candidatePath = generationPath
      expect(JSON.parse(await readFile(join(generationPath, 'package.json'), 'utf8'))).toMatchObject({
        dependencies: { '@example/profile-bundle': '1.0.0' },
        dsh: { profile: { bundles: ['@example/profile-bundle'] } },
      })
      expect(await readFile(join(generationPath, 'pnpm-lock.yaml'), 'utf8'))
        .toContain('specifier: 1.0.0')
      expect(await readFile(join(generationPath, 'node_modules/@example/profile-bundle/index.js'), 'utf8'))
        .toContain('marker')
    }
    const staged = await app.ctx.profileTransactions.stage({
      profile,
      mutationId: nextMutationId('baseline'),
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: await artifact(root, 'install', '1.0.0'),
    })
    expect(await app.ctx.profileTransactions.snapshot(profile)).toEqual(before)
    const committed = (await app.ctx.profileTransactions.commit({
      profile,
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      generation: staged.generation,
    })).after
    expect(committed).toMatchObject({
      activeGeneration: staged.generation,
      bootStatus: 'pending-restart',
    })
    expect(typeof committed.lastGoodGeneration).toBe('string')
    expect(committed.lastGoodGeneration).not.toBe(committed.activeGeneration)
    expect(candidatePath).toBe(committed.effectivePath)

    const verified = await acknowledge(app.ctx, committed)
    expect(verified).toMatchObject({
      bootStatus: 'verified',
      lastGoodGeneration: committed.activeGeneration,
      rollbackGeneration: committed.lastGoodGeneration,
    })
  })

  it('coalesces a concurrent mutation key, rejects different input, and projects the active correlation', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const app = await boot(profilesDir)
    cleanups.push(() => app.dispose())
    const profile = profileId('web')
    const before = await app.ctx.profileTransactions.snapshot(profile)
    const mutationId = profileMutationId('concurrent-stage')
    const exactArtifact = await artifact(root, 'install', '1.0.0')
    const request = {
      profile,
      mutationId,
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: exactArtifact,
    } as const
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let validations = 0
    validateCandidate = async () => {
      validations += 1
      entered.resolve(undefined)
      await release.promise
    }
    const firstStage = app.ctx.profileTransactions.stage(request)
    await entered.promise
    const secondStage = app.ctx.profileTransactions.stage(request)
    release.resolve(undefined)
    const [first, second] = await Promise.all([firstStage, secondStage])
    expect(second).toEqual(first)
    expect(validations).toBe(1)

    await expect(app.ctx.profileTransactions.stage({
      ...request,
      mutation: await artifact(root, 'install', '2.0.0'),
    })).rejects.toBeInstanceOf(ProfileMutationConflictError)
    const commitRequest = {
      profile,
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      generation: first.generation,
    } as const
    const committed = await app.ctx.profileTransactions.commit(commitRequest)
    const replayed = await app.ctx.profileTransactions.commit(commitRequest)
    expect(replayed.after).toEqual(committed.after)
    expect((await app.ctx.profileTransactions.list(profile)).active).toMatchObject({
      generation: first.generation,
      mutationId,
    })
  })

  it('durably replays install, update, configure, and uninstall after snapshot fences advance', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const app = await boot(profilesDir)
    cleanups.push(() => app.dispose())
    const profile = profileId('web')
    let validations = 0
    validateCandidate = () => { validations += 1 }

    const replay = async (
      label: string,
      mutation: ExactProfileMutation,
      conflictingMutation: ExactProfileMutation,
      replayMutation: ExactProfileMutation = mutation,
    ) => {
      const before = await app.ctx.profileTransactions.snapshot(profile)
      const mutationId = profileMutationId(`durable-${label}`)
      const staged = await app.ctx.profileTransactions.stage({
        profile,
        mutationId,
        expectedRevision: before.revision,
        expectedTreeDigest: before.treeDigest,
        mutation,
      })
      const receipt = await app.ctx.profileTransactions.commit({
        profile,
        expectedRevision: before.revision,
        expectedTreeDigest: before.treeDigest,
        generation: staged.generation,
      })
      const current = await app.ctx.profileTransactions.snapshot(profile)
      const validationCount = validations
      const replayedStage = await app.ctx.profileTransactions.stage({
        profile,
        mutationId,
        expectedRevision: current.revision,
        expectedTreeDigest: current.treeDigest,
        mutation: replayMutation,
      })
      expect(replayedStage).toEqual(staged)
      expect(validations).toBe(validationCount)
      await expect(app.ctx.profileTransactions.commit({
        profile,
        expectedRevision: current.revision,
        expectedTreeDigest: current.treeDigest,
        generation: replayedStage.generation,
      })).resolves.toEqual(receipt)
      expect((await app.ctx.profileTransactions.snapshot(profile)).revision).toBe(receipt.after.revision)
      await expect(app.ctx.profileTransactions.stage({
        profile,
        mutationId,
        expectedRevision: current.revision,
        expectedTreeDigest: current.treeDigest,
        mutation: conflictingMutation,
      })).rejects.toBeInstanceOf(ProfileMutationConflictError)
      return receipt.after
    }

    const install = await artifact(root, 'install', '1.0.0')
    const installed = await replay('install', install, await artifact(root, 'install', '2.0.0'))
    const installedGeneration = installed.activeGeneration!
    let current = await acknowledge(app.ctx, installed)

    const update = await artifact(root, 'update', '2.0.0')
    current = await replay('update', update, await artifact(root, 'update', '3.0.0'))
    current = await acknowledge(app.ctx, current)

    const oldBytes = await readFile(join(current.effectivePath, 'cordis.patch.yml'), 'utf8')
    const expectedDigest = profileContentDigest(`sha256:${createHash('sha256').update(oldBytes).digest('hex')}`)
    const nextUtf8 = '# durable configure\n[]\n'
    const nextDigest = profileContentDigest(`sha256:${createHash('sha256').update(nextUtf8).digest('hex')}`)
    const configure = {
      operation: 'configure' as const,
      packageName: '@example/profile-bundle',
      patch: { expectedDigest, nextUtf8, nextDigest },
    }
    const conflictingUtf8 = '# conflicting configure\n[]\n'
    current = await replay('configure', configure, {
      ...configure,
      patch: {
        expectedDigest,
        nextUtf8: conflictingUtf8,
        nextDigest: profileContentDigest(
          `sha256:${createHash('sha256').update(conflictingUtf8).digest('hex')}`,
        ),
      },
    }, {
      patch: { nextDigest, nextUtf8, expectedDigest },
      packageName: '@example/profile-bundle',
      operation: 'configure',
    })
    current = await acknowledge(app.ctx, current)

    await expect(app.ctx.profileTransactions.abort({ profile, generation: installedGeneration }))
      .rejects.toThrow(/retained for durable mutation replay/)
    await replay(
      'uninstall',
      { operation: 'uninstall', packageName: '@example/profile-bundle' },
      { operation: 'uninstall', packageName: '@example/not-the-same-package' },
      { packageName: '@example/profile-bundle', operation: 'uninstall' },
    )
  })

  it('owns stage and transition requests before crossing an asynchronous store boundary', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    await Promise.all([makeProfile(profilesDir), makeProfile(profilesDir, 'other')])
    const app = await boot(profilesDir)
    cleanups.push(() => app.dispose())
    const profile = profileId('web')
    const other = profileId('other')
    const before = await app.ctx.profileTransactions.snapshot(profile)
    const originalMutation = await artifact(root, 'install', '1.0.0')
    const mutationId = nextMutationId('owned-stage')
    const stageRequest = {
      profile,
      mutationId,
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: {
        ...originalMutation,
        artifact: { ...originalMutation.artifact },
      },
    }

    const stagePromise = app.ctx.profileTransactions.stage(stageRequest)
    Object.assign(stageRequest, {
      profile: other,
      mutationId: nextMutationId('retargeted-stage'),
      expectedRevision: 99,
    })
    Object.assign(stageRequest.mutation, {
      packageName: '@example/retargeted',
      version: '9.9.9',
    })
    Object.assign(stageRequest.mutation.artifact, {
      path: join(root, 'missing.tgz'),
      digest: profileArtifactDigest(`sha256:${'0'.repeat(64)}`),
    })
    const staged = await stagePromise
    expect(staged).toMatchObject({
      profile,
      mutationId,
      mutation: {
        packageName: '@example/profile-bundle',
        version: '1.0.0',
        artifact: originalMutation.artifact,
      },
    })

    const commitRequest = {
      profile,
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      generation: staged.generation,
    }
    const commitPromise = app.ctx.profileTransactions.commit(commitRequest)
    Object.assign(commitRequest, {
      profile: other,
      expectedRevision: 99,
      generation: '00000000-0000-4000-8000-000000000000',
    })
    const committed = await commitPromise
    expect(committed.after).toMatchObject({ profile, activeGeneration: staged.generation })

    const acknowledgeRequest = {
      profile,
      expectedRevision: committed.after.revision,
      expectedTreeDigest: committed.after.treeDigest,
      generation: staged.generation,
    }
    const acknowledgePromise = app.ctx.profileTransactions.acknowledgeBoot(acknowledgeRequest)
    Object.assign(acknowledgeRequest, {
      profile: other,
      expectedRevision: 99,
      generation: '00000000-0000-4000-8000-000000000000',
    })
    const verified = await acknowledgePromise
    expect(verified.after).toMatchObject({ profile, activeGeneration: staged.generation, bootStatus: 'verified' })

    const disposable = await app.ctx.profileTransactions.stage({
      profile,
      mutationId: nextMutationId('owned-abort'),
      expectedRevision: verified.after.revision,
      expectedTreeDigest: verified.after.treeDigest,
      mutation: { operation: 'uninstall', packageName: '@example/profile-bundle' },
    })
    const abortRequest = { profile, generation: disposable.generation }
    const abortPromise = app.ctx.profileTransactions.abort(abortRequest)
    Object.assign(abortRequest, {
      profile: other,
      generation: '00000000-0000-4000-8000-000000000000',
    })
    await expect(abortPromise).resolves.toBe(true)
    expect((await app.ctx.profileTransactions.list(profile)).staged)
      .not.toContainEqual(expect.objectContaining({ generation: disposable.generation }))

    const replacement = await app.ctx.profileTransactions.stage({
      profile,
      mutationId: nextMutationId('owned-restore-update'),
      expectedRevision: verified.after.revision,
      expectedTreeDigest: verified.after.treeDigest,
      mutation: await artifact(root, 'update', '2.0.0'),
    })
    const pending = (await app.ctx.profileTransactions.commit({
      profile,
      expectedRevision: verified.after.revision,
      expectedTreeDigest: verified.after.treeDigest,
      generation: replacement.generation,
    })).after
    const restoreMutationId = nextMutationId('owned-restore')
    const restoreRequest = {
      profile,
      mutationId: restoreMutationId,
      expectedRevision: pending.revision,
      expectedTreeDigest: pending.treeDigest,
    }
    const restorePromise = app.ctx.profileTransactions.restoreLastGood(restoreRequest)
    Object.assign(restoreRequest, {
      profile: other,
      mutationId: nextMutationId('retargeted-restore'),
      expectedRevision: 99,
    })
    const restored = await restorePromise
    expect(restored).toMatchObject({
      operation: 'restore',
      after: { profile, activeGeneration: staged.generation },
    })
    expect(await app.ctx.profileTransactions.snapshot(other)).toMatchObject({
      revision: 0,
      activeGeneration: null,
    })
  })

  it('updates, uninstalls, and restores complete package, bundle, artifact, and lockfile state', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const app = await boot(profilesDir)
    cleanups.push(() => app.dispose())
    const profile = profileId('web')

    let current = await stageCommit(app.ctx, await app.ctx.profileTransactions.snapshot(profile), await artifact(root, 'install', '1.0.0'))
    current = await acknowledge(app.ctx, current)
    const installedGeneration = current.activeGeneration
    current = await stageCommit(app.ctx, current, await artifact(root, 'update', '2.0.0'))
    current = await acknowledge(app.ctx, current)
    expect(JSON.parse(await readFile(join(current.effectivePath, 'package.json'), 'utf8')))
      .toMatchObject({ dependencies: { '@example/profile-bundle': '2.0.0' } })
    const lock = parse(await readFile(join(current.effectivePath, 'pnpm-lock.yaml'), 'utf8')) as {
      importers: { '.': { dependencies: Record<string, { specifier: string; version: string }> } }
      packages: Record<string, { version: string; resolution: { integrity: string; tarball: string } }>
      snapshots: Record<string, unknown>
    }
    const fileReference = `file:.dsh-artifacts/${Buffer.from('@example/profile-bundle').toString('base64url')}.tgz`
    const packageKey = `@example/profile-bundle@${fileReference}`
    expect(lock.importers['.'].dependencies['@example/profile-bundle']).toEqual({
      specifier: '2.0.0',
      version: fileReference,
    })
    expect(lock.packages[packageKey]).toMatchObject({
      version: '2.0.0',
      resolution: { tarball: fileReference },
    })
    expect(lock.packages[packageKey]?.resolution.integrity).toMatch(/^sha512-/)
    expect(lock.snapshots[packageKey]).toEqual({})

    const updatedGeneration = current.activeGeneration
    current = await stageCommit(app.ctx, current, { operation: 'uninstall', packageName: '@example/profile-bundle' })
    await expect(access(join(current.effectivePath, 'node_modules/@example/profile-bundle'))).rejects.toThrow()
    expect(JSON.parse(await readFile(join(current.effectivePath, 'package.json'), 'utf8'))).toMatchObject({ dependencies: {} })
    const removedLock = parse(await readFile(join(current.effectivePath, 'pnpm-lock.yaml'), 'utf8')) as {
      importers: { '.': { dependencies: Record<string, unknown> } }
      packages: Record<string, unknown>
      snapshots: Record<string, unknown>
    }
    expect(removedLock.importers['.'].dependencies).toEqual({})
    expect(removedLock.packages).toEqual({})
    expect(removedLock.snapshots).toEqual({})

    const restoreMutationId = nextMutationId('restore')
    const restoreRequest = {
      profile,
      mutationId: restoreMutationId,
      expectedRevision: current.revision,
      expectedTreeDigest: current.treeDigest,
    } as const
    await expect(app.ctx.profileTransactions.getRestoreReceipt({
      profile,
      mutationId: restoreMutationId,
    })).resolves.toBeNull()
    await expect(app.ctx.profileTransactions.restoreLastGood({
      ...restoreRequest,
      mutationId: nextMutationId('stale-restore'),
      expectedRevision: restoreRequest.expectedRevision + 1,
    })).rejects.toBeInstanceOf(ProfileRevisionConflictError)
    const restoreReceipt = await app.ctx.profileTransactions.restoreLastGood(restoreRequest)
    const restored = restoreReceipt.after
    await expect(app.ctx.profileTransactions.getRestoreReceipt({
      profile,
      mutationId: restoreMutationId,
    })).resolves.toEqual({
      mutationId: restoreMutationId,
      status: 'committed',
      ...restoreReceipt,
    })
    expect(await app.ctx.profileTransactions.restoreLastGood(restoreRequest)).toEqual(restoreReceipt)
    expect(await app.ctx.profileTransactions.restoreLastGood({
      ...restoreRequest,
      expectedRevision: restored.revision,
      expectedTreeDigest: restored.treeDigest,
    })).toEqual(restoreReceipt)
    expect((await app.ctx.profileTransactions.snapshot(profile)).revision).toBe(restored.revision)
    expect(restored.activeGeneration).toBe(updatedGeneration)
    expect(restored.activeGeneration).not.toBe(installedGeneration)
    expect(JSON.parse(await readFile(join(restored.effectivePath, 'package.json'), 'utf8')))
      .toMatchObject({ dependencies: { '@example/profile-bundle': '2.0.0' } })
  })

  it('updates one installed name symmetrically between bundle and plain-package kinds', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const app = await boot(profilesDir)
    cleanups.push(() => app.dispose())
    const profile = profileId('web')

    let current = await stageCommit(
      app.ctx,
      await app.ctx.profileTransactions.snapshot(profile),
      await artifact(root, 'install', '1.0.0', { kind: 'bundle' }),
    )
    current = await acknowledge(app.ctx, current)
    validateCandidate = async (generationPath) => {
      const manifest = JSON.parse(await readFile(join(generationPath, 'package.json'), 'utf8')) as {
        dsh: { profile: { bundles: string[] } }
      }
      const installed = JSON.parse(await readFile(
        join(generationPath, 'node_modules/@example/profile-bundle/package.json'),
        'utf8',
      )) as Record<string, unknown>
      expect(manifest.dsh.profile.bundles).not.toContain('@example/profile-bundle')
      expect(installed).not.toHaveProperty('dsh.bundle')
    }
    current = await stageCommit(
      app.ctx,
      current,
      await artifact(root, 'update', '2.0.0', { kind: 'package' }),
    )
    let manifest = JSON.parse(await readFile(join(current.effectivePath, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest).toMatchObject({ dependencies: { '@example/profile-bundle': '2.0.0' } })
    expect(manifest.dsh.profile.bundles).not.toContain('@example/profile-bundle')
    expect(await readFile(join(current.effectivePath, 'pnpm-lock.yaml'), 'utf8')).toContain('specifier: 2.0.0')

    current = await acknowledge(app.ctx, current)
    validateCandidate = async (generationPath) => {
      const candidateManifest = JSON.parse(await readFile(join(generationPath, 'package.json'), 'utf8')) as {
        dsh: { profile: { bundles: string[] } }
      }
      const installed = JSON.parse(await readFile(
        join(generationPath, 'node_modules/@example/profile-bundle/package.json'),
        'utf8',
      )) as { dsh?: { bundle?: unknown } }
      expect(candidateManifest.dsh.profile.bundles).toContain('@example/profile-bundle')
      expect(installed.dsh?.bundle).toBeDefined()
    }
    current = await stageCommit(
      app.ctx,
      current,
      await artifact(root, 'update', '3.0.0', { kind: 'bundle' }),
    )
    manifest = JSON.parse(await readFile(join(current.effectivePath, 'package.json'), 'utf8')) as typeof manifest
    expect(manifest).toMatchObject({ dependencies: { '@example/profile-bundle': '3.0.0' } })
    expect(manifest.dsh.profile.bundles).toContain('@example/profile-bundle')
    expect(await readFile(join(current.effectivePath, 'pnpm-lock.yaml'), 'utf8')).toContain('specifier: 3.0.0')
  })

  it('reopens exact install, update, uninstall, and restore state after cold provider starts', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    let app = await boot(profilesDir)
    cleanups.push(async () => { await app.dispose() })
    const profile = profileId('web')

    let current = await stageCommit(app.ctx, await app.ctx.profileTransactions.snapshot(profile), await artifact(root, 'install', '1.0.0'))
    await app.dispose()
    app = await boot(profilesDir)
    current = await app.ctx.profileTransactions.snapshot(profile)
    expect(current).toMatchObject({ bootStatus: 'pending-restart', revision: 1 })
    expect(await readFile(join(current.effectivePath, 'pnpm-lock.yaml'), 'utf8')).toContain('specifier: 1.0.0')

    current = await acknowledge(app.ctx, current)
    current = await stageCommit(app.ctx, current, await artifact(root, 'update', '2.0.0'))
    await app.dispose()
    app = await boot(profilesDir)
    current = await app.ctx.profileTransactions.snapshot(profile)
    expect(await readFile(join(current.effectivePath, 'node_modules/@example/profile-bundle/package.json'), 'utf8'))
      .toContain('"version": "2.0.0"')

    current = await acknowledge(app.ctx, current)
    current = await stageCommit(app.ctx, current, { operation: 'uninstall', packageName: '@example/profile-bundle' })
    await app.dispose()
    app = await boot(profilesDir)
    current = await app.ctx.profileTransactions.snapshot(profile)
    await expect(access(join(current.effectivePath, 'node_modules/@example/profile-bundle'))).rejects.toThrow()

    current = (await app.ctx.profileTransactions.restoreLastGood({
      profile,
      mutationId: nextMutationId('cold-restore'),
      expectedRevision: current.revision,
      expectedTreeDigest: current.treeDigest,
    })).after
    await app.dispose()
    app = await boot(profilesDir)
    current = await app.ctx.profileTransactions.snapshot(profile)
    expect(await readFile(join(current.effectivePath, 'node_modules/@example/profile-bundle/package.json'), 'utf8'))
      .toContain('"version": "2.0.0"')
  })

  it('configures only the Profile patch for an installed package with content and whole-tree fences', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const app = await boot(profilesDir)
    cleanups.push(() => app.dispose())
    const profile = profileId('web')
    let current = await stageCommit(app.ctx, await app.ctx.profileTransactions.snapshot(profile), await artifact(root, 'install', '1.0.0'))
    current = await acknowledge(app.ctx, current)
    const oldBytes = await readFile(join(current.effectivePath, 'cordis.patch.yml'), 'utf8')
    const nextUtf8 = '# typed adapter output\n[]\n'
    const oldDigest = profileContentDigest(`sha256:${createHash('sha256').update(oldBytes).digest('hex')}`)
    const nextDigest = profileContentDigest(`sha256:${createHash('sha256').update(nextUtf8).digest('hex')}`)

    validateCandidate = async (generationPath) => {
      expect(await readFile(join(generationPath, 'cordis.patch.yml'), 'utf8')).toBe(nextUtf8)
    }
    const staged = await app.ctx.profileTransactions.stage({
      profile,
      mutationId: nextMutationId('configure'),
      expectedRevision: current.revision,
      expectedTreeDigest: current.treeDigest,
      mutation: {
        operation: 'configure',
        packageName: '@example/profile-bundle',
        patch: { expectedDigest: oldDigest, nextUtf8, nextDigest },
      },
    })
    const configured = (await app.ctx.profileTransactions.commit({
      profile,
      expectedRevision: current.revision,
      expectedTreeDigest: current.treeDigest,
      generation: staged.generation,
    })).after
    expect(await readFile(join(configured.effectivePath, 'cordis.patch.yml'), 'utf8')).toBe(nextUtf8)

    await expect(app.ctx.profileTransactions.stage({
      profile,
      mutationId: nextMutationId('stale-configure'),
      expectedRevision: configured.revision,
      expectedTreeDigest: configured.treeDigest,
      mutation: {
        operation: 'configure',
        packageName: '@example/profile-bundle',
        patch: { expectedDigest: oldDigest, nextUtf8, nextDigest },
      },
    })).rejects.toBeInstanceOf(ProfileContentConflictError)
    await expect(app.ctx.profileTransactions.stage({
      profile,
      mutationId: nextMutationId('missing-configure-owner'),
      expectedRevision: configured.revision,
      expectedTreeDigest: configured.treeDigest,
      mutation: {
        operation: 'configure',
        packageName: '@example/not-installed',
        patch: { expectedDigest: nextDigest, nextUtf8, nextDigest },
      },
    })).rejects.toThrow(/requires installed package/)
  })

  it('treats Object prototype names as absent packages for every owner-required mutation', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const app = await boot(profilesDir)
    cleanups.push(() => app.dispose())
    const profile = profileId('web')
    const before = await app.ctx.profileTransactions.snapshot(profile)
    const patchBytes = await readFile(join(before.effectivePath, 'cordis.patch.yml'), 'utf8')
    const patchDigest = profileContentDigest(`sha256:${createHash('sha256').update(patchBytes).digest('hex')}`)
    const forbiddenPatch = '# forbidden\n[]\n'
    const forbiddenDigest = profileContentDigest(
      `sha256:${createHash('sha256').update(forbiddenPatch).digest('hex')}`,
    )

    for (const mutation of [
      {
        operation: 'configure' as const,
        packageName: 'constructor',
        patch: { expectedDigest: patchDigest, nextUtf8: forbiddenPatch, nextDigest: forbiddenDigest },
      },
      {
        operation: 'update' as const,
        kind: 'package' as const,
        packageName: 'constructor',
        version: '1.0.0',
        artifact: {
          path: join(root, 'must-not-be-read.tgz'),
          digest: profileArtifactDigest(`sha256:${'0'.repeat(64)}`),
        },
      },
      { operation: 'uninstall' as const, packageName: 'constructor' },
    ]) {
      await expect(app.ctx.profileTransactions.stage({
        profile,
        mutationId: nextMutationId(`prototype-${mutation.operation}`),
        expectedRevision: before.revision,
        expectedTreeDigest: before.treeDigest,
        mutation,
      })).rejects.toThrow('requires installed package constructor')
      expect(await app.ctx.profileTransactions.snapshot(profile)).toEqual(before)
    }
    expect((await app.ctx.profileTransactions.list(profile)).staged).toEqual([])
  })

  it('installs constructor as an own manifest and lockfile dependency', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const app = await boot(profilesDir)
    cleanups.push(() => app.dispose())
    const profile = profileId('web')
    const installed = await stageCommit(
      app.ctx,
      await app.ctx.profileTransactions.snapshot(profile),
      await artifact(root, 'install', '1.0.0', { packageName: 'constructor' }),
    )

    const manifest = JSON.parse(await readFile(join(installed.effectivePath, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(Object.hasOwn(manifest.dependencies, 'constructor')).toBe(true)
    expect(manifest.dependencies['constructor']).toBe('1.0.0')
    const lock = parse(await readFile(join(installed.effectivePath, 'pnpm-lock.yaml'), 'utf8')) as {
      importers: { '.': { dependencies: Record<string, { specifier: string }> } }
    }
    expect(Object.hasOwn(lock.importers['.'].dependencies, 'constructor')).toBe(true)
    expect(lock.importers['.'].dependencies.constructor).toMatchObject({ specifier: '1.0.0' })
  })

  it('rejects install and update archives for installation-owned template packages before staging', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    const packageNames = [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-headless',
    ]
    await makeProfile(profilesDir, 'web', packageNames)
    const app = await boot(profilesDir)
    cleanups.push(() => app.dispose())
    const profile = profileId('web')
    const before = await app.ctx.profileTransactions.snapshot(profile)
    let validations = 0
    validateCandidate = () => { validations += 1 }

    for (const operation of ['install', 'update'] as const) {
      for (const packageName of packageNames) {
        const packed = await artifact(root, operation, '1.0.0', { packageName })
        for (const kind of ['package', 'bundle'] as const) {
          await expect(app.ctx.profileTransactions.stage({
            profile,
            mutationId: nextMutationId('installation-owned'),
            expectedRevision: before.revision,
            expectedTreeDigest: before.treeDigest,
            mutation: { ...packed, kind },
          })).rejects.toThrow(
            `package ${JSON.stringify(packageName)} resolves from the dsh installation `
            + 'and cannot be managed while it is a direct Profile bundle',
          )
        }
      }
    }

    expect(validations).toBe(0)
    expect(await readdir(join(profilesDir, '.dsh-profile-transactions/web/generations'))).toEqual([])
  })

  it('rejects a custom direct bundle resolved from the exact installation anchor for install and update', async () => {
    const root = await scratch()
    const packageName = '@example/installation-bundle'
    const marker = join(root, 'installation-bundle-loaded')
    const installAnchor = await installationBundle(root, packageName, marker)
    const validatorWorker = fileURLToPath(new URL('./real-validator-worker.ts', import.meta.url))

    const installProfiles = join(root, 'install-profiles')
    const customWeb = await makeProfile(installProfiles, 'web', [packageName])
    await execFileAsync(process.execPath, [
      '--no-warnings',
      '--import', import.meta.resolve('tsx/esm'),
      validatorWorker,
      'web',
      customWeb,
      installAnchor,
    ])
    expect(await readFile(marker, 'utf8')).toBe('installation')

    let validations = 0
    validateCandidate = () => { validations += 1 }
    const installApp = await boot(installProfiles, installAnchor)
    cleanups.push(() => installApp.dispose())
    const installBefore = await installApp.ctx.profileTransactions.snapshot(profileId('web'))
    await expect(installApp.ctx.profileTransactions.stage({
      profile: installBefore.profile,
      mutationId: nextMutationId('custom-installation-install'),
      expectedRevision: installBefore.revision,
      expectedTreeDigest: installBefore.treeDigest,
      mutation: await artifact(root, 'install', '1.0.0', { packageName }),
    })).rejects.toThrow(/resolves from the dsh installation/)
    expect(await readdir(join(installProfiles, '.dsh-profile-transactions/web/generations'))).toEqual([])

    const updateProfiles = join(root, 'update-profiles')
    await makeProfile(updateProfiles)
    const updateApp = await boot(updateProfiles, installAnchor)
    cleanups.push(() => updateApp.dispose())
    let updateBefore = await updateApp.ctx.profileTransactions.snapshot(profileId('web'))
    updateBefore = await stageCommit(
      updateApp.ctx,
      updateBefore,
      await artifact(root, 'install', '1.0.0', { kind: 'package', packageName }),
    )
    updateBefore = await acknowledge(updateApp.ctx, updateBefore)
    validations = 0
    await expect(updateApp.ctx.profileTransactions.stage({
      profile: updateBefore.profile,
      mutationId: nextMutationId('custom-installation-update'),
      expectedRevision: updateBefore.revision,
      expectedTreeDigest: updateBefore.treeDigest,
      mutation: await artifact(root, 'update', '2.0.0', { packageName }),
    })).rejects.toThrow(/resolves from the dsh installation/)
    expect(validations).toBe(0)
    expect(await updateApp.ctx.profileTransactions.snapshot(profileId('web'))).toEqual(updateBefore)
  })

  it('rejects lifecycle archives and validator mutations without publishing a partial generation', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const app = await boot(profilesDir)
    cleanups.push(() => app.dispose())
    const profile = profileId('web')
    const before = await app.ctx.profileTransactions.snapshot(profile)
    await expect(app.ctx.profileTransactions.stage({
      profile,
      mutationId: nextMutationId('lifecycle'),
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: await artifact(root, 'install', '1.0.0', { lifecycle: true }),
    })).rejects.toThrow(/lifecycle script install/)

    let candidatePath = ''
    validateCandidate = async (generationPath) => {
      candidatePath = generationPath
      await writeFile(join(generationPath, 'cordis.patch.yml'), '# validator mutation\n[]\n')
    }
    await expect(app.ctx.profileTransactions.stage({
      profile,
      mutationId: nextMutationId('validator-mutation'),
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: await artifact(root, 'install', '1.0.1'),
    })).rejects.toThrow(/validator modified/)
    await expect(access(candidatePath)).rejects.toThrow()
    expect(await app.ctx.profileTransactions.snapshot(profile)).toEqual(before)
  })

  it('rejects an external Profile edit through the complete-tree revision fence', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    const profileDir = await makeProfile(profilesDir)
    const app = await boot(profilesDir)
    cleanups.push(() => app.dispose())
    const profile = profileId('web')
    const before = await app.ctx.profileTransactions.snapshot(profile)
    await writeFile(join(profileDir, 'cordis.patch.yml'), '# external edit\n[]\n')
    await expect(app.ctx.profileTransactions.stage({
      profile,
      mutationId: nextMutationId('external-edit'),
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: await artifact(root, 'install', '1.0.0'),
    })).rejects.toBeInstanceOf(ProfileTreeConflictError)
  })

  it('rejects a stale pnpm importer before creating a candidate', async () => {
    const root = await scratch()
    const profilesDir = join(root, 'profiles')
    const profileDir = await makeProfile(profilesDir)
    await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { ghost: '1.0.0' },
      dsh: { profile: { bundles: [] } },
    }, null, 2)}\n`)
    await mkdir(join(profileDir, 'node_modules', 'ghost'), { recursive: true })
    await writeFile(join(profileDir, 'node_modules', 'ghost', 'package.json'), '{"name":"ghost","version":"1.0.0"}\n')
    const app = await boot(profilesDir)
    cleanups.push(() => app.dispose())
    const profile = profileId('web')
    const before = await app.ctx.profileTransactions.snapshot(profile)
    await expect(app.ctx.profileTransactions.stage({
      profile,
      mutationId: nextMutationId('stale-lock'),
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: await artifact(root, 'install', '1.0.0'),
    })).rejects.toThrow(/pnpm-lock\.yaml dependencies do not match package\.json/)
    expect(await readdir(join(profilesDir, '.dsh-profile-transactions/web/generations'))).toEqual([])
  })
})
