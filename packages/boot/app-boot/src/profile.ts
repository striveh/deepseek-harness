/**
 * Profile discovery, initialization, and patch-layer composition for the
 * `dsh --profile` launcher family.
 *
 * A profile is a directory under `$DSH_HOME/profiles/<name>` holding a
 * `package.json` (out-of-tree plugin dependencies plus the profile manifest
 * `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml`
 * (the user's own patch layer, applied after every bundle layer). Bundles are
 * npm packages whose manifest declares
 * `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; the tree is
 * composed by applying each bundle's patch list in `dsh.profile.bundles` order over
 * an empty entry list, then the profile's own patches, then any launcher
 * layers (`--patch` files and flag-derived patches).
 *
 * Module resolution is two-anchor by construction: a bundle name resolves
 * first from the dsh installation (the launcher's own package), then from the
 * profile directory. The Loader's `baseUrl` is the profile directory, whose
 * `node_modules` pnpm manages for out-of-tree plugins, while the maintained
 * flat fallback directory `$DSH_HOME/profiles/node_modules` (one symlink per
 * package the installation's app and bundles depend on) makes every in-box
 * plugin Node-resolvable from any profile through the ordinary parent-walk.
 * @module @deepseek-ai/dsh-app-boot/profile
 */

import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  currentProcessIncarnation,
  readProcessIncarnation,
  type ProcessIncarnation,
} from '@deepseek-ai/dsh-native-command'
import { loadOverlayPatches } from './index.ts'

/** Directory under the Harness home holding every profile. */
export const PROFILES_DIR = 'profiles'

/** Reserved Profile sibling holding generation transactions and initialization coordination. */
export const PROFILE_TRANSACTION_ROOT = '.dsh-profile-transactions'

/** Basename of the launcher-owned empty Loader root, including private runtime roots. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/** The user patch layer inside a profile directory (hot-reloaded on long-lived surfaces). */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** The bundle half of the `dsh` manifest section: what a bundle package exports. */
export interface DshBundleManifest {
  /** The patch layer this bundle exports, relative to its package root. */
  patch: string
}

/** The profile half of the `dsh` manifest section: what a profile directory composes. */
export interface DshProfileManifest {
  /** Ordered bundle layer list (package names). */
  bundles?: string[]
}

/**
 * The profile-launcher slice of the `dsh`-owned package.json section. A
 * manifest may declare both roles; other consumers own additional keys.
 */
export interface DshManifestSection {
  /** Bundle metadata consumed by the profile launcher. */
  bundle?: DshBundleManifest
  /** Profile metadata consumed by the profile launcher. */
  profile?: DshProfileManifest
}

/** The slice of package.json both profiles and bundles use. */
export interface ProfileManifest {
  name?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: DshManifestSection
}

/** One resolved bundle layer of a profile. */
export interface ProfileLayer {
  /** The bundle's package name, as listed in `dsh.profile.bundles`. */
  packageName: string
  /** Absolute directory of the resolved bundle package. */
  packageDir: string
  /** Absolute path of the bundle's patch file. */
  patchPath: string
  /** The parsed patch list. */
  patches: PatchOptions[]
}

/** A loaded profile: resolved bundle layers plus the user's own patch layer. */
export interface Profile {
  /** The profile name (its directory basename). */
  name: string
  /** Absolute profile directory. */
  dir: string
  /** Bundle layers in `dsh.profile.bundles` order. */
  layers: ProfileLayer[]
  /** Absolute path of the profile's own patch file. */
  patchPath: string
  /** The profile's own patches; empty when the file is absent. */
  patches: PatchOptions[]
}

/** Alternate Profile location and mutation policy used by generation-aware consumers. */
export interface LoadProfileOptions {
  /** Skip reading the Profile patch layer for a bundles-only diagnostic. */
  userLayer?: boolean
  /** Read this complete Profile tree instead of the live named directory. */
  profileDir?: string
  /** Reject initialization and normalization writes to an immutable generation. */
  readOnly?: boolean
}

