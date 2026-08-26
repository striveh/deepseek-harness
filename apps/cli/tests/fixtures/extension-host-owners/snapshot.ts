/** Assembled Extension Management Host owner and managed MCP provenance fixture. */

import { fileURLToPath } from 'node:url'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import {
  CallId,
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  mcpConnectionId,
  mcpConnectionMutationId,
  parseMcpConnectionDesired,
} from '@deepseek-ai/dsh-mcp-connections'
import { profileId } from '@deepseek-ai/dsh-profile-transactions'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  taskContinuationRevision,
  taskContinuationVerifierId,
} from '@deepseek-ai/dsh-task-continuation'
import { queryServiceApi } from '@deepseek-ai/dsh-tool-cordis/src/api-catalog.ts'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

const rootConfigPath = fileURLToPath(
  new URL('../../../../../packages/bundle/base/tests/fixtures/root.cordis.yml', import.meta.url),
)
const basePatchPath = fileURLToPath(
  new URL('../../../../../packages/bundle/base/cordis.patch.yml', import.meta.url),
)
const installAnchor = fileURLToPath(new URL('../../../package.json', import.meta.url))
const fixtureServerPath = fileURLToPath(
  new URL('../../../../../packages/mcp/mcp-connections-local/tests/fixture-server.ts', import.meta.url),
)
const sessionId = SessionId('extension-host-owners-continuation')
const provider = 'extension-host-snapshot'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'snapshot complete' },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function bootHost(): ReturnType<typeof boot> {
  return boot(
    'extension-host-owners-snapshot',
    rootConfigPath,
    loadOverlayPatches('extension-host-owners-snapshot', basePatchPath),
    (hostCtx) => { hostCtx.provide('dshInstallAnchor', installAnchor) },
  )
}

async function eventually<T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const firstRun = await (async () => {
  const ctx = await bootHost()
  try {
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter([provider], adapter)
    const handle = await ctx.agents.create({
      sessionId,
      agentOptions: { provider, model: 'snapshot' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'Complete the extension installation task.' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    await ctx.sessions.flush(handle.agent.session)

    type ContinuationRequest = Parameters<typeof ctx.taskContinuations.create>[1]
    const pending = await ctx.taskContinuations.create(handle.agent, {
      callerId: 'extension-host-snapshot' as ContinuationRequest['callerId'],
      mutationId: 'restart-recovery' as ContinuationRequest['mutationId'],
      sessionId,
      originalMessageId: original.id,
      needDigest: `sha256:${'a'.repeat(64)}` as ContinuationRequest['needDigest'],
      taskRevision: taskContinuationRevision('extension-host-r1'),
      verifierId: taskContinuationVerifierId('extension-host-verifier'),
      verificationPayloadDigest: `sha256:${'b'.repeat(64)}` as ContinuationRequest['verificationPayloadDigest'],
      expiresAtMs: Date.now() + 300_000,
    })

    const connection = mcpConnectionId('snapshot')
    const configured = await ctx.mcpConnections.configure({
      desired: parseMcpConnectionDesired({
        id: connection,
        enabled: true,
        transport: {
          transport: 'stdio',
          command: process.execPath,
          args: [fixtureServerPath, 'managed'],
          env: {},
          cwd: '',
          toolCallTimeoutMs: 10_000,
          reconnect: { enabled: true, initialDelayMs: 10, maxDelayMs: 100, maxAttempts: 3 },
        },
      }),
      mutationId: mcpConnectionMutationId('snapshot-configure'),
      expectedRevision: 0,
    })

    ctx.tools.register(defineContentToolFixture({
      name: 'mcp__snapshot__foreign',
      description: 'Unmanaged same-prefix snapshot fixture.',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'foreign' }] },
    }))

    const beforeDisable = ctx.mcpConnections.get(connection)
    const managedCall = await ctx.tools.execute({
      callId: CallId('extension-host-owners-snapshot'),
      name: 'mcp__snapshot__managed',
      arguments: {},
      signal: new AbortController().signal,
    })
    const serviceMethods: Record<string, string[]> = {}
    const serviceMounted: Record<string, boolean> = {}
    for (const key of ['mcpConnections', 'profileTransactions', 'taskContinuations']) {
      const result = queryServiceApi(key) as { service: { key: string; methods: Array<{ signature: string }> } }
      serviceMethods[result.service.key] = result.service.methods.map(method => method.signature)
      serviceMounted[key] = ctx.get(key) !== undefined
    }

    const profile = await ctx.profileTransactions.snapshot(profileId('web'))
    const schemasBeforeDisable = ctx.tools.schemas()
      .filter(schema => schema.name.startsWith('mcp__snapshot__'))
      .map(schema => ({ name: schema.name, description: schema.description, parameters: schema.parameters }))

    await ctx.mcpConnections.disable({
      id: connection,
      mutationId: mcpConnectionMutationId('snapshot-disable'),
      expectedRevision: configured.revision,
    })
    const afterDisable = ctx.mcpConnections.get(connection)
    const schemaNamesAfterDisable = ctx.tools.schemas()
      .map(schema => schema.name)
      .filter(name => name.startsWith('mcp__snapshot__'))

    return {
      pending,
      evidence: {
        protocols: {
          profileTransactions: ctx.profileTransactions.protocolVersion,
          mcpConnections: ctx.mcpConnections.protocolVersion,
          taskContinuations: ctx.taskContinuations.protocolVersion,
        },
        profile: {
          revision: profile.revision,
          activeGeneration: profile.activeGeneration,
          bootStatus: profile.bootStatus,
        },
        serviceMounted,
        serviceMethods,
        mcp: {
          beforeDisable: beforeDisable === undefined ? null : {
            revision: beforeDisable.revision,
            observed: beforeDisable.observed.state,
            ownedTools: beforeDisable.tools.names,
          },
          schemasBeforeDisable,
          managedCall: { isError: managedCall.isError, content: managedCall.content },
          afterDisable: afterDisable === undefined ? null : {
            revision: afterDisable.revision,
            observed: afterDisable.observed.state,
            ownedTools: afterDisable.tools.names,
          },
          schemaNamesAfterDisable,
        },
      },
    }
  } finally {
    await ctx.fiber.dispose()
  }
})()

