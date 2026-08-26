/**
 * Shared profile boot for every `dsh` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
 * tree over an invocation-private empty root config, keep the profile patch layer
 * live, and wire fail-loud plus bounded shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  initProfile,
  installFailLoud,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  PROFILE_ROOT_FILENAME,
  PROFILE_TEMPLATES,
  resolveProfileDir,
  watchUserPatches,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  currentProcessIncarnation,
  readProcessIncarnation,
  type ProcessIncarnation,
} from '@deepseek-ai/dsh-native-command'
import type { ProfileSnapshot } from '@deepseek-ai/dsh-profile-transactions'
import { copyProfileTree, digestProfileTree } from '@deepseek-ai/dsh-profile-transactions-local'

/** Shipped agent-preset root: beside this app's own config, in both source and built layouts. */
const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))

import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'
import {
  acknowledgeProfileBoot,
  openProfileTransactionConsumer,
  type ProfileTransactionConsumer,
} from './profile-transactions.ts'
import { INSTALL_ANCHOR } from './install-anchor.ts'

const NAME = 'dsh'
const PROFILE_PREPARATION_STABILITY_ATTEMPTS = 8
const PROFILE_RUNTIME_ROOT_PREFIX = '.dsh-runtime-'

/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$DSH_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/** Effective Profile plus the pre-Loader transaction Consumer that resolved it. */
export interface TransactionalPreparedProfile {
  readonly profile: Profile
  readonly snapshot: ProfileSnapshot
  readonly transactionConsumer: ProfileTransactionConsumer
  /** Runtime-owned empty include root; never part of a managed generation digest. */
  readonly rootConfig: string
  /** Live Profile directory or invocation-private managed copy used by Loader. */
  readonly rootBaseUrl: string
  /** Remove this invocation's private runtime root; safe to call repeatedly. */
  readonly releaseRootConfig: () => void
}

interface ProfileRuntimeRootOwner {
  readonly pid: number
  readonly incarnationFingerprint: string
}

/** Derive the pathname-safe exact process-lifetime token used by private runtime roots. */
function processIncarnationFingerprint(incarnation: ProcessIncarnation): string {
  return createHash('sha256').update(incarnation).digest('hex')
}

/** Parse only the complete private-root names this launcher owns. */
function profileRuntimeRootOwner(name: string): ProfileRuntimeRootOwner | undefined {
  if (!name.startsWith(PROFILE_RUNTIME_ROOT_PREFIX)) return undefined
  const [owner, incarnationFingerprint, token, extra] = name.slice(PROFILE_RUNTIME_ROOT_PREFIX.length).split('.')
  if (extra !== undefined || owner === undefined || incarnationFingerprint === undefined || token === undefined
    || !/^[1-9]\d*$/.test(owner)
    || !/^[0-9a-f]{64}$/.test(incarnationFingerprint)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)) {
    return undefined
  }
  const pid = Number(owner)
  return Number.isSafeInteger(pid) ? { pid, incarnationFingerprint } : undefined
}

/** Remove exact dead-owner private roots while preserving every live sibling invocation. */
function recoverProfileRuntimeRoots(profilesDir: string): void {
  const incarnations = new Map<number, ProcessIncarnation | null>()
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    const owner = profileRuntimeRootOwner(entry.name)
    if (owner === undefined) continue
    let incarnation = incarnations.get(owner.pid)
    if (!incarnations.has(owner.pid)) {
      incarnation = readProcessIncarnation(owner.pid)
      incarnations.set(owner.pid, incarnation ?? null)
    }
    if (incarnation !== undefined && incarnation !== null
      && processIncarnationFingerprint(incarnation) === owner.incarnationFingerprint) continue
    const root = join(profilesDir, entry.name)
    let info
    try {
      info = lstatSync(root)
    } catch (error) {
      // Another preparer may have removed the same proven-dead root.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`dsh: managed Profile runtime root ${root} is not a directory`)
    }
    rmSync(root, { recursive: true, force: true })
  }
}

