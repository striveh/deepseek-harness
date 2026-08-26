/** Assembled keyless snapshot for Extension Management Host owner surfaces. */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LOADER_SMOKE_TEST_TIMEOUT_MS,
  resolveExampleLaunch,
  runLoaderSmoke,
} from '@deepseek-ai/dsh-loader-smoke'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const cliSource = join(repoRoot, 'apps/cli/src/bin.ts')
const cliBuilt = join(repoRoot, 'apps/cli/lib/bin.js')
const tsconfigPath = join(repoRoot, 'tsconfig.json')
const readyExitHook = fileURLToPath(new URL('./fixtures/web-browser-open/register.mjs', import.meta.url))
const ownerFixture = fileURLToPath(new URL('./fixtures/extension-host-owners/snapshot.ts', import.meta.url))
const rootConfig = join(repoRoot, 'packages/bundle/base/tests/fixtures/root.cordis.yml')
const builtArtifactsExist = existsSync(cliBuilt) && existsSync(join(repoRoot, 'apps/web/dist/index.html'))
const roots: string[] = []
const packageName = 'snapshot-lifecycle-bundle'
const generationPattern = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu

interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface ProfileInventory {
  readonly snapshot: {
    readonly revision: number
    readonly activeGeneration: string | null
    readonly lastGoodGeneration: string | null
    readonly rollbackGeneration: string | null
    readonly bootStatus: string
    readonly effectivePath: string
  }
  readonly active: {
    readonly mutation: null | {
      readonly operation: string
      readonly packageName: string
      readonly version?: string
    }
  } | null
  readonly staged: readonly unknown[]
  readonly recoverable: readonly unknown[]
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function commandEnvironment(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEEPSEEK_API_KEY: 'keyless-extension-host-snapshot-no-call',
    DSH_AGENTS_HOME: join(root, '.agents'),
    DSH_HOME: join(root, '.dsh'),
    DSH_TELEMETRY_DISABLED: '1',
    NODE_NO_WARNINGS: '1',
    ...extra,
  }
  delete env.DEEPSEEK_BASE_URL
  return env
}

