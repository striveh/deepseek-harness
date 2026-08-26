import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { Context } from '@deepseek-ai/cordis'
import { profileId, profileMutationId, profileTreeDigest } from '@deepseek-ai/dsh-profile-transactions'
import { create } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import LocalProfileTransactions from '../src/index.ts'
import { LocalProfileTransactionStore } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
const children = new Set<ChildProcess>()

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) await once(child, 'close')
  }))
  children.clear()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function fixtures(root: string): Promise<{ profilesDir: string; artifactPath: string; digest: string }> {
  const profilesDir = join(root, 'profiles')
  const profileDir = join(profilesDir, 'web')
  const source = join(root, 'source')
  const packageRoot = join(source, 'package')
  await mkdir(packageRoot, { recursive: true })
  await mkdir(profileDir, { recursive: true })
  await Promise.all([
    writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, null, 2)}\n`),
    writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n'),
    writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nautoInstallPeers: false\n'),
    writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\nsettings:\n  autoInstallPeers: false\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    dependencies: {}\npackages: {}\nsnapshots: {}\n'),
    writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@example/process-race',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2)}\n`),
    writeFile(join(packageRoot, 'cordis.patch.yml'), '[]\n'),
  ])
  const artifactPath = join(root, 'bundle.tgz')
  await create({ cwd: source, file: artifactPath, gzip: true, portable: true }, ['package'])
  const digest = `sha256:${createHash('sha256').update(await readFile(artifactPath)).digest('hex')}`
  return { profilesDir, artifactPath, digest }
}

async function waitForReady(barrierDir: string): Promise<void> {
  for (;;) {
    const entries = await readdir(barrierDir)
    if (entries.filter(entry => entry.startsWith('ready-')).length === 2) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function runWorker(file: string, args: readonly string[]): {
  child: ChildProcess
  close: Promise<unknown[]>
  stdout: Promise<string>
  stderr: Promise<string>
} {
  const child = spawn(process.execPath, ['--no-warnings', '--import', import.meta.resolve('tsx/esm'), file, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  const close = once(child, 'close')
  const collect = (stream: NodeJS.ReadableStream): Promise<string> => new Promise((resolvePromise, reject) => {
    let value = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => { value += String(chunk) })
    stream.on('end', () => { resolvePromise(value) })
    stream.on('error', reject)
  })
  return { child, close, stdout: collect(child.stdout), stderr: collect(child.stderr) }
}

function nextWorkerMessage(owner: Worker): Promise<{ kind: string; generation?: string }> {
  return new Promise((resolvePromise, reject) => {
    owner.once('message', resolvePromise)
    owner.once('error', reject)
  })
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolvePromise, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`worker-thread test timed out during ${label}`))
        }, 3_000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function service(profilesDir: string): Promise<{ ctx: Context; dispose(): Promise<void> }> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalProfileTransactions, {
    profilesDir,
    installAnchor: fileURLToPath(import.meta.url),
    lockWaitMs: 5_000,
  })
  await fiber
  return { ctx, async dispose() { await fiber.dispose(); await ctx.fiber.dispose() } }
}