/**
 * Resolve a profile's directory under the Harness home.
 * @param name - the profile name (`dsh --profile <name>`).
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 * @returns the absolute profile directory (which may not exist yet).
 */
export function resolveProfileDir(name: string, home: string = resolveDshHome()): string {
  if (name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..'
    // The launcher-maintained flat module fallback lives at this sibling path.
    || name === 'node_modules' || name === PROFILE_TRANSACTION_ROOT) {
    throw new Error(`dsh: invalid profile name ${JSON.stringify(name)}`)
  }
  return join(home, PROFILES_DIR, name)
}

/** The shipped profile templates auto-initialized on first use, by name. */
export const PROFILE_TEMPLATES: Record<string, readonly string[]> = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
}

/** Installation-owned bundle tuples normalized to the shipped template. */
const INSTALLATION_OWNED_PROFILE_TUPLES: Record<string, readonly string[]> = {
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'],
}

/** The bundle list a `dsh plugin` init uses for a name with no shipped template. */
export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base']

const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

// The hoisted linker gives out-of-tree plugins a flat node_modules whose
// missing peers (cordis and friends) fall through to the healed
// profiles/node_modules installation fallback, so every plugin shares the
// installation's single cordis instance instead of a duplicate. pnpm ≥10
// reads its settings from pnpm-workspace.yaml, not .npmrc.
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

const PROFILE_PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: false
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies: {}

packages: {}

snapshots: {}
`

const PROFILE_INITIALIZATION_COORDINATOR = 'initialization.sqlite'

interface ProfileAtomicTemporaryOwner {
  readonly pid: number
  readonly incarnationFingerprint: string
}

interface ProfileTemplateFile {
  readonly name: string
  readonly content: string
}

/** Policy supplied by one Profile owner when durably creating directory components. */
export interface DurableProfileDirectoryOptions {
  /** Permission bits for newly created components; omission preserves the platform default. */
  readonly mode?: number
  /** Build the owner-specific failure for an `EEXIST` component that is not a directory. */
  readonly notDirectory: (directory: string) => Error
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY)
    fsyncSync(descriptor)
  } catch (error) {
    /* v8 ignore next 3 -- Windows rejects directory handles on filesystems that cannot flush them. */
    if (process.platform === 'win32'
      && ['EACCES', 'EINVAL', 'ENOTSUP', 'EPERM'].some(code => isErrno(error, code))) return
    /* v8 ignore next -- public callers cannot inject a directory flush fault. */
    throw error
  } finally {
    /* v8 ignore next -- false only when opening the directory failed before acquiring a handle. */
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/**
 * Create a Profile-owned directory tree and prove every component entry durable, including an `EEXIST` race winner.
 * @param path - complete directory path to create or confirm.
 * @param options - creation mode and owner-specific invalid-component diagnostic.
 */
export function ensureDurableProfileDirectory(path: string, options: DurableProfileDirectoryOptions): void {
  const pending: string[] = []
  for (let current = resolve(path); dirname(current) !== current; current = dirname(current)) pending.push(current)
  for (const directory of pending.reverse()) {
    try {
      if (options.mode === undefined) mkdirSync(directory)
      else mkdirSync(directory, { mode: options.mode })
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
      if (!statSync(directory).isDirectory()) throw options.notDirectory(directory)
    }
    syncDirectory(dirname(directory))
  }
}

const APP_PROFILE_DIRECTORY_OPTIONS: DurableProfileDirectoryOptions = {
  notDirectory: directory => new Error(`dsh: durable directory component ${directory} is not a directory`),
}

function mkdirDurable(path: string): void {
  ensureDurableProfileDirectory(path, APP_PROFILE_DIRECTORY_OPTIONS)
}

/** Publish complete bytes from a durable same-directory temporary file without replacing a pathname. */
function writeProfileFileAtomic(path: string, content: string): boolean {
  const incarnationFingerprint = processIncarnationFingerprint(currentProcessIncarnation())
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${String(process.pid)}.${incarnationFingerprint}.${randomUUID()}.tmp`,
  )
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    try {
      linkSync(temporary, path)
    } catch (error) {
      /* v8 ignore next -- only a concurrent initializer can enter this publication race. */
      if (!isErrno(error, 'EEXIST')) throw error
      /* v8 ignore next -- the same race returns after preserving the winner's file. */
      return false
    }
    unlinkSync(temporary)
    syncDirectory(dirname(path))
    return true
  } finally {
    /* v8 ignore next -- only a synchronous write/fsync fault leaves the temporary descriptor open. */
    if (descriptor !== undefined) closeSync(descriptor)
    try {
      unlinkSync(temporary)
    } catch (error) {
      /* v8 ignore next -- cleanup may ignore only a temporary already published or removed. */
      if (!isErrno(error, 'ENOENT')) throw error
    }
  }
}

