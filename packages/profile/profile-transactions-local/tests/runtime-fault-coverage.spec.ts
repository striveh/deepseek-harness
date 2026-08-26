import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create, Header } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LocalProfileTransactionStore,
  digestProfileTree,
  type LocalProfileTransactionHooks,
  type StoreArtifactMutation,
  type StoreSnapshot,
  type StoreStageRequest,
} from '../src/runtime.ts'

const TEST_INSTALL_ANCHOR = fileURLToPath(import.meta.url)

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
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`
const PROFILE = 'web'
const PACKAGE = '@example/archive'
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function scratch(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-profile-fault-${label}-`))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function makeProfile(profilesDir: string): Promise<string> {
  const profile = join(profilesDir, PROFILE)
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
    writeFile(join(profile, 'cordis.yml'), 'excluded: true\n'),
  ])
  return profile
}

function store(
  profilesDir: string,
  lockWaitMs = 100,
  hooks: LocalProfileTransactionHooks = {},
): LocalProfileTransactionStore {
  return new LocalProfileTransactionStore({ profilesDir, installAnchor: TEST_INSTALL_ANCHOR, lockWaitMs }, hooks)
}

function artifactDigest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function packedArtifact(
  root: string,
  label: string,
  manifest: Record<string, unknown> = {
    name: PACKAGE,
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  },
  patch: 'file' | 'missing' | 'directory' = 'file',
): Promise<{ path: string; digest: string }> {
  const source = join(root, `source-${label}`)
  const packageRoot = join(source, 'package')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  if (patch === 'file') await writeFile(join(packageRoot, 'cordis.patch.yml'), '[]\n')
  if (patch === 'directory') await mkdir(join(packageRoot, 'cordis.patch.yml'))
  const path = join(root, `${label}.tgz`)
  await create({ cwd: source, file: path, gzip: true, portable: true }, ['package'])
  return { path, digest: artifactDigest(await readFile(path)) }
}

interface RawArchiveEntry {
  readonly path: string
  readonly type: 'Directory' | 'File' | 'SymbolicLink'
  readonly data?: string
  readonly declaredSize?: number
  readonly linkpath?: string
}

async function rawArtifact(root: string, label: string, entries: readonly RawArchiveEntry[]) {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.data ?? '', 'utf8')
    const header = Buffer.alloc(512)
    new Header({
      path: entry.path,
      type: entry.type,
      mode: entry.type === 'Directory' ? 0o755 : 0o644,
      size: entry.declaredSize ?? body.length,
      ...entry.linkpath === undefined ? {} : { linkpath: entry.linkpath },
      mtime: new Date(0),
    }).encode(header)
    chunks.push(header)
    if (body.length > 0) {
      chunks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512))
    }
  }
  chunks.push(Buffer.alloc(1024))
  const bytes = Buffer.concat(chunks)
  const path = join(root, `${label}.tgz`)
  await writeFile(path, bytes)
  return { path, digest: artifactDigest(bytes) }
}

function installRequest(
  before: StoreSnapshot,
  mutationId: string,
  artifact: { readonly path: string; readonly digest: string },
  options: { readonly kind?: 'package' | 'bundle'; readonly packageName?: string } = {},
): StoreStageRequest {
  return {
    profile: PROFILE,
    mutationId,
    expectedRevision: before.revision,
    expectedTreeDigest: before.treeDigest,
    mutation: {
      operation: 'install',
      kind: options.kind ?? 'bundle',
      packageName: options.packageName ?? PACKAGE,
      version: '1.0.0',
      artifact,
    },
  }
}

async function stageArtifact(
  local: LocalProfileTransactionStore,
  before: StoreSnapshot,
  mutationId: string,
  artifact: { readonly path: string; readonly digest: string },
  options: { readonly kind?: 'package' | 'bundle'; readonly packageName?: string } = {},
) {
  return local.stage(installRequest(before, mutationId, artifact, options), () => {})
}

