# Antigrative Dashboard v0.11.0-alpha.3

> [!NOTE]
> **Independent Continuation Fork (`v0.11.0-alpha.3`):**
> Released from the independent continuation fork [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard), maintained from `v0.8.7` of the MIT-licensed upstream project `antigrative-dashboard` (`Copyright (c) 2026 AG Pulse contributors`). Releases from `v0.8.8` onward are independently developed and maintained without affiliation with or endorsement from the original upstream authors.

## What's New in v0.10.2 – v0.11.0-alpha.3

- **TypeScript + `esbuild` Backend Modularization (`0.11.0-alpha.2` – `0.11.0-alpha.3`):** Migrated the backend telemetry core into 67 focused TypeScript modules under `src/telemetry/` alongside `src/contracts/*`, `src/shared/*`, and `src/platform/*` (`tsconfig.json`, `tools/build.mjs`), compiling zero-dependency `.mjs` runtime targets (`sidecars/panel/*.mjs`, `compat/{platform,preferences,sidecar-owner}.mjs`) with zero runtime dependencies. Unified request identity extraction (`extractRequestIdentity()`), eliminated redundant internal validation boilerplate, and kept VSIX / sidecar / CLI packaging unchanged.
- **I/O & Memory Hot-Path Speedups (`0.11.0-alpha.1`):** Added an incremental `UsageLedger` file-metadata index (`fileIndex` + `stat`-cached `accountsMeta`/`ownership`) and split read/write queues (`writeQueue`), moved `saveBackfillState()` out of the per-conversation inner loop to once per 3s slice, upgraded `TranscriptReader` to continuous `setImmediate`-driven multi-slice EOF streaming with round-robin fairness, stream-projected Connect+JSON `StreamAgentStateUpdates` frames in 64 KiB chunks, and replaced hot-path `JSON.stringify` deep comparisons in `MetricsStore.session()` with structural equality helpers (`sameTranscriptStats`, `sameTaskUsage`, `sameStringList`).
- **Stability, Dual-Instance Symmetry & Account Isolation (`0.10.2`):** Externalized local account mappings via `loadKnownAccounts()` reading gitignored `.data/usage-accounts.local.json`, fixed 5 missing transitive modules in IDE VSIX packaging (`ide/package.py`) with unpacked smoke tests, replaced strong `entry.rawRef`/`ancestorRaws` references in `MetricsStore` with `WeakRef` (`entry.rawWeak`), parameterized `manage.py` (`install`, `enable`, `disable`, `status`, `uninstall`) with `--instance (all|pro|vertex)`, and aligned `ag-pulse:preferences` IPC keys (`language`, `languageGuideDismissed`, `usageGuideDismissed`, `modelTimelineEnabled`).

## Downloads

- **App / CLI:** `antigrative-dashboard-0.11.0-alpha.3.zip` and `antigrative-dashboard-0.11.0-alpha.3.zip.sha256`
- **Standalone Antigravity IDE:** `antigrative-dashboard-ide-0.11.0-alpha.3.vsix` and `antigrative-dashboard-ide-0.11.0-alpha.3.vsix.sha256`

> [!IMPORTANT]
> **Standalone IDE Extension ID Note:** The IDE extension identifier is `shzbz.antigrative-dashboard-ide` (global storage path: `User/globalStorage/shzbz.antigrative-dashboard-ide/`). If migrating from upstream `you-should-know-me.antigrative-dashboard-ide`, quit the IDE, copy `history-v1/`, `usage-v1/`, and `preferences.json` to the new storage folder, and uninstall the old extension before relaunching. See [ide/README.md](ide/README.md).

Python 3.10+ is required for App installation/updates; CLI requires Node.js 20+.

Details: [full changelog](CHANGELOG.md) · [English README](README.md) · [IDE guide](ide/README.md) · [usage accounting](docs/USAGE.md) · [update verification](docs/UPDATES.md).

---

## 中文发布说明（v0.11.0-alpha.3）

