# Antigrative Dashboard v0.12.5

> [!NOTE]
> **Independent Continuation Fork (`v0.12.5`):**
> This release is published by the independent continuation fork [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard), maintained from `v0.8.7` of the MIT-licensed open-source project `antigrative-dashboard` (`Copyright (c) 2026 AG Pulse contributors`). Releases from `v0.8.8` onward are independently developed and maintained without affiliation with or endorsement from the original upstream authors.

> [!IMPORTANT]
> **Prebuilt Rust Native Binaries Included (`pulse-accel` & `ag-pulse-statusline`):**
> Both `antigrative-dashboard-0.12.5.zip` and `antigrative-dashboard-ide-0.12.5.vsix` bundle the prebuilt `pulse-accel.<platform>-<arch>.node` addons for all 5 platforms (`win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`), and the ZIP also ships the standalone `ag-pulse-statusline` CLI binaries under `cli/bin/`. You can disable native acceleration at runtime with `PULSE_DISABLE_NATIVE_ACCEL=1` (falling back seamlessly to pure TypeScript) or roll back to **`v0.11.0`** if needed.

## What's New in v0.12.5

- **Full Antigravity `2.34+` Cloud Quota & Automatic Account Detection (`src/telemetry/client/{server-discovery,rpc-client,snapshot-stream}.ts`, `src/telemetry/main.ts`):**
  - Antigravity `2.34.0` removed `--csrf_token` from `language_server` process command-line arguments. Added safe environment-variable credential discovery (`ANTIGRAVITY_LS_ADDRESS` + `ANTIGRAVITY_CSRF_TOKEN`) with strict loopback-only host validation (`127.0.0.1`, `localhost`, `[::1]`), live standalone PID/port ownership checks, Pro-vs-`.antigravity-vertex` dual-instance isolation (`env: {}` for cross-instance Vertex clients), and automatic 401/403 fallback to local SQLite direct-read mode.
- **Local SQLite Direct-Read Fallback & Recording Account Management (`src/telemetry/reader/local-summaries.ts`, `src/telemetry/store/metrics-store.ts`, `src/telemetry/ledger/accounts.ts`, `src/ui/panel-webview/settings-popover.ts`):**
  - When RPC credentials are unavailable (offline/cross-instance/standalone), live TPS, token/cache metrics, context window, and `conversation_summaries.db` sessions continue working directly from local SQLite.
  - Added a local recording account switcher in sidebar settings (aligned with `sha256(email)`), atomic conversation ownership reassignment in Project Stats, and `MODEL_PLACEHOLDER_M532` → `Gemini 4 Neon (High)` mapping.
- **Fixed Native `/swarm` Subagent Naming (`src/telemetry/delegation/{hints,delegated-collector,delegation,task-validation}.ts`, `src/telemetry/reader/local-summaries.ts`):**
  - Merged `trajectoryMetadata` across summary and worker `.db` payloads and forwarded `agent_name` / `subagentSpec` / `nestingDepth` so Swarm workers show their real roles (e.g. `Swarm Worker (<name>)`) instead of placeholder `"Unnamed session"` / `"未命名会话"`, and automatically self-heal stale `history-v1` snapshots.
- **Sidebar Motion, 5h Depleted Ring & Live Quota Refresh (`src/ui/panel-webview/*`, `src/telemetry/store/{metrics-store,session-runner}.ts`):**
  - Added a dashed red outer ring when the 5-hour quota bucket is depleted, improved active/settled quota refresh scheduling, and polished sidebar WAAPI motion and responsive layout.

## Downloads

- **App / CLI:** `antigrative-dashboard-0.12.5.zip` and `antigrative-dashboard-0.12.5.zip.sha256`
- **Standalone Antigravity IDE:** `antigrative-dashboard-ide-0.12.5.vsix` and `antigrative-dashboard-ide-0.12.5.vsix.sha256`

