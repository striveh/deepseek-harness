import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  mcpConnectionId,
  mcpConnectionMutationId,
  parseMcpConnectionDesired,
  type McpConnectionMutationReceipt,
} from '@deepseek-ai/dsh-mcp-connections'
import { McpConnectionFileStore } from '../src/persistence.ts'
import { McpConnectionCoordinator } from '../src/coordinator.ts'
import {
  MCP_CONNECTION_STATE_VERSION,
  digestCanonical,
  digestDesired,
  emptyStoredState,
  serializeStateEnvelope,
  type StoredMcpConnectionsState,
} from '../src/state.ts'

const roots: string[] = []
const children = new Set<ChildProcess>()

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) await once(child, 'close')
  }))
  children.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function pathFor(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-mcp-persistence-${name}-`))
  roots.push(root)
  return join(root, 'connections.json')
}

function desired(id: string) {
  return parseMcpConnectionDesired({
    id,
    enabled: false,
    transport: {
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 1_000,
      reconnect: { enabled: true, initialDelayMs: 10, maxDelayMs: 100, maxAttempts: 3 },
    },
  })
}

function receipt(id = 'seed', snapshotRevision = 1): McpConnectionMutationReceipt {
  return {
    mutationId: mcpConnectionMutationId(`${id}-mutation`),
    operation: 'configure',
    id: mcpConnectionId(id),
    revision: 1,
    snapshotRevision,
    changed: true,
    desiredDigest: digestDesired(desired(id)),
  }
}

function applyConfigured(state: StoredMcpConnectionsState, committed: McpConnectionMutationReceipt): void {
  state.revision = committed.snapshotRevision
  state.connections.push({ desired: desired(committed.id), revision: committed.revision })
}

async function seed(path: string): Promise<McpConnectionFileStore> {
  const store = new McpConnectionFileStore(path)
  const committed = receipt()
  await store.mutate(committed.mutationId, digestCanonical({ seed: true }), (state) => {
    applyConfigured(state, committed)
    return { next: state, receipt: committed }
  })
  return store
}

interface JournalCore {
  version: number
  sequence: number
  kind: string
  previousDigest: string | null
  stateDigest: string
  mutationId?: string
  requestDigest?: string
  receipt?: McpConnectionMutationReceipt
}

function journalLine(core: JournalCore, digest = digestCanonical(core)): string {
  return `${JSON.stringify({ ...core, digest })}\n`
}

function recoveryCore(overrides: Partial<JournalCore> = {}): JournalCore {
  return {
    version: MCP_CONNECTION_STATE_VERSION,
    sequence: 1,
    kind: 'recovery',
    previousDigest: null,
    stateDigest: 'b'.repeat(64),
    ...overrides,
  }
}

function mutationCore(
  mutationReceipt: McpConnectionMutationReceipt,
  overrides: Partial<JournalCore> = {},
): JournalCore {
  return {
    version: MCP_CONNECTION_STATE_VERSION,
    sequence: 1,
    kind: 'mutation',
    previousDigest: null,
    stateDigest: 'b'.repeat(64),
    mutationId: mutationReceipt.mutationId,
    requestDigest: 'd'.repeat(64),
    receipt: mutationReceipt,
    ...overrides,
  }
}

describe('MCP connection file-store recovery', () => {
  it('rolls back and releases coordination when an operation rejects', async () => {
    const path = await pathFor('coordinator-rollback')
    const coordinator = new McpConnectionCoordinator(path, 500)
    const failure = new Error('operation failed')

    await expect(coordinator.run(() => Promise.reject(failure))).rejects.toBe(failure)
    await expect(coordinator.run(() => Promise.resolve('recovered'))).resolves.toBe('recovered')
  })

  it('propagates non-missing filesystem failures while probing authority', async () => {
    const path = await pathFor('probe-failure')
    await expect(new McpConnectionFileStore(`${path}\0invalid`).load())
      .rejects.toThrow(/null bytes|must be a string without null bytes|argument.*path/i)

    const invalidParent = join(dirname(path), '\0invalid', 'connections.json')
    await expect(new McpConnectionFileStore(invalidParent).load())
      .rejects.toThrow(/null bytes|must be a string without null bytes|argument.*path/i)

    const nonDirectory = await pathFor('parent-file')
    await writeFile(nonDirectory, 'not a directory')
    await expect(new McpConnectionFileStore(join(nonDirectory, 'connections.json')).load())
      .rejects.toThrow(/durable parent is not a directory/)
  })

  it('recovers immediately after a real writer dies while holding coordination', async () => {
    const path = await pathFor('coordinator-kill')
    const worker = fileURLToPath(new URL('./coordinator-kill-worker.ts', import.meta.url))
    const child = spawn(process.execPath, [
      '--no-warnings',
      '--import',
      import.meta.resolve('tsx/esm'),
      worker,
      path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const close = await once(child, 'close')
    expect(stdout).toContain('coordinator-held')
    expect(close[0], stderr).not.toBe(0)

    await expect(new McpConnectionFileStore(path, 500).load()).resolves.toEqual({
      state: emptyStoredState(),
      recoveries: [],
    })
    expect(await readdir(join(path, '..'))).not.toContain('connections.json.lock')
  }, 20_000)

  it('serializes two same-process stores before entering synchronous SQLite contention', async () => {
    const path = await pathFor('same-process-queue')
    const left = new McpConnectionFileStore(path, 2_000)
    const right = new McpConnectionFileStore(path, 2_000)
    const mutate = (store: McpConnectionFileStore, id: string) => {
      const mutationId = mcpConnectionMutationId(`${id}-mutation`)
      return store.mutate(mutationId, digestCanonical({ id }), (state) => {
        const snapshotRevision = state.revision + 1
        const committed = receipt(id, snapshotRevision)
        applyConfigured(state, committed)
        return { next: state, receipt: committed }
      })
    }

    const results = await Promise.all([mutate(left, 'left'), mutate(right, 'right')])

    expect(results.map(result => result.receipt.snapshotRevision).sort()).toEqual([1, 2])
    const loaded = await new McpConnectionFileStore(path).load()
    expect(loaded.state.revision).toBe(2)
    expect(loaded.state.mutations.map(entry => entry.mutationId).sort()).toEqual([
      mcpConnectionMutationId('left-mutation'),
      mcpConnectionMutationId('right-mutation'),
    ])
  }, 10_000)

  it('flushes new ancestry, replacement files, and the appended journal in publication order', async () => {
    const base = await pathFor('durability-order')
    const path = join(dirname(base), 'private', 'mcp', 'connections.json')
    const steps: string[] = []
    const store = new McpConnectionFileStore(path, 1_000, {
      afterStep(step, target) {
        if (!step.startsWith('directory-') || target.startsWith(join(dirname(base), 'private'))) {
          steps.push(`${step}:${target}`)
        }
      },
    })
    const committed = receipt('ordered')

    await store.mutate(committed.mutationId, digestCanonical({ ordered: true }), (state) => {
      applyConfigured(state, committed)
      return { next: state, receipt: committed }
    })

    expect(steps).toEqual([
      `directory-created:${join(dirname(base), 'private')}`,
      `directory-entry-synced:${join(dirname(base), 'private')}`,
      `directory-created:${join(dirname(base), 'private', 'mcp')}`,
      `directory-entry-synced:${join(dirname(base), 'private', 'mcp')}`,
      `directory-entry-synced:${join(dirname(base), 'private')}`,
      `directory-entry-synced:${join(dirname(base), 'private', 'mcp')}`,
      `file-synced:${path}`,
      `file-renamed:${path}`,
      `parent-directory-synced:${path}`,
      `directory-entry-synced:${join(dirname(base), 'private')}`,
      `directory-entry-synced:${join(dirname(base), 'private', 'mcp')}`,
      `file-synced:${path}.last-good`,
      `file-renamed:${path}.last-good`,
      `parent-directory-synced:${path}.last-good`,
      `directory-entry-synced:${join(dirname(base), 'private')}`,
      `directory-entry-synced:${join(dirname(base), 'private', 'mcp')}`,
      `journal-appended:${path}.journal`,
      `journal-synced:${path}.journal`,
      `journal-parent-directory-synced:${path}.journal`,
    ])
  })

  it('fsyncs an existing durable-parent entry after an EEXIST observation', async () => {
    const path = await pathFor('existing-parent-sync')
    const parent = dirname(path)
    const synced: string[] = []
    const store = new McpConnectionFileStore(path, 1_000, {
      afterStep(step, target) {
        if (step === 'directory-entry-synced') synced.push(target)
      },
    })

    await expect(store.load()).resolves.toEqual({ state: emptyStoredState(), recoveries: [] })

    expect(synced).toContain(parent)
  })

  it('removes an unpublished synced temp when publication fails before rename', async () => {
    const path = await pathFor('durability-before-rename')
    const failure = new Error('injected before rename')
    const store = new McpConnectionFileStore(path, 1_000, {
      afterStep(step, target) {
        if (step === 'file-synced' && target === path) throw failure
      },
    })
    const committed = receipt('before-rename')

    await expect(store.mutate(committed.mutationId, digestCanonical({ before: true }), (state) => {
      applyConfigured(state, committed)
      return { next: state, receipt: committed }
    })).rejects.toBe(failure)

    await expect(access(path)).rejects.toThrow()
    expect((await readdir(dirname(path))).filter(entry => entry.endsWith('.tmp'))).toEqual([])
  })

  it('keeps publication failure primary when temporary cleanup also fails', async () => {
    const path = await pathFor('durability-cleanup-failure')
    const primary = new Error('injected publication failure')
    const cleanup = new Error('injected cleanup failure')
    const committed = receipt('cleanup-failure')
    const store = new McpConnectionFileStore(path, 1_000, {
      afterStep(step, target) {
        if (target !== path) return
        if (step === 'file-synced') throw primary
        if (step === 'temp-cleanup-starting') throw cleanup
      },
    })

    const result = store.mutate(committed.mutationId, digestCanonical({ cleanup: true }), (state) => {
      applyConfigured(state, committed)
      return { next: state, receipt: committed }
    })
    await expect(result).rejects.toMatchObject({
      cause: primary,
      errors: [primary, cleanup],
    })
  })

  it.each([
    ['file-synced', 'state'],
    ['journal-appended', 'journal'],
  ] as const)('wraps a non-Error fault at %s for %s publication', async (faultStep, targetKind) => {
    const path = await pathFor(`non-error-${targetKind}`)
    const target = targetKind === 'state' ? path : `${path}.journal`
    const committed = receipt(`non-error-${targetKind}`)
    const store = new McpConnectionFileStore(path, 1_000, {
      afterStep(step, stepPath) {
        if (step === faultStep && stepPath === target) throw 'injected non-Error fault'
      },
    })

    await expect(store.mutate(committed.mutationId, digestCanonical({ targetKind }), (state) => {
      applyConfigured(state, committed)
      return { next: state, receipt: committed }
    })).rejects.toMatchObject({ cause: 'injected non-Error fault' })
  })

  it.each([
    ['file-renamed', 'state'],
    ['parent-directory-synced', 'state'],
    ['file-synced', 'last-good'],
    ['file-renamed', 'last-good'],
    ['parent-directory-synced', 'last-good'],
    ['journal-appended', 'journal'],
    ['journal-synced', 'journal'],
    ['journal-parent-directory-synced', 'journal'],
  ] as const)('recovers an exact replay after a %s fault at %s publication', async (faultStep, targetKind) => {
    const path = await pathFor(`durability-${faultStep}-${targetKind}`)
    const target = targetKind === 'state' ? path : `${path}.${targetKind}`
    const failure = new Error(`injected ${faultStep} ${targetKind}`)
    let armed = true
    const store = new McpConnectionFileStore(path, 1_000, {
      afterStep(step, stepPath) {
        if (armed && step === faultStep && stepPath === target) {
          armed = false
          throw failure
        }
      },
    })
    const committed = receipt(`${targetKind}-${faultStep.slice(0, 16)}`)
    const requestDigest = digestCanonical({ faultStep, targetKind })

    await expect(store.mutate(committed.mutationId, requestDigest, (state) => {
      applyConfigured(state, committed)
      return { next: state, receipt: committed }
    })).rejects.toBe(failure)

    const recovered = new McpConnectionFileStore(path, 1_000)
    const replay = await recovered.mutate(committed.mutationId, requestDigest, () => {
      throw new Error('durable mutation must replay without transforming state')
    })
    expect(replay).toMatchObject({ replayed: true, receipt: committed, state: { revision: 1 } })
  })

  it.each([
    'file-synced',
    'file-renamed',
    'parent-directory-synced',
  ] as const)('durably republishes corruption evidence after a %s evidence fault', async (faultStep) => {
    const path = await pathFor(`durability-evidence-${faultStep}`)
    await seed(path)
    const corrupt = '{corrupt-current'
    await writeFile(path, corrupt)
    const evidencePath = `${path}.corrupt-${digestCanonical(corrupt).slice(0, 16)}`
    const steps: string[] = []
    let armed = true
    const failure = new Error(`injected ${faultStep} evidence`)
    const store = new McpConnectionFileStore(path, 1_000, {
      afterStep(step, stepPath) {
        if (stepPath === evidencePath) steps.push(step)
        if (armed && step === faultStep && stepPath === evidencePath) {
          armed = false
          throw failure
        }
      },
    })

    await expect(store.load()).rejects.toBe(failure)
    const recovered = await new McpConnectionFileStore(path, 1_000, {
      afterStep(step, stepPath) {
        if (stepPath === evidencePath) steps.push(step)
      },
    }).load()

    expect(recovered.state.revision).toBe(1)
    expect(await readFile(evidencePath, 'utf8')).toBe(corrupt)
    expect(steps.slice(-3)).toEqual(['file-synced', 'file-renamed', 'parent-directory-synced'])
  })

  it('starts empty and restores a missing current file from last-good', async () => {
    const emptyPath = await pathFor('empty')
    await expect(new McpConnectionFileStore(emptyPath).load()).resolves.toEqual({
      state: emptyStoredState(),
      recoveries: [],
    })

    const restoredPath = await pathFor('last-good')
    const state = emptyStoredState()
    const configured = receipt('last-good')
    applyConfigured(state, configured)
    state.mutations.push({
      mutationId: configured.mutationId,
      requestDigest: digestCanonical({ lastGood: true }),
      receipt: configured,
    })
    await writeFile(`${restoredPath}.last-good`, serializeStateEnvelope(state))
    const restored = await new McpConnectionFileStore(restoredPath).load()
    expect(restored).toMatchObject({
      state: { revision: 1 },
      recoveries: ['state-restored-from-last-good', 'journal-reconciled-to-state'],
    })
    expect(await readFile(restoredPath, 'utf8')).toBe(serializeStateEnvelope(state))
  })

  it('reconciles a missing or corrupt last-good file to valid current authority', async () => {
    for (const mode of ['missing', 'corrupt'] as const) {
      const path = await pathFor(`last-good-${mode}`)
      const store = await seed(path)
      if (mode === 'missing') await rm(`${path}.last-good`)
      else await writeFile(`${path}.last-good`, '{broken')

      const loaded = await store.load()

      expect(loaded).toMatchObject({
        state: { revision: 1 },
        recoveries: ['last-good-reconciled-to-state'],
      })
      expect(await readFile(`${path}.last-good`, 'utf8')).toBe(await readFile(path, 'utf8'))
      const evidence = (await readdir(join(path, '..')))
        .filter(entry => entry.startsWith('connections.json.last-good.corrupt-'))
      expect(evidence, mode).toHaveLength(mode === 'corrupt' ? 1 : 0)
    }
  })

  it('heals a stale crash-window backup before a later current-state recovery', async () => {
    const path = await pathFor('stale-last-good')
    const store = await seed(path)
    const staleBackup = await readFile(`${path}.last-good`, 'utf8')
    const staleJournal = await readFile(`${path}.journal`, 'utf8')
    const latest = receipt('latest', 2)
    await store.mutate(latest.mutationId, digestCanonical({ latest: true }), (state) => {
      applyConfigured(state, latest)
      return { next: state, receipt: latest }
    })
    await writeFile(`${path}.last-good`, staleBackup)
    await writeFile(`${path}.journal`, staleJournal)

    const healed = await store.load()

    expect(healed.recoveries).toEqual([
      'last-good-reconciled-to-state',
      'journal-reconciled-to-state',
    ])
    expect(healed.state).toMatchObject({ revision: 2 })
    expect(healed.state.mutations).toContainEqual(expect.objectContaining({
      mutationId: latest.mutationId,
      receipt: latest,
    }))

    await writeFile(path, '{broken-current')
    const recovered = await store.load()
    expect(recovered).toMatchObject({
      state: { revision: 2 },
      recoveries: ['state-restored-from-last-good'],
    })
    expect(recovered.state.mutations).toContainEqual(expect.objectContaining({
      mutationId: latest.mutationId,
      receipt: latest,
    }))
  })

  it('rejects missing authority with an extant journal and corrupt current state without backup', async () => {
    const journalOnly = await pathFor('journal-only')
    await writeFile(`${journalOnly}.journal`, '{}\n')
    await expect(new McpConnectionFileStore(journalOnly).load()).rejects.toThrow(/state and last-good files are missing/)

    const corruptOnly = await pathFor('corrupt-only')
    await writeFile(corruptOnly, '{')
    await expect(new McpConnectionFileStore(corruptOnly).load()).rejects.toThrow(/current state is corrupt and no last-good/)
  })

  it('reconciles a missing journal head to non-empty authoritative state', async () => {
    const path = await pathFor('reconcile')
    const store = await seed(path)
    await writeFile(`${path}.journal`, '')
    const loaded = await store.load()
    expect(loaded.recoveries).toEqual(['journal-reconciled-to-state'])
    const journal = await readFile(`${path}.journal`, 'utf8')
    expect(journal.trim()).not.toBe('')
    await expect(store.load()).resolves.toMatchObject({ recoveries: [] })
  })

  it('truncates every invalid journal-entry form and preserves forensic suffixes', async () => {
    const validMutation = receipt('journal')
    const malformed: Array<readonly [string, string]> = [
      ['invalid-json', '{\n'],
      ['non-object', '[]\n'],
      ['invalid-digest', journalLine(recoveryCore(), 'bad')],
      ['digest-mismatch', journalLine(recoveryCore(), '0'.repeat(64))],
      ['version', journalLine(recoveryCore({ version: 2 }))],
      ['sequence', journalLine(recoveryCore({ sequence: 2 }))],
      ['kind', journalLine(recoveryCore({ kind: 'other' }))],
      ['previous-digest', journalLine(recoveryCore({ previousDigest: 'c'.repeat(64) }))],
      ['state-digest', journalLine(recoveryCore({ stateDigest: 'bad' }))],
      ['mutation-incomplete', journalLine(recoveryCore({ kind: 'mutation' }))],
      ['entry-extra-field', journalLine({ ...recoveryCore(), extra: true } as unknown as JournalCore)],
      ['mutation-id', journalLine(mutationCore(validMutation, { mutationId: 'unsafe mutation id' }))],
      ['mutation-id-type', journalLine(mutationCore(validMutation, { mutationId: 1 as unknown as string }))],
      ['request-digest', journalLine(mutationCore(validMutation, { requestDigest: 'bad' }))],
      ['receipt-mutation-mismatch', journalLine(mutationCore(validMutation, {
        mutationId: 'different-mutation',
      }))],
      ['receipt-semantics', journalLine(mutationCore({ ...validMutation, changed: false }))],
      ['recovery-mutation-fields', journalLine(recoveryCore({
        mutationId: String(validMutation.mutationId),
        requestDigest: 'd'.repeat(64),
        receipt: validMutation,
      }))],
    ]

    for (const [name, line] of malformed) {
      const path = await pathFor(name)
      const store = await seed(path)
      await writeFile(`${path}.journal`, line)
      const loaded = await store.load()
      expect(loaded.recoveries, name).toEqual([
        'journal-invalid-suffix-truncated',
        'journal-reconciled-to-state',
      ])
      const evidence = (await readdir(join(path, '..')))
        .filter(entry => entry.startsWith('connections.json.journal.corrupt-'))
      expect(evidence, name).toHaveLength(1)
    }
  })

  it('rejects a journal append that does not extend the validated head', async () => {
    const path = await pathFor('append-head')
    const store = new McpConnectionFileStore(path) as unknown as {
      appendJournal(
        head: { sequence: number; digest: string | null; stateDigest: string | null },
        core: JournalCore,
      ): Promise<unknown>
    }
    await expect(store.appendJournal(
      { sequence: 0, digest: null, stateDigest: null },
      recoveryCore({ sequence: 2 }),
    )).rejects.toThrow(/does not extend the validated head/)
  })

  it('propagates non-ENOENT read failures', async () => {
    const path = await pathFor('read-failure')
    await mkdir(path)
    await expect(new McpConnectionFileStore(path).load()).rejects.toThrow()
  })
})