function profileManifestTemplate(dir: string, bundles: readonly string[]): string {
  const manifest: ProfileManifest & { private: boolean } = {
    name: `dsh-profile-${basename(dir)}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...bundles] } },
  }
  return `${JSON.stringify(manifest, undefined, 2)}\n`
}

function profileTemplateFiles(dir: string, bundles: readonly string[]): readonly ProfileTemplateFile[] {
  return [
    { name: 'package.json', content: profileManifestTemplate(dir, bundles) },
    { name: PROFILE_PATCH_FILENAME, content: PROFILE_PATCH_TEMPLATE },
    { name: 'pnpm-workspace.yaml', content: PROFILE_PNPM_WORKSPACE },
    { name: 'pnpm-lock.yaml', content: PROFILE_PNPM_LOCK },
  ]
}

function isInterruptedTemplate(raw: string, expected: string): boolean {
  return raw.length < expected.length && expected.startsWith(raw)
}

function processIncarnationFingerprint(incarnation: ProcessIncarnation): string {
  return createHash('sha256').update(incarnation).digest('hex')
}

function profileAtomicTemporaryOwner(
  name: string,
  basenames: readonly string[],
): ProfileAtomicTemporaryOwner | undefined {
  for (const basename of basenames) {
    const prefix = `.${basename}.`
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
    const [owner, incarnationFingerprint, token, extra] = name.slice(prefix.length, -4).split('.')
    if (extra !== undefined || owner === undefined || incarnationFingerprint === undefined || token === undefined
      || !/^[1-9]\d*$/.test(owner)
      || !/^[0-9a-f]{64}$/.test(incarnationFingerprint)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)) {
      return undefined
    }
    const parsed = Number(owner)
    return Number.isSafeInteger(parsed) ? { pid: parsed, incarnationFingerprint } : undefined
  }
  return undefined
}

function canResumeInitialization(
  dir: string,
  files: readonly ProfileTemplateFile[],
): boolean {
  const owned = new Map(files.map(file => [file.name, file.content]))
  for (const name of readdirSync(dir)) {
    const expected = owned.get(name)
    if (expected === undefined) return false
    const raw = readFileSync(join(dir, name), 'utf8')
    if (raw === expected) continue
    return false
  }
  return files.some(file => !existsSync(join(dir, file.name)))
}

/** Remove recognized dead-owner residue while boundedly waiting for exact live owners. */
function settleProfileTemporaries(
  dir: string,
  files: readonly ProfileTemplateFile[],
  deadline: number,
): void {
  const basenames = files.map(file => file.name)
  for (;;) {
    let removed = false
    let liveOwner: number | undefined
    for (const name of readdirSync(dir)) {
      const owner = profileAtomicTemporaryOwner(name, basenames)
      if (owner === undefined) continue
      const liveIncarnation = readProcessIncarnation(owner.pid)
      if (liveIncarnation !== null
        && processIncarnationFingerprint(liveIncarnation) === owner.incarnationFingerprint) {
        liveOwner ??= owner.pid
        continue
      }
      try {
        unlinkSync(join(dir, name))
        removed = true
      } catch (error) {
        /* v8 ignore next -- an external cleanup may remove the same dead-owner temporary first. */
        if (!isErrno(error, 'ENOENT')) throw error
      }
    }
    if (removed) syncDirectory(dir)
    if (liveOwner === undefined) return
    if (Date.now() >= deadline) {
      throw new Error(`dsh: Profile initialization for ${dir} is still owned by process ${String(liveOwner)}`)
    }
    Atomics.wait(PROFILE_INITIALIZATION_WAIT, 0, 0, 10)
  }
}

/** Serialize initialization and recovery through an OS-released SQLite writer lease. */
function withProfileInitializationCoordinator<T>(dir: string, operation: () => T): T {
  const coordinatorDir = join(dirname(dir), PROFILE_TRANSACTION_ROOT, basename(dir))
  mkdirDurable(coordinatorDir)
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
  const database = new DatabaseSync(join(coordinatorDir, PROFILE_INITIALIZATION_COORDINATOR))
  let transactionOpen = false
  let hasPrimaryFailure = false
  let primaryFailure: unknown
  try {
    database.exec(`PRAGMA busy_timeout = ${String(PROFILE_INITIALIZATION_WAIT_MS)}`)
    database.exec('PRAGMA journal_mode = DELETE')
    database.exec('PRAGMA synchronous = FULL')
    database.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    const result = operation()
    database.exec('COMMIT')
    transactionOpen = false
    return result
  } catch (error) {
    hasPrimaryFailure = true
    primaryFailure = error
    throw error
  } finally {
    const cleanupFailures: unknown[] = []
    if (transactionOpen) {
      try {
        database.exec('ROLLBACK')
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    try {
      database.close()
    } catch (error) {
      cleanupFailures.push(error)
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        hasPrimaryFailure ? [primaryFailure, ...cleanupFailures] : cleanupFailures,
        'dsh: Profile initialization failed to release its coordinator',
        { cause: primaryFailure },
      )
    }
  }
}

const PROFILE_INITIALIZATION_WAIT = new Int32Array(new SharedArrayBuffer(4))
const PROFILE_INITIALIZATION_WAIT_MS = 10_000

function requiresProfileInitialization(
  dir: string,
  files: readonly ProfileTemplateFile[],
): boolean {
  const deadline = Date.now() + PROFILE_INITIALIZATION_WAIT_MS
  settleProfileTemporaries(dir, files, deadline)
  const requiresRecovery = files.some((file) => {
    const path = join(dir, file.name)
    return !existsSync(path) || isInterruptedTemplate(readFileSync(path, 'utf8'), file.content)
  })
  if (!requiresRecovery) return false
  if (!canResumeInitialization(dir, files)) {
    throw new Error(
      `dsh: Profile ${dir} is missing initialization files but contains user-owned content; repair it manually`,
    )
  }
  return true
}

/**
 * Initialize a profile directory: manifest, empty user patch layer, and the
 * pnpm settings out-of-tree plugins need. Each template file becomes visible
 * only with complete, flushed bytes. An OS-released writer lease permits retry
 * to publish only missing companions from an exact template subset; incomplete
 * or unrelated existing bytes are never overwritten and require manual inspection.
 * @param dir - the profile directory from {@link resolveProfileDir}.
 * @param bundles - the initial `dsh.profile.bundles` layer list.
 */
export function initProfile(dir: string, bundles: readonly string[]): void {
  mkdirDurable(dir)
  withProfileInitializationCoordinator(dir, () => {
    const files = profileTemplateFiles(dir, bundles)
    if (!requiresProfileInitialization(dir, files)) return
    for (const file of files) {
      const path = join(dir, file.name)
      if (!existsSync(path)) {
        /* v8 ignore next -- only an external pathname publisher can win while the coordinator is held. */
        if (writeProfileFileAtomic(path, file.content)) continue
      }
      const raw = readFileSync(path, 'utf8')
      if (raw === file.content) continue
      throw new Error(`dsh: Profile initialization cannot replace incomplete, user-owned, or unrelated file ${path}`)
    }
  })
}

function ensureEmptyProfileLock(binName: string, dir: string, manifest: ProfileManifest): void {
  const path = join(dir, 'pnpm-lock.yaml')
  if (existsSync(path)) return
  if (Object.keys(manifest.dependencies ?? {}).length > 0) {
    throw new Error(`${binName}: profile ${dir} has dependencies but no pnpm-lock.yaml; repair it before boot`)
  }
  writeProfileFileAtomic(path, PROFILE_PNPM_LOCK)
}

/** Ensure `link` is a symlink to `target`, replacing a wrong or dangling link; a real directory throws. */
function ensureSymlink(link: string, target: string): void {
  let stat
  try {
    stat = lstatSync(link)
  } catch {
    // Missing link (first run) — created below. Any other lstat failure on a
    // path we just created the parent of would resurface on symlinkSync.
    stat = undefined
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) {
      throw new Error(`dsh: ${link} exists and is not a symlink; remove it so dsh can manage the installation fallback`)
    }
    if (readlinkSync(link) === target) return
    // unlink deletes the reparse point itself on Windows too; rmSync treats a
    // junction as a directory and throws EISDIR unless recursive.
    unlinkSync(link)
  }
  try {
    symlinkSync(target, link, 'junction')
  } catch (error) {
    // Concurrent launches heal the same fallback; losing the race to a
    // process writing the identical link is success, anything else is not.
    // The window between the lstat miss above and this write cannot be
    // staged deterministically from the public API.
    /* v8 ignore next 4 */
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
      || !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) {
      throw error
    }
  }
}

/**
 * Maintain the flat module fallback `$DSH_HOME/profiles/node_modules`: one
 * symlink per package in the dsh app's resolvable dependency CLOSURE (BFS
 * over `dependencies` from the app manifest), each resolved from its own
 * real location. Node's parent-directory walk from any profile finds this
 * directory after the profile's own `node_modules`, so every in-box plugin
 * resolves without pnpm ever managing it — the exact "bundles come from the
 * installation" contract. The closure (not just direct dependencies) is
 * required for out-of-tree plugins: their peer dependencies name Service
 * Definition packages (`dsh-compaction`, `dsh-invariants`, ...) that the app
 * reaches only through its Service Provider packages. Symlinked packages
 * resolve their own dependencies from their real directories (Node's default
 * symlink-following), so each package needs only its one flat link.
 * Idempotent: correct links are kept and moved installations are
 * re-pointed; a stale link to a vanished package stays until its name is
 * reused (dangling links are invisible to resolution).
 * @param installAnchor - absolute path of the dsh app's package.json.
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 */
export function healProfilesModuleFallback(installAnchor: string, home: string = resolveDshHome()): void {
  const profilesDir = join(home, PROFILES_DIR)
  const modulesDir = join(profilesDir, 'node_modules')
  mkdirSync(modulesDir, { recursive: true })
  const appManifest = JSON.parse(readFileSync(installAnchor, 'utf8')) as ProfileManifest
  const links = new Map<string, string>()
  /* v8 ignore next -- a real app manifest always declares its name */
  if (appManifest.name !== undefined) links.set(appManifest.name, dirname(installAnchor))
  // BFS over the resolvable dependency graph; the visited set is the link
  // map itself (first resolution wins, matching Node's own nearest-wins).
  const queue: { anchor: string; manifest: ProfileManifest }[] = [{ anchor: installAnchor, manifest: appManifest }]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    // Peer dependencies participate: Service Definition packages (dsh-subprocess,
    // dsh-compaction, ...) are peers of their implementations, never plain
    // dependencies, yet out-of-tree plugins import them directly.
    /* v8 ignore next -- a real app manifest always declares dependencies */
    for (const dep of [...Object.keys(next.manifest.dependencies ?? {}), ...Object.keys(next.manifest.peerDependencies ?? {})]) {
      if (links.has(dep)) continue
      const dir = packageDirFromAnchor(next.anchor, dep)
      // A declared-but-uninstalled dependency cannot be a loader-visible
      // plugin; skip it rather than fail the whole boot.
      if (dir === undefined) continue
      links.set(dep, dir)
      const manifestPath = join(dir, 'package.json')
      queue.push({ anchor: manifestPath, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest })
    }
  }
  for (const [packageName, target] of links) {
    const link = join(modulesDir, packageName)
    mkdirSync(dirname(link), { recursive: true })
    ensureSymlink(link, target)
  }
}

/**
 * Read a profile's manifest.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param dir - the profile directory.
 * @returns the parsed manifest.
 */
export function readProfileManifest(binName: string, dir: string): ProfileManifest {
  const path = join(dir, 'package.json')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`${binName}: failed to read profile manifest ${path}: ${String(error)}`)
  }
  // The field checks below validate the file data before trusting the parse type.
  const parsed = JSON.parse(raw) as ProfileManifest | null
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${binName}: profile manifest ${path} must hold a JSON object`)
  }
  return parsed
}

