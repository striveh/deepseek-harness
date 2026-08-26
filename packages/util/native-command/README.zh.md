# dsh-native-command

[English](README.md) | 中文

宿主原生 primitive 库。`runNativeCommand(command, args, signal)` 通过 `execFile` 直接 spawn 可执行文件，不拼接 shell 字符串；它捕获 UTF-8 stdout/stderr，把 abort 传播为子进程终止，并在 Windows 上隐藏瞬时控制台窗口。失败时，错误附带退出 `code` 与两路已捕获输出，调用方无需重跑即可区分工具缺失、取消和命令失败。

process-incarnation API 会区分一个 OS 进程生命周期与后来复用的相同 PID。Linux 读取 kernel boot id 与 `/proc/<pid>/stat` start ticks；Darwin 通过 libproc 读取微秒级创建时间；Windows 通过 `GetProcessTimes` 读取 100 纳秒级创建时间。Koffi 依赖直接提供 Darwin 与 Windows ABI 调用，不会 spawn helper command。每个已取得的 Windows process handle 也必须成功关闭：`CloseHandle` 失败会拒绝 query，query failure 与 cleanup failure 同时发生时会按 query failure 在前的顺序形成 aggregate。PID 不存在时返回 `null`；native data 错误、live PID 的创建时间不可读或 OS 不受支持时都会明确失败。

[`directory-picker-native`](../../host/directory-picker-native/README.zh.md) 与 [`dsh-host-apiproxy`](../../host/apiproxy/README.zh.md) 使用 command execution。app boot 与 Profile transaction coordination 使用精确进程归属，避免 stale owner 跨 PID 复用继续生效。`NativeCommandRunner` 与 `ProcessIncarnationRuntime` 是这些路径可注入的宿主边界。

它是**库，不是服务或插件**：没有 `ctx`、不注册任何东西、不持有状态、不发事件。

## 接口面

```ts
import {
  currentProcessIncarnation,
  isProcessIncarnation,
  readProcessIncarnation,
  runNativeCommand,
  type NativeCommandRunner,
  type ProcessIncarnation,
  type ProcessIncarnationRuntime,
} from '@deepseek-ai/dsh-native-command'
```

## 模型体验

无；这是宿主侧子进程与 native process inspection，这里没有任何东西进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **不做输出限量**——两路流在内存中无界缓冲；当前每个调用方只运行输出为一个路径或一行错误的小型原生工具。把它指向输出量可观的命令之前，先接入 `dsh-output-retention` 限量。
- **process inspection 支持平台**——精确 process incarnation 只在 Linux、macOS 与 Windows 上实现。其他平台会拒绝 ownership inspection，不会退化为只按 PID 判断存活。
