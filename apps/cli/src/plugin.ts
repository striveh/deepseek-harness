/**
 * Exact `dsh plugin` lifecycle Consumer. Every mutation stages a complete
 * Profile through `ctx.profileTransactions`; arbitrary pnpm writes are
 * rejected so no command can bypass the shared lock, journal, or validation.
 * @module @deepseek-ai/dsh/plugin
 */

import { constants, existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  healProfilesModuleFallback,
  initProfile,
  PROFILE_TEMPLATES,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'
import {
  ProfileRevisionConflictError,
  ProfileTreeConflictError,
  profileArtifactDigest,
  profileContentDigest,
  profileMutationId,
  MAX_PROFILE_PATCH_BYTES,
  type ExactProfileMutation,
  type ProfileMutationId,
} from '@deepseek-ai/dsh-profile-transactions'
import { openProfileTransactionConsumer } from './profile-transactions.ts'
import { INSTALL_ANCHOR } from './install-anchor.ts'

const NAME = 'dsh'

interface ArtifactCommand {
  readonly operation: 'install' | 'update'
  readonly artifact: string
  readonly packageName: string
  readonly version: string
  readonly digest: string
  readonly kind: 'package' | 'bundle'
  readonly mutationId: ProfileMutationId
}

interface ConfigureCommand {
  readonly operation: 'configure'
  readonly packageName: string
  readonly patchFile: string
  readonly expectedDigest: string
  readonly nextDigest: string
  readonly mutationId: ProfileMutationId
}

type PluginMutationCommand =
  | ArtifactCommand
  | ConfigureCommand
  | { readonly operation: 'uninstall'; readonly packageName: string; readonly mutationId: ProfileMutationId }

type PluginCommand =
  | PluginMutationCommand
  | { readonly operation: 'restore'; readonly mutationId: ProfileMutationId }
  | { readonly operation: 'restore-receipt'; readonly mutationId: ProfileMutationId }
  | { readonly operation: 'list' }

function parseFlags(args: readonly string[], allowed: readonly string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    /* v8 ignore next -- the loop condition guarantees this indexed element. */
    if (argument === undefined) throw new Error(`${NAME}: plugin argument index is outside the parsed command`)
    if (!argument.startsWith('--')) {
      positional.push(argument)
      continue
    }
    if (!allowed.includes(argument) || flags.has(argument)) {
      throw new Error(`${NAME}: unsupported or duplicate plugin option ${JSON.stringify(argument)}`)
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${NAME}: plugin option ${argument} needs one value`)
    }
    flags.set(argument, value)
    index += 1
  }
  return { positional, flags }
}

function requiredFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name)
  if (value === undefined || value === '') throw new Error(`${NAME}: plugin option ${name} is required`)
  return value
}

function requiredMutationId(flags: ReadonlyMap<string, string>): ProfileMutationId {
  return profileMutationId(requiredFlag(flags, '--mutation-id'))
}

function parsePluginCommand(args: readonly string[]): PluginCommand {
  const [operation, ...rest] = args
  if (operation === 'install' || operation === 'update') {
    const parsed = parseFlags(rest, ['--package', '--version', '--digest', '--kind', '--mutation-id'])
    const [artifact] = parsed.positional
    if (parsed.positional.length !== 1 || artifact === undefined) {
      throw new Error(`${NAME}: plugin ${operation} needs exactly one local .tgz artifact`)
    }
    const kind = parsed.flags.get('--kind') ?? 'bundle'
    if (kind !== 'package' && kind !== 'bundle') throw new Error(`${NAME}: --kind must be package or bundle`)
    return {
      operation,
      artifact: resolve(artifact),
      packageName: requiredFlag(parsed.flags, '--package'),
      version: requiredFlag(parsed.flags, '--version'),
      digest: requiredFlag(parsed.flags, '--digest'),
      kind,
      mutationId: requiredMutationId(parsed.flags),
    }
  }
  if (operation === 'uninstall') {
    const parsed = parseFlags(rest, ['--mutation-id'])
    const [packageName] = parsed.positional
    if (parsed.positional.length !== 1 || packageName === undefined || packageName === '') {
      throw new Error(`${NAME}: plugin uninstall needs one exact package name`)
    }
    return { operation, packageName, mutationId: requiredMutationId(parsed.flags) }
  }
  if (operation === 'configure') {
    const parsed = parseFlags(rest, ['--patch-file', '--expected-digest', '--next-digest', '--mutation-id'])
    const [packageName] = parsed.positional
    if (parsed.positional.length !== 1 || packageName === undefined) {
      throw new Error(`${NAME}: plugin configure needs one installed package name`)
    }
    return {
      operation,
      packageName,
      patchFile: resolve(requiredFlag(parsed.flags, '--patch-file')),
      expectedDigest: requiredFlag(parsed.flags, '--expected-digest'),
      nextDigest: requiredFlag(parsed.flags, '--next-digest'),
      mutationId: requiredMutationId(parsed.flags),
    }
  }
  if (operation === 'restore') {
    const parsed = parseFlags(rest, ['--mutation-id'])
    if (parsed.positional.length > 0) throw new Error(`${NAME}: plugin restore takes no positional arguments`)
    return { operation, mutationId: requiredMutationId(parsed.flags) }
  }
  if (operation === 'restore-receipt') {
    const parsed = parseFlags(rest, ['--mutation-id'])
    if (parsed.positional.length > 0) throw new Error(`${NAME}: plugin restore-receipt takes no positional arguments`)
    return { operation, mutationId: requiredMutationId(parsed.flags) }
  }
  if (operation === 'list') {
    if (rest.length > 0) throw new Error(`${NAME}: plugin list takes no additional arguments`)
    return { operation }
  }
  throw new Error(
    `${NAME}: plugin accepts only install, update, uninstall, configure, restore, restore-receipt, or list; arbitrary pnpm writes are disabled`,
  )
}

interface PatchFileHandle {
  stat(): Promise<{ isFile(): boolean; size: number }>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

type OpenPatchFile = (path: string, flags: number) => Promise<PatchFileHandle>

/** Read one regular patch file without buffering beyond the Profile protocol limit. */
export async function readRegularUtf8(path: string, openFile: OpenPatchFile = open): Promise<string> {
  const portableConstants: Partial<typeof constants> = constants
  /* v8 ignore next -- supported Node releases expose O_NOFOLLOW; the fallback is for portable typing. */
  const noFollow = portableConstants.O_NOFOLLOW ?? 0
  const handle = await openFile(path, constants.O_RDONLY | noFollow)
  let primary: { readonly error: unknown } | null = null
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`${NAME}: patch input ${path} must be a regular file`)
    if (info.size > MAX_PROFILE_PATCH_BYTES) {
      throw new Error(`${NAME}: patch input ${path} exceeds ${String(MAX_PROFILE_PATCH_BYTES)} bytes`)
    }
    const bytes = Buffer.allocUnsafe(MAX_PROFILE_PATCH_BYTES + 1)
    let position = 0
    while (position < bytes.length) {
      const result = await handle.read(bytes, position, bytes.length - position, position)
      if (result.bytesRead === 0) break
      position += result.bytesRead
    }
    if (position > MAX_PROFILE_PATCH_BYTES) {
      throw new Error(`${NAME}: patch input ${path} exceeds ${String(MAX_PROFILE_PATCH_BYTES)} bytes`)
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, position))
    } catch (cause) {
      throw new Error(`${NAME}: patch input ${path} must contain valid UTF-8`, { cause })
    }
  } catch (error) {
    primary = { error }
    throw error
  } finally {
    try {
      await handle.close()
    } catch (closeError) {
      if (primary !== null) {
        throw new AggregateError(
          [primary.error, closeError],
          `${errorMessage(primary.error)}; patch descriptor close also failed`,
          { cause: primary.error },
        )
      }
      throw closeError
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mutationOf(command: PluginMutationCommand, nextUtf8?: string): ExactProfileMutation {
  if (command.operation === 'uninstall') {
    return { operation: command.operation, packageName: command.packageName }
  }
  if (command.operation === 'configure') {
    /* v8 ignore next -- the command runner reads configure bytes before calling this helper. */
    if (nextUtf8 === undefined) throw new Error(`${NAME}: configure patch bytes were not read`)
    return {
      operation: 'configure',
      packageName: command.packageName,
      patch: {
        expectedDigest: profileContentDigest(command.expectedDigest),
        nextUtf8,
        nextDigest: profileContentDigest(command.nextDigest),
      },
    }
  }
  return {
    operation: command.operation,
    kind: command.kind,
    packageName: command.packageName,
    version: command.version,
    artifact: {
      path: command.artifact,
      digest: profileArtifactDigest(command.digest),
    },
  }
}

/** Initialize one shipped Profile template, or leave a custom Profile untouched. */
function initializeShippedProfile(profile: string): { readonly dir: string; readonly created: boolean } | undefined {
  const bundles = Object.hasOwn(PROFILE_TEMPLATES, profile) ? PROFILE_TEMPLATES[profile] : undefined
  if (bundles === undefined) return undefined
  const dir = resolveProfileDir(profile)
  const created = !existsSync(join(dir, 'package.json'))
  // initProfile preserves existing files and fills any absent companions. Run
  // it even when package.json exists so a process killed during first
  // initialization can resume from the files already published.
  initProfile(dir, bundles)
  return { dir, created }
}

function ensureInstallProfile(profile: string): void {
  const initialized = initializeShippedProfile(profile)
  /* v8 ignore next -- runPlugin admits only the shipped web template before calling this helper. */
  if (initialized === undefined) throw new Error(`${NAME}: P0 plugin mutations support the web Profile only`)
  if (initialized.created) process.stderr.write(`${NAME}: initialized profile ${profile} at ${initialized.dir}\n`)
}

/** Materialize shipped templates before inventory; a missing custom Profile remains caller-owned. */
function ensureListProfile(profile: string): void {
  if (initializeShippedProfile(profile) !== undefined) return
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    throw new Error(
      `profile ${JSON.stringify(profile)} does not exist; list initializes only shipped web and headless Profiles; `
      + 'create a complete custom Profile directory before listing',
    )
  }
}

/**
 * Run one exact `dsh plugin` operation through the Profile transaction owner.
 * @param profile - named Profile.
 * @param args - strict lifecycle command arguments.
 * @returns zero on success and two on rejected input or mutation.
 */
export async function runPlugin(profile: string, args: readonly string[]): Promise<number> {
  try {
    const command = parsePluginCommand(args)
    if (command.operation !== 'list' && command.operation !== 'restore-receipt' && profile !== 'web') {
      throw new Error(`${NAME}: P0 plugin mutations support the web Profile only`)
    }
    if (command.operation === 'install') ensureInstallProfile(profile)
    if (command.operation === 'list') ensureListProfile(profile)
    const configureUtf8 = command.operation === 'configure' ? await readRegularUtf8(command.patchFile) : undefined
    const consumer = await openProfileTransactionConsumer(profile)
    let primary: { readonly error: unknown } | null = null
    try {
      if (command.operation === 'list') {
        process.stdout.write(`${JSON.stringify(await consumer.transactions.list(consumer.profile), null, 2)}\n`)
        return 0
      }
      if (command.operation === 'restore-receipt') {
        const receipt = await consumer.transactions.getRestoreReceipt({
          profile: consumer.profile,
          mutationId: command.mutationId,
        })
        process.stdout.write(`${JSON.stringify({
          profile: consumer.profile,
          mutationId: command.mutationId,
          status: receipt === null ? 'not-found' : 'committed',
          receipt,
        }, null, 2)}\n`)
        return 0
      }
      const snapshot = await consumer.transactions.snapshot(consumer.profile)
      if (command.operation === 'restore') {
        const receipt = await consumer.transactions.restoreLastGood({
          profile: consumer.profile,
          mutationId: command.mutationId,
          expectedRevision: snapshot.revision,
          expectedTreeDigest: snapshot.treeDigest,
        })
        process.stdout.write(`${NAME}: restored generation ${String(receipt.after.activeGeneration)}; restart required\n`)
        return 0
      }
      const mutation = mutationOf(command, configureUtf8)
      if (command.operation === 'install') {
        // A first plugin mutation reaches validation before ordinary profile
        // boot. Establish the same installation-owned module fallback that
        // app boot maintains so the standard base/web rows resolve unchanged.
        healProfilesModuleFallback(INSTALL_ANCHOR)
      }
      const staged = await consumer.transactions.stage({
        profile: consumer.profile,
        mutationId: command.mutationId,
        expectedRevision: snapshot.revision,
        expectedTreeDigest: snapshot.treeDigest,
        mutation,
      })
      const receipt = await (async () => {
        try {
          return await consumer.transactions.commit({
            profile: consumer.profile,
            expectedRevision: snapshot.revision,
            expectedTreeDigest: snapshot.treeDigest,
            generation: staged.generation,
          })
        } catch (error) {
          if (!(error instanceof ProfileRevisionConflictError) && !(error instanceof ProfileTreeConflictError)) {
            throw error
          }
          try {
            await consumer.transactions.abort({ profile: consumer.profile, generation: staged.generation })
          } catch (abortError) {
            throw new AggregateError(
              [error, abortError],
              `${errorMessage(error)}; staged Profile generation abort also failed`,
              { cause: error },
            )
          }
          throw error
        }
      })()
      process.stdout.write(
        `${NAME}: committed generation ${String(receipt.after.activeGeneration)} at revision ${String(receipt.after.revision)}; restart required\n`,
      )
      return 0
    } catch (error) {
      primary = { error }
      throw error
    } finally {
      try {
        await consumer.close()
      } catch (closeError) {
        if (primary !== null) {
          throw new AggregateError(
            [primary.error, closeError],
            `${errorMessage(primary.error)}; Profile transaction owner close also failed`,
            { cause: primary.error },
          )
        }
        throw closeError
      }
    }
  } catch (error) {
    process.stderr.write(`${NAME}: ${errorMessage(error)}\n`)
    return 2
  }
}