/**
 * Write a profile's manifest back (2-space JSON, trailing newline).
 * @param dir - the profile directory.
 * @param manifest - the manifest value to persist.
 */
export function writeProfileManifest(dir: string, manifest: ProfileManifest): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
}

/** Return whether two bundle lists have the same values in the same order. */
function sameBundles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Normalize an exact installation-owned bundle tuple to its shipped template
 * while preserving every other manifest field. Any other list is user-owned.
 */
function normalizeShippedProfile(name: string, dir: string, manifest: ProfileManifest): ProfileManifest {
  const installationOwned = Object.hasOwn(INSTALLATION_OWNED_PROFILE_TUPLES, name)
    ? INSTALLATION_OWNED_PROFILE_TUPLES[name]
    : undefined
  const current = Object.hasOwn(PROFILE_TEMPLATES, name) ? PROFILE_TEMPLATES[name] : undefined
  const bundles = manifest.dsh?.profile?.bundles
  if (installationOwned === undefined || current === undefined || bundles === undefined
    || !sameBundles(bundles, installationOwned)) return manifest
  const normalized: ProfileManifest = {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles: [...current] },
    },
  }
  writeProfileManifest(dir, normalized)
  return normalized
}

/**
 * Resolve a package's root directory from one anchor without depending on the
 * package exporting `./package.json` (`require.resolve` would need that):
 * probe the require resolution paths for a directory holding the named
 * manifest. This is Node's own node_modules lookup order, so the result
 * matches what the Loader would import from the same anchor, and
 * `existsSync` follows the symlinks pnpm's isolated layout uses.
 */