describe('cross-process Profile writer coordination', () => {
  it('does not steal a building reservation owned by another worker thread in the same process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-worker-thread-owner-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const { profilesDir, artifactPath, digest } = await fixtures(root)
    const workerUrl = new URL('./worker-thread-stage-owner.ts', import.meta.url)
    const owner = new Worker(
      `import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(workerUrl.href)}, ${JSON.stringify(workerUrl.href)}))`,
      {
        eval: true,
        workerData: { profilesDir, artifactPath, digest },
      },
    )
    try {
      await expect(within(nextWorkerMessage(owner), 'owner validation')).resolves.toEqual({ kind: 'validating' })
      const contender = new LocalProfileTransactionStore({
        profilesDir,
        installAnchor: fileURLToPath(import.meta.url),
        lockWaitMs: 50,
      })
      const before = await contender.snapshot('web')
      await expect(within(contender.stage({
        profile: 'web',
        mutationId: 'worker-thread-owner',
        expectedRevision: before.revision,
        expectedTreeDigest: before.treeDigest,
        mutation: {
          operation: 'install',
          kind: 'bundle',
          packageName: '@example/process-race',
          version: '1.0.0',
          artifact: { path: artifactPath, digest },
        },
      }, () => {}), 'contender timeout')).rejects.toThrow(/is still staging/)
      const completion = nextWorkerMessage(owner)
      owner.postMessage('release')
      const completed = await within(completion, 'owner completion')
      expect(completed.kind).toBe('complete')
      expect(typeof completed.generation).toBe('string')
      if (completed.generation === undefined) throw new Error('owner did not return its completed generation')
      expect(await readdir(join(profilesDir, '.dsh-profile-transactions/web/generations')))
        .toEqual([completed.generation])
    } finally {
      await within(owner.terminate(), 'owner termination')
    }
  }, 20_000)

  it('replaces a building reservation after its owning worker thread terminates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-worker-thread-recovery-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const { profilesDir, artifactPath, digest } = await fixtures(root)
    const workerUrl = new URL('./worker-thread-stage-owner.ts', import.meta.url)
    const owner = new Worker(
      `import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(workerUrl.href)}, ${JSON.stringify(workerUrl.href)}))`,
      {
        eval: true,
        workerData: { profilesDir, artifactPath, digest },
      },
    )
    await expect(within(nextWorkerMessage(owner), 'owner validation')).resolves.toEqual({ kind: 'validating' })
    await within(owner.terminate(), 'abrupt owner termination')

    const recovered = new LocalProfileTransactionStore({
      profilesDir,
      installAnchor: fileURLToPath(import.meta.url),
      lockWaitMs: 1_000,
    })
    const before = await recovered.snapshot('web')
    const staged = await within(recovered.stage({
      profile: 'web',
      mutationId: 'worker-thread-owner',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: {
        operation: 'install',
        kind: 'bundle',
        packageName: '@example/process-race',
        version: '1.0.0',
        artifact: { path: artifactPath, digest },
      },
    }, () => {}), 'replacement staging')

    await expect(readdir(join(profilesDir, '.dsh-profile-transactions/web/generations')))
      .resolves.toEqual([staged.generation])
    await expect(readdir(join(profilesDir, '.dsh-profile-transactions/web/stage-leases')))
      .resolves.toEqual([])
  }, 20_000)

  it('serializes two operating-system processes and rejects the stale revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-process-race-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const { profilesDir, artifactPath, digest } = await fixtures(root)
    const barrierDir = join(root, 'barrier')
    await mkdir(barrierDir)
    const worker = fileURLToPath(new URL('./cross-process-worker.ts', import.meta.url))
    const args = [profilesDir, artifactPath, digest, barrierDir] as const
    const left = runWorker(worker, args)
    const right = runWorker(worker, args)

    await waitForReady(barrierDir)
    await writeFile(join(barrierDir, 'go'), '')
    const [leftClose, rightClose] = await Promise.all([left.close, right.close])
    const [leftOut, rightOut, leftErr, rightErr] = await Promise.all([left.stdout, right.stdout, left.stderr, right.stderr])
    expect(leftClose[0], leftErr).toBe(0)
    expect(rightClose[0], rightErr).toBe(0)
    const outcomes = [JSON.parse(leftOut) as { status: string }, JSON.parse(rightOut) as { status: string }]
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['committed', 'conflict'])

    const app = await service(profilesDir)
    cleanups.push(() => app.dispose())
    expect(await app.ctx.profileTransactions.snapshot(profileId('web'))).toMatchObject({
      revision: 1,
      bootStatus: 'pending-restart',
    })
  }, 20_000)

  it('projects a durable journal after a real SIGKILL between journal fsync and state publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-process-kill-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const { profilesDir, artifactPath, digest } = await fixtures(root)
    const worker = fileURLToPath(new URL('./journal-kill-worker.ts', import.meta.url))
    const killed = runWorker(worker, [profilesDir, artifactPath, digest])
    const close = await killed.close
    const [stdout, stderr] = await Promise.all([killed.stdout, killed.stderr])
    expect(stdout).toContain('journal-durable')
    expect(close[0], stderr).not.toBe(0)

    const app = await service(profilesDir)
    cleanups.push(() => app.dispose())
    const projected = await app.ctx.profileTransactions.snapshot(profileId('web'))
    expect(projected).toMatchObject({ revision: 1, bootStatus: 'pending-restart' })
    expect(typeof projected.activeGeneration).toBe('string')
    expect(await readFile(join(profilesDir, '.dsh-profile-transactions/web/journal.json'), 'utf8'))
      .toContain('"kind": "commit"')
  }, 20_000)

  it('recovers and exactly replays a commit after SIGKILL between state fsync and receipt commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-commit-state-kill-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const { profilesDir, artifactPath, digest } = await fixtures(root)
    const beforeStore = new LocalProfileTransactionStore({
      profilesDir, installAnchor: fileURLToPath(import.meta.url), lockWaitMs: 5_000,
    })
    const originalBefore = await beforeStore.snapshot('web')
    const worker = fileURLToPath(new URL('./commit-state-kill-worker.ts', import.meta.url))
    const killed = runWorker(worker, [profilesDir, artifactPath, digest])
    const close = await killed.close
    const [stdout, stderr] = await Promise.all([killed.stdout, killed.stderr])
    expect(stdout).toContain('commit-state-durable')
    expect(close[0], stderr).not.toBe(0)
    const generationLine = stdout.split('\n').find(line => line.startsWith('commit-generation:'))
    if (generationLine === undefined) throw new Error('commit worker did not emit its generation')
    const generation = generationLine.slice('commit-generation:'.length)

    await writeFile(join(profilesDir, 'web', 'cordis.patch.yml'), '# abandoned live tree changed\n[]\n')
    const recovered = new LocalProfileTransactionStore({
      profilesDir, installAnchor: fileURLToPath(import.meta.url), lockWaitMs: 5_000,
    })
    const current = await recovered.snapshot('web')
    let validations = 0
    const mutation = {
      operation: 'install' as const,
      kind: 'bundle' as const,
      packageName: '@example/process-race',
      version: '1.0.0',
      artifact: { path: artifactPath, digest },
    }
    const staged = await recovered.stage({
      profile: 'web',
      mutationId: 'commit-state-kill',
      expectedRevision: current.revision,
      expectedTreeDigest: current.treeDigest,
      mutation,
    }, () => { validations += 1 })
    expect(staged.generation).toBe(generation)
    expect(validations).toBe(0)
    const receipt = await recovered.commit({
      profile: 'web',
      expectedRevision: current.revision,
      expectedTreeDigest: current.treeDigest,
      generation,
    })
    expect(receipt).toMatchObject({
      before: { revision: 0, treeDigest: originalBefore.treeDigest },
      after: { revision: 1, activeGeneration: generation },
    })
    expect((await recovered.snapshot('web')).revision).toBe(1)
    await expect(access(join(profilesDir, '.dsh-profile-transactions/web/journal.json'))).rejects.toThrow()

    const reopened = new LocalProfileTransactionStore({
      profilesDir, installAnchor: fileURLToPath(import.meta.url), lockWaitMs: 5_000,
    })
    const cold = await reopened.snapshot('web')
    const coldStage = await reopened.stage({
      profile: 'web',
      mutationId: 'commit-state-kill',
      expectedRevision: cold.revision,
      expectedTreeDigest: cold.treeDigest,
      mutation,
    }, () => { throw new Error('cold replay must not re-run validation') })
    await expect(reopened.commit({
      profile: 'web',
      expectedRevision: cold.revision,
      expectedTreeDigest: cold.treeDigest,
      generation: coldStage.generation,
    })).resolves.toEqual(receipt)

    const recordPath = join(
      profilesDir,
      '.dsh-profile-transactions/web/generations',
      generation,
      'generation.json',
    )
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
    record['basedOnTreeDigest'] = `sha256:${'0'.repeat(64)}`
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`)
    const corrupted = new LocalProfileTransactionStore({
      profilesDir, installAnchor: fileURLToPath(import.meta.url), lockWaitMs: 5_000,
    })
    await expect(corrupted.stage({
      profile: 'web',
      mutationId: 'commit-state-kill',
      expectedRevision: cold.revision,
      expectedTreeDigest: cold.treeDigest,
      mutation,
    }, () => {})).rejects.toThrow(/base digest does not match immutable evidence/)
  }, 20_000)

  it('recovers the same mutation key after SIGKILL immediately after its staging reservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-stage-reservation-kill-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const { profilesDir, artifactPath, digest } = await fixtures(root)
    const worker = fileURLToPath(new URL('./stage-reservation-kill-worker.ts', import.meta.url))
    const killed = runWorker(worker, [profilesDir, artifactPath, digest])
    const close = await killed.close
    const [stdout, stderr] = await Promise.all([killed.stdout, killed.stderr])
    expect(stdout).toContain('stage-reservation-durable')
    expect(close[0], stderr).not.toBe(0)

    const store = new LocalProfileTransactionStore({
      profilesDir, installAnchor: fileURLToPath(import.meta.url), lockWaitMs: 5_000,
    })
    await store.initialize()
    const before = await store.snapshot('web')
    const staged = await store.stage({
      profile: 'web',
      mutationId: 'stage-reservation-kill',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: {
        operation: 'install',
        kind: 'bundle',
        packageName: '@example/process-race',
        version: '1.0.0',
        artifact: { path: artifactPath, digest },
      },
    }, () => {})
    expect(staged.mutationId).toBe('stage-reservation-kill')
    expect((await store.list('web')).staged).toEqual([
      expect.objectContaining({ generation: staged.generation, mutationId: 'stage-reservation-kill' }),
    ])
  }, 20_000)

  it('adopts the same fully flushed generation after SIGKILL before reservation finalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-generation-kill-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const { profilesDir, artifactPath, digest } = await fixtures(root)
    const worker = fileURLToPath(new URL('./generation-kill-worker.ts', import.meta.url))
    const killed = runWorker(worker, [profilesDir, artifactPath, digest])
    const close = await killed.close
    const [stdout, stderr] = await Promise.all([killed.stdout, killed.stderr])
    expect(stdout).toContain('generation-durable')
    expect(close[0], stderr).not.toBe(0)

    const store = new LocalProfileTransactionStore({
      profilesDir, installAnchor: fileURLToPath(import.meta.url), lockWaitMs: 5_000,
    })
    await store.initialize()
    const before = await store.snapshot('web')
    const staged = await store.stage({
      profile: 'web',
      mutationId: 'generation-kill',
      expectedRevision: before.revision,
      expectedTreeDigest: before.treeDigest,
      mutation: {
        operation: 'install',
        kind: 'bundle',
        packageName: '@example/process-race',
        version: '1.0.0',
        artifact: { path: artifactPath, digest },
      },
    }, () => {
      throw new Error('recovery must adopt the persisted generation without rebuilding it')
    })
    const generationsDir = join(profilesDir, '.dsh-profile-transactions/web/generations')
    expect(await readdir(generationsDir)).toEqual([staged.generation])
    expect(await readFile(join(
      generationsDir,
      staged.generation,
      'profile/node_modules/@example/process-race/cordis.patch.yml',
    ), 'utf8')).toBe('[]\n')
  }, 20_000)

  it('recovers and replays one restore key after SIGKILL in its durable journal window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-restore-kill-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const { profilesDir, artifactPath, digest } = await fixtures(root)
    const worker = fileURLToPath(new URL('./restore-journal-kill-worker.ts', import.meta.url))
    const killed = runWorker(worker, [profilesDir, artifactPath, digest])
    const close = await killed.close
    const [stdout, stderr] = await Promise.all([killed.stdout, killed.stderr])
    expect(stdout).toContain('restore-journal-durable')
    expect(close[0], stderr).not.toBe(0)
    const requestLine = stdout.split('\n').find(line => line.startsWith('restore-request:'))
    if (requestLine === undefined) throw new Error('restore worker did not emit its exact request')
    const raw = JSON.parse(requestLine.slice('restore-request:'.length)) as {
      profile: string
      mutationId: string
      expectedRevision: number
      expectedTreeDigest: string
    }

    const app = await service(profilesDir)
    cleanups.push(() => app.dispose())
    const request = {
      profile: profileId(raw.profile),
      mutationId: profileMutationId(raw.mutationId),
      expectedRevision: raw.expectedRevision,
      expectedTreeDigest: profileTreeDigest(raw.expectedTreeDigest),
    }
    const recovered = await app.ctx.profileTransactions.getRestoreReceipt({
      profile: request.profile,
      mutationId: request.mutationId,
    })
    if (recovered === null) throw new Error('restore receipt query did not recover the durable journal')
    expect(recovered.after).toMatchObject({
      revision: raw.expectedRevision + 1,
      activeGeneration: recovered.before.lastGoodGeneration,
      bootStatus: 'verified',
    })
    const revision = (await app.ctx.profileTransactions.snapshot(request.profile)).revision
    expect(await app.ctx.profileTransactions.restoreLastGood(request)).toEqual({
      operation: 'restore',
      before: recovered.before,
      after: recovered.after,
      restartRequired: true,
    })
    expect((await app.ctx.profileTransactions.snapshot(request.profile)).revision).toBe(revision)
  }, 20_000)
})
