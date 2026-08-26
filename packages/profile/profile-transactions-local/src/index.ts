/**
 * Local Service Provider for complete Profile generation transactions. It
 * coordinates every writer through SQLite and keeps immutable generations in
 * a central directory outside every live and active Profile tree.
 * @module @deepseek-ai/dsh-profile-transactions-local
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  ProfileRevisionConflictError,
  ProfileContentConflictError,
  ProfileMutationConflictError,
  ProfileTransactions,
  ProfileTreeConflictError,
  profileId,
  profileMutationId,
  type AbortProfileGenerationRequest,
  type AcknowledgeProfileBootRequest,
  type CommitProfileGenerationRequest,
  type ExactProfileMutation,
  type GetProfileRestoreReceiptRequest,
  type ProfileArtifactDigest,
  type ProfileCommitReceipt,
  type ProfileContentDigest,
  type ProfileGenerationId,
  type ProfileGenerationInventory,
  type ProfileGenerationSummary,
  type ProfileId,
  type ProfileRestoreReceipt,
  type ProfileSnapshot,
  type ProfileTreeDigest,
  type RestoreLastGoodProfileRequest,
  type StageProfileGenerationRequest,
  type StagedProfileGeneration,
} from '@deepseek-ai/dsh-profile-transactions'
import {
  copyProfileTree,
  digestProfileTree,
  LocalProfileRevisionConflictError,
  LocalProfileContentConflictError,
  LocalProfileMutationConflictError,
  LocalProfileTransactionStore,
  LocalProfileTreeConflictError,
  type StoreGenerationSummary,
  type StoreMutation,
  type StoreSnapshot,
} from './runtime.ts'
import {
  DEFAULT_PROFILE_VALIDATION_TIMEOUT_MS,
  MAX_PROFILE_VALIDATION_TIMEOUT_MS,
  assertProfileValidatorInstallAnchor,
  validateProfileGenerationIsolated,
} from './validator.ts'

export { copyProfileTree, digestProfileTree }

export {
  DEFAULT_PROFILE_VALIDATION_TIMEOUT_MS,
  MAX_PROFILE_VALIDATION_TIMEOUT_MS,
  PROFILE_VALIDATOR_ARG,
  assertProfileValidatorInstallAnchor,
  profileValidatorChildEnvironment,
  runProfileValidatorChild,
  validateProfileGenerationIsolated,
} from './validator.ts'

/** Largest busy timeout accepted by SQLite's signed millisecond interface. */
export const MAX_PROFILE_LOCK_WAIT_MS = 2_147_483_647
/** Default wait for another Profile transaction writer. */
export const DEFAULT_PROFILE_LOCK_WAIT_MS = 10_000

/** Local Profile transaction provider configuration. */
export interface Config {
  /** Directory containing named Profile directories. */
  profilesDir: string
  /** Exact application package file used by production Profile bundle resolution. */
  installAnchor: string
  /** Maximum wait for another process's writer reservation. */
  lockWaitMs?: number
  /** Wall-clock budget for one isolated Loader validation. */
  validationTimeoutMs?: number
}

function asMutation(mutation: StoreMutation): ExactProfileMutation {
  if (mutation.operation === 'uninstall') return mutation
  if (mutation.operation === 'configure') {
    return {
      ...mutation,
      patch: {
        ...mutation.patch,
        expectedDigest: mutation.patch.expectedDigest as ProfileContentDigest,
        nextDigest: mutation.patch.nextDigest as ProfileContentDigest,
      },
    }
  }
  return {
    ...mutation,
    artifact: {
      ...mutation.artifact,
      digest: mutation.artifact.digest as ProfileArtifactDigest,
    },
  }
}

function asSnapshot(snapshot: StoreSnapshot): ProfileSnapshot {
  return {
    profile: profileId(snapshot.profile),
    revision: snapshot.revision,
    treeDigest: snapshot.treeDigest as ProfileTreeDigest,
    effectivePath: snapshot.effectivePath,
    activeGeneration: snapshot.activeGeneration as ProfileGenerationId | null,
    lastGoodGeneration: snapshot.lastGoodGeneration as ProfileGenerationId | null,
    rollbackGeneration: snapshot.rollbackGeneration as ProfileGenerationId | null,
    bootStatus: snapshot.bootStatus,
  }
}

function asSummary(summary: StoreGenerationSummary): ProfileGenerationSummary {
  return {
    generation: summary.generation as ProfileGenerationId,
    treeDigest: summary.treeDigest as ProfileTreeDigest,
    mutationId: summary.mutationId === null ? null : profileMutationId(summary.mutationId),
    mutation: summary.mutation === null ? null : asMutation(summary.mutation),
  }
}

function freeze<T>(value: T): T {
  const clone = structuredClone(value)
  const visit = (entry: unknown): void => {
    if (typeof entry !== 'object' || entry === null || Object.isFrozen(entry)) return
    for (const child of Object.values(entry)) visit(child)
    Object.freeze(entry)
  }
  visit(clone)
  return clone
}

/** Local filesystem and SQLite-coordinated Profile transaction provider. */
export class LocalProfileTransactions extends ProfileTransactions {
  static Config: z<Config> = z.object({
    profilesDir: z.string().required(),
    installAnchor: z.string().required(),
    lockWaitMs: z.number().step(1).min(0).max(MAX_PROFILE_LOCK_WAIT_MS).default(DEFAULT_PROFILE_LOCK_WAIT_MS),
    validationTimeoutMs: z.number().step(1).min(1).max(MAX_PROFILE_VALIDATION_TIMEOUT_MS)
      .default(DEFAULT_PROFILE_VALIDATION_TIMEOUT_MS),
  })

