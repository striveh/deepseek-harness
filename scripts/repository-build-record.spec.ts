import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  REPOSITORY_BUILD_RECORD_PATH,
  readRepositoryBuildRecord,
  repositoryRuntimeArtifactDigest,
  repositorySourceDigest,
  writeRepositoryBuildRecord,
} from './repository-build-record.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repository-build-'))
  roots.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  write(join(root, '.gitignore'), 'lib/\n.dsh-build/\n')
  write(join(root, 'src/input.ts'), 'export const value = 1\n')
  execFileSync('git', ['add', '.gitignore', 'src/input.ts'], { cwd: root })
  write(join(root, 'packages/example/runtime/lib/index.js'), 'export const value = 1\n')
  return root
}

describe('repository build record', () => {
  it('binds the complete source state to runtime artifact bytes', () => {
    const root = fixture()
    const source = repositorySourceDigest(root)
    const record = writeRepositoryBuildRecord(root, source)

    expect(readRepositoryBuildRecord(root)).toEqual(record)
    expect(record.source).toEqual(source)
    expect(record.runtimeArtifacts).toEqual(repositoryRuntimeArtifactDigest(root))
    expect(JSON.parse(readFileSync(join(root, REPOSITORY_BUILD_RECORD_PATH), 'utf8'))).toEqual(record)

    write(join(root, 'src/input.ts'), 'export const value = 2\n')
    expect(() => readRepositoryBuildRecord(root)).toThrow(/repository source differs/)

    write(join(root, 'src/input.ts'), 'export const value = 1\n')
    expect(() => readRepositoryBuildRecord(root)).toThrow(/repository source differs/)
    writeRepositoryBuildRecord(root, repositorySourceDigest(root))
    write(join(root, 'packages/example/runtime/lib/index.js'), 'export const value = 2\n')
    expect(() => readRepositoryBuildRecord(root)).toThrow(/runtime artifacts differ/)
  })

  it('refuses to stamp a build when tracked or untracked source changed', () => {
    const root = fixture()
    const source = repositorySourceDigest(root)
    write(join(root, 'src/untracked.ts'), 'export const later = true\n')

    expect(() => writeRepositoryBuildRecord(root, source)).toThrow(/endpoint observations differ/)
  })

  it('detects a same-content source replacement between build endpoints', () => {
    const root = fixture()
    const source = repositorySourceDigest(root)
    rmSync(join(root, 'src/input.ts'))
    write(join(root, 'src/input.ts'), 'export const value = 1\n')

    const replaced = repositorySourceDigest(root)
    expect(replaced.sha256).toBe(source.sha256)
    expect(replaced.identitySha256).not.toBe(source.identitySha256)
    expect(() => writeRepositoryBuildRecord(root, source)).toThrow(/endpoint observations differ/)
  })

  it('binds a tracked deletion as part of the checkout source state', () => {
    const root = fixture()
    rmSync(join(root, 'src/input.ts'))
    const source = repositorySourceDigest(root)

    const record = writeRepositoryBuildRecord(root, source)
    expect(readRepositoryBuildRecord(root)).toEqual(record)
  })

  it('fails closed for missing, malformed, and structurally invalid records', () => {
    const root = fixture()
    expect(() => readRepositoryBuildRecord(root)).toThrow(/is missing/)

    write(join(root, REPOSITORY_BUILD_RECORD_PATH), '{')
    expect(() => readRepositoryBuildRecord(root)).toThrow(/invalid JSON/)

    write(join(root, REPOSITORY_BUILD_RECORD_PATH), '{"formatVersion":2}')
    expect(() => readRepositoryBuildRecord(root)).toThrow(/must be an object/)
  })

  it('binds hidden runtime files instead of dropping them from the artifact set', () => {
    const root = fixture()
    write(join(root, 'packages/example/runtime/lib/.runtime.js'), 'export const hidden = 1\n')
    const record = writeRepositoryBuildRecord(root, repositorySourceDigest(root))
    expect(record.runtimeArtifacts.fileCount).toBe(2)

    write(join(root, 'packages/example/runtime/lib/.runtime.js'), 'export const hidden = 2\n')
    expect(() => readRepositoryBuildRecord(root)).toThrow(/runtime artifacts differ/)
  })

  it.runIf(process.platform !== 'win32')('keeps literal backslashes distinct in runtime artifact paths', () => {
    const root = fixture()
    write(join(root, 'packages/example/runtime/lib/nested/value.js'), 'export const nested = 1\n')
    write(join(root, 'packages/example/runtime/lib/nested\\value.js'), 'export const backslash = 1\n')
    const record = writeRepositoryBuildRecord(root, repositorySourceDigest(root))
    expect(record.runtimeArtifacts.fileCount).toBe(3)

    write(join(root, 'packages/example/runtime/lib/nested\\value.js'), 'export const backslash = 2\n')
    expect(() => readRepositoryBuildRecord(root)).toThrow(/runtime artifacts differ/)
  })

  it.runIf(process.platform !== 'win32')('rejects external source authority and linked runtime artifacts', () => {
    const root = fixture()
    const external = mkdtempSync(join(tmpdir(), 'dsh-repository-build-external-'))
    roots.push(external)
    write(join(external, 'input.ts'), 'export const value = 1\n')
    rmSync(join(root, 'src/input.ts'))
    symlinkSync(join(external, 'input.ts'), join(root, 'src/input.ts'))
    expect(() => repositorySourceDigest(root)).toThrow(/resolves outside the repository/)

    rmSync(join(root, 'src/input.ts'))
    write(join(root, 'src/input.ts'), 'export const value = 1\n')
    symlinkSync(
      join(root, 'packages/example/runtime/lib/index.js'),
      join(root, 'packages/example/runtime/lib/linked.js'),
    )
    expect(() => repositoryRuntimeArtifactDigest(root)).toThrow(/is not a regular file/)
  })

  it('uses an invocation-unique temporary record path', () => {
    const root = fixture()
    const legacyTemporary = join(root, `${REPOSITORY_BUILD_RECORD_PATH}.tmp`)
    write(legacyTemporary, 'unrelated writer state\n')

    writeRepositoryBuildRecord(root, repositorySourceDigest(root))
    expect(readFileSync(legacyTemporary, 'utf8')).toBe('unrelated writer state\n')
  })
})
