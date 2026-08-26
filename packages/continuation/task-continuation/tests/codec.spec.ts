import { describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  TASK_CONTINUATION_PROMPT,
  TaskContinuationInputError,
  TaskContinuationMutationConflictError,
  allocateContinuationId,
  continuationDigest,
  continuationId,
  decodeTaskContinuationSource,
  isTaskContinuationMessage,
  taskContinuationMessage,
  taskContinuationCallerId,
  taskContinuationMutationId,
  taskContinuationRevision,
  taskContinuationVerifierId,
  type TaskContinuationClaim,
} from '../src/index.ts'

const digestA = continuationDigest(`sha256:${'a'.repeat(64)}`)
const digestB = continuationDigest(`sha256:${'b'.repeat(64)}`)

function claim(): TaskContinuationClaim {
  return {
    kind: 'task-continuation',
    version: 1,
    continuationId: continuationId('11111111-1111-4111-8111-111111111111'),
    callerId: taskContinuationCallerId('extension-center'),
    mutationId: taskContinuationMutationId('operation-1'),
    recordRevision: 2,
    state: 'consumed',
    dispatchMessageId: MessageId('dispatch-1'),
    resumeAgentOptions: { provider: 'mock', model: 'mock' },
    sessionId: SessionId('session-1'),
    originalMessageId: MessageId('message-1'),
    needDigest: digestA,
    taskRevision: taskContinuationRevision('task-r1'),
    verifierId: taskContinuationVerifierId('extension-receipt'),
    verificationPayloadDigest: digestB,
    createdAtMs: 1,
    updatedAtMs: 2,
    expiresAtMs: 10_000,
  }
}

function decode(source: unknown) {
  return decodeTaskContinuationSource(source as never)
}

function sourceRecord(): Record<string, unknown> {
  return { ...taskContinuationMessage(claim()).source }
}

