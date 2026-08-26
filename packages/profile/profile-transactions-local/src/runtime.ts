/**
 * Local complete-Profile transaction mechanism. The store owns artifact
 * admission, immutable generation construction, conflict fences, journals,
 * boot acknowledgement, and recovery generation selection.
 * @module @deepseek-ai/dsh-profile-transactions-local/src/runtime
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { extract, list, type ReadEntry } from 'tar'
import { parseAllDocuments, stringify } from 'yaml'
import { ensureDurableProfileDirectory, PROFILE_TRANSACTION_ROOT } from '@deepseek-ai/dsh-app-boot'
import {
  currentProcessIncarnation,
  isProcessIncarnation,
  readProcessIncarnation,
  type ProcessIncarnation,
} from '@deepseek-ai/dsh-native-command'
import { MAX_PROFILE_PATCH_BYTES } from '@deepseek-ai/dsh-profile-transactions'

const FORMAT_VERSION = 2
const TRANSACTION_ROOT = PROFILE_TRANSACTION_ROOT
const STATE_FILE = 'state.json'
const JOURNAL_FILE = 'journal.json'
const COORDINATOR_FILE = 'writer.sqlite'
const GENERATIONS_DIR = 'generations'
const STAGE_LEASES_DIR = 'stage-leases'
const GENERATION_RECORD = 'generation.json'
const GENERATION_PROFILE = 'profile'
const ARTIFACTS_DIR = '.dsh-artifacts'
const PROFILE_PATCH = 'cordis.patch.yml'
const PROFILE_WORKSPACE = 'pnpm-workspace.yaml'
const PROFILE_LOCK = 'pnpm-lock.yaml'
const GENERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PROFILE_MUTATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/
const SEMVER_PRERELEASE_IDENTIFIER = '(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)'
const EXACT_SEMVER = new RegExp([
  '^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)',
  `(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?`,
  '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
].join(''))
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/i
const MAX_ARCHIVE_ENTRIES = 10_000
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const MAX_ARCHIVE_COMPRESSED_BYTES = MAX_ARCHIVE_BYTES
const COORDINATOR_APPLICATION_ID = 0x44505432
const COORDINATOR_SCHEMA_VERSION = 4
const STAGE_RESERVATIONS_SCHEMA = `CREATE TABLE stage_reservations (
      mutation_id TEXT PRIMARY KEY NOT NULL,
      request_digest TEXT NOT NULL,
      generation TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('building','complete')),
      owner_pid INTEGER,
      owner_incarnation TEXT,
      owner_token TEXT,
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      CHECK ((status = 'building') = (
        owner_pid IS NOT NULL AND owner_incarnation IS NOT NULL AND owner_token IS NOT NULL
      ))
    ) STRICT`
const POINTER_OPERATIONS_SCHEMA = `CREATE TABLE pointer_operations (
      mutation_id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('commit','restore')),
      request_digest TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
    ) STRICT`
const COORDINATOR_SCHEMA_FINGERPRINT = JSON.stringify({
  objects: [
    { type: 'table', name: 'pointer_operations', tbl_name: 'pointer_operations', sql: POINTER_OPERATIONS_SCHEMA },
    { type: 'table', name: 'stage_reservations', tbl_name: 'stage_reservations', sql: STAGE_RESERVATIONS_SCHEMA },
  ],
  pointerColumns: [
    { cid: 0, name: 'mutation_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1, hidden: 0 },
    { cid: 1, name: 'kind', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
    { cid: 2, name: 'request_digest', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
    { cid: 3, name: 'receipt_json', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
    { cid: 4, name: 'updated_at_ms', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  ],
  stageColumns: [
    { cid: 0, name: 'mutation_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1, hidden: 0 },
    { cid: 1, name: 'request_digest', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
    { cid: 2, name: 'generation', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
    { cid: 3, name: 'status', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
    { cid: 4, name: 'owner_pid', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
    { cid: 5, name: 'owner_incarnation', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
    { cid: 6, name: 'owner_token', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
    { cid: 7, name: 'updated_at_ms', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  ],
  pointerIndexes: [
    { seq: 0, name: 'sqlite_autoindex_pointer_operations_1', unique: 1, origin: 'pk', partial: 0 },
  ],
  stageIndexes: [
    { seq: 0, name: 'sqlite_autoindex_stage_reservations_2', unique: 1, origin: 'u', partial: 0 },
    { seq: 1, name: 'sqlite_autoindex_stage_reservations_1', unique: 1, origin: 'pk', partial: 0 },
  ],
  pointerPrimaryKey: [
    { seqno: 0, cid: 0, name: 'mutation_id', desc: 0, coll: 'BINARY', key: 1 },
    { seqno: 1, cid: -1, name: null, desc: 0, coll: 'BINARY', key: 0 },
  ],
  stagePrimaryKey: [
    { seqno: 0, cid: 0, name: 'mutation_id', desc: 0, coll: 'BINARY', key: 1 },
    { seqno: 1, cid: -1, name: null, desc: 0, coll: 'BINARY', key: 0 },
  ],
  stageGenerationUnique: [
    { seqno: 0, cid: 2, name: 'generation', desc: 0, coll: 'BINARY', key: 1 },
    { seqno: 1, cid: -1, name: null, desc: 0, coll: 'BINARY', key: 0 },
  ],
})
const EXCLUDED_ROOT_ENTRIES = new Set([TRANSACTION_ROOT, '.dsh-runtime', 'cordis.yml'])
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const

/** Resolved runtime configuration. */
export interface LocalProfileTransactionStoreConfig {
  readonly profilesDir: string
  readonly installAnchor: string
  readonly lockWaitMs: number
}

/** Internal fault points used only by filesystem and process-death acceptance fixtures. */
export interface LocalProfileTransactionHooks {
  afterJournalPersisted?(): void
  afterStatePersisted?(): void
  afterStageReservationPersisted?(): void
  afterCandidateCopied?(generationPath: string): void
  afterArchivePreflight?(artifactPath: string): void | Promise<void>
  afterGenerationPersisted?(): void
}

/** Immutable local artifact accepted by the Profile transaction provider. */
export interface StoreArtifact {
  readonly path: string
  readonly digest: string
}

/** Install or update mutation applied while staging one Profile generation. */
export interface StoreArtifactMutation {
  readonly operation: 'install' | 'update'
  readonly kind: 'package' | 'bundle'
  readonly packageName: string
  readonly version: string
  readonly artifact: StoreArtifact
}

/** Uninstall mutation applied while staging one Profile generation. */
export interface StoreUninstallMutation {
  readonly operation: 'uninstall'
  readonly packageName: string
}

/** Raw configure mutation shared with the Service Provider bridge. */
export interface StoreConfigureMutation {
  readonly operation: 'configure'
  readonly packageName: string
  readonly patch: {
    readonly expectedDigest: string
    readonly nextUtf8: string
    readonly nextDigest: string
  }
}

/** Closed mutation set owned by the local Profile transaction provider. */
export type StoreMutation = StoreArtifactMutation | StoreUninstallMutation | StoreConfigureMutation

interface PointerState {
  readonly profile: string
  readonly revision: number
  readonly activeGeneration: string | null
  readonly lastGoodGeneration: string | null
  readonly rollbackGeneration: string | null
}

interface RecoveredPointerState {
  readonly state: PointerState
  readonly journalOperation: string | null
}

/** Raw structurally compatible Profile snapshot used inside the provider. */
export interface StoreSnapshot extends PointerState {
  readonly treeDigest: string
  readonly effectivePath: string
  readonly bootStatus: 'live' | 'pending-restart' | 'verified'
}

/** Raw structurally compatible stage request used inside the provider. */
export interface StoreStageRequest {
  readonly profile: string
  readonly mutationId: string
  readonly expectedRevision: number
  readonly expectedTreeDigest: string
  readonly mutation: StoreMutation
}

/** Raw structurally compatible staged generation used inside the provider. */
export interface StoreStagedGeneration {
  readonly profile: string
  readonly mutationId: string
  readonly generation: string
  readonly basedOnRevision: number
  readonly basedOnTreeDigest: string
  readonly treeDigest: string
  readonly mutation: StoreMutation
}

/** Candidate passed to the Service Provider validation bridge. */
export interface StoreGenerationCandidate {
  readonly profile: string
  readonly mutationId: string
  readonly generation: string
  readonly basedOn: StoreSnapshot
  readonly mutation: StoreMutation
  readonly generationPath: string
  readonly artifactPath: string | null
  readonly treeDigest: string
}

/** Raw generation summary returned by read-only listing. */
export interface StoreGenerationSummary {
  readonly generation: string
  readonly treeDigest: string
  readonly mutationId: string | null
  readonly mutation: StoreMutation | null
}

/** Raw generation inventory returned by read-only listing. */
export interface StoreGenerationInventory {
  readonly snapshot: StoreSnapshot
  readonly active: StoreGenerationSummary | null
  readonly staged: readonly StoreGenerationSummary[]
  readonly recoverable: readonly StoreGenerationSummary[]
}

/** Exact terminal restore receipt returned by the local provider. */
export interface StoreRestoreReceipt {
  readonly mutationId: string
  readonly status: 'committed'
  readonly operation: 'restore'
  readonly before: StoreSnapshot
  readonly after: StoreSnapshot
  readonly restartRequired: true
}

interface StoredArtifactMutation {
  readonly operation: 'install' | 'update'
  readonly kind: 'package' | 'bundle'
  readonly packageName: string
  readonly version: string
  readonly digest: string
  readonly integrity: string
  readonly artifactFile: string
  readonly bytes: number
}

interface StoredUninstallMutation {
  readonly operation: 'uninstall'
  readonly packageName: string
}

type StoredConfigureMutation = StoreConfigureMutation

type StoredMutation = StoredArtifactMutation | StoredUninstallMutation | StoredConfigureMutation

interface GenerationRecord {
  readonly formatVersion: typeof FORMAT_VERSION
  readonly profile: string
  readonly generation: string
  readonly mutationId: string | null
  readonly source: 'baseline' | 'mutation'
  readonly basedOnRevision: number
  readonly basedOnGeneration: string | null
  readonly basedOnTreeDigest: string
  readonly treeDigest: string
  readonly mutation: StoredMutation | null
}

interface StageReservationRow {
  readonly mutationId: string
  readonly requestDigest: string
  readonly generation: string
  readonly status: 'building' | 'complete'
  readonly ownerPid: number | null
  readonly ownerIncarnation: ProcessIncarnation | null
  readonly ownerToken: string | null
}

type StageReservationDecision =
  | { readonly kind: 'complete'; readonly record: GenerationRecord }
  | { readonly kind: 'committed'; readonly record: GenerationRecord }
  | { readonly kind: 'in-progress' }
  | {
    readonly kind: 'build'
    readonly generation: string
    readonly ownerToken: string
    readonly basedOn: StoreSnapshot
    readonly lease: StageLease
    readonly replacedGeneration: string | null
    readonly replacedOwnerToken: string | null
  }

type StageBuildReservation = Extract<StageReservationDecision, { readonly kind: 'build' }>

interface StageLease {
  readonly database: DatabaseSync
  readonly path: string
}

interface JournalRecord {
  readonly formatVersion: typeof FORMAT_VERSION
  readonly operation: string
  readonly kind: 'commit' | 'restore' | 'acknowledge-boot'
  readonly mutationId: string | null
  readonly requestDigest: string | null
  readonly profile: string
  readonly before: PointerState
  readonly after: PointerState
}

interface PointerOperationReceiptDocument {
  readonly before: PointerState
  readonly after: PointerState
}

interface StoredPointerOperation extends PointerOperationReceiptDocument {
  readonly kind: 'commit' | 'restore'
  readonly requestDigest: string
}

interface ProfileManifestDocument {
  readonly name?: unknown
  readonly version?: unknown
  readonly dependencies?: unknown
  readonly optionalDependencies?: unknown
  readonly bundledDependencies?: unknown
  readonly bundleDependencies?: unknown
  readonly scripts?: unknown
  readonly dsh?: unknown
  readonly [key: string]: unknown
}

/** Internal revision conflict translated by the Cordis Service Provider. */
export class LocalProfileRevisionConflictError extends Error {
  constructor(
    readonly profile: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`profile revision conflict: expected ${String(expected)}, found ${String(actual)}`)
    this.name = 'LocalProfileRevisionConflictError'
  }
}

/** Internal tree conflict translated by the Cordis Service Provider. */
export class LocalProfileTreeConflictError extends Error {
  constructor(
    readonly profile: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`profile tree conflict: expected ${expected}, found ${actual}`)
    this.name = 'LocalProfileTreeConflictError'
  }
}

/** Internal Profile patch conflict translated by the Cordis Service Provider. */
export class LocalProfileContentConflictError extends Error {
  constructor(
    readonly profile: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`profile patch conflict: expected ${expected}, found ${actual}`)
    this.name = 'LocalProfileContentConflictError'
  }
}

/** Internal mutation-id replay conflict translated by the Cordis Service Provider. */
export class LocalProfileMutationConflictError extends Error {
  constructor(
    readonly profile: string,
    readonly mutationId: string,
  ) {
    super(`profile mutation conflict: ${mutationId} is already bound to different input`)
    this.name = 'LocalProfileMutationConflictError'
  }
}

type DatabaseSyncConstructor = typeof import('node:sqlite')['DatabaseSync']
type DatabaseSync = import('node:sqlite').DatabaseSync
let databaseConstructor: Promise<DatabaseSyncConstructor> | undefined

async function loadDatabaseConstructor(): Promise<DatabaseSyncConstructor> {
  databaseConstructor ??= import('node:sqlite').then(module => module.DatabaseSync)
  return databaseConstructor
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code
}

function isSqliteBusy(error: unknown): boolean {
  const sqliteError = error as { readonly code?: unknown; readonly errcode?: unknown } | null
  return sqliteError?.code === 'ERR_SQLITE_ERROR' && sqliteError.errcode === 5
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function assertProfileName(profile: string): void {
  if (profile === '' || profile.includes('/') || profile.includes('\\') || profile === '.' || profile === '..'
    || profile === 'node_modules' || profile === TRANSACTION_ROOT) {
    throw new TypeError(`profile name ${JSON.stringify(profile)} must be one non-reserved path segment`)
  }
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError('profile revision must be a non-negative safe integer')
  }
}