const ctx = await bootHost()
try {
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter([provider], adapter)
  ctx.taskContinuations.registerVerifier({
    id: taskContinuationVerifierId('extension-host-verifier'),
    verify: claim => Promise.resolve({
      kind: 'ready',
      continuationId: claim.continuationId,
      sessionId: claim.sessionId,
      originalMessageId: claim.originalMessageId,
      needDigest: claim.needDigest,
      taskRevision: claim.taskRevision,
      verificationPayloadDigest: claim.verificationPayloadDigest,
    }),
  })

  const claimed = await eventually(
    () => ctx.taskContinuations.get(firstRun.pending.continuationId)
      .then(claim => claim?.state === 'claimed' ? claim : undefined),
    'recovered continuation claim',
  )
  const resumed = await eventually(() => ctx.agents.get(sessionId), 'cold-resumed continuation Agent')
  await resumed.whenIdle()
  await ctx.sessions.flush(resumed.session)

  const modelRequests = adapter.requests.filter(request => request.purpose === undefined)
  if (modelRequests.length !== 1 || modelRequests[0] === undefined) {
    throw new Error(`expected one recovered model request, received ${String(modelRequests.length)}`)
  }
  const dispatchEvents = resumed.session.events.filter(event => event.type === 'user/message'
    && event.data.source.kind === 'task-continuation')
  if (dispatchEvents.length !== 1) {
    throw new Error(`expected one durable continuation dispatch, received ${String(dispatchEvents.length)}`)
  }

  process.stdout.write(`${JSON.stringify({
    ...firstRun.evidence,
    continuation: {
      beforeRestart: firstRun.pending.state,
      afterRestart: claimed.state,
      modelRequestCount: modelRequests.length,
      dispatchEventCount: dispatchEvents.length,
      messageSequence: modelRequests[0].messages.map(message => ({
        role: message.role,
        source: message.source.kind,
      })),
      taskContinuationMessages: modelRequests[0].messages.flatMap((message) => {
        if (message.source.kind !== 'task-continuation') return []
        const source = message.source
        return [{
          role: message.role,
          content: message.content,
          source: {
            kind: source.kind,
            taskRevision: source.taskRevision,
            verifierId: source.verifierId,
          },
        }]
      }),
    },
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