/** Allocate one launcher-owned root that no Profile writer or sibling invocation shares. */
function createRuntimeRootConfig(profilesDir: string): {
  readonly path: string
  readonly executionProfile: string
  readonly release: () => void
} {
  // A sibling under profiles keeps Node's parent-walk connected to the
  // installation fallback at profiles/node_modules.
  const runtimeDir = join(
    profilesDir,
    `${PROFILE_RUNTIME_ROOT_PREFIX}${String(process.pid)}.`
      + `${processIncarnationFingerprint(currentProcessIncarnation())}.${randomUUID()}`,
  )
  mkdirSync(runtimeDir, { mode: 0o700 })
  const path = join(runtimeDir, PROFILE_ROOT_FILENAME)
  try {
    writeFileSync(path, PROFILE_ROOT_CONFIG, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    rmSync(runtimeDir, { recursive: true, force: true })
    throw error
  }
  return {
    path,
    executionProfile: join(runtimeDir, 'profile'),
    release: () => { rmSync(runtimeDir, { recursive: true, force: true }) },
  }
}

type CleanupOperation = () => void | Promise<void>

/** Preserve one primary failure while attempting every bounded cleanup in order. */
async function rethrowAfterCleanup(
  primary: unknown,
  message: string,
  operations: readonly CleanupOperation[],
): Promise<never> {
  const cleanupFailures: unknown[] = []
  for (const operation of operations) {
    try {
      await operation()
    } catch (error) {
      cleanupFailures.push(error)
    }
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError([primary, ...cleanupFailures], message, { cause: primary })
  }
  throw primary
}

/**
 * Resolve the active generation before the app Loader exists. An unmanaged
 * live Profile retains the launcher's existing initialize/normalize behavior.
 * Every invocation receives a private root file; a managed generation also
 * receives a digest-verified private copy that becomes Loader's only base.
 * @param name - Profile name.
 * @param userLayer - whether to parse the Profile patch.
 * @returns effective Profile, held snapshot, and bootstrap Consumer.
 */
export async function prepareTransactionalProfile(
  name: string,
  userLayer = true,
): Promise<TransactionalPreparedProfile> {
  const profileDir = resolveProfileDir(name)
  healProfilesModuleFallback(INSTALL_ANCHOR)
  recoverProfileRuntimeRoots(dirname(profileDir))
  const shippedBundles = Object.hasOwn(PROFILE_TEMPLATES, name) ? PROFILE_TEMPLATES[name] : undefined
  if (shippedBundles !== undefined) initProfile(profileDir, shippedBundles)
  const transactionConsumer = await openProfileTransactionConsumer(name)
  try {
    let snapshot = await transactionConsumer.transactions.snapshot(transactionConsumer.profile)
    for (let attempt = 0; attempt < PROFILE_PREPARATION_STABILITY_ATTEMPTS; attempt++) {
      const selected = snapshot
      if (selected.activeGeneration === null) {
        const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
        const confirmed = await transactionConsumer.transactions.snapshot(transactionConsumer.profile)
        if (selected.activeGeneration !== confirmed.activeGeneration
          || selected.effectivePath !== confirmed.effectivePath
          || selected.treeDigest !== confirmed.treeDigest) {
          snapshot = confirmed
          continue
        }
        const runtimeRoot = createRuntimeRootConfig(dirname(profileDir))
        return {
          profile,
          snapshot: confirmed,
          transactionConsumer,
          rootConfig: runtimeRoot.path,
          rootBaseUrl: profile.dir,
          releaseRootConfig: runtimeRoot.release,
        }
      }

      const runtimeRoot = createRuntimeRootConfig(dirname(profileDir))
      let profile: Profile
      let confirmed: ProfileSnapshot
      try {
        copyProfileTree(selected.effectivePath, runtimeRoot.executionProfile)
        const executionDigest = digestProfileTree(runtimeRoot.executionProfile)
        if (executionDigest !== selected.treeDigest) {
          throw new Error(
            `dsh: Profile ${JSON.stringify(name)} changed while its private execution tree was being prepared`,
          )
        }
        profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, {
          userLayer,
          profileDir: runtimeRoot.executionProfile,
          readOnly: true,
        })
        confirmed = await transactionConsumer.transactions.snapshot(transactionConsumer.profile)
      } catch (error) {
        return await rethrowAfterCleanup(
          error,
          'dsh: Profile execution-tree preparation failed and runtime cleanup also failed',
          [runtimeRoot.release],
        )
      }
      if (selected.activeGeneration === confirmed.activeGeneration
        && selected.effectivePath === confirmed.effectivePath
        && selected.treeDigest === confirmed.treeDigest) {
        return {
          profile,
          snapshot: confirmed,
          transactionConsumer,
          rootConfig: runtimeRoot.path,
          rootBaseUrl: profile.dir,
          releaseRootConfig: runtimeRoot.release,
        }
      }
      runtimeRoot.release()
      snapshot = confirmed
    }
    throw new Error(`dsh: Profile ${JSON.stringify(name)} changed repeatedly during preparation`)
  } catch (error) {
    return rethrowAfterCleanup(
      error,
      'dsh: Profile preparation failed and transaction cleanup also failed',
      [() => transactionConsumer.close()],
    )
  }
}

