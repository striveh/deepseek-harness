# profile/ — Profile lifecycle capability family

English | [中文](README.zh.md)

This family owns immutable Profile generations and the atomic pointer transitions that publish or restore them.

| Package | Role | ctx key |
|---|---|---|
| [`profile-transactions/`](profile-transactions/README.md) | Defines snapshots, isolated staging, commit, abort, and last-good restore | `ctx.profileTransactions` |
| [`profile-transactions-local/`](profile-transactions-local/README.md) | Persists local generations and journaled pointer transitions | registers on `ctx.profileTransactions` |

The subsystem reference is [Profile generation transactions](../../docs/subsystems/profile-transactions.md).
