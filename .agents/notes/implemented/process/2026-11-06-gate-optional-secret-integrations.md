# Agent Note: Gate optional secret-backed CI integrations

Status: implemented

English | [中文](2026-11-06-gate-optional-secret-integrations.zh.md)

## Problem

A fork of this repository has no repository secrets or variables configured. Three pull-request workflows consumed them unconditionally: [Build PR preview](../../../../.github/workflows/build-preview-cloudflare.yml) ran `wrangler pages deploy` with empty `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and [Issue policy](../../../../.github/workflows/issue-policy.yml) and [Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml) called `create-github-app-token` with an empty `DSH_ISSUE_APP_CLIENT_ID`. Each failed on the first credential-dependent step, so every PR in such a fork carried three red checks unrelated to the change under review. GitHub also withholds secrets from untrusted forked PRs and Dependabot PRs, so the same hard failures occur in the upstream repository regardless of its own secret configuration.

## Decision

The Cloudflare Pages preview and the Project App board integration are optional. Their workflows still run the credential-free portion (checkout, install, full workspace build and VFS image packing for the preview), and skip only the steps that require credentials. A job skipped by a job-level `if:` reports as a successful check rather than a gray skip, so the jobs remain unconditional and the gates are step-level.

The `secrets` context is unavailable in both `jobs.<job_id>.if` and `jobs.<job_id>.steps.if`; `vars` is available, but relying on it alone would leave `private-key` empty. Each workflow therefore has one gate step that reads the credentials through a step-level `env` (the context the [official docs](https://docs.github.com/en/actions/security-guides/encrypted-secrets) prescribe for this case) and writes `enabled=true` or `enabled=false` to `$GITHUB_OUTPUT`. The credential-dependent steps consume that single output, keeping one condition per workflow. Both credentials absent is the keyless case and skips cleanly; exactly one present is a misconfiguration and fails with an explicit `::error::`, so a partially configured integration cannot silently report a false green.

The build steps stay unconditional: a keyless fork still proves the preview compiles. When credentials are present the deployment, protected-image verification, idempotent URL comment, human-PR policy, and board mutations behave exactly as before.

## Alternatives considered

**Configure the secrets in the fork.** It fixes this fork only, cannot be done by a PR, and does not address untrusted forked PRs or Dependabot PRs that GitHub keeps keyless. The integration is optional for those events, so a workflow-level fix is the durable one.

**Reference `secrets.*` directly in `if:`.** The context is unavailable in conditionals; at job level GitHub rejects the expression as an unrecognized named-value, and at step level it resolves to an empty string that silently skips the step. Reading through `env` and emitting an output is the documented pattern.

**Gate on `vars.DSH_ISSUE_APP_CLIENT_ID` alone.** `vars` is available in `if:`, but a fork can set a client-id variable without the matching private-key secret. The token action would then fail again, and the two credentials would disagree. The gate checks both.

**A separate gate job with `needs` outputs.** It moves the decision into the workflow graph and makes the PR check gray for keyless forks. One step in the existing job keeps the check green and avoids an extra runner.

**`continue-on-error` on the deployment steps.** It hides genuinely broken deployments, leaves the protected-image verification and URL comment running against a deployment that never happened, and gives no signal for partial configuration.

## Consequences

A keyless fork gets no deployed preview and no Project board updates; those features require a maintainer to configure the credentials. The credential-free build still consumes a runner for every PR. A fork that configures exactly one of the two values fails loudly until it configures both. The gate is a shell step reading secrets through `env`, so its output is a boolean only; no credential value is written to the step output or logs.

## Verification

[Preview workflow regressions](../../../../scripts/preview-workflow.spec.ts) pin the gate's `env` mapping, both output branches, the partial-configuration failure, the three deployment-owned `if:` conditions, and the unconditional build. [CI workflow regressions](../../../../scripts/ci-workflow.spec.ts) pin the same for both issue workflows and the combined conditions on their token and board steps. The gate scripts pass `bash -n` and a three-state simulation (both absent, exactly one present, both present). These checks verify configuration and shell control flow; they do not exercise GitHub's runtime secret redaction or a live Cloudflare deployment.
