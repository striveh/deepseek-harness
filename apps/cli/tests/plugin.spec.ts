import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import {
  ProfileRevisionConflictError,
  ProfileTreeConflictError,
  profileId,
  profileMutationId,
  MAX_PROFILE_PATCH_BYTES,
  profileTreeDigest,
  type AbortProfileGenerationRequest,
  type CommitProfileGenerationRequest,
  type GetProfileRestoreReceiptRequest,
  type ProfileCommitReceipt,
  type ProfileGenerationId,
  type ProfileGenerationInventory,
  type ProfileSnapshot,
  type ProfileRestoreReceipt,
  type RestoreLastGoodProfileRequest,
  type StageProfileGenerationRequest,
  type StagedProfileGeneration,
} from '@deepseek-ai/dsh-profile-transactions'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  abort: vi.fn<(request: AbortProfileGenerationRequest) => Promise<boolean>>(),
  close: vi.fn<() => Promise<void>>(),
  commit: vi.fn<(request: CommitProfileGenerationRequest) => Promise<ProfileCommitReceipt>>(),
  getRestoreReceipt: vi.fn<(request: GetProfileRestoreReceiptRequest) => Promise<ProfileRestoreReceipt | null>>(),
  list: vi.fn<(profile: string) => Promise<ProfileGenerationInventory>>(),
  restoreLastGood: vi.fn<(request: RestoreLastGoodProfileRequest) => Promise<ProfileCommitReceipt>>(),
  snapshot: vi.fn<(name: string) => Promise<ProfileSnapshot>>(),
  stage: vi.fn<(request: StageProfileGenerationRequest) => Promise<StagedProfileGeneration>>(),
}))

vi.mock('@deepseek-ai/dsh-app-boot', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>(),
  healProfilesModuleFallback: vi.fn(),
}))

vi.mock('../src/profile-transactions.ts', () => ({
  openProfileTransactionConsumer: vi.fn(async (name: string) => ({
    profile: profileId(name),
    transactions: {
      abort: mocks.abort,
      commit: mocks.commit,
      getRestoreReceipt: mocks.getRestoreReceipt,
      list: mocks.list,
      restoreLastGood: mocks.restoreLastGood,
      snapshot: mocks.snapshot,
      stage: mocks.stage,
    },
    close: mocks.close,
  })),
}))

import { readRegularUtf8, runPlugin } from '../src/plugin.ts'

const cleanups: Array<() => Promise<void>> = []

function liveSnapshot(name: string): ProfileSnapshot {
  return {
    profile: profileId(name),
    revision: 0,
    treeDigest: profileTreeDigest(`sha256:${'0'.repeat(64)}`),
    effectivePath: '',
    activeGeneration: null,
    lastGoodGeneration: null,
    rollbackGeneration: null,
    bootStatus: 'live',
  }
}

function emptyInventory(name: string): ProfileGenerationInventory {
  return {
    snapshot: liveSnapshot(name),
    active: null,
    staged: [],
    recoverable: [],
  }
}

beforeEach(() => {
  mocks.snapshot.mockImplementation(async name => liveSnapshot(name))
})

afterEach(async () => {
  vi.restoreAllMocks()
  mocks.abort.mockReset()
  mocks.close.mockReset()
  mocks.commit.mockReset()
  mocks.getRestoreReceipt.mockReset()
  mocks.list.mockReset()
  mocks.restoreLastGood.mockReset()
  mocks.snapshot.mockReset()
  mocks.stage.mockReset()
  while (cleanups.length > 0) await cleanups.pop()!()
})

