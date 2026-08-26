import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Repository-relative path of the complete source/runtime build record. */
export const REPOSITORY_BUILD_RECORD_PATH = '.dsh-build/repository-build.json'

const REPOSITORY_BUILD_RECORD_FORMAT = 2

/** Deterministic digest of one named file set. */
export interface RepositoryFileDigest {
  /** Number of files covered by the digest. */
  readonly fileCount: number
  /** Lowercase SHA-256 digest of sorted paths, file kinds, modes, and contents. */
  readonly sha256: string
}

/** Content and filesystem-identity observation of one repository source set. */
export interface RepositorySourceDigest extends RepositoryFileDigest {
  /** SHA-256 digest of source kinds, identities, timestamps, modes, sizes, and link targets. */
  readonly identitySha256: string
}

/** Durable description of one complete root build. */
export interface RepositoryBuildRecord {
  /** Record schema version. */
  readonly formatVersion: number
  /** Matching source observation taken at both endpoints of the complete build. */
  readonly source: RepositorySourceDigest
  /** Exact Host-side application, package, and vendored `lib` artifacts observed after the build. */
  readonly runtimeArtifacts: RepositoryFileDigest
}

interface RuntimeArtifact {
  readonly absolute: string
  readonly path: string
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function digestEntry(hash: ReturnType<typeof createHash>, path: string, kind: string, mode: number, content: Buffer): void {
  hash.update(`${Buffer.byteLength(path)}:${path}`)
  hash.update(`${kind}:${String(mode & 0o111)}:${content.byteLength}:`)
  hash.update(content)
}

function digestField(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const content = typeof value === 'string' ? Buffer.from(value) : value
  hash.update(`${String(content.byteLength)}:`)
  hash.update(content)
}

function digestIdentityEntry(
  hash: ReturnType<typeof createHash>,
  path: string,
  kind: string,
  info: BigIntStats | undefined,
  linkTarget: Buffer,
): void {
  digestField(hash, path)
  digestField(hash, kind)
  digestField(hash, info === undefined ? '0' : String(info.dev))
  digestField(hash, info === undefined ? '0' : String(info.ino))
  digestField(hash, info === undefined ? '0' : String(info.size))
  digestField(hash, info === undefined ? '0' : String(info.mtimeNs))
  digestField(hash, info === undefined ? '0' : String(info.ctimeNs))
  digestField(hash, info === undefined ? '0' : String(info.mode))
  digestField(hash, linkTarget)
}

function errnoIs(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function sourcePaths(root: string): string[] {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return output.toString('utf8').split('\0').filter(path => path.length > 0).sort(compareCodeUnits)
}

function repositoryPath(root: string, absolute: string): string {
  const path = relative(root, absolute)
  return sep === '\\' ? path.replaceAll('\\', '/') : path
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function assertListedSourceTree(
  root: string,
  target: string,
  sourcePathSet: ReadonlySet<string>,
  visitedDirectories: Set<string>,
): void {
  const canonical = realpathSync(target)
  if (!isWithin(root, canonical)) {
    throw new Error(`repository source symlink resolves outside the repository: ${repositoryPath(root, target)}`)
  }
  const targetInfo = statSync(canonical)
  if (targetInfo.isFile()) {
    const path = repositoryPath(root, canonical)
    if (!sourcePathSet.has(path)) throw new Error(`repository source symlink resolves to unlisted source entry: ${path}`)
    return
  }
  if (!targetInfo.isDirectory()) {
    throw new Error(`repository source symlink resolves to an unsupported entry: ${repositoryPath(root, canonical)}`)
  }
  if (visitedDirectories.has(canonical)) return
  visitedDirectories.add(canonical)
  for (const entry of readdirSync(canonical, { withFileTypes: true })) {
    const absolute = join(canonical, entry.name)
    const info = lstatSync(absolute)
    if (info.isDirectory()) {
      assertListedSourceTree(root, absolute, sourcePathSet, visitedDirectories)
      continue
    }
    const path = repositoryPath(root, absolute)
    if (!sourcePathSet.has(path)) throw new Error(`repository source symlink reaches unlisted source entry: ${path}`)
    if (info.isSymbolicLink()) {
      assertListedSourceTree(root, absolute, sourcePathSet, visitedDirectories)
      continue
    }
    if (!info.isFile()) throw new Error(`repository source symlink reaches an unsupported entry: ${path}`)
  }
}

/**
 * Digest every tracked and non-ignored source entry in one Git checkout.
 * @param root - repository root.
 * @returns exact source-file count and digest.
 */
export function repositorySourceDigest(root: string): RepositorySourceDigest {
  const paths = sourcePaths(root)
  const canonicalRoot = realpathSync(root)
  const sourcePathSet = new Set(paths)
  const visitedDirectories = new Set<string>()
  const hash = createHash('sha256')
  const identityHash = createHash('sha256')
  for (const path of paths) {
    const absolute = resolve(root, path)
    let info: BigIntStats
    try {
      info = lstatSync(absolute, { bigint: true })
    } catch (error) {
      if (!errnoIs(error, 'ENOENT')) throw error
      digestEntry(hash, path, 'missing', 0, Buffer.alloc(0))
      digestIdentityEntry(identityHash, path, 'missing', undefined, Buffer.alloc(0))
      continue
    }
    if (info.isSymbolicLink()) {
      const linkTarget = readlinkSync(absolute, { encoding: 'buffer' })
      assertListedSourceTree(canonicalRoot, absolute, sourcePathSet, visitedDirectories)
      digestEntry(hash, path, 'symlink', Number(info.mode), linkTarget)
      digestIdentityEntry(identityHash, path, 'symlink', info, linkTarget)
      continue
    }
    if (!info.isFile()) throw new Error(`repository source entry ${path} is neither a file nor a symbolic link`)
    digestEntry(hash, path, 'file', Number(info.mode), readFileSync(absolute))
    digestIdentityEntry(identityHash, path, 'file', info, Buffer.alloc(0))
  }
  return {
    fileCount: paths.length,
    sha256: hash.digest('hex'),
    identitySha256: identityHash.digest('hex'),
  }
}

function directoryNames(root: string, parts: readonly string[]): string[] {
  const absolute = join(root, ...parts)
  let rootInfo
  try {
    rootInfo = lstatSync(absolute)
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return []
    throw error
  }
  const rootPath = parts.join('/')
  if (rootInfo.isSymbolicLink()) throw new Error(`repository runtime artifact ancestor ${rootPath} is a symbolic link`)
  if (!rootInfo.isDirectory()) throw new Error(`repository runtime artifact ancestor ${rootPath} is not a directory`)
  const entries = readdirSync(absolute, { withFileTypes: true })
  const names: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(entry.name)
      continue
    }
    if (!entry.isSymbolicLink()) continue
    const path = join(absolute, entry.name)
    if (statSync(path).isDirectory()) {
      throw new Error(`repository runtime artifact ancestor ${[...parts, entry.name].join('/')} is a symbolic link`)
    }
  }
  return names.sort(compareCodeUnits)
}

function collectRuntimeTree(root: string, parts: readonly string[], artifacts: RuntimeArtifact[]): void {
  const absolute = join(root, ...parts)
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const childParts = [...parts, entry.name]
    const childAbsolute = join(root, ...childParts)
    const path = childParts.join('/')
    const info = lstatSync(childAbsolute)
    if (info.isDirectory()) {
      collectRuntimeTree(root, childParts, artifacts)
      continue
    }
    if (!info.isFile()) throw new Error(`repository runtime artifact ${path} is not a regular file`)
    if (!path.endsWith('.tsbuildinfo')) artifacts.push({ absolute: childAbsolute, path })
  }
}

