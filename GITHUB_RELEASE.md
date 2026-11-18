# Antigrative Dashboard v0.12.3

> [!NOTE]
> **Independent Continuation Fork (`v0.12.3`):**
> This release is published by the independent continuation fork [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard), maintained from `v0.8.7` of the MIT-licensed upstream project `antigrative-dashboard` (`Copyright (c) 2026 AG Pulse contributors`). Releases from `v0.8.8` onward are independently developed and maintained without affiliation with or endorsement from the original upstream authors.

> [!IMPORTANT]
> **Prebuilt Rust Native Binaries Included (`pulse-accel` & `ag-pulse-statusline`):**
> Both `antigrative-dashboard-0.12.3.zip` and `antigrative-dashboard-ide-0.12.3.vsix` bundle the prebuilt `pulse-accel.<platform>-<arch>.node` addons for all 5 platforms (`win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`), and the ZIP also ships the standalone `ag-pulse-statusline` CLI binaries under `cli/bin/`. You can disable native acceleration at runtime with `PULSE_DISABLE_NATIVE_ACCEL=1` (falling back seamlessly to pure TypeScript) or roll back to **`v0.11.0`** if needed.

## What's New in v0.12.3

- **Refactored Sidebar & Header Quota Rings (`sidecars/panel/index.html`, `src/ui/panel-webview/*`):**
  - Replaced the header quota dropdown and duplicate `#context-card` quota rows with compact concentric SVG quota rings (`#quota-rings-pill`) and an interactive `#quota-popover` (`5h` outer ring + `weekly` inner ring, threshold colors, `Weekly only` tag, and live 1s countdowns).
  - Upgraded `.status-strip` with two-column Speed/Cache chips, an inline Context capacity/progress bar (`80%`/`90%` warning/danger coloring), click-to-collapse `#card-stage` tabs with WAAPI height morphing, anti-jump bottom pinning (`data-pin-bottom`), brand logo (`/logo.svg`), and `@container sidebar` width-adaptive breakpoints.
- **Usage Modal UI Polish (`src/ui/usage-modal/*`):**
  - Aligned `#account-switcher` cleanly on the right of `.tabs-bar`, removed redundant account scope text from `#subtitle` in multi-account setups, replaced `#detail-title` with a stacked `.detail-heading-group` picker/summary header, and refined the project dimension label (`Project Stats` / `项目统计`).
- **Faster Project Statistics & Resilient Metadata (`native/pulse-accel/src/project_ledger.rs`, `src/telemetry/ledger/{project-stats,timezone,storage,backfill}.ts`):**
  - Added Rust N-API `readLedgerProjectSummariesJson` with streaming `DeserializeSeed` parsing, process-local `PROJECT_MEM_CACHE`, and binary sidecar cache `project-ledger-v1.bin` (`AGPPRJ01`), plus `LEDGER_MEM_CACHE` in `ledger_index.rs` and precomputed/binary-searched `dateTimeParts` in `timezone.ts`.
  - Added `project-meta-v1.json` persistence (`persistProjectMetaFromRawSummaries`), `LedgerStorage.projectDirtyRelPaths`, stat-validated `.db`/`.db-wal` summary metadata caching, and Level-2 candidate file filtering so project drilldowns avoid reading unrelated conversations.
- **Fixed Multi-Account Isolation in Project Statistics (`src/telemetry/ledger/project-stats.ts`, `src/ui/usage-modal/{index,stacked-bar}.ts`):**
  - Forwarded the active `viewScope` from `#account-switcher` through `getProjectUsage` / `getProjectDetail` and updated `#project-scope-note` dynamically.
  - Enforced `ownership-v1.json` ownership, primary-account tie-breaking, and record-level deduplication (`buildScopeFilePlan`, `loadSharedFileSummariesJs`) so single-account and `All Accounts (Aggregated)` project totals match `UsageLedger.summary()` accurately.

## Downloads

- **App / CLI:** `antigrative-dashboard-0.12.3.zip` and `antigrative-dashboard-0.12.3.zip.sha256`
- **Standalone Antigravity IDE:** `antigrative-dashboard-ide-0.12.3.vsix` and `antigrative-dashboard-ide-0.12.3.vsix.sha256`

> [!IMPORTANT]
> **Standalone IDE Extension ID:** The IDE extension identifier is `shzbz.antigrative-dashboard-ide` (global storage path: `User/globalStorage/shzbz.antigrative-dashboard-ide/`). If migrating from upstream `you-should-know-me.antigrative-dashboard-ide`, quit the IDE, copy `history-v1/`, `usage-v1/`, and `preferences.json` to the new storage folder, and uninstall the old extension before relaunching. See [ide/README.md](ide/README.md).

