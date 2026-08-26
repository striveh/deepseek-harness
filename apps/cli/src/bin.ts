#!/usr/bin/env node
/**
 * dsh — command-line entry. Dynamic imports per mode keep unrelated modes out
 * of each dispatch path. Commander terminal results set `process.exitCode`
 * without forcing exit, so pending help, version, and error output drains.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { parseDshArgs } from './args.ts'

/** Keep Node 22's runtime classification from occupying product stderr. */
function installNode22SqliteWarningFilter(): void {
  const originalEmitWarning = Reflect.get(process, 'emitWarning')
  Reflect.set(process, 'emitWarning', (warning: string | Error, ...details: unknown[]): void => {
    const message = warning instanceof Error ? warning.message : warning
    const options = details[0]
    const type = warning instanceof Error
      ? warning.name
      : typeof options === 'string'
        ? options
        : typeof options === 'object' && options !== null && 'type' in options
          ? options.type
          : undefined
    if (message === 'SQLite is an experimental feature and might change at any time'
      && type === 'ExperimentalWarning') return
    Reflect.apply(originalEmitWarning, process, [warning, ...details])
  })
}

installNode22SqliteWarningFilter()

const isProfileValidator = process.argv[2] === '--dsh-internal-profile-validate'
if (isProfileValidator) {
  const profile = process.argv[3]
  const generationPath = process.argv[4]
  const installAnchor = process.argv[5]
  if (profile === undefined || generationPath === undefined || installAnchor === undefined || process.argv.length !== 6) {
    throw new Error('dsh-profile-validator: expected Profile name, generation path, and install anchor')
  }
  const { runProfileValidatorChild } = await import('@deepseek-ai/dsh-profile-transactions-local')
  try {
    await runProfileValidatorChild(profile, generationPath, installAnchor)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the checked-in manifest resolves with the
// same relative hop from either artifact.
/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

if (!isProfileValidator) {
  const result = parseDshArgs(process.argv.slice(2), readVersion())

  if (result.mode === 'terminal') {
    process.exitCode = result.exitCode
  } else {
    const invocation = result
    switch (invocation.mode) {
      case 'profile': {
        const { runProfile } = await import('./profile-boot.ts')
        await runProfile({
          environment: loadLayeredEnv('dsh'),
          profile: invocation.profile,
          patchFiles: invocation.patches,
          args: invocation.args,
        })
        break
      }
      case 'plugin': {
        const { runPlugin } = await import('./plugin.ts')
        process.exitCode = await runPlugin(invocation.profile, invocation.args)
        break
      }
      case 'dump-config': {
        const { runDumpConfig } = await import('./dump-config.ts')
        await runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
        break
      }
      default:
        invocation satisfies never
        throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
    }
  }
}