describe('writer coordination and abort cleanup', () => {
  it('waits on a live reservation, times out, and aborts staged, missing, and authoritative generations', async () => {
    const root = await scratch('writer-wait')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root, 'writer')
    const owner = store(profilesDir, 500)
    const before = await owner.snapshot(PROFILE)
    const request = installRequest(before, 'live-writer', artifact)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const first = owner.stage(request, async () => {
      entered.resolve(undefined)
      await release.promise
    })
    await entered.promise

    await expect(store(profilesDir, 25).stage(request, () => {}))
      .rejects.toThrow(/is still staging/)
    release.resolve(undefined)
    const staged = await first

    await expect(owner.abort({ profile: PROFILE, generation: staged.generation })).resolves.toBe(true)
    await expect(owner.abort({ profile: PROFILE, generation: staged.generation })).resolves.toBe(false)

    const next = await stageArtifact(owner, before, 'authoritative-generation', artifact)
    const committed = await owner.commit({
      profile: PROFILE,
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      generation: next.generation,
    })
    await expect(owner.abort({ profile: PROFILE, generation: committed.after.activeGeneration! }))
      .rejects.toThrow(/authoritative and cannot be aborted/)
  })

  it('rolls back an operation fault and closes a connection whose BEGIN is busy', async () => {
    const root = await scratch('writer-rollback')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const local = store(profilesDir, 0)
    const internals = local as unknown as {
      withWriterLock<T>(profile: string, operation: () => T): Promise<T>
    }
    await expect(internals.withWriterLock(PROFILE, () => {
      throw new Error('injected writer fault')
    })).rejects.toThrow('injected writer fault')
    await expect(local.abort({ profile: PROFILE, generation: randomUUID() })).resolves.toBe(false)

    const { DatabaseSync } = await import('node:sqlite')
    const coordinator = join(profilesDir, '.dsh-profile-transactions', PROFILE, 'writer.sqlite')
    const holder = new DatabaseSync(coordinator)
    holder.exec('BEGIN IMMEDIATE')
    try {
      await expect(local.abort({ profile: PROFILE, generation: randomUUID() })).rejects.toThrow()
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
    await expect(local.abort({ profile: PROFILE, generation: randomUUID() })).resolves.toBe(false)
  })

  it('unlinks an unreferenced generation symlink without following it', async () => {
    const root = await scratch('abort-link')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const local = store(profilesDir)
    await local.abort({ profile: PROFILE, generation: randomUUID() })
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'kept'), 'kept')
    const generation = randomUUID()
    const link = join(profilesDir, '.dsh-profile-transactions', PROFILE, 'generations', generation)
    symlinkSync(outside, link, 'dir')

    await expect(local.abort({ profile: PROFILE, generation })).resolves.toBe(true)
    expect(existsSync(link)).toBe(false)
    await expect(readFile(join(outside, 'kept'), 'utf8')).resolves.toBe('kept')
  })

  it('rejects an active generation whose commit receipt disappeared and a baseline commit attempt', async () => {
    const root = await scratch('missing-commit-receipt')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const local = store(profilesDir)
    const before = await local.snapshot(PROFILE)
    const staged = await stageArtifact(local, before, 'missing-commit-receipt', await packedArtifact(root, 'missing-receipt'))
    const committed = await local.commit({
      profile: PROFILE,
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      generation: staged.generation,
    })

    await expect(local.commit({
      profile: PROFILE,
      expectedRevision: committed.after.revision,
      expectedTreeDigest: committed.after.treeDigest,
      generation: committed.after.lastGoodGeneration!,
    })).rejects.toThrow(/baseline generation cannot be committed/)

    const internals = local as unknown as {
      withWriterLock<T>(
        profile: string,
        operation: (database: { prepare(sql: string): { run(...args: unknown[]): unknown } }) => T,
      ): Promise<T>
    }
    await internals.withWriterLock(PROFILE, database => database.prepare(
      'DELETE FROM pointer_operations WHERE mutation_id = ?',
    ).run('missing-commit-receipt'))
    await expect(local.commit({
      profile: PROFILE,
      expectedRevision: committed.after.revision,
      expectedTreeDigest: committed.after.treeDigest,
      generation: staged.generation,
    })).rejects.toThrow(/active mutation generation has no durable commit receipt/)
  })

  it('fails loud when active or recoverable inventory entries disappear during projection', async () => {
    const root = await scratch('inventory-race')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const local = store(profilesDir)
    const before = await local.snapshot(PROFILE)
    const staged = await stageArtifact(local, before, 'inventory-race', await packedArtifact(root, 'inventory-race'))
    const committed = await local.commit({
      profile: PROFILE,
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      generation: staged.generation,
    })
    const internals = local as unknown as {
      readCompleteGeneration(profile: string, generation: string, verifyTree: boolean): unknown
    }
    const original = internals.readCompleteGeneration.bind(local)

    let activeReads = 0
    internals.readCompleteGeneration = (profile, generation, verifyTree) => {
      if (generation === committed.after.activeGeneration && ++activeReads === 3) throw new Error('injected active race')
      return original(profile, generation, verifyTree)
    }
    await expect(local.list(PROFILE)).rejects.toThrow(/active generation disappeared/)

    internals.readCompleteGeneration = original
    let recoveryReads = 0
    internals.readCompleteGeneration = (profile, generation, verifyTree) => {
      if (generation === committed.after.lastGoodGeneration && ++recoveryReads === 3) {
        throw new Error('injected recovery race')
      }
      return original(profile, generation, verifyTree)
    }
    await expect(local.list(PROFILE)).rejects.toThrow(/recoverable generation disappeared/)
    internals.readCompleteGeneration = original
  })

  it('contains durable journal removal races and preserves both commit failures', async () => {
    for (const removal of ['missing', 'directory'] as const) {
      const root = await scratch(`journal-remove-${removal}`)
      const profilesDir = join(root, 'profiles')
      await makeProfile(profilesDir)
      const journalPath = join(profilesDir, '.dsh-profile-transactions', PROFILE, 'journal.json')
      let mode: 'none' | typeof removal = 'none'
      const local = store(profilesDir, 100, {
        afterStatePersisted() {
          if (mode === 'none') return
          unlinkSync(journalPath)
          if (mode === 'directory') mkdirSync(journalPath)
        },
      })
      const before = await local.snapshot(PROFILE)
      const staged = await stageArtifact(local, before, `journal-remove-${removal}`, await packedArtifact(root, removal))
      const committed = await local.commit({
        profile: PROFILE,
        expectedRevision: before.revision,
        expectedTreeDigest: before.treeDigest,
        generation: staged.generation,
      })
      mode = removal
      const acknowledgement = local.acknowledgeBoot({
        profile: PROFILE,
        expectedRevision: committed.after.revision,
        expectedTreeDigest: committed.after.treeDigest,
        generation: staged.generation,
      })
      if (removal === 'missing') await expect(acknowledgement).resolves.toMatchObject({ restartRequired: false })
      else await expect(acknowledgement).rejects.toThrow()
    }

    const root = await scratch('baseline-cleanup-double-fault')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    let failCommit = false
    const local = store(profilesDir, 100, {
      afterJournalPersisted() {
        if (failCommit) throw new Error('injected commit failure')
      },
    })
    const before = await local.snapshot(PROFILE)
    const staged = await stageArtifact(local, before, 'baseline-cleanup-double-fault', await packedArtifact(root, 'double-fault'))
    const internals = local as unknown as {
      removeUnreferencedGeneration(profile: string, generation: string): void
    }
    internals.removeUnreferencedGeneration = () => {
      throw new Error('injected baseline cleanup failure')
    }
    failCommit = true
    await expect(local.commit({
      profile: PROFILE,
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      generation: staged.generation,
    })).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [
        expect.objectContaining({ message: 'injected commit failure' }),
        expect.objectContaining({ message: 'injected baseline cleanup failure' }),
      ],
    })
  })
})

