# Agent Note: 完整 Profile generation 事务

Status: implemented

[English](2026-08-25-profile-generation-transactions.md) | 中文

## 问题

直接包管理器写入会让应用启动看到只替换一部分的 Profile manifest、lock record、module、archive 与 patch。单独的锁可以串行化 writer，却不能向 reader 隐藏部分文件、恢复 pointer 发布期间被杀死的进程、保留原始 live Profile，或证明被选择的 tree 真正可启动。

Extension Center 还需要唯一 mutation owner。pre-Loader resolver 对选择当前 tree 必不可少，但它无法服务 Web Loader 内运行期 install/update/uninstall/configure 请求；反之，运行期 Provider 不能改变自身进程已经选择的 tree。

## 决策

[`dsh-profile-transactions`](../../../../packages/profile/profile-transactions/README.zh.md) 定义生命周期和 branded state。[`dsh-profile-transactions-local`](../../../../packages/profile/profile-transactions-local/README.zh.md) 持有完整本地 generation、确切 mutation admission、pnpm lock 一致性、tree/content/revision fence、SQLite 协调、journal recovery、baseline capture、boot acknowledgement 与 restore selection。

每个 generation 都是完整 Profile tree：manifest 与有序 bundles、根 patch、workspace 与 lockfile、保留的本地 archive，以及真实 package 文件。本地 owner 使用维护中的 `tar` 与 `yaml` 包。P0 接受一个确切 `.tgz` install/update、已安装 package uninstall，或由已安装 package 持有的根 patch 替换。带前导零的数字 prerelease identifier 会被拒绝。压缩输入与声明的解压内容有独立的 100 MiB 上限；复制路径同时检查初始大小与实际观察到的字节数，因此文件在 `stat` 后增长也会 fail closed。带 dependency、安装 lifecycle script、`bin` entry、不安全 path/type 或 name/version/digest 不匹配的 archive 都会在 validation 前失败。对于当前是 direct bundle，或经 bundle install/update 后会成为 direct bundle 的每个 package，owner 会重复 app-boot 的确切 installation-anchor lookup，并在 reservation、candidate 创建、archive 访问或 validation 前拒绝可从安装解析的冲突；completed replay 也会重复同一归属检查。因此 app-boot 的安装优先 resolution 永远不会用安装 bytes 替换已准入的 artifact。archive entry 预检与 extraction 会保留各自累计的 entry/byte state，记录 callback 拒绝，并在 reader settle 后拒绝所属 Promise，因此已复制 archive 在两遍之间改变时，admission 也会 fail closed，不会产生未捕获的 callback 错误或一直 pending 的 stage。manifest 与 lockfile dependency mutation 使用 null-prototype map 与自有 key membership，因此合法 Object prototype name 无法伪装成已安装 owner，也不会在 install 时消失。configure 携带当前与下一份 content digest，以及规范化下一份 UTF-8 bytes；owner 只改变 `cordis.patch.yml`，不解析 YAML。

CLI 首次 install 可能早于普通 Web Profile boot。transaction owner 读取首份 snapshot 前，app-boot 会通过已 flush 的同目录临时文件与原子且不替换既有 pathname 的发布来初始化随附 Web template。保留 transaction sibling 下的 SQLite writer lease 会串行化 initializer，并在进程退出后释放；携带 PID 与 incarnation 的 companion 名称可以区分 live work 和 dead residue。recovery 只会补全四份随附模板的精确子集，因此并发 initializer 会收敛到完整模板 bytes，而中断写入留下的模板前缀或任何无关的既有 bytes 都会明确失败且原样保留，等待人工检查。CLI 随后在 stage 前修复安装持有的 `profiles/node_modules` fallback，使用后续产品启动所用的同一 app-boot 解析 authority。因此 validator 会执行标准 base 与 Web row，而不是缩减的 synthetic Profile。