function assertDigest(digest: string, label: string): void {
  if (!SHA256_DIGEST.test(digest)) throw new TypeError(`${label} must match sha256:<64 lowercase hex>`)
}

function assertGenerationId(generation: string): void {
  if (!GENERATION_ID.test(generation)) throw new TypeError(`invalid Profile generation id ${JSON.stringify(generation)}`)
}

function assertProfileMutationId(mutationId: string): void {
  if (!PROFILE_MUTATION_ID.test(mutationId)) {
    throw new TypeError('profile mutation id must be 1-128 safe identifier characters')
  }
}

function assertPackageName(packageName: string): void {
  if (!PACKAGE_NAME.test(packageName) || packageName === '.' || packageName === '..') {
    throw new TypeError(`profile package name ${JSON.stringify(packageName)} is not an exact npm package name`)
  }
}

/** Match app-boot's installation anchor lookup without consulting Profile-local modules. */
function packageDirFromInstallAnchor(installAnchor: string, packageName: string): string | undefined {
  /* v8 ignore next -- resolve.paths returns null only for Node builtins, which are not valid package names here. */
  for (const searchPath of createRequire(installAnchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

function assertExactVersion(version: string): void {
  if (!EXACT_SEMVER.test(version)) {
    throw new TypeError(`profile package version ${JSON.stringify(version)} must be an exact SemVer`)
  }
}

function assertMutation(mutation: StoreMutation): void {
  assertPackageName(mutation.packageName)
  if (mutation.operation === 'uninstall') return
  if (mutation.operation === 'configure') {
    assertDigest(mutation.patch.expectedDigest, 'expected Profile patch digest')
    assertDigest(mutation.patch.nextDigest, 'next Profile patch digest')
    const bytes = Buffer.from(mutation.patch.nextUtf8, 'utf8')
    if (bytes.length > MAX_PROFILE_PATCH_BYTES || bytes.toString('utf8') !== mutation.patch.nextUtf8
      || mutation.patch.nextUtf8.startsWith('\uFEFF') || mutation.patch.nextUtf8.includes('\0')
      || mutation.patch.nextUtf8.includes('\r') || !mutation.patch.nextUtf8.endsWith('\n')) {
      throw new TypeError('profile patch must be normalized UTF-8 with LF line endings and a trailing newline')
    }
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (digest !== mutation.patch.nextDigest) {
      throw new TypeError('profile patch nextDigest does not match nextUtf8 bytes')
    }
    return
  }
  assertExactVersion(mutation.version)
  assertDigest(mutation.artifact.digest, 'profile artifact digest')
  if (!mutation.artifact.path.toLowerCase().endsWith('.tgz')) {
    throw new TypeError('profile artifact must be a complete local .tgz archive')
  }
}

/** Compare one stored mutation to the immutable semantics of a replay request. */
function sameStoredMutation(stored: StoredMutation, requested: StoreMutation): boolean {
  if (stored.operation !== requested.operation || stored.packageName !== requested.packageName) return false
  if (stored.operation === 'uninstall' || requested.operation === 'uninstall') {
    return stored.operation === requested.operation
  }
  if (stored.operation === 'configure' || requested.operation === 'configure') {
    return stored.operation === 'configure' && requested.operation === 'configure'
      && stored.patch.expectedDigest === requested.patch.expectedDigest
      && stored.patch.nextUtf8 === requested.patch.nextUtf8
      && stored.patch.nextDigest === requested.patch.nextDigest
  }
  return stored.kind === requested.kind
    && stored.version === requested.version
    && stored.digest === requested.artifact.digest
}

/* v8 ignore next -- closed-union exhaustiveness guard */
function assertNever(value: never): never {
  throw new TypeError(`unsupported Profile mutation ${JSON.stringify(value)}`)
}

/** Project immutable mutation semantics; local artifact paths are transport, not identity. */
function mutationDigestInput(mutation: StoreMutation): unknown {
  switch (mutation.operation) {
    case 'install':
    case 'update':
      return {
        operation: mutation.operation,
        kind: mutation.kind,
        packageName: mutation.packageName,
        version: mutation.version,
        artifactDigest: mutation.artifact.digest,
      }
    case 'configure':
      return {
        operation: mutation.operation,
        packageName: mutation.packageName,
        patch: {
          expectedDigest: mutation.patch.expectedDigest,
          nextUtf8: mutation.patch.nextUtf8,
          nextDigest: mutation.patch.nextDigest,
        },
      }
    case 'uninstall':
      return {
        operation: mutation.operation,
        packageName: mutation.packageName,
      }
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      return assertNever(mutation)
  }
}

/** Hash the mutation identity retained after a completed pointer transition. */
function mutationSemanticDigest(request: Pick<StoreStageRequest, 'profile' | 'mutation'>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    profile: request.profile,
    mutation: mutationDigestInput(request.mutation),
  })).digest('hex')}`
}

/** Hash the exact in-flight stage input, including its held state fences. */
function stageRequestDigest(request: StoreStageRequest): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    profile: request.profile,
    expectedRevision: request.expectedRevision,
    expectedTreeDigest: request.expectedTreeDigest,
    mutation: mutationDigestInput(request.mutation),
  })).digest('hex')}`
}

function restoreRequestDigest(request: {
  readonly profile: string
  readonly expectedRevision: number
  readonly expectedTreeDigest: string
}): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    profile: request.profile,
    expectedRevision: request.expectedRevision,
    expectedTreeDigest: request.expectedTreeDigest,
  })).digest('hex')}`
}

function coordinatorSchemaFingerprint(database: DatabaseSync): string {
  return JSON.stringify({
    objects: database.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all(),
    pointerColumns: database.prepare("PRAGMA table_xinfo('pointer_operations')").all(),
    stageColumns: database.prepare("PRAGMA table_xinfo('stage_reservations')").all(),
    pointerIndexes: database.prepare("PRAGMA index_list('pointer_operations')").all(),
    stageIndexes: database.prepare("PRAGMA index_list('stage_reservations')").all(),
    pointerPrimaryKey: database.prepare("PRAGMA index_xinfo('sqlite_autoindex_pointer_operations_1')").all(),
    stagePrimaryKey: database.prepare("PRAGMA index_xinfo('sqlite_autoindex_stage_reservations_1')").all(),
    stageGenerationUnique: database.prepare("PRAGMA index_xinfo('sqlite_autoindex_stage_reservations_2')").all(),
  })
}

/** Initialize or strictly validate the per-Profile staging-reservation schema. */
function initializeCoordinator(database: DatabaseSync): void {
  const applicationRow = database.prepare('PRAGMA application_id').get() as Record<string, unknown>
  const versionRow = database.prepare('PRAGMA user_version').get() as Record<string, unknown>
  let applicationId = Number(Object.values(applicationRow)[0])
  let version = Number(Object.values(versionRow)[0])
  const objects = database.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
  if (applicationId === 0 && version === 0 && objects.length === 0) {
    database.exec(`PRAGMA application_id = ${String(COORDINATOR_APPLICATION_ID)}`)
    database.exec(STAGE_RESERVATIONS_SCHEMA)
    database.exec(POINTER_OPERATIONS_SCHEMA)
    database.exec(`PRAGMA user_version = ${String(COORDINATOR_SCHEMA_VERSION)}`)
    applicationId = COORDINATOR_APPLICATION_ID
    version = COORDINATOR_SCHEMA_VERSION
  }
  if (applicationId !== COORDINATOR_APPLICATION_ID || version !== COORDINATOR_SCHEMA_VERSION
    || coordinatorSchemaFingerprint(database) !== COORDINATOR_SCHEMA_FINGERPRINT) {
    throw new Error('profile transactions: coordinator schema is unsupported or malformed')
  }
}

/** Decode one strict staging-reservation row. */
function decodeStageReservation(value: unknown): StageReservationRow {
  if (!isRecord(value) || typeof value['mutation_id'] !== 'string'
    || typeof value['request_digest'] !== 'string' || typeof value['generation'] !== 'string'
    || (value['status'] !== 'building' && value['status'] !== 'complete')) {
    throw new Error('profile transactions: malformed staging reservation')
  }
  assertProfileMutationId(value['mutation_id'])
  assertDigest(value['request_digest'], 'stage request digest')
  assertGenerationId(value['generation'])
  const ownerPidValue = value['owner_pid']
  const ownerPid = ownerPidValue === null
    ? null
    : typeof ownerPidValue === 'bigint' ? Number(ownerPidValue) : ownerPidValue
  const ownerToken = value['owner_token']
  const ownerIncarnation = value['owner_incarnation']
  if (value['status'] === 'building') {
    if (!Number.isSafeInteger(ownerPid) || (ownerPid as number) <= 0
      || !isProcessIncarnation(ownerIncarnation)
      || typeof ownerToken !== 'string' || !GENERATION_ID.test(ownerToken)) {
      throw new Error('profile transactions: malformed active staging reservation')
    }
  } else if (ownerPid !== null || ownerIncarnation !== null || ownerToken !== null) {
    throw new Error('profile transactions: completed staging reservation retains an owner')
  }
  return {
    mutationId: value['mutation_id'],
    requestDigest: value['request_digest'],
    generation: value['generation'],
    status: value['status'],
    ownerPid: ownerPid as number | null,
    ownerIncarnation,
    ownerToken: ownerToken,
  }
}

function syncDirectory(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EINVAL', 'ENOTSUP', 'EPERM'].some(code => isErrno(error, code))) return
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Create a directory tree and prove every component entry durable, including an EEXIST race winner. */
function mkdirDurable(path: string): void {
  ensureDurableProfileDirectory(path, {
    mode: 0o700,
    notDirectory: directory => new Error(
      `profile transactions: durable directory component is not a directory: ${directory}`,
    ),
  })
}

/** Flush every supported generation entry before publishing its completion marker. */
function syncGenerationTree(path: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) return
  if (info.isFile()) {
    const fd = openSync(path, constants.O_RDONLY)
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return
  }
  if (!info.isDirectory()) {
    throw new Error(`profile transactions: cannot flush unsupported generation entry ${JSON.stringify(path)}`)
  }
  for (const entry of readdirSync(path)) syncGenerationTree(join(path, entry))
  syncDirectory(path)
}

function writeJsonDurable(path: string, value: unknown): void {
  mkdirDurable(dirname(path))
  const temp = `${path}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
    syncDirectory(dirname(path))
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(temp)
    } catch (cleanupError) {
      if (!isErrno(cleanupError, 'ENOENT')) throw cleanupError
    }
    throw error
  }
}

function removeDurable(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return
    throw error
  }
  syncDirectory(dirname(path))
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  }
}

function removeTree(path: string): boolean {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    unlinkSync(path)
    return true
  }
  for (const entry of readdirSync(path)) removeTree(join(path, entry))
  rmdirSync(path)
  return true
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function excludedTreeEntry(relativePath: string): boolean {
  const first = relativePath.split(sep, 1)[0]
  return first !== undefined && EXCLUDED_ROOT_ENTRIES.has(first)
}

function hashFile(path: string): { digest: string; bytes: number } {
  const hash = createHash('sha256')
  const fd = openSync(path, constants.O_RDONLY)
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let bytes = 0
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null)
      if (count === 0) break
      bytes += count
      hash.update(buffer.subarray(0, count))
    }
  } finally {
    closeSync(fd)
  }
  return { digest: `sha256:${hash.digest('hex')}`, bytes }
}

/**
 * Digest a complete Profile tree with stable ordering and internal-link targets.
 * Runtime scratch and the transaction store are intentionally excluded.
 * @param root - Profile tree root.
 * @returns canonical complete-tree SHA-256 digest.
 */
export function digestProfileTree(root: string): string {
  const requestedRoot = resolve(root)
  const hash = createHash('sha256')
  if (!existsSync(requestedRoot)) {
    hash.update('missing-profile\n')
    return `sha256:${hash.digest('hex')}`
  }
  const absoluteRoot = realpathSync(requestedRoot)
  if (!lstatSync(absoluteRoot).isDirectory()) throw new Error(`profile transactions: ${absoluteRoot} is not a directory`)
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const rel = relative(absoluteRoot, path)
      if (excludedTreeEntry(rel)) continue
      const info = lstatSync(path)
      const portable = rel.split(sep).join('/')
      if (info.isDirectory() && !info.isSymbolicLink()) {
        hash.update(`${JSON.stringify(['directory', portable])}\n`)
        walk(path)
      } else if (info.isFile()) {
        const file = hashFile(path)
        hash.update(`${JSON.stringify(['file', portable, info.mode & 0o111, file.bytes, file.digest])}\n`)
      } else if (info.isSymbolicLink()) {
        const target = realpathSync(path)
        if (!isWithin(absoluteRoot, target)) {
          throw new Error(`profile transactions: symlink ${JSON.stringify(portable)} escapes the Profile tree`)
        }
        hash.update(`${JSON.stringify(['symlink', portable, relative(absoluteRoot, target).split(sep).join('/')])}\n`)
      } else {
        throw new Error(`profile transactions: special filesystem entry ${JSON.stringify(portable)} is not supported`)
      }
    }
  }
  walk(absoluteRoot)
  return `sha256:${hash.digest('hex')}`
}

/**
 * Copy every entry covered by {@link digestProfileTree} into a new complete
 * Profile tree while preserving executable bits and internal symlink targets.
 * @param sourceRoot - existing complete Profile tree.
 * @param targetRoot - absent destination directory.
 * @returns after the complete target tree has been copied.
 */
export function copyProfileTree(sourceRoot: string, targetRoot: string): void {
  const absoluteSource = realpathSync(resolve(sourceRoot))
  const absoluteTarget = resolve(targetRoot)
  if (!lstatSync(absoluteSource).isDirectory()) {
    throw new Error(`profile transactions: Profile source ${absoluteSource} is not a directory`)
  }
  mkdirSync(absoluteTarget, { recursive: false, mode: 0o700 })
  const walk = (sourceDir: string, targetDir: string): void => {
    for (const name of readdirSync(sourceDir).sort()) {
      const source = join(sourceDir, name)
      const rel = relative(absoluteSource, source)
      if (excludedTreeEntry(rel)) continue
      const target = join(targetDir, name)
      const info = lstatSync(source)
      if (info.isDirectory() && !info.isSymbolicLink()) {
        mkdirSync(target, { mode: info.mode & 0o777 })
        walk(source, target)
      } else if (info.isFile()) {
        copyFileSync(source, target, constants.COPYFILE_EXCL)
        chmodSync(target, info.mode & 0o777)
      } else if (info.isSymbolicLink()) {
        const sourceTarget = realpathSync(source)
        if (!isWithin(absoluteSource, sourceTarget)) {
          throw new Error(`profile transactions: symlink ${JSON.stringify(rel)} escapes the Profile tree`)
        }
        const targetTarget = join(absoluteTarget, relative(absoluteSource, sourceTarget))
        const targetType = statSync(sourceTarget).isDirectory() ? 'junction' : 'file'
        const linkTarget = process.platform === 'win32' ? targetTarget : relative(dirname(target), targetTarget)
        symlinkSync(linkTarget === '' ? '.' : linkTarget, target, targetType)
      } else {
        throw new Error(`profile transactions: special filesystem entry ${JSON.stringify(rel)} is not supported`)
      }
    }
  }
  walk(absoluteSource, absoluteTarget)
}