async function runDsh(root: string, args: readonly string[], exitAfterWebReady = false): Promise<CommandResult> {
  const launch = resolveExampleLaunch({
    srcBin: cliSource,
    libBin: cliBuilt,
    configArgs: args,
    tsconfigPath,
  })
  const result = await execa(launch.command, [
    ...exitAfterWebReady ? ['--import', readyExitHook] : [],
    ...launch.args,
  ], {
    cwd: root,
    env: commandEnvironment(root, {
      ...launch.env,
      ...exitAfterWebReady ? { DSH_BROWSER_OPEN_TEST_EXIT_ON_READY: '1' } : {},
    }),
    extendEnv: false,
    input: '',
    timeout: 60_000,
    killSignal: 'SIGKILL',
    reject: false,
  })
  return {
    code: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

async function packBundle(root: string, version: string): Promise<{ artifact: string; digest: string }> {
  const source = join(root, `bundle-${version}`)
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({
    name: packageName,
    version,
    type: 'module',
    main: './plugin.mjs',
    files: ['plugin.mjs', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, undefined, 2))
  writeFileSync(join(source, 'plugin.mjs'), 'export function apply() {}\n')
  writeFileSync(join(source, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: snapshot-lifecycle-plugin',
    `      name: ${packageName}`,
    '',
  ].join('\n'))
  const packed = await execa('pnpm', ['pack', '--pack-destination', root], {
    cwd: source,
    timeout: 30_000,
    killSignal: 'SIGKILL',
    reject: false,
  })
  if (packed.exitCode !== 0) {
    throw new Error(`snapshot bundle pack failed:\n${packed.stdout}\n${packed.stderr}`)
  }
  const artifact = join(root, `${packageName}-${version}.tgz`)
  return { artifact, digest: sha256(readFileSync(artifact)) }
}

function normalize(result: CommandResult, root: string): CommandResult {
  const normalizeText = (value: string): string => value
    .replaceAll(root, '{{root}}')
    .replace(generationPattern, '{{generation}}')
    .replace(/sha256:[0-9a-f]{64}/gu, 'sha256:{{digest}}')
    .replace(/http:\/\/127\.0\.0\.1:\d+/gu, 'http://127.0.0.1:{{port}}')
  return {
    code: result.code,
    stdout: normalizeText(result.stdout),
    stderr: normalizeText(result.stderr),
  }
}

function inventory(result: CommandResult): ProfileInventory {
  if (result.code !== 0 || result.stderr !== '') {
    throw new Error(`Profile inventory failed:\n${result.stdout}\n${result.stderr}`)
  }
  return JSON.parse(result.stdout) as ProfileInventory
}

function requireCode(label: string, result: CommandResult, expected: number): void {
  if (result.code !== expected) {
    throw new Error(`${label} exited ${String(result.code)} instead of ${String(expected)}:\n${result.stdout}\n${result.stderr}`)
  }
}

function summarizeInventory(value: ProfileInventory): object {
  const active = value.snapshot.activeGeneration
  const lastGood = value.snapshot.lastGoodGeneration
  const mutation = value.active?.mutation
  return {
    revision: value.snapshot.revision,
    bootStatus: value.snapshot.bootStatus,
    active: active !== null,
    activeIsLastGood: active !== null && active === lastGood,
    lastGood: lastGood !== null,
    rollback: value.snapshot.rollbackGeneration !== null,
    activeMutation: mutation == null ? null : {
      operation: mutation.operation,
      packageName: mutation.packageName,
      ...mutation.version === undefined ? {} : { version: mutation.version },
    },
    staged: value.staged.length,
    recoverable: value.recoverable.length,
  }
}

describe.skipIf(!builtArtifactsExist)('Extension Management Host assembled snapshots', () => {
  it('pins strict plugin lifecycle output and the restored world', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-extension-host-snapshot-'))
    roots.push(root)
    const first = await packBundle(root, '1.0.0')
    const second = await packBundle(root, '2.0.0')

    const invalid = await runDsh(root, ['plugin', '--profile', 'web', 'add', packageName])
    const initial = inventory(await runDsh(root, ['plugin', '--profile', 'web', 'list']))
    const install = await runDsh(root, [
      'plugin', '--profile', 'web', 'install', first.artifact,
      '--package', packageName, '--version', '1.0.0', '--digest', first.digest, '--kind', 'bundle',
      '--mutation-id', 'snapshot-install',
    ])
    const boot = await runDsh(root, ['web', '--port', '0', '--no-open'], true)
    const verified = inventory(await runDsh(root, ['plugin', '--profile', 'web', 'list']))
    const update = await runDsh(root, [
      'plugin', '--profile', 'web', 'update', second.artifact,
      '--package', packageName, '--version', '2.0.0', '--digest', second.digest, '--kind', 'bundle',
      '--mutation-id', 'snapshot-update',
    ])

    const afterUpdate = inventory(await runDsh(root, ['plugin', '--profile', 'web', 'list']))
    const currentPatch = join(afterUpdate.snapshot.effectivePath, 'cordis.patch.yml')
    const disabledPatch = join(root, 'disabled.cordis.patch.yml')
    const emptyPatch = join(root, 'empty.cordis.patch.yml')
    const disabledText = '- id: snapshot-lifecycle-plugin\n  disabled: true\n'
    const emptyText = '[]\n'
    writeFileSync(disabledPatch, disabledText)
    writeFileSync(emptyPatch, emptyText)
    const configure = await runDsh(root, [
      'plugin', '--profile', 'web', 'configure', packageName,
      '--patch-file', disabledPatch,
      '--expected-digest', sha256(readFileSync(currentPatch)),
      '--next-digest', sha256(disabledText),
      '--mutation-id', 'snapshot-configure',
    ])
    const afterConfigure = inventory(await runDsh(root, ['plugin', '--profile', 'web', 'list']))
    const reset = await runDsh(root, [
      'plugin', '--profile', 'web', 'configure', packageName,
      '--patch-file', emptyPatch,
      '--expected-digest', sha256(readFileSync(join(afterConfigure.snapshot.effectivePath, 'cordis.patch.yml'))),
      '--next-digest', sha256(emptyText),
      '--mutation-id', 'snapshot-reset',
    ])
    const uninstall = await runDsh(root, [
      'plugin', '--profile', 'web', 'uninstall', packageName, '--mutation-id', 'snapshot-uninstall',
    ])
    const restore = await runDsh(root, [
      'plugin', '--profile', 'web', 'restore', '--mutation-id', 'snapshot-restore',
    ])
    const restoreReplay = await runDsh(root, [
      'plugin', '--profile', 'web', 'restore', '--mutation-id', 'snapshot-restore',
    ])
    const restoreReceipt = await runDsh(root, [
      'plugin', '--profile', 'web', 'restore-receipt', '--mutation-id', 'snapshot-restore',
    ])
    requireCode('invalid plugin operation', invalid, 2)
    requireCode('plugin install', install, 0)
    requireCode('verified Web boot', boot, 0)
    requireCode('plugin update', update, 0)
    requireCode('plugin configure', configure, 0)
    requireCode('plugin configure reset', reset, 0)
    requireCode('plugin uninstall', uninstall, 0)
    requireCode('plugin restore', restore, 0)
    requireCode('plugin restore replay', restoreReplay, 0)
    requireCode('plugin restore receipt', restoreReceipt, 0)
    expect(normalize(restoreReplay, root)).toEqual(normalize(restore, root))
    const restored = inventory(await runDsh(root, ['plugin', '--profile', 'web', 'list']))
    const restoredManifest = JSON.parse(
      readFileSync(join(restored.snapshot.effectivePath, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }

    expect({
      invalid: normalize(invalid, root),
      initial: summarizeInventory(initial),
      install: normalize(install, root),
      boot: {
        ...normalize(boot, root),
        stdout: normalize(boot, root).stdout.split(/\r?\n/u).filter(line => line.startsWith('dsh web: ')),
      },
      verified: summarizeInventory(verified),
      update: normalize(update, root),
      configure: normalize(configure, root),
      reset: normalize(reset, root),
      uninstall: normalize(uninstall, root),
      restore: normalize(restore, root),
      restoreReceipt: normalize(restoreReceipt, root),
      restored: {
        ...summarizeInventory(restored),
        installedVersion: restoredManifest.dependencies?.[packageName] ?? null,
      },
    }).toMatchInlineSnapshot(`
      {
        "boot": {
          "code": 0,
          "stderr": "",
          "stdout": [
            "dsh web: http://127.0.0.1:{{port}}",
          ],
        },
        "configure": {
          "code": 0,
          "stderr": "",
          "stdout": "dsh: committed generation {{generation}} at revision 4; restart required",
        },
        "initial": {
          "active": false,
          "activeIsLastGood": false,
          "activeMutation": null,
          "bootStatus": "live",
          "lastGood": false,
          "recoverable": 0,
          "revision": 0,
          "rollback": false,
          "staged": 0,
        },
        "install": {
          "code": 0,
          "stderr": "",
          "stdout": "dsh: committed generation {{generation}} at revision 1; restart required",
        },
        "invalid": {
          "code": 2,
          "stderr": "dsh: dsh: plugin accepts only install, update, uninstall, configure, restore, restore-receipt, or list; arbitrary pnpm writes are disabled",
          "stdout": "",
        },
        "reset": {
          "code": 0,
          "stderr": "",
          "stdout": "dsh: committed generation {{generation}} at revision 5; restart required",
        },
        "restore": {
          "code": 0,
          "stderr": "",
          "stdout": "dsh: restored generation {{generation}}; restart required",
        },
        "restoreReceipt": {
          "code": 0,
          "stderr": "",
          "stdout": "{
        \"profile\": \"web\",
        \"mutationId\": \"snapshot-restore\",
        \"status\": \"committed\",
        \"receipt\": {
          \"mutationId\": \"snapshot-restore\",
          \"status\": \"committed\",
          \"operation\": \"restore\",
          \"before\": {
            \"profile\": \"web\",
            \"revision\": 6,
            \"treeDigest\": \"sha256:{{digest}}\",
            \"effectivePath\": \"{{root}}/.dsh/profiles/.dsh-profile-transactions/web/generations/{{generation}}/profile\",
            \"activeGeneration\": \"{{generation}}\",
            \"lastGoodGeneration\": \"{{generation}}\",
            \"rollbackGeneration\": \"{{generation}}\",
            \"bootStatus\": \"pending-restart\"
          },
          \"after\": {
            \"profile\": \"web\",
            \"revision\": 7,
            \"treeDigest\": \"sha256:{{digest}}\",
            \"effectivePath\": \"{{root}}/.dsh/profiles/.dsh-profile-transactions/web/generations/{{generation}}/profile\",
            \"activeGeneration\": \"{{generation}}\",
            \"lastGoodGeneration\": \"{{generation}}\",
            \"rollbackGeneration\": \"{{generation}}\",
            \"bootStatus\": \"verified\"
          },
          \"restartRequired\": true
        }
      }",
        },
        "restored": {
          "active": true,
          "activeIsLastGood": true,
          "activeMutation": {
            "operation": "install",
            "packageName": "snapshot-lifecycle-bundle",
            "version": "1.0.0",
          },
          "bootStatus": "verified",
          "installedVersion": "1.0.0",
          "lastGood": true,
          "recoverable": 1,
          "revision": 7,
          "rollback": true,
          "staged": 4,
        },
        "uninstall": {
          "code": 0,
          "stderr": "",
          "stdout": "dsh: committed generation {{generation}} at revision 6; restart required",
        },
        "update": {
          "code": 0,
          "stderr": "",
          "stdout": "dsh: committed generation {{generation}} at revision 3; restart required",
        },
        "verified": {
          "active": true,
          "activeIsLastGood": true,
          "activeMutation": {
            "operation": "install",
            "packageName": "snapshot-lifecycle-bundle",
            "version": "1.0.0",
          },
          "bootStatus": "verified",
          "lastGood": true,
          "recoverable": 1,
          "revision": 2,
          "rollback": true,
          "staged": 0,
        },
      }
    `)
  }, 120_000)

  it('projects all owners and exact managed MCP tool provenance from the real base bundle', async () => {
    const result = await runLoaderSmoke({
      label: 'extension management Host owners snapshot',
      tempDirPrefix: 'dsh-extension-host-owners-snapshot-',
      binScript: ownerFixture,
      libBinScript: ownerFixture,
      configPath: rootConfig,
      binArgs: [],
      tsconfigPath,
      env: {
        DEEPSEEK_API_KEY: 'keyless-extension-host-snapshot-no-call',
        DSH_TELEMETRY_DISABLED: '1',
        NODE_NO_WARNINGS: '1',
      },
    })
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout) as unknown).toMatchInlineSnapshot(`
      {
        "continuation": {
          "afterRestart": "claimed",
          "beforeRestart": "pending",
          "dispatchEventCount": 1,
          "messageSequence": [
            {
              "role": "user",
              "source": "user",
            },
            {
              "role": "user",
              "source": "plugin",
            },
            {
              "role": "assistant",
              "source": "model",
            },
            {
              "role": "user",
              "source": "task-continuation",
            },
          ],
          "modelRequestCount": 1,
          "taskContinuationMessages": [
            {
              "content": [
                {
                  "text": "The requested capability is now verified for the existing task. Re-check it and continue that task.",
                  "type": "text",
                },
              ],
              "role": "user",
              "source": {
                "kind": "task-continuation",
                "taskRevision": "extension-host-r1",
                "verifierId": "extension-host-verifier",
              },
            },
          ],
        },
        "mcp": {
          "afterDisable": {
            "observed": "disabled",
            "ownedTools": [],
            "revision": 2,
          },
          "beforeDisable": {
            "observed": "ready",
            "ownedTools": [
              "mcp__snapshot__managed",
            ],
            "revision": 1,
          },
          "managedCall": {
            "content": [
              {
                "text": "managed",
                "type": "text",
              },
            ],
            "isError": false,
          },
          "schemaNamesAfterDisable": [
            "mcp__snapshot__foreign",
          ],
          "schemasBeforeDisable": [
            {
              "description": "Managed fixture tool managed.",
              "name": "mcp__snapshot__managed",
              "parameters": {
                "$schema": "http://json-schema.org/draft-07/schema#",
                "properties": {},
                "type": "object",
              },
            },
            {
              "description": "Unmanaged same-prefix snapshot fixture.",
              "name": "mcp__snapshot__foreign",
              "parameters": {
                "properties": {},
                "type": "object",
              },
            },
          ],
        },
        "profile": {
          "activeGeneration": null,
          "bootStatus": "live",
          "revision": 0,
        },
        "protocols": {
          "mcpConnections": 1,
          "profileTransactions": 1,
          "taskContinuations": 1,
        },
        "serviceMethods": {
          "mcpConnections": [
            "abstract readonly protocolVersion: 1",
            "abstract snapshot(): McpConnectionsSnapshot",
            "abstract get(id: McpConnectionId): McpConnectionView | undefined",
            "abstract getRemoved(id: McpConnectionId): RemovedMcpConnectionView | undefined",
            "abstract configure(request: ConfigureMcpConnectionRequest): Promise<McpConnectionMutationReceipt>",
            "abstract enable(request: McpConnectionMutationRequest): Promise<McpConnectionMutationReceipt>",
            "abstract disable(request: McpConnectionMutationRequest): Promise<McpConnectionMutationReceipt>",
            "abstract update(request: UpdateMcpConnectionRequest): Promise<McpConnectionMutationReceipt>",
            "abstract remove(request: McpConnectionMutationRequest): Promise<McpConnectionMutationReceipt>",
            "abstract restore(request: RestoreMcpConnectionRequest): Promise<McpConnectionMutationReceipt>",
            "abstract purge(request: PurgeMcpConnectionRequest): Promise<McpConnectionMutationReceipt>",
          ],
          "profileTransactions": [
            "abstract readonly protocolVersion: 1",
            "abstract snapshot(profile: ProfileId): Promise<ProfileSnapshot>",
            "abstract stage(request: StageProfileGenerationRequest): Promise<StagedProfileGeneration>",
            "abstract commit(request: CommitProfileGenerationRequest): Promise<ProfileCommitReceipt>",
            "abstract abort(request: AbortProfileGenerationRequest): Promise<boolean>",
            "abstract restoreLastGood(request: RestoreLastGoodProfileRequest): Promise<ProfileCommitReceipt>",
            "abstract getRestoreReceipt(request: GetProfileRestoreReceiptRequest): Promise<ProfileRestoreReceipt | null>",
            "abstract acknowledgeBoot(request: AcknowledgeProfileBootRequest): Promise<ProfileCommitReceipt>",
            "abstract list(profile: ProfileId): Promise<ProfileGenerationInventory>",
          ],
          "taskContinuations": [
            "abstract readonly protocolVersion: 1",
            "abstract create(agent: Agent, request: CreateTaskContinuationRequest): Promise<TaskContinuationClaim>",
            "abstract reserve(request: ReserveTaskContinuationRequest): Promise<TaskContinuationClaim>",
            "abstract get(id: ContinuationId): Promise<TaskContinuationClaim | undefined>",
            "abstract list(request?: ListTaskContinuationsRequest): Promise<readonly TaskContinuationClaim[]>",
            "abstract cancel(ref: TaskContinuationRef): Promise<boolean>",
            "abstract supersede(request: SupersedeTaskContinuationRequest): Promise<boolean>",
            "registerVerifier(verifier: TaskContinuationVerifier): () => void",
          ],
        },
        "serviceMounted": {
          "mcpConnections": true,
          "profileTransactions": true,
          "taskContinuations": true,
        },
      }
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
