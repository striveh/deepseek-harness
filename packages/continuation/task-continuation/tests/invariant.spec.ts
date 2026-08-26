import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as TaskContinuationInvariant from '../src/invariant.ts'

describe('task-continuation invariant companion', () => {
  it('reserves package ownership and releases it on fiber disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(TaskContinuationInvariant)

    expect(TaskContinuationInvariant.name).toBe('task-continuation-invariant')
    expect(TaskContinuationInvariant.inject).toEqual(['invariants'])
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-task-continuation', () => {})
    }).toThrow(/already registered/u)

    await fiber.dispose()
    await expect(ctx.plugin(TaskContinuationInvariant).await()).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