  private readonly store: LocalProfileTransactionStore
  private readonly validationTimeoutMs: number

  readonly protocolVersion = 1 as const

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    this.store = new LocalProfileTransactionStore({
      profilesDir: config.profilesDir,
      installAnchor: config.installAnchor,
      lockWaitMs: config.lockWaitMs ?? DEFAULT_PROFILE_LOCK_WAIT_MS,
    })
    this.validationTimeoutMs = config.validationTimeoutMs ?? DEFAULT_PROFILE_VALIDATION_TIMEOUT_MS
  }

  /** Validate deployment configuration without materializing Profile state or loading SQLite. */
  protected async [Service.init](): Promise<void> {
    assertProfileValidatorInstallAnchor(this.config.installAnchor)
    await this.translate(() => this.store.initialize())
  }

  snapshot(profile: ProfileId): Promise<ProfileSnapshot> {
    return this.translate(async () => asSnapshot(await this.store.snapshot(profile)))
  }

  stage(request: StageProfileGenerationRequest): Promise<StagedProfileGeneration> {
    const ownedRequest = freeze(request)
    return this.translate(async () => {
      const staged = await this.store.stage(ownedRequest, candidate => this.validateCandidate(
        candidate.profile,
        candidate.generationPath,
      ))
      return {
        profile: profileId(staged.profile),
        mutationId: profileMutationId(staged.mutationId),
        generation: staged.generation as ProfileGenerationId,
        basedOnRevision: staged.basedOnRevision,
        basedOnTreeDigest: staged.basedOnTreeDigest as ProfileTreeDigest,
        treeDigest: staged.treeDigest as ProfileTreeDigest,
        mutation: asMutation(staged.mutation),
      }
    })
  }

  /**
   * Run the non-replaceable production validator used by the Service API.
   * Test-only subclasses may isolate storage semantics without changing the
   * exported Provider or letting a Consumer pass a validation callback.
   * @param profile - named candidate Profile.
   * @param generationPath - complete staged tree.
   * @returns after real isolated Loader activation.
   */
  protected validateCandidate(profile: string, generationPath: string): Promise<void> {
    return validateProfileGenerationIsolated(
      profile,
      generationPath,
      this.config.installAnchor,
      this.validationTimeoutMs,
    )
  }

  commit(request: CommitProfileGenerationRequest): Promise<ProfileCommitReceipt> {
    const ownedRequest = freeze(request)
    return this.translate(async () => {
      const receipt = await this.store.commit(ownedRequest)
      return { ...receipt, before: asSnapshot(receipt.before), after: asSnapshot(receipt.after) }
    })
  }

  abort(request: AbortProfileGenerationRequest): Promise<boolean> {
    const ownedRequest = freeze(request)
    return this.translate(() => this.store.abort(ownedRequest))
  }

  restoreLastGood(request: RestoreLastGoodProfileRequest): Promise<ProfileCommitReceipt> {
    const ownedRequest = freeze(request)
    return this.translate(async () => {
      const receipt = await this.store.restoreLastGood(ownedRequest)
      return { ...receipt, before: asSnapshot(receipt.before), after: asSnapshot(receipt.after) }
    })
  }

  getRestoreReceipt(request: GetProfileRestoreReceiptRequest): Promise<ProfileRestoreReceipt | null> {
    const ownedRequest = freeze(request)
    return this.translate(async () => {
      const receipt = await this.store.getRestoreReceipt(ownedRequest)
      if (receipt === null) return null
      return {
        ...receipt,
        mutationId: profileMutationId(receipt.mutationId),
        before: asSnapshot(receipt.before),
        after: asSnapshot(receipt.after),
      }
    })
  }

  acknowledgeBoot(request: AcknowledgeProfileBootRequest): Promise<ProfileCommitReceipt> {
    const ownedRequest = freeze(request)
    return this.translate(async () => {
      const receipt = await this.store.acknowledgeBoot(ownedRequest)
      return { ...receipt, before: asSnapshot(receipt.before), after: asSnapshot(receipt.after) }
    })
  }

  list(profile: ProfileId): Promise<ProfileGenerationInventory> {
    return this.translate(async () => {
      const inventory = await this.store.list(profile)
      return {
        snapshot: asSnapshot(inventory.snapshot),
        active: inventory.active === null ? null : asSummary(inventory.active),
        staged: inventory.staged.map(asSummary),
        recoverable: inventory.recoverable.map(asSummary),
      }
    })
  }

  private async translate<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof LocalProfileRevisionConflictError) {
        throw new ProfileRevisionConflictError(profileId(error.profile), error.expected, error.actual)
      }
      if (error instanceof LocalProfileTreeConflictError) {
        throw new ProfileTreeConflictError(
          profileId(error.profile),
          error.expected as ProfileTreeDigest,
          error.actual as ProfileTreeDigest,
        )
      }
      if (error instanceof LocalProfileContentConflictError) {
        throw new ProfileContentConflictError(
          profileId(error.profile),
          error.expected as ProfileContentDigest,
          error.actual as ProfileContentDigest,
        )
      }
      if (error instanceof LocalProfileMutationConflictError) {
        throw new ProfileMutationConflictError(
          profileId(error.profile),
          profileMutationId(error.mutationId),
        )
      }
      throw error
    }
  }
}

export default LocalProfileTransactions
