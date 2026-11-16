# Antigrative Dashboard v0.11.0

> [!NOTE]
> **Independent Continuation Fork (`v0.11.0`):**
> This release is published by the independent continuation fork [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard), maintained from `v0.8.7` of the MIT-licensed upstream project `antigrative-dashboard` (`Copyright (c) 2026 AG Pulse contributors`). Releases from `v0.8.8` onward are independently developed and maintained without affiliation with or endorsement from the original upstream authors.

## What's New in v0.11.0

- **Zero-dependency TypeScript + `esbuild` architecture (`src/`):** Modularized the entire backend telemetry engine (`src/telemetry/`), frontend UI (`src/ui/inline-widget/`, `usage-modal/`, `panel-webview/`, `update-banner/`, `host-adapter/`), IDE adapter (`src/ide/`), shared contracts (`src/contracts/`), and lifecycle tooling (`src/lifecycle/`) into `<300`-line TypeScript modules compiled into 51 self-contained, zero-dependency runtime bundles (`tools/build.mjs`), eliminating runtime `module.exports` string-slicing assembly.
- **Single-source-of-truth manifest & Node-first lifecycle tooling (`src/platform/manifest.ts`, `manage.mjs`, `ide/package.mjs`):** Unified plugin identity, desktop/IDE/CLI file allowlists, and open-source privacy rules with build-time static dependency graph verification (`verifyManifestDependencyGraph()`). Migrated installer, CLI statusLine, PKZIP/VSIX packager, two-phase draft release publisher, and privacy sanitizer to TypeScript while retaining Python compatibility wrappers (`manage.py`, `ide/manage.py`).
- **Backend I/O, streaming & memory optimizations (`v0.10.2` – `v0.11.0`):**
  - Added an in-memory `fileIndex` and split read/write queue scheduling to `UsageLedger`, plus 3s batched `saveBackfillState()` checkpoints to eliminate full-directory rescans and $O(N^2)$ backfill write amplification.
  - Replaced strong trajectory references in `MetricsStore` with `WeakRef` (`rawWeak`) and structural equality checks (`sameTranscriptStats`, `sameTaskUsage`, `sameStringList`) so evicted trajectories are never pinned in V8 heap.
  - Enabled continuous multi-slice `TranscriptReader` progression via `setImmediate` with round-robin fairness, and streaming `64 KiB` chunk decoding of `StreamAgentStateUpdates` Connect+JSON frames.
  - Fixed standalone IDE VSIX transitive module packaging (`delegated-usage.mjs`, `delegation.mjs`, `timeline.mjs`, `timeline-store.mjs`, `task-usage.mjs`) and added parallelized `ScopedBrowser` Playwright UI regression execution (`tools/ui-runner.mjs`).

## Highlights from v0.9.0 – v0.10.1

- **Cloud Remote Agent support:** Full support for `v1/default/jetski_remote_agents_3p/...` sessions with tiered 50-step tail cold loading, sparse background history backfill, incremental `initialStepsPageBounds` slicing, and stuck `RUNNING` revalidation.
- **Hybrid Orchestrator identity & multi-model usage rings:** Maps `Orchestrator (Argon)` / `Gemini Flash` (`speed.planModel`, `speed.activeModel`), renders `Orchestrator (Argon) → Gemini Flash` in the sidebar with planner/worker quota-split notes, and adds TrustedHTML-safe multi-model SVG donut rings (inline `36px` Top-3 ring and sidebar `78px` interactive breakdown with `Total`/`Output`/`Calls` and `Session only`/`Include subagents` switchers).
- **Opt-in model call timeline tree (`modelTimelineEnabled`):** Disabled by default (`modelTimeline: null`, zero `timeline-v1` disk writes). When enabled, captures strictly structural metadata into `Plan` / `Worker` / `Tools·Agents` swimlanes and a collapsible `Turn → Phase → Model Call / Tool Group / Subagent` tree bounded on disk (`<= 400` nodes / `<= 192 KiB`) with one-click `clearTimeline`.
- **Multi-account isolation, 24h trend & variant grouping:** Strict per-account conversation ownership (`ownership-v1.json`), `All Accounts (Aggregated)` viewing, **By Model** / **By User** switching, **Simple** / **Detailed** variant grouping with expandable rows, interactive 24-hour SVG smooth spline trend charts, custom date ranges, single-bar drilldown, manual remote-project ledger CRUD, and hierarchical subagent/Swarm context occupancy rings.