describe('Profile tree copy and filesystem faults', () => {
  it('copies an internal self-link while excluding runtime configuration', async () => {
    const root = await scratch('copy-self-link')
    const profilesDir = join(root, 'profiles')
    const profile = await makeProfile(profilesDir)
    await symlink('.', join(profile, 'self'))
    const artifact = await packedArtifact(root, 'copy-self-link')
    const local = store(profilesDir)
    const before = await local.snapshot(PROFILE)
    const staged = await stageArtifact(local, before, 'copy-self-link', artifact)
    const generationProfile = join(
      profilesDir,
      '.dsh-profile-transactions',
      PROFILE,
      'generations',
      staged.generation,
      'profile',
    )
    expect(readlinkSync(join(generationProfile, 'self'))).toBe('.')
    expect(existsSync(join(generationProfile, 'cordis.yml'))).toBe(false)
    await local.abort({ profile: PROFILE, generation: staged.generation })
  })

  it('rejects a source changed to a file after its reservation and removes the partial generation', async () => {
    const root = await scratch('copy-file')
    const profilesDir = join(root, 'profiles')
    const profile = await makeProfile(profilesDir)
    const artifact = await packedArtifact(root, 'copy-file')
    const local = store(profilesDir, 100, {
      afterStageReservationPersisted() {
        rmSync(profile, { recursive: true })
        writeFileSync(profile, 'not a directory')
      },
    })
    const before = await local.snapshot(PROFILE)
    await expect(stageArtifact(local, before, 'copy-source-file', artifact)).rejects.toThrow(/is not a directory/)
    await expect(readdir(join(profilesDir, '.dsh-profile-transactions', PROFILE, 'generations'))).resolves.toEqual([])
  })

  it('rejects a symlink escape introduced after reservation and preserves its target', async () => {
    const root = await scratch('copy-escape')
    const profilesDir = join(root, 'profiles')
    const profile = await makeProfile(profilesDir)
    const outside = join(root, 'outside')
    await writeFile(outside, 'outside')
    const artifact = await packedArtifact(root, 'copy-escape')
    const local = store(profilesDir, 100, {
      afterStageReservationPersisted() {
        symlinkSync(outside, join(profile, 'escape'))
      },
    })
    const before = await local.snapshot(PROFILE)
    await expect(stageArtifact(local, before, 'copy-escape', artifact)).rejects.toThrow(/escapes the Profile tree/)
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside')
  })

  it.runIf(process.platform !== 'win32')('rejects FIFO entries in digest and copy admission', async () => {
    const root = await scratch('special-entry')
    const direct = join(root, 'direct')
    await mkdir(direct)
    const directFifo = join(direct, 'fifo')
    expect(spawnSync('mkfifo', [directFifo]).status).toBe(0)
    expect(() => digestProfileTree(direct)).toThrow(/special filesystem entry/)

    const profilesDir = join(root, 'profiles')
    const profile = await makeProfile(profilesDir)
    const artifact = await packedArtifact(root, 'special-entry')
    const local = store(profilesDir, 100, {
      afterStageReservationPersisted() {
        const fifo = join(profile, 'fifo')
        const result = spawnSync('mkfifo', [fifo])
        if (result.status !== 0) throw new Error(result.stderr.toString('utf8'))
      },
    })
    const before = await local.snapshot(PROFILE)
    await expect(stageArtifact(local, before, 'copy-special', artifact)).rejects.toThrow(/special filesystem entry/)
  })

  it.runIf(process.platform !== 'win32')('surfaces copyArtifact source and target IO admission faults', async () => {
    const root = await scratch('copy-io')
    const profilesDir = join(root, 'profiles')
    const profile = await makeProfile(profilesDir)
    const local = store(profilesDir)
    const before = await local.snapshot(PROFILE)
    const directoryArtifact = join(root, 'directory.tgz')
    await mkdir(directoryArtifact)
    await expect(stageArtifact(local, before, 'directory-artifact', {
      path: directoryArtifact,
      digest: ZERO_DIGEST,
    })).rejects.toThrow(/must be a regular file/)

    const artifact = await packedArtifact(root, 'target-permission')
    const artifactsDir = join(profile, '.dsh-artifacts')
    await mkdir(artifactsDir)
    await chmod(artifactsDir, 0o500)
    try {
      const changed = await local.snapshot(PROFILE)
      await expect(stageArtifact(local, changed, 'target-permission', artifact)).rejects.toThrow()
    } finally {
      await chmod(artifactsDir, 0o700)
    }
  })
})

