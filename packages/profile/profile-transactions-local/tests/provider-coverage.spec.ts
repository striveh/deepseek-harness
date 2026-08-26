import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  ProfileRevisionConflictError,
  profileId,
  type ProfileId,
} from '@deepseek-ai/dsh-profile-transactions'
import { afterEach, describe, expect, it } from 'vitest'
import LocalProfileTransactions, {
  DEFAULT_PROFILE_VALIDATION_TIMEOUT_MS,
  MAX_PROFILE_VALIDATION_TIMEOUT_MS,
} from '../src/index.ts'
import { LocalProfileRevisionConflictError } from '../src/runtime.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

describe('local Profile provider projections', () => {
  it('uses the default lock wait and projects every public route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-provider-coverage-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const anchor = join(root, 'package.json')
    await writeFile(anchor, '{}\n')
    expect(LocalProfileTransactions.Config({ profilesDir: root, installAnchor: anchor })).toMatchObject({
      lockWaitMs: 10_000,
      validationTimeoutMs: DEFAULT_PROFILE_VALIDATION_TIMEOUT_MS,
    })
    expect(LocalProfileTransactions.Config({
      profilesDir: root,
      installAnchor: anchor,
      validationTimeoutMs: MAX_PROFILE_VALIDATION_TIMEOUT_MS,
    }).validationTimeoutMs).toBe(MAX_PROFILE_VALIDATION_TIMEOUT_MS)
    for (const validationTimeoutMs of [0, 1.5, MAX_PROFILE_VALIDATION_TIMEOUT_MS + 1]) {
      expect(() => LocalProfileTransactions.Config({ profilesDir: root, installAnchor: anchor, validationTimeoutMs }))
        .toThrow()
    }
    const ctx = new Context()
    const directContext = new Context()
    const direct = new LocalProfileTransactions(directContext, {
      profilesDir: join(root, 'direct-profiles'),
      installAnchor: anchor,
    })
    expect(direct.protocolVersion).toBe(1)
    expect((direct as unknown as { validationTimeoutMs: number }).validationTimeoutMs)
      .toBe(DEFAULT_PROFILE_VALIDATION_TIMEOUT_MS)
    await directContext.fiber.dispose()
    const fiber = ctx.plugin(LocalProfileTransactions, { profilesDir: join(root, 'profiles'), installAnchor: anchor })
    await fiber
    cleanups.push(async () => { await fiber.dispose(); await ctx.fiber.dispose() })

    const service = ctx.profileTransactions as unknown as {
      store: Record<string, unknown>
      validateCandidate(profile: string, generationPath: string): Promise<void>
    }
    const digest = `sha256:${'a'.repeat(64)}`
    Object.defineProperty(service, 'store', {
      configurable: true,
      value: {
        snapshot: async () => { throw new LocalProfileRevisionConflictError('web', 1, 2) },
        abort: async () => true,
        list: async (profile: ProfileId) => ({
          snapshot: {
            profile,
            revision: 1,
            treeDigest: digest,
            effectivePath: '/generation',
            activeGeneration: '11111111-1111-4111-8111-111111111111',
            lastGoodGeneration: null,
            rollbackGeneration: null,
            bootStatus: 'pending-restart',
          },
          active: {
            generation: '11111111-1111-4111-8111-111111111111',
            treeDigest: digest,
            mutationId: null,
            mutation: null,
          },
          staged: [],
          recoverable: [],
        }),
      },
    })

    await expect(ctx.profileTransactions.snapshot(profileId('web'))).rejects.toBeInstanceOf(ProfileRevisionConflictError)
    await expect(ctx.profileTransactions.abort({
      profile: profileId('web'),
      generation: '22222222-2222-4222-8222-222222222222' as never,
    })).resolves.toBe(true)
    await expect(ctx.profileTransactions.list(profileId('web'))).resolves.toMatchObject({
      active: { generation: '11111111-1111-4111-8111-111111111111' },
    })
    Object.defineProperty(service, 'store', {
      configurable: true,
      value: {
        list: async (profile: ProfileId) => ({
          snapshot: {
            profile,
            revision: 0,
            treeDigest: digest,
            effectivePath: '/profile',
            activeGeneration: null,
            lastGoodGeneration: null,
            rollbackGeneration: null,
            bootStatus: 'live',
          },
          active: null,
          staged: [],
          recoverable: [],
        }),
      },
    })
    await expect(ctx.profileTransactions.list(profileId('web'))).resolves.toMatchObject({ active: null })
    expect(() => service.validateCandidate('web', 'relative')).toThrow(/generation path must be absolute/)
  })
})