function packageDirFromAnchor(anchor: string, packageName: string): string | undefined {
  // resolve.paths returns null only for builtins, which no bundle name is.
  /* v8 ignore next */
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Resolve one bundle package's directory: installation anchor first, then the
 * profile directory. The installation-first order is the contract that
 * `@deepseek-ai/dsh-base` (and every other in-box bundle) always comes from
 * the same installation as the running dsh, never from a profile-local copy.
 * Resolution does not require the package to export `./package.json`.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param packageName - the bundle's package name from `dsh.profile.bundles`.
 * @param installAnchor - absolute path of a file inside the dsh app package (its package.json).
 * @param profileDir - the profile directory (second anchor).
 * @returns the bundle package's absolute directory.
 */
export function resolveBundleDir(
  binName: string, packageName: string, installAnchor: string, profileDir: string,
): string {
  for (const anchor of [installAnchor, join(profileDir, 'package.json')]) {
    const dir = packageDirFromAnchor(anchor, packageName)
    if (dir !== undefined) return dir
  }
  throw new Error(
    `${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)} from the dsh installation or ${profileDir}; `
    + `run 'dsh plugin --profile ${basename(profileDir)} install' if its dependency is not installed`,
  )
}

/**
 * Load a profile: resolve every `dsh.profile.bundles` entry to its patch
 * layer and parse the profile's own patch file. A listed bundle without a
 * `dsh.bundle` manifest fails loud — naming a bundle-less package as a layer
 * is a misconfiguration, not "no patches".
 * @param binName - the diagnostic prefix on thrown errors.
 * @param name - the profile name.
 * @param installAnchor - absolute path of the dsh app's package.json (first resolution anchor).
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 * @param options - `userLayer: false` skips reading `cordis.patch.yml`, so a
 * bundles-only consumer (`--dump-default-config`, a recovery diagnostic)
 * cannot fail on a broken user layer.
 * @returns the loaded profile (empty `patches` when the user layer is skipped).
 */
export function loadProfile(
  binName: string, name: string, installAnchor: string, home: string = resolveDshHome(),
  options: LoadProfileOptions = {},
): Profile {
  const dir = options.profileDir === undefined ? resolveProfileDir(name, home) : resolve(options.profileDir)
  if (options.profileDir === undefined && options.readOnly !== true) {
    const template = Object.hasOwn(PROFILE_TEMPLATES, name) ? PROFILE_TEMPLATES[name] : undefined
    if (template !== undefined) {
      initProfile(dir, template)
    } else if (!existsSync(join(dir, 'package.json'))) {
      throw new Error(
        `${binName}: profile ${JSON.stringify(name)} does not exist; P0 auto-initializes only "web" and "headless"; `
        + `run '${binName} plugin --profile ${name} install <artifact.tgz>' to create it transactionally, `
        + 'or create a complete custom Profile directory before boot',
      )
    }
  } else if (!existsSync(join(dir, 'package.json'))) {
    throw new Error(`${binName}: complete Profile generation ${dir} has no package.json`)
  }
  const parsedManifest = readProfileManifest(binName, dir)
  if (options.readOnly !== true) ensureEmptyProfileLock(binName, dir, parsedManifest)
  const manifest = options.readOnly === true
    ? parsedManifest
    : normalizeShippedProfile(name, dir, parsedManifest)
  // A hand-written profile manifest may omit the dsh section entirely.
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const layers = bundles.map((packageName): ProfileLayer => {
    const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir)
    const bundleManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as ProfileManifest
    const declared = bundleManifest.dsh?.bundle?.patch
    if (declared === undefined) {
      throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`)
    }
    const patchPath = join(packageDir, declared)
    return { packageName, packageDir, patchPath, patches: loadOverlayPatches(binName, patchPath) }
  })
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  const patches = options.userLayer !== false && existsSync(patchPath)
    ? loadOverlayPatches(binName, patchPath)
    : []
  return { name, dir, layers, patchPath, patches }
}

/**
 * Compose patch layers into the effective entry list over an empty root —
 * the same single `applyEntryPatches` call the boot include makes, so flag
 * derivation and config dumps see exactly what mounts.
 * @param layers - patch lists in application order.
 * @param warn - sink for skipped-patch diagnostics; defaults to silent (boot repeats them).
 * @returns the composed entry list.
 */
export function composeEntries(
  layers: readonly PatchOptions[][], warn: (message: string) => void = () => {},
): EntryOptions[] {
  return applyEntryPatches([], structuredClone(layers.flat()), (message: string, ...args: unknown[]) => {
    let index = 0
    warn(message.replace(/%C/g, () => JSON.stringify(args[index++])))
  })
}