function collectLibRoot(root: string, parts: readonly string[], artifacts: RuntimeArtifact[]): void {
  const absolute = join(root, ...parts)
  let info
  try {
    info = lstatSync(absolute)
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return
    throw error
  }
  const path = parts.join('/')
  if (info.isSymbolicLink()) throw new Error(`repository runtime artifact ancestor ${path} is a symbolic link`)
  if (!info.isDirectory()) throw new Error(`repository runtime artifact ancestor ${path} is not a directory`)
  collectRuntimeTree(root, parts, artifacts)
}

function runtimeArtifacts(root: string): RuntimeArtifact[] {
  const artifacts: RuntimeArtifact[] = []
  for (const app of directoryNames(root, ['apps'])) collectLibRoot(root, ['apps', app, 'lib'], artifacts)
  for (const group of directoryNames(root, ['packages'])) {
    for (const pkg of directoryNames(root, ['packages', group])) {
      collectLibRoot(root, ['packages', group, pkg, 'lib'], artifacts)
    }
  }
  for (const pkg of directoryNames(root, ['vendor'])) collectLibRoot(root, ['vendor', pkg, 'lib'], artifacts)
  return artifacts.sort((left, right) => compareCodeUnits(left.path, right.path))
}

/**
 * Digest every Host-side application, package, and vendored `lib` artifact.
 * @param root - repository root containing built `lib` directories.
 * @returns exact runtime-file count and digest.
 */
