import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'

const cleanups: Array<() => Promise<void>> = []
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const validatorEntry = fileURLToPath(new URL('./fixtures/profile-validator-entry.ts', import.meta.url))
const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function makeProfile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-validator-owner-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const profilesDir = join(root, 'profiles')
  const profile = join(profilesDir, 'web')
  const owner = join(profile, 'node_modules', 'owner-package')
  await mkdir(owner, { recursive: true })
  await Promise.all([
    writeFile(join(profile, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-validator-fixture',
      private: true,
      dependencies: { 'owner-package': '1.0.0' },
      dsh: { profile: { bundles: [] } },
    }, null, 2)}\n`),
    writeFile(join(owner, 'package.json'), '{"name":"owner-package","version":"1.0.0"}\n'),
    writeFile(join(profile, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: web-startup',
      "      name: './credential-sentinel.mjs'",
      '',
    ].join('\n')),
    writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nautoInstallPeers: false\n'),
    writeFile(join(profile, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
settings:
  autoInstallPeers: false
  excludeLinksFromLockfile: false
importers:
  .:
    dependencies:
      owner-package:
        specifier: 1.0.0
        version: 1.0.0
packages: {}
snapshots: {}
`),
    writeFile(join(profile, 'credential-sentinel.mjs'), [
      "const forbidden = ['DSH_VALIDATOR_TEST_API_KEY', 'AWS_SHARED_CREDENTIALS_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'DEEPSEEK_BASE_URL', 'HTTPS_PROXY', 'SSH_AUTH_SOCK', 'NODE_OPTIONS']",
      'export function apply() {',
      '  const inherited = forbidden.filter(name => process.env[name] !== undefined)',
      "  if (inherited.length > 0) throw new Error(`validator inherited forbidden environment: ${inherited.join(', ')}`)",
      "  if (!process.env.DSH_HOME?.includes('dsh-profile-validation-') || process.env.HOME !== process.env.DSH_HOME) throw new Error('validator did not receive an isolated home')",
      '}',
      '',
    ].join('\n')),
    writeFile(join(profile, 'broken-sentinel.mjs'), "export function apply() { throw new Error('broken Loader sentinel') }\n"),
  ])
  return profilesDir
}

async function runOwner(mode: 'valid' | 'broken', profilesDir: string) {
  return execa(process.execPath, [
    '--import', import.meta.resolve('tsx/esm'), validatorEntry, mode, profilesDir, installAnchor,
  ], {
    cwd: repoRoot,
    env: {
      DSH_VALIDATOR_TEST_API_KEY: 'must-not-cross',
      AWS_SHARED_CREDENTIALS_FILE: '/private/ambient/aws-credentials',
      GOOGLE_APPLICATION_CREDENTIALS: '/private/ambient/google-credentials.json',
      DEEPSEEK_BASE_URL: 'https://ambient-provider.invalid',
      HTTPS_PROXY: 'https://ambient-proxy.invalid',
      SSH_AUTH_SOCK: '/private/ambient/ssh-agent.sock',
    },
    reject: false,
    timeout: 35_000,
    killSignal: 'SIGKILL',
  })
}

describe('owner-managed Profile validator', () => {
  it('stages only after real Loader activation without inherited credential authority', async () => {
    const result = await runOwner('valid', await makeProfile())
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ validated: true })
  }, 40_000)

  it('rejects a Loader failure before creating a committable generation', async () => {
    const result = await runOwner('broken', await makeProfile())
    expect(result.exitCode, result.stderr).toBe(0)
    const response: unknown = JSON.parse(result.stdout)
    expect(response).toMatchObject({ rejected: true })
    if (typeof response !== 'object' || response === null || !('message' in response)
      || typeof response.message !== 'string') {
      throw new TypeError('validator rejection response must carry a string message')
    }
    expect(response.message).toContain('isolated Profile Loader validation failed')
    expect(response.message).toContain('broken Loader sentinel')
  }, 40_000)
})
