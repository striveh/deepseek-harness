import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as DefinitionInvariant from '@deepseek-ai/dsh-profile-transactions/invariant'
import { describe, expect, it } from 'vitest'
import * as LocalInvariant from '../src/invariant.ts'

describe('Profile transaction invariant companions', () => {
  it.each([
    ['@deepseek-ai/dsh-profile-transactions', DefinitionInvariant],
    ['@deepseek-ai/dsh-profile-transactions-local', LocalInvariant],
  ] as const)('registers the explained empty invariant for %s', async (packageName, companion) => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(companion)
    expect(() => ctx.invariants.register(packageName, () => {})).toThrow(/already registered/)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
