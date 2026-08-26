/**
 * Pre-Loader Profile transaction Consumer. It resolves the immutable active
 * tree before the main composition exists and acknowledges that exact tree
 * only after the real app Loader boot succeeds.
 * @module @deepseek-ai/dsh/profile-transactions
 */

import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { PROFILES_DIR } from '@deepseek-ai/dsh-app-boot'
import {
  profileId,
  type ProfileId,
  type ProfileSnapshot,
  type ProfileTransactions,
} from '@deepseek-ai/dsh-profile-transactions'
import LocalProfileTransactions from '@deepseek-ai/dsh-profile-transactions-local'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { INSTALL_ANCHOR } from './install-anchor.ts'

/** Short-lived Consumer handle used before and immediately after main app boot. */
export interface ProfileTransactionConsumer {
  readonly profile: ProfileId
  readonly transactions: ProfileTransactions
  /** Dispose the bootstrap provider after resolution or boot acknowledgement. */
  close(): Promise<void>
}

/**
 * Mount the same local transaction owner used by the runtime composition.
 * This bootstrap context never changes which tree the current process uses.
 * @param name - named Profile to resolve.
 * @returns transaction service and bounded disposal handle.
 */
export async function openProfileTransactionConsumer(name: string): Promise<ProfileTransactionConsumer> {
  const profile = profileId(name)
  const ctx = new Context()
  const fiber = ctx.plugin(LocalProfileTransactions, {
    profilesDir: join(resolveDshHome(), PROFILES_DIR),
    installAnchor: INSTALL_ANCHOR,
  })
  try {
    await fiber
  } catch (error) {
    try {
      await ctx.fiber.dispose()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'dsh: Profile transaction bootstrap failed and root cleanup also failed',
        { cause: error },
      )
    }
    throw error
  }
  return {
    profile,
    transactions: ctx.profileTransactions,
    async close() {
      const failures: unknown[] = []
      try {
        await fiber.dispose()
      } catch (error) {
        failures.push(error)
      }
      try {
        await ctx.fiber.dispose()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) {
        throw new AggregateError(failures, 'dsh: multiple Profile transaction bootstrap cleanup operations failed')
      }
    },
  }
}

/**
 * Acknowledge one resolved active generation after real Loader activation.
 * A concurrent mutation or external tree edit rejects the acknowledgement.
 * @param consumer - bootstrap transaction Consumer.
 * @param snapshot - exact tree that the app process booted.
 */
export async function acknowledgeProfileBoot(
  consumer: ProfileTransactionConsumer,
  snapshot: ProfileSnapshot,
): Promise<void> {
  if (snapshot.activeGeneration === null) return
  await consumer.transactions.acknowledgeBoot({
    profile: consumer.profile,
    expectedRevision: snapshot.revision,
    expectedTreeDigest: snapshot.treeDigest,
    generation: snapshot.activeGeneration,
  })
}
