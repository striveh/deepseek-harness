import { describe, expect, it } from 'vitest'
import {
  mcpConnectionMutationId,
  parseMcpConnectionDesired,
  type McpConnectionMutationReceipt,
  type McpConnectionOperation,
} from '@deepseek-ai/dsh-mcp-connections'
import {
  MCP_CONNECTION_STATE_VERSION,
  canonicalStringify,
  cloneStoredState,
  digestCanonical,
  digestDesired,
  emptyStoredState,
  normalizeStoredState,
  parseStateEnvelope,
  serializeStateEnvelope,
  type StoredMcpConnectionsState,
} from '../src/state.ts'

const reconnect = {
  enabled: true,
  initialDelayMs: 10,
  maxDelayMs: 100,
  maxAttempts: 3,
} as const

function desired(id: string, enabled = false, command = 'node') {
  return parseMcpConnectionDesired({
    id,
    enabled,
    transport: {
      transport: 'stdio',
      command,
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 1_000,
      reconnect,
    },
  })
}

function prototypeKeyMap(value: string): Record<string, string> {
  return JSON.parse(`{"__proto__":${JSON.stringify(value)}}`) as Record<string, string>
}

function receipt(
  operation: McpConnectionOperation,
  index: number,
  options: {
    readonly id?: string
    readonly previousRevision?: number
    readonly revision?: number
    readonly changed?: boolean
    readonly desiredDigest?: string | null
  } = {},
): McpConnectionMutationReceipt {
  const id = options.id ?? 'receipt-lifecycle'
  const revision = options.revision ?? index + 1
  return {
    mutationId: mcpConnectionMutationId(`state-${operation}-${String(index)}`),
    operation,
    id: desired(id).id,
    ...operation === 'configure' ? {} : { previousRevision: options.previousRevision ?? index },
    revision,
    snapshotRevision: index + 1,
    changed: options.changed ?? true,
    desiredDigest: options.desiredDigest ?? (operation === 'purge' ? null : digestDesired(desired(id))),
  }
}

function envelope(state: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    formatVersion: MCP_CONNECTION_STATE_VERSION,
    state,
    digest: digestCanonical(state),
    ...overrides,
  })
}

function baseState(): StoredMcpConnectionsState {
  const aInitial = desired('a-active')
  const aEnabled = desired('a-active', true)
  const aUpdated = desired('a-active', false, 'node-updated')
  const operations: McpConnectionMutationReceipt[] = [
    receipt('configure', 0, { id: 'a-active', desiredDigest: digestDesired(aInitial) }),
    receipt('enable', 1, { id: 'a-active', previousRevision: 1, revision: 2, desiredDigest: digestDesired(aEnabled) }),
    receipt('disable', 2, { id: 'a-active', previousRevision: 2, revision: 3, desiredDigest: digestDesired(aInitial) }),
    receipt('update', 3, { id: 'a-active', previousRevision: 3, revision: 4, desiredDigest: digestDesired(aUpdated) }),
    receipt('remove', 4, { id: 'a-active', previousRevision: 4, revision: 5, desiredDigest: digestDesired(aUpdated) }),
    receipt('restore', 5, { id: 'a-active', previousRevision: 5, revision: 6, desiredDigest: digestDesired(aUpdated) }),
    receipt('remove', 6, { id: 'a-active', previousRevision: 6, revision: 7, desiredDigest: digestDesired(aUpdated) }),
    receipt('purge', 7, { id: 'a-active', previousRevision: 7, revision: 8 }),
    receipt('configure', 8, { id: 'a-active', revision: 1, desiredDigest: digestDesired(aInitial) }),
    receipt('configure', 9, { id: 'z-active', revision: 1 }),
    receipt('configure', 10, { id: 'a-removed', revision: 1 }),
    receipt('remove', 11, { id: 'a-removed', previousRevision: 1, revision: 2 }),
    receipt('configure', 12, { id: 'z-removed', revision: 1 }),
    receipt('remove', 13, { id: 'z-removed', previousRevision: 1, revision: 2 }),
  ]
  return {
    formatVersion: MCP_CONNECTION_STATE_VERSION,
    revision: operations.length,
    connections: [
      { desired: desired('z-active'), revision: 1 },
      { desired: desired('a-active'), revision: 1 },
    ],
    removed: [
      { desired: desired('z-removed'), revision: 2, removedAtRevision: 14 },
      { desired: desired('a-removed'), revision: 2, removedAtRevision: 12 },
    ],
    mutations: operations.map(entry => ({
      mutationId: entry.mutationId,
      requestDigest: digestCanonical({ operation: entry.operation, snapshotRevision: entry.snapshotRevision }),
      receipt: entry,
    })),
  }
}

