import { rmSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  homePatchPath: vi.fn<() => string>(),
  prepareTransactionalProfile: vi.fn(),
}))

vi.mock('../src/profile-boot.ts', () => mocks)

import { runDumpConfig } from '../src/dump-config.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  mocks.homePatchPath.mockReset()
  mocks.prepareTransactionalProfile.mockReset()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function preparedFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dump-runtime-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const rootConfig = join(root, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  const close = vi.fn<() => Promise<void>>().mockResolvedValue()
  const releaseRootConfig = vi.fn(() => { rmSync(root, { recursive: true, force: true }) })
  mocks.homePatchPath.mockReturnValue(join(root, 'missing-home-patch.yml'))
  mocks.prepareTransactionalProfile.mockResolvedValue({
    profile: {
      layers: [],
      patchPath: join(root, 'missing-profile-patch.yml'),
      patches: [],
    },
    rootConfig,
    snapshot: { effectivePath: join(root, 'authoritative-generation') },
    transactionConsumer: { close },
    releaseRootConfig,
  })
  return { close, releaseRootConfig, root, rootConfig }
}

describe('config dump runtime root', () => {
  it('removes the private root after a successful dump', async () => {
    const fixture = await preparedFixture()
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    await runDumpConfig('web', true, [])

    expect(fixture.close).toHaveBeenCalledOnce()
    expect(fixture.releaseRootConfig).toHaveBeenCalledOnce()
    await expect(lstat(fixture.rootConfig)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes the private root after composition fails', async () => {
    const fixture = await preparedFixture()

    await expect(runDumpConfig('web', false, [join(fixture.root, 'missing-overlay.yml')]))
      .rejects.toThrow(/missing-overlay/)

    expect(fixture.close).toHaveBeenCalledOnce()
    expect(fixture.releaseRootConfig).toHaveBeenCalledOnce()
    await expect(lstat(fixture.rootConfig)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('labels the authoritative managed patch while rendering bytes parsed from the private copy', async () => {
    const fixture = await preparedFixture()
    const authoritativeRoot = join(fixture.root, 'authoritative-generation')
    const authoritativePatch = join(authoritativeRoot, 'cordis.patch.yml')
    const privatePatch = join(fixture.root, 'private-execution-tree', 'cordis.patch.yml')
    await Promise.all([
      mkdir(authoritativeRoot, { recursive: true }),
      mkdir(join(fixture.root, 'private-execution-tree'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(authoritativePatch, '- insert:\n    - id: authoritative-bytes\n      name: authoritative\n'),
      writeFile(privatePatch, '- insert:\n    - id: private-copy-bytes\n      name: private\n'),
    ])
    mocks.prepareTransactionalProfile.mockResolvedValue({
      profile: {
        layers: [],
        patchPath: privatePatch,
        patches: [{ insert: [{ id: 'private-copy-bytes', name: 'private' }] }],
      },
      rootConfig: fixture.rootConfig,
      snapshot: { effectivePath: authoritativeRoot },
      transactionConsumer: { close: fixture.close },
      releaseRootConfig: fixture.releaseRootConfig,
    })
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    await runDumpConfig('web', false, [])

    const output = String(stdout.mock.calls[0]?.[0])
    expect(output).toContain(`# == ${authoritativePatch}`)
    expect(output).toContain('id: private-copy-bytes')
    expect(output).not.toContain(privatePatch)
    expect(output).not.toContain('authoritative-bytes')
  })
})
