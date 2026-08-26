/** Keyless clean-shutdown restart evidence through the real Agent and JSONL persistence. */

import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  TaskContinuationMutationConflictError,
  TaskContinuationService,
  continuationDigest,
  taskContinuationCallerId,
  taskContinuationMutationId,
  taskContinuationRevision,
  taskContinuationVerifierId,
  type TaskContinuationClaim,
  type TaskContinuationReady,
} from '@deepseek-ai/dsh-task-continuation'
import DurableTaskContinuationDriver, { type Config } from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []
const CONTINUATION_CALLER = taskContinuationCallerId('extension-center')

function mutation(id: string) {
  return {
    callerId: CONTINUATION_CALLER,
    mutationId: taskContinuationMutationId(id),
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'done' },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class SecondRequestPausingAdapter extends RecordingAdapter {
  readonly paused = Promise.withResolvers<undefined>()

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.requests.length !== 1) {
      yield* super.stream(options)
      return
    }
    this.requests.push(options)
    this.paused.resolve(undefined)
    if (options.signal?.aborted !== true) {
      const aborted = Promise.withResolvers<undefined>()
      options.signal?.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      await aborted.promise
    }
  }
}

async function allocateRoots(): Promise<{ sessions: string; claims: string }> {
  const sessions = await mkdtemp(join(tmpdir(), 'dsh-continuation-sessions-'))
  const claims = await mkdtemp(join(tmpdir(), 'dsh-continuation-claims-'))
  roots.push(sessions, claims)
  return { sessions, claims }
}

async function mountRuntime(
  rootsForRuntime: { sessions: string; claims: string },
  adapter: RecordingAdapter,
  config: Omit<Config, 'root'> = {},
  beforeDriver?: (context: Context) => void,
): Promise<Context> {
  const context = new Context()
  contexts.push(context)
  await mountAgentLoopTestDependencies(context)
  await context.plugin(AgentLoop, { agents: [] })
  await context.plugin(JsonlSessionPersistence, { root: rootsForRuntime.sessions, compression: 'none' })
  context.llm.registerAdapter(['mock'], adapter)
  beforeDriver?.(context)
  await context.plugin(DurableTaskContinuationDriver, { ...config, root: rootsForRuntime.claims })
  return context
}

async function disposeContext(context: Context): Promise<void> {
  const index = contexts.indexOf(context)
  if (index >= 0) contexts.splice(index, 1)
  await context.fiber.dispose()
}

async function eventually<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function ready(claim: TaskContinuationClaim): TaskContinuationReady {
  return {
    kind: 'ready',
    continuationId: claim.continuationId,
    sessionId: claim.sessionId,
    originalMessageId: claim.originalMessageId,
    needDigest: claim.needDigest,
    taskRevision: claim.taskRevision,
    verificationPayloadDigest: claim.verificationPayloadDigest,
  }
}

