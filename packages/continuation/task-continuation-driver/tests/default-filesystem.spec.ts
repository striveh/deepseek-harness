import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { openDirectory } = vi.hoisted(() => ({ openDirectory: vi.fn() }))

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  open: openDirectory,
}))

import { DurableTaskContinuationStore } from '../src/store.ts'

const roots: string[] = []

afterEach(async () => {
  openDirectory.mockReset()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function missingRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-continuation-default-fs-'))
  roots.push(parent)
  return join(parent, 'claims')
}

describe('default continuation-store directory durability adapter', () => {
  it('surfaces directory sync failure before creating SQLite state', async () => {
    const root = await missingRoot()
    const primary = new Error('directory sync failed')
    const close = vi.fn().mockResolvedValue(undefined)
    openDirectory.mockResolvedValue({ sync: vi.fn().mockRejectedValue(primary), close })

    await expect(new DurableTaskContinuationStore(root, 1_000).initialize()).rejects.toBe(primary)
    expect(close).toHaveBeenCalledOnce()
    await expect(access(join(root, 'claims.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('surfaces directory close failure after a successful sync', async () => {
    const root = await missingRoot()
    const cleanup = new Error('directory close failed')
    openDirectory.mockResolvedValue({ sync: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockRejectedValue(cleanup) })

    await expect(new DurableTaskContinuationStore(root, 1_000).initialize()).rejects.toBe(cleanup)
    await expect(access(join(root, 'claims.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves directory sync as primary when close also fails', async () => {
    const root = await missingRoot()
    const primary = new Error('directory sync failed')
    const cleanup = new Error('directory close failed')
    openDirectory.mockResolvedValue({ sync: vi.fn().mockRejectedValue(primary), close: vi.fn().mockRejectedValue(cleanup) })

    try {
      await new DurableTaskContinuationStore(root, 1_000).initialize()
      expect.unreachable('store initialization ignored directory durability failures')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([primary, cleanup])
      expect((error as AggregateError).cause).toBe(primary)
    }
    await expect(access(join(root, 'claims.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
