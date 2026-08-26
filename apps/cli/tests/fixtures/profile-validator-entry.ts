import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { profileContentDigest, profileId, profileMutationId } from '@deepseek-ai/dsh-profile-transactions'
import LocalProfileTransactions, {
  PROFILE_VALIDATOR_ARG,
  runProfileValidatorChild,
} from '@deepseek-ai/dsh-profile-transactions-local'

function digest(value: string) {
  return profileContentDigest(`sha256:${createHash('sha256').update(value).digest('hex')}`)
}

async function stageThroughOwner(mode: string, profilesDir: string, installAnchor: string): Promise<void> {
  if (mode !== 'valid' && mode !== 'broken') throw new Error(`profile-validator fixture: unknown mode ${mode}`)
  const ctx = new Context()
  const fiber = ctx.plugin(LocalProfileTransactions, { profilesDir, installAnchor })
  await fiber
  try {
    const profile = profileId('web')
    const before = await ctx.profileTransactions.snapshot(profile)
    const current = await readFile(join(before.effectivePath, 'cordis.patch.yml'), 'utf8')
    const nextUtf8 = mode === 'valid'
      ? `# owner-validated\n${current}`
      : "- insert:\n    - id: web-startup\n      name: './broken-sentinel.mjs'\n"
    try {
      const staged = await ctx.profileTransactions.stage({
        profile,
        mutationId: profileMutationId(`validator-${mode}`),
        expectedRevision: before.revision,
        expectedTreeDigest: before.treeDigest,
        mutation: {
          operation: 'configure',
          packageName: 'owner-package',
          patch: {
            expectedDigest: digest(current),
            nextUtf8,
            nextDigest: digest(nextUtf8),
          },
        },
      })
      if (mode === 'broken') {
        await ctx.profileTransactions.abort({ profile, generation: staged.generation })
        throw new Error('profile-validator fixture: broken Loader candidate unexpectedly staged')
      }
      const inventory = await ctx.profileTransactions.list(profile)
      const summary = inventory.staged.find(item => item.generation === staged.generation)
      if (summary?.treeDigest !== staged.treeDigest) {
        throw new Error('profile-validator fixture: owner changed candidate bytes during validation')
      }
      await ctx.profileTransactions.abort({ profile, generation: staged.generation })
      process.stdout.write('{"validated":true}\n')
    } catch (error) {
      if (mode !== 'broken') throw error
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('broken Loader sentinel')) throw error
      const after = await ctx.profileTransactions.snapshot(profile)
      const inventory = await ctx.profileTransactions.list(profile)
      if (JSON.stringify(after) !== JSON.stringify(before) || inventory.staged.length !== 0) {
        throw new Error('profile-validator fixture: rejected candidate changed owner state')
      }
      process.stdout.write(`${JSON.stringify({ rejected: true, message })}\n`)
    }
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === PROFILE_VALIDATOR_ARG) {
    const profile = process.argv[3]
    const generationPath = process.argv[4]
    const installAnchor = process.argv[5]
    if (profile === undefined || generationPath === undefined || installAnchor === undefined) {
      throw new Error('profile-validator fixture: expected child arguments')
    }
    await runProfileValidatorChild(profile, generationPath, installAnchor)
    return
  }
  const mode = process.argv[2]
  const profilesDir = process.argv[3]
  const installAnchor = process.argv[4]
  if (mode === undefined || profilesDir === undefined || installAnchor === undefined) {
    throw new Error('profile-validator fixture: expected mode, profiles directory, and install anchor')
  }
  await stageThroughOwner(mode, profilesDir, installAnchor)
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}