Details: [full changelog](CHANGELOG.md) · [English README](README.md) · [IDE guide](ide/README.md) · [usage accounting](docs/USAGE.md) · [update verification](docs/UPDATES.md).

---

## 中文发布说明（v0.12.3）

> [!NOTE]
> **独立接续维护分支发布（`v0.12.3`）：**
> 本版本由基于原 MIT 协议开源项目 `antigrative-dashboard`（`Copyright (c) 2026 AG Pulse contributors`）`v0.8.7` 独立接续维护的仓库 [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard) 发布。自 `v0.8.8` 起的所有更新均由当前仓库独立开发与维护，与原上游作者不存在从属或背书关系。

> [!IMPORTANT]
> **已内置 5 平台预编译 Rust 原生引擎：**
> `antigrative-dashboard-0.12.3.zip` 与 `antigrative-dashboard-ide-0.12.3.vsix` 均已直接内置全部 5 个平台（`win32-x64`、`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`）的预编译 `pulse-accel.<platform>-<arch>.node` 原生模块，ZIP 内 `cli/bin/` 同步附带独立原生状态栏可执行文件 `ag-pulse-statusline.*`。如需临时关闭原生加速，仍可通过环境变量 `PULSE_DISABLE_NATIVE_ACCEL=1` 无缝切回纯 TypeScript 模式。

### v0.12.3 新增与改进

- **侧边栏重构与顶部多模型额度圆环：**
  - 移除旧版顶部 `<select>` 额度下拉框及 `#context-card` 中重复的额度列表，改为标题栏同心圆环胶囊（`#quota-rings-pill`，内环周额度、外环 5 小时额度及阈值变色）与悬停/点击弹出面板（`#quota-popover`，支持「仅周额度」标签与每秒实时倒计时）。
  - 顶部状态条重构为双列 Speed / Cache 指标卡与内嵌进度条的 Context 指标卡（80% 警告 / 90% 危险阈值），支持点击激活标签折叠详情卡（WAAPI 高度平滑过渡）、防跳动底部吸底布局（`data-pin-bottom`）、品牌图标（`/logo.svg`）以及基于 `@container sidebar` 的容器宽度响应式断点。
- **Token 用量弹窗 UI 细节优化：**
  - 将账号切换器（`#account-switcher`）移至标签栏（`.tabs-bar`）右侧并精简多账号副标题冗余文案；将详情页标题升级为堆叠式控件与摘要栏（`.detail-heading-group`），并统一维度文案为「项目统计 / Project Stats」。
- **大幅提升项目统计速度与持久化元数据：**
  - 新增 Rust N-API 接口 `readLedgerProjectSummariesJson` 与二进制增量缓存 `project-ledger-v1.bin`（`AGPPRJ01`）、进程内缓存 `PROJECT_MEM_CACHE` / `LEDGER_MEM_CACHE`，结合流式 `DeserializeSeed` 与并行刷新显著降低项目统计延迟与 V8 堆内存开销。
  - 新增 `project-meta-v1.json` 持久化项目元数据、独立脏路径追踪 `projectDirtyRelPaths`、`.db`/`.db-wal` 文件戳校验缓存、二级详情候选文件精准过滤以及 `timezone.ts` 查表/二分高速日期转换。
- **修复项目统计无法按账号区分的 Bug：**
  - 打通用量弹窗 `#account-switcher` 选中 `viewScope` 至 `getProjectUsage` / `getProjectDetail` 查询与缓存键，并动态更新 `#project-scope-note` 提示。
  - 后端 `buildScopeFilePlan` 与 `loadSharedFileSummariesJs` 严格对齐 `UsageLedger.summary()` 的 `ownership-v1.json` 归属、主账号优先决策与请求级去重规则，彻底修复单账号视图与「全部账号 (汇总)」下的跨账号串账与重复统计问题。

### 下载产物与迁移说明

- **App / CLI：** `antigrative-dashboard-0.12.3.zip`、`antigrative-dashboard-0.12.3.zip.sha256`
- **独立 Antigravity IDE：** `antigrative-dashboard-ide-0.12.3.vsix`、`antigrative-dashboard-ide-0.12.3.vsix.sha256`

更多说明请参阅 [CHANGELOG.md](CHANGELOG.md)、[中文 README](README.zh-CN.md) 与 [ide/README.md](ide/README.md)。