async function seedColdClaims(
  runtimeRoots: { sessions: string; claims: string },
  suffix: string,
  count: number = 1,
  expiresAtMs: number = Date.now() + 60_000,
): Promise<{ claims: TaskContinuationClaim[]; original: ReturnType<typeof createUserMessage>; sessionId: SessionId }> {
  const context = await mountRuntime(runtimeRoots, new RecordingAdapter())
  const sessionId = SessionId(`task-continuation-cold-${suffix}`)
  const handle = await context.agents.create({
    sessionId,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const original = createUserMessage({
    content: [{ type: 'text', text: `cold task ${suffix}` }],
    source: { kind: 'user' },
  })
  handle.agent.followup(original)
  await handle.agent.whenIdle()
  const claims: TaskContinuationClaim[] = []
  for (let index = 0; index < count; index += 1) {
    claims.push(await context.taskContinuations.create(handle.agent, {
      ...mutation(`${suffix}-${String(index)}`),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${String(index + 1).padStart(64, '0')}`),
      taskRevision: taskContinuationRevision(`${suffix}-r${String(index + 1)}`),
      verifierId: taskContinuationVerifierId(`${suffix}-verifier-${String(index)}`),
      verificationPayloadDigest: continuationDigest(`sha256:${String(index + 2).padStart(64, '0')}`),
      expiresAtMs,
    }))
  }
  await context.sessions.flush(handle.agent.session)
  await disposeContext(context)
  return { claims, original, sessionId }
}

function captureColdDisposals(disposals: Array<ReturnType<typeof vi.fn>>) {
  return (context: Context): void => {
    const resume = context.agents.resume.bind(context.agents)
    vi.spyOn(context.agents, 'resume').mockImplementation(async (options) => {
      const handle = await resume(options)
      const dispose = vi.fn(handle.dispose.bind(handle))
      disposals.push(dispose)
      return { agent: handle.agent, dispose }
    })
  }
}

describe('durable task continuation restart', () => {
  it('publishes a literal protocol revision and rejects same-name or wrong-version probes', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots, new RecordingAdapter())
    const supportsTaskContinuations = (value: unknown): value is TaskContinuationService =>
      value instanceof TaskContinuationService && value.protocolVersion === 1
    expect(supportsTaskContinuations(context.taskContinuations)).toBe(true)
    expect(supportsTaskContinuations({ name: 'taskContinuations', protocolVersion: 1 })).toBe(false)
    const wrongVersion = Object.create(TaskContinuationService.prototype) as { protocolVersion: number }
    wrongVersion.protocolVersion = 2
    expect(supportsTaskContinuations(wrongVersion)).toBe(false)
  })

  it('rejects unbounded live and cold Agent routes before durable reservation or Agent resolution', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots, new RecordingAdapter())
    const liveSessionId = SessionId('task-continuation-unbounded-live-route')
    const live = await context.agents.create({
      sessionId: liveSessionId,
      agentOptions: { provider: 'p'.repeat(257), model: 'mock' },
    })
    const originalMessageId = createUserMessage({
      content: [{ type: 'text', text: 'not admitted' }],
      source: { kind: 'user' },
    }).id
    const base = {
      ...mutation('unbounded-live-route'),
      sessionId: liveSessionId,
      originalMessageId,
      needDigest: continuationDigest(`sha256:${'1'.repeat(64)}`),
      taskRevision: taskContinuationRevision('unbounded-route-r1'),
      verifierId: taskContinuationVerifierId('bounded-route-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'2'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
    } as const
    await expect(context.taskContinuations.create(live.agent, base))
      .rejects.toThrow(/provider must be 1-256 UTF-8 bytes/)
    await expect(context.taskContinuations.list()).resolves.toEqual([])
    await expect(access(join(runtimeRoots.claims, 'claims.sqlite'))).rejects.toThrow()

    const coldSessionId = SessionId('task-continuation-unbounded-cold-route')
    await expect(context.taskContinuations.reserve({
      ...base,
      ...mutation('unbounded-cold-model'),
      sessionId: coldSessionId,
      resumeAgentOptions: { provider: 'mock', model: 'm'.repeat(257) },
    })).rejects.toThrow(/model must be 1-256 UTF-8 bytes/)
    await expect(context.taskContinuations.reserve({
      ...base,
      ...mutation('unbounded-cold-tokens'),
      sessionId: coldSessionId,
      resumeAgentOptions: { provider: 'mock', model: 'mock', maxTokens: 1_000_001 },
    })).rejects.toThrow(/maxTokens must be an integer from 1 to 1000000/)
    expect(context.agents.get(coldSessionId)).toBeUndefined()
    await expect(context.taskContinuations.list()).resolves.toEqual([])
    await expect(access(join(runtimeRoots.claims, 'claims.sqlite'))).rejects.toThrow()
  })

  it('cold-reserves after an approval restart and idempotently reconciles a reserve-to-caller-record crash', async () => {
    const runtimeRoots = await allocateRoots()
    const sessionId = SessionId('task-continuation-cold-reservation')
    const first = await mountRuntime(runtimeRoots, new RecordingAdapter())
    const handle = await first.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'approved task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    await first.sessions.flush(handle.agent.session)
    await disposeContext(first)

    const reservation = {
      ...mutation('cold-reservation-operation'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'6'.repeat(64)}`),
      taskRevision: taskContinuationRevision('cold-reservation-r1'),
      verifierId: taskContinuationVerifierId('cold-reservation-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'7'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
      resumeAgentOptions: { provider: 'mock', model: 'mock' },
    } as const
    const second = await mountRuntime(runtimeRoots, new RecordingAdapter())
    const reserved = await second.taskContinuations.reserve(reservation)
    expect(reserved).toMatchObject({ state: 'pending', ...mutation('cold-reservation-operation') })
    await disposeContext(second)

    const thirdAdapter = new RecordingAdapter()
    const third = await mountRuntime(runtimeRoots, thirdAdapter)
    const replayed = await third.taskContinuations.reserve(reservation)
    expect(replayed.continuationId).toBe(reserved.continuationId)
    expect(replayed.dispatchMessageId).toBe(reserved.dispatchMessageId)
    await expect(third.taskContinuations.list(mutation('cold-reservation-operation')))
      .resolves.toEqual([expect.objectContaining({ continuationId: reserved.continuationId })])
    third.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('cold-reservation-verifier'),
      verify: claim => Promise.resolve(ready(claim)),
    })
    await eventually(
      () => third.taskContinuations.get(reserved.continuationId)
        .then(claim => claim?.state === 'claimed' ? claim : undefined),
      'cold reservation dispatch',
    )
    await eventually(() => thirdAdapter.requests.length === 1 ? true : undefined, 'cold reservation model request')
    expect(thirdAdapter.requests).toHaveLength(1)
    await eventually(() => third.agents.get(sessionId) === undefined ? true : undefined, 'cold reservation Agent release')
  })

  it('coalesces concurrent caller-key reservations and rejects a different-payload replay', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots, new RecordingAdapter())
    const sessionId = SessionId('task-continuation-concurrent-reservation')
    const handle = await context.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    const reservation = {
      ...mutation('concurrent-reservation-operation'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'8'.repeat(64)}`),
      taskRevision: taskContinuationRevision('concurrent-reservation-r1'),
      verifierId: taskContinuationVerifierId('concurrent-reservation-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'9'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
      resumeAgentOptions: { provider: 'mock', model: 'mock' },
    } as const
    const results = await Promise.all([
      context.taskContinuations.reserve(reservation),
      context.taskContinuations.reserve(reservation),
    ])
    expect(results[1]?.continuationId).toBe(results[0]?.continuationId)
    await expect(context.taskContinuations.list(mutation('concurrent-reservation-operation')))
      .resolves.toHaveLength(1)
    await expect(context.taskContinuations.reserve({
      ...reservation,
      needDigest: continuationDigest(`sha256:${'a'.repeat(64)}`),
    })).rejects.toBeInstanceOf(TaskContinuationMutationConflictError)
    await expect(context.taskContinuations.list(mutation('concurrent-reservation-operation')))
      .resolves.toHaveLength(1)
  })

  it('holds every concurrent caller-key replay through a failed first marker checkpoint', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots, new RecordingAdapter())
    const sessionId = SessionId('task-continuation-concurrent-reservation-flush-fault')
    const handle = await context.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'task with checkpoint fault' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    const reservation = {
      ...mutation('concurrent-reservation-flush-fault'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'d'.repeat(64)}`),
      taskRevision: taskContinuationRevision('concurrent-reservation-flush-fault-r1'),
      verifierId: taskContinuationVerifierId('concurrent-reservation-flush-fault-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'e'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
      resumeAgentOptions: { provider: 'mock', model: 'mock' },
    } as const
    const originalFlush = context.sessions.flush.bind(context.sessions)
    const firstFlush = Promise.withResolvers<boolean>()
    const flushStarted = Promise.withResolvers<undefined>()
    vi.spyOn(context.sessions, 'flush')
      .mockImplementationOnce(async () => {
        flushStarted.resolve(undefined)
        return firstFlush.promise
      })
      .mockImplementation(session => originalFlush(session))

    const first = context.taskContinuations.reserve(reservation)
    await flushStarted.promise
    const second = context.taskContinuations.reserve(reservation)
    let secondSettled = false
    void second.then(
      () => { secondSettled = true },
      () => { secondSettled = true },
    )
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(secondSettled).toBe(false)

    const primary = new Error('first marker checkpoint failed')
    firstFlush.reject(primary)
    const results = await Promise.allSettled([first, second])
    expect(results).toEqual([
      { status: 'rejected', reason: primary },
      { status: 'rejected', reason: primary },
    ])
    await expect(context.taskContinuations.list(mutation('concurrent-reservation-flush-fault')))
      .resolves.toEqual([expect.objectContaining({ state: 'invalid' })])
  })

  it('shares one cold Agent resume across concurrent distinct caller-key reservations', async () => {
    const runtimeRoots = await allocateRoots()
    const sessionId = SessionId('task-continuation-concurrent-cold-reservation')
    const first = await mountRuntime(runtimeRoots, new RecordingAdapter())
    const handle = await first.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'persisted concurrent task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    await first.sessions.flush(handle.agent.session)
    await disposeContext(first)

    const second = await mountRuntime(runtimeRoots, new RecordingAdapter())
    const originalResume = second.agents.resume.bind(second.agents)
    const resumeRelease = Promise.withResolvers<undefined>()
    const resumeStarted = Promise.withResolvers<undefined>()
    const resume = vi.spyOn(second.agents, 'resume').mockImplementation(async (options) => {
      resumeStarted.resolve(undefined)
      await resumeRelease.promise
      return originalResume(options)
    })
    const reservation = {
      ...mutation('concurrent-cold-reservation-operation'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'b'.repeat(64)}`),
      taskRevision: taskContinuationRevision('concurrent-cold-reservation-r1'),
      verifierId: taskContinuationVerifierId('concurrent-cold-reservation-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'c'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
      resumeAgentOptions: { provider: 'mock', model: 'mock' },
    } as const
    const firstReservation = second.taskContinuations.reserve(reservation)
    await resumeStarted.promise
    const secondReservation = second.taskContinuations.reserve({
      ...reservation,
      ...mutation('concurrent-cold-reservation-operation-2'),
    })
    let secondSettled = false
    void secondReservation.then(
      () => { secondSettled = true },
      () => { secondSettled = true },
    )
    await Promise.resolve()
    expect(resume).toHaveBeenCalledTimes(1)
    expect(secondSettled).toBe(false)
    resumeRelease.resolve(undefined)

    const results = await Promise.all([firstReservation, secondReservation])
    expect(results[1]?.continuationId).not.toBe(results[0]?.continuationId)
    expect(second.agents.list().filter(agent => agent.id === sessionId)).toHaveLength(1)
    await expect(second.taskContinuations.list(mutation('concurrent-cold-reservation-operation')))
      .resolves.toHaveLength(1)
    await expect(second.taskContinuations.list(mutation('concurrent-cold-reservation-operation-2')))
      .resolves.toHaveLength(1)
  })

  it('fully disposes, cold-resumes, and dispatches the same claim exactly once', async () => {
    const runtimeRoots = await allocateRoots()
    const sessionId = SessionId('task-continuation-clean-restart')
    const firstAdapter = new RecordingAdapter()
    const first = await mountRuntime(runtimeRoots, firstAdapter)
    const handle = await first.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'original private task text' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    await first.sessions.flush(handle.agent.session)
    expect(firstAdapter.requests).toHaveLength(1)

    const pending = await first.taskContinuations.create(handle.agent, {
      ...mutation('clean-restart'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'e'.repeat(64)}`),
      taskRevision: taskContinuationRevision('task-revision-1'),
      verifierId: taskContinuationVerifierId('extension-receipt'),
      verificationPayloadDigest: continuationDigest(`sha256:${'f'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
    })
    expect(pending.state).toBe('pending')

    await disposeContext(first)

    const secondAdapter = new RecordingAdapter()
    const second = await mountRuntime(runtimeRoots, secondAdapter)
    second.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('extension-receipt'),
      verify: claim => Promise.resolve(ready(claim)),
    })
    try {
      await eventually(
        () => secondAdapter.requests.length === 1 ? secondAdapter.requests[0] : undefined,
        'one continuation model request',
      )
    } catch (error: unknown) {
      const diagnostic = await second.taskContinuations.get(pending.continuationId)
      const live = second.agents.get(sessionId)
      throw new Error(`restart diagnostic: claim=${JSON.stringify(diagnostic)}, agents=${second.agents.list().map(agent => `${agent.id}:${agent.status}`).join(',')}, tail=${JSON.stringify(live?.session.events.slice(-8))}`, { cause: error })
    }
    await expect(second.taskContinuations.get(pending.continuationId)).resolves.toMatchObject({
      state: 'claimed',
      dispatchMessageId: pending.dispatchMessageId,
      recordRevision: 3,
    })
    expect(secondAdapter.requests).toHaveLength(1)
    await eventually(() => second.agents.get(sessionId) === undefined ? true : undefined, 'cold-resumed Agent release')

    await disposeContext(second)

    const thirdAdapter = new RecordingAdapter()
    const third = await mountRuntime(runtimeRoots, thirdAdapter)
    const replayHandle = await third.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await replayHandle.agent.whenIdle()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(thirdAdapter.requests).toEqual([])
    await expect(third.taskContinuations.get(pending.continuationId)).resolves.toMatchObject({
      state: 'claimed',
      recordRevision: 3,
    })
  })

  it('retries a consumed intent after a pre-step fault before user-message persistence', async () => {
    const runtimeRoots = await allocateRoots()
    const adapter = new RecordingAdapter()
    const context = await mountRuntime(runtimeRoots, adapter)
    const sessionId = SessionId('task-continuation-pre-step-fault')
    const handle = await context.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    const pending = await context.taskContinuations.create(handle.agent, {
      ...mutation('pre-step-fault'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'0'.repeat(64)}`),
      taskRevision: taskContinuationRevision('fault-r1'),
      verifierId: taskContinuationVerifierId('fault-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'1'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
    })
    let throwOnce = true
    context.on('agent/pre-step', async ({ messages }, next) => {
      const decision = await next()
      if (throwOnce && messages.some(message => message.source.kind === 'task-continuation')) {
        throwOnce = false
        throw new Error('fault after downstream continuation admission')
      }
      return decision
    })
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('fault-verifier'),
      verify: claim => Promise.resolve(ready(claim)),
    })

    await eventually(
      () => context.taskContinuations.get(pending.continuationId)
        .then(claim => claim?.state === 'claimed' ? claim : undefined),
      'fault-recovered claimed continuation',
    )
    await handle.agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(handle.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.id === pending.dispatchMessageId)).toHaveLength(1)
  })

  it('keeps the pre-model claimed barrier terminal across cold recovery', async () => {
    const runtimeRoots = await allocateRoots()
    const sessionId = SessionId('task-continuation-persisted-dispatch-gap')
    const firstAdapter = new SecondRequestPausingAdapter()
    const first = await mountRuntime(runtimeRoots, firstAdapter)
    const handle = await first.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    const pending = await first.taskContinuations.create(handle.agent, {
      ...mutation('persisted-dispatch-gap'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'2'.repeat(64)}`),
      taskRevision: taskContinuationRevision('persisted-gap-r1'),
      verifierId: taskContinuationVerifierId('persisted-gap-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'3'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
    })
    first.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('persisted-gap-verifier'),
      verify: claim => Promise.resolve(ready(claim)),
    })
    await firstAdapter.paused.promise
    await first.sessions.flush(handle.agent.session)
    await expect(first.taskContinuations.get(pending.continuationId)).resolves.toMatchObject({ state: 'claimed' })
    expect(handle.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.id === pending.dispatchMessageId)).toHaveLength(1)
    await disposeContext(first)

    const secondAdapter = new RecordingAdapter()
    const second = await mountRuntime(runtimeRoots, secondAdapter)
    await eventually(
      () => second.taskContinuations.get(pending.continuationId)
        .then(claim => claim?.state === 'claimed' ? claim : undefined),
      'cold-reconciled persisted dispatch',
    )
    expect(secondAdapter.requests).toEqual([])
    expect(second.agents.get(sessionId)).toBeUndefined()
  })

  it('rejects public terminal mutations after the durable dispatch entered its model request', async () => {
    const runtimeRoots = await allocateRoots()
    const adapter = new SecondRequestPausingAdapter()
    const context = await mountRuntime(runtimeRoots, adapter)
    const sessionId = SessionId('task-continuation-dispatched-terminal-mutation')
    const handle = await context.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    const pending = await context.taskContinuations.create(handle.agent, {
      ...mutation('dispatched-terminal-mutation'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'4'.repeat(64)}`),
      taskRevision: taskContinuationRevision('dispatched-terminal-r1'),
      verifierId: taskContinuationVerifierId('dispatched-terminal-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'5'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
    })
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('dispatched-terminal-verifier'),
      verify: claim => Promise.resolve(ready(claim)),
    })

    await adapter.paused.promise
    await context.sessions.flush(handle.agent.session)
    await expect(context.taskContinuations.get(pending.continuationId)).resolves.toMatchObject({ state: 'claimed' })
    expect(handle.agent.session.events.some(event => event.type === 'user/message'
      && event.data.id === pending.dispatchMessageId)).toBe(true)
    await expect(context.taskContinuations.cancel({
      id: pending.continuationId,
      sessionId,
      taskRevision: pending.taskRevision,
    })).resolves.toBe(false)
    await expect(context.taskContinuations.supersede({
      id: pending.continuationId,
      sessionId,
      taskRevision: pending.taskRevision,
      replacementTaskRevision: taskContinuationRevision('dispatched-terminal-r2'),
    })).resolves.toBe(false)
    await expect(context.taskContinuations.get(pending.continuationId)).resolves.toMatchObject({ state: 'claimed' })
  })

  it('supersedes a continuation when direct-user steering arrives during verifier maintenance', async () => {
    const runtimeRoots = await allocateRoots()
    const adapter = new RecordingAdapter()
    const context = await mountRuntime(runtimeRoots, adapter)
    const sessionId = SessionId('task-continuation-maintenance-steering')
    const handle = await context.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'original task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    const pending = await context.taskContinuations.create(handle.agent, {
      ...mutation('maintenance-steering'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'6'.repeat(64)}`),
      taskRevision: taskContinuationRevision('maintenance-steering-r1'),
      verifierId: taskContinuationVerifierId('maintenance-steering-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'7'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
    })
    const started = Promise.withResolvers<TaskContinuationClaim>()
    const release = Promise.withResolvers<TaskContinuationReady>()
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('maintenance-steering-verifier'),
      verify: (claim) => {
        started.resolve(claim)
        return release.promise
      },
    })
    await started.promise
    const replacement = createUserMessage({
      content: [{ type: 'text', text: 'replacement task' }],
      source: { kind: 'user' },
    })
    handle.agent.steer(replacement)
    release.resolve(ready(pending))

    await eventually(
      () => context.taskContinuations.get(pending.continuationId)
        .then(claim => claim?.state === 'superseded' ? claim : undefined),
      'maintenance-steered supersession',
    )
    await eventually(
      () => adapter.requests.length === 2 ? adapter.requests[1] : undefined,
      'replacement-only model request',
    )
    await handle.agent.whenIdle()
    const secondRequest = JSON.stringify(adapter.requests[1]?.messages)
    expect(secondRequest).toContain('replacement task')
    expect(secondRequest).not.toContain('The requested capability is now verified')
    expect(handle.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.id === pending.dispatchMessageId)).toHaveLength(0)
  })

  it('rechecks expiry after a blocking downstream pre-step listener before model admission', async () => {
    const runtimeRoots = await allocateRoots()
    const adapter = new RecordingAdapter()
    const context = await mountRuntime(runtimeRoots, adapter)
    const sessionId = SessionId('task-continuation-post-next-expiry')
    const handle = await context.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()

    let clock = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const pending = await context.taskContinuations.create(handle.agent, {
      ...mutation('post-next-expiry'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'4'.repeat(64)}`),
      taskRevision: taskContinuationRevision('post-next-expiry-r1'),
      verifierId: taskContinuationVerifierId('post-next-expiry-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'5'.repeat(64)}`),
      expiresAtMs: clock + 100,
    })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    context.on('agent/pre-step', async ({ messages }, next) => {
      if (messages.some(message => message.source.kind === 'task-continuation')) {
        entered.resolve(undefined)
        await release.promise
      }
      return next()
    })
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('post-next-expiry-verifier'),
      verify: claim => Promise.resolve(ready(claim)),
    })
    await entered.promise
    await expect(context.taskContinuations.get(pending.continuationId)).resolves.toMatchObject({ state: 'consumed' })
    clock += 100
    release.resolve(undefined)

    await eventually(
      () => context.taskContinuations.get(pending.continuationId)
        .then(claim => claim?.state === 'expired' ? claim : undefined),
      'post-next expired continuation',
    )
    await handle.agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(handle.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.id === pending.dispatchMessageId)).toHaveLength(0)
  })

  it('turns a wrong verifier revision into zero-dispatch invalid state', async () => {
    const runtimeRoots = await allocateRoots()
    const adapter = new RecordingAdapter()
    const context = await mountRuntime(runtimeRoots, adapter)
    const sessionId = SessionId('task-continuation-wrong-fence')
    const handle = await context.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    const pending = await context.taskContinuations.create(handle.agent, {
      ...mutation('wrong-fence'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'1'.repeat(64)}`),
      taskRevision: taskContinuationRevision('task-r1'),
      verifierId: taskContinuationVerifierId('wrong-revision'),
      verificationPayloadDigest: continuationDigest(`sha256:${'2'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
    })
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('wrong-revision'),
      verify: claim => Promise.resolve({ ...ready(claim), taskRevision: taskContinuationRevision('task-r2') }),
    })
    await eventually(
      () => context.taskContinuations.get(pending.continuationId)
        .then(claim => claim?.state === 'invalid' ? claim : undefined),
      'invalid claim',
    )
    await handle.agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    await expect(context.taskContinuations.cancel({
      id: pending.continuationId,
      sessionId,
      taskRevision: taskContinuationRevision('task-r1'),
    })).resolves.toBe(false)
  })

  it('fences cancellation during verification and expiry before readiness with zero dispatch', async () => {
    const runtimeRoots = await allocateRoots()
    const adapter = new RecordingAdapter()
    const context = await mountRuntime(runtimeRoots, adapter)
    const sessionId = SessionId('task-continuation-cancel-expiry')
    const handle = await context.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()

    const cancelClaim = await context.taskContinuations.create(handle.agent, {
      ...mutation('cancel-during-verification'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'3'.repeat(64)}`),
      taskRevision: taskContinuationRevision('cancel-r1'),
      verifierId: taskContinuationVerifierId('slow-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'4'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
    })
    const started = Promise.withResolvers<TaskContinuationClaim>()
    const release = Promise.withResolvers<TaskContinuationReady>()
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('slow-verifier'),
      verify: (claim) => {
        started.resolve(claim)
        return release.promise
      },
    })
    await started.promise
    await expect(context.taskContinuations.cancel({
      id: cancelClaim.continuationId,
      sessionId,
      taskRevision: taskContinuationRevision('wrong-revision'),
    })).resolves.toBe(false)
    await expect(context.taskContinuations.cancel({
      id: cancelClaim.continuationId,
      sessionId,
      taskRevision: cancelClaim.taskRevision,
    })).resolves.toBe(true)
    release.resolve(ready(cancelClaim))
    await handle.agent.whenIdle()
    await expect(context.taskContinuations.get(cancelClaim.continuationId)).resolves.toMatchObject({
      state: 'canceled',
    })

    const expiryClaim = await context.taskContinuations.create(handle.agent, {
      ...mutation('expiry-before-ready'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'5'.repeat(64)}`),
      taskRevision: taskContinuationRevision('expiry-r1'),
      verifierId: taskContinuationVerifierId('expiry-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'6'.repeat(64)}`),
      expiresAtMs: Date.now() + 20,
    })
    await new Promise<void>(resolve => setTimeout(resolve, 30))
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('expiry-verifier'),
      verify: claim => Promise.resolve(ready(claim)),
    })
    await eventually(
      () => context.taskContinuations.get(expiryClaim.continuationId)
        .then(claim => claim?.state === 'expired' ? claim : undefined),
      'expired claim',
    )
    await handle.agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
  })

  it('cold-supersedes a claim when a newer direct-user message replaced the original task', async () => {
    const runtimeRoots = await allocateRoots()
    const firstAdapter = new SecondRequestPausingAdapter()
    const first = await mountRuntime(runtimeRoots, firstAdapter)
    expect(first.taskContinuations.protocolVersion).toBe(1)
    const sessionId = SessionId('task-continuation-direct-user-supersede')
    const handle = await first.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'original task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    const pending = await first.taskContinuations.create(handle.agent, {
      ...mutation('direct-user-supersede'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'d'.repeat(64)}`),
      taskRevision: taskContinuationRevision('superseded-r1'),
      verifierId: taskContinuationVerifierId('superseded-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'e'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
    })
    const replacement = createUserMessage({
      content: [{ type: 'text', text: 'replacement task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(replacement)
    await firstAdapter.paused.promise
    await first.sessions.flush(handle.agent.session)
    await disposeContext(first)

    const secondAdapter = new RecordingAdapter()
    const second = await mountRuntime(runtimeRoots, secondAdapter)
    second.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('superseded-verifier'),
      verify: claim => Promise.resolve(ready(claim)),
    })
    const superseded = await eventually(
      () => second.taskContinuations.get(pending.continuationId)
        .then(claim => claim?.state === 'superseded' ? claim : undefined),
      'cold superseded claim',
    )
    expect(superseded.supersededByTaskRevision).toMatch(/^message:[0-9a-f]{64}$/)
    expect(secondAdapter.requests).toHaveLength(0)
    await eventually(() => second.agents.get(sessionId) === undefined ? true : undefined, 'superseded cold Agent release')
    const replay = await second.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(replay.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.id === pending.dispatchMessageId)).toHaveLength(0)
    await replay.dispose()
  })

  it('invalidates a stalled verifier and continues another Session without dispatching the stalled claim', async () => {
    const runtimeRoots = await allocateRoots()
    const adapter = new RecordingAdapter()
    const context = await mountRuntime(runtimeRoots, adapter, { verifierTimeoutMs: 50 })
    const createClaim = async (suffix: string): Promise<{ claim: TaskContinuationClaim; sessionId: SessionId }> => {
      const sessionId = SessionId(`task-continuation-timeout-${suffix}`)
      const handle = await context.agents.create({
        sessionId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      const original = createUserMessage({
        content: [{ type: 'text', text: `task ${suffix}` }],
        source: { kind: 'user' },
      })
      handle.agent.followup(original)
      await handle.agent.whenIdle()
      const claim = await context.taskContinuations.create(handle.agent, {
        ...mutation(`verifier-timeout-${suffix}`),
        sessionId,
        originalMessageId: original.id,
        needDigest: continuationDigest(`sha256:${suffix === 'stalled' ? '1'.repeat(64) : '2'.repeat(64)}`),
        taskRevision: taskContinuationRevision(`verifier-timeout-${suffix}-r1`),
        verifierId: taskContinuationVerifierId('bounded-verifier'),
        verificationPayloadDigest: continuationDigest(
          `sha256:${suffix === 'stalled' ? '3'.repeat(64) : '4'.repeat(64)}`,
        ),
        expiresAtMs: Date.now() + 60_000,
      })
      return { claim, sessionId }
    }

    const stalled = await createClaim('stalled')
    const started = Promise.withResolvers<undefined>()
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined)
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('bounded-verifier'),
      verify: (claim) => {
        if (claim.continuationId !== stalled.claim.continuationId) return Promise.resolve(ready(claim))
        started.resolve(undefined)
        return new Promise(() => {})
      },
    })
    await started.promise
    const progressing = await createClaim('progressing')

    await eventually(async () => {
      const [stalledClaim, progressingClaim] = await Promise.all([
        context.taskContinuations.get(stalled.claim.continuationId),
        context.taskContinuations.get(progressing.claim.continuationId),
      ])
      return stalledClaim?.state === 'invalid' && progressingClaim?.state === 'claimed'
        ? [stalledClaim, progressingClaim]
        : undefined
    }, 'bounded verifier recovery across Sessions')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`claim "${stalled.claim.continuationId}"`))
    const stalledAgent = context.agents.get(stalled.sessionId)
    const progressingAgent = context.agents.get(progressing.sessionId)
    expect(stalledAgent?.session.events.some(event => event.type === 'user/message'
      && event.data.id === stalled.claim.dispatchMessageId)).toBe(false)
    expect(progressingAgent?.session.events.filter(event => event.type === 'user/message'
      && event.data.id === progressing.claim.dispatchMessageId)).toHaveLength(1)
    expect(adapter.requests).toHaveLength(3)
  })

  it('serializes two ready claims into one distinct turn each', async () => {
    const runtimeRoots = await allocateRoots()
    const adapter = new RecordingAdapter()
    const context = await mountRuntime(runtimeRoots, adapter)
    const sessionId = SessionId('task-continuation-serialized')
    const handle = await context.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    const create = (suffix: string): Promise<TaskContinuationClaim> => context.taskContinuations.create(handle.agent, {
      ...mutation(`serialized-${suffix}`),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${suffix.repeat(64)}`),
      taskRevision: taskContinuationRevision(`serialized-${suffix}`),
      verifierId: taskContinuationVerifierId('serial-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${suffix === '7' ? '8'.repeat(64) : 'a'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
    })
    const firstClaim = await create('7')
    const secondClaim = await create('9')
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('serial-verifier'),
      verify: claim => Promise.resolve(ready(claim)),
    })
    await eventually(
      () => adapter.requests.length === 3 ? adapter.requests : undefined,
      'two serialized continuation requests',
    )
    await handle.agent.whenIdle()
    await expect(context.taskContinuations.get(firstClaim.continuationId)).resolves.toMatchObject({ state: 'claimed' })
    await expect(context.taskContinuations.get(secondClaim.continuationId)).resolves.toMatchObject({ state: 'claimed' })
    expect(handle.agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(3)
  })

  it('retains one provider-owned cold Agent until the last claim is canceled, then disposes it once', async () => {
    const runtimeRoots = await allocateRoots()
    const seeded = await seedColdClaims(runtimeRoots, 'multi-cancel', 2)
    const disposals: Array<ReturnType<typeof vi.fn>> = []
    const context = await mountRuntime(
      runtimeRoots,
      new RecordingAdapter(),
      { recoveryRetryInitialMs: 5, recoveryRetryMaxMs: 20 },
      captureColdDisposals(disposals),
    )
    await eventually(() => context.agents.get(seeded.sessionId), 'multi-claim cold Agent')
    const [first, second] = seeded.claims
    if (first === undefined || second === undefined) throw new Error('multi-claim seed incomplete')

    await expect(context.taskContinuations.cancel({
      id: first.continuationId,
      sessionId: seeded.sessionId,
      taskRevision: first.taskRevision,
    })).resolves.toBe(true)
    expect(context.agents.get(seeded.sessionId)).toBeDefined()
    expect(disposals[0]).not.toHaveBeenCalled()

    await expect(context.taskContinuations.cancel({
      id: second.continuationId,
      sessionId: seeded.sessionId,
      taskRevision: second.taskRevision,
    })).resolves.toBe(true)
    await eventually(() => context.agents.get(seeded.sessionId) === undefined ? true : undefined, 'last-claim cold release')
    expect(disposals).toHaveLength(1)
    expect(disposals[0]).toHaveBeenCalledOnce()
  })

  it('auto-expires a not-ready cold claim, releases invalid cold Agents, and preserves caller-owned Agents', async () => {
    const expiryRoots = await allocateRoots()
    const expiring = await seedColdClaims(expiryRoots, 'expiry-release', 1, Date.now() + 180)
    const expiryDisposals: Array<ReturnType<typeof vi.fn>> = []
    const expiryContext = await mountRuntime(
      expiryRoots,
      new RecordingAdapter(),
      { recoveryPollMs: 20 },
      captureColdDisposals(expiryDisposals),
    )
    await eventually(() => expiryContext.agents.get(expiring.sessionId), 'expiring cold Agent')
    let notReadyCalls = 0
    expiryContext.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('expiry-release-verifier-0'),
      verify: () => {
        notReadyCalls += 1
        return Promise.resolve({ kind: 'not-ready' })
      },
    })
    await eventually(() => notReadyCalls > 0 ? notReadyCalls : undefined, 'not-ready verifier decision')
    const expiringClaim = expiring.claims[0]
    if (expiringClaim === undefined) throw new Error('expiring seed incomplete')
    await eventually(
      () => expiryContext.taskContinuations.get(expiringClaim.continuationId)
        .then(claim => claim?.state === 'expired' ? claim : undefined),
      'cold claim expiration',
    )
    await eventually(() => expiryContext.agents.get(expiring.sessionId) === undefined ? true : undefined, 'expired cold release')
    expect(expiryDisposals[0]).toHaveBeenCalledOnce()

    const invalidRoots = await allocateRoots()
    const invalid = await seedColdClaims(invalidRoots, 'invalid-release')
    const invalidDisposals: Array<ReturnType<typeof vi.fn>> = []
    const invalidContext = await mountRuntime(
      invalidRoots,
      new RecordingAdapter(),
      {},
      captureColdDisposals(invalidDisposals),
    )
    await eventually(() => invalidContext.agents.get(invalid.sessionId), 'invalid cold Agent')
    invalidContext.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('invalid-release-verifier-0'),
      verify: claim => Promise.resolve({ ...ready(claim), taskRevision: taskContinuationRevision('wrong-revision') }),
    })
    const invalidClaim = invalid.claims[0]
    if (invalidClaim === undefined) throw new Error('invalid seed incomplete')
    await eventually(
      () => invalidContext.taskContinuations.get(invalidClaim.continuationId)
        .then(claim => claim?.state === 'invalid' ? claim : undefined),
      'cold invalid claim',
    )
    await eventually(() => invalidContext.agents.get(invalid.sessionId) === undefined ? true : undefined, 'invalid cold release')
    expect(invalidDisposals[0]).toHaveBeenCalledOnce()

    const liveRoots = await allocateRoots()
    const liveContext = await mountRuntime(liveRoots, new RecordingAdapter())
    const liveSessionId = SessionId('task-continuation-caller-owned-live')
    const liveHandle = await liveContext.agents.create({
      sessionId: liveSessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const liveDispose = vi.spyOn(liveHandle, 'dispose')
    const liveOriginal = createUserMessage({ content: [{ type: 'text', text: 'live task' }], source: { kind: 'user' } })
    liveHandle.agent.followup(liveOriginal)
    await liveHandle.agent.whenIdle()
    const liveClaim = await liveContext.taskContinuations.create(liveHandle.agent, {
      ...mutation('caller-owned-live'),
      sessionId: liveSessionId,
      originalMessageId: liveOriginal.id,
      needDigest: continuationDigest(`sha256:${'d'.repeat(64)}`),
      taskRevision: taskContinuationRevision('caller-owned-live-r1'),
      verifierId: taskContinuationVerifierId('caller-owned-live-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'e'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
    })
    await expect(liveContext.taskContinuations.cancel({
      id: liveClaim.continuationId,
      sessionId: liveSessionId,
      taskRevision: liveClaim.taskRevision,
    })).resolves.toBe(true)
    expect(liveContext.agents.get(liveSessionId)).toBe(liveHandle.agent)
    expect(liveDispose).not.toHaveBeenCalled()
  })

  it('automatically retries one cold-resume, verifier, and Session-flush failure without an external trigger', async () => {
    const resumeRoots = await allocateRoots()
    const resumeSeed = await seedColdClaims(resumeRoots, 'resume-retry')
    let resumeCalls = 0
    const resumed = await mountRuntime(
      resumeRoots,
      new RecordingAdapter(),
      { recoveryRetryInitialMs: 5, recoveryRetryMaxMs: 20 },
      (context) => {
        const resume = context.agents.resume.bind(context.agents)
        vi.spyOn(context.agents, 'resume').mockImplementation((options) => {
          resumeCalls += 1
          return resumeCalls === 1 ? Promise.reject(new Error('one resume fault')) : resume(options)
        })
      },
    )
    await eventually(() => resumeCalls === 2 ? resumed.agents.get(resumeSeed.sessionId) : undefined, 'automatic resume retry')
    expect(resumeCalls).toBe(2)

    const runtimeRoots = await allocateRoots()
    const adapter = new RecordingAdapter()
    const context = await mountRuntime(runtimeRoots, adapter, {
      recoveryRetryInitialMs: 5,
      recoveryRetryMaxMs: 20,
    })
    const sessionId = SessionId('task-continuation-transient-retries')
    const handle = await context.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    const original = createUserMessage({ content: [{ type: 'text', text: 'retry task' }], source: { kind: 'user' } })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    const verifierClaim = await context.taskContinuations.create(handle.agent, {
      ...mutation('verifier-retry'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'1'.repeat(64)}`),
      taskRevision: taskContinuationRevision('verifier-retry-r1'),
      verifierId: taskContinuationVerifierId('retry-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'2'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
    })
    let verifierCalls = 0
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('retry-verifier'),
      verify: (claim) => {
        verifierCalls += 1
        return verifierCalls === 1
          ? Promise.reject(new Error('one verifier fault'))
          : Promise.resolve(ready(claim))
      },
    })
    await eventually(
      () => context.taskContinuations.get(verifierClaim.continuationId)
        .then(claim => claim?.state === 'claimed' ? claim : undefined),
      'automatic verifier retry',
    )
    expect(verifierCalls).toBe(2)

    const flushClaim = await context.taskContinuations.create(handle.agent, {
      ...mutation('flush-retry'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'3'.repeat(64)}`),
      taskRevision: taskContinuationRevision('flush-retry-r1'),
      verifierId: taskContinuationVerifierId('flush-retry-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'4'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
    })
    const flush = context.sessions.flush.bind(context.sessions)
    let failedFlushes = 0
    vi.spyOn(context.sessions, 'flush').mockImplementation((session) => {
      if (failedFlushes++ === 0) return Promise.reject(new Error('one flush fault'))
      return flush(session)
    })
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('flush-retry-verifier'),
      verify: claim => Promise.resolve(ready(claim)),
    })
    await eventually(
      () => context.taskContinuations.get(flushClaim.continuationId)
        .then(claim => claim?.state === 'claimed' ? claim : undefined),
      'automatic flush retry',
    )
    await handle.agent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
  })

  it('aborts a never-settling cold Session preparation during provider teardown', async () => {
    const runtimeRoots = await allocateRoots()
    const seeded = await seedColdClaims(runtimeRoots, 'hung-cold-prepare')
    const preparationStarted = Promise.withResolvers<undefined>()
    let creationSignal: AbortSignal | undefined
    const context = await mountRuntime(
      runtimeRoots,
      new RecordingAdapter(),
      { recoveryRetryInitialMs: 5, recoveryRetryMaxMs: 20 },
      (mounted) => {
        vi.spyOn(mounted.sessionPersistence, 'prepare').mockImplementation((_id, signal) => {
          creationSignal = signal
          preparationStarted.resolve(undefined)
          return new Promise<never>(() => {})
        })
      },
    )
    await preparationStarted.promise
    const agents = context.agents
    const sessions = context.sessions

    await expect(Promise.race([
      disposeContext(context).then(() => 'disposed' as const),
      new Promise<'timeout'>(resolve => setTimeout(() => { resolve('timeout') }, 500)),
    ])).resolves.toBe('disposed')
    expect(creationSignal?.aborted).toBe(true)
    expect(agents.get(seeded.sessionId)).toBeUndefined()
    expect(sessions.get(seeded.sessionId)).toBeUndefined()
  })

  it('leases one consumed dispatch across two Hosts while downstream admission is blocked', async () => {
    const runtimeRoots = await allocateRoots()
    const seeded = await seedColdClaims(runtimeRoots, 'dual-host')
    const firstAdapter = new RecordingAdapter()
    const secondAdapter = new RecordingAdapter()
    const config = { dispatchLeaseMs: 30, recoveryRetryInitialMs: 5, recoveryRetryMaxMs: 20 }
    const first = await mountRuntime(runtimeRoots, firstAdapter, config)
    const second = await mountRuntime(runtimeRoots, secondAdapter, config)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let downstreamEntries = 0
    const block = (context: Context): void => {
      context.on('agent/pre-step', async ({ messages }, next) => {
        if (messages.some(message => message.source.kind === 'task-continuation')) {
          downstreamEntries += 1
          entered.resolve(undefined)
          await release.promise
        }
        return next()
      })
    }
    block(first)
    block(second)
    const verifier = {
      id: taskContinuationVerifierId('dual-host-verifier-0'),
      verify: (claim: TaskContinuationClaim) => Promise.resolve(ready(claim)),
    }
    first.taskContinuations.registerVerifier(verifier)
    second.taskContinuations.registerVerifier(verifier)
    await entered.promise
    await new Promise<void>(resolve => setTimeout(resolve, 120))
    expect(downstreamEntries).toBe(1)
    release.resolve(undefined)

    const claim = seeded.claims[0]
    if (claim === undefined) throw new Error('dual-host seed incomplete')
    await eventually(
      () => first.taskContinuations.get(claim.continuationId)
        .then(current => current?.state === 'claimed' ? current : undefined),
      'dual-host claimed barrier',
    )
    await eventually(
      () => firstAdapter.requests.length + secondAdapter.requests.length === 1 ? true : undefined,
      'single dual-host model request',
    )
    await eventually(
      () => first.agents.get(seeded.sessionId) === undefined && second.agents.get(seeded.sessionId) === undefined
        ? true
        : undefined,
      'dual-host cold handle release',
    )
    expect(firstAdapter.requests).toHaveLength(firstAdapter.requests.length === 1 ? 1 : 0)
    expect(firstAdapter.requests.length + secondAdapter.requests.length).toBe(1)
  })

  it('lets an earlier Host discover the database and take over an expired lease without another event', async () => {
    const runtimeRoots = await allocateRoots()
    const firstAdapter = new RecordingAdapter()
    const secondAdapter = new RecordingAdapter()
    const config = {
      dispatchLeaseMs: 90,
      recoveryPollMs: 10,
      recoveryRetryInitialMs: 5,
      recoveryRetryMaxMs: 20,
    }
    const second = await mountRuntime(runtimeRoots, secondAdapter, config)
    await expect(access(join(runtimeRoots.claims, 'claims.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
    const first = await mountRuntime(runtimeRoots, firstAdapter, config)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    first.on('agent/pre-step', async ({ messages }, next) => {
      if (messages.some(message => message.source.kind === 'task-continuation')) {
        entered.resolve(undefined)
        await release.promise
      }
      return next()
    })

    const sessionId = SessionId('task-continuation-killed-lease-owner')
    const handle = await first.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'durable takeover task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    const claim = await first.taskContinuations.create(handle.agent, {
      ...mutation('killed-lease-owner'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'7'.repeat(64)}`),
      taskRevision: taskContinuationRevision('killed-lease-owner-r1'),
      verifierId: taskContinuationVerifierId('killed-lease-owner-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'8'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
    })
    first.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('killed-lease-owner-verifier'),
      verify: current => Promise.resolve(ready(current)),
    })
    await entered.promise
    await eventually(() => second.agents.get(sessionId), 'early Host cold resume')
    await new Promise<void>(resolve => setTimeout(resolve, 40))
    expect(secondAdapter.requests).toHaveLength(0)
    await expect(second.taskContinuations.reserve({
      ...mutation('expired-explicit-reserve'),
      resumeAgentOptions: { provider: 'mock', model: 'mock' },
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'9'.repeat(64)}`),
      taskRevision: taskContinuationRevision('expired-explicit-reserve-r1'),
      verifierId: taskContinuationVerifierId('expired-explicit-reserve-verifier'),
      verificationPayloadDigest: continuationDigest(`sha256:${'a'.repeat(64)}`),
      expiresAtMs: Date.now() - 1,
    })).rejects.toThrow('expiry must be a future')

    type OwnedLease = { readonly abort: AbortController; readonly promise: Promise<void> }
    const firstDriver = first.taskContinuations as TaskContinuationService & {
      stopping: boolean
      dispatchLeases: Map<TaskContinuationClaim['continuationId'], OwnedLease>
    }
    const owned = await eventually(
      () => firstDriver.dispatchLeases.get(claim.continuationId),
      'first Host dispatch lease',
    )
    firstDriver.stopping = true
    owned.abort.abort()
    await owned.promise
    firstDriver.dispatchLeases.delete(claim.continuationId)

    await eventually(
      () => second.taskContinuations.get(claim.continuationId)
        .then(current => current?.state === 'claimed' ? current : undefined),
      'automatic expired-lease takeover',
    )
    await eventually(() => secondAdapter.requests.length === 1 ? true : undefined, 'takeover model request')
    release.resolve(undefined)
    await handle.agent.whenIdle()
    expect(firstAdapter.requests).toHaveLength(1)
  })

  it('disposes promptly when a verifier ignores cancellation', async () => {
    const runtimeRoots = await allocateRoots()
    const context = await mountRuntime(runtimeRoots, new RecordingAdapter(), { verifierTimeoutMs: 60_000 })
    const sessionId = SessionId('task-continuation-dispose-verifier')
    const handle = await context.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const original = createUserMessage({
      content: [{ type: 'text', text: 'task' }],
      source: { kind: 'user' },
    })
    handle.agent.followup(original)
    await handle.agent.whenIdle()
    await context.taskContinuations.create(handle.agent, {
      ...mutation('dispose-verifier'),
      sessionId,
      originalMessageId: original.id,
      needDigest: continuationDigest(`sha256:${'b'.repeat(64)}`),
      taskRevision: taskContinuationRevision('dispose-r1'),
      verifierId: taskContinuationVerifierId('non-cooperative'),
      verificationPayloadDigest: continuationDigest(`sha256:${'c'.repeat(64)}`),
      expiresAtMs: Date.now() + 60_000,
    })
    const started = Promise.withResolvers<undefined>()
    context.taskContinuations.registerVerifier({
      id: taskContinuationVerifierId('non-cooperative'),
      verify: () => {
        started.resolve(undefined)
        return new Promise<TaskContinuationReady>(() => {})
      },
    })
    await started.promise
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => { reject(new Error('driver disposal did not converge')) }, 1_000)
    })
    await expect(Promise.race([disposeContext(context), timeout])).resolves.toBeUndefined()
  })
})