> [!IMPORTANT]
> **Standalone IDE Extension ID:** The IDE extension identifier is `shzbz.antigrative-dashboard-ide` (global storage path: `User/globalStorage/shzbz.antigrative-dashboard-ide/`). If migrating from upstream `you-should-know-me.antigrative-dashboard-ide`, quit the IDE, copy `history-v1/`, `usage-v1/`, and `preferences.json` to the new storage folder, and uninstall the old extension before relaunching. See [ide/README.md](ide/README.md).

Details: [full changelog](CHANGELOG.md) · [English README](README.md) · [IDE guide](ide/README.md) · [usage accounting](docs/USAGE.md) · [update verification](docs/UPDATES.md).

---

## 中文发布说明（v0.12.5）

> [!NOTE]
> **独立接续维护分支发布（`v0.12.5`）：**
> 本版本由基于原 MIT 协议开源项目 `antigrative-dashboard`（`Copyright (c) 2026 AG Pulse contributors`）`v0.8.7` 独立接续维护的仓库 [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard) 发布。自 `v0.8.8` 起的所有更新均由当前仓库独立开发与维护，与原上游作者不存在从属或背书关系。

> [!IMPORTANT]
> **已内置 5 平台预编译 Rust 原生引擎：**
> `antigrative-dashboard-0.12.5.zip` 与 `antigrative-dashboard-ide-0.12.5.vsix` 均已直接内置全部 5 个平台（`win32-x64`、`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`）的预编译 `pulse-accel.<platform>-<arch>.node` 原生模块，ZIP 内 `cli/bin/` 同步附带独立原生状态栏可执行文件 `ag-pulse-statusline.*`。如需临时关闭原生加速，仍可通过环境变量 `PULSE_DISABLE_NATIVE_ACCEL=1` 无缝切回纯 TypeScript 模式。

### v0.12.5 新增与改进

- **全面适配 Antigravity `2.34+`，恢复云端额度与账号邮箱自动识别：**
  - Antigravity `2.34.0` 移除了 `language_server` 启动命令行中的 `--csrf_token`。新版通过宿主注入的 `ANTIGRAVITY_LS_ADDRESS` / `ANTIGRAVITY_CSRF_TOKEN` 环境变量凭据安全恢复本地 Connect-RPC 连接，强制校验环回地址与当前存活 PID/端口归属，隔离 Pro 与 `.antigravity-vertex` 双实例凭据，并在 401/403 时自动降级至本地 SQLite 直读模式。
- **本地 SQLite 直读兜底模式与手动记录账号管理：**
  - 无本地 RPC 凭据时（离线、独立预览或跨实例监控）自动直读本地 `.db` 与 `conversation_summaries.db` 保持速率/缓存/上下文实时采集；侧边栏设置新增记录账号切换（与邮箱 `sha256` 100% 对齐）与项目会话归属迁移，并补充 `Gemini 4 Neon (High)`（`MODEL_PLACEHOLDER_M532`）模型名称映射。
- **修复原生 `/swarm` 子代理显示「未命名会话」问题：**
  - 合并 summary 与子代理 `.db` 的 `trajectoryMetadata` 并透传 `agent_name` / `subagentSpec` / `nestingDepth`，过滤占位标题，使侧边栏子代理列表与时间线准确显示 `Swarm Worker (<name>)` 并自动自愈旧缓存。
- **侧边栏交互、5h 耗尽态圆环与实时额度刷新优化：**
  - 5 小时额度耗尽时外环切换为红色虚线警示，优化活跃/完成态的额度刷新时机以及侧边栏 WAAPI 折叠动效与响应式布局。

### 下载产物与迁移说明

- **App / CLI：** `antigrative-dashboard-0.12.5.zip`、`antigrative-dashboard-0.12.5.zip.sha256`
- **独立 Antigravity IDE：** `antigrative-dashboard-ide-0.12.5.vsix`、`antigrative-dashboard-ide-0.12.5.vsix.sha256`

更多说明请参阅 [CHANGELOG.md](CHANGELOG.md)、[中文 README](README.zh-CN.md) 与 [ide/README.md](ide/README.md)。