/** One profile's patch layers (application order) and the row index of its pre-flag composition. */
interface ComposedProfile {
  profile: Profile
  /** Bundle layers concatenated — the part below the user layers on a live reload. */
  bundlePatches: PatchOptions[]
  /** The home-level user layer (`$DSH_HOME/cordis.patch.yml`), applied after the profile's own. */
  homePatches: PatchOptions[]
  /** Layers above the user layers on a live reload: `--patch` overlays and the telemetry switch. */
  overlays: PatchOptions[]
  /**
   * id → row of the composed tree (bundles + user layers + overlays), for the
   * launcher's own row checks.
   */
  rows: ReadonlyMap<string, EntryOptions>
  /** Exact transaction snapshot whose effective directory was composed. */
  transactionSnapshot: ProfileSnapshot
  /** Bootstrap owner kept only through real Loader boot acknowledgement. */
  transactionConsumer: ProfileTransactionConsumer
  /** Invocation-private empty include root. */
  rootConfig: string
  /** Effective Profile directory used to resolve relative Loader entries. */
  rootBaseUrl: string
  /** Remove this invocation's private runtime root. */
  releaseRootConfig: () => void
}

/** The full patch stack of one composed profile, in application order. */
function allPatches(composed: ComposedProfile): PatchOptions[] {
  return [
    ...composed.bundlePatches,
    ...composed.profile.patches,
    ...composed.homePatches,
    ...composed.overlays,
  ]
}

/**
 * Resolve the per-Profile patch input for HMR recomposition. Live Profiles are
 * re-read; an immutable generation reuses only the bytes parsed at boot.
 * @param profile - effective Profile loaded before app boot.
 * @param snapshot - exact transaction snapshot selecting that Profile.
 * @returns patch entries allowed in the next HMR composition.
 */
export function profilePatchesForReload(profile: Profile, snapshot: ProfileSnapshot): PatchOptions[] {
  if (!profilePatchIsReloadable(snapshot)) return profile.patches
  return loadOptionalPatches(NAME, profile.patchPath) ?? []
}

/**
 * Decide whether direct Profile patch HMR is allowed for one boot snapshot.
 * @param snapshot - transaction snapshot selecting the effective Profile.
 * @returns `true` only for the unmanaged live directory.
 */
export function profilePatchIsReloadable(snapshot: ProfileSnapshot): boolean {
  return snapshot.activeGeneration === null
}

/**
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order (the base bundle gates the shell stacks by
 * platform on its own rows), the profile's user layer, the home-level user
 * layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply
 * to every profile, so it outranks the per-profile layer), `--patch` overlays,
 * then the telemetry switch.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @returns the profile, its patch layers, and the composed row index.
 */
