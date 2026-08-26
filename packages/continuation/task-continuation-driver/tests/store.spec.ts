import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  continuationDigest,
  continuationId,
  taskContinuationCallerId,
  taskContinuationMutationId,
  taskContinuationRevision,
  taskContinuationVerifierId,
  type TaskContinuationClaim,
} from '@deepseek-ai/dsh-task-continuation'
import {
  DurableTaskContinuationStore,
  type ContinuationDispatchLease,
  type NewContinuationRecord,
} from '../src/store.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function input(): NewContinuationRecord {
  return {
    kind: 'task-continuation',
    version: 1,
    continuationId: continuationId('22222222-2222-4222-8222-222222222222'),
    callerId: taskContinuationCallerId('extension-center'),
    mutationId: taskContinuationMutationId('operation-2'),
    dispatchMessageId: MessageId('dispatch-2'),
    resumeAgentOptions: { provider: 'mock', model: 'mock', maxTokens: 512 },
    sessionId: SessionId('session-2'),
    originalMessageId: MessageId('message-2'),
    needDigest: continuationDigest(`sha256:${'c'.repeat(64)}`),
    taskRevision: taskContinuationRevision('revision-2'),
    verifierId: taskContinuationVerifierId('receipt-verifier'),
    verificationPayloadDigest: continuationDigest(`sha256:${'d'.repeat(64)}`),
    createdAtMs: 10,
    expiresAtMs: 10_000,
  }
}

async function store(): Promise<DurableTaskContinuationStore> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-continuation-store-'))
  roots.push(root)
  const result = new DurableTaskContinuationStore(root, 1_000)
  await result.initialize()
  return result
}

describe('durable task continuation store', () => {
  it('fences dispatch ownership across stores and commits an at-most-once claimed barrier', async () => {
    const first = await store()
    const second = new DurableTaskContinuationStore(roots[0]!, 1_000)
    await second.initialize()
    const pending = await first.create(input())
    const ready = await first.transition({
      id: pending.continuationId,
      from: ['pending'],
      to: 'ready',
      updatedAtMs: 11,
    })
    if (ready === undefined) throw new Error('ready transition lost')
    const consumed = await first.transition({
      id: ready.continuationId,
      from: ['ready'],
      to: 'consumed',
      updatedAtMs: 12,
    })
    if (consumed === undefined) throw new Error('consumed transition lost')

    const attempts = await Promise.all([
      first.acquireDispatchLease(consumed, 'host-a', 20, 120),
      second.acquireDispatchLease(consumed, 'host-b', 20, 120),
    ])
    const winner = attempts.find((lease): lease is ContinuationDispatchLease => lease !== undefined)
    const loserOwner = winner?.ownerId === 'host-a' ? 'host-b' : 'host-a'
    expect(attempts.filter(lease => lease !== undefined)).toHaveLength(1)
    if (winner === undefined) throw new Error('dispatch lease had no winner')
    await expect(second.acquireDispatchLease(consumed, loserOwner, 119, 219)).resolves.toBeUndefined()
    await expect(second.getDispatchLeaseExpiry(consumed)).resolves.toBe(120)
    await expect(first.holdsDispatchLease(winner, 119)).resolves.toBe(true)

    const takeover = await second.acquireDispatchLease(consumed, loserOwner, 120, 220)
    expect(takeover).toMatchObject({ ownerId: loserOwner, incarnation: winner.incarnation + 1 })
    if (takeover === undefined) throw new Error('expired dispatch lease was not recoverable')
    await expect(first.claimDispatch(consumed, winner, 121)).resolves.toBeUndefined()
    const renewed = await second.renewDispatchLease(takeover, 240)
    expect(renewed).toMatchObject({ expiresAtMs: 240 })
    if (renewed === undefined) throw new Error('takeover lease renewal lost')
    await expect(second.claimDispatch(consumed, renewed, 130)).resolves.toMatchObject({
      state: 'claimed',
      recordRevision: 3,
    })
    await expect(first.holdsDispatchLease(renewed, 130)).resolves.toBe(false)
    await expect(first.releaseDispatchLease(renewed)).resolves.toBe(false)
    await expect(first.getDispatchLeaseExpiry(consumed)).resolves.toBeUndefined()
    await second.close()
  })

  it('persists a monotonic single-use state machine across close and reopen', async () => {
    const first = await store()
    const pending = await first.create(input())
    const ready = await first.transition({
      id: pending.continuationId,
      from: ['pending'],
      to: 'ready',
      expectedRecordRevision: 0,
      updatedAtMs: 11,
    })
    expect(ready).toMatchObject({ state: 'ready', recordRevision: 1 })

    await expect(first.transition({
      id: pending.continuationId,
      from: ['pending'],
      to: 'canceled',
      expectedRecordRevision: 0,
      updatedAtMs: 12,
    })).resolves.toBeUndefined()

    const consumed = await first.transition({
      id: pending.continuationId,
      from: ['ready'],
      to: 'consumed',
      expectedRecordRevision: 1,
      updatedAtMs: 13,
    })
    expect(consumed).toMatchObject({ state: 'consumed', recordRevision: 2 })
    const claimed = await first.transition({
      id: pending.continuationId,
      from: ['consumed'],
      to: 'claimed',
      expectedRecordRevision: 2,
      updatedAtMs: 14,
    })
    expect(claimed).toMatchObject({ state: 'claimed', recordRevision: 3 })
    await first.close()

    const reopened = new DurableTaskContinuationStore(roots[0]!, 1_000)
    await reopened.initialize()
    await expect(reopened.get(pending.continuationId)).resolves.toMatchObject({
      state: 'claimed',
      recordRevision: 3,
    } satisfies Partial<TaskContinuationClaim>)
    await expect(reopened.transition({
      id: pending.continuationId,
      from: ['claimed'],
      to: 'canceled',
      updatedAtMs: 15,
    })).rejects.toThrow(/invalid task continuation transition/)
    await reopened.close()
  })

  it('uses the session and task revision as zero-mutation terminal fences', async () => {
    const database = await store()
    const pending = await database.create(input())

    await expect(database.transition({
      id: pending.continuationId,
      from: ['pending'],
      to: 'canceled',
      expectedSessionId: SessionId('wrong-session'),
      expectedTaskRevision: pending.taskRevision,
      updatedAtMs: 11,
    })).resolves.toBeUndefined()
    await expect(database.transition({
      id: pending.continuationId,
      from: ['pending'],
      to: 'superseded',
      expectedSessionId: pending.sessionId,
      expectedTaskRevision: taskContinuationRevision('wrong-revision'),
      supersededByTaskRevision: taskContinuationRevision('replacement'),
      updatedAtMs: 12,
    })).resolves.toBeUndefined()
    await expect(database.get(pending.continuationId)).resolves.toMatchObject({
      state: 'pending',
      recordRevision: 0,
    })
    await database.close()
  })

  it('keeps transition timestamps monotonic when the wall clock moves backward', async () => {
    const database = await store()
    const pending = await database.create(input())
    const ready = await database.transition({
      id: pending.continuationId,
      from: ['pending'],
      to: 'ready',
      updatedAtMs: 20,
    })

    await expect(database.transition({
      id: pending.continuationId,
      from: ['ready'],
      to: 'consumed',
      ...(ready === undefined ? {} : { expectedRecordRevision: ready.recordRevision }),
      updatedAtMs: 5,
    })).resolves.toMatchObject({
      state: 'consumed',
      recordRevision: 2,
      createdAtMs: 10,
      updatedAtMs: 20,
    })
    await database.close()
  })
})