function parseGenerationOrNull(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !GENERATION_ID.test(value)) throw new Error(`profile transactions: invalid ${field}`)
  return value
}

function parsePointer(value: unknown, expectedProfile: string, label: string, stateDocument = false): PointerState {
  const keys = stateDocument
    ? ['formatVersion', 'profile', 'revision', 'activeGeneration', 'lastGoodGeneration', 'rollbackGeneration']
    : ['profile', 'revision', 'activeGeneration', 'lastGoodGeneration', 'rollbackGeneration']
  if (!isRecord(value) || !hasExactOwnKeys(value, keys) || value.profile !== expectedProfile) {
    throw new Error(`profile transactions: invalid ${label} Profile`)
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error(`profile transactions: invalid ${label} revision`)
  }
  const pointer: PointerState = {
    profile: expectedProfile,
    revision: value.revision as number,
    activeGeneration: parseGenerationOrNull(value.activeGeneration, `${label} activeGeneration`),
    lastGoodGeneration: parseGenerationOrNull(value.lastGoodGeneration, `${label} lastGoodGeneration`),
    rollbackGeneration: parseGenerationOrNull(value.rollbackGeneration, `${label} rollbackGeneration`),
  }
  assertReachablePointer(pointer, label)
  return pointer
}

function assertReachablePointer(pointer: PointerState, label: string): void {
  const initial = pointer.revision === 0
  if (initial
    ? pointer.activeGeneration !== null || pointer.lastGoodGeneration !== null || pointer.rollbackGeneration !== null
    : pointer.activeGeneration === null || pointer.lastGoodGeneration === null
      || pointer.lastGoodGeneration === pointer.rollbackGeneration) {
    throw new Error(`profile transactions: unreachable ${label} pointer state`)
  }
}

function parseState(value: unknown, profile: string): PointerState {
  if (!isRecord(value) || value.formatVersion !== FORMAT_VERSION) {
    throw new Error('profile transactions: unsupported or malformed state file')
  }
  return parsePointer(value, profile, 'state', true)
}

function samePointer(left: PointerState, right: PointerState): boolean {
  return left.profile === right.profile
    && left.revision === right.revision
    && left.activeGeneration === right.activeGeneration
    && left.lastGoodGeneration === right.lastGoodGeneration
    && left.rollbackGeneration === right.rollbackGeneration
}

function pointerReferencesGeneration(pointer: PointerState, generation: string): boolean {
  return pointer.activeGeneration === generation
    || pointer.lastGoodGeneration === generation
    || pointer.rollbackGeneration === generation
}

function assertJournalTransition(journal: JournalRecord): void {
  const { before, after, kind } = journal
  assertReachablePointer(before, 'journal before')
  assertReachablePointer(after, 'journal after')
  if (after.revision !== before.revision + 1) throw new Error('profile transactions: journal revision is not monotonic')
  if (kind === 'commit') {
    const initialCommit = before.activeGeneration === null
    if (after.activeGeneration === null || pointerReferencesGeneration(before, after.activeGeneration)
      || after.rollbackGeneration !== before.rollbackGeneration
      || (initialCommit
        ? before.lastGoodGeneration !== null || before.rollbackGeneration !== null
          || after.lastGoodGeneration === null || after.lastGoodGeneration === after.activeGeneration
        : before.lastGoodGeneration === null || after.lastGoodGeneration !== before.lastGoodGeneration)) {
      throw new Error('profile transactions: malformed commit journal transition')
    }
  } else if (kind === 'restore') {
    const target = before.activeGeneration !== before.lastGoodGeneration
      ? before.lastGoodGeneration
      : before.rollbackGeneration
    if (target === null || after.activeGeneration !== target
      || after.lastGoodGeneration !== before.lastGoodGeneration
      || after.rollbackGeneration !== before.rollbackGeneration) {
      throw new Error('profile transactions: malformed restore journal transition')
    }
  } else if (before.activeGeneration === null || before.activeGeneration === before.lastGoodGeneration
    || after.activeGeneration !== before.activeGeneration
    || after.lastGoodGeneration !== after.activeGeneration
    || after.rollbackGeneration !== before.lastGoodGeneration) {
    throw new Error('profile transactions: malformed boot acknowledgement journal transition')
  }
}

function parseJournal(value: unknown, profile: string): JournalRecord {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'formatVersion', 'operation', 'kind', 'mutationId', 'requestDigest', 'profile', 'before', 'after',
  ]) || value.formatVersion !== FORMAT_VERSION || value.profile !== profile
    || typeof value.operation !== 'string' || !GENERATION_ID.test(value.operation)
    || (value.kind !== 'commit' && value.kind !== 'restore' && value.kind !== 'acknowledge-boot')
    || (value.mutationId !== null
      && (typeof value.mutationId !== 'string' || !PROFILE_MUTATION_ID.test(value.mutationId)))
    || (value.requestDigest !== null
      && (typeof value.requestDigest !== 'string' || !SHA256_DIGEST.test(value.requestDigest)))
    || ((value.mutationId === null) !== (value.requestDigest === null))
    || ((value.kind === 'acknowledge-boot') === (value.mutationId !== null))) {
    throw new Error('profile transactions: unsupported or malformed journal file')
  }
  const journal: JournalRecord = {
    formatVersion: FORMAT_VERSION,
    operation: value.operation,
    kind: value.kind,
    mutationId: value.mutationId,
    requestDigest: value.requestDigest,
    profile,
    before: parsePointer(value.before, profile, 'journal before'),
    after: parsePointer(value.after, profile, 'journal after'),
  }
  assertJournalTransition(journal)
  return journal
}

function stateDocument(state: PointerState): Record<string, unknown> {
  return { formatVersion: FORMAT_VERSION, ...state }
}

function readManifest(path: string, label: string): ProfileManifestDocument {
  const value = readJson(path)
  if (!isRecord(value)) throw new Error(`profile transactions: ${label} must be a JSON object`)
  return value
}

function parseDependencies(manifest: ProfileManifestDocument, label: string): Record<string, string> {
  const value = manifest.dependencies
  if (value === undefined) return {}
  if (!isRecord(value) || Object.values(value).some(spec => typeof spec !== 'string')) {
    throw new Error(`profile transactions: ${label} dependencies must be a string map`)
  }
  return value as Record<string, string>
}

function parseBundles(manifest: ProfileManifestDocument, label: string): string[] {
  if (!isRecord(manifest.dsh) || !isRecord(manifest.dsh.profile)
    || !Array.isArray(manifest.dsh.profile.bundles)
    || manifest.dsh.profile.bundles.some(name => typeof name !== 'string')) {
    throw new Error(`profile transactions: ${label} must declare dsh.profile.bundles`)
  }
  const bundles = manifest.dsh.profile.bundles as string[]
  if (new Set(bundles).size !== bundles.length) {
    throw new Error(`profile transactions: ${label} dsh.profile.bundles contains duplicates`)
  }
  return [...bundles]
}

function mutableSection(document: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = document[key]
  if (current === undefined) {
    const created: Record<string, unknown> = {}
    document[key] = created
    return created
  }
  if (!isRecord(current)) throw new Error(`profile transactions: pnpm lockfile ${key} must be a map`)
  return current
}

function readLockfile(profilePath: string): Record<string, unknown> {
  const path = join(profilePath, PROFILE_LOCK)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`profile transactions: complete Profile is missing readable ${PROFILE_LOCK}`, { cause: error })
  }
  const documents = parseAllDocuments(raw)
  if (documents.length !== 1 || documents[0] === undefined || documents[0].errors.length > 0) {
    throw new Error(`profile transactions: ${PROFILE_LOCK} must contain one valid YAML document`)
  }
  const value = documents[0].toJS() as unknown
  if (!isRecord(value) || value.lockfileVersion !== '9.0') {
    throw new Error(`profile transactions: ${PROFILE_LOCK} must use lockfileVersion '9.0'`)
  }
  return value
}

function writeLockfile(profilePath: string, lockfile: Record<string, unknown>): void {
  writeFileSync(join(profilePath, PROFILE_LOCK), stringify(lockfile, { lineWidth: 0 }), 'utf8')
}

function sha512Integrity(path: string): string {
  const hash = createHash('sha512')
  const fd = openSync(path, constants.O_RDONLY)
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null)
      if (count === 0) break
      hash.update(buffer.subarray(0, count))
    }
  } finally {
    closeSync(fd)
  }
  return `sha512-${hash.digest('base64')}`
}

function assertLockfile(profilePath: string, manifest: ProfileManifestDocument): void {
  const dependencies = parseDependencies(manifest, `Profile manifest ${join(profilePath, 'package.json')}`)
  const lockfile = readLockfile(profilePath)
  const importers = mutableSection(lockfile, 'importers')
  const importer = importers['.']
  if (!isRecord(importer)) throw new Error(`profile transactions: ${PROFILE_LOCK} has no root importer`)
  const lockedDependencies = importer.dependencies === undefined ? {} : importer.dependencies
  if (!isRecord(lockedDependencies)) throw new Error(`profile transactions: ${PROFILE_LOCK} root dependencies must be a map`)
  if (Object.keys(lockedDependencies).length !== Object.keys(dependencies).length) {
    throw new Error(`profile transactions: ${PROFILE_LOCK} dependencies do not match package.json`)
  }
  const packages = mutableSection(lockfile, 'packages')
  const snapshots = mutableSection(lockfile, 'snapshots')
  for (const [packageName, specifier] of Object.entries(dependencies)) {
    const locked = Object.hasOwn(lockedDependencies, packageName) ? lockedDependencies[packageName] : undefined
    if (!isRecord(locked) || locked.specifier !== specifier || typeof locked.version !== 'string') {
      throw new Error(`profile transactions: ${PROFILE_LOCK} importer does not match ${packageName}`)
    }
    if (!EXACT_SEMVER.test(specifier) || !locked.version.startsWith('file:.dsh-artifacts/')) continue
    const packageKey = `${packageName}@${locked.version}`
    const packageRecord = packages[packageKey]
    const snapshot = snapshots[packageKey]
    if (!isRecord(packageRecord) || packageRecord.version !== specifier || !isRecord(packageRecord.resolution)
      || packageRecord.resolution.tarball !== locked.version || typeof packageRecord.resolution.integrity !== 'string'
      || !isRecord(snapshot)) {
      throw new Error(`profile transactions: ${PROFILE_LOCK} has no self-consistent artifact snapshot for ${packageName}`)
    }
    const artifactPath = resolve(profilePath, locked.version.slice('file:'.length))
    if (!isWithin(profilePath, artifactPath) || !lstatSync(artifactPath).isFile()
      || sha512Integrity(artifactPath) !== packageRecord.resolution.integrity) {
      throw new Error(`profile transactions: ${PROFILE_LOCK} artifact integrity does not match ${packageName}`)
    }
  }
}

function previousPackageKey(locked: unknown): string | null {
  if (!isRecord(locked) || typeof locked.version !== 'string') return null
  return locked.version.replace(/\([^)]*\)$/u, '')
}

interface ArtifactLockMetadata {
  readonly relative: string
  readonly integrity: string
  readonly manifest: ProfileManifestDocument
}

type LockfileMutation =
  | { readonly mutation: StoreUninstallMutation; readonly artifact: null }
  | { readonly mutation: StoreArtifactMutation; readonly artifact: ArtifactLockMetadata }

function updateLockfile(
  profilePath: string,
  change: LockfileMutation,
): void {
  const lockfile = readLockfile(profilePath)
  const importers = mutableSection(lockfile, 'importers')
  const importer = importers['.'] as Record<string, unknown>
  const lockedDependencies = Object.assign(
    Object.create(null) as Record<string, unknown>,
    isRecord(importer.dependencies) ? importer.dependencies : {},
  )
  importer.dependencies = lockedDependencies
  const packages = mutableSection(lockfile, 'packages')
  const snapshots = mutableSection(lockfile, 'snapshots')
  const previous = Object.hasOwn(lockedDependencies, change.mutation.packageName)
    ? lockedDependencies[change.mutation.packageName]
    : undefined
  const previousVersion = previousPackageKey(previous)
  if (previousVersion !== null) {
    delete packages[`${change.mutation.packageName}@${previousVersion}`]
    delete snapshots[`${change.mutation.packageName}@${previousVersion}`]
  }
  if (change.artifact === null) {
    Reflect.deleteProperty(lockedDependencies, change.mutation.packageName)
  } else {
    const { artifact, mutation } = change
    const fileReference = `file:${artifact.relative}`
    lockedDependencies[mutation.packageName] = { specifier: mutation.version, version: fileReference }
    const packageKey = `${mutation.packageName}@${fileReference}`
    const packageRecord: Record<string, unknown> = {
      resolution: { integrity: artifact.integrity, tarball: fileReference },
      version: mutation.version,
    }
    for (const key of ['engines', 'peerDependencies', 'peerDependenciesMeta'] as const) {
      if (isRecord(artifact.manifest[key])) packageRecord[key] = artifact.manifest[key]
    }
    packages[packageKey] = packageRecord
    snapshots[packageKey] = {}
  }
  if (Object.keys(packages).length === 0) lockfile.packages = {}
  if (Object.keys(snapshots).length === 0) lockfile.snapshots = {}
  writeLockfile(profilePath, lockfile)
}

function packagePath(profilePath: string, packageName: string): string {
  assertPackageName(packageName)
  return join(profilePath, 'node_modules', ...packageName.split('/'))
}

