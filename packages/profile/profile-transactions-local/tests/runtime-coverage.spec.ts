import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  currentProcessIncarnation,
  readProcessIncarnation,
  type ProcessIncarnation,
} from '@deepseek-ai/dsh-native-command'
import {
  LocalProfileMutationConflictError,
  LocalProfileTransactionStore,
  digestProfileTree,
  type StoreConfigureMutation,
  type StoreMutation,
  type StoreStageRequest,
} from '../src/runtime.ts'

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
const TEST_INSTALL_ANCHOR = fileURLToPath(import.meta.url)
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`
const OWN_INCARNATION = currentProcessIncarnation()
const STALE_INCARNATION = 'linux:00000000-0000-0000-0000-000000000000:1' as ProcessIncarnation
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function scratch(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-profile-runtime-${label}-`))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function makeProfile(profilesDir: string): Promise<string> {
  const profile = join(profilesDir, 'web')
  await mkdir(profile, { recursive: true })
  await Promise.all([
    writeFile(join(profile, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, null, 2)}\n`),
    writeFile(join(profile, 'cordis.patch.yml'), '[]\n'),
    writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n'),
    writeFile(join(profile, 'pnpm-lock.yaml'), EMPTY_LOCK),
  ])
  return profile
}

function store(profilesDir: string, lockWaitMs = 100): LocalProfileTransactionStore {
  return new LocalProfileTransactionStore({ profilesDir, installAnchor: TEST_INSTALL_ANCHOR, lockWaitMs })
}

async function packedArtifact(root: string): Promise<{ path: string; digest: string }> {
  const packageRoot = join(root, 'artifact-source', 'package')
  await mkdir(packageRoot, { recursive: true })
  await Promise.all([
    writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@example/runtime',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2)}\n`),
    writeFile(join(packageRoot, 'cordis.patch.yml'), '[]\n'),
  ])
  const path = join(root, 'runtime.tgz')
  await create({ cwd: join(root, 'artifact-source'), file: path, gzip: true, portable: true }, ['package'])
  const digest = `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`
  return { path, digest }
}

function invalidStage(mutation: StoreMutation, overrides: Record<string, unknown> = {}) {
  return {
    profile: 'web',
    mutationId: 'runtime-invalid',
    expectedRevision: 0,
    expectedTreeDigest: ZERO_DIGEST,
    mutation,
    ...overrides,
  }
}

interface TestGenerationRecord {
  readonly profile: string
  readonly generation: string
  readonly mutationId: string | null
  readonly source: 'baseline' | 'mutation'
  readonly basedOnRevision: number
  readonly basedOnGeneration: string | null
  readonly basedOnTreeDigest: string
  readonly treeDigest: string
  readonly mutation: unknown
}

interface StoreInternals {
  reserveStageLocked(
    database: unknown,
    request: StoreStageRequest,
    state: unknown,
    stageOwnerToken: string,
    DatabaseSync?: unknown,
  ): unknown
  stageLeaseIsHeld(profile: string, ownerToken: string, DatabaseSync: unknown): boolean
  acquireStageLeaseLocked(profile: string, ownerToken: string, DatabaseSync: unknown): unknown
  releaseStageLease(lease: {
    database: { exec(sql: string): void; close(): void }
    path: string
  }): void
  pruneUnreferencedStageLeasesLocked(database: unknown, profile: string): void
  finalizeStageLocked(
    database: unknown,
    request: StoreStageRequest,
    generation: string,
    ownerToken: string,
  ): void
  abandonStageLocked(
    database: unknown,
    request: StoreStageRequest,
    generation: string,
    ownerToken: string,
  ): void
  assertFinalizedStageLocked(database: unknown, record: TestGenerationRecord): void
  readCompleteGeneration(profile: string, generation: string, verifyTree: boolean): TestGenerationRecord
  captureBaseline(profile: string, before: StoreSnapshotLike): string
  removeUnreferencedGeneration(profile: string, generation: string): void
  withWriterLock<T>(profile: string, operation: (database: unknown) => T): Promise<T>
}

interface StoreSnapshotLike {
  readonly profile: string
  readonly revision: number
  readonly activeGeneration: string | null
  readonly lastGoodGeneration: string | null
  readonly rollbackGeneration: string | null
  readonly treeDigest: string
  readonly effectivePath: string
  readonly bootStatus: 'live' | 'pending-restart' | 'verified'
}

interface FakeDatabaseOptions {
  readonly get: (sql: string, args: readonly unknown[]) => unknown
  readonly run?: (sql: string, args: readonly unknown[]) => { readonly changes: number }
  readonly all?: (sql: string, args: readonly unknown[]) => readonly unknown[]
}

function fakeDatabase(options: FakeDatabaseOptions) {
  return {
    prepare(sql: string) {
      return {
        get: (...args: unknown[]) => options.get(sql, args),
        run: (...args: unknown[]) => options.run?.(sql, args) ?? { changes: 1 },
        all: (...args: unknown[]) => options.all?.(sql, args) ?? [],
      }
    },
  }
}

function stageDigest(request: StoreStageRequest): string {
  const mutation = request.mutation.operation === 'install' || request.mutation.operation === 'update'
    ? {
      operation: request.mutation.operation,
      kind: request.mutation.kind,
      packageName: request.mutation.packageName,
      version: request.mutation.version,
      artifactDigest: request.mutation.artifact.digest,
    }
    : request.mutation
  return `sha256:${createHash('sha256').update(JSON.stringify({
    profile: request.profile,
    expectedRevision: request.expectedRevision,
    expectedTreeDigest: request.expectedTreeDigest,
    mutation,
  })).digest('hex')}`
}

