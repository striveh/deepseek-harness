# @deepseek-ai/dsh-task-continuation

English | [中文](README.zh.md)

Service Definition for single-use task continuation claims on `ctx.taskContinuations`. A claim binds one exact session, original direct-user message, capability-need digest, task revision, verifier, verification-payload digest, dispatch identity, and expiry. It never stores the original task text or an installation payload.

Dynamic Consumers require both `instanceof TaskContinuationService` and the literal `protocolVersion === 1`. Revision and verifier identities are distinct `TaskContinuationRevision` and `TaskContinuationVerifierId` values constructed by their validating helpers. `create()` parks a fixed plugin `UserMessage` without waking the Agent. `reserve()` additionally binds a caller id and mutation id to the exact persisted Session/task reference and restricted Agent resume options, so a cold caller retry returns the same claim. A registered verifier may only report readiness by echoing every authority-bearing field. `cancel()` and `supersede()` require the exact session and task revision and return `false` after the claim reaches recoverable `consumed` dispatch intent. The concrete driver owns durable storage, recovery, dispatch claiming, and model-request admission.

The lifecycle states distinguish waiting (`pending`), verified (`ready`), recoverable dispatch intent (`consumed`), the durable pre-provider at-most-once barrier (`claimed`), and terminal cancellation, supersession, expiry, or invalid evidence. A provider may recover `consumed` under the same message identity, but it must durably transition to `claimed` before returning pre-step admission to AgentLoop. A crash after that barrier may leave no continuation `user/message` event or model request; recovery never redelivers the claim. A newer authoritative direct-user message supersedes the older task before verification, consumption, dispatch, or barrier commit.

## Model Experience

### Verified continuation message

#### What the model sees

Only a verified `consumed` claim may pass pre-step checks, and the provider must commit `claimed` before AgentLoop can enter the request. Pending and other terminal claims are rejected before a model request. No original task or verification payload is duplicated into the fixed message:

##### Fixed continuation prompt

```markdown
The requested capability is now verified for the existing task. Re-check it and continue that task.
```

#### Token effect

Each admitted claim adds one fixed user-role message. The message remains in Session history and contributes its fixed tokens to later requests until ordinary compaction replaces that history.

#### KV Cache effect

The continuation message appends after the existing reusable prefix. Its fixed text is stable; claim identities and digests stay in message attribution and do not change model-visible content.

## Known Limitations and Deferred Work

- **Provider required** — this package defines values, validation, and verifier registration; a concrete provider owns durable records, recovery, and pre-step admission.
- **At-most-once barrier, not completion** — `claimed` proves only that the provider durably closed redelivery before AgentLoop could invoke the model. A crash in the following write-behind window may leave no continuation event or request, and the state cannot prove provider completion, network delivery, or downstream side effects.