> [!NOTE]
> **独立接续维护分支版本（`v0.11.0-alpha.3`）：**
> 本版本由独立接续维护仓库 [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard) 发布，基于原 MIT 协议开源项目 `antigrative-dashboard`（`Copyright (c) 2026 AG Pulse contributors`）的 `v0.8.7` 版本独立演进。自 `v0.8.8` 起的所有更新均与原上游作者不存在从属或背书关系。

### v0.10.2 – v0.11.0-alpha.3 重点更新

- **TypeScript + `esbuild` 后端模块化与零运行时依赖构建（`0.11.0-alpha.2` – `0.11.0-alpha.3`）：** 将后端遥测核心迁移并拆分为 `src/telemetry/` 下 67 个单职责 TypeScript 模块，结合 `src/contracts/*`、`src/shared/*` 与 `src/platform/*` 唯一契约与公共库（`tsconfig.json`、`tools/build.mjs`），原位输出 25 个零依赖 `.mjs` 运行时产物（保持 sidecar、CLI 与 IDE VSIX 打包兼容）；新增统一 `extractRequestIdentity()` 消除 5 处重复请求 ID 提取与内部冗余校验。
- **I/O 与内存热路径性能修复（`0.11.0-alpha.1`）：** 为 `UsageLedger` 引入文件元数据增量索引（`fileIndex` + 基于 `stat` 的 `accountsMeta`/`ownership` 缓存）并拆分读写调度队列（`writeQueue`），消除读写队头阻塞；将 `DesktopUsage.runSync()` 的 `saveBackfillState()` 迁出内层循环改为每 3 秒时间片批量刷盘；`TranscriptReader` 支持单次 `request()` 通过 `setImmediate` 连续分片异步推进至 EOF；远程 `StreamAgentStateUpdates` 改用 64 KiB 分块流式投影解码；移除 `MetricsStore.session()` 热路径的 `JSON.stringify` 深比较，改用轻量结构等价校验。
- **稳定性、双实例对称管理与账号外置（`0.10.2`）：** 通过 `loadKnownAccounts()` 读取被 `.gitignore` 忽略的 `.data/usage-accounts.local.json`，源码中彻底移除个人账号硬编码；补齐 `ide/package.py` 打包白名单遗漏的 5 个传递依赖模块并补充 VSIX 解包导入冒烟测试；将 `MetricsStore` 中的 `entry.rawRef`/`ancestorRaws` 强引用改造为 `WeakRef`（`entry.rawWeak`）避免回收会话钉死堆内存；为 `manage.py` 的 `install`/`enable`/`disable`/`status`/`uninstall` 统一增加 `--instance (all|pro|vertex)` 对称管理，并补齐 `ag-pulse:preferences` IPC 白名单字段。

### 下载产物与迁移说明

- **App / CLI：** `antigrative-dashboard-0.11.0-alpha.3.zip`、`antigrative-dashboard-0.11.0-alpha.3.zip.sha256`
- **独立 Antigravity IDE：** `antigrative-dashboard-ide-0.11.0-alpha.3.vsix`、`antigrative-dashboard-ide-0.11.0-alpha.3.vsix.sha256`

> [!IMPORTANT]
> **IDE 扩展 ID 说明：** 独立 IDE 扩展 ID 为 `shzbz.antigrative-dashboard-ide`（数据目录位于 `User/globalStorage/shzbz.antigrative-dashboard-ide/`）。若从原上游 `you-should-know-me.antigrative-dashboard-ide` 迁移，请先完整退出 IDE，将旧目录下的 `history-v1/`、`usage-v1/` 与 `preferences.json` 复制到新目录并卸载旧版扩展。详情见 [ide/README.md](ide/README.md)。

App 安装/更新需 Python 3.10+；CLI 需 Node.js 20+。更多说明请参阅 [CHANGELOG.md](CHANGELOG.md)、[中文 README](README.zh-CN.md) 与 [ide/README.md](ide/README.md)。