function assertCompleteProfile(profilePath: string): ProfileManifestDocument {
  const manifestPath = join(profilePath, 'package.json')
  const manifest = readManifest(manifestPath, `Profile manifest ${manifestPath}`)
  const dependencies = parseDependencies(manifest, `Profile manifest ${manifestPath}`)
  parseBundles(manifest, `Profile manifest ${manifestPath}`)
  for (const filename of [PROFILE_PATCH, PROFILE_WORKSPACE, PROFILE_LOCK]) {
    const path = join(profilePath, filename)
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(`profile transactions: complete Profile is missing regular ${filename}`)
    }
  }
  for (const [packageName, version] of Object.entries(dependencies)) {
    assertPackageName(packageName)
    const installed = readManifest(join(packagePath(profilePath, packageName), 'package.json'), `installed ${packageName} manifest`)
    if (installed.name !== packageName || typeof installed.version !== 'string'
      || (EXACT_SEMVER.test(version) && installed.version !== version)) {
      throw new Error(`profile transactions: installed ${packageName} does not match its manifest dependency`)
    }
  }
  assertLockfile(profilePath, manifest)
  digestProfileTree(profilePath)
  return manifest
}

function safeBundlePatch(packageRoot: string, manifest: ProfileManifestDocument): string | null {
  if (!isRecord(manifest.dsh) || !isRecord(manifest.dsh.bundle)) return null
  const declared = manifest.dsh.bundle.patch
  if (typeof declared !== 'string' || declared === '' || declared.includes('\\') || isAbsolute(declared)) {
    throw new Error('profile transactions: artifact dsh.bundle.patch must be a safe relative path')
  }
  const patchPath = resolve(packageRoot, declared)
  if (!isWithin(packageRoot, patchPath) || !existsSync(patchPath) || !lstatSync(patchPath).isFile()) {
    throw new Error('profile transactions: artifact dsh.bundle.patch does not name a regular file inside the package')
  }
  return declared
}

function assertArchivePackage(manifest: ProfileManifestDocument, packageRoot: string, mutation: StoreArtifactMutation): void {
  if (manifest.name !== mutation.packageName || manifest.version !== mutation.version) {
    throw new Error(
      `profile transactions: archive identity ${JSON.stringify(manifest.name)}@${JSON.stringify(manifest.version)} `
      + `does not match ${mutation.packageName}@${mutation.version}`,
    )
  }
  for (const key of ['dependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies'] as const) {
    const value = manifest[key]
    if (value !== undefined && (!isRecord(value) || Object.keys(value).length > 0)) {
      throw new Error(`profile transactions: P0 artifacts cannot declare ${key}`)
    }
  }
  if (manifest.scripts !== undefined && !isRecord(manifest.scripts)) {
    throw new Error('profile transactions: artifact scripts must be an object when present')
  }
  for (const script of LIFECYCLE_SCRIPTS) {
    if (isRecord(manifest.scripts) && manifest.scripts[script] !== undefined) {
      throw new Error(`profile transactions: P0 artifacts cannot declare lifecycle script ${script}`)
    }
  }
  if (manifest.bin !== undefined) {
    throw new Error('profile transactions: P0 artifacts cannot declare bin entries')
  }
  const bundlePatch = safeBundlePatch(packageRoot, manifest)
  if ((mutation.kind === 'bundle') !== (bundlePatch !== null)) {
    throw new Error(`profile transactions: artifact bundle declaration does not match requested kind ${mutation.kind}`)
  }
}

function validateArchiveEntry(entry: ReadEntry, seen: Set<string>, counters: { entries: number; bytes: number }): void {
  const path = entry.path
  const normalized = posix.normalize(path)
  if (path.includes('\\') || path.startsWith('/') || normalized === '..' || normalized.startsWith('../')
    || (normalized !== 'package' && !normalized.startsWith('package/'))) {
    throw new Error(`profile transactions: unsafe archive entry ${JSON.stringify(path)}`)
  }
  if (!['Directory', 'File', 'OldFile', 'ContiguousFile'].includes(entry.type)) {
    throw new Error(`profile transactions: archive entry ${JSON.stringify(path)} has unsupported type ${entry.type}`)
  }
  if (seen.has(normalized) && entry.type !== 'Directory') {
    throw new Error(`profile transactions: archive contains duplicate entry ${JSON.stringify(path)}`)
  }
  seen.add(normalized)
  counters.entries += 1
  counters.bytes += entry.size
  if (counters.entries > MAX_ARCHIVE_ENTRIES || counters.bytes > MAX_ARCHIVE_BYTES) {
    throw new Error('profile transactions: archive exceeds the P0 entry or uncompressed-size limit')
  }
}

async function extractArchive(
  artifactPath: string,
  target: string,
  mutation: StoreArtifactMutation,
  afterPreflight?: (artifactPath: string) => void | Promise<void>,
): Promise<ProfileManifestDocument> {
  const seen = new Set<string>()
  const counters = { entries: 0, bytes: 0 }
  const admission = { failure: null as { readonly error: unknown } | null }
  try {
    await list({
      file: artifactPath,
      strict: true,
      onReadEntry: (entry) => {
        if (admission.failure !== null) return
        try {
          validateArchiveEntry(entry, seen, counters)
        } catch (error) {
          admission.failure = { error }
        }
      },
    })
  } catch (error) {
    if (admission.failure !== null) throw admission.failure.error
    throw error
  }
  if (admission.failure !== null) throw admission.failure.error
  await afterPreflight?.(artifactPath)
  mkdirSync(target, { recursive: false, mode: 0o700 })
  const extractSeen = new Set<string>()
  const extractCounters = { entries: 0, bytes: 0 }
  const extractAdmission = { failure: null as { readonly error: unknown } | null }
  try {
    await extract({
      file: artifactPath,
      cwd: target,
      strip: 1,
      strict: true,
      preserveOwner: false,
      noMtime: true,
      filter: (path, entry) => {
        if (extractAdmission.failure !== null) return false
        try {
          validateArchiveEntry(entry as ReadEntry, extractSeen, extractCounters)
          return path === 'package' || path.startsWith('package/')
        } catch (error) {
          extractAdmission.failure = { error }
          return false
        }
      },
    })
  } catch (error) {
    if (extractAdmission.failure !== null) throw extractAdmission.failure.error
    throw error
  }
  if (extractAdmission.failure !== null) throw extractAdmission.failure.error
  const manifest = readManifest(join(target, 'package.json'), 'artifact package.json')
  assertArchivePackage(manifest, target, mutation)
  digestProfileTree(target)
  return manifest
}

function artifactFilename(packageName: string): string {
  return `${Buffer.from(packageName).toString('base64url')}.tgz`
}

/** Filesystem paths for one Profile's central transaction state. */
function paths(profilesDir: string, profile: string) {
  const profileDir = join(profilesDir, profile)
  const transactionDir = join(profilesDir, TRANSACTION_ROOT, profile)
  return {
    profileDir,
    transactionDir,
    state: join(transactionDir, STATE_FILE),
    journal: join(transactionDir, JOURNAL_FILE),
    coordinator: join(transactionDir, COORDINATOR_FILE),
    generations: join(transactionDir, GENERATIONS_DIR),
    stageLeases: join(transactionDir, STAGE_LEASES_DIR),
  }
}

function generationPaths(profilesDir: string, profile: string, generation: string) {
  const root = join(paths(profilesDir, profile).generations, generation)
  return { root, profile: join(root, GENERATION_PROFILE), record: join(root, GENERATION_RECORD) }
}

/** Local complete-Profile transaction store used by the Cordis provider. */
export class LocalProfileTransactionStore {
  private readonly profilesDir: string
  private readonly installAnchor: string
  private readonly lockWaitMs: number
  private readonly hooks: LocalProfileTransactionHooks

  constructor(config: LocalProfileTransactionStoreConfig, hooks: LocalProfileTransactionHooks = {}) {
    this.profilesDir = resolve(config.profilesDir)
    this.installAnchor = config.installAnchor
    this.hooks = hooks
    if (!Number.isSafeInteger(config.lockWaitMs) || config.lockWaitMs < 0 || config.lockWaitMs > 2_147_483_647) {
      throw new TypeError('profile transaction lockWaitMs must be an integer from 0 through 2147483647')
    }
    this.lockWaitMs = config.lockWaitMs
  }

  /**
   * Prepare the store without creating Profile state or importing SQLite.
   * The first writer loads SQLite so read-only CLI paths stay silent on Node
   * releases that still classify `node:sqlite` as experimental.
   */
  async initialize(): Promise<void> {
    await Promise.resolve()
  }

  /**
   * Read one Profile without creating directories, SQLite files, or state.
   * @param profile - safe direct-child Profile name.
   * @returns current projected pointer and complete effective-tree digest.
   */
  snapshot(profile: string): Promise<StoreSnapshot> {
    assertProfileName(profile)
    return Promise.resolve(this.snapshotFromState(this.readProjectedState(profile)))
  }