describe('archive admission and failed extraction cleanup', () => {
  it('rejects package metadata that can execute or escape the requested capability', async () => {
    const root = await scratch('archive-metadata')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const local = store(profilesDir)
    const before = await local.snapshot(PROFILE)
    const base = { name: PACKAGE, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }
    const cases: Array<{
      readonly label: string
      readonly manifest: Record<string, unknown>
      readonly diagnostic: RegExp
      readonly kind?: 'package' | 'bundle'
      readonly patch?: 'file' | 'missing' | 'directory'
    }> = [
      { label: 'identity', manifest: { ...base, name: '@example/wrong' }, diagnostic: /archive identity/ },
      { label: 'dependencies', manifest: { ...base, dependencies: { dep: '1.0.0' } }, diagnostic: /cannot declare dependencies/ },
      { label: 'optional', manifest: { ...base, optionalDependencies: { dep: '1.0.0' } }, diagnostic: /cannot declare optionalDependencies/ },
      { label: 'bundled', manifest: { ...base, bundledDependencies: ['dep'] }, diagnostic: /cannot declare bundledDependencies/ },
      { label: 'bundle-deps', manifest: { ...base, bundleDependencies: ['dep'] }, diagnostic: /cannot declare bundleDependencies/ },
      { label: 'scripts-value', manifest: { ...base, scripts: 'install' }, diagnostic: /scripts must be an object/ },
      { label: 'lifecycle', manifest: { ...base, scripts: { prepare: 'node prepare.js' } }, diagnostic: /lifecycle script prepare/ },
      { label: 'bin', manifest: { ...base, bin: './cli.js' }, diagnostic: /cannot declare bin/ },
      { label: 'no-dsh', manifest: { name: PACKAGE, version: '1.0.0' }, diagnostic: /bundle declaration/ },
      { label: 'empty-dsh', manifest: { name: PACKAGE, version: '1.0.0', dsh: {} }, diagnostic: /bundle declaration/ },
      { label: 'number-patch', manifest: { ...base, dsh: { bundle: { patch: 1 } } }, diagnostic: /safe relative path/ },
      { label: 'empty-patch', manifest: { ...base, dsh: { bundle: { patch: '' } } }, diagnostic: /safe relative path/ },
      { label: 'backslash-patch', manifest: { ...base, dsh: { bundle: { patch: 'dir\\patch.yml' } } }, diagnostic: /safe relative path/ },
      { label: 'absolute-patch', manifest: { ...base, dsh: { bundle: { patch: '/patch.yml' } } }, diagnostic: /safe relative path/ },
      { label: 'escape-patch', manifest: { ...base, dsh: { bundle: { patch: '../patch.yml' } } }, diagnostic: /regular file inside/ },
      { label: 'missing-patch', manifest: { ...base, dsh: { bundle: { patch: './missing.yml' } } }, diagnostic: /regular file inside/ },
      { label: 'directory-patch', manifest: base, diagnostic: /regular file inside/, patch: 'directory' },
      { label: 'kind-mismatch', manifest: base, diagnostic: /requested kind package/, kind: 'package' },
    ]
    for (const testCase of cases) {
      const artifact = await packedArtifact(root, testCase.label, testCase.manifest, testCase.patch)
      const options = testCase.kind === undefined ? {} : { kind: testCase.kind }
      await expect(stageArtifact(local, before, `archive-${testCase.label}`, artifact, options))
        .rejects.toThrow(testCase.diagnostic)
    }
  })

  it('accepts a scriptless plain package without a bundle declaration', async () => {
    const root = await scratch('plain-package')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root, 'plain-package', { name: PACKAGE, version: '1.0.0' })
    const local = store(profilesDir)
    const before = await local.snapshot(PROFILE)
    const staged = await stageArtifact(local, before, 'plain-package', artifact, { kind: 'package' })
    await expect(local.abort({ profile: PROFILE, generation: staged.generation })).resolves.toBe(true)
  })

  it('rejects unsafe, unsupported, duplicate, and bounded raw tar entries', async () => {
    const root = await scratch('raw-archives')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const local = store(profilesDir)
    const before = await local.snapshot(PROFILE)
    const cases: Array<{ readonly label: string; readonly entries: readonly RawArchiveEntry[]; readonly diagnostic: RegExp }> = [
      { label: 'backslash', entries: [{ path: 'package\\bad', type: 'File' }], diagnostic: /unsafe archive entry/ },
      { label: 'absolute', entries: [{ path: '/package/bad', type: 'File' }], diagnostic: /unsafe archive entry/ },
      { label: 'parent', entries: [{ path: '../bad', type: 'File' }], diagnostic: /unsafe archive entry/ },
      { label: 'wrong-root', entries: [{ path: 'other/bad', type: 'File' }], diagnostic: /unsafe archive entry/ },
      {
        label: 'unsupported',
        entries: [{ path: 'package/link', type: 'SymbolicLink', linkpath: 'target' }],
        diagnostic: /unsupported type SymbolicLink/,
      },
      {
        label: 'duplicate',
        entries: [
          { path: 'package/file', type: 'File' },
          { path: 'package/file', type: 'File' },
          { path: 'package/ignored-after-rejection', type: 'File' },
        ],
        diagnostic: /duplicate entry/,
      },
      {
        label: 'entry-limit',
        entries: Array.from({ length: 10_001 }, (_, index) => ({
          path: `package/d-${String(index)}/`,
          type: 'Directory' as const,
        })),
        diagnostic: /entry or uncompressed-size limit/,
      },
      {
        label: 'byte-limit',
        entries: [{ path: 'package/big', type: 'File', declaredSize: 100 * 1024 * 1024 + 1 }],
        diagnostic: /entry or uncompressed-size limit/,
      },
      {
        label: 'truncated',
        entries: [{ path: 'package/truncated', type: 'File', declaredSize: 2_048 }],
        diagnostic: /TAR_BAD_ARCHIVE|Truncated input/,
      },
    ]
    for (const testCase of cases) {
      const artifact = await rawArtifact(root, testCase.label, testCase.entries)
      await expect(stageArtifact(local, before, `raw-${testCase.label}`, artifact)).rejects.toThrow(testCase.diagnostic)
    }
  })

  it('revalidates cumulative entries when the copied archive changes after preflight', async () => {
    const root = await scratch('archive-preflight-race')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root, 'archive-preflight-original')
    const manifest = JSON.stringify({
      name: PACKAGE,
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    const replacement = await rawArtifact(root, 'archive-preflight-replacement', [
      { path: 'package/', type: 'Directory' },
      { path: 'package/package.json', type: 'File', data: manifest },
      { path: 'package/package.json', type: 'File', data: manifest },
      { path: 'package/cordis.patch.yml', type: 'File', data: '[]\n' },
    ])
    const replacementBytes = await readFile(replacement.path)
    const local = store(profilesDir, 100, {
      afterArchivePreflight(artifactPath) {
        writeFileSync(artifactPath, replacementBytes)
      },
    })
    const before = await local.snapshot(PROFILE)
    await expect(stageArtifact(local, before, 'archive-preflight-race', artifact))
      .rejects.toThrow(/duplicate entry/)
  })

  it('rejects extract parser faults and preserves an earlier extract admission failure', async () => {
    const root = await scratch('archive-extract-faults')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root, 'archive-extract-original')
    const unsafeHeader = Buffer.alloc(512)
    new Header({
      path: '../escape',
      type: 'File',
      mode: 0o644,
      size: 2_048,
      mtime: new Date(0),
    }).encode(unsafeHeader)
    const cases = [
      { mutationId: 'extract-parser-fault', replacement: Buffer.from('not a tar'), diagnostic: /TAR_BAD_ARCHIVE/ },
      {
        mutationId: 'extract-admission-before-parser',
        replacement: Buffer.concat([unsafeHeader, Buffer.alloc(10)]),
        diagnostic: /unsafe archive entry/,
      },
    ]
    for (const testCase of cases) {
      const local = store(profilesDir, 100, {
        afterArchivePreflight(artifactPath) {
          writeFileSync(artifactPath, testCase.replacement)
        },
      })
      const before = await local.snapshot(PROFILE)
      await expect(stageArtifact(local, before, testCase.mutationId, artifact))
        .rejects.toThrow(testCase.diagnostic)
    }
  })

  it('rejects a copied artifact whose digest differs from the request', async () => {
    const root = await scratch('artifact-digest')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root, 'artifact-digest')
    const local = store(profilesDir)
    const before = await local.snapshot(PROFILE)
    await expect(stageArtifact(local, before, 'artifact-digest-mismatch', {
      path: artifact.path,
      digest: ZERO_DIGEST,
    })).rejects.toThrow(/artifact digest mismatch/)
  })
})

