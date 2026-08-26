# 打包与安装插件

[English](publish.md) | 中文

本教程把本地插件打包成完整的 `.tgz` 组合包，并通过确切的 P0 Profile 事务管理它。P0 只接受本地产物：注册表发现、下载、信任与审批发生在 `dsh plugin` 命令之前。本文假设 `dsh` CLI（命令行界面）已安装。请先完成[插件配置](./config.zh.md)。

如果使用全新的源码 checkout，请先完成[从源码运行](../../../../README.zh.md#run-from-source)，将本教程的 `hello-plugin` 目录保留在仓库根目录，并把下文每个 `dsh ...` 调用替换为 `pnpm dsh ...`。启动器行为见[源码执行](../../../../apps/cli/reference/README.zh.md#source-execution)。

## 构建 P0 组合包

创建包目录：

```sh
mkdir -p hello-plugin
```

这个包包含 npm manifest（元数据清单）、一个组合包 patch，以及该 patch 引用的插件模块：

```
hello-plugin/
├── package.json       # declares dsh.bundle
├── cordis.patch.yml   # bundle layer
└── index.js           # plugin module
```

创建 `hello-plugin/package.json`：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

版本必须是 `0.1.0` 这样的确切 SemVer，不能是范围或标签。P0 产物不能声明非空的 `dependencies`、`optionalDependencies`、`bundledDependencies` 或 `bundleDependencies`；也不能声明 `preinstall`、`install`、`postinstall`、`prepare` 脚本或任何 `bin` 条目。所有运行时文件都必须包含在 archive 中。

创建 `hello-plugin/index.js`：

```js
export const name = 'hello-plugin'

export function apply() {
  console.log('[hello-plugin] plugin loaded!')
}
```

创建 `hello-plugin/cordis.patch.yml`。组合包 patch 按包名引用已安装代码：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

请求 `--kind bundle` 时，`dsh.bundle.patch` 必须指向 archive 内的普通文件。只有不含组合包声明的产物才使用 `--kind package`；这种包会被安装，但不会贡献 patch 层。

## 打包并计算确切产物的摘要

打包完整产物，再计算这份 `.tgz` 确切字节的 SHA-256：

```sh
cd hello-plugin
pnpm pack
cd ..
ARTIFACT_SHA256="$(shasum -a 256 ./hello-plugin/dsh-hello-plugin-0.1.0.tgz | awk '{print $1}')"
```

CLI 要求规范摘要形式 `sha256:<64-lowercase-hex>`。重新打包会改变字节，因此每次打包后都要重新计算摘要。

## 安装进 Web Profile

使用 archive 声明的确切名称、版本、摘要和种类安装组合包：

```sh
dsh plugin --profile web install \
  ./hello-plugin/dsh-hello-plugin-0.1.0.tgz \
  --package dsh-hello-plugin \
  --version 0.1.0 \
  --digest "sha256:${ARTIFACT_SHA256}" \
  --kind bundle
```

`install` 要求该包尚未存在。首次使用时，它会初始化 `web` Profile、保留其内置组合包、记录确切 package 与 owner 维护的 lock 数据，并把通过验证的组合包追加到有序组合包列表。commit 成功会打印 `restart required`，不会修改正在运行的 Web 进程。

检查等待生效的 generation，然后启动一个新的 Web 进程。如果 Web 已在运行，请先停止它，再执行第二条命令：

```sh
dsh plugin --profile web list
dsh web
```

新进程会启动 active immutable generation，并且只有在真实 Loader 激活成功后才将其确认为 last-good。启动失败时，此前的 last-good generation 仍可用于恢复。

## 使用确切生命周期操作

`dsh plugin` 只接受 `install`、`update`、`uninstall`、`configure`、`restore` 和 `list`。它会拒绝 `add`、`remove`、任意 pnpm verb，以及不受支持或重复的 flag。

### 更新

把 package manifest 改为确切的下一版本，重新打包，并通过 `update` 提交该产物。该 package 必须已经安装；命令中的名称、版本、摘要和种类必须与新 archive 完全一致：

```sh
cd hello-plugin
pnpm pack
cd ..
UPDATED_ARTIFACT_SHA256="$(shasum -a 256 ./hello-plugin/dsh-hello-plugin-0.2.0.tgz | awk '{print $1}')"
dsh plugin --profile web update \
  ./hello-plugin/dsh-hello-plugin-0.2.0.tgz \
  --package dsh-hello-plugin \
  --version 0.2.0 \
  --digest "sha256:${UPDATED_ARTIFACT_SHA256}" \
  --kind bundle
```

更新只在重启后生效。

### 配置

配置是由 owner 管理的 Profile 完整 `cordis.patch.yml` 替换，不是片段合并。已安装 package 的类型化适配器必须生成使用 LF 换行并以换行符结尾的规范 UTF-8 文本。从 `list` 读取 `snapshot.effectivePath`，分别计算当前字节与完整下一文件的摘要，再指定已安装的 owner package：

```sh
dsh plugin --profile web list
EFFECTIVE_PROFILE=/absolute/path/from-list
EXPECTED_PATCH_SHA256="$(shasum -a 256 "${EFFECTIVE_PROFILE}/cordis.patch.yml" | awk '{print $1}')"
NEXT_PATCH_SHA256="$(shasum -a 256 ./next.cordis.patch.yml | awk '{print $1}')"
dsh plugin --profile web configure dsh-hello-plugin \
  --patch-file ./next.cordis.patch.yml \
  --expected-digest "sha256:${EXPECTED_PATCH_SHA256}" \
  --next-digest "sha256:${NEXT_PATCH_SHA256}"
```

owner package 未安装、当前字节陈旧、下一摘要不匹配或下一文件未规范化时，事务会拒绝请求。配置同样需要重启。

### 卸载、恢复与列出

这些操作应彼此独立使用：

- `dsh plugin --profile web uninstall dsh-hello-plugin` 在一个通过验证的 generation 中移除已安装 package、保留的产物及其组合包列表条目。
- `dsh plugin --profile web restore` 会在 active generation 尚未验证时发布 last-good，否则发布已验证的 rollback generation。没有可恢复 generation 时，该操作会失败。
- `dsh plugin --profile web list` 完全只读，报告 active、staged 与 recoverable generation、启动状态以及 effective Profile 路径。

卸载和恢复会打印 `restart required`；列出操作从不改变 Profile 状态。

## 验证与重启行为

每个 P0 mutation 都遵循相同规则：

- 只有 `web` Profile 接受安装、更新、卸载、配置或恢复 mutation。`list` 完全只读。
- 安装要求确切 package name 尚不存在；更新、卸载与配置要求该确切 package 已安装。
- transaction owner 会复制完整 effective Profile、验证产物身份与摘要、一起更新 package graph 与 lock record，并在 commit 前对未改变的候选项运行 Provider 持有的真实 Web Loader 激活。
- commit 会发布 immutable generation 并返回 `restart required`，不会热替换当前进程。受管理的 Profile 配置跨越相同的重启边界。

验证 child 会尽量减少继承的凭据与提供方设置，但它不是文件系统或网络沙箱。已接纳插件仍以 host 用户的操作系统权限执行，因此只有确切字节已经审批的 package 产物才能进入此命令。

## 下一步

- [插件与生命周期](../framework/index.zh.md) — 插件编程模型
- [CLI 行为参考](../../../../apps/cli/reference/README.zh.md) — 确切事务字段、恢复、验证与重启行为
