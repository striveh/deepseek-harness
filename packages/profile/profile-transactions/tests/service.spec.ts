import { Context } from '@deepseek-ai/cordis'
import {
  ProfileRevisionConflictError,
  ProfileContentConflictError,
  ProfileTransactions,
  profileArtifactDigest,
  profileContentDigest,
  profileId,
  profileMutationId,
  profileTreeDigest,
  type AbortProfileGenerationRequest,
  type CommitProfileGenerationRequest,
  type GetProfileRestoreReceiptRequest,
  type AcknowledgeProfileBootRequest,
  type ProfileCommitReceipt,
  type ProfileGenerationInventory,
  type ProfileId,
  type ProfileSnapshot,
  type ProfileRestoreReceipt,
  type RestoreLastGoodProfileRequest,
  type StageProfileGenerationRequest,
  type StagedProfileGeneration,
} from '@deepseek-ai/dsh-profile-transactions'
import { describe, expect, it } from 'vitest'

class StubProfileTransactions extends ProfileTransactions {
  readonly protocolVersion = 1 as const

  snapshot(profile: ProfileId): Promise<ProfileSnapshot> {
    return Promise.resolve({
      profile,
      revision: 0,
      treeDigest: profileTreeDigest(`sha256:${'0'.repeat(64)}`),
      effectivePath: '/profiles/web',
      activeGeneration: null,
      lastGoodGeneration: null,
      rollbackGeneration: null,
      bootStatus: 'live',
    })
  }

  stage(_request: StageProfileGenerationRequest): Promise<StagedProfileGeneration> {
    throw new Error('not implemented by the seam stub')
  }

  commit(_request: CommitProfileGenerationRequest): Promise<ProfileCommitReceipt> {
    throw new Error('not implemented by the seam stub')
  }

  abort(_request: AbortProfileGenerationRequest): Promise<boolean> {
    throw new Error('not implemented by the seam stub')
  }

  restoreLastGood(_request: RestoreLastGoodProfileRequest): Promise<ProfileCommitReceipt> {
    throw new Error('not implemented by the seam stub')
  }

  getRestoreReceipt(_request: GetProfileRestoreReceiptRequest): Promise<ProfileRestoreReceipt | null> {
    throw new Error('not implemented by the seam stub')
  }

  acknowledgeBoot(_request: AcknowledgeProfileBootRequest): Promise<ProfileCommitReceipt> {
    throw new Error('not implemented by the seam stub')
  }

  list(_profile: ProfileId): Promise<ProfileGenerationInventory> {
    throw new Error('not implemented by the seam stub')
  }
}

describe('Profile transaction Service Definition', () => {
  it('brands valid names and rejects path-shaped or reserved names', () => {
    expect(profileId('web')).toBe('web')
    for (const value of ['', '.', '..', 'node_modules', '.dsh-profile-transactions', 'nested/profile', 'nested\\profile']) {
      expect(() => profileId(value)).toThrow(/one non-reserved path segment/)
    }
  })

  it('accepts only canonical lowercase SHA-256 digests', () => {
    const valid = `sha256:${'a'.repeat(64)}`
    expect(profileArtifactDigest(valid)).toBe(valid)
    expect(profileContentDigest(valid)).toBe(valid)
    expect(profileTreeDigest(valid)).toBe(valid)
    for (const value of ['sha256:abcd', `SHA256:${'a'.repeat(64)}`, `sha256:${'A'.repeat(64)}`]) {
      expect(() => profileArtifactDigest(value)).toThrow(/64 lowercase hex/)
    }
  })

  it('accepts only bounded durable mutation identifiers', () => {
    expect(profileMutationId('install:example-1')).toBe('install:example-1')
    for (const value of ['', 'unsafe value', `x${'a'.repeat(128)}`]) {
      expect(() => profileMutationId(value)).toThrow(/1-128 safe identifier/)
    }
  })

  it('reports stable patch-content conflict fields', () => {
    const expected = profileContentDigest(`sha256:${'a'.repeat(64)}`)
    const actual = profileContentDigest(`sha256:${'b'.repeat(64)}`)
    expect(new ProfileContentConflictError(profileId('web'), expected, actual)).toMatchObject({
      name: 'ProfileContentConflictError',
      code: 'PROFILE_CONTENT_CONFLICT',
      profile: 'web',
      expected,
      actual,
    })
  })

  it('publishes one service implementation per context', async () => {
    const ctx = new Context()
    const first = ctx.plugin(StubProfileTransactions)
    await first
    expect(await ctx.profileTransactions.snapshot(profileId('web'))).toMatchObject({ revision: 0 })
    await expect(ctx.plugin(StubProfileTransactions)).rejects.toThrow(/service "profileTransactions" has been registered/)
    await first.dispose()
    await ctx.fiber.dispose()
  })

  it('reports stable revision conflict fields', () => {
    const error = new ProfileRevisionConflictError(profileId('web'), 2, 3)
    expect(error).toMatchObject({
      name: 'ProfileRevisionConflictError',
      code: 'PROFILE_REVISION_CONFLICT',
      profile: 'web',
      expected: 2,
      actual: 3,
    })
    expect(error.message).toContain('expected revision 2, now 3')
  })
})