function parseRawState(state: unknown): StoredMcpConnectionsState {
  return parseStateEnvelope(envelope(state), 'connections.json')
}

function rawBase(): Record<string, unknown> {
  const state = baseState()
  normalizeStoredState(state)
  return JSON.parse(JSON.stringify(state)) as Record<string, unknown>
}

describe('MCP connection durable state format', () => {
  it('canonicalizes, sorts, serializes, parses, clones, and detaches every receipt operation', () => {
    const state = baseState()
    expect(canonicalStringify({ z: [{ b: 2, a: 1 }], a: null })).toBe('{"a":null,"z":[{"a":1,"b":2}]}')
    expect(digestCanonical({ b: 2, a: 1 })).toBe(digestCanonical({ a: 1, b: 2 }))
    normalizeStoredState(state)
    expect(state.connections.map(record => record.desired.id)).toEqual(['a-active', 'z-active'])
    expect(state.removed.map(record => record.desired.id)).toEqual(['a-removed', 'z-removed'])

    const parsed = parseStateEnvelope(serializeStateEnvelope(state), 'connections.json')
    expect(parsed.mutations.slice(0, 8).map(entry => entry.receipt.operation)).toEqual([
      'configure', 'enable', 'disable', 'update', 'remove', 'restore', 'remove', 'purge',
    ])
    expect(parsed.mutations[1]?.receipt.previousRevision).toBe(1)
    expect(parsed.mutations[7]?.receipt.desiredDigest).toBeNull()

    const cloned = cloneStoredState(parsed)
    cloned.connections.splice(0, 1)
    expect(parsed.connections).toHaveLength(2)
    expect(emptyStoredState()).toEqual({
      formatVersion: 1,
      revision: 0,
      connections: [],
      removed: [],
      mutations: [],
    })
  })

  it('orders mixed-case and punctuation ids by stable string code units', () => {
    const ids = ['a_', 'a-', 'a', 'A']
    const state = emptyStoredState()
    state.revision = ids.length
    for (const [index, id] of ids.entries()) {
      const configured = receipt('configure', index, {
        id,
        revision: 1,
        desiredDigest: digestDesired(desired(id)),
      })
      state.connections.push({ desired: desired(id), revision: 1 })
      state.mutations.push({
        mutationId: configured.mutationId,
        requestDigest: digestCanonical({ id }),
        receipt: configured,
      })
    }

    normalizeStoredState(state)
    expect(state.connections.map(record => record.desired.id)).toEqual(['A', 'a', 'a-', 'a_'])
    expect(parseStateEnvelope(serializeStateEnvelope(state), 'connections.json')
      .connections.map(record => record.desired.id)).toEqual(['A', 'a', 'a-', 'a_'])

    const equal = emptyStoredState()
    equal.connections.push(
      { desired: desired('same'), revision: 1 },
      { desired: desired('same'), revision: 1 },
    )
    normalizeStoredState(equal)
    expect(equal.connections.map(record => record.desired.id)).toEqual(['same', 'same'])
  })

  it('includes own __proto__ env and header values in every canonical digest', () => {
    const stdio = (value: string) => parseMcpConnectionDesired({
      id: 'proto-stdio',
      enabled: false,
      transport: {
        transport: 'stdio',
        command: 'node',
        args: [],
        env: prototypeKeyMap(value),
        cwd: '',
        toolCallTimeoutMs: 1_000,
        reconnect,
      },
    })
    const http = (value: string) => parseMcpConnectionDesired({
      id: 'proto-http',
      enabled: false,
      transport: {
        transport: 'streamable-http',
        url: 'https://mcp.example.test/',
        headers: prototypeKeyMap(value),
        redirect: 'error',
        toolCallTimeoutMs: 1_000,
        reconnect,
      },
    })
    expect(digestDesired(stdio('one'))).not.toBe(digestDesired(stdio('two')))
    expect(digestDesired(http('one'))).not.toBe(digestDesired(http('two')))

    const state = emptyStoredState()
    state.revision = 1
    const original = stdio('original')
    state.connections.push({ desired: original, revision: 1 })
    const configured = receipt('configure', 0, {
      id: 'proto-stdio',
      desiredDigest: digestDesired(original),
    })
    state.mutations.push({
      mutationId: configured.mutationId,
      requestDigest: digestCanonical({ configured: true }),
      receipt: configured,
    })
    const serialized = serializeStateEnvelope(state)
    const tampered = JSON.parse(serialized) as {
      state: { connections: Array<{ desired: { transport: { env: Record<string, string> } } }> }
    }
    tampered.state.connections[0]!.desired.transport.env['__proto__'] = 'tampered'
    expect(() => parseStateEnvelope(JSON.stringify(tampered), 'connections.json'))
      .toThrow(/state digest mismatch/)
  })

  it('accepts a no-op mutation that advances only the global commit revision', () => {
    const state = emptyStoredState()
    const configured = receipt('configure', 0)
    const unchanged: McpConnectionMutationReceipt = {
      ...receipt('enable', 1),
      previousRevision: 1,
      revision: 1,
      changed: false,
    }
    state.revision = 2
    state.connections.push({ desired: desired('receipt-lifecycle'), revision: 1 })
    state.mutations.push(
      { mutationId: configured.mutationId, requestDigest: digestCanonical({ configured: true }), receipt: configured },
      { mutationId: unchanged.mutationId, requestDigest: digestCanonical({ unchanged: true }), receipt: unchanged },
    )
    expect(parseStateEnvelope(serializeStateEnvelope(state), 'connections.json').mutations[1]?.receipt)
      .toEqual(unchanged)
  })

  it('rejects checksum-valid active and removed records outside canonical id order', () => {
    const active = baseState()
    expect(() => parseStateEnvelope(envelope(active), 'connections.json'))
      .toThrow(/durable connections records are not sorted by id/)

    normalizeStoredState(active)
    active.removed.reverse()
    expect(() => parseStateEnvelope(envelope(active), 'connections.json'))
      .toThrow(/durable removed records are not sorted by id/)
  })

  it.each([
    ['invalid JSON', '{', /invalid JSON state envelope/],
    ['non-object envelope', '[]', /must be an object/],
    ['unsupported envelope version', envelope(emptyStoredState(), { formatVersion: 2 }), /unsupported state envelope version/],
    ['non-digest envelope', envelope(emptyStoredState(), { digest: 'nope' }), /invalid state digest/],
    ['mismatched digest', envelope(emptyStoredState(), { digest: '0'.repeat(64) }), /state digest mismatch/],
    ['extra envelope field', JSON.stringify({
      formatVersion: 1,
      state: emptyStoredState(),
      digest: digestCanonical(emptyStoredState()),
      extra: true,
    }), /extra is not supported/],
    ['missing envelope field', JSON.stringify({ formatVersion: 1, state: emptyStoredState() }), /digest is required/],
  ] as const)('rejects %s', (_label, text, diagnostic) => {
    expect(() => parseStateEnvelope(text, 'connections.json')).toThrow(diagnostic)
  })

  it('rejects every malformed desired-state relationship and scalar field', () => {
    const cases: Array<readonly [string, (state: Record<string, unknown>) => void, RegExp]> = [
      ['state version', (state) => { state.formatVersion = 2 }, /unsupported desired-state version/],
      ['negative global revision', (state) => { state.revision = -1 }, /non-negative safe integer/],
      ['connections type', (state) => { state.connections = {} }, /connections must be an array/],
      ['removed type', (state) => { state.removed = {} }, /removed must be an array/],
      ['mutations type', (state) => { state.mutations = {} }, /mutations must be an array/],
      ['state extra field', (state) => { state.extra = true }, /extra is not supported/],
      ['state missing field', (state) => { delete state.revision }, /revision is required/],
      ['connection record type', (state) => { state.connections = [null] }, /connections\[0\] must be an object/],
      ['connection revision', (state) => {
        const connections = state.connections as Array<Record<string, unknown>>
        connections[0]!.revision = 0
      }, /positive safe integer/],
      ['duplicate connection', (state) => {
        const connections = state.connections as unknown[]
        connections.push(structuredClone(connections[0]))
      }, /duplicate connection id/],
      ['record ahead of global revision', (state) => { state.revision = 0 }, /revision exceeds the global revision/],
      ['removed revision ahead of global revision', (state) => {
        const removed = state.removed as Array<Record<string, unknown>>
        removed[0]!.removedAtRevision = 15
      }, /removed connection.*exceeds the global revision/],
      ['duplicate mutation', (state) => {
        const mutations = state.mutations as unknown[]
        mutations.push(structuredClone(mutations[0]))
      }, /duplicate mutation id/],
      ['mutation snapshot is not commit-order contiguous', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[0]!.receipt.snapshotRevision = 8
      }, /snapshot revision is not commit-order contiguous/],
      ['final mutation snapshot differs from global revision', (state) => {
        state.revision = 15
      }, /final mutation snapshot revision does not match the global revision/],
      ['mutation record type', (state) => { state.mutations = [null] }, /mutations\[0\] must be an object/],
      ['mutation id type', (state) => {
        const mutations = state.mutations as Array<Record<string, unknown>>
        mutations[0]!.mutationId = 1
      }, /mutationId must be a string/],
      ['request digest', (state) => {
        const mutations = state.mutations as Array<Record<string, unknown>>
        mutations[0]!.requestDigest = 'bad'
      }, /requestDigest must be a SHA-256 digest/],
      ['receipt mutation mismatch', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[0]!.receipt.mutationId = 'different'
      }, /receipt mutation id does not match/],
      ['receipt type', (state) => {
        const mutations = state.mutations as Array<Record<string, unknown>>
        mutations[0]!.receipt = null
      }, /receipt must be an object/],
      ['receipt mutation id type', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[0]!.receipt.mutationId = 1
      }, /receipt\.mutationId must be a string/],
      ['receipt connection id type', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[0]!.receipt.id = 1
      }, /receipt\.id must be a string/],
      ['receipt operation', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[0]!.receipt.operation = 'replace'
      }, /operation is not supported/],
      ['receipt changed type', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[0]!.receipt.changed = 'yes'
      }, /changed must be a boolean/],
      ['receipt desired digest', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[0]!.receipt.desiredDigest = 'bad'
      }, /desiredDigest must be a SHA-256 digest or null/],
      ['non-purge null digest', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[0]!.receipt.desiredDigest = null
      }, /desiredDigest must be null exactly for purge/],
      ['purge non-null digest', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[7]!.receipt.desiredDigest = 'a'.repeat(64)
      }, /desiredDigest must be null exactly for purge/],
      ['receipt revision', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[0]!.receipt.revision = 0
      }, /positive safe integer/],
      ['receipt previous revision', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[1]!.receipt.previousRevision = 0
      }, /positive safe integer/],
      ['configure previous revision', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[0]!.receipt.previousRevision = 1
      }, /previousRevision must be absent for configure/],
      ['configure unchanged', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[0]!.receipt.changed = false
      }, /configure must create changed revision 1/],
      ['configure record revision', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[0]!.receipt.revision = 2
      }, /configure must create changed revision 1/],
      ['non-configure missing previous revision', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        delete mutations[1]!.receipt.previousRevision
      }, /previousRevision is required outside configure/],
      ['unchanged record revision advances', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[1]!.receipt.changed = false
      }, /revision does not follow previousRevision and changed/],
      ['changed record revision does not advance', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[1]!.receipt.revision = 1
      }, /revision does not follow previousRevision and changed/],
      ...([['remove', 4], ['restore', 5], ['purge', 7]] as const).map(([operation, index]) => [
        `${operation} unchanged`,
        (state: Record<string, unknown>) => {
          const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
          const receipt = mutations[index]!.receipt
          receipt.changed = false
          receipt.revision = receipt.previousRevision
        },
        new RegExp(`${operation} must report changed`),
      ] as const),
      ['history operation without an existing record', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[1]!.receipt.id = 'missing'
      }, /mutation history revision.*unreachable/],
      ['history configures an existing record', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        const duplicate = mutations[1]!.receipt
        duplicate.operation = 'configure'
        delete duplicate.previousRevision
        duplicate.revision = 1
      }, /mutation history cannot configure existing connection/],
      ['history updates a removed record', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[5]!.receipt.operation = 'update'
      }, /mutation history cannot update connection/],
      ['history remove changes desired state', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[4]!.receipt.desiredDigest = 'a'.repeat(64)
      }, /mutation history cannot remove/],
      ['history restores an active record', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[1]!.receipt.operation = 'restore'
      }, /mutation history cannot restore connection/],
      ['history purges an active record', (state) => {
        const mutations = state.mutations as Array<{ receipt: Record<string, unknown> }>
        mutations[1]!.receipt.operation = 'purge'
        mutations[1]!.receipt.desiredDigest = null
      }, /mutation history cannot purge connection/],
      ['active inventory revision differs from history', (state) => {
        const connections = state.connections as Array<Record<string, unknown>>
        connections[0]!.revision = 2
      }, /final inventory.*does not match mutation history/],
      ['removed inventory commit revision differs from history', (state) => {
        const removed = state.removed as Array<Record<string, unknown>>
        removed[0]!.removedAtRevision = 13
      }, /final inventory.*does not match mutation history/],
      ['inventory omits a replayed record', (state) => {
        const connections = state.connections as unknown[]
        connections.splice(0, 1)
      }, /final inventory does not match mutation history/],
    ]

    for (const [label, edit, diagnostic] of cases) {
      const state = rawBase()
      edit(state)
      expect(() => parseRawState(state), label).toThrow(diagnostic)
    }
  })
})
