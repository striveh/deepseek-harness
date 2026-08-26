# `@deepseek-ai/dsh`

[English](README.md) | 中文

`dsh` 是 DeepSeek Harness 中用于启动 profile 的命令；profile 由多个插件组合包 patch 层按顺序叠加而成，其上再应用用户自己的覆盖配置。[`src/args.ts`](src/args.ts) 负责命令语法，[`src/bin.ts`](src/bin.ts) 只加载选中的运行器。无效命令、来自其他模式的选项、配置错误和启动失败都会以非零状态退出。

## 入口模式

| 命令 | 用途 |
|---|---|
| `dsh --profile <name>` | 启动位于 `$DSH_HOME/profiles/<name>` 的指定 profile。 |
| `dsh --profile headless "job"` | 运行一个全新的持久化会话，打印最终答案并退出。 |
| `dsh web` | `--profile web` 的别名。 |
| `dsh plugin --profile <name> <operation>` | 通过 Profile transaction 执行确切 install、update、uninstall、configure、restore 或只读 list。 |

运行命令时所在的目录将作为默认 workspace 根目录。`web` 和 `headless` profile 在首次使用时会从随附模板自动初始化。Profile mutation 会为下一进程发布完整 generation，并打印 `restart required`。在 Node 22 上，launcher 只过滤准确的 SQLite `ExperimentalWarning`；所有产品诊断与其他 runtime warning 仍会显示在 stderr。

## 应用参数

启动器只解析自身的 flag，并将其后的所有内容交给已启动的 profile；注入该 profile 的任意应用插件都可以解析这份共享的不可变快照（[`dsh-cmdline`](../../packages/boot/cmdline/README.zh.md)）。因此，启动器的 flag 必须写在最前面；启动器无法识别的第一个 token 标志着应用参数的开始：

```sh
dsh --profile web --port 8080       # --port belongs to the web app
dsh --profile tui --resume <id>     # example, assuming the tui profile is installed; --resume belongs to the terminal app
dsh --profile headless "run the tests"
dsh --profile web --help            # the web app's flags, not the launcher's
dsh --help                          # the launcher's own help
```

<a id="profiles"></a>

## Profile

profile 目录包含一个 `package.json`，其中记录树外插件依赖，以及 profile manifest（元数据清单）`dsh.profile` 和其中按顺序排列的 `bundles` 列表；还包含一个 `cordis.patch.yml`，其中保存用户自己的 patch 层。

每次调用都会使用自己由 launcher 持有的空根文件。未受管的 live Profile 仍是相对 entry 的解析基准。对于 active managed generation，launcher 会把 digest 匹配的 tree 复制到同一调用私有的 runtime root，并且只把该副本交给 Loader；之后即使 authoritative generation 的 bytes 被替换，也不会成为被导入的 plugin code。boot 失败或 app dispose 会移除私有 root 与副本。每个 root name 都绑定 owner PID 与确切 process incarnation；后续 preparation 会移除 owner 已退出或 PID 已复用的 root，同时保留仍存活的并发调用。并发启动不会共享或写入 Profile generation 的 `cordis.yml` 路径。

配置树按以下顺序叠加：
- `dsh.profile.bundles` 中各组合包的 patch
- profile 自身的 `cordis.patch.yml`，然后是 home 级的 `$DSH_HOME/cordis.patch.yml`
- `--patch` 指定的覆盖层

`dsh.profile.bundles` 中列出的组合包先从 dsh 安装目录解析（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-headless`），再从 effective live tree 或调用私有 managed 副本的真实 `node_modules` package 文件解析。

`dsh plugin install` 与 `update` 要求一个本地 `.tgz`、确切 package name/version 和规范 SHA-256。`uninstall` 指定已安装 package。`configure` 携带 typed adapter 生成的完整规范化 `cordis.patch.yml` bytes 与当前/下一份 digest。每次写操作还要求调用方持有的 `--mutation-id`；完成结果不明确时，应以完全相同的 id 和命令重试，绝不能把该 id 绑定到不同输入。revision 或 tree conflict 能证明 commit 尚未发布，因此 CLI 会丢弃该未引用 candidate，并允许同一 intent 重新 stage；其他 commit failure 都会保留 generation 以供精确重放。任意 pnpm 写入都会被拒绝。transaction owner 读取首份 snapshot 前，首次 install 会原子初始化或严格续接随附 Web template，再使用与普通 Profile boot 相同的解析 authority 修复安装持有的 `profiles/node_modules` fallback。每个 mutation 都构建完整 candidate，在 credential-minimized child 中运行真实 Web Loader validation，提交 pending-restart pointer，并且只有下一次真实应用 boot 成功后才成为 last-good。validation 会以 host 文件系统和网络 authority 执行已接纳 code；它不是沙箱。managed generation patch 不会热重载；home-level patch 仍保持 live。

使用 `--dump-default-config` 和 `--dump-config` 可在不启动的情况下检查组合后的配置树。

层的确切优先级、flag、关闭行为、部署默认值和源码执行方式，以 [CLI（命令行界面）行为参考](reference/README.zh.md)为准。

## 开发

生产运行需要已构建的包与前端产物。请在仓库根目录单独运行 `pnpm run build`，然后使用 `pnpm dsh <args...>` 运行 TypeScript 入口并转发所有参数；模块解析约定以[源码执行参考](reference/README.zh.md#source-execution)为准。