describe('Profile transaction input validation', () => {
  it('rejects invalid store lock waits and request identifiers', async () => {
    for (const lockWaitMs of [-1, 1.5, Number.NaN, 2_147_483_648]) {
      expect(() => store('/profiles', lockWaitMs)).toThrow(/lockWaitMs/)
    }
    const local = store('/profiles')
    for (const profile of ['', '.', '..', 'node_modules', '.dsh-profile-transactions', 'a/b', 'a\\b']) {
      await expect(local.stage(invalidStage({ operation: 'uninstall', packageName: 'example' }, { profile }) as never, () => {}))
        .rejects.toThrow(/profile name/)
    }
    for (const mutationId of ['', 'unsafe value', `x${'a'.repeat(128)}`]) {
      await expect(local.stage(invalidStage({ operation: 'uninstall', packageName: 'example' }, { mutationId }) as never, () => {}))
        .rejects.toThrow(/mutation id/)
    }
    for (const expectedRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(local.stage(invalidStage({ operation: 'uninstall', packageName: 'example' }, { expectedRevision }) as never, () => {}))
        .rejects.toThrow(/revision/)
    }
    await expect(local.stage(invalidStage({ operation: 'uninstall', packageName: 'example' }, {
      expectedTreeDigest: 'sha256:bad',
    }) as never, () => {})).rejects.toThrow(/64 lowercase hex/)
  })

  it('rejects invalid package artifacts and normalized patch bytes', async () => {
    const local = store('/profiles')
    for (const packageName of ['.', '..', 'bad name', '@scope']) {
      await expect(local.stage(invalidStage({ operation: 'uninstall', packageName }) as never, () => {}))
        .rejects.toThrow(/exact npm package name/)
    }
    for (const version of ['1', 'v1.0.0', '01.0.0', '1.0.0-01', '1.0.0-alpha.01']) {
      await expect(local.stage(invalidStage({
        operation: 'install',
        kind: 'bundle',
        packageName: 'example',
        version,
        artifact: { path: '/tmp/example.tgz', digest: ZERO_DIGEST },
      }) as never, () => {})).rejects.toThrow(/exact SemVer/)
    }
    await expect(local.stage(invalidStage({
      operation: 'install',
      kind: 'bundle',
      packageName: 'example',
      version: '1.0.0',
      artifact: { path: '/tmp/example.tar', digest: ZERO_DIGEST },
    }) as never, () => {})).rejects.toThrow(/complete local .tgz/)
    await expect(local.stage(invalidStage({
      operation: 'install',
      kind: 'bundle',
      packageName: 'example',
      version: '1.0.0',
      artifact: { path: '/tmp/example.tgz', digest: 'bad' },
    }) as never, () => {})).rejects.toThrow(/64 lowercase hex/)

    const normalizedCases = [
      '\uFEFF[]\n',
      '[]\0\n',
      '[]\r\n',
      '[]',
      '\uD800\n',
      `${'x'.repeat(1024 * 1024 + 1)}\n`,
    ]
    for (const nextUtf8 of normalizedCases) {
      const patch: StoreConfigureMutation = {
        operation: 'configure',
        packageName: 'example',
        patch: { expectedDigest: ZERO_DIGEST, nextUtf8, nextDigest: ZERO_DIGEST },
      }
      await expect(local.stage(invalidStage(patch), () => {})).rejects.toThrow(/normalized UTF-8/)
    }
    await expect(local.stage(invalidStage({
      operation: 'configure',
      packageName: 'example',
      patch: { expectedDigest: 'bad', nextUtf8: '[]\n', nextDigest: ZERO_DIGEST },
    }), () => {})).rejects.toThrow(/expected Profile patch digest/)
    await expect(local.stage(invalidStage({
      operation: 'configure',
      packageName: 'example',
      patch: { expectedDigest: ZERO_DIGEST, nextUtf8: '[]\n', nextDigest: 'bad' },
    }), () => {})).rejects.toThrow(/next Profile patch digest/)
    await expect(local.stage(invalidStage({
      operation: 'configure',
      packageName: 'example',
      patch: { expectedDigest: ZERO_DIGEST, nextUtf8: '[]\n', nextDigest: ZERO_DIGEST },
    }), () => {})).rejects.toThrow(/nextDigest does not match/)
  })

  it('validates commit, abort, restore, and boot acknowledgement inputs', async () => {
    const local = store('/profiles')
    expect(() => local.commit({ profile: 'web', expectedRevision: 0, expectedTreeDigest: ZERO_DIGEST, generation: 'bad' }))
      .toThrow(/generation id/)
    expect(() => local.abort({ profile: 'web', generation: 'bad' })).toThrow(/generation id/)
    expect(() => local.restoreLastGood({
      profile: 'web', mutationId: '', expectedRevision: 0, expectedTreeDigest: ZERO_DIGEST,
    })).toThrow(/mutation id/)
    expect(() => local.acknowledgeBoot({
      profile: 'web', expectedRevision: 0, expectedTreeDigest: ZERO_DIGEST, generation: 'bad',
    })).toThrow(/generation id/)
  })

  it('returns no restore receipt before transaction state exists', async () => {
    const profilesDir = join(await scratch('missing-restore-receipt'), 'profiles')

    await expect(store(profilesDir).getRestoreReceipt({
      profile: 'web',
      mutationId: 'missing-restore-receipt',
    })).resolves.toBeNull()
  })
})

describe('Profile tree filesystem admission', () => {
  it('digests missing, regular, executable, excluded, nested, and internal-link entries', async () => {
    const root = await scratch('digest')
    const tree = join(root, 'tree')
    expect(digestProfileTree(join(root, 'missing'))).toMatch(/^sha256:/)
    await writeFile(join(root, 'plain'), 'plain')
    expect(() => digestProfileTree(join(root, 'plain'))).toThrow(/not a directory/)
    await mkdir(join(tree, 'nested'), { recursive: true })
    await mkdir(join(tree, '.dsh-runtime'))
    await writeFile(join(tree, 'file'), 'body')
    await chmod(join(tree, 'file'), 0o755)
    await writeFile(join(tree, 'nested', 'target'), 'target')
    await writeFile(join(tree, '.dsh-runtime', 'ignored'), 'ignored')
    await symlink('nested/target', join(tree, 'file-link'))
    await symlink('nested', join(tree, 'dir-link'))
    const digest = digestProfileTree(tree)
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    await writeFile(join(tree, '.dsh-runtime', 'ignored'), 'changed')
    expect(digestProfileTree(tree)).toBe(digest)
  })

  it('rejects a symlink that escapes the Profile tree', async () => {
    const root = await scratch('escape')
    const tree = join(root, 'tree')
    await mkdir(tree)
    await writeFile(join(root, 'outside'), 'outside')
    await symlink('../outside', join(tree, 'escape'))
    expect(() => digestProfileTree(tree)).toThrow(/escapes the Profile tree/)
  })

  it('copies and flushes internal file and directory links in a staged generation', async () => {
    const root = await scratch('copy-links')
    const profilesDir = join(root, 'profiles')
    const profile = await makeProfile(profilesDir)
    await mkdir(join(profile, 'linked-dir'))
    await mkdir(join(profile, '.dsh-runtime'))
    await writeFile(join(profile, 'linked-file'), 'linked')
    await writeFile(join(profile, '.dsh-runtime', 'excluded'), 'excluded')
    await symlink('linked-file', join(profile, 'file-link'))
    await symlink('linked-dir', join(profile, 'dir-link'))
    const artifact = await packedArtifact(root)
    const local = store(profilesDir)
    const before = await local.snapshot('web')
    const staged = await local.stage({
      profile: 'web',
      mutationId: 'copy-links',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: {
        operation: 'install',
        kind: 'bundle',
        packageName: '@example/runtime',
        version: '1.0.0',
        artifact,
      },
    }, () => {})
    expect(staged.treeDigest).toMatch(/^sha256:/)
    await expect(readFile(join(
      profilesDir,
      '.dsh-profile-transactions/web/generations',
      staged.generation,
      'profile/.dsh-runtime/excluded',
    ), 'utf8')).rejects.toThrow()
  })

  it('uses absolute link targets when copying for a Windows runtime', async () => {
    const root = await scratch('copy-links-win32')
    const profilesDir = join(root, 'profiles')
    const profile = await makeProfile(profilesDir)
    await writeFile(join(profile, 'linked-file'), 'linked')
    await symlink('linked-file', join(profile, 'file-link'))
    const artifact = await packedArtifact(root)
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const local = store(profilesDir)
      const before = await local.snapshot('web')
      await expect(local.stage({
        profile: 'web',
        mutationId: 'copy-links-win32',
        expectedRevision: before.revision,
        expectedTreeDigest: before.treeDigest,
        mutation: {
          operation: 'install',
          kind: 'bundle',
          packageName: '@example/runtime',
          version: '1.0.0',
          artifact,
        },
      }, () => {})).resolves.toMatchObject({ mutationId: 'copy-links-win32' })
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'platform', original)
    }
  })
})

