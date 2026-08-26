# Task continuation

English | [中文](README.zh.md)

Packages that retain one exact original-task continuation across Host restarts and admit it only after an extension-owned verifier confirms the bound capability evidence.

| Package | Role |
|---|---|
| [`task-continuation/`](task-continuation/README.md) | Service Definition, branded identities, durable claim vocabulary, verifier registry, and model-visible resume marker |
| [`task-continuation-driver/`](task-continuation-driver/README.md) | SQLite provider, restart recovery, verifier gating, exact-once Agent admission, cancellation, and supersession |