describe('complete Profile file admission faults', () => {
  async function rejectedProfile(
    label: string,
    mutate: (profile: string) => Promise<void>,
    diagnostic: RegExp,
  ): Promise<void> {
    const root = await scratch(`profile-${label}`)
    const profilesDir = join(root, 'profiles')
    const profile = await makeProfile(profilesDir)
    await mutate(profile)
    const local = store(profilesDir)
    const before = await local.snapshot(PROFILE)
    await expect(stageArtifact(local, before, `profile-${label}`, {
      path: join(root, 'unused.tgz'),
      digest: ZERO_DIGEST,
    })).rejects.toThrow(diagnostic)
  }

  async function writeManifest(profile: string, value: unknown): Promise<void> {
    await writeFile(join(profile, 'package.json'), `${JSON.stringify(value)}\n`)
  }

  async function installDependency(profile: string, version = '1.0.0'): Promise<void> {
    const packageRoot = join(profile, 'node_modules', 'dep')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({ name: 'dep', version })}\n`)
  }

  it('rejects malformed manifests, bundle lists, and required Profile files', async () => {
    const valid = { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
    const cases: Array<{ readonly label: string; readonly value: unknown; readonly diagnostic: RegExp }> = [
      { label: 'manifest-null', value: null, diagnostic: /must be a JSON object/ },
      { label: 'dependencies-array', value: { ...valid, dependencies: [] }, diagnostic: /dependencies must be a string map/ },
      { label: 'dependencies-value', value: { ...valid, dependencies: { dep: 1 } }, diagnostic: /dependencies must be a string map/ },
      { label: 'dsh-missing', value: { ...valid, dsh: undefined }, diagnostic: /must declare dsh\.profile\.bundles/ },
      { label: 'profile-missing', value: { ...valid, dsh: {} }, diagnostic: /must declare dsh\.profile\.bundles/ },
      { label: 'bundles-scalar', value: { ...valid, dsh: { profile: { bundles: 'bundle' } } }, diagnostic: /must declare/ },
      { label: 'bundles-value', value: { ...valid, dsh: { profile: { bundles: [1] } } }, diagnostic: /must declare/ },
      { label: 'bundles-duplicate', value: { ...valid, dsh: { profile: { bundles: ['dup', 'dup'] } } }, diagnostic: /contains duplicates/ },
    ]
    for (const testCase of cases) {
      await rejectedProfile(testCase.label, profile => writeManifest(profile, testCase.value), testCase.diagnostic)
    }
    await rejectedProfile('missing-patch', async (profile) => {
      await rm(join(profile, 'cordis.patch.yml'))
    }, /missing regular cordis\.patch\.yml/)
  })

  it('rejects malformed lockfile documents and dependency projections', async () => {
    const cases: Array<{ readonly label: string; readonly lock: string; readonly diagnostic: RegExp }> = [
      { label: 'invalid-yaml', lock: '[unterminated\n', diagnostic: /one valid YAML document/ },
      { label: 'wrong-version', lock: "lockfileVersion: '8.0'\n", diagnostic: /lockfileVersion '9\.0'/ },
      { label: 'missing-importer', lock: "lockfileVersion: '9.0'\nimporters: {}\npackages: {}\nsnapshots: {}\n", diagnostic: /no root importer/ },
      {
        label: 'dependencies-list',
        lock: "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: []\npackages: {}\nsnapshots: {}\n",
        diagnostic: /root dependencies must be a map/,
      },
      {
        label: 'packages-list',
        lock: "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\npackages: []\nsnapshots: {}\n",
        diagnostic: /packages must be a map/,
      },
    ]
    for (const testCase of cases) {
      await rejectedProfile(testCase.label, async (profile) => {
        await writeFile(join(profile, 'pnpm-lock.yaml'), testCase.lock)
      }, testCase.diagnostic)
    }

    await rejectedProfile('importer-mismatch', async (profile) => {
      await writeManifest(profile, {
        name: 'dsh-profile-web',
        dependencies: { dep: '1.0.0' },
        dsh: { profile: { bundles: [] } },
      })
      await installDependency(profile)
      await writeFile(join(profile, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      dep:
        specifier: 2.0.0
        version: 2.0.0
packages: {}
snapshots: {}
`)
    }, /importer does not match dep/)

    await rejectedProfile('importer-key-mismatch', async (profile) => {
      await writeManifest(profile, {
        name: 'dsh-profile-web',
        dependencies: { dep: '1.0.0' },
        dsh: { profile: { bundles: [] } },
      })
      await installDependency(profile)
      await writeFile(join(profile, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      other:
        specifier: 1.0.0
        version: 1.0.0
packages: {}
snapshots: {}
`)
    }, /importer does not match dep/)

    await rejectedProfile('artifact-snapshot', async (profile) => {
      await writeManifest(profile, {
        name: 'dsh-profile-web',
        dependencies: { dep: '1.0.0' },
        dsh: { profile: { bundles: [] } },
      })
      await installDependency(profile)
      await writeFile(join(profile, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      dep:
        specifier: 1.0.0
        version: file:.dsh-artifacts/dep.tgz
packages: {}
snapshots: {}
`)
    }, /no self-consistent artifact snapshot/)

    await rejectedProfile('artifact-integrity', async (profile) => {
      await writeManifest(profile, {
        name: 'dsh-profile-web',
        dependencies: { dep: '1.0.0' },
        dsh: { profile: { bundles: [] } },
      })
      await installDependency(profile)
      await mkdir(join(profile, '.dsh-artifacts'))
      await writeFile(join(profile, '.dsh-artifacts', 'dep.tgz'), 'wrong artifact bytes')
      await writeFile(join(profile, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      dep:
        specifier: 1.0.0
        version: file:.dsh-artifacts/dep.tgz
packages:
  dep@file:.dsh-artifacts/dep.tgz:
    resolution:
      integrity: sha512-invalid
      tarball: file:.dsh-artifacts/dep.tgz
    version: 1.0.0
snapshots:
  dep@file:.dsh-artifacts/dep.tgz: {}
`)
    }, /artifact integrity does not match dep/)

    await rejectedProfile('installed-mismatch', async (profile) => {
      await writeManifest(profile, {
        name: 'dsh-profile-web',
        dependencies: { dep: '1.0.0' },
        dsh: { profile: { bundles: [] } },
      })
      await installDependency(profile, '2.0.0')
    }, /installed dep does not match/)
  })

  it.runIf(process.platform !== 'win32')('rejects a regular but unreadable lockfile', async () => {
    const root = await scratch('profile-unreadable-lock')
    const profilesDir = join(root, 'profiles')
    const profile = await makeProfile(profilesDir)
    const local = store(profilesDir)
    const before = await local.snapshot(PROFILE)
    const lockfile = join(profile, 'pnpm-lock.yaml')
    let treeDigestReads = 0
    const request = {
      profile: PROFILE,
      mutationId: 'profile-unreadable-lock',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: {
        operation: 'install',
        kind: 'bundle',
        packageName: PACKAGE,
        version: '1.0.0',
        artifact: { path: join(root, 'unused.tgz'), digest: ZERO_DIGEST },
      } satisfies StoreArtifactMutation,
    } satisfies StoreStageRequest
    Object.defineProperty(request, 'expectedTreeDigest', {
      enumerable: true,
      get() {
        treeDigestReads += 1
        if (treeDigestReads === 3) chmodSync(lockfile, 0o000)
        return before.treeDigest
      },
    })
    try {
      await expect(local.stage(request, () => {})).rejects.toThrow(/missing readable pnpm-lock\.yaml/)
    } finally {
      await chmod(lockfile, 0o600)
    }
  })

  it('accepts absent lockfile sections and a non-exact existing dependency', async () => {
    const root = await scratch('profile-lock-defaults')
    const profilesDir = join(root, 'profiles')
    const profile = await makeProfile(profilesDir)
    await writeManifest(profile, {
      name: 'dsh-profile-web',
      dependencies: { dep: 'workspace:^' },
      dsh: { profile: { bundles: [] } },
    })
    await installDependency(profile)
    await writeFile(join(profile, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      dep:
        specifier: workspace:^
        version: link:../dep
`)
    const artifact = await packedArtifact(root, 'lock-defaults')
    const local = store(profilesDir)
    const before = await local.snapshot(PROFILE)
    const staged = await stageArtifact(local, before, 'lock-defaults', artifact)
    await expect(local.abort({ profile: PROFILE, generation: staged.generation })).resolves.toBe(true)

    const noDependencies = join(root, 'no-dependencies')
    const noDependenciesProfile = await makeProfile(noDependencies)
    await writeManifest(noDependenciesProfile, {
      name: 'dsh-profile-web',
      dsh: { profile: { bundles: [] } },
    })
    await writeFile(join(noDependenciesProfile, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
importers:
  .: {}
`)
    const second = store(noDependencies)
    const secondBefore = await second.snapshot(PROFILE)
    const secondStaged = await stageArtifact(second, secondBefore, 'missing-dependencies', artifact)
    await expect(second.abort({ profile: PROFILE, generation: secondStaged.generation })).resolves.toBe(true)
  })
})

describe('durable file cleanup faults', () => {
  async function stagedForCommit(
    root: string,
    hooks: LocalProfileTransactionHooks,
  ): Promise<{ local: LocalProfileTransactionStore; before: StoreSnapshot; generation: string; profilesDir: string }> {
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const artifact = await packedArtifact(root, 'durable')
    const local = store(profilesDir, 100, hooks)
    const before = await local.snapshot(PROFILE)
    const staged = await stageArtifact(local, before, 'durable-stage', artifact)
    return { local, before, generation: staged.generation, profilesDir }
  }

  it('tolerates a journal already removed after state publication', async () => {
    const root = await scratch('journal-missing')
    let journal = ''
    const fixture = await stagedForCommit(root, {
      afterJournalPersisted() {
        unlinkSync(journal)
      },
    })
    journal = join(fixture.profilesDir, '.dsh-profile-transactions', PROFILE, 'journal.json')
    await expect(fixture.local.commit({
      profile: PROFILE,
      expectedRevision: fixture.before.revision,
      expectedTreeDigest: fixture.before.treeDigest,
      generation: fixture.generation,
    })).resolves.toMatchObject({ operation: 'commit' })
    expect(existsSync(journal)).toBe(false)
  })

  it('surfaces a non-file journal cleanup target', async () => {
    const root = await scratch('journal-directory')
    let journal = ''
    const fixture = await stagedForCommit(root, {
      afterJournalPersisted() {
        unlinkSync(journal)
        mkdirSync(journal)
      },
    })
    journal = join(fixture.profilesDir, '.dsh-profile-transactions', PROFILE, 'journal.json')
    await expect(fixture.local.commit({
      profile: PROFILE,
      expectedRevision: fixture.before.revision,
      expectedTreeDigest: fixture.before.treeDigest,
      generation: fixture.generation,
    })).rejects.toThrow()
  })

  it('removes a durable-write temporary after state rename fails', async () => {
    const root = await scratch('state-directory')
    let state = ''
    const fixture = await stagedForCommit(root, {
      afterJournalPersisted() {
        mkdirSync(state)
      },
    })
    state = join(fixture.profilesDir, '.dsh-profile-transactions', PROFILE, 'state.json')
    await expect(fixture.local.commit({
      profile: PROFILE,
      expectedRevision: fixture.before.revision,
      expectedTreeDigest: fixture.before.treeDigest,
      generation: fixture.generation,
    })).rejects.toThrow()
    const entries = await readdir(join(fixture.profilesDir, '.dsh-profile-transactions', PROFILE))
    expect(entries.filter(entry => entry.startsWith('state.json.') && entry.endsWith('.tmp'))).toEqual([])
  })

  it('closes a durable-write descriptor when JSON encoding fails', async () => {
    const root = await scratch('json-encoding')
    const fixture = await stagedForCommit(root, {})
    const committed = (await fixture.local.commit({
      profile: PROFILE,
      expectedRevision: fixture.before.revision,
      expectedTreeDigest: fixture.before.treeDigest,
      generation: fixture.generation,
    })).after
    const beforeState = {
      profile: PROFILE,
      revision: committed.revision,
      activeGeneration: committed.activeGeneration,
      lastGoodGeneration: committed.lastGoodGeneration,
      rollbackGeneration: committed.rollbackGeneration,
    }
    const poisoned = new Proxy(beforeState, {
      get(target, property, receiver) {
        if (property === 'toJSON') throw new Error('injected JSON encoding fault')
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    const afterState = {
      ...beforeState,
      revision: beforeState.revision + 1,
      lastGoodGeneration: beforeState.activeGeneration,
      rollbackGeneration: beforeState.lastGoodGeneration,
    }
    const internals = fixture.local as unknown as {
      publishJournaled(kind: 'acknowledge-boot', before: typeof beforeState, after: typeof afterState): void
    }
    expect(() => { internals.publishJournaled('acknowledge-boot', poisoned, afterState) })
      .toThrow('injected JSON encoding fault')
    const transaction = join(fixture.profilesDir, '.dsh-profile-transactions', PROFILE)
    expect((await readdir(transaction)).filter(entry => entry.endsWith('.tmp'))).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('surfaces generation-directory fsync and lstat permission faults', async () => {
    const root = await scratch('directory-permissions')
    const profilesDir = join(root, 'profiles')
    await makeProfile(profilesDir)
    const local = store(profilesDir)
    await local.abort({ profile: PROFILE, generation: randomUUID() })
    const generations = join(profilesDir, '.dsh-profile-transactions', PROFILE, 'generations')

    const linkedGeneration = randomUUID()
    const outside = join(root, 'fsync-outside')
    await mkdir(outside)
    symlinkSync(outside, join(generations, linkedGeneration), 'dir')
    chmodSync(generations, 0o300)
    try {
      await expect(local.abort({ profile: PROFILE, generation: linkedGeneration })).rejects.toThrow()
    } finally {
      chmodSync(generations, 0o700)
    }

    chmodSync(generations, 0o000)
    try {
      await expect(local.abort({ profile: PROFILE, generation: randomUUID() })).rejects.toThrow()
    } finally {
      chmodSync(generations, 0o700)
    }
  })
})