describe('Profile staging reservation relationships', () => {
  it('rejects pointer-key reuse, malformed rows, and conflicting reservations', async () => {
    const local = store('/profiles') as unknown as StoreInternals
    const request = invalidStage({ operation: 'uninstall', packageName: 'example' }) as StoreStageRequest
    const state = {
      profile: 'web', revision: 0, activeGeneration: null, lastGoodGeneration: null, rollbackGeneration: null,
    }
    const stageOwnerToken = '33333333-3333-4333-8333-333333333333'
    const pointerBefore = {
      profile: 'web', revision: 1,
      activeGeneration: '11111111-1111-4111-8111-111111111111',
      lastGoodGeneration: '22222222-2222-4222-8222-222222222222',
      rollbackGeneration: null,
    }
    const pointerAfter = { ...pointerBefore, revision: 2, activeGeneration: pointerBefore.lastGoodGeneration }
    const pointerConflict = fakeDatabase({
      get: sql => sql.includes('pointer_operations')
        ? {
          kind: 'restore',
          request_digest: `sha256:${'a'.repeat(64)}`,
          receipt_json: JSON.stringify({ before: pointerBefore, after: pointerAfter }),
        }
        : undefined,
    })
    expect(() => local.reserveStageLocked(pointerConflict, request, state, stageOwnerToken))
      .toThrow(LocalProfileMutationConflictError)

    const malformedRows: unknown[] = [
      {},
      {
        mutation_id: request.mutationId,
        request_digest: stageDigest(request),
        generation: '11111111-1111-4111-8111-111111111111',
        status: 'building',
        owner_pid: 0,
        owner_incarnation: OWN_INCARNATION,
        owner_token: null,
      },
      {
        mutation_id: request.mutationId,
        request_digest: stageDigest(request),
        generation: '11111111-1111-4111-8111-111111111111',
        status: 'building',
        owner_pid: process.pid,
        owner_incarnation: 'not-a-process-incarnation',
        owner_token: '22222222-2222-4222-8222-222222222222',
      },
      {
        mutation_id: request.mutationId,
        request_digest: stageDigest(request),
        generation: '11111111-1111-4111-8111-111111111111',
        status: 'building',
        owner_pid: process.pid,
        owner_incarnation: OWN_INCARNATION,
        owner_token: 'not-a-generation-token',
      },
      {
        mutation_id: request.mutationId,
        request_digest: stageDigest(request),
        generation: '11111111-1111-4111-8111-111111111111',
        status: 'complete',
        owner_pid: process.pid,
        owner_incarnation: OWN_INCARNATION,
        owner_token: null,
      },
    ]
    for (const row of malformedRows) {
      const database = fakeDatabase({
        get: sql => sql.includes('pointer_operations') ? undefined : row,
      })
      expect(() => local.reserveStageLocked(database, request, state, stageOwnerToken))
        .toThrow(/malformed|retains an owner/)
    }

    const conflicting = fakeDatabase({
      get: sql => sql.includes('pointer_operations') ? undefined : {
        mutation_id: request.mutationId,
        request_digest: `sha256:${'f'.repeat(64)}`,
        generation: '11111111-1111-4111-8111-111111111111',
        status: 'complete',
        owner_pid: null,
        owner_incarnation: null,
        owner_token: null,
      },
    })
    expect(() => local.reserveStageLocked(conflicting, request, state, stageOwnerToken))
      .toThrow(LocalProfileMutationConflictError)

    const completeButAbsent = fakeDatabase({
      get: sql => sql.includes('pointer_operations') ? undefined : {
        mutation_id: request.mutationId,
        request_digest: stageDigest(request),
        generation: '77777777-7777-4777-8777-777777777777',
        status: 'complete',
        owner_pid: null,
        owner_incarnation: null,
        owner_token: null,
      },
    })
    expect(() => local.reserveStageLocked(completeButAbsent, request, state, stageOwnerToken))
      .toThrow(/absent, incomplete, or malformed/)
  })

  it('waits for a held live-owner lease and replaces stale owner reservations', async () => {
    const root = await scratch('reservation-owner')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const concrete = store(profilesDir)
    const local = concrete as unknown as StoreInternals
    const before = await concrete.snapshot('web')
    const request: StoreStageRequest = {
      profile: 'web',
      mutationId: 'reservation-owner',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: { operation: 'uninstall', packageName: 'example' },
    }
    const row = (ownerPid: number | bigint, ownerIncarnation: ProcessIncarnation) => ({
      mutation_id: request.mutationId,
      request_digest: stageDigest(request),
      generation: '11111111-1111-4111-8111-111111111111',
      status: 'building',
      owner_pid: ownerPid,
      owner_incarnation: ownerIncarnation,
      owner_token: '22222222-2222-4222-8222-222222222222',
    })
    const stageOwnerToken = '33333333-3333-4333-8333-333333333333'
    const liveOwner = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'])
    await new Promise<void>((resolvePromise, reject) => {
      liveOwner.once('spawn', resolvePromise)
      liveOwner.once('error', reject)
    })
    const livePid = liveOwner.pid
    if (livePid === undefined) throw new Error('spawned process has no PID')
    cleanups.push(async () => {
      liveOwner.kill()
      await new Promise<void>((resolvePromise) => {
        liveOwner.once('exit', () => {
          resolvePromise()
        })
      })
    })
    const liveIncarnation = readProcessIncarnation(livePid)
    if (liveIncarnation === null) throw new Error('spawned process disappeared')
    const live = fakeDatabase({
      get: sql => sql.includes('pointer_operations') ? undefined : row(BigInt(livePid), liveIncarnation),
    })
    const leaseProbe = vi.spyOn(local, 'stageLeaseIsHeld').mockReturnValue(true)
    vi.spyOn(local, 'acquireStageLeaseLocked').mockReturnValue({ database: {}, path: '/stage-lease.sqlite' })
    const DatabaseSync = { name: 'FakeDatabaseSync' }
    expect(local.reserveStageLocked(live, request, {
      profile: 'web', revision: 0, activeGeneration: null, lastGoodGeneration: null, rollbackGeneration: null,
    }, stageOwnerToken, DatabaseSync)).toEqual({ kind: 'in-progress' })
    expect(leaseProbe).toHaveBeenCalledWith('web', '22222222-2222-4222-8222-222222222222', DatabaseSync)

    const reused = fakeDatabase({
      get: sql => sql.includes('pointer_operations') ? undefined : row(livePid, STALE_INCARNATION),
    })
    expect(local.reserveStageLocked(reused, request, {
      profile: 'web', revision: 0, activeGeneration: null, lastGoodGeneration: null, rollbackGeneration: null,
    }, stageOwnerToken, DatabaseSync)).toMatchObject({ kind: 'build', basedOn: before })

    const dead = fakeDatabase({
      get: sql => sql.includes('pointer_operations')
        ? undefined
        : row(2_147_483_647, STALE_INCARNATION),
    })
    expect(local.reserveStageLocked(dead, request, {
      profile: 'web', revision: 0, activeGeneration: null, lastGoodGeneration: null, rollbackGeneration: null,
    }, stageOwnerToken, DatabaseSync)).toMatchObject({ kind: 'build', basedOn: before })
  })

  it('fails closed across stage-lease acquisition, probing, pruning, and release faults', async () => {
    const root = await scratch('stage-lease-faults')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const local = store(profilesDir) as unknown as StoreInternals
    const acquisitionFailure = new Error('lease BEGIN failed')
    class FailingLeaseDatabase {
      exec(sql: string): void {
        if (sql === 'BEGIN IMMEDIATE') throw acquisitionFailure
      }

      close(): void {}
    }
    expect(() => local.acquireStageLeaseLocked(
      'web',
      '11111111-1111-4111-8111-111111111111',
      FailingLeaseDatabase,
    )).toThrow(acquisitionFailure)

    const acquisitionCloseFailure = new Error('lease close failed')
    class FailingLeaseCloseDatabase extends FailingLeaseDatabase {
      override close(): void {
        throw acquisitionCloseFailure
      }
    }
    try {
      local.acquireStageLeaseLocked(
        'web',
        '22222222-2222-4222-8222-222222222222',
        FailingLeaseCloseDatabase,
      )
      expect.unreachable('lease acquisition discarded close failure')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([acquisitionFailure, acquisitionCloseFailure])
      expect((error as AggregateError).cause).toBe(acquisitionFailure)
    }

    const rollbackFailure = new Error('lease rollback failed')
    expect(() => {
      local.releaseStageLease({
        database: { exec: () => { throw rollbackFailure }, close: () => {} },
        path: join(root, 'absent-lease.sqlite'),
      })
    }).toThrow(rollbackFailure)

    const closeFailure = new Error('lease release close failed')
    const directoryLease = join(root, 'directory-lease.sqlite')
    await mkdir(directoryLease)
    try {
      local.releaseStageLease({
        database: {
          exec: () => { throw rollbackFailure },
          close: () => { throw closeFailure },
        },
        path: directoryLease,
      })
      expect.unreachable('lease release discarded independent failures')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors.slice(0, 2)).toEqual([rollbackFailure, closeFailure])
      expect((error as AggregateError).errors).toHaveLength(3)
    }

    const leaseDir = join(profilesDir, '.dsh-profile-transactions', 'web', 'stage-leases')
    await mkdir(leaseDir, { recursive: true })
    const heldToken = '33333333-3333-4333-8333-333333333333'
    const heldPath = join(leaseDir, `${heldToken}.sqlite`)
    await writeFile(heldPath, '')
    const probeClose = vi.fn()
    class BusyProbeDatabase {
      exec(sql: string): void {
        if (sql === 'BEGIN IMMEDIATE') {
          throw Object.assign(new Error('lease busy'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
        }
      }

      close(): void {
        probeClose()
      }
    }
    expect(local.stageLeaseIsHeld('web', heldToken, BusyProbeDatabase)).toBe(true)
    expect(probeClose).toHaveBeenCalledOnce()

    const probeFailure = new Error('lease probe failed')
    class FailingProbeDatabase {
      exec(sql: string): void {
        if (sql === 'BEGIN IMMEDIATE') throw probeFailure
      }

      close(): void {
        probeClose()
      }
    }
    expect(() => local.stageLeaseIsHeld('web', heldToken, FailingProbeDatabase)).toThrow(probeFailure)
    expect(probeClose).toHaveBeenCalledTimes(2)

    const referencedToken = '44444444-4444-4444-8444-444444444444'
    const staleToken = '55555555-5555-4555-8555-555555555555'
    const referencedPath = join(leaseDir, `${referencedToken}.sqlite`)
    const stalePath = join(leaseDir, `${staleToken}.sqlite`)
    await Promise.all([
      writeFile(referencedPath, ''),
      writeFile(stalePath, ''),
      writeFile(join(leaseDir, 'invalid.sqlite'), ''),
      writeFile(join(leaseDir, 'ignored.txt'), ''),
    ])
    local.pruneUnreferencedStageLeasesLocked(fakeDatabase({
      get: () => undefined,
      all: () => [{ owner_token: referencedToken }],
    }), 'web')
    await expect(access(stalePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(referencedPath)).resolves.toBeUndefined()
    expect(() => {
      local.pruneUnreferencedStageLeasesLocked(fakeDatabase({
        get: () => undefined,
        all: () => [{}],
      }), 'web')
    }).toThrow(/malformed active staging reservation owner/)
  })

  it('releases acquired stage leases when reservation writes fail', async () => {
    const root = await scratch('stage-reservation-write-faults')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const concrete = store(profilesDir)
    const local = concrete as unknown as StoreInternals
    const before = await concrete.snapshot('web')
    const request: StoreStageRequest = {
      profile: 'web',
      mutationId: 'reservation-write-fault',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: { operation: 'uninstall', packageName: 'example' },
    }
    const lease = { database: { exec: () => {}, close: () => {} }, path: join(root, 'owned-lease.sqlite') }
    vi.spyOn(local, 'acquireStageLeaseLocked').mockReturnValue(lease)
    const release = vi.spyOn(local, 'releaseStageLease').mockImplementation(() => {})
    const writeFailure = new Error('reservation write failed')
    const failedRun = () => {
      throw writeFailure
    }
    const staleReservation = {
      mutation_id: request.mutationId,
      request_digest: stageDigest(request),
      generation: '66666666-6666-4666-8666-666666666666',
      status: 'building',
      owner_pid: 2_147_483_647,
      owner_incarnation: STALE_INCARNATION,
      owner_token: '77777777-7777-4777-8777-777777777777',
    }
    const state = {
      profile: 'web', revision: 0, activeGeneration: null, lastGoodGeneration: null, rollbackGeneration: null,
    }
    expect(() => local.reserveStageLocked(fakeDatabase({
      get: sql => sql.includes('pointer_operations') ? undefined : staleReservation,
      run: failedRun,
    }), request, state, '88888888-8888-4888-8888-888888888888', Object)).toThrow(writeFailure)
    expect(() => local.reserveStageLocked(fakeDatabase({
      get: () => undefined,
      run: failedRun,
    }), request, state, '99999999-9999-4999-8999-999999999999', Object)).toThrow(writeFailure)
    expect(release).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenNthCalledWith(1, lease)
    expect(release).toHaveBeenNthCalledWith(2, lease)
  })

  it('enforces exact finalization ownership and complete reservation state', async () => {
    const root = await scratch('finalize')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root)
    const concrete = store(profilesDir)
    const before = await concrete.snapshot('web')
    const request: StoreStageRequest = {
      profile: 'web',
      mutationId: 'finalize-stage',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: {
        operation: 'install', kind: 'bundle', packageName: '@example/runtime', version: '1.0.0', artifact,
      },
    }
    const staged = await concrete.stage(request, () => {})
    const local = concrete as unknown as StoreInternals
    const record = local.readCompleteGeneration('web', staged.generation, true)
    const token = '33333333-3333-4333-8333-333333333333'
    const reservation = (overrides: Record<string, unknown> = {}) => ({
      mutation_id: request.mutationId,
      request_digest: stageDigest(request),
      generation: staged.generation,
      status: 'building',
      owner_pid: process.pid,
      owner_incarnation: OWN_INCARNATION,
      owner_token: token,
      ...overrides,
    })

    expect(() => {
      local.finalizeStageLocked(fakeDatabase({ get: () => undefined }), request, staged.generation, token)
    })
      .toThrow(LocalProfileMutationConflictError)
    expect(() => {
      local.finalizeStageLocked(fakeDatabase({
        get: () => reservation({ request_digest: `sha256:${'e'.repeat(64)}` }),
      }), request, staged.generation, token)
    }).toThrow(LocalProfileMutationConflictError)
    expect(() => {
      local.finalizeStageLocked(fakeDatabase({
        get: () => reservation({ owner_pid: process.pid + 1 }),
      }), request, staged.generation, token)
    })
      .toThrow(LocalProfileMutationConflictError)
    expect(() => {
      local.finalizeStageLocked(fakeDatabase({
        get: () => reservation(),
        run: () => ({ changes: 0 }),
      }), request, staged.generation, token)
    }).toThrow(LocalProfileMutationConflictError)
    expect(() => {
      local.finalizeStageLocked(fakeDatabase({
        get: () => reservation({ status: 'complete', owner_pid: null, owner_incarnation: null, owner_token: null }),
      }), request, staged.generation, token)
    }).not.toThrow()

    expect(() => {
      local.assertFinalizedStageLocked(fakeDatabase({ get: () => undefined }), record)
    })
      .toThrow(/no staging reservation/)
    expect(() => {
      local.assertFinalizedStageLocked(fakeDatabase({ get: () => reservation() }), record)
    })
      .toThrow(/reservation is not complete/)
    expect(() => {
      local.assertFinalizedStageLocked(fakeDatabase({
        get: () => reservation({ status: 'complete', owner_pid: null, owner_incarnation: null, owner_token: null }),
      }), { ...record, mutationId: null })
    }).toThrow(/baseline generation/)

    const conflictingRequest: StoreStageRequest = {
      ...request,
      mutation: { operation: 'install', kind: 'package', packageName: '@example/runtime', version: '1.0.0', artifact },
    }
    expect(() => {
      local.abandonStageLocked(fakeDatabase({
        get: () => ({
          ...reservation(),
          request_digest: stageDigest(conflictingRequest),
        }),
      }), conflictingRequest, staged.generation, token)
    }).toThrow(LocalProfileMutationConflictError)
    const otherPackage: StoreStageRequest = {
      ...request,
      mutation: { operation: 'install', kind: 'bundle', packageName: '@example/other', version: '1.0.0', artifact },
    }
    expect(() => {
      local.abandonStageLocked(fakeDatabase({
        get: () => ({ ...reservation(), request_digest: stageDigest(otherPackage) }),
      }), otherPackage, staged.generation, token)
    }).toThrow(LocalProfileMutationConflictError)
  })

  it('abandons only the caller-owned incomplete reservation', async () => {
    const root = await scratch('abandon')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const concrete = store(profilesDir)
    const local = concrete as unknown as StoreInternals
    const before = await concrete.snapshot('web')
    const request: StoreStageRequest = {
      profile: 'web',
      mutationId: 'abandon-stage',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: { operation: 'uninstall', packageName: 'example' },
    }
    const generation = '44444444-4444-4444-8444-444444444444'
    const token = '55555555-5555-4555-8555-555555555555'
    const owned = {
      mutation_id: request.mutationId,
      request_digest: stageDigest(request),
      generation,
      status: 'building',
      owner_pid: process.pid,
      owner_incarnation: OWN_INCARNATION,
      owner_token: token,
    }
    expect(() => {
      local.abandonStageLocked(fakeDatabase({ get: () => undefined }), request, generation, token)
    }).not.toThrow()
    expect(() => {
      local.abandonStageLocked(fakeDatabase({
        get: () => ({ ...owned, generation: '66666666-6666-4666-8666-666666666666' }),
      }), request, generation, token)
    }).not.toThrow()
    await mkdir(join(profilesDir, '.dsh-profile-transactions/web/generations', generation), { recursive: true })
    const deleted: string[] = []
    expect(() => {
      local.abandonStageLocked(fakeDatabase({
        get: () => owned,
        run: (sql) => { deleted.push(sql); return { changes: 1 } },
      }), request, generation, token)
    }).not.toThrow()
    expect(deleted.some(sql => sql.includes('DELETE FROM stage_reservations'))).toBe(true)
  })
})

describe('Profile staging and publication edge relationships', () => {
  it('keeps stage failure primary when owner-lease release also fails', async () => {
    const successfulRoot = await scratch('stage-release-after-success')
    const successfulProfilesDir = join(successfulRoot, 'profiles')
    await makeProfile(successfulProfilesDir)
    const successfulArtifact = await packedArtifact(successfulRoot)
    const successful = store(successfulProfilesDir)
    const successfulInternals = successful as unknown as StoreInternals
    const successfulBefore = await successful.snapshot('web')
    const successfulLease = {
      database: { exec: () => {}, close: () => {} },
      path: join(successfulRoot, 'successful-lease.sqlite'),
    }
    vi.spyOn(successfulInternals, 'acquireStageLeaseLocked').mockReturnValue(successfulLease)
    const releaseAfterSuccess = new Error('release after successful stage failed')
    vi.spyOn(successfulInternals, 'releaseStageLease').mockImplementation(() => {
      throw releaseAfterSuccess
    })
    await expect(successful.stage({
      profile: 'web',
      mutationId: 'release-after-success',
      expectedRevision: successfulBefore.revision,
      expectedTreeDigest: successfulBefore.treeDigest,
      mutation: {
        operation: 'install',
        kind: 'bundle',
        packageName: '@example/runtime',
        version: '1.0.0',
        artifact: successfulArtifact,
      },
    }, () => {})).rejects.toBe(releaseAfterSuccess)

    const failedRoot = await scratch('stage-release-after-failure')
    const failedProfilesDir = join(failedRoot, 'profiles')
    await makeProfile(failedProfilesDir)
    const failedArtifact = await packedArtifact(failedRoot)
    const failed = store(failedProfilesDir)
    const failedInternals = failed as unknown as StoreInternals
    const failedBefore = await failed.snapshot('web')
    const failedLease = {
      database: { exec: () => {}, close: () => {} },
      path: join(failedRoot, 'failed-lease.sqlite'),
    }
    vi.spyOn(failedInternals, 'acquireStageLeaseLocked').mockReturnValue(failedLease)
    const stageFailure = new Error('candidate validation failed')
    const releaseAfterFailure = new Error('release after failed stage failed')
    vi.spyOn(failedInternals, 'releaseStageLease').mockImplementation(() => {
      throw releaseAfterFailure
    })
    try {
      await failed.stage({
        profile: 'web',
        mutationId: 'release-after-failure',
        expectedRevision: failedBefore.revision,
        expectedTreeDigest: failedBefore.treeDigest,
        mutation: {
          operation: 'install',
          kind: 'bundle',
          packageName: '@example/runtime',
          version: '1.0.0',
          artifact: failedArtifact,
        },
      }, () => Promise.reject(stageFailure))
      expect.unreachable('stage cleanup discarded owner-lease release failure')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([stageFailure, releaseAfterFailure])
      expect((error as AggregateError).cause).toBe(stageFailure)
    }
  })

  it('rejects a candidate changed after its base tree copy', async () => {
    const root = await scratch('post-copy-edit')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root)
    const local = new LocalProfileTransactionStore({
      profilesDir, installAnchor: TEST_INSTALL_ANCHOR, lockWaitMs: 100,
    }, {
      afterCandidateCopied(generationPath) {
        writeFileSync(join(generationPath, 'cordis.patch.yml'), '- copied-tree-edit\n', 'utf8')
      },
    })
    const before = await local.snapshot('web')
    await expect(local.stage({
      profile: 'web',
      mutationId: 'post-copy-edit',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: {
        operation: 'install', kind: 'bundle', packageName: '@example/runtime', version: '1.0.0', artifact,
      },
    }, () => {})).rejects.toThrow(/tree conflict/)
  })

  it('times out a same-key waiter while a live validator owns the candidate', async () => {
    const root = await scratch('stage-timeout')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root)
    const owner = store(profilesDir, 1_000)
    const before = await owner.snapshot('web')
    const request: StoreStageRequest = {
      profile: 'web',
      mutationId: 'stage-timeout',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: {
        operation: 'install', kind: 'bundle', packageName: '@example/runtime', version: '1.0.0', artifact,
      },
    }
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const first = owner.stage(request, async () => {
      entered.resolve(undefined)
      await release.promise
    })
    await entered.promise
    const waiter = store(profilesDir, 0)
    await expect(waiter.stage(request, () => {})).rejects.toThrow(/is still staging/)
    await expect(waiter.restoreLastGood({
      profile: 'web',
      mutationId: request.mutationId,
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
    })).rejects.toThrow(LocalProfileMutationConflictError)
    release.resolve(undefined)
    await expect(first).resolves.toMatchObject({ mutationId: request.mutationId })
  })

  it('preserves the stage error and lets a same-process retry replace a reservation after cleanup lock failure', async () => {
    const root = await scratch('stage-cleanup-lock')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root)
    const primaryError = new Error('validator rejected candidate')
    const cleanupError = new Error('cleanup writer lock failed')
    let rejectCandidate = true
    let rejectCleanupLock = false
    const local = new LocalProfileTransactionStore({
      profilesDir, installAnchor: TEST_INSTALL_ANCHOR, lockWaitMs: 100,
    }, {
      afterCandidateCopied() {
        if (!rejectCandidate) return
        rejectCandidate = false
        rejectCleanupLock = true
        throw primaryError
      },
    })
    const internals = local as unknown as StoreInternals
    const writerLock = internals.withWriterLock.bind(local)
    internals.withWriterLock = async <T>(profile: string, operation: (database: unknown) => T): Promise<T> => {
      if (rejectCleanupLock) {
        rejectCleanupLock = false
        throw cleanupError
      }
      return writerLock(profile, operation)
    }
    const before = await local.snapshot('web')
    const request: StoreStageRequest = {
      profile: 'web',
      mutationId: 'stage-cleanup-lock',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: {
        operation: 'install', kind: 'bundle', packageName: '@example/runtime', version: '1.0.0', artifact,
      },
    }
    let observed: unknown
    try {
      await local.stage(request, () => {})
    } catch (error) {
      observed = error
    }
    expect(observed).toBeInstanceOf(AggregateError)
    const failures = (observed as AggregateError).errors as readonly unknown[]
    expect(failures).toEqual([primaryError, cleanupError])
    expect((observed as AggregateError).cause).toBe(primaryError)
    await expect(local.stage(request, () => {})).resolves.toMatchObject({ mutationId: request.mutationId })
  })

  it('rejects install over an installed package and an artifact body with a different digest', async () => {
    const root = await scratch('mutation-errors')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root)
    const local = store(profilesDir)
    const before = await local.snapshot('web')
    const staged = await local.stage({
      profile: 'web',
      mutationId: 'install-first',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: {
        operation: 'install', kind: 'bundle', packageName: '@example/runtime', version: '1.0.0', artifact,
      },
    }, () => {})
    const active = (await local.commit({
      profile: 'web',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      generation: staged.generation,
    })).after
    await expect(local.stage({
      profile: 'web',
      mutationId: 'install-again',
      expectedRevision: active.revision,
      expectedTreeDigest: active.treeDigest,
      mutation: {
        operation: 'install', kind: 'bundle', packageName: '@example/runtime', version: '1.0.0', artifact,
      },
    }, () => {})).rejects.toThrow(/install requires absent package/)

    const otherRoot = await scratch('artifact-mismatch')
    const otherProfiles = join(otherRoot, 'profiles')
    await makeProfile(otherProfiles)
    const otherArtifact = await packedArtifact(otherRoot)
    const other = store(otherProfiles)
    const otherBefore = await other.snapshot('web')
    await expect(other.stage({
      profile: 'web',
      mutationId: 'artifact-mismatch',
      expectedRevision: otherBefore.revision,
      expectedTreeDigest: otherBefore.treeDigest,
      mutation: {
        operation: 'install',
        kind: 'bundle',
        packageName: '@example/runtime',
        version: '1.0.0',
        artifact: { path: otherArtifact.path, digest: ZERO_DIGEST },
      },
    }, () => {})).rejects.toThrow(/artifact digest mismatch/)
  })

  it('replays a committed generation across new fences and rejects an older uncommitted candidate', async () => {
    const root = await scratch('commit-fences')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root)
    const local = store(profilesDir)
    const before = await local.snapshot('web')
    const mutation = {
      operation: 'install' as const,
      kind: 'bundle' as const,
      packageName: '@example/runtime',
      version: '1.0.0',
      artifact,
    }
    const left = await local.stage({
      profile: 'web', mutationId: 'commit-left', expectedRevision: 0, expectedTreeDigest: before.treeDigest, mutation,
    }, () => {})
    const right = await local.stage({
      profile: 'web', mutationId: 'commit-right', expectedRevision: 0, expectedTreeDigest: before.treeDigest, mutation,
    }, () => {})
    const committedReceipt = await local.commit({
      profile: 'web', expectedRevision: 0, expectedTreeDigest: before.treeDigest, generation: left.generation,
    })
    const committed = committedReceipt.after
    await expect(local.commit({
      profile: 'web', expectedRevision: 1, expectedTreeDigest: before.treeDigest, generation: left.generation,
    })).resolves.toEqual(committedReceipt)
    await expect(local.commit({
      profile: 'web', expectedRevision: 0, expectedTreeDigest: ZERO_DIGEST, generation: left.generation,
    })).resolves.toEqual(committedReceipt)
    await expect(local.commit({
      profile: 'web',
      expectedRevision: committed.revision,
      expectedTreeDigest: committed.treeDigest,
      generation: right.generation,
    })).rejects.toThrow(/revision conflict/)
    await expect(local.acknowledgeBoot({
      profile: 'web',
      expectedRevision: committed.revision,
      expectedTreeDigest: committed.treeDigest,
      generation: right.generation,
    })).rejects.toThrow(/does not name the active generation/)
    const verified = (await local.acknowledgeBoot({
      profile: 'web',
      expectedRevision: committed.revision,
      expectedTreeDigest: committed.treeDigest,
      generation: left.generation,
    })).after
    await expect(local.acknowledgeBoot({
      profile: 'web',
      expectedRevision: verified.revision,
      expectedTreeDigest: verified.treeDigest,
      generation: left.generation,
    })).resolves.toMatchObject({ before: verified, after: verified })
  })

  it('does not remove a prior baseline when a later commit publication fails', async () => {
    const root = await scratch('later-commit-failure')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root)
    const publicationFailure = new Error('later state publication failed')
    let failPublication = false
    const local = new LocalProfileTransactionStore({
      profilesDir, installAnchor: TEST_INSTALL_ANCHOR, lockWaitMs: 100,
    }, {
      afterStatePersisted() {
        if (failPublication) throw publicationFailure
      },
    })
    const before = await local.snapshot('web')
    const installed = await local.stage({
      profile: 'web',
      mutationId: 'later-commit-install',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: {
        operation: 'install', kind: 'bundle', packageName: '@example/runtime', version: '1.0.0', artifact,
      },
    }, () => {})
    const active = (await local.commit({
      profile: 'web',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      generation: installed.generation,
    })).after
    const uninstall = await local.stage({
      profile: 'web',
      mutationId: 'later-commit-uninstall',
      expectedRevision: active.revision,
      expectedTreeDigest: active.treeDigest,
      mutation: { operation: 'uninstall', packageName: '@example/runtime' },
    }, () => {})
    failPublication = true
    await expect(local.commit({
      profile: 'web',
      expectedRevision: active.revision,
      expectedTreeDigest: active.treeDigest,
      generation: uninstall.generation,
    })).rejects.toBe(publicationFailure)
    await expect(readdir(join(profilesDir, '.dsh-profile-transactions', 'web', 'generations')))
      .resolves.toContain(active.lastGoodGeneration)
  })

  it('rejects a live Profile edit after its recovery baseline becomes durable', async () => {
    const root = await scratch('post-baseline-edit')
    const profilesDir = join(root, 'profiles')
    const profile = await makeProfile(profilesDir)
    const artifact = await packedArtifact(root)
    let persisted = 0
    const local = new LocalProfileTransactionStore({
      profilesDir, installAnchor: TEST_INSTALL_ANCHOR, lockWaitMs: 100,
    }, {
      afterGenerationPersisted() {
        persisted += 1
        if (persisted === 2) writeFileSync(join(profile, 'cordis.patch.yml'), '- externally-edited\n', 'utf8')
      },
    })
    const before = await local.snapshot('web')
    const staged = await local.stage({
      profile: 'web',
      mutationId: 'post-baseline-edit',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: {
        operation: 'install', kind: 'bundle', packageName: '@example/runtime', version: '1.0.0', artifact,
      },
    }, () => {})
    await expect(local.commit({
      profile: 'web',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      generation: staged.generation,
    })).rejects.toThrow(/tree conflict/)
    expect(persisted).toBe(2)
    await expect(readdir(join(profilesDir, '.dsh-profile-transactions/web/generations')))
      .resolves.toEqual([staged.generation])
  })

  it('rejects unreachable pointer state and damaged pointer generations', async () => {
    const root = await scratch('missing-baseline')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root)
    const local = store(profilesDir)
    const before = await local.snapshot('web')
    const mutation = {
      operation: 'install' as const,
      kind: 'bundle' as const,
      packageName: '@example/runtime',
      version: '1.0.0',
      artifact,
    }
    const first = await local.stage({
      profile: 'web', mutationId: 'missing-baseline-first', expectedRevision: 0, expectedTreeDigest: before.treeDigest, mutation,
    }, () => {})
    const transactionDir = join(profilesDir, '.dsh-profile-transactions/web')
    const statePath = join(transactionDir, 'state.json')
    await writeFile(statePath, `${JSON.stringify({
      formatVersion: 2,
      profile: 'web',
      revision: 0,
      activeGeneration: first.generation,
      lastGoodGeneration: null,
      rollbackGeneration: null,
    }, null, 2)}\n`)
    expect(() => local.snapshot('web')).toThrow(/unreachable state pointer state/)
    await writeFile(statePath, `${JSON.stringify({
      formatVersion: 2,
      profile: 'web',
      revision: 1,
      activeGeneration: first.generation,
      lastGoodGeneration: first.generation,
      rollbackGeneration: null,
    }, null, 2)}\n`)

    const activeProfile = join(transactionDir, 'generations', first.generation, 'profile')
    await writeFile(join(activeProfile, 'cordis.patch.yml'), '- damaged-after-record\n')
    await expect(local.list('web')).rejects.toThrow(/tree no longer matches its digest/)
  })

  it('reports an empty inventory and rejects restore without a recovery generation', async () => {
    const root = await scratch('empty-inventory')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const local = store(profilesDir)
    const before = await local.snapshot('web')
    await expect(local.list('web')).resolves.toMatchObject({ active: null, staged: [], recoverable: [] })
    const generations = join(profilesDir, '.dsh-profile-transactions/web/generations')
    await mkdir(generations, { recursive: true })
    await writeFile(join(generations, 'not-a-generation'), 'ignored')
    await expect(local.list('web')).resolves.toMatchObject({ active: null, staged: [], recoverable: [] })
    await expect(local.restoreLastGood({
      profile: 'web',
      mutationId: 'restore-empty',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
    })).rejects.toThrow(/has no recoverable generation/)
  })

  it('removes a failed baseline capture and preserves the tree conflict', async () => {
    const root = await scratch('baseline-conflict')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const concrete = store(profilesDir)
    const before = await concrete.snapshot('web')
    const local = concrete as unknown as StoreInternals
    await mkdir(join(profilesDir, '.dsh-profile-transactions/web/generations'), { recursive: true })
    expect(() => local.captureBaseline('web', { ...before, treeDigest: ZERO_DIGEST }))
      .toThrow(/tree conflict/)
  })

  it('retains a state-referenced baseline and accepts an already absent cleanup target', async () => {
    const root = await scratch('baseline-cleanup-reference')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const transactionDir = join(profilesDir, '.dsh-profile-transactions/web')
    const generation = '77777777-7777-4777-8777-777777777777'
    await mkdir(join(transactionDir, 'generations', generation), { recursive: true })
    await writeFile(join(transactionDir, 'state.json'), `${JSON.stringify({
      formatVersion: 2,
      profile: 'web',
      revision: 1,
      activeGeneration: generation,
      lastGoodGeneration: generation,
      rollbackGeneration: null,
    }, null, 2)}\n`)
    const local = store(profilesDir) as unknown as StoreInternals
    expect(() => {
      local.removeUnreferencedGeneration('web', generation)
    }).not.toThrow()
    await expect(readdir(join(transactionDir, 'generations'))).resolves.toContain(generation)
    expect(() => {
      local.removeUnreferencedGeneration('web', '88888888-8888-4888-8888-888888888888')
    }).not.toThrow()
  })

  it('removes failed baseline copies from a non-directory or escaping-link source', async () => {
    const root = await scratch('baseline-copy-errors')
    const profilesDir = join(root, 'profiles')
    const profile = await makeProfile(profilesDir)
    const concrete = store(profilesDir)
    const before = await concrete.snapshot('web')
    const local = concrete as unknown as StoreInternals
    await mkdir(join(profilesDir, '.dsh-profile-transactions/web/generations'), { recursive: true })
    const plain = join(root, 'plain')
    await writeFile(plain, 'plain')
    expect(() => local.captureBaseline('web', { ...before, effectivePath: plain }))
      .toThrow(/Profile source .* is not a directory/)
    await writeFile(join(root, 'outside'), 'outside')
    await symlink(join(root, 'outside'), join(profile, 'escape'))
    expect(() => local.captureBaseline('web', before)).toThrow(/escapes the Profile tree/)
  })
})

