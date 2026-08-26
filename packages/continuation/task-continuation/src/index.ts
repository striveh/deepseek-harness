/** Durable task-continuation claim registry and lifecycle Service Definition. @module @deepseek-ai/dsh-task-continuation */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  taskContinuationVerifierId,
} from './codec.ts'
import type {
  ContinuationId,
  CreateTaskContinuationRequest,
  ListTaskContinuationsRequest,
  SupersedeTaskContinuationRequest,
  TaskContinuationClaim,
  TaskContinuationRef,
  ReserveTaskContinuationRequest,
  TaskContinuationVerifier,
  TaskContinuationVerifierId,
} from './types.ts'

export type * from './types.ts'
export {
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
} from './codec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskContinuations: TaskContinuationService
  }
}

/** Service API for durable, verifier-gated continuation claims. */
export abstract class TaskContinuationService extends Service {
  private readonly verifiers = new Map<TaskContinuationVerifierId, TaskContinuationVerifier>()

  /** Exact same-process API revision required by dynamic consumers. */
  abstract readonly protocolVersion: 1

  constructor(ctx: Context) {
    super(ctx, 'taskContinuations')
  }

  /**
   * Park one continuation for an exact live Agent without waking a turn.
   * @param agent - exact live Agent whose session owns the task.
   * @param request - task, need, verifier, payload-digest, and expiry fences.
   * @returns the durably created pending claim.
   */
  abstract create(agent: Agent, request: CreateTaskContinuationRequest): Promise<TaskContinuationClaim>

  /**
   * Idempotently create or recover one caller-owned reservation without requiring a live Agent object.
   * @param request - caller key, Session/task fences, verifier payload, expiry, and restricted resume route.
   * @returns the one durable claim bound to the caller key.
   */
  abstract reserve(request: ReserveTaskContinuationRequest): Promise<TaskContinuationClaim>

  /**
   * Read one claim by stable identity.
   * @param id - continuation identity to read.
   * @returns the immutable durable view, or `undefined` when absent.
   */
  abstract get(id: ContinuationId): Promise<TaskContinuationClaim | undefined>

  /**
   * List claims, optionally restricted to one exact session.
   * @param request - optional management filter.
   * @returns immutable views in deterministic creation order.
   */
  abstract list(request?: ListTaskContinuationsRequest): Promise<readonly TaskContinuationClaim[]>

  /**
   * Make one exact pending or ready claim permanently canceled.
   * @param ref - continuation, session, and task-revision fence.
   * @returns whether this call won before the claim reached consumed dispatch intent.
   */
  abstract cancel(ref: TaskContinuationRef): Promise<boolean>

  /**
   * Make one exact pending or ready claim terminal in favor of a newer task revision.
   * @param request - old exact fence and replacement revision.
   * @returns whether this call won before the claim reached consumed dispatch intent.
   */
  abstract supersede(request: SupersedeTaskContinuationRequest): Promise<boolean>

  /**
   * Register an extension-owned verifier under an effect-scoped identity.
   * @param verifier - non-mutating evidence verifier.
   * @returns the exact single-use registration disposer.
   */
  registerVerifier(verifier: TaskContinuationVerifier): () => void {
    const id = taskContinuationVerifierId(verifier.id)
    // oxlint-disable-next-line typescript/no-misused-promises -- cleanup is synchronous; direct identity preserves Cordis disposal ordering
    return this.ctx.effect(() => {
      if (this.verifiers.has(id)) throw new Error(`task continuation verifier "${id}" is already registered`)
      this.verifiers.set(id, verifier)
      this.onVerifierRegistryChanged()
      return () => {
        if (this.verifiers.get(id) !== verifier) return
        this.verifiers.delete(id)
        this.onVerifierRegistryChanged()
      }
    }, `taskContinuations.registerVerifier(${id})`)
  }

  /**
   * Read a verifier for a provider-owned drive decision.
   * @param id - validated verifier identity from a durable claim.
   * @returns the exact live registration, or `undefined`.
   */
  protected resolveVerifier(id: TaskContinuationVerifierId): TaskContinuationVerifier | undefined {
    return this.verifiers.get(id)
  }

  /** Notify a concrete provider that verifier availability changed. */
  protected onVerifierRegistryChanged(): void {}
}

export default TaskContinuationService