describe('plugin Profile mutations', () => {
  async function useTemporaryHome(profile = 'web'): Promise<{ home: string; profileDir: string }> {
    const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-init-recovery-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    cleanups.push(() => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      return Promise.resolve()
    })
    const profileDir = join(home, 'profiles', profile)
    return { home, profileDir }
  }

  it.each([
    'package.json',
    'cordis.patch.yml',
    'pnpm-lock.yaml',
  ] as const)('restores a missing %s before the first transaction snapshot', async (filename) => {
    const { profileDir } = await useTemporaryHome()
    initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const path = join(profileDir, filename)
    const complete = await readFile(path, 'utf8')
    await rm(path)
    mocks.stage.mockRejectedValueOnce(new Error('stop after initialization recovery'))
    mocks.snapshot.mockImplementationOnce(async (name: string) => {
      expect(await readFile(path, 'utf8')).toBe(complete)
      const manifest = await readFile(join(profileDir, 'package.json'), 'utf8')
      expect(() => { JSON.parse(manifest) }).not.toThrow()
      expect(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('[]')
      expect(await readFile(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).toContain("lockfileVersion: '9.0'")
      return {
        profile: profileId(name),
        revision: 0,
        treeDigest: profileTreeDigest(`sha256:${'0'.repeat(64)}`),
        effectivePath: profileDir,
        activeGeneration: null,
        lastGoodGeneration: null,
        rollbackGeneration: null,
        bootStatus: 'live' as const,
      }
    })

    await expect(runPlugin('web', [
      'install',
      './unread.tgz',
      '--package',
      '@example/recovered',
      '--version',
      '1.0.0',
      '--digest',
      `sha256:${'1'.repeat(64)}`,
      '--mutation-id',
      `recover-${filename.replaceAll('.', '-')}`,
    ])).resolves.toBe(2)

    await expect(readFile(path, 'utf8')).resolves.toBe(complete)
    expect(mocks.snapshot).toHaveBeenCalledOnce()
    expect(mocks.stage).toHaveBeenCalledOnce()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('preserves a valid user manifest and refuses to repair an unrelated partial companion', async () => {
    const { profileDir } = await useTemporaryHome()
    initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const manifestPath = join(profileDir, 'package.json')
    const manifest = `${JSON.stringify({
      name: 'user-owned-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      userField: 'keep',
    }, null, 2)}\n`
    await writeFile(manifestPath, manifest)
    await writeFile(join(profileDir, 'cordis.patch.yml'), '')

    await expect(runPlugin('web', [
      'install',
      './unread.tgz',
      '--package',
      '@example/not-repaired',
      '--version',
      '1.0.0',
      '--digest',
      `sha256:${'2'.repeat(64)}`,
      '--mutation-id',
      'preserve-user-files',
    ])).resolves.toBe(2)

    await expect(readFile(manifestPath, 'utf8')).resolves.toBe(manifest)
    await expect(readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')).resolves.toBe('')
    expect(mocks.snapshot).not.toHaveBeenCalled()
    expect(mocks.stage).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it.each([
    ['install', ['install', './p.tgz', '--package', 'p', '--version', '1.0.0', '--digest', `sha256:${'1'.repeat(64)}`]],
    ['update', ['update', './p.tgz', '--package', 'p', '--version', '2.0.0', '--digest', `sha256:${'2'.repeat(64)}`]],
    ['uninstall', ['uninstall', 'p']],
    ['configure', ['configure', 'p', '--patch-file', './patch.yml', '--expected-digest', `sha256:${'3'.repeat(64)}`, '--next-digest', `sha256:${'4'.repeat(64)}`]],
    ['restore', ['restore']],
    ['restore-receipt', ['restore-receipt']],
  ] as const)('requires a caller-owned mutation id for %s', async (_operation, args) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    await expect(runPlugin('web', args)).resolves.toBe(2)

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('plugin option --mutation-id is required'))
    expect(mocks.snapshot).not.toHaveBeenCalled()
  })

  it.each(['bad id', `x${'a'.repeat(128)}`])('applies the bounded Profile mutation-id validator to %j', async (mutationId) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    await expect(runPlugin('web', ['restore', '--mutation-id', mutationId])).resolves.toBe(2)

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('profile mutation id must be 1-128 safe identifier characters'))
    expect(mocks.snapshot).not.toHaveBeenCalled()
  })

  it.each([
    ['duplicate option', ['restore', '--mutation-id', 'one', '--mutation-id', 'two'], 'unsupported or duplicate'],
    ['unsupported option', ['restore', '--unknown', 'one'], 'unsupported or duplicate'],
    ['missing option value', ['restore', '--mutation-id'], 'needs one value'],
    ['option followed by option', ['restore', '--mutation-id', '--unknown'], 'needs one value'],
    ['extra artifact', ['update', 'a.tgz', 'b.tgz', '--package', 'p', '--version', '1.0.0', '--digest', `sha256:${'1'.repeat(64)}`, '--mutation-id', 'update'], 'needs exactly one local .tgz'],
    ['invalid kind', ['update', 'a.tgz', '--package', 'p', '--version', '1.0.0', '--digest', `sha256:${'1'.repeat(64)}`, '--kind', 'archive', '--mutation-id', 'update'], '--kind must be package or bundle'],
    ['empty required value', ['update', 'a.tgz', '--package', '', '--version', '1.0.0', '--digest', `sha256:${'1'.repeat(64)}`, '--mutation-id', 'update'], 'plugin option --package is required'],
    ['missing uninstall package', ['uninstall', '--mutation-id', 'uninstall'], 'needs one exact package name'],
    ['missing configure package', ['configure', '--patch-file', 'p.yml', '--expected-digest', `sha256:${'2'.repeat(64)}`, '--next-digest', `sha256:${'3'.repeat(64)}`, '--mutation-id', 'configure'], 'needs one installed package name'],
    ['restore positional', ['restore', 'extra', '--mutation-id', 'restore'], 'takes no positional arguments'],
    ['restore receipt positional', ['restore-receipt', 'extra', '--mutation-id', 'restore'], 'takes no positional arguments'],
    ['list option', ['list', '--mutation-id', 'read'], 'list takes no additional arguments'],
    ['unknown operation', ['add', 'p'], 'accepts only install, update, uninstall, configure, restore, restore-receipt, or list'],
  ] as const)('rejects %s without opening the transaction owner', async (_case, args, message) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    await expect(runPlugin('web', args)).resolves.toBe(2)

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(message))
    expect(mocks.snapshot).not.toHaveBeenCalled()
  })

  it('passes reusable mutation identities to update, uninstall, and configure staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-mutation-id-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const patch = join(root, 'cordis.patch.yml')
    await writeFile(patch, '[]\n')
    const digest = `sha256:${'5'.repeat(64)}`
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    mocks.stage.mockRejectedValue(new Error('stop after identity capture'))
    const cases = [
      ['update-id', ['update', './p.tgz', '--package', 'p', '--version', '2.0.0', '--digest', digest]],
      ['uninstall-id', ['uninstall', 'p']],
      ['configure-id', ['configure', 'p', '--patch-file', patch, '--expected-digest', digest, '--next-digest', digest]],
    ] as const

    for (const [mutationId, args] of cases) {
      await expect(runPlugin('web', [...args, '--mutation-id', mutationId])).resolves.toBe(2)
      expect(mocks.stage).toHaveBeenLastCalledWith(expect.objectContaining({ mutationId }))
      expect(mocks.stage.mock.calls.at(-1)?.[0].mutation).not.toHaveProperty('mutationId')
    }
    expect(stderr).toHaveBeenCalled()
  })

  it('replays an ambiguously completed restore without rolling A back to B', async () => {
    const generationA = '00000000-0000-4000-8000-00000000000a' as ProfileGenerationId
    const generationB = '00000000-0000-4000-8000-00000000000b' as ProfileGenerationId
    const treeDigest = profileTreeDigest(`sha256:${'6'.repeat(64)}`)
    let current: ProfileSnapshot = {
      profile: profileId('web'),
      revision: 8,
      treeDigest,
      effectivePath: '/profile/B',
      activeGeneration: generationB,
      lastGoodGeneration: generationA,
      rollbackGeneration: generationB,
      bootStatus: 'pending-restart',
    }
    const completed = new Map<string, ProfileCommitReceipt>()
    mocks.snapshot.mockImplementation(async () => current)
    mocks.restoreLastGood.mockImplementation(async (request) => {
      const replay = completed.get(request.mutationId)
      if (replay !== undefined) return replay
      const before = current
      current = {
        ...before,
        revision: before.revision + 1,
        effectivePath: before.activeGeneration === generationB ? '/profile/A' : '/profile/B',
        activeGeneration: before.activeGeneration === generationB ? generationA : generationB,
      }
      const receipt: ProfileCommitReceipt = {
        operation: 'restore',
        before,
        after: current,
        restartRequired: true,
      }
      completed.set(request.mutationId, receipt)
      return receipt
    })
    const stdout = vi.spyOn(process.stdout, 'write')
      .mockImplementationOnce(() => { throw new Error('completion output was ambiguous') })
      .mockReturnValue(true)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const command = ['restore', '--mutation-id', 'restore-ambiguous'] as const

    await expect(runPlugin('web', command)).resolves.toBe(2)
    await expect(runPlugin('web', command)).resolves.toBe(0)

    expect(mocks.restoreLastGood).toHaveBeenCalledTimes(2)
    expect(mocks.restoreLastGood.mock.calls.map(([request]) => request.mutationId))
      .toEqual(['restore-ambiguous', 'restore-ambiguous'])
    expect(completed.size).toBe(1)
    expect(current.activeGeneration).toBe(generationA)
    expect(stdout.mock.calls.at(-1)?.[0]).toContain(`restored generation ${generationA}`)
  })

  it('lists without a mutation identity', async () => {
    const { profileDir } = await useTemporaryHome('custom')
    initProfile(profileDir, [])
    const inventory = emptyInventory('custom')
    mocks.snapshot.mockClear()
    mocks.list.mockResolvedValue(inventory)
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    await expect(runPlugin('custom', ['list'])).resolves.toBe(0)

    expect(mocks.list).toHaveBeenCalledWith(profileId('custom'))
    expect(mocks.snapshot).not.toHaveBeenCalled()
    expect(stdout).toHaveBeenCalledWith(`${JSON.stringify(inventory, null, 2)}\n`)
  })

  it('queries a missing custom Profile restore receipt without creating or listing the Profile', async () => {
    const { profileDir } = await useTemporaryHome('custom')
    mocks.getRestoreReceipt.mockResolvedValue(null)
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    await expect(runPlugin('custom', ['restore-receipt', '--mutation-id', 'recovery-query'])).resolves.toBe(0)

    expect(mocks.getRestoreReceipt).toHaveBeenCalledWith({
      profile: profileId('custom'),
      mutationId: profileMutationId('recovery-query'),
    })
    expect(stdout).toHaveBeenCalledWith(`${JSON.stringify({
      profile: 'custom',
      mutationId: 'recovery-query',
      status: 'not-found',
      receipt: null,
    }, null, 2)}\n`)
    await expect(readFile(join(profileDir, 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(mocks.snapshot).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('prints the exact committed restore receipt as strict JSON', async () => {
    const before = liveSnapshot('web')
    const generation = '00000000-0000-4000-8000-00000000000d' as ProfileGenerationId
    const after: ProfileSnapshot = {
      ...before,
      revision: 1,
      activeGeneration: generation,
      lastGoodGeneration: generation,
      effectivePath: '/profile/recovered',
      bootStatus: 'verified',
    }
    const receipt: ProfileRestoreReceipt = {
      mutationId: profileMutationId('recovery-query'),
      status: 'committed',
      operation: 'restore',
      before,
      after,
      restartRequired: true,
    }
    mocks.getRestoreReceipt.mockResolvedValue(receipt)
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    await expect(runPlugin('web', ['restore-receipt', '--mutation-id', 'recovery-query'])).resolves.toBe(0)

    expect(stdout).toHaveBeenCalledWith(`${JSON.stringify({
      profile: 'web',
      mutationId: 'recovery-query',
      status: 'committed',
      receipt,
    }, null, 2)}\n`)
    expect(mocks.snapshot).not.toHaveBeenCalled()
  })

  it.each([
    ['web', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']],
    ['headless', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']],
  ] as const)('initializes the missing shipped %s Profile before listing', async (profile, bundles) => {
    const { profileDir } = await useTemporaryHome(profile)
    const inventory = emptyInventory(profile)
    mocks.list.mockImplementation(async () => {
      const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
        dsh: { profile: { bundles: string[] } }
      }
      expect(manifest.dsh.profile.bundles).toEqual(bundles)
      await expect(readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')).resolves.toContain('[]')
      await expect(readFile(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).resolves.toContain("lockfileVersion: '9.0'")
      return inventory
    })
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    await expect(runPlugin(profile, ['list'])).resolves.toBe(0)
    const firstManifest = await readFile(join(profileDir, 'package.json'), 'utf8')
    await expect(runPlugin(profile, ['list'])).resolves.toBe(0)

    await expect(readFile(join(profileDir, 'package.json'), 'utf8')).resolves.toBe(firstManifest)
    expect(mocks.list).toHaveBeenCalledTimes(2)
    expect(mocks.snapshot).not.toHaveBeenCalled()
  })

  it.each(['custom', 'constructor'])('rejects a missing custom Profile %j list without creating it', async (profile) => {
    const { profileDir } = await useTemporaryHome(profile)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    await expect(runPlugin(profile, ['list'])).resolves.toBe(2)

    await expect(readFile(join(profileDir, 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
      `profile ${JSON.stringify(profile)} does not exist; list initializes only shipped web and headless Profiles`,
    ))
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('commits the staged generation with the caller mutation identity', async () => {
    const generation = '00000000-0000-4000-8000-00000000000c' as ProfileGenerationId
    const before = liveSnapshot('web')
    mocks.stage.mockImplementation(async request => ({
      profile: request.profile,
      mutationId: request.mutationId,
      generation,
      basedOnRevision: request.expectedRevision,
      basedOnTreeDigest: request.expectedTreeDigest,
      treeDigest: request.expectedTreeDigest,
      mutation: request.mutation,
    }))
    mocks.commit.mockResolvedValue({
      operation: 'commit',
      before,
      after: { ...before, revision: 1, activeGeneration: generation, bootStatus: 'pending-restart' },
      restartRequired: true,
    })
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    await expect(runPlugin('web', [
      'update', './p.tgz', '--package', 'p', '--version', '2.0.0',
      '--digest', `sha256:${'7'.repeat(64)}`, '--kind', 'package', '--mutation-id', 'commit-update',
    ])).resolves.toBe(0)

    expect(mocks.stage).toHaveBeenCalledWith(expect.objectContaining({ mutationId: 'commit-update' }))
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ generation }))
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining(`committed generation ${generation} at revision 1`))
  })

  it('aborts a revision-conflicted stage so the same mutation identity can retry', async () => {
    const firstGeneration = '00000000-0000-4000-8000-00000000000d' as ProfileGenerationId
    const secondGeneration = '00000000-0000-4000-8000-00000000000e' as ProfileGenerationId
    const before = liveSnapshot('web')
    const advanced = { ...before, revision: 1, treeDigest: profileTreeDigest(`sha256:${'8'.repeat(64)}`) }
    mocks.snapshot.mockResolvedValueOnce(before).mockResolvedValueOnce(advanced)
    let reservation: ProfileGenerationId | undefined
    mocks.stage.mockImplementation(async (request) => {
      if (reservation !== undefined) throw new Error('mutation identity remained reserved')
      const generation = request.expectedRevision === 0 ? firstGeneration : secondGeneration
      reservation = generation
      return {
        profile: request.profile,
        mutationId: request.mutationId,
        generation,
        basedOnRevision: request.expectedRevision,
        basedOnTreeDigest: request.expectedTreeDigest,
        treeDigest: request.expectedTreeDigest,
        mutation: request.mutation,
      }
    })
    mocks.abort.mockImplementation(async ({ generation }) => {
      if (reservation !== generation) return false
      reservation = undefined
      return true
    })
    mocks.commit
      .mockRejectedValueOnce(new ProfileRevisionConflictError(profileId('web'), 0, 1))
      .mockImplementationOnce(async request => ({
        operation: 'commit',
        before: advanced,
        after: {
          ...advanced,
          revision: 2,
          activeGeneration: request.generation,
          bootStatus: 'pending-restart',
        },
        restartRequired: true,
      }))
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const command = [
      'update', './p.tgz', '--package', 'p', '--version', '2.0.0',
      '--digest', `sha256:${'7'.repeat(64)}`, '--kind', 'package', '--mutation-id', 'retry-conflict',
    ] as const

    await expect(runPlugin('web', command)).resolves.toBe(2)
    await expect(runPlugin('web', command)).resolves.toBe(0)

    expect(mocks.abort).toHaveBeenCalledOnce()
    expect(mocks.abort).toHaveBeenCalledWith({ profile: profileId('web'), generation: firstGeneration })
    expect(mocks.stage.mock.calls.map(([request]) => request.mutationId))
      .toEqual(['retry-conflict', 'retry-conflict'])
    expect(mocks.commit.mock.calls.map(([request]) => request.generation))
      .toEqual([firstGeneration, secondGeneration])
  })

  it('preserves a tree conflict when aborting its staged generation also fails', async () => {
    const generation = '00000000-0000-4000-8000-00000000000f' as ProfileGenerationId
    const before = liveSnapshot('web')
    const conflict = new ProfileTreeConflictError(
      profileId('web'),
      before.treeDigest,
      profileTreeDigest(`sha256:${'9'.repeat(64)}`),
    )
    const abortFailure = new Error('abort failed')
    mocks.stage.mockImplementation(async request => ({
      profile: request.profile,
      mutationId: request.mutationId,
      generation,
      basedOnRevision: request.expectedRevision,
      basedOnTreeDigest: request.expectedTreeDigest,
      treeDigest: request.expectedTreeDigest,
      mutation: request.mutation,
    }))
    mocks.commit.mockRejectedValueOnce(conflict)
    mocks.abort.mockRejectedValueOnce(abortFailure)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    await expect(runPlugin('web', [
      'uninstall', 'p', '--mutation-id', 'tree-conflict-abort-failure',
    ])).resolves.toBe(2)

    expect(mocks.abort).toHaveBeenCalledWith({ profile: profileId('web'), generation })
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
      `${conflict.message}; staged Profile generation abort also failed`,
    ))
  })

  it('does not abort a stage after an ambiguous commit failure', async () => {
    const generation = '00000000-0000-4000-8000-000000000010' as ProfileGenerationId
    mocks.stage.mockImplementation(async request => ({
      profile: request.profile,
      mutationId: request.mutationId,
      generation,
      basedOnRevision: request.expectedRevision,
      basedOnTreeDigest: request.expectedTreeDigest,
      treeDigest: request.expectedTreeDigest,
      mutation: request.mutation,
    }))
    mocks.commit.mockRejectedValueOnce(Object.assign(new Error('commit completion is unknown'), {
      code: 'PROFILE_REVISION_CONFLICT',
    }))
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    await expect(runPlugin('web', [
      'uninstall', 'p', '--mutation-id', 'ambiguous-commit',
    ])).resolves.toBe(2)

    expect(mocks.abort).not.toHaveBeenCalled()
  })

  it('rejects a configure input that is not a regular file before opening the owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-config-input-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    await expect(runPlugin('web', [
      'configure', 'p', '--patch-file', root,
      '--expected-digest', `sha256:${'8'.repeat(64)}`,
      '--next-digest', `sha256:${'9'.repeat(64)}`,
      '--mutation-id', 'configure-directory',
    ])).resolves.toBe(2)

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('must be a regular file'))
    expect(mocks.stage).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('bounds sparse and after-stat growth before opening the transaction owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-config-limit-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const oversized = join(root, 'oversized.yml')
    await writeFile(oversized, '')
    await truncate(oversized, MAX_PROFILE_PATCH_BYTES + 1)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    await expect(runPlugin('web', [
      'configure', 'p', '--patch-file', oversized,
      '--expected-digest', `sha256:${'8'.repeat(64)}`,
      '--next-digest', `sha256:${'9'.repeat(64)}`,
      '--mutation-id', 'configure-oversized',
    ])).resolves.toBe(2)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`exceeds ${String(MAX_PROFILE_PATCH_BYTES)} bytes`))
    expect(mocks.snapshot).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()

    const close = vi.fn<() => Promise<void>>().mockResolvedValue()
    await expect(readRegularUtf8('/growing.yml', async () => ({
      stat: () => Promise.resolve({ isFile: () => true, size: 1 }),
      read: (buffer, offset, length) => {
        buffer.fill(0x61, offset, offset + length)
        return Promise.resolve({ bytesRead: length })
      },
      close,
    }))).rejects.toThrow(`exceeds ${String(MAX_PROFILE_PATCH_BYTES)} bytes`)
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects invalid UTF-8 patch bytes without replacement decoding', async () => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue()
    let read = false
    await expect(readRegularUtf8('/invalid.yml', async () => ({
      stat: () => Promise.resolve({ isFile: () => true, size: 2 }),
      read: (buffer, offset) => {
        if (read) return Promise.resolve({ bytesRead: 0 })
        read = true
        buffer.set([0xc3, 0x28], offset)
        return Promise.resolve({ bytesRead: 2 })
      },
      close,
    }))).rejects.toThrow(/must contain valid UTF-8/)
    expect(close).toHaveBeenCalledOnce()
  })

  it('preserves patch read failure before descriptor close failure', async () => {
    const primary = new Error('patch stat failed')
    const cleanup = new Error('patch close failed')
    const failure = await readRegularUtf8('/double-failure.yml', async () => ({
      stat: () => Promise.reject(primary),
      read: () => Promise.resolve({ bytesRead: 0 }),
      close: () => Promise.reject(cleanup),
    })).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([primary, cleanup])
    expect((failure as Error).cause).toBe(primary)
    expect((failure as Error).message).toContain(primary.message)
  })

  it('reports mutation failure before transaction-owner close failure', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    mocks.stage.mockRejectedValueOnce(new Error('stage primary failed'))
    mocks.close.mockRejectedValueOnce(new Error('owner close failed'))

    await expect(runPlugin('web', [
      'uninstall', 'p', '--mutation-id', 'double-failure',
    ])).resolves.toBe(2)

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
      'stage primary failed; Profile transaction owner close also failed',
    ))
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('formats non-Error mutation failures', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    mocks.stage.mockRejectedValue('string failure')

    await expect(runPlugin('web', [
      'uninstall', 'p', '--mutation-id', 'string-failure',
    ])).resolves.toBe(2)

    expect(stderr).toHaveBeenCalledWith('dsh: string failure\n')
  })

  it('rejects mutation operations for Profiles outside the P0 Web scope', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    await expect(runPlugin('headless', [
      'uninstall', 'p', '--mutation-id', 'wrong-profile',
    ])).resolves.toBe(2)

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('P0 plugin mutations support the web Profile only'))
    expect(mocks.snapshot).not.toHaveBeenCalled()
  })
})
