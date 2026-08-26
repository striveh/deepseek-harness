# Agent Note: 把完整构建绑定到仓库源码与运行时产物

Status: implemented

[English](2026-08-26-repository-build-record.md) | 中文

## Problem

本地集成验收执行构建后的 `lib` 文件，而普通源码测试通过 workspace import 解析到 `src`。因此，同一 checkout 可能同时包含当前源码和更早一次构建留下的运行时输出。检查输出存在或返回相同 package version，不能证明实际执行的 bytes 来自当前 checkout，因为多个源码 revision 通常共用同一 package version。

Extension Center 的 local-HEAD 验收必须区分当前源码证据与旧 Host 输出上的运行结果。修改时间不足以完成证明，因为复制文件、恢复缓存和时钟差异都可能让不相关的源码与输出看似新鲜。

## Decision

每次根级 `pnpm run build` 成功后都会写入 format-v2 `.dsh-build/repository-build.json`。该记录包含覆盖全部 Git 已跟踪与未忽略源码 entry 的确定性内容摘要和文件系统身份摘要，并包含覆盖 Host-side 应用、package 与 vendored package `lib` 文件的内容摘要；每份摘要都记录准确文件数。独立的 client-build record 继续负责 `apps/web/dist`、动态 Client bundle 与公开浏览器环境值。

源码内容摘要对仓库相对路径、普通文件、符号链接或已跟踪但缺失的 kind、可执行 mode 与 bytes 做分帧。身份摘要对同一路径与 kind，以及 device、inode、size、纳秒 modification time、纳秒 change time、完整 mode 和原始符号链接 target 做分帧；access time 被有意排除。源码 symlink 必须解析到 canonical checkout 内部，经由链接目录可达的每个文件本身也必须属于记录的源码集合。Host-side `lib` 扫描会纳入 dotfile，保留 POSIX 反斜杠等字面路径字符，排除 TypeScript build-info 文件，并拒绝 symlink 与非普通产物。

构建包装器会在构建编排开始前立即观测源码，并在 library 与 Web 构建步骤完成后再次观测。内容或身份观测不同会拒绝构建，且不留下新记录。成功观测会先写入带 process 与 UUID 的唯一临时文件，再通过原子 rename 发布；局部构建命令不会更新该记录。

任何声称当前 checkout 证据的消费者，都要在执行构建入口前独立重算源码与 Host-side `lib` 摘要，并要求准确相等。长时间运行的验收 lane 还要在结束点重复验证，并要求 record bytes 保持相同 SHA-256。该记录是被 Git 忽略的本地 checkout 证据，不是已发布兼容性承诺，也不能替代 packed artifact、Client/browser 或已发布 Host 验收。

这些都是端点观测。身份摘要可以发现普通原地重写与同内容原子替换，但不能证明不存在以无法区分的内容和 metadata 恢复的瞬态修改、编译器实际消费了观测到的 bytes，或输出来自不可变源码 snapshot。需要因果构建来源的声明必须另行设计隔离的不可变源码构建与产物发布流程。

## Alternatives considered

**比较修改时间。** 文件时间戳不绑定内容，也可能倒退或随复制缓存保留。

**只比较 `git rev-parse HEAD`。** dirty tracked 文件或未忽略的 untracked 构建输入可以偏离 HEAD，而报告的 commit 不变。

**执行构建后的 CLI 并比较 version。** 源码与旧输出通常携带同一 pre-release package version。

**让每个消费者重新构建 Host checkout。** 验收工具不应修改调用方选择的 checkout；重新构建也不能留下可供后续证明输出未再变化的持久 receipt。

**从不可变源码 snapshot 运行完整构建。** 这可以支持更强的因果声明，但当前根构建跨越 pnpm workspace link、TypeScript Project Reference、tsdown 与调用方 checkout 中的 Vite 输出。Snapshot 构造与产物发布因此需要独立的全仓设计，不能仅作为 P0 verifier 修改完成。

## Consequences

当记录缺失、任一源码端点不同、记录生成后源码变化、Host-side `lib` 文件变化，或只执行局部构建时，当前 checkout 集成证据会 fail closed。完整构建会增加一次仓库源码扫描与一次运行时产物扫描。任何未忽略的源码变化（包括文档）都需要重新执行完整构建；这里优先采用完整的本地观测，而不是维护更小的依赖近似。

repository build record 回答的是：当前源码观测与当前 Host-side `lib` 产物是否等于完整构建包装器记录的集合。它不声称不可变或因果的 source-to-output 来源，也不替代 browser 产物使用的 client-build record。
