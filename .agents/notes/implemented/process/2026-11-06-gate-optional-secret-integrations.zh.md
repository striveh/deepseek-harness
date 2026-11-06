# Agent Note: 为依赖密钥的可选 CI 集成加门控

Status: implemented

[English](2026-11-06-gate-optional-secret-integrations.md) | 中文

## Problem

本仓库的一个 fork 未配置任何仓库密钥或变量。三个 PR 工作流无条件消费这些凭据：[Build PR preview](../../../../.github/workflows/build-preview-cloudflare.yml) 在 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 为空时执行 `wrangler pages deploy`；[Issue policy](../../../../.github/workflows/issue-policy.yml) 与 [Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml) 在 `DSH_ISSUE_APP_CLIENT_ID` 为空时调用 `create-github-app-token`。三者都在首个依赖凭据的步骤失败，使该 fork 的每个 PR 都带着三个与被审改动无关的红叉。GitHub 同样不向不受信任的 fork PR 与 Dependabot PR 提供密钥，因此上游仓库无论自身如何配置密钥，这两类 PR 都会遇到相同的硬失败。

## Decision

Cloudflare Pages 预览与 Project App 看板集成是可选能力。相关工作流仍执行不依赖凭据的部分（预览工作流完成检出、安装、全工作区构建与 VFS 镜像打包），只跳过需要凭据的步骤。由作业级 `if:` 跳过的作业会报为成功而非灰色的 skip，因此作业保持无条件，门控放在步骤级。

`secrets` 上下文在 `jobs.<job_id>.if` 与 `jobs.<job_id>.steps.if` 中均不可用；`vars` 可用，但只依赖它会让 `private-key` 仍为空。每个工作流因此增加一个门控步骤：通过步骤级 `env`（[官方文档](https://docs.github.com/en/actions/security-guides/encrypted-secrets) 针对此场景规定的上下文）读取凭据，并向 `$GITHUB_OUTPUT` 写入 `enabled=true` 或 `enabled=false`。依赖凭据的步骤消费这一个输出，使每个工作流只有一处条件。两个凭据都缺失属于无密钥场景，正常跳过；只配置其中一个属于配置错误，以明确的 `::error::` 失败，避免半配置的集成静默报出假绿。

构建步骤保持无条件：无密钥的 fork 仍能证明预览可以编译。凭据齐备时，部署、受保护镜像校验、幂等的预览 URL 评论、人类 PR 策略与看板变更的行为与改动前完全一致。

## Alternatives considered

**在该 fork 配置密钥。** 只能修好这一个 fork，无法通过 PR 完成，也不覆盖 GitHub 保持无密钥的不受信任 fork PR 与 Dependabot PR。集成对这些事件本就是可选的，工作流层面的修复才持久。

**在 `if:` 中直接引用 `secrets.*`。** 该上下文在条件中不可用：作业级会被 GitHub 判为无法识别的命名值，步骤级则解析为空字符串并静默跳过步骤。经 `env` 读取并输出布尔值是文档规定的做法。

**只用 `vars.DSH_ISSUE_APP_CLIENT_ID` 做门控。** `vars` 在 `if:` 中可用，但 fork 可能设置了 client-id 变量却没有对应的私钥密钥，令牌 action 会再次失败，两个凭据也会不一致。门控同时检查两者。

**用独立的门控作业加 `needs` 输出。** 这会把决策放进工作流图，并让无密钥 fork 的 PR 检查变成灰色。在现有作业里加一个步骤既能保持检查为绿，也省掉一个 runner。

**给部署步骤加 `continue-on-error`。** 它会掩盖真正损坏的部署，让受保护镜像校验与 URL 评论针对一个从未发生的部署继续运行，且对半配置不给出任何信号。

## Consequences

无密钥的 fork 得不到已部署的预览，也不会更新 Project 看板；这些能力需要维护者配置凭据。免凭据的构建仍为每个 PR 占用一个 runner。只配置两个值中其一的 fork 会明确失败，直到两者齐备。门控是经 `env` 读取密钥的 shell 步骤，其输出只有布尔值；任何凭据值都不会写入步骤输出或日志。

## Verification

[预览工作流回归测试](../../../../scripts/preview-workflow.spec.ts) 固定门控的 `env` 映射、两个输出分支、半配置失败、三个部署所属步骤的 `if:` 条件，以及无条件的构建。[CI 工作流回归测试](../../../../scripts/ci-workflow.spec.ts) 对两个 issue 工作流固定同样内容，并固定令牌与看板步骤的组合条件。门控脚本通过 `bash -n`，并完成三态模拟（两者皆缺、仅配其一、两者齐备）。这些检查验证配置与 shell 控制流，不覆盖 GitHub 运行时的密钥脱敏，也不覆盖真实的 Cloudflare 部署。