export function repositoryRuntimeArtifactDigest(root: string): RepositoryFileDigest {
  const artifacts = runtimeArtifacts(root)
  if (artifacts.length === 0) throw new Error('complete repository build produced no Host-side lib artifacts')
  const hash = createHash('sha256')
  for (const artifact of artifacts) {
    const info = lstatSync(artifact.absolute)
    if (!info.isFile()) throw new Error(`repository runtime artifact ${artifact.path} changed kind while being read`)
    digestEntry(hash, artifact.path, 'file', info.mode, readFileSync(artifact.absolute))
  }
  return { fileCount: artifacts.length, sha256: hash.digest('hex') }
}

function sameDigest(left: RepositoryFileDigest, right: RepositoryFileDigest): boolean {
  return left.fileCount === right.fileCount && left.sha256 === right.sha256
}

function sameSourceDigest(left: RepositorySourceDigest, right: RepositorySourceDigest): boolean {
  return sameDigest(left, right) && left.identitySha256 === right.identitySha256
}

/**
 * Write the build record after matching source content and identity at both build endpoints.
 * @param root - repository root containing source and generated artifacts.
 * @param sourceAtStart - source digest captured immediately before build orchestration.
 * @returns record written atomically to disk.
 */
export function writeRepositoryBuildRecord(
  root: string,
  sourceAtStart: RepositorySourceDigest,
): RepositoryBuildRecord {
  const source = repositorySourceDigest(root)
  if (!sameSourceDigest(source, sourceAtStart)) {
    throw new Error('repository source endpoint observations differ; rerun pnpm run build from a stable checkout')
  }
  const record: RepositoryBuildRecord = {
    formatVersion: REPOSITORY_BUILD_RECORD_FORMAT,
    source,
    runtimeArtifacts: repositoryRuntimeArtifactDigest(root),
  }
  const path = resolve(root, REPOSITORY_BUILD_RECORD_PATH)
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return record
}

function parseDigest(value: unknown, label: string): RepositoryFileDigest {
  if (typeof value !== 'object' || value === null) throw new Error(`${label} must be an object`)
  const fileCount: unknown = Reflect.get(value, 'fileCount')
  const sha256: unknown = Reflect.get(value, 'sha256')
  if (!Number.isSafeInteger(fileCount) || (fileCount as number) <= 0) {
    throw new Error(`${label}.fileCount must be a positive safe integer`)
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`${label}.sha256 must be a lowercase SHA-256 digest`)
  }
  return { fileCount: fileCount as number, sha256 }
}

function parseSourceDigest(value: unknown, label: string): RepositorySourceDigest {
  const digest = parseDigest(value, label)
  const identitySha256: unknown = Reflect.get(value as object, 'identitySha256')
  if (typeof identitySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(identitySha256)) {
    throw new Error(`${label}.identitySha256 must be a lowercase SHA-256 digest`)
  }
  return { ...digest, identitySha256 }
}

function parseRecord(value: unknown): RepositoryBuildRecord {
  if (typeof value !== 'object' || value === null) throw new Error('repository build record must be an object')
  const formatVersion: unknown = Reflect.get(value, 'formatVersion')
  if (formatVersion !== REPOSITORY_BUILD_RECORD_FORMAT) {
    throw new Error(`repository build record formatVersion must be ${String(REPOSITORY_BUILD_RECORD_FORMAT)}`)
  }
  return {
    formatVersion,
    source: parseSourceDigest(Reflect.get(value, 'source'), 'repository build record source'),
    runtimeArtifacts: parseDigest(
      Reflect.get(value, 'runtimeArtifacts'),
      'repository build record runtimeArtifacts',
    ),
  }
}

/**
 * Read a complete build record and prove it still describes source and runtime artifacts.
 * @param root - repository root containing the record, source, and generated artifacts.
 * @returns parsed and fully verified record.
 */
export function readRepositoryBuildRecord(root: string): RepositoryBuildRecord {
  const path = resolve(root, REPOSITORY_BUILD_RECORD_PATH)
  if (!existsSync(path)) {
    throw new Error(`repository build record ${REPOSITORY_BUILD_RECORD_PATH} is missing; run pnpm run build first`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`repository build record ${REPOSITORY_BUILD_RECORD_PATH} is invalid JSON: ${detail}`)
  }
  const record = parseRecord(parsed)
  const source = repositorySourceDigest(root)
  if (!sameSourceDigest(source, record.source)) {
    throw new Error(`repository source differs from ${REPOSITORY_BUILD_RECORD_PATH}; run pnpm run build again`)
  }
  const runtimeArtifacts = repositoryRuntimeArtifactDigest(root)
  if (!sameDigest(runtimeArtifacts, record.runtimeArtifacts)) {
    throw new Error(`repository runtime artifacts differ from ${REPOSITORY_BUILD_RECORD_PATH}; run pnpm run build again`)
  }
  return record
}
