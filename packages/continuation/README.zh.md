# 任务续跑

[English](README.md) | 中文

这些包跨 Host 重启保留一个准确的原任务续跑请求，并且只有扩展自有 verifier 确认绑定的能力证据后才允许它进入 Agent。

| 包 | 职责 |
|---|---|
| [`task-continuation/`](task-continuation/README.zh.md) | Service Definition、品牌化标识、持久化 claim 词汇、verifier registry 与模型可见的续跑 marker |
| [`task-continuation-driver/`](task-continuation-driver/README.zh.md) | SQLite provider、重启恢复、verifier 门控、Agent 准确一次准入、取消与替换 |
