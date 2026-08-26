import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import TaskContinuationService, {
  taskContinuationVerifierId,
  type ContinuationId,
  type CreateTaskContinuationRequest,
  type ListTaskContinuationsRequest,
  type ReserveTaskContinuationRequest,
  type SupersedeTaskContinuationRequest,
  type TaskContinuationClaim,
  type TaskContinuationRef,
  type TaskContinuationVerifier,
  type TaskContinuationVerifierId,
} from '../src/index.ts'

class ProbeService extends TaskContinuationService {
  readonly protocolVersion = 1
  readonly changes = vi.fn()

  async create(_agent: Agent, _request: CreateTaskContinuationRequest): Promise<TaskContinuationClaim> {
    throw new Error('not implemented by definition probe')
  }

  async reserve(_request: ReserveTaskContinuationRequest): Promise<TaskContinuationClaim> {
    throw new Error('not implemented by definition probe')
  }

  async get(_id: ContinuationId): Promise<TaskContinuationClaim | undefined> {
    return undefined
  }

  async list(_request?: ListTaskContinuationsRequest): Promise<readonly TaskContinuationClaim[]> {
    return []
  }

  async cancel(_ref: TaskContinuationRef): Promise<boolean> {
    return false
  }

  async supersede(_request: SupersedeTaskContinuationRequest): Promise<boolean> {
    return false
  }

  verifier(id: string): TaskContinuationVerifier | undefined {
    return this.resolveVerifier(taskContinuationVerifierId(id))
  }

  runBaseRegistryHook(): void {
    super.onVerifierRegistryChanged()
  }

  protected override onVerifierRegistryChanged(): void {
    this.changes()
  }
}

function verifier(id: string): TaskContinuationVerifier {
  return {
    id: taskContinuationVerifierId(id),
    verify: vi.fn().mockResolvedValue({ kind: 'not-ready' }),
  }
}

describe('TaskContinuationService verifier registry', () => {
  it('rejects duplicates and removes the exact verifier on disposal', async () => {
    const ctx = new Context()
    const service = new ProbeService(ctx)
    const registered = verifier('extension-receipt')
    const dispose = service.registerVerifier(registered)

    expect(service.verifier(registered.id)).toBe(registered)
    expect(service.verifier('missing')).toBeUndefined()
    expect(service.changes).toHaveBeenCalledOnce()
    expect(() => service.registerVerifier(verifier(registered.id))).toThrow(/already registered/u)
    expect(() => service.registerVerifier(verifier('Invalid Verifier'))).toThrow(/lower-kebab/u)

    dispose()
    expect(service.verifier(registered.id)).toBeUndefined()
    expect(service.changes).toHaveBeenCalledTimes(2)
    service.runBaseRegistryHook()
    await ctx.fiber.dispose()
  })

  it('does not let a stale disposer remove a different verifier identity', async () => {
    const ctx = new Context()
    const service = new ProbeService(ctx)
    const first = verifier('extension-receipt')
    const replacement = verifier('extension-receipt')
    const disposeFirst = service.registerVerifier(first)
    const internalRegistry = (service as unknown as {
      verifiers: Map<TaskContinuationVerifierId, TaskContinuationVerifier>
    }).verifiers
    internalRegistry.set(first.id, replacement)

    disposeFirst()
    expect(service.verifier(first.id)).toBe(replacement)
    expect(service.changes).toHaveBeenCalledOnce()
    internalRegistry.clear()
    await ctx.fiber.dispose()
  })
})