async function composeProfile(
  name: string,
  patchFiles: readonly string[],
): Promise<ComposedProfile> {
  const prepared = await prepareTransactionalProfile(name)
  const profile = prepared.profile
  try {
    const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? []
    const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
    const bundlePatches = profile.layers.flatMap(layer => layer.patches)
    const rows = new Map<string, EntryOptions>()
    for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays])) {
      if (typeof row.id === 'string') rows.set(row.id, row)
    }
    const composedOverlays = [...overlays]
    // The SHIPPED root is the part of the roster only this app can resolve: it
    // sits beside this app's own config, in both the source and built layouts.
    // The writable root the roster appends is `dsh-agent-presets`' own, so a
    // launcher that never reaches this patch still finds a person's presets.
    if (rows.has('agent-presets')) {
      composedOverlays.push({
        id: 'agent-presets',
        config: {
          ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
          roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }],
        },
      })
    }
    const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
    if (telemetryPatch !== undefined) composedOverlays.push(telemetryPatch)
    return {
      profile,
      bundlePatches,
      homePatches,
      overlays: composedOverlays,
      rows,
      transactionSnapshot: prepared.snapshot,
      transactionConsumer: prepared.transactionConsumer,
      rootConfig: prepared.rootConfig,
      rootBaseUrl: prepared.rootBaseUrl,
      releaseRootConfig: prepared.releaseRootConfig,
    }
  } catch (error) {
    return rethrowAfterCleanup(
      error,
      'dsh: Profile composition failed and runtime cleanup also failed',
      [prepared.releaseRootConfig, () => prepared.transactionConsumer.close()],
    )
  }
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
}

/**
 * Decide whether shutdown already owns a watcher-setup failure:
 * a signal aborted this invocation, or an app requested exit (`ctx.appExit`
 * from a fast one-shot) and the root's disposal rejected the in-flight setup
 * await. Either way the failure describes a tree that is exiting as asked,
 * not a broken watch.
 * @param ctx - the booted root context.
 * @param signal - this invocation's signal-shutdown fact.
 * @returns whether the setup failure was caused by requested tree shutdown.
 */