  /**
   * Build and validate one complete isolated candidate.
   * @param request - exact mutation and held revision/tree fences.
   * @param validate - read-only validation of the complete candidate Profile.
   * @returns validated generation handle.
   */
  async stage(
    request: StoreStageRequest,
    validate: (candidate: StoreGenerationCandidate) => void | Promise<void>,
  ): Promise<StoreStagedGeneration> {
    assertProfileName(request.profile)
    assertProfileMutationId(request.mutationId)
    assertRevision(request.expectedRevision)
    assertDigest(request.expectedTreeDigest, 'expected Profile tree digest')
    assertMutation(request.mutation)
    const stageOwnerToken = randomUUID()
    const deadline = Date.now() + this.lockWaitMs
    let reservation: Exclude<StageReservationDecision, { kind: 'in-progress' }>
    for (;;) {
      const decision = await this.withRecoveredWriterLock(
        request.profile,
        (database, state, DatabaseSync) => this.reserveStageLocked(
          database,
          request,
          state,
          stageOwnerToken,
          DatabaseSync,
        ),
      )
      if (decision.kind !== 'in-progress') {
        reservation = decision
        break
      }
      if (Date.now() >= deadline) {
        throw new Error(`profile transactions: mutation ${request.mutationId} is still staging`)
      }
      await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 10))
    }
    if (reservation.kind === 'complete') return this.stagedFromRecord(reservation.record, request)
    if (reservation.kind === 'committed') return this.stagedFromCommittedRecord(reservation.record, request)

    this.hooks.afterStageReservationPersisted?.()
    const { generation, basedOn } = reservation
    const candidate = generationPaths(this.profilesDir, request.profile, generation)
    let stageFailure: { readonly error: unknown } | null = null
    let artifactPath: string | null = null
    try {
      if (reservation.replacedGeneration !== null) {
        removeTree(generationPaths(this.profilesDir, request.profile, reservation.replacedGeneration).root)
      }
      if (reservation.replacedOwnerToken !== null) {
        removeDurable(this.stageLeasePath(request.profile, reservation.replacedOwnerToken))
      }
      mkdirSync(candidate.root, { recursive: false, mode: 0o700 })
      copyProfileTree(basedOn.effectivePath, candidate.profile)
      this.hooks.afterCandidateCopied?.(candidate.profile)
      const copiedBaseDigest = digestProfileTree(candidate.profile)
      if (copiedBaseDigest !== basedOn.treeDigest) {
        throw new LocalProfileTreeConflictError(request.profile, basedOn.treeDigest, copiedBaseDigest)
      }
      const storedMutation = await this.applyMutation(request.profile, candidate, request.mutation)
      assertCompleteProfile(candidate.profile)
      const treeDigest = digestProfileTree(candidate.profile)
      if (storedMutation.operation === 'install' || storedMutation.operation === 'update') {
        artifactPath = join(candidate.profile, storedMutation.artifactFile)
      }
      await validate({
        profile: request.profile,
        mutationId: request.mutationId,
        generation,
        basedOn,
        mutation: request.mutation,
        generationPath: candidate.profile,
        artifactPath,
        treeDigest,
      })
      const afterValidation = digestProfileTree(candidate.profile)
      if (afterValidation !== treeDigest) {
        throw new Error('profile transactions: candidate validator modified the Profile tree')
      }
      const record: GenerationRecord = {
        formatVersion: FORMAT_VERSION,
        profile: request.profile,
        generation,
        mutationId: request.mutationId,
        source: 'mutation',
        basedOnRevision: basedOn.revision,
        basedOnGeneration: basedOn.activeGeneration,
        basedOnTreeDigest: basedOn.treeDigest,
        treeDigest,
        mutation: storedMutation,
      }
      syncGenerationTree(candidate.profile)
      writeJsonDurable(candidate.record, record)
      syncDirectory(dirname(candidate.root))
      this.hooks.afterGenerationPersisted?.()
      await this.withWriterLock(request.profile, (database) => {
        this.finalizeStageLocked(database, request, generation, stageOwnerToken)
      })
      return this.stagedFromRecord(record, request)
    } catch (error) {
      let failure = error
      try {
        await this.withWriterLock(request.profile, (database) => {
          this.abandonStageLocked(database, request, generation, stageOwnerToken)
        })
      } catch (cleanupError) {
        failure = new AggregateError(
          [error, cleanupError],
          'profile transactions: stage failed and reservation cleanup also failed',
          { cause: error },
        )
      }
      stageFailure = { error: failure }
      throw failure
    } finally {
      try {
        this.releaseStageLease(reservation.lease)
      } catch (releaseError) {
        if (stageFailure !== null) {
          throw new AggregateError(
            [stageFailure.error, releaseError],
            'profile transactions: stage failed and owner lease release also failed',
            { cause: stageFailure.error },
          )
        }
        throw releaseError
      }
    }
  }

  /**
   * Publish a validated generation and require a restart before boot acknowledgement.
   * @param request - expected Profile revision and the staged generation to publish.
   * @returns the before/after snapshots and whether the app must restart.
   */
  commit(request: {
    profile: string
    expectedRevision: number
    expectedTreeDigest: string
    generation: string
  }): Promise<{ operation: 'commit'; before: StoreSnapshot; after: StoreSnapshot; restartRequired: boolean }> {
    assertProfileName(request.profile)
    assertRevision(request.expectedRevision)
    assertDigest(request.expectedTreeDigest, 'expected Profile tree digest')
    assertGenerationId(request.generation)
    return this.withRecoveredWriterLock(request.profile, (database, beforeState) => {
      const before = this.snapshotFromState(beforeState)
      const record = this.readCompleteGeneration(request.profile, request.generation, true)
      const replay = this.readCommitOperationForRecordLocked(database, record)
      if (replay !== undefined) return replay
      this.assertFinalizedStageLocked(database, record)
      if (before.activeGeneration === request.generation) {
        throw new Error('profile transactions: active mutation generation has no durable commit receipt')
      }
      this.assertExpected(before, request.expectedRevision, request.expectedTreeDigest)
      if (record.basedOnRevision !== before.revision || record.basedOnGeneration !== before.activeGeneration
        || record.basedOnTreeDigest !== before.treeDigest) {
        throw new LocalProfileRevisionConflictError(request.profile, record.basedOnRevision, before.revision)
      }

      let capturedBaseline: string | null = null
      try {
        let baseline: string | null = before.lastGoodGeneration
        if (before.activeGeneration === null) {
          baseline = this.captureBaseline(request.profile, before)
          capturedBaseline = baseline
          const liveAfterCapture = digestProfileTree(before.effectivePath)
          if (liveAfterCapture !== before.treeDigest) {
            throw new LocalProfileTreeConflictError(request.profile, before.treeDigest, liveAfterCapture)
          }
        }
        /* v8 ignore next -- reachable non-initial pointer states always retain a parsed last-good generation. */
        if (baseline === null) throw new Error('profile transactions: commit has no recovery baseline generation')
        const afterState: PointerState = {
          profile: request.profile,
          revision: before.revision + 1,
          activeGeneration: request.generation,
          lastGoodGeneration: baseline,
          rollbackGeneration: before.rollbackGeneration,
        }
        const mutationId = record.mutationId as string
        const requestDigest = this.recordMutationSemanticDigest(record)
        this.publishJournaled('commit', beforeState, afterState, {
          mutationId,
          requestDigest,
          retainJournal: true,
        })
        this.recordCommitOperationLocked(database, record, requestDigest, beforeState, afterState)
        return this.commitReceipt(record, beforeState, afterState)
      } catch (error) {
        if (capturedBaseline !== null) {
          try {
            this.removeUnreferencedGeneration(request.profile, capturedBaseline)
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'profile transactions: commit failed and baseline cleanup also failed',
              { cause: error },
            )
          }
        }
        throw error
      }
    })
  }

  /**
   * Remove one complete or incomplete generation that no state names.
   * @param request - Profile and unreferenced generation to remove.
   * @returns whether a generation directory was removed.
   */
  abort(request: { profile: string; generation: string }): Promise<boolean> {
    assertProfileName(request.profile)
    assertGenerationId(request.generation)
    return this.withRecoveredWriterLock(request.profile, (database, state) => {
      if ([state.activeGeneration, state.lastGoodGeneration, state.rollbackGeneration].includes(request.generation)) {
        throw new Error(`profile transactions: generation ${request.generation} is authoritative and cannot be aborted`)
      }
      if (this.pointerOperationsReferenceGenerationLocked(database, request.profile, request.generation)) {
        throw new Error(`profile transactions: generation ${request.generation} is retained for durable mutation replay`)
      }
      const generation = generationPaths(this.profilesDir, request.profile, request.generation)
      const removed = removeTree(generation.root)
      if (removed) {
        database.prepare('DELETE FROM stage_reservations WHERE generation = ?').run(request.generation)
      }
      if (removed) syncDirectory(dirname(generation.root))
      return removed
    })
  }

  /**
   * Publish the last-good or rollback recovery target and require restart.
   * @param request - expected Profile state and idempotent restore mutation identity.
   * @returns the before/after snapshots for the published recovery target.
   */
  restoreLastGood(request: {
    profile: string
    mutationId: string
    expectedRevision: number
    expectedTreeDigest: string
  }): Promise<{ operation: 'restore'; before: StoreSnapshot; after: StoreSnapshot; restartRequired: true }> {
    assertProfileName(request.profile)
    assertProfileMutationId(request.mutationId)
    assertRevision(request.expectedRevision)
    assertDigest(request.expectedTreeDigest, 'expected Profile tree digest')
    const requestDigest = restoreRequestDigest(request)
    return this.withRecoveredWriterLock(request.profile, (database, beforeState) => {
      if (database.prepare('SELECT 1 FROM stage_reservations WHERE mutation_id = ?').get(request.mutationId) !== undefined) {
        throw new LocalProfileMutationConflictError(request.profile, request.mutationId)
      }
      const replay = this.readRestoreOperationLocked(database, request)
      if (replay !== undefined) return replay
      const before = this.snapshotFromState(beforeState)
      this.assertExpected(before, request.expectedRevision, request.expectedTreeDigest)
      const target = before.activeGeneration !== before.lastGoodGeneration
        ? before.lastGoodGeneration
        : before.rollbackGeneration
      if (target === null) {
        throw new Error(`profile transactions: Profile ${JSON.stringify(request.profile)} has no recoverable generation`)
      }
      this.readCompleteGeneration(request.profile, target, true)
      const afterState: PointerState = { ...beforeState, revision: before.revision + 1, activeGeneration: target }
      this.publishJournaled('restore', beforeState, afterState, {
        mutationId: request.mutationId,
        requestDigest,
        retainJournal: true,
      })
      this.recordRestoreOperationLocked(database, request.mutationId, requestDigest, beforeState, afterState)
      return this.restoreReceipt(beforeState, afterState)
    })
  }

  /**
   * Resolve one retained restore receipt without selecting or publishing a new recovery target.
   * @param request - exact Profile and caller mutation identity.
   * @returns the committed receipt, or `null` when no restore transaction owns that identity.
   */
  getRestoreReceipt(request: {
    readonly profile: string
    readonly mutationId: string
  }): Promise<StoreRestoreReceipt | null> {
    assertProfileName(request.profile)
    assertProfileMutationId(request.mutationId)
    const profilePaths = paths(this.profilesDir, request.profile)
    if (!existsSync(profilePaths.coordinator) && !existsSync(profilePaths.journal)) return Promise.resolve(null)
    return this.withRecoveredWriterLock(request.profile, (database) => {
      const receipt = this.readRestoreOperationLocked(database, request)
      if (receipt === undefined) return null
      return {
        mutationId: request.mutationId,
        status: 'committed',
        ...receipt,
      }
    })
  }

  /**
   * Promote the active generation only after the real app Loader boot succeeds.
   * @param request - exact active generation and expected Profile state.
   * @returns the before/after snapshots for the boot acknowledgement.
   */
  acknowledgeBoot(request: {
    profile: string
    expectedRevision: number
    expectedTreeDigest: string
    generation: string
  }): Promise<{ operation: 'acknowledge-boot'; before: StoreSnapshot; after: StoreSnapshot; restartRequired: false }> {
    assertProfileName(request.profile)
    assertRevision(request.expectedRevision)
    assertDigest(request.expectedTreeDigest, 'expected Profile tree digest')
    assertGenerationId(request.generation)
    return this.withRecoveredWriterLock(request.profile, (_database, beforeState) => {
      const before = this.snapshotFromState(beforeState)
      this.assertExpected(before, request.expectedRevision, request.expectedTreeDigest)
      if (before.activeGeneration !== request.generation) {
        throw new Error('profile transactions: boot acknowledgement does not name the active generation')
      }
      this.readCompleteGeneration(request.profile, request.generation, true)
      if (before.activeGeneration === before.lastGoodGeneration) {
        return { operation: 'acknowledge-boot', before, after: before, restartRequired: false }
      }
      const afterState: PointerState = {
        ...beforeState,
        revision: before.revision + 1,
        lastGoodGeneration: before.activeGeneration,
        rollbackGeneration: before.lastGoodGeneration,
      }
      this.publishJournaled('acknowledge-boot', beforeState, afterState)
      return { operation: 'acknowledge-boot', before, after: this.snapshotFromState(afterState), restartRequired: false }
    })
  }

  /**
   * List staged and recoverable complete generations without changing disk state.
   * @param profile - Profile whose generation inventory to read.
   * @returns the current snapshot and complete generation summaries.
   */
  async list(profile: string): Promise<StoreGenerationInventory> {
    const snapshot = await this.snapshot(profile)
    const profilePaths = paths(this.profilesDir, profile)
    if (!existsSync(profilePaths.generations)) return { snapshot, active: null, staged: [], recoverable: [] }
    const summaries = new Map<string, StoreGenerationSummary>()
    for (const entry of readdirSync(profilePaths.generations, { withFileTypes: true })) {
      if (!entry.isDirectory() || !GENERATION_ID.test(entry.name)) continue
      try {
        const record = this.readCompleteGeneration(profile, entry.name, true)
        summaries.set(entry.name, this.generationSummary(record))
      } catch {
        // Incomplete stage directories are neither committable nor recoverable.
      }
    }
    const authoritative = new Set([
      snapshot.activeGeneration,
      snapshot.lastGoodGeneration,
      snapshot.rollbackGeneration,
    ].filter((generation): generation is string => generation !== null))
    const staged = [...summaries.entries()]
      .filter(([generation]) => !authoritative.has(generation))
      .map(([, summary]) => summary)
    let active: StoreGenerationSummary | null = null
    if (snapshot.activeGeneration !== null) {
      active = summaries.get(snapshot.activeGeneration) ?? null
      if (active === null) {
        throw new Error('profile transactions: active generation disappeared during inventory projection')
      }
    }
    const recoverableIds = [snapshot.lastGoodGeneration, snapshot.rollbackGeneration]
      .filter((generation): generation is string => generation !== null && generation !== snapshot.activeGeneration)
    const recoverable = [...new Set(recoverableIds)].map((generation) => {
      const summary = summaries.get(generation)
      if (summary === undefined) {
        throw new Error('profile transactions: recoverable generation disappeared during inventory projection')
      }
      return summary
    })
    return { snapshot, active, staged, recoverable }
  }

  /** Reject a direct bundle whose bytes app-boot would resolve from the installation first. */
  private assertNoInstallationOwnedDirectBundle(profilePath: string, mutation: StoreMutation): void {
    const manifestPath = join(profilePath, 'package.json')
    const manifest = assertCompleteProfile(profilePath)
    const bundles = parseBundles(manifest, `Profile manifest ${manifestPath}`)
    const remainsOrBecomesDirect = bundles.includes(mutation.packageName)
      || ((mutation.operation === 'install' || mutation.operation === 'update') && mutation.kind === 'bundle')
    if (!remainsOrBecomesDirect
      || packageDirFromInstallAnchor(this.installAnchor, mutation.packageName) === undefined) return
    throw new TypeError(
      `profile transactions: package ${JSON.stringify(mutation.packageName)} resolves from the dsh installation `
      + 'and cannot be managed while it is a direct Profile bundle',
    )
  }

  /** Resolve the per-owner SQLite lease file held for the complete stage Promise. */
  private stageLeasePath(profile: string, ownerToken: string): string {
    assertGenerationId(ownerToken)
    return join(paths(this.profilesDir, profile).stageLeases, `${ownerToken}.sqlite`)
  }

  /** Acquire one OS-released lock whose lifetime is the exact owning Worker or process. */
  private acquireStageLeaseLocked(
    profile: string,
    ownerToken: string,
    DatabaseSync: DatabaseSyncConstructor,
  ): StageLease {
    const leasePath = this.stageLeasePath(profile, ownerToken)
    mkdirDurable(dirname(leasePath))
    const database = new DatabaseSync(leasePath)
    try {
      database.exec('PRAGMA busy_timeout = 0')
      database.exec('PRAGMA journal_mode = DELETE')
      database.exec('PRAGMA synchronous = FULL')
      database.exec('BEGIN IMMEDIATE')
      syncDirectory(dirname(leasePath))
      return { database, path: leasePath }
    } catch (error) {
      try {
        database.close()
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          'profile transactions: stage owner lease acquisition and close both failed',
          { cause: error },
        )
      }
      removeDurable(leasePath)
      throw error
    }
  }

  /** Release and remove one owner lease after its reservation is no longer building. */
  private releaseStageLease(lease: StageLease): void {
    const failures: unknown[] = []
    try {
      lease.database.exec('ROLLBACK')
    } catch (error) {
      failures.push(error)
    }
    try {
      lease.database.close()
    } catch (error) {
      failures.push(error)
    }
    try {
      removeDurable(lease.path)
    } catch (error) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'profile transactions: stage owner lease release failed')
    }
  }

  /** Check the OS-managed lock without trusting PID liveness alone. */
  private stageLeaseIsHeld(
    profile: string,
    ownerToken: string,
    DatabaseSync: DatabaseSyncConstructor,
  ): boolean {
    const leasePath = this.stageLeasePath(profile, ownerToken)
    if (!existsSync(leasePath)) return false
    const probe = new DatabaseSync(leasePath)
    let transaction = false
    let held = false
    try {
      probe.exec('PRAGMA busy_timeout = 0')
      probe.exec('BEGIN IMMEDIATE')
      transaction = true
    } catch (error) {
      if (!isSqliteBusy(error)) throw error
      held = true
    } finally {
      if (transaction) probe.exec('ROLLBACK')
      probe.close()
    }
    return held
  }

  /** Remove lease files that cannot belong to a concurrently reserving writer. */
  private pruneUnreferencedStageLeasesLocked(database: DatabaseSync, profile: string): void {
    const leaseDir = paths(this.profilesDir, profile).stageLeases
    if (!existsSync(leaseDir)) return
    const referenced = new Set<string>()
    for (const value of database.prepare(
      "SELECT owner_token FROM stage_reservations WHERE status = 'building'",
    ).all()) {
      if (!isRecord(value) || typeof value.owner_token !== 'string' || !GENERATION_ID.test(value.owner_token)) {
        throw new Error('profile transactions: malformed active staging reservation owner')
      }
      referenced.add(value.owner_token)
    }
    for (const entry of readdirSync(leaseDir)) {
      if (!entry.endsWith('.sqlite')) continue
      const ownerToken = entry.slice(0, -'.sqlite'.length)
      if (GENERATION_ID.test(ownerToken) && !referenced.has(ownerToken)) {
        removeDurable(join(leaseDir, entry))
      }
    }
  }

  /** Acquire and persist one new building reservation after validating its held base snapshot. */
  private beginStageBuildLocked(
    database: DatabaseSync,
    request: StoreStageRequest,
    beforeState: PointerState,
    stageOwnerToken: string,
    DatabaseSync: DatabaseSyncConstructor,
    replaced: { readonly generation: string | null; readonly ownerToken: string | null },
    persist: (generation: string, ownerIncarnation: ProcessIncarnation) => void,
  ): StageBuildReservation {
    const basedOn = this.snapshotFromState(beforeState)
    this.assertExpected(basedOn, request.expectedRevision, request.expectedTreeDigest)
    this.assertNoInstallationOwnedDirectBundle(basedOn.effectivePath, request.mutation)
    const generation = randomUUID()
    const ownerIncarnation = currentProcessIncarnation()
    this.pruneUnreferencedStageLeasesLocked(database, request.profile)
    const lease = this.acquireStageLeaseLocked(request.profile, stageOwnerToken, DatabaseSync)
    try {
      persist(generation, ownerIncarnation)
    } catch (error) {
      this.releaseStageLease(lease)
      throw error
    }
    return {
      kind: 'build',
      generation,
      ownerToken: stageOwnerToken,
      basedOn,
      lease,
      replacedGeneration: replaced.generation,
      replacedOwnerToken: replaced.ownerToken,
    }
  }

  /** Reserve one mutation identity in a short SQLite transaction. */
  private reserveStageLocked(
    database: DatabaseSync,
    request: StoreStageRequest,
    beforeState: PointerState,
    stageOwnerToken: string,
    DatabaseSync: DatabaseSyncConstructor,
  ): StageReservationDecision {
    const requestDigest = stageRequestDigest(request)
    const committed = this.readCommitOperationLocked(database, request)
    if (committed !== undefined) return { kind: 'committed', record: committed.record }
    const raw = database.prepare('SELECT * FROM stage_reservations WHERE mutation_id = ?')
      .get(request.mutationId)
    if (raw !== undefined) {
      const reservation = decodeStageReservation(raw)
      if (reservation.requestDigest !== requestDigest) {
        throw new LocalProfileMutationConflictError(request.profile, request.mutationId)
      }
      try {
        const record = this.readCompleteGeneration(request.profile, reservation.generation, true)
        this.assertSameStage(record, request)
        this.assertNoInstallationOwnedDirectBundle(
          generationPaths(this.profilesDir, request.profile, reservation.generation).profile,
          request.mutation,
        )
        if (reservation.status !== 'complete') {
          database.prepare(`UPDATE stage_reservations SET
            status = 'complete', owner_pid = NULL, owner_incarnation = NULL,
            owner_token = NULL, updated_at_ms = ?
            WHERE mutation_id = ? AND generation = ?`).run(
            Date.now(), request.mutationId, reservation.generation,
          )
        }
        return { kind: 'complete', record }
      } catch (error) {
        if (reservation.status === 'complete') throw error
      }
      const ownerPid = reservation.ownerPid
      if (ownerPid !== null && readProcessIncarnation(ownerPid) === reservation.ownerIncarnation
        && reservation.ownerToken !== null
        && this.stageLeaseIsHeld(request.profile, reservation.ownerToken, DatabaseSync)) {
        return { kind: 'in-progress' }
      }

      return this.beginStageBuildLocked(
        database,
        request,
        beforeState,
        stageOwnerToken,
        DatabaseSync,
        { generation: reservation.generation, ownerToken: reservation.ownerToken },
        (generation, ownerIncarnation) => {
          database.prepare(`UPDATE stage_reservations SET
            generation = ?, status = 'building', owner_pid = ?, owner_incarnation = ?,
            owner_token = ?, updated_at_ms = ?
            WHERE mutation_id = ? AND request_digest = ?`).run(
            generation, process.pid, ownerIncarnation, stageOwnerToken, Date.now(), request.mutationId, requestDigest,
          )
        },
      )
    }

    return this.beginStageBuildLocked(
      database,
      request,
      beforeState,
      stageOwnerToken,
      DatabaseSync,
      { generation: null, ownerToken: null },
      (generation, ownerIncarnation) => {
        database.prepare(`INSERT INTO stage_reservations (
          mutation_id, request_digest, generation, status, owner_pid, owner_incarnation, owner_token, updated_at_ms
        ) VALUES (?, ?, ?, 'building', ?, ?, ?, ?)`).run(
          request.mutationId, requestDigest, generation, process.pid, ownerIncarnation, stageOwnerToken, Date.now(),
        )
      },
    )
  }

  /** Atomically mark one exact owner-built generation committable. */
  private finalizeStageLocked(
    database: DatabaseSync,
    request: StoreStageRequest,
    generation: string,
    ownerToken: string,
  ): void {
    const raw = database.prepare('SELECT * FROM stage_reservations WHERE mutation_id = ?')
      .get(request.mutationId)
    if (raw === undefined) throw new LocalProfileMutationConflictError(request.profile, request.mutationId)
    const reservation = decodeStageReservation(raw)
    if (reservation.requestDigest !== stageRequestDigest(request) || reservation.generation !== generation) {
      throw new LocalProfileMutationConflictError(request.profile, request.mutationId)
    }
    const record = this.readCompleteGeneration(request.profile, generation, true)
    this.assertSameStage(record, request)
    if (reservation.status === 'complete') return
    const ownerIncarnation = currentProcessIncarnation()
    if (reservation.ownerPid !== process.pid || reservation.ownerIncarnation !== ownerIncarnation
      || reservation.ownerToken !== ownerToken) {
      throw new LocalProfileMutationConflictError(request.profile, request.mutationId)
    }
    const result = database.prepare(`UPDATE stage_reservations SET
      status = 'complete', owner_pid = NULL, owner_incarnation = NULL, owner_token = NULL, updated_at_ms = ?
      WHERE mutation_id = ? AND generation = ? AND owner_incarnation = ?
        AND owner_token = ? AND status = 'building'`).run(
      Date.now(), request.mutationId, generation, ownerIncarnation, ownerToken,
    )
    if (Number(result.changes) !== 1) {
      throw new LocalProfileMutationConflictError(request.profile, request.mutationId)
    }
  }

  /** Remove a failed owner reservation, preserving a fully written record for replay adoption. */
  private abandonStageLocked(
    database: DatabaseSync,
    request: StoreStageRequest,
    generation: string,
    ownerToken: string,
  ): void {
    const raw = database.prepare('SELECT * FROM stage_reservations WHERE mutation_id = ?')
      .get(request.mutationId)
    if (raw === undefined) return
    const reservation = decodeStageReservation(raw)
    if (reservation.generation !== generation || reservation.status === 'complete'
      || reservation.ownerPid !== process.pid || reservation.ownerIncarnation !== currentProcessIncarnation()
      || reservation.ownerToken !== ownerToken) return
    try {
      const record = this.readCompleteGeneration(request.profile, generation, true)
      this.assertSameStage(record, request)
      this.finalizeStageLocked(database, request, generation, ownerToken)
      return
    } catch (error) {
      if (error instanceof LocalProfileMutationConflictError) throw error
    }
    database.prepare('DELETE FROM stage_reservations WHERE mutation_id = ? AND owner_token = ?')
      .run(request.mutationId, ownerToken)
    removeTree(generationPaths(this.profilesDir, request.profile, generation).root)
  }

  /** Project a replayed or newly completed record into the public staged response. */
  private stagedFromRecord(record: GenerationRecord, request: StoreStageRequest): StoreStagedGeneration {
    this.assertSameStage(record, request)
    return this.projectStagedRecord(record, request)
  }

  /** Project a committed replay without reapplying its original state fences. */
  private stagedFromCommittedRecord(record: GenerationRecord, request: StoreStageRequest): StoreStagedGeneration {
    this.assertSameMutation(record, request)
    return this.projectStagedRecord(record, request)
  }

  private projectStagedRecord(record: GenerationRecord, request: StoreStageRequest): StoreStagedGeneration {
    return {
      profile: request.profile,
      mutationId: request.mutationId,
      generation: record.generation,
      basedOnRevision: record.basedOnRevision,
      basedOnTreeDigest: record.basedOnTreeDigest,
      treeDigest: record.treeDigest,
      mutation: request.mutation,
    }
  }

  /** Require a generation's caller reservation to be fully finalized before pointer publication. */
  private assertFinalizedStageLocked(database: DatabaseSync, record: GenerationRecord): void {
    if (record.mutationId === null) {
      throw new Error('profile transactions: a baseline generation cannot be committed as a mutation')
    }
    const raw = database.prepare('SELECT * FROM stage_reservations WHERE mutation_id = ?')
      .get(record.mutationId)
    if (raw === undefined) throw new Error('profile transactions: generation has no staging reservation')
    const reservation = decodeStageReservation(raw)
    if (reservation.status !== 'complete' || reservation.generation !== record.generation) {
      throw new Error('profile transactions: generation staging reservation is not complete')
    }
  }

  private async applyMutation(
    profile: string,
    candidate: ReturnType<typeof generationPaths>,
    mutation: StoreMutation,
  ): Promise<StoredMutation> {
    const manifestPath = join(candidate.profile, 'package.json')
    const manifest = assertCompleteProfile(candidate.profile)
    const dependencies = Object.assign(
      Object.create(null) as Record<string, string>,
      parseDependencies(manifest, `Profile manifest ${manifestPath}`),
    )
    const bundles = parseBundles(manifest, `Profile manifest ${manifestPath}`)
    const exists = Object.hasOwn(dependencies, mutation.packageName)
    if (mutation.operation === 'install' && exists) {
      throw new Error(`profile transactions: install requires absent package ${mutation.packageName}`)
    }
    if ((mutation.operation === 'update' || mutation.operation === 'uninstall' || mutation.operation === 'configure') && !exists) {
      throw new Error(`profile transactions: ${mutation.operation} requires installed package ${mutation.packageName}`)
    }

    const destination = packagePath(candidate.profile, mutation.packageName)
    const artifactRelative = join(ARTIFACTS_DIR, artifactFilename(mutation.packageName))
    const artifactPath = join(candidate.profile, artifactRelative)
    if (mutation.operation === 'configure') {
      const patchPath = join(candidate.profile, PROFILE_PATCH)
      const current = hashFile(patchPath).digest
      if (current !== mutation.patch.expectedDigest) {
        throw new LocalProfileContentConflictError(profile, mutation.patch.expectedDigest, current)
      }
      writeFileSync(patchPath, mutation.patch.nextUtf8, 'utf8')
      return mutation
    }
    if (mutation.operation === 'uninstall') {
      removeTree(destination)
      removeTree(artifactPath)
      Reflect.deleteProperty(dependencies, mutation.packageName)
      const filtered = bundles.filter(bundle => bundle !== mutation.packageName)
      updateLockfile(candidate.profile, { mutation, artifact: null })
      this.writeManagedManifest(manifestPath, manifest, dependencies, filtered)
      return { operation: 'uninstall', packageName: mutation.packageName }
    }

    mkdirSync(dirname(artifactPath), { recursive: true, mode: 0o700 })
    removeTree(artifactPath)
    const copied = await this.copyArtifact(mutation.artifact.path, artifactPath)
    if (copied.digest !== mutation.artifact.digest) {
      throw new Error(`profile transactions: artifact digest mismatch (expected ${mutation.artifact.digest}, received ${copied.digest})`)
    }
    const extracted = join(candidate.root, `.extract-${randomUUID()}`)
    let packageManifest: ProfileManifestDocument
    try {
      packageManifest = await extractArchive(
        artifactPath,
        extracted,
        mutation,
        path => this.hooks.afterArchivePreflight?.(path),
      )
      removeTree(destination)
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      renameSync(extracted, destination)
    } finally {
      removeTree(extracted)
    }
    dependencies[mutation.packageName] = mutation.version
    const nextBundles = mutation.kind === 'bundle'
      ? bundles.includes(mutation.packageName) ? bundles : [...bundles, mutation.packageName]
      : bundles.filter(bundle => bundle !== mutation.packageName)
    const artifactPortable = artifactRelative.split(sep).join('/')
    updateLockfile(candidate.profile, {
      mutation,
      artifact: {
        relative: artifactPortable,
        integrity: copied.integrity,
        manifest: packageManifest,
      },
    })
    this.writeManagedManifest(manifestPath, manifest, dependencies, nextBundles)
    return {
      operation: mutation.operation,
      kind: mutation.kind,
      packageName: mutation.packageName,
      version: mutation.version,
      digest: copied.digest,
      integrity: copied.integrity,
      artifactFile: artifactPortable,
      bytes: copied.bytes,
    }
  }

  private writeManagedManifest(
    path: string,
    manifest: ProfileManifestDocument,
    dependencies: Record<string, string>,
    bundles: string[],
  ): void {
    const dsh = manifest.dsh as Record<string, unknown>
    const profile = dsh.profile as Record<string, unknown>
    writeFileSync(path, `${JSON.stringify({
      ...manifest,
      dependencies,
      dsh: { ...dsh, profile: { ...profile, bundles } },
    }, null, 2)}\n`, 'utf8')
  }

  private captureBaseline(profile: string, before: StoreSnapshot): string {
    const generation = randomUUID()
    const target = generationPaths(this.profilesDir, profile, generation)
    mkdirSync(target.root, { recursive: false, mode: 0o700 })
    try {
      copyProfileTree(before.effectivePath, target.profile)
      assertCompleteProfile(target.profile)
      const treeDigest = digestProfileTree(target.profile)
      if (treeDigest !== before.treeDigest) {
        throw new LocalProfileTreeConflictError(profile, before.treeDigest, treeDigest)
      }
      const record: GenerationRecord = {
        formatVersion: FORMAT_VERSION,
        profile,
        generation,
        mutationId: null,
        source: 'baseline',
        basedOnRevision: before.revision,
        basedOnGeneration: null,
        basedOnTreeDigest: before.treeDigest,
        treeDigest,
        mutation: null,
      }
      syncGenerationTree(target.profile)
      writeJsonDurable(target.record, record)
      syncDirectory(dirname(target.root))
      this.hooks.afterGenerationPersisted?.()
      return generation
    } catch (error) {
      removeTree(target.root)
      throw error
    }
  }

  private removeUnreferencedGeneration(profile: string, generation: string): void {
    const profilePaths = paths(this.profilesDir, profile)
    const journalValue = readJson(profilePaths.journal)
    const journal = journalValue === undefined ? null : parseJournal(journalValue, profile)
    if (journal !== null && (pointerReferencesGeneration(journal.before, generation)
      || pointerReferencesGeneration(journal.after, generation))) return
    if (pointerReferencesGeneration(this.readState(profile), generation)) return
    const generationRoot = generationPaths(this.profilesDir, profile, generation).root
    if (removeTree(generationRoot)) syncDirectory(dirname(generationRoot))
  }

  private assertExpected(snapshot: StoreSnapshot, revision: number, treeDigest: string): void {
    if (snapshot.revision !== revision) {
      throw new LocalProfileRevisionConflictError(snapshot.profile, revision, snapshot.revision)
    }
    if (snapshot.treeDigest !== treeDigest) {
      throw new LocalProfileTreeConflictError(snapshot.profile, treeDigest, snapshot.treeDigest)
    }
  }

  private initialState(profile: string): PointerState {
    return {
      profile,
      revision: 0,
      activeGeneration: null,
      lastGoodGeneration: null,
      rollbackGeneration: null,
    }
  }

  private readState(profile: string): PointerState {
    const value = readJson(paths(this.profilesDir, profile).state)
    return value === undefined ? this.initialState(profile) : parseState(value, profile)
  }

  private readProjectedState(profile: string): PointerState {
    const state = this.readState(profile)
    const journalValue = readJson(paths(this.profilesDir, profile).journal)
    if (journalValue === undefined) return state
    const journal = parseJournal(journalValue, profile)
    this.assertJournalEvidence(journal)
    if (samePointer(state, journal.before) || samePointer(state, journal.after)) return journal.after
    throw new Error('profile transactions: journal does not continue from the authoritative state')
  }

  /** Validate the immutable evidence that makes a parsed pointer transition possible. */
  private assertJournalEvidence(journal: JournalRecord, database?: DatabaseSync): GenerationRecord | null {
    if (journal.kind === 'acknowledge-boot') return null
    const mutationId = journal.mutationId as string
    const requestDigest = journal.requestDigest as string
    if (journal.kind === 'restore') {
      if (database?.prepare('SELECT 1 FROM stage_reservations WHERE mutation_id = ?').get(mutationId) !== undefined) {
        throw new Error('profile transactions: restore journal collides with a staging reservation')
      }
      const before = this.snapshotFromState(journal.before)
      const expectedDigest = restoreRequestDigest({
        profile: journal.profile,
        expectedRevision: journal.before.revision,
        expectedTreeDigest: before.treeDigest,
      })
      if (requestDigest !== expectedDigest) {
        throw new Error('profile transactions: restore journal request digest does not match its before state')
      }
      return null
    }
    const generation = journal.after.activeGeneration as string
    const record = this.readCompleteGeneration(journal.profile, generation, true)
    this.assertCommitOperationRecord(record, journal.before, journal.after)
    if (record.mutationId !== mutationId || this.recordMutationSemanticDigest(record) !== requestDigest) {
      throw new Error('profile transactions: commit journal does not match its generation mutation')
    }
    if (database !== undefined) this.assertFinalizedStageLocked(database, record)
    return record
  }

  private recoverLocked(profile: string, database: DatabaseSync): RecoveredPointerState {
    const profilePaths = paths(this.profilesDir, profile)
    const state = this.readState(profile)
    const journalValue = readJson(profilePaths.journal)
    if (journalValue === undefined) {
      this.assertPointerComplete(state)
      return { state, journalOperation: null }
    }
    const journal = parseJournal(journalValue, profile)
    const commitRecord = this.assertJournalEvidence(journal, database)
    let recovered: PointerState
    if (samePointer(state, journal.before)) {
      this.assertPointerComplete(journal.after)
      writeJsonDurable(profilePaths.state, stateDocument(journal.after))
      recovered = journal.after
    } else if (samePointer(state, journal.after)) {
      recovered = journal.after
    } else {
      throw new Error('profile transactions: journal does not continue from the authoritative state')
    }
    if (journal.kind !== 'acknowledge-boot') {
      const mutationId = journal.mutationId as string
      const requestDigest = journal.requestDigest as string
      if (journal.kind === 'restore') {
        this.recordRestoreOperationLocked(database, mutationId, requestDigest, journal.before, journal.after)
      } else {
        this.recordCommitOperationLocked(
          database,
          commitRecord as GenerationRecord,
          requestDigest,
          journal.before,
          journal.after,
        )
      }
    }
    return { state: recovered, journalOperation: journal.operation }
  }

  /** Remove only a journal whose state and any correlated receipt are already durable. */
  private async cleanupCommittedJournal(profile: string, expectedOperation?: string): Promise<void> {
    await this.withWriterLock(profile, (database) => {
      const profilePaths = paths(this.profilesDir, profile)
      const value = readJson(profilePaths.journal)
      if (value === undefined) return
      const journal = parseJournal(value, profile)
      if (expectedOperation !== undefined && journal.operation !== expectedOperation) return
      const state = this.readState(profile)
      if (!samePointer(state, journal.after)) {
        throw new Error('profile transactions: journal cleanup state is not durably published')
      }
      if (journal.kind !== 'acknowledge-boot') {
        const mutationId = journal.mutationId as string
        const requestDigest = journal.requestDigest as string
        const stored = database.prepare(
          'SELECT kind, request_digest, receipt_json FROM pointer_operations WHERE mutation_id = ?',
        ).get(mutationId)
        const receiptJson = JSON.stringify({ before: journal.before, after: journal.after } satisfies PointerOperationReceiptDocument)
        if (!isRecord(stored) || stored['kind'] !== journal.kind
          || stored['request_digest'] !== requestDigest || stored['receipt_json'] !== receiptJson) {
          throw new Error(`profile transactions: ${journal.kind} journal has no durable operation receipt`)
        }
      }
      removeDurable(profilePaths.journal)
    })
  }

  /** Read and structurally verify one durable pointer-operation receipt. */
  private readPointerOperationLocked(
    database: DatabaseSync,
    profile: string,
    mutationId: string,
  ): StoredPointerOperation | undefined {
    const value = database.prepare('SELECT kind, request_digest, receipt_json FROM pointer_operations WHERE mutation_id = ?')
      .get(mutationId)
    if (value === undefined) return undefined
    if (!isRecord(value) || (value['kind'] !== 'commit' && value['kind'] !== 'restore')
      || typeof value['request_digest'] !== 'string' || !SHA256_DIGEST.test(value['request_digest'])
      || typeof value['receipt_json'] !== 'string') {
      throw new Error('profile transactions: malformed pointer operation receipt')
    }
    let document: unknown
    try {
      document = JSON.parse(value['receipt_json']) as unknown
    } catch (error) {
      throw new Error('profile transactions: malformed pointer operation receipt JSON', { cause: error })
    }
    if (!isRecord(document) || !hasExactOwnKeys(document, ['before', 'after'])) {
      throw new Error('profile transactions: malformed pointer operation receipt document')
    }
    const before = parsePointer(document['before'], profile, `${value['kind']} receipt before`)
    const after = parsePointer(document['after'], profile, `${value['kind']} receipt after`)
    const operation: StoredPointerOperation = {
      kind: value['kind'],
      requestDigest: value['request_digest'],
      before,
      after,
    }
    const receiptJournal: JournalRecord = {
      formatVersion: FORMAT_VERSION,
      operation: randomUUID(),
      kind: operation.kind,
      mutationId,
      requestDigest: operation.requestDigest,
      profile,
      before,
      after,
    }
    assertJournalTransition(receiptJournal)
    return operation
  }

  /** Insert one exact pointer receipt or require an existing row to match it byte-for-byte. */
  private recordPointerOperationLocked(
    database: DatabaseSync,
    kind: StoredPointerOperation['kind'],
    mutationId: string,
    requestDigest: string,
    before: PointerState,
    after: PointerState,
  ): void {
    const receiptJson = JSON.stringify({ before, after } satisfies PointerOperationReceiptDocument)
    database.prepare(`INSERT OR IGNORE INTO pointer_operations (
      mutation_id, kind, request_digest, receipt_json, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?)`).run(mutationId, kind, requestDigest, receiptJson, Date.now())
    const stored = database.prepare('SELECT kind, request_digest, receipt_json FROM pointer_operations WHERE mutation_id = ?')
      .get(mutationId)
    if (!isRecord(stored) || stored['kind'] !== kind
      || stored['request_digest'] !== requestDigest || stored['receipt_json'] !== receiptJson) {
      throw new LocalProfileMutationConflictError(before.profile, mutationId)
    }
  }

  /** Return a durably completed restore replay for the caller-owned identity. */
  private readRestoreOperationLocked(
    database: DatabaseSync,
    request: { readonly profile: string; readonly mutationId: string },
  ): { operation: 'restore'; before: StoreSnapshot; after: StoreSnapshot; restartRequired: true } | undefined {
    const operation = this.readPointerOperationLocked(database, request.profile, request.mutationId)
    if (operation === undefined) return undefined
    if (operation.kind !== 'restore') {
      throw new LocalProfileMutationConflictError(request.profile, request.mutationId)
    }
    this.assertJournalEvidence({
      formatVersion: FORMAT_VERSION,
      operation: randomUUID(),
      kind: 'restore',
      mutationId: request.mutationId,
      requestDigest: operation.requestDigest,
      profile: request.profile,
      before: operation.before,
      after: operation.after,
    }, database)
    return this.restoreReceipt(operation.before, operation.after)
  }

  /** Bind one restore mutation identity to its exact durable pointer transition. */
  private recordRestoreOperationLocked(
    database: DatabaseSync,
    mutationId: string,
    requestDigest: string,
    before: PointerState,
    after: PointerState,
  ): void {
    if (database.prepare('SELECT 1 FROM stage_reservations WHERE mutation_id = ?').get(mutationId) !== undefined) {
      throw new LocalProfileMutationConflictError(before.profile, mutationId)
    }
    this.recordPointerOperationLocked(database, 'restore', mutationId, requestDigest, before, after)
  }

  /** Require a commit transition to name the generation and base recorded by its stage. */
  private assertCommitOperationRecord(
    record: GenerationRecord,
    before: PointerState,
    after: PointerState,
  ): void {
    if (record.source !== 'mutation' || record.mutationId === null || record.mutation === null
      || record.generation !== after.activeGeneration
      || record.basedOnRevision !== before.revision
      || record.basedOnGeneration !== before.activeGeneration) {
      throw new Error('profile transactions: commit receipt does not match its generation record')
    }
    const evidenceGeneration = before.activeGeneration ?? after.lastGoodGeneration
    if (evidenceGeneration === null) {
      throw new Error('profile transactions: commit receipt has no immutable base evidence')
    }
    const evidence = this.readCompleteGeneration(record.profile, evidenceGeneration, true)
    if ((before.activeGeneration === null && evidence.source !== 'baseline')
      || record.basedOnTreeDigest !== evidence.treeDigest) {
      throw new Error('profile transactions: commit receipt base digest does not match immutable evidence')
    }
  }

  /** Stable semantic digest recovered from one complete generation record. */
  private recordMutationSemanticDigest(record: GenerationRecord): string {
    const mutation = this.generationSummary(record).mutation
    if (mutation === null) throw new Error('profile transactions: baseline generation has no mutation identity')
    return mutationSemanticDigest({ profile: record.profile, mutation })
  }

  /** Bind one committed generation to its exact durable pointer transition. */
  private recordCommitOperationLocked(
    database: DatabaseSync,
    record: GenerationRecord,
    requestDigest: string,
    before: PointerState,
    after: PointerState,
  ): void {
    this.assertFinalizedStageLocked(database, record)
    this.assertCommitOperationRecord(record, before, after)
    if (this.recordMutationSemanticDigest(record) !== requestDigest) {
      throw new Error('profile transactions: commit request digest does not match its generation mutation')
    }
    this.recordPointerOperationLocked(database, 'commit', record.mutationId as string, requestDigest, before, after)
  }

  /** Read a completed commit while revalidating the caller's immutable mutation semantics. */
  private readCommitOperationLocked(
    database: DatabaseSync,
    request: StoreStageRequest,
  ): { readonly record: GenerationRecord; readonly operation: StoredPointerOperation } | undefined {
    const operation = this.readPointerOperationLocked(database, request.profile, request.mutationId)
    if (operation === undefined) return undefined
    if (operation.kind !== 'commit' || operation.requestDigest !== mutationSemanticDigest(request)
      || operation.after.activeGeneration === null) {
      throw new LocalProfileMutationConflictError(request.profile, request.mutationId)
    }
    this.assertJournalEvidence({
      formatVersion: FORMAT_VERSION,
      operation: randomUUID(),
      kind: 'commit',
      mutationId: request.mutationId,
      requestDigest: operation.requestDigest,
      profile: request.profile,
      before: operation.before,
      after: operation.after,
    }, database)
    const record = this.readCompleteGeneration(request.profile, operation.after.activeGeneration, true)
    this.assertCommitOperationRecord(record, operation.before, operation.after)
    this.assertSameMutation(record, request)
    this.assertNoInstallationOwnedDirectBundle(
      generationPaths(this.profilesDir, request.profile, record.generation).profile,
      request.mutation,
    )
    return { record, operation }
  }

  /** Read a completed commit by its staged generation for commit-call replay. */
  private readCommitOperationForRecordLocked(
    database: DatabaseSync,
    record: GenerationRecord,
  ): { operation: 'commit'; before: StoreSnapshot; after: StoreSnapshot; restartRequired: true } | undefined {
    if (record.mutationId === null) return undefined
    const operation = this.readPointerOperationLocked(database, record.profile, record.mutationId)
    if (operation === undefined) return undefined
    if (operation.kind !== 'commit' || operation.requestDigest !== this.recordMutationSemanticDigest(record)) {
      throw new LocalProfileMutationConflictError(record.profile, record.mutationId)
    }
    this.assertJournalEvidence({
      formatVersion: FORMAT_VERSION,
      operation: randomUUID(),
      kind: 'commit',
      mutationId: record.mutationId,
      requestDigest: operation.requestDigest,
      profile: record.profile,
      before: operation.before,
      after: operation.after,
    }, database)
    this.assertCommitOperationRecord(record, operation.before, operation.after)
    return this.commitReceipt(record, operation.before, operation.after)
  }

  /** Whether a durable mutation receipt still owns a generation needed for exact replay. */
  private pointerOperationsReferenceGenerationLocked(
    database: DatabaseSync,
    profile: string,
    generation: string,
  ): boolean {
    const rows = database.prepare('SELECT mutation_id FROM pointer_operations ORDER BY mutation_id').all()
    for (const row of rows) {
      if (!isRecord(row) || typeof row['mutation_id'] !== 'string') {
        throw new Error('profile transactions: malformed pointer operation identity')
      }
      const operation = this.readPointerOperationLocked(database, profile, row['mutation_id'])
      if (operation !== undefined && (pointerReferencesGeneration(operation.before, generation)
        || pointerReferencesGeneration(operation.after, generation))) return true
    }
    return false
  }

  private commitReceipt(
    record: GenerationRecord,
    before: PointerState,
    after: PointerState,
  ): { operation: 'commit'; before: StoreSnapshot; after: StoreSnapshot; restartRequired: true } {
    return {
      operation: 'commit',
      before: this.snapshotFromStateAtDigest(before, record.basedOnTreeDigest),
      after: this.snapshotFromStateAtDigest(after, record.treeDigest),
      restartRequired: true,
    }
  }

  private restoreReceipt(
    before: PointerState,
    after: PointerState,
  ): { operation: 'restore'; before: StoreSnapshot; after: StoreSnapshot; restartRequired: true } {
    return {
      operation: 'restore',
      before: this.snapshotFromState(before),
      after: this.snapshotFromState(after),
      restartRequired: true,
    }
  }

  private snapshotFromState(state: PointerState): StoreSnapshot {
    this.assertPointerComplete(state)
    const effectivePath = state.activeGeneration === null
      ? paths(this.profilesDir, state.profile).profileDir
      : generationPaths(this.profilesDir, state.profile, state.activeGeneration).profile
    return this.snapshotFromStateAtDigest(state, digestProfileTree(effectivePath))
  }

  /** Project a pointer with a digest already bound by an immutable generation record. */
  private snapshotFromStateAtDigest(state: PointerState, treeDigest: string): StoreSnapshot {
    this.assertPointerComplete(state)
    const effectivePath = state.activeGeneration === null
      ? paths(this.profilesDir, state.profile).profileDir
      : generationPaths(this.profilesDir, state.profile, state.activeGeneration).profile
    return {
      ...state,
      effectivePath,
      treeDigest,
      bootStatus: state.activeGeneration === null
        ? 'live'
        : state.activeGeneration === state.lastGoodGeneration ? 'verified' : 'pending-restart',
    }
  }

  private assertPointerComplete(state: PointerState): void {
    for (const generation of [state.activeGeneration, state.lastGoodGeneration, state.rollbackGeneration]) {
      if (generation !== null) this.readCompleteGeneration(state.profile, generation, true)
    }
  }

  private parseStoredMutation(value: unknown, profilePath: string): StoredMutation {
    if (!isRecord(value) || typeof value.operation !== 'string' || typeof value.packageName !== 'string') {
      throw new Error('profile transactions: malformed generation mutation metadata')
    }
    assertPackageName(value.packageName)
    if (value.operation === 'uninstall') {
      if (!hasExactOwnKeys(value, ['operation', 'packageName'])) {
        throw new Error('profile transactions: malformed uninstall mutation metadata')
      }
      return { operation: 'uninstall', packageName: value.packageName }
    }
    if (value.operation === 'configure') {
      if (!hasExactOwnKeys(value, ['operation', 'packageName', 'patch'])
        || !isRecord(value.patch)
        || !hasExactOwnKeys(value.patch, ['expectedDigest', 'nextUtf8', 'nextDigest'])
        || typeof value.patch.expectedDigest !== 'string'
        || typeof value.patch.nextUtf8 !== 'string' || typeof value.patch.nextDigest !== 'string') {
        throw new Error('profile transactions: malformed configure mutation metadata')
      }
      const mutation: StoreConfigureMutation = {
        operation: 'configure',
        packageName: value.packageName,
        patch: {
          expectedDigest: value.patch.expectedDigest,
          nextUtf8: value.patch.nextUtf8,
          nextDigest: value.patch.nextDigest,
        },
      }
      assertMutation(mutation)
      return mutation
    }
    if (!hasExactOwnKeys(value, [
      'operation', 'kind', 'packageName', 'version', 'digest', 'integrity', 'artifactFile', 'bytes',
    ]) || (value.operation !== 'install' && value.operation !== 'update')
      || (value.kind !== 'package' && value.kind !== 'bundle') || typeof value.version !== 'string'
      || typeof value.digest !== 'string' || typeof value.integrity !== 'string' || typeof value.artifactFile !== 'string'
      || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) {
      throw new Error('profile transactions: malformed artifact mutation metadata')
    }
    assertExactVersion(value.version)
    assertDigest(value.digest, 'stored artifact digest')
    if (!value.integrity.startsWith('sha512-')) throw new Error('profile transactions: malformed stored artifact integrity')
    const artifactPath = resolve(profilePath, value.artifactFile)
    if (!isWithin(profilePath, artifactPath) || !lstatSync(artifactPath).isFile()) {
      throw new Error('profile transactions: stored artifact path is absent or escapes its generation')
    }
    const artifact = hashFile(artifactPath)
    if (artifact.digest !== value.digest || artifact.bytes !== value.bytes) {
      throw new Error('profile transactions: stored artifact no longer matches its digest')
    }
    return {
      operation: value.operation,
      kind: value.kind,
      packageName: value.packageName,
      version: value.version,
      digest: value.digest,
      integrity: value.integrity,
      artifactFile: value.artifactFile,
      bytes: value.bytes,
    }
  }

  private readCompleteGeneration(profile: string, generation: string, verifyTree: boolean): GenerationRecord {
    assertGenerationId(generation)
    const generationPath = generationPaths(this.profilesDir, profile, generation)
    const value = readJson(generationPath.record)
    if (!isRecord(value) || !hasExactOwnKeys(value, [
      'formatVersion', 'profile', 'generation', 'mutationId', 'source', 'basedOnRevision',
      'basedOnGeneration', 'basedOnTreeDigest', 'treeDigest', 'mutation',
    ]) || value.formatVersion !== FORMAT_VERSION || value.profile !== profile
      || value.generation !== generation || (value.source !== 'baseline' && value.source !== 'mutation')
      || (value.mutationId !== null
        && (typeof value.mutationId !== 'string' || !PROFILE_MUTATION_ID.test(value.mutationId)))
      || !Number.isSafeInteger(value.basedOnRevision) || (value.basedOnRevision as number) < 0
      || typeof value.basedOnTreeDigest !== 'string' || typeof value.treeDigest !== 'string'
      || (value.basedOnGeneration !== null
        && (typeof value.basedOnGeneration !== 'string' || !GENERATION_ID.test(value.basedOnGeneration)))) {
      throw new Error(`profile transactions: generation ${generation} is absent, incomplete, or malformed`)
    }
    assertDigest(value.basedOnTreeDigest, 'generation base tree digest')
    assertDigest(value.treeDigest, 'generation tree digest')
    assertCompleteProfile(generationPath.profile)
    const mutation = value.mutation === null ? null : this.parseStoredMutation(value.mutation, generationPath.profile)
    if ((value.source === 'baseline') !== (mutation === null)
      || (value.source === 'baseline') !== (value.mutationId === null)) {
      throw new Error(`profile transactions: generation ${generation} source and mutation disagree`)
    }
    if (verifyTree) {
      const actual = digestProfileTree(generationPath.profile)
      if (actual !== value.treeDigest) {
        throw new Error(`profile transactions: generation ${generation} tree no longer matches its digest`)
      }
    }
    return {
      formatVersion: FORMAT_VERSION,
      profile,
      generation,
      mutationId: value.mutationId,
      source: value.source,
      basedOnRevision: value.basedOnRevision as number,
      basedOnGeneration: value.basedOnGeneration,
      basedOnTreeDigest: value.basedOnTreeDigest,
      treeDigest: value.treeDigest,
      mutation,
    }
  }

  /** Require one caller-key replay to preserve its complete immutable stage input. */
  private assertSameStage(record: GenerationRecord, request: StoreStageRequest): void {
    this.assertSameMutation(record, request)
    if (record.basedOnRevision !== request.expectedRevision
      || record.basedOnTreeDigest !== request.expectedTreeDigest
    ) {
      throw new LocalProfileMutationConflictError(request.profile, request.mutationId)
    }
  }

  /** Require one completed replay to preserve the caller key and immutable mutation semantics. */
  private assertSameMutation(record: GenerationRecord, request: StoreStageRequest): void {
    if (record.source !== 'mutation' || record.mutation === null
      || record.mutationId !== request.mutationId
      || !sameStoredMutation(record.mutation, request.mutation)) {
      throw new LocalProfileMutationConflictError(request.profile, request.mutationId)
    }
  }

  private generationSummary(record: GenerationRecord): StoreGenerationSummary {
    let mutation: StoreMutation | null = null
    if (record.mutation?.operation === 'uninstall' || record.mutation?.operation === 'configure') {
      mutation = record.mutation
    } else if (record.mutation !== null) {
      const profilePath = generationPaths(this.profilesDir, record.profile, record.generation).profile
      mutation = {
        operation: record.mutation.operation,
        kind: record.mutation.kind,
        packageName: record.mutation.packageName,
        version: record.mutation.version,
        artifact: {
          path: join(profilePath, record.mutation.artifactFile),
          digest: record.mutation.digest,
        },
      }
    }
    return {
      generation: record.generation,
      treeDigest: record.treeDigest,
      mutationId: record.mutationId,
      mutation,
    }
  }

  private publishJournaled(
    kind: JournalRecord['kind'],
    before: PointerState,
    after: PointerState,
    options: { readonly mutationId?: string; readonly requestDigest?: string; readonly retainJournal?: boolean } = {},
  ): void {
    this.assertPointerComplete(after)
    const profilePaths = paths(this.profilesDir, before.profile)
    const journal: JournalRecord = {
      formatVersion: FORMAT_VERSION,
      operation: randomUUID(),
      kind,
      mutationId: options.mutationId ?? null,
      requestDigest: options.requestDigest ?? null,
      profile: before.profile,
      before,
      after,
    }
    assertJournalTransition(journal)
    writeJsonDurable(profilePaths.journal, journal)
    this.hooks.afterJournalPersisted?.()
    writeJsonDurable(profilePaths.state, stateDocument(after))
    this.hooks.afterStatePersisted?.()
    if (options.retainJournal !== true) removeDurable(profilePaths.journal)
  }

  private async copyArtifact(
    sourcePath: string,
    targetPath: string,
  ): Promise<{ digest: string; integrity: string; bytes: number }> {
    const portableConstants: Partial<typeof constants> = constants
    const noFollow = portableConstants.O_NOFOLLOW ?? 0
    const source = await open(resolve(sourcePath), constants.O_RDONLY | noFollow)
    try {
      const info = await source.stat()
      if (!info.isFile()) throw new TypeError(`profile transactions: artifact ${JSON.stringify(sourcePath)} must be a regular file`)
      if (info.size > MAX_ARCHIVE_COMPRESSED_BYTES) {
        throw new TypeError(`profile transactions: compressed artifact exceeds ${String(MAX_ARCHIVE_COMPRESSED_BYTES)} bytes`)
      }
      const target = await open(targetPath, 'wx', 0o600)
      try {
        const hash = createHash('sha256')
        const integrity = createHash('sha512')
        const buffer = Buffer.allocUnsafe(1024 * 1024)
        let position = 0
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
          if (bytesRead === 0) break
          if (position + bytesRead > MAX_ARCHIVE_COMPRESSED_BYTES) {
            throw new TypeError(`profile transactions: compressed artifact exceeds ${String(MAX_ARCHIVE_COMPRESSED_BYTES)} bytes`)
          }
          hash.update(buffer.subarray(0, bytesRead))
          integrity.update(buffer.subarray(0, bytesRead))
          let written = 0
          while (written < bytesRead) {
            const result = await target.write(buffer, written, bytesRead - written, null)
            written += result.bytesWritten
          }
          position += bytesRead
        }
        await target.sync()
        return {
          digest: `sha256:${hash.digest('hex')}`,
          integrity: `sha512-${integrity.digest('base64')}`,
          bytes: position,
        }
      } finally {
        await target.close()
      }
    } finally {
      await source.close()
    }
  }

  private async withWriterLock<T>(
    profile: string,
    operation: (database: DatabaseSync, DatabaseSync: DatabaseSyncConstructor) => T,
  ): Promise<T> {
    const profilePaths = paths(this.profilesDir, profile)
    mkdirDurable(profilePaths.generations)
    const DatabaseSync = await loadDatabaseConstructor()
    const database = new DatabaseSync(profilePaths.coordinator)
    let transaction = false
    try {
      database.exec(`PRAGMA busy_timeout = ${String(this.lockWaitMs)}`)
      database.exec('PRAGMA journal_mode = DELETE')
      database.exec('PRAGMA synchronous = FULL')
      database.exec('BEGIN IMMEDIATE')
      transaction = true
      initializeCoordinator(database)
      const result = operation(database, DatabaseSync)
      database.exec('COMMIT')
      transaction = false
      return result
    } catch (error) {
      if (transaction) database.exec('ROLLBACK')
      throw error
    } finally {
      database.close()
    }
  }

  /** Recover pointer state and remove its journal only after the coordinator commit succeeds. */
  private async withRecoveredWriterLock<T>(
    profile: string,
    operation: (
      database: DatabaseSync,
      state: PointerState,
      DatabaseSync: DatabaseSyncConstructor,
    ) => T,
  ): Promise<T> {
    for (;;) {
      const outcome = await this.withWriterLock(profile, (database, DatabaseSync) => {
        const recovered = this.recoverLocked(profile, database)
        if (recovered.journalOperation !== null) {
          return { kind: 'recovered' as const, journalOperation: recovered.journalOperation }
        }
        const result = operation(database, recovered.state, DatabaseSync)
        const journalValue = readJson(paths(this.profilesDir, profile).journal)
        const journalOperation = journalValue === undefined
          ? null
          : parseJournal(journalValue, profile).operation
        return { kind: 'result' as const, result, journalOperation }
      })
      if (outcome.kind === 'recovered') {
        await this.cleanupCommittedJournal(profile, outcome.journalOperation)
        continue
      }
      if (outcome.journalOperation !== null) {
        await this.cleanupCommittedJournal(profile, outcome.journalOperation)
      }
      return outcome.result
    }
  }
}