describe('task continuation codec', () => {
  it('round-trips the fixed message without copying original task text', () => {
    const expected = claim()
    const message = taskContinuationMessage(expected)

    expect(message.content).toEqual([{ type: 'text', text: TASK_CONTINUATION_PROMPT }])
    expect(JSON.stringify(message)).not.toContain('install the secret extension')
    expect(decodeTaskContinuationSource(message.source)).toEqual({
      kind: 'task-continuation',
      version: 1,
      continuationId: expected.continuationId,
      sessionId: expected.sessionId,
      originalMessageId: expected.originalMessageId,
      needDigest: expected.needDigest,
      taskRevision: expected.taskRevision,
      verifierId: expected.verifierId,
      verificationPayloadDigest: expected.verificationPayloadDigest,
      expiresAtMs: expected.expiresAtMs,
    })
    expect(isTaskContinuationMessage(message, expected)).toBe(true)
  })

  it('rejects extra fields, non-canonical digests, and changed framing', () => {
    const expected = claim()
    const message = taskContinuationMessage(expected)
    expect(decodeTaskContinuationSource({
      ...message.source,
      unexpected: true,
    } as never)).toBeUndefined()
    expect(() => continuationDigest(`sha256:${'A'.repeat(64)}`)).toThrow(/canonical/)
    expect(isTaskContinuationMessage({
      ...message,
      content: [{ type: 'text', text: `${TASK_CONTINUATION_PROMPT} changed` }],
    }, expected)).toBe(false)
  })

  it('validates every public identity and preserves stable error codes', () => {
    const id = allocateContinuationId()
    expect(continuationId(id)).toBe(id)
    expect(() => continuationId('not-a-uuid')).toThrow(TaskContinuationInputError)

    expect(taskContinuationCallerId('extension-center')).toBe('extension-center')
    expect(() => taskContinuationCallerId('Extension Center')).toThrow(TaskContinuationInputError)
    expect(() => taskContinuationCallerId('a'.repeat(129))).toThrow(TaskContinuationInputError)

    expect(taskContinuationMutationId('operation_1:retry')).toBe('operation_1:retry')
    expect(() => taskContinuationMutationId('')).toThrow(TaskContinuationInputError)
    expect(continuationDigest(`sha256:${'0'.repeat(64)}`)).toBe(`sha256:${'0'.repeat(64)}`)
    expect(() => continuationDigest('sha256:short')).toThrow(TaskContinuationInputError)

    expect(taskContinuationRevision('task.r1:retry')).toBe('task.r1:retry')
    expect(() => taskContinuationRevision('task revision')).toThrow(TaskContinuationInputError)
    expect(taskContinuationVerifierId('extension-receipt')).toBe('extension-receipt')
    expect(() => taskContinuationVerifierId('ExtensionReceipt')).toThrow(TaskContinuationInputError)
    expect(() => taskContinuationVerifierId('a'.repeat(129))).toThrow(TaskContinuationInputError)

    const inputError = new TaskContinuationInputError('invalid')
    expect(inputError.code).toBe('TASK_CONTINUATION_INVALID_INPUT')
    const conflict = new TaskContinuationMutationConflictError(
      taskContinuationCallerId('extension-center'),
      taskContinuationMutationId('operation-1'),
    )
    expect(conflict).toMatchObject({
      code: 'TASK_CONTINUATION_MUTATION_CONFLICT',
      message: 'task continuation mutation "extension-center/operation-1" is already bound to different input',
    })
  })

  it('strictly decodes plain and null-prototype records only', () => {
    expect(decode({ kind: 'user' })).toBeUndefined()
    expect(decode(Object.assign([], { kind: 'task-continuation' }))).toBeUndefined()
    expect(decode(Object.assign(() => undefined, { kind: 'task-continuation' }))).toBeUndefined()
    expect(decode(Object.assign(new Date(), { kind: 'task-continuation' }))).toBeUndefined()

    const validNullPrototype = Object.assign(
      Object.create(null) as Record<string, unknown>,
      sourceRecord(),
    )
    expect(decode(validNullPrototype)).toEqual(decode(sourceRecord()))

    const wrongKey = sourceRecord()
    delete wrongKey['version']
    wrongKey['wrong'] = 1
    expect(decode(wrongKey)).toBeUndefined()
    expect(decode({ ...sourceRecord(), version: 2 })).toBeUndefined()

    const changingKind = sourceRecord()
    let kindReads = 0
    Object.defineProperty(changingKind, 'kind', {
      enumerable: true,
      get() {
        kindReads += 1
        return kindReads === 1 ? 'task-continuation' : 'changed'
      },
    })
    expect(decode(changingKind)).toBeUndefined()
  })

  it('rejects every invalid durable source field before dispatch', () => {
    for (const field of [
      'continuationId',
      'sessionId',
      'originalMessageId',
      'needDigest',
      'taskRevision',
      'verifierId',
      'verificationPayloadDigest',
    ]) {
      expect(decode({ ...sourceRecord(), [field]: null }), field).toBeUndefined()
    }
    expect(decode({ ...sourceRecord(), expiresAtMs: '10000' })).toBeUndefined()
    expect(decode({ ...sourceRecord(), expiresAtMs: -1 })).toBeUndefined()

    for (const [field, value] of [
      ['continuationId', 'not-a-uuid'],
      ['needDigest', 'sha256:short'],
      ['taskRevision', 'task revision'],
      ['verifierId', 'Verifier'],
      ['verificationPayloadDigest', `sha256:${'A'.repeat(64)}`],
    ] as const) {
      expect(decode({ ...sourceRecord(), [field]: value }), field).toBeUndefined()
    }
  })

  it('compares every dispatch-bearing message field to the durable claim', () => {
    const expected = claim()
    const message = taskContinuationMessage(expected)
    expect(isTaskContinuationMessage({ ...message, id: MessageId('other') }, expected)).toBe(false)
    expect(isTaskContinuationMessage({ ...message, content: [] }, expected)).toBe(false)
    expect(isTaskContinuationMessage({
      ...message,
      content: [{ type: 'reasoning', text: 'not the fixed prompt' }],
    }, expected)).toBe(false)
    expect(isTaskContinuationMessage({ ...message, source: { kind: 'user' } }, expected)).toBe(false)

    const mismatches: readonly Partial<TaskContinuationClaim>[] = [
      { continuationId: continuationId('22222222-2222-4222-8222-222222222222') },
      { sessionId: SessionId('session-2') },
      { originalMessageId: MessageId('message-2') },
      { needDigest: digestB },
      { taskRevision: taskContinuationRevision('task-r2') },
      { verifierId: taskContinuationVerifierId('other-verifier') },
      { verificationPayloadDigest: digestA },
      { expiresAtMs: expected.expiresAtMs + 1 },
    ]
    for (const mismatch of mismatches) {
      expect(isTaskContinuationMessage(message, { ...expected, ...mismatch }), JSON.stringify(mismatch)).toBe(false)
    }
  })
})
