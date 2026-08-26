/**
 * Config-dump entry for `dsh --profile <name> --dump-config`: compose the
 * profile's patch layers through the include plugin's patch algorithm without
 * booting or evaluating `!!js`, with one source layer per bundle, the
 * profile's own patch file, and each `--patch` overlay.
 * @module @deepseek-ai/dsh/dump-config
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  loadOptionalPatches,
  loadOverlayPatches,
  PROFILE_PATCH_FILENAME,
  renderConfigDump,
  type ConfigDumpLayer,
} from '@deepseek-ai/dsh-app-boot'
import { homePatchPath, prepareTransactionalProfile } from './profile-boot.ts'

const NAME = 'dsh'

/* v8 ignore start -- built-bin acceptance drives this boot-free dispatch */
/**
 * Print a profile composition with comments naming each source file and patch layer.
 * @param profile - the profile name.
 * @param defaultOnly - omit the profile's user layer and `--patch` overlays
 * (the recovery diagnostic for a broken `cordis.patch.yml`, which is then
 * never parsed).
 * @param patches - `--patch` overlay paths, in argv order.
 */
export async function runDumpConfig(profile: string, defaultOnly: boolean, patches: readonly string[]): Promise<void> {
  const prepared = await prepareTransactionalProfile(profile, !defaultOnly)
  const loaded = prepared.profile
  let primaryFailure: { readonly error: unknown } | undefined
  try {
    const layers: ConfigDumpLayer[] = loaded.layers.map(layer => ({
      label: layer.packageName,
      patches: layer.patches,
    }))
    if (!defaultOnly) {
      if (existsSync(loaded.patchPath)) {
        layers.push({
          label: join(prepared.snapshot.effectivePath, PROFILE_PATCH_FILENAME),
          patches: loaded.patches,
        })
      }
      const homePatchFile = homePatchPath()
      const homePatches = loadOptionalPatches(NAME, homePatchFile)
      if (homePatches !== undefined) {
        layers.push({ label: homePatchFile, patches: homePatches })
      }
      for (const file of patches) {
        const absolute = resolve(file)
        layers.push({ label: absolute, patches: loadOverlayPatches(NAME, absolute) })
      }
    }
    process.stdout.write(renderConfigDump(NAME, prepared.rootConfig, layers))
  } catch (error) {
    primaryFailure = { error }
  } finally {
    const cleanupFailures: unknown[] = []
    try {
      await prepared.transactionConsumer.close()
    } catch (error) {
      cleanupFailures.push(error)
    }
    try {
      prepared.releaseRootConfig()
    } catch (error) {
      cleanupFailures.push(error)
    }
    if (primaryFailure !== undefined) {
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [primaryFailure.error, ...cleanupFailures],
          'dsh: config dump failed and runtime cleanup also failed',
          { cause: primaryFailure.error },
        )
      }
      throw primaryFailure.error
    }
    if (cleanupFailures.length === 1) throw cleanupFailures[0]
    if (cleanupFailures.length > 1) {
      throw new AggregateError(cleanupFailures, 'dsh: multiple config dump cleanup operations failed')
    }
  }
}
/* v8 ignore stop */
