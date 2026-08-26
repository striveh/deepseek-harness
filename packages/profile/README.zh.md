# profile/ — Profile 生命周期能力族

[English](README.md) | 中文

该能力族负责不可变 Profile generation，以及发布或恢复 generation 的原子指针转换。

| 包 | 角色 | ctx key |
|---|---|---|
| [`profile-transactions/`](profile-transactions/README.zh.md) | 定义快照、隔离暂存、提交、中止和 last-good 恢复 | `ctx.profileTransactions` |
| [`profile-transactions-local/`](profile-transactions-local/README.zh.md) | 持久化本地 generation 和带 journal 的指针转换 | 注册到 `ctx.profileTransactions` |

子系统参考见 [Profile generation 事务](../../docs/subsystems/profile-transactions.zh.md)。