describe('generation durability fault relationships', () => {
  it('flushes every transaction-directory component parent before opening the coordinator', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const mkdirDirectory = vi.fn(actualFs.mkdirSync)
    const directoryByDescriptor = new Map<number, string>()
    const mockedDirectories = new Set<string>()
    const flushedDirectories: string[] = []
    let nextDirectoryDescriptor = -1
    let failAt = -1
    let injectedFailure: Error | undefined
    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actualFs,
      mkdirSync: mkdirDirectory,
      openSync(...args: Parameters<typeof actualFs.openSync>) {
        const path = String(args[0])
        if (!mockedDirectories.has(path)) return actualFs.openSync(...args)
        const descriptor = nextDirectoryDescriptor--
        directoryByDescriptor.set(descriptor, path)
        return descriptor
      },
      fsyncSync(descriptor: number) {
        const directory = directoryByDescriptor.get(descriptor)
        if (directory !== undefined) {
          flushedDirectories.push(directory)
          if (flushedDirectories.length - 1 === failAt) throw injectedFailure
          return
        }
        actualFs.fsyncSync(descriptor)
      },
      closeSync(descriptor: number) {
        if (directoryByDescriptor.delete(descriptor)) return
        actualFs.closeSync(descriptor)
      },
    }))
    try {
      const { LocalProfileTransactionStore: FaultStore } = await import('../src/runtime.ts')
      const generation = '11111111-1111-4111-8111-111111111111'
      const durableComponents = (path: string): string[] => {
        const components: string[] = []
        for (let current = resolve(path); dirname(current) !== current; current = dirname(current)) {
          components.push(current)
        }
        return components.reverse()
      }
      const mkdirFailure = Object.assign(new Error('mkdir permission denied'), { code: 'EACCES' })
      mkdirDirectory.mockImplementationOnce(() => {
        throw mkdirFailure
      })
      const deniedRoot = await scratch('mkdir-denied')
      const deniedProfilesDir = join(deniedRoot, 'profiles')
      const denied = new FaultStore({ profilesDir: deniedProfilesDir, installAnchor: TEST_INSTALL_ANCHOR, lockWaitMs: 100 })
      await expect(denied.abort({ profile: 'web', generation })).rejects.toBe(mkdirFailure)
      mkdirDirectory.mockImplementation(actualFs.mkdirSync)

      const blockedRoot = await scratch('mkdir-not-directory')
      const blocked = join(blockedRoot, 'blocked')
      await writeFile(blocked, 'not a directory')
      const blockedProfilesDir = join(blocked, 'profiles')
      const blockedStore = new FaultStore({
        profilesDir: blockedProfilesDir,
        installAnchor: TEST_INSTALL_ANCHOR,
        lockWaitMs: 100,
      })
      await expect(blockedStore.abort({ profile: 'web', generation }))
        .rejects.toThrow(`durable directory component is not a directory: ${blocked}`)

      const failureExampleRoot = await scratch('mkdir-fsync-failure-count')
      const failureExampleProfilesDir = join(failureExampleRoot, 'profiles')
      const failureCount = durableComponents(join(
        failureExampleProfilesDir,
        '.dsh-profile-transactions',
        'web',
        'generations',
      )).length
      for (const failureIndex of Array.from({ length: failureCount }, (_, index) => index)) {
        const root = await scratch(`mkdir-fsync-${String(failureIndex)}`)
        const profilesDir = join(root, 'profiles')
        await makeProfile(profilesDir)
        const generations = join(profilesDir, '.dsh-profile-transactions', 'web', 'generations')
        const expected = durableComponents(generations).map(dirname)
        mockedDirectories.clear()
        expected.forEach(directory => mockedDirectories.add(directory))
        mkdirDirectory.mockClear()
        failAt = failureIndex
        injectedFailure = new Error(`directory fsync ${String(failureIndex)} failed`)
        flushedDirectories.length = 0
        const local = new FaultStore({ profilesDir, installAnchor: TEST_INSTALL_ANCHOR, lockWaitMs: 100 })
        await expect(local.abort({ profile: 'web', generation })).rejects.toBe(injectedFailure)
        expect(flushedDirectories).toEqual(expected.slice(0, failureIndex + 1))
        expect(actualFs.existsSync(join(dirname(generations), 'writer.sqlite'))).toBe(false)
      }

      const root = await scratch('mkdir-fsync-success')
      const profilesDir = join(root, 'profiles')
      await makeProfile(profilesDir)
      const generations = join(profilesDir, '.dsh-profile-transactions', 'web', 'generations')
      await mkdir(generations, { recursive: true })
      const components = durableComponents(generations)
      const expected = components.map(dirname)
      mockedDirectories.clear()
      expected.forEach(directory => mockedDirectories.add(directory))
      mkdirDirectory.mockClear()
      failAt = -1
      injectedFailure = undefined
      flushedDirectories.length = 0
      const local = new FaultStore({ profilesDir, installAnchor: TEST_INSTALL_ANCHOR, lockWaitMs: 100 })
      await expect(local.abort({ profile: 'web', generation })).resolves.toBe(false)
      expect(mkdirDirectory.mock.calls.map(call => String(call[0]))).toEqual(components)
      expect(flushedDirectories).toEqual(expected)
      expect(actualFs.existsSync(join(dirname(generations), 'writer.sqlite'))).toBe(true)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('bounds both initially oversized and concurrently growing compressed artifacts', async () => {
    const root = await scratch('compressed-artifact-limit')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const maximum = 100 * 1024 * 1024
    const oversized = join(root, 'oversized.tgz')
    const growing = join(root, 'growing.tgz')
    await Promise.all([writeFile(oversized, ''), writeFile(growing, 'not-a-tar')])
    await truncate(oversized, maximum + 1)
    const actualPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let grew = false
    vi.resetModules()
    vi.doMock('node:fs/promises', () => ({
      ...actualPromises,
      async open(...args: Parameters<typeof actualPromises.open>) {
        const handle = await actualPromises.open(...args)
        if (String(args[0]) !== growing) return handle
        return {
          stat: handle.stat.bind(handle),
          async read(buffer: Buffer, offset: number, length: number, position: number) {
            if (!grew) {
              grew = true
              await actualPromises.truncate(growing, maximum + 1)
            }
            return handle.read(buffer, offset, length, position)
          },
          close: handle.close.bind(handle),
        }
      },
    }))
    try {
      const { LocalProfileTransactionStore: FaultStore } = await import('../src/runtime.ts')
      const local = new FaultStore({ profilesDir, installAnchor: TEST_INSTALL_ANCHOR, lockWaitMs: 100 })
      const before = await local.snapshot('web')
      const request = (mutationId: string, path: string): StoreStageRequest => ({
        profile: 'web',
        mutationId,
        expectedRevision: before.revision,
        expectedTreeDigest: before.treeDigest,
        mutation: {
          operation: 'install',
          kind: 'bundle',
          packageName: '@example/runtime',
          version: '1.0.0',
          artifact: { path, digest: ZERO_DIGEST },
        },
      })
      await expect(local.stage(request('oversized-compressed', oversized), () => {}))
        .rejects.toThrow(/compressed artifact exceeds 104857600 bytes/)
      await expect(local.stage(request('growing-compressed', growing), () => {}))
        .rejects.toThrow(/compressed artifact exceeds 104857600 bytes/)
      expect(grew).toBe(true)
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('lets a same-process retry replace a reservation after failed candidate removal', async () => {
    const root = await scratch('stage-cleanup-remove')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root)
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const primaryError = new Error('candidate construction failed')
    const cleanupError = new Error('candidate removal failed')
    let rejectCandidate = true
    let rejectRemove = true
    let candidateRoot = ''
    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actualFs,
      rmdirSync(path: Parameters<typeof actualFs.rmdirSync>[0]) {
        if (String(path) === candidateRoot && rejectRemove) {
          rejectRemove = false
          throw cleanupError
        }
        actualFs.rmdirSync(path)
      },
    }))
    try {
      const { LocalProfileTransactionStore: FaultStore } = await import('../src/runtime.ts')
      const local = new FaultStore({ profilesDir, installAnchor: TEST_INSTALL_ANCHOR, lockWaitMs: 100 }, {
        afterCandidateCopied(generationPath) {
          if (!rejectCandidate) return
          rejectCandidate = false
          candidateRoot = dirname(generationPath)
          throw primaryError
        },
      })
      const before = await local.snapshot('web')
      const request: StoreStageRequest = {
        profile: 'web',
        mutationId: 'stage-cleanup-remove',
        expectedRevision: before.revision,
        expectedTreeDigest: before.treeDigest,
        mutation: {
          operation: 'install', kind: 'bundle', packageName: '@example/runtime', version: '1.0.0', artifact,
        },
      }
      let observed: unknown
      try {
        await local.stage(request, () => {})
      } catch (error) {
        observed = error
      }
      expect(observed).toBeInstanceOf(AggregateError)
      expect((observed as AggregateError).errors).toEqual([primaryError, cleanupError])
      await expect(local.stage(request, () => {})).resolves.toMatchObject({ mutationId: request.mutationId })
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('uses portable artifact flags and accepts only Windows directory-fsync limitations', async () => {
    const root = await scratch('portable-durability')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const actualNativeCommand = await vi.importActual<typeof import('@deepseek-ai/dsh-native-command')>(
      '@deepseek-ai/dsh-native-command',
    )
    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actualFs,
      constants: { ...actualFs.constants, O_NOFOLLOW: undefined },
      fsyncSync(fd: number) {
        if (actualFs.fstatSync(fd).isDirectory()) {
          throw Object.assign(new Error('directory fsync unsupported'), { code: 'EINVAL' })
        }
        actualFs.fsyncSync(fd)
      },
    }))
    vi.doMock('@deepseek-ai/dsh-native-command', () => ({
      ...actualNativeCommand,
      currentProcessIncarnation: () => OWN_INCARNATION,
    }))
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const { LocalProfileTransactionStore: FaultStore } = await import('../src/runtime.ts')
      const local = new FaultStore({ profilesDir, installAnchor: TEST_INSTALL_ANCHOR, lockWaitMs: 100 })
      const before = await local.snapshot('web')
      await expect(local.stage({
        profile: 'web',
        mutationId: 'portable-durability',
        expectedRevision: before.revision,
        expectedTreeDigest: before.treeDigest,
        mutation: {
          operation: 'install', kind: 'bundle', packageName: '@example/runtime', version: '1.0.0', artifact,
        },
      }, () => {})).resolves.toMatchObject({ mutationId: 'portable-durability' })
    } finally {
      if (platform !== undefined) Object.defineProperty(process, 'platform', platform)
      vi.doUnmock('node:fs')
      vi.doUnmock('@deepseek-ai/dsh-native-command')
      vi.resetModules()
    }
  })

  it('rejects a special entry substituted after the validated tree digest', async () => {
    const root = await scratch('special-sync-entry')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root)
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    let specialPath = ''
    let canonicalSpecialPath = ''
    let postValidationReads = 0
    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actualFs,
      lstatSync(path: Parameters<typeof actualFs.lstatSync>[0]) {
        const syncRead = specialPath === canonicalSpecialPath ? 2 : 1
        if (String(path) === specialPath && ++postValidationReads === syncRead) {
          return {
            isDirectory: () => false,
            isFile: () => false,
            isSymbolicLink: () => false,
          }
        }
        return actualFs.lstatSync(path)
      },
    }))
    try {
      const { LocalProfileTransactionStore: FaultStore } = await import('../src/runtime.ts')
      const local = new FaultStore({ profilesDir, installAnchor: TEST_INSTALL_ANCHOR, lockWaitMs: 100 })
      const before = await local.snapshot('web')
      await expect(local.stage({
        profile: 'web',
        mutationId: 'special-sync-entry',
        expectedRevision: before.revision,
        expectedTreeDigest: before.treeDigest,
        mutation: {
          operation: 'install', kind: 'bundle', packageName: '@example/runtime', version: '1.0.0', artifact,
        },
      }, (candidate) => {
        specialPath = join(candidate.generationPath, 'cordis.patch.yml')
        canonicalSpecialPath = actualFs.realpathSync(specialPath)
      })).rejects.toThrow(/cannot flush unsupported generation entry/)
      expect(postValidationReads).toBeGreaterThanOrEqual(specialPath === canonicalSpecialPath ? 2 : 1)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('distinguishes secondary durable-write cleanup failures from an absent temporary', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const cleanupFaults = new Map<string, { readonly code: string; readonly message: string }>()
    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actualFs,
      unlinkSync(path: Parameters<typeof actualFs.unlinkSync>[0]) {
        for (const [statePath, fault] of cleanupFaults) {
          if (String(path).startsWith(`${statePath}.`) && String(path).endsWith('.tmp')) {
            throw Object.assign(new Error(fault.message), { code: fault.code })
          }
        }
        actualFs.unlinkSync(path)
      },
    }))
    try {
      const { LocalProfileTransactionStore: FaultStore } = await import('../src/runtime.ts')
      const commitWithCleanupFault = async (label: string, code: string, message: string): Promise<void> => {
        const root = await scratch(label)
        const profilesDir = join(root, 'profiles')
        await makeProfile(profilesDir)
        const artifact = await packedArtifact(root)
        const statePath = join(profilesDir, '.dsh-profile-transactions/web/state.json')
        cleanupFaults.set(statePath, { code, message })
        const local = new FaultStore({ profilesDir, installAnchor: TEST_INSTALL_ANCHOR, lockWaitMs: 100 }, {
          afterJournalPersisted() {
            actualFs.mkdirSync(statePath)
          },
        })
        const before = await local.snapshot('web')
        const staged = await local.stage({
          profile: 'web',
          mutationId: label,
          expectedRevision: before.revision,
          expectedTreeDigest: before.treeDigest,
          mutation: {
            operation: 'install', kind: 'bundle', packageName: '@example/runtime', version: '1.0.0', artifact,
          },
        }, () => {})
        await local.commit({
          profile: 'web',
          expectedRevision: before.revision,
          expectedTreeDigest: before.treeDigest,
          generation: staged.generation,
        })
      }
      await expect(commitWithCleanupFault('cleanup-denied', 'EPERM', 'cleanup denied'))
        .rejects.toThrow('cleanup denied')
      await expect(commitWithCleanupFault('cleanup-absent', 'ENOENT', 'temporary already absent'))
        .rejects.not.toThrow('temporary already absent')
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })
})