每个请求都由单调 revision 与 effective tree 的 canonical digest 双重 fence。stage 与 restore 还要求调用方 mutation id。Provider 会在首次 asynchronous store operation 前同步 clone 并递归 freeze mutation 与 transition request，因此调用方之后的写入无法重定向 Profile、generation、mutation identity 或嵌套 artifact input。短 SQLite transaction 会预留每个 stage identity，archive 构建与真实 Loader validation 不持有 database transaction，另一个短 transaction 再 finalize 唯一 generation。只有确切 `STRICT` table SQL、完整 column metadata、check 与 primary/unique index 全部匹配时，当前 coordinator version 才会被接受。完全相同的并发或冷重试会收敛到一个 generation。每个 building reservation 都绑定 owner PID 与确切 OS process-creation identity，先排除进程退出与 PID 重用。其确切 stage Promise 还会持有独立 SQLite OS lock，contender 会跨 Worker thread 与进程探测该 lock。存活的 Worker 与 Promise 会保留 reservation；Worker 异常退出时 OS 会释放 lease，之后的重试即可替换。未完成 stage identity 包含初始 fence；commit 后的持久 identity 则由 Profile、mutation id 与 semantic mutation 组成，不包含更新后的 fence 与 artifact transport path。等价重试返回原 generation 与 before/after receipt，同 id 的不同 semantic input 会失败。staging 复制完整 held tree，应用确切 change 与 owner 管理的 pnpm importer/package/snapshot record，校验完整性，再调用本地 Provider 持有的真实 Loader validator。Service 不接受 Consumer callback。validator 修改或失败会删除 candidate。stage work 与 reservation cleanup 同时失败时，有序 aggregate 会把 stage failure 放在首位；lease 不再被持有后，重试可以替换 reservation。首次 commit 在 SQLite `BEGIN IMMEDIATE` 内重新检查两个 fence。

首次 commit 会把原始 live Profile 捕获为不可变 baseline 与 last-good target。如果 live tree 在捕获后改变，或另一项发布前步骤失败，owner 只会在确认 state 与 journal 都没有引用新 baseline 后将其删除，再 flush generations directory。已提交 candidate 是 active，但处于 pending restart。CLI 的短生命周期 bootstrap Context 只有在 snapshot 把每个 pointer 指向的不可变 generation 与已记录 tree digest 比对后，才会选择 active directory。它通过 Provider 持有的 copy primitive 把完整 selected tree 复制到调用私有的 runtime root，按 selected digest 验证私有 target，从该副本加载 Profile，再次确认同一 snapshot。只有该私有副本会成为 Loader 的显式 base；preparation 前或期间的 source edit 会在 digest 或 snapshot fence 失败，之后的 source replacement 则无法提供被导入的 plugin bytes。同一 runtime root 持有 launcher `cordis.yml`，并在 boot 失败或 app dispose 时释放。其 name 会绑定 owner PID 与确切 process-incarnation fingerprint，因此后续 preparation 能删除 SIGKILL residue 与 PID-reuse residue，同时保留存活的并发调用。只有真实 Loader activation 后，CLI 才确认确切 authoritative generation。该 acknowledgement 会把它提升为 last-good，并把原 last-good 移至 rollback。active generation 未验证时 restore 选择 last-good，验证后选择 rollback。

CLI 与运行期有意在同一 `profilesDir` 上挂载两个 `LocalProfileTransactions` instance。bootstrap instance 只在 resolution 与 acknowledgement 前后存在。`dsh-base` instance 服务影响下一进程的运行期 Extension Center 请求。SQLite 提供跨进程 exclusion；两个 instance 都不会在调用之间持锁，运行期 commit 也不会改变本进程 effective directory。

managed generation patch 文件不会被 Profile HMR 重新读取或监听。home patch 仍保持热更新。受管理 Profile 的 configuration change 必须经过 configure staging 和真实 candidate validation；外部 generation edit 则会使下一 tree fence 失败。

pointer transition intent 会在 state replacement 前持久化写入 `journal.json`。commit 与 restore 会保留 correlated journal，直到 SQLite 持有调用方 key、semantic digest 与确切 before/after receipt。进程在 journal fsync 后被杀死，包括 state fsync 后、receipt 持久化前被杀死时，会先恢复同一 receipt 再清理；重试返回原 generation 与 transition，不会再次增加 revision 或重复应用 mutation。真实进程死亡会释放 SQLite reservation。只读 snapshot/list 会投影有效 journal 而不清理；下一 writer 在 state 等于 `before` 时完成 transition，等于 `after` 时接受，其他所有关系都拒绝。owner 创建或接受 `writer.sqlite` 前，会从文件系统根开始，以非递归方式逐级创建到 `.dsh-profile-transactions/<profile>/generations`。每个 component 无论刚创建，还是收到 `EEXIST` 后被确认为目录，都会随后 fsync 其 parent，因此竞争 writer 在自身 fsync 前被杀死时，不会发布可由另一 writer 接受的 authority。任何必需的 parent-directory fsync 失败都会在 coordinator admission 前中止。state、record，以及 generation 中每个受支持的文件和目录都会在发布前 flush。

公开 restore-receipt 查询会取得相同 writer reservation，并在查找确切 Profile 与调用方 mutation id 前完成相关 retained journal。committed 结果携带终态 status 与原 before/after snapshot；不存在时不会初始化 Profile 或选择另一 target。因此，外部 recovery Consumer 能在评估已经变化的 recovery selector 前，区分响应丢失与 restore 尚未开始。