function watcherSetupFailureIsShutdownOwned(ctx: Context, signal: AbortSignal): boolean {
  return signal.aborted || ctx.fiber.state !== FiberState.ACTIVE || ctx.get('loader') === undefined
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  const composed = await composeProfile(options.profile, options.patchFiles)
  const app: { current?: Context } = {}
  const shutdown = createProcessShutdown(async () => { await app.current?.fiber.dispose() })
  const signalShutdown = new AbortController()
  const interrupt = (code: number): void => {
    signalShutdown.abort()
    shutdown.interrupt(code)
  }
  // Signals own teardown throughout the startup window, not only after boot()
  // settles: an inserted provider can publish before sibling rows finish mounting.
  // SIGTERM is a supervisor's ordinary stop request and exits 0 on every
  // surface — the launcher does not know whether the app considered its work
  // complete; SIGINT is a user interrupt and reports 130.
  process.on('SIGTERM', () => { interrupt(0) })
  process.on('SIGINT', () => { interrupt(130) })
  installFailLoud(NAME, process, async () => {
    await app.current?.fiber.dispose()
  })

  const rootConfig = composed.rootConfig
  // Recomposition for the live user layers: bundle layers below, overlays
  // above, so a user edit can never displace them. Parsed app arguments are
  // not in here at all — they live in app-provided services that survive a
  // recomposition. BOTH
  // user files are re-read per generation (the HMR watcher hands us only the
  // changed file's patches, which one of the reads duplicates — fresh reads
  // keep the two watchers from stitching in each other's stale copy).
  // Fresh clones per generation: the include pushes `insert` rows into the
  // mounted tree BY REFERENCE and later id-targeted patches mutate those
  // objects in place. Reusing one parsed patch object across applications
  // would bake a user override into the bundle's in-memory insert row, so
  // removing the override could never revert the row to the bundle default.
  const composeLive = (): PatchOptions[] => structuredClone([
    ...composed.bundlePatches,
    ...profilePatchesForReload(composed.profile, composed.transactionSnapshot),
    ...loadOptionalPatches(NAME, homePatchPath()) ?? [],
    ...composed.overlays,
  ])
  // Cloned for the same insert-aliasing reason as composeLive: the boot
  // application must not mutate the objects later reloads recompose from.
  let ctx: Context
  try {
    ctx = await boot(NAME, rootConfig, structuredClone(allPatches(composed)), (hostCtx) => {
      app.current = hostCtx
      hostCtx.effect(() => composed.releaseRootConfig, 'dsh.profileRuntimeRoot()')
      // Before any config-tree entry mounts, so plugins resolve all launch-time
      // environment values from the same immutable provenance snapshot.
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
      hostCtx.provide('dshInstallAnchor', INSTALL_ANCHOR)
      // The command line and bounded exit request are launcher facts available
      // to every app plugin that injects the argument snapshot.
      provideCmdline(hostCtx, {
        args: options.args,
        exit: code => void shutdown.shutdown(code),
      })
    }, undefined, composed.rootBaseUrl)
    app.current = ctx
    if (!signalShutdown.signal.aborted) {
      await acknowledgeProfileBoot(composed.transactionConsumer, composed.transactionSnapshot)
    }
  } catch (error) {
    return rethrowAfterCleanup(
      error,
      'dsh: Profile boot failed and runtime cleanup also failed',
      [() => app.current?.fiber.dispose(), composed.releaseRootConfig, () => composed.transactionConsumer.close()],
    )
  }
  try {
    await composed.transactionConsumer.close()
  } catch (error) {
    return rethrowAfterCleanup(
      error,
      'dsh: Profile transaction cleanup failed and app cleanup also failed',
      [() => app.current?.fiber.dispose(), composed.releaseRootConfig],
    )
  }
  // A surface can dispose the whole tree while boot or this post-boot watcher
  // setup is still in flight — a signal, or a fast one-shot's appExit. Loader
  // presence and fiber state own liveness; the initial check skips a tree
  // that already exited, and the catch below re-checks for an exit that
  // landed mid-setup. Watching is unconditional: a one-shot surface exits
  // through its bounded shutdown, which disposes the watchers before the
  // loop drains.
  if (!signalShutdown.signal.aborted
    && ctx.fiber.state === FiberState.ACTIVE
    && ctx.get('loader') !== undefined) {
    try {
      // Config-only HMR for the live profile patch layer: the web bundle
      // disables the shared module-reload `hmr` row (its reload lifecycle is
      // untested), so when the composition leaves no HMR service, mount a
      // watch-only instance with no module roots — cordis.patch.yml edits stay
      // live on every long-lived surface. A silent skip would break the
      // documented hot-reload contract. HMR injects the timer service, which a
      // bare custom profile may not mount either.
      if (ctx.get('hmr') === undefined) {
        if (ctx.get('timer') === undefined) {
          await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
        }
        await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
      }
      if (profilePatchIsReloadable(composed.transactionSnapshot)) {
        await watchUserPatches(ctx, {
          binName: NAME,
          filename: composed.profile.patchPath,
          compose: composeLive,
        })
      }
      await watchUserPatches(ctx, {
        binName: NAME,
        filename: homePatchPath(),
        compose: composeLive,
      })
    } catch (error) {
      if (!watcherSetupFailureIsShutdownOwned(ctx, signalShutdown.signal)) {
        return rethrowAfterCleanup(
          error,
          'dsh: Profile watcher setup failed and app cleanup also failed',
          [() => ctx.fiber.dispose(), composed.releaseRootConfig],
        )
      }
    }
  }
  return { ctx, shutdown }
}