## Downloads

- **App / CLI:** `antigrative-dashboard-0.11.0.zip` and `antigrative-dashboard-0.11.0.zip.sha256`
- **Standalone Antigravity IDE:** `antigrative-dashboard-ide-0.11.0.vsix` and `antigrative-dashboard-ide-0.11.0.vsix.sha256`

> [!IMPORTANT]
> **Standalone IDE Extension ID:** The IDE extension identifier is `shzbz.antigrative-dashboard-ide` (global storage path: `User/globalStorage/shzbz.antigrative-dashboard-ide/`). If migrating from upstream `you-should-know-me.antigrative-dashboard-ide`, quit the IDE, copy `history-v1/`, `usage-v1/`, and `preferences.json` to the new storage folder, and uninstall the old extension before relaunching. See [ide/README.md](ide/README.md).

Details: [full changelog](CHANGELOG.md) · [English README](README.md) · [IDE guide](ide/README.md) · [usage accounting](docs/USAGE.md) · [update verification](docs/UPDATES.md).

---

## 中文发布说明（v0.11.0）

> [!NOTE]
> **独立接续维护分支发布（`v0.11.0`）：**
> 本版本由基于原 MIT 协议开源项目 `antigrative-dashboard`（`Copyright (c) 2026 AG Pulse contributors`）`v0.8.7` 独立接续维护的仓库 [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard) 发布。自 `v0.8.8` 起的所有更新均由当前仓库独立开发与维护，与原上游作者不存在从属或背书关系。

### v0.11.0 重点更新

- **全栈零依赖 TypeScript + `esbuild` 模块化架构（`src/`）：** 将后端遥测引擎（`src/telemetry/`）、前端 UI 组件（`src/ui/inline-widget/`、`usage-modal/`、`panel-webview/`、`update-banner/`、`host-adapter/`）、IDE 扩展（`src/ide/`）、跨层契约（`src/contracts/`）与生命周期工具（`src/lifecycle/`）全面重构为 `<300` 行的 TypeScript 模块，编译产出 51 个零外部依赖运行时文件（`tools/build.mjs`），彻底消除运行时 `module.exports` 字符串切片拼装。
- **清单唯一真源与 Node 优先工具链（`src/platform/manifest.ts`、`manage.mjs`、`ide/package.mjs`）：** 统一插件身份、桌面端/VSIX/CLI 打包白名单与开源脱敏排除规则，新增构建期静态依赖图校验（`verifyManifestDependencyGraph()`）；支持通过 `node manage.mjs`、`./install.ps1` 或 `sh install.sh` 直接执行安装、双实例（Pro + `.antigravity-vertex`）同步、CLI 状态栏配置与 ZIP/VSIX 打包，同时保留 `manage.py` 兼容回退。
- **后端热路径 I/O、流式解析与内存优化（`v0.10.2` – `v0.11.0`）：**
  - `UsageLedger` 新增内存文件元数据索引（`fileIndex`）、读写分离队列与 3 秒批量回填检查点持久化，消除全量目录重扫与 $O(N^2)$ 写放大。
  - `MetricsStore` 改用 `WeakRef`（`rawWeak`）与轻量结构比对替代 `JSON.stringify` 深比较，防止被淘汰的大体积轨迹滞留 V8 堆内存。
  - `TranscriptReader` 支持通过 `setImmediate` 连续异步推进多分片读取直至 EOF；远程会话 `StreamAgentStateUpdates` 接入 `64 KiB` 流式 JSON 投影。
  - 补齐独立 IDE VSIX 传递依赖模块并通过解包冒烟测试，新增 `ScopedBrowser` 并发隔离 Playwright UI 回归测试运行器（`tools/ui-runner.mjs`）。

### 下载产物与迁移说明

- **App / CLI：** `antigrative-dashboard-0.11.0.zip`、`antigrative-dashboard-0.11.0.zip.sha256`
- **独立 Antigravity IDE：** `antigrative-dashboard-ide-0.11.0.vsix`、`antigrative-dashboard-ide-0.11.0.vsix.sha256`

更多说明请参阅 [CHANGELOG.md](CHANGELOG.md)、[中文 README](README.zh-CN.md) 与 [ide/README.md](ide/README.md)。