## Validation ownership

本地 Provider 会通过产品 CLI 的隐藏 argv route 启动有界 detached child 做 candidate admission。child 以只读方式加载 staged Profile，组合真实 patch，在 `127.0.0.1` 的 port zero 上启动真实 Web Loader，再释放。配置的 `validationTimeoutMs` 会在 Node 可调度的 timer 范围内限制 activation 与 disposal。parent 会在 stdio 排空后的 child `close` 上 settle。Unix process-group kill 或 Windows `taskkill` 在处理 output-limit 或 timeout 时失败，parent 会先把操作标为 settled，再销毁两条 stdio pipe 并解除 child 的 event-loop 引用。原始 validation failure 仍排在有序 aggregate 首位，彼此独立的 termination 与本端 release failure 随后排列；仍存活的 child 无法继续保留 launcher 的 event loop。child 会等待 dispose 后再无条件移除 validation home；彼此独立的 validation、dispose 与 removal failure 会按顺序保留在 aggregate 中，不会使后续 cleanup 饥饿。合成 root file 位于用后即删的 validation home，明确 Loader base URL 则仍锚定 candidate Profile 根；因此 validation 不改变 candidate bytes，也不会破坏相对 entry 语义。parent 通过 timeout、输出上限和 process-tree termination 隔离失败 plugin。child 只继承进程启动、locale 与临时目录名称，随后把 home、Harness home、XDG、application-data 与临时目录根替换为用后即删的目录。凭据特征名称、凭据文件指针、provider endpoint、proxy、SSH agent authority、Node 注入选项和其他所有 ambient name 都不会传入。P0 在出现另一种真实 activation adapter 前，有意拒绝非 Web candidate。

环境变量最小化与 loopback binding 不是文件系统或网络沙箱。candidate plugin code 已经通过 trust admission，并在 validation 期间以 host 用户的操作系统权限执行。Consumer 必须先完成 provenance policy 与人工审批，再要求 transaction owner stage 这些 code。

## 已考虑的替代方案

**在一个锁下修改 live Profile。** reader 仍可观察部分 multi-file graph，而 rollback 必须重建已经被覆盖的 state。

**在 `dsh plugin` 中保留包管理器 mutation。** 这会绕过 Extension Center 共用的 SQLite owner、确切 artifact admission、tree fence、journal、validation 与 recovery semantics。

**只保存 pointer 或 package manifest。** boot 需要完整 package tree 和与真实已安装文件一致的 lockfile；在 restart 时重建任一内容都会重新引入部分 mutation。

**把 commit 当作成功并立即设为 last-good。** commit 只证明 durable selection，不能证明 Loader activation 成功。单独 acknowledgement 会在 restart 失败时保留已知 recovery target。

**让临时 Loader root 决定解析 base。** 相对 plugin name 与 configuration path 会改从每次调用的临时目录解析。私有 root 配合 effective Profile 的显式 base，既让 runtime file 位于 managed content 之外，也不改变 Profile 语义。

## 后果

P0 archive restriction 有意比 npm 更窄。需要普通 dependency、安装 lifecycle script 或 executable shim 的 package 会明确失败。多 package graph change 与自动 retention pruning 属于未来工作。

active pointer 只在 validation 后改变，运行中进程只在 restart 后改变。失败或被杀死的 publication 有确定性 recovery；失败 Loader boot 不会覆盖 last-good。即使 transaction store 尚不存在，snapshot 与 list 仍保持零写。

restore-journal SIGKILL 用例会在重启后先查询公开 receipt，再重放相同 restore id，并证明 Profile revision 保持不变。

focused acceptance 覆盖跨冷 provider start 的确切 install/update/uninstall/restore、跨更新 fence 的 completed install/update/configure/uninstall replay 且不再次 validation 或增加 revision、在全新隔离 Harness home 的标准 Web template 中首次安装 packed 普通 package 与 `constructor` package、从确切 installation anchor 解析的 custom direct-bundle conflict 在 reservation 前被拒绝、调用方 request 脱离、并发同 key staging、不同输入 key conflict、active generation correlation、pnpm lock update、对称的 bundle-to-package 与 package-to-bundle update、自有 key installed-owner 检查、patch content 与 whole-tree conflict、外部编辑、被拒绝 archive/validator、有序 validator dispose 与 removal failure、首次 baseline recovery、带相对 entry 的 active generation Loader boot、managed-patch HMR exclusion、跨进程 stale commit、stage reservation、generation persistence、commit state fsync 与 restore journal 持久化后的真实 `SIGKILL` 窗口，以及真实 child Loader 在不继承 credential、credential-file、endpoint、proxy 或 SSH-agent 环境 authority 时仍成功激活。
