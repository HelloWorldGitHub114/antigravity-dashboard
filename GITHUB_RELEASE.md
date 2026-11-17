# Antigrative Dashboard v0.12.2

> [!NOTE]
> **Independent Continuation Fork (`v0.12.2`):**
> This release is published by the independent continuation fork [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard), maintained from `v0.8.7` of the MIT-licensed upstream project `antigrative-dashboard` (`Copyright (c) 2026 AG Pulse contributors`). Releases from `v0.8.8` onward are independently developed and maintained without affiliation with or endorsement from the original upstream authors.

> [!IMPORTANT]
> **Prebuilt Rust Native Binaries Included (`pulse-accel` & `ag-pulse-statusline`):**
> Both `antigrative-dashboard-0.12.2.zip` and `antigrative-dashboard-ide-0.12.2.vsix` bundle the prebuilt `pulse-accel.<platform>-<arch>.node` addons for all 5 platforms (`win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`), and the ZIP also ships the standalone `ag-pulse-statusline` CLI binaries under `cli/bin/`. You can disable native acceleration at runtime with `PULSE_DISABLE_NATIVE_ACCEL=1` (falling back seamlessly to pure TypeScript) or roll back to **`v0.11.0`** if needed.

## What's New in v0.12.2

- **"By Project" Token Usage & Conversation Drilldown (`src/telemetry/ledger/project-stats.ts`, `src/ui/usage-modal/{picker,project-detail}.ts`, `native/pulse-accel`):**
  - Added a `By Project` dimension alongside `By Model` and `By User` in the Token Usage modal, powered by native `readSqliteConversationSummariesJson` (`conversation_summaries.db`) and `getProjectUsage` / `getProjectDetail` across desktop, preview, IPC, and standalone IDE hosts.
  - Groups workspace URIs and worktree conversations under their root project while keeping Antigravity CLI, general conversations, and remote sessions cleanly categorized.
  - Replaced native `<select>` controls with a themed accessible popover listbox (`createPopoverListbox`) and added a per-project conversation breakdown featuring horizontal session bars, expandable subagent rows, and an interactive SVG donut chart.
- **Independent `Aa` Font Size Scaling (`src/ui/shared/font-popover.ts`, `src/contracts/preferences.ts`):**
  - Added an `Aa` font-scale popover allowing independent `80%`–`150%` scaling (5% steppers or direct input) for the Usage modal (`usageFontScale`), Sidebar (`sidebarFontScale`), and Bottom inline card (`inlineFontScale`), synced and persisted across restarts in `preferences.json`.

## Downloads

- **App / CLI:** `antigrative-dashboard-0.12.2.zip` and `antigrative-dashboard-0.12.2.zip.sha256`
- **Standalone Antigravity IDE:** `antigrative-dashboard-ide-0.12.2.vsix` and `antigrative-dashboard-ide-0.12.2.vsix.sha256`

> [!IMPORTANT]
> **Standalone IDE Extension ID:** The IDE extension identifier is `shzbz.antigrative-dashboard-ide` (global storage path: `User/globalStorage/shzbz.antigrative-dashboard-ide/`). If migrating from upstream `you-should-know-me.antigrative-dashboard-ide`, quit the IDE, copy `history-v1/`, `usage-v1/`, and `preferences.json` to the new storage folder, and uninstall the old extension before relaunching. See [ide/README.md](ide/README.md).

Details: [full changelog](CHANGELOG.md) · [English README](README.md) · [IDE guide](ide/README.md) · [usage accounting](docs/USAGE.md) · [update verification](docs/UPDATES.md).

---

## 中文发布说明（v0.12.2）

> [!NOTE]
> **独立接续维护分支发布（`v0.12.2`）：**
> 本版本由基于原 MIT 协议开源项目 `antigrative-dashboard`（`Copyright (c) 2026 AG Pulse contributors`）`v0.8.7` 独立接续维护的仓库 [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard) 发布。自 `v0.8.8` 起的所有更新均由当前仓库独立开发与维护，与原上游作者不存在从属或背书关系。

> [!IMPORTANT]
> **已内置 5 平台预编译 Rust 原生引擎：**
> `antigrative-dashboard-0.12.2.zip` 与 `antigrative-dashboard-ide-0.12.2.vsix` 均已直接内置全部 5 个平台（`win32-x64`、`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`）的预编译 `pulse-accel.<platform>-<arch>.node` 原生模块，ZIP 内 `cli/bin/` 同步附带独立原生状态栏可执行文件 `ag-pulse-statusline.*`。如需临时关闭原生加速，仍可通过环境变量 `PULSE_DISABLE_NATIVE_ACCEL=1` 无缝切回纯 TypeScript 模式。

### v0.12.2 新增与改进

- **「按项目统计」维度与会话明细下钻：**
  - 在 Token 用量弹窗新增与「按模型统计」「按用户统计」并列的 **「按项目统计」** 维度，由 Rust 原生 `readSqliteConversationSummariesJson` 读取 `conversation_summaries.db` 摘要，并打通桌面侧边栏、预览服务、IPC 与独立 IDE 的 `getProjectUsage` / `getProjectDetail` 接口。
  - 自动归并工作区路径与 worktree 会话至对应项目，同时独立归类 Antigravity CLI、通用对话与远程会话。
  - 使用自绘无障碍弹出列表框（`createPopoverListbox`）替代原生下拉框，并新增「项目会话明细」视图：支持主会话横向占比条、子代理展开明细以及联动高亮的 SVG 环形分布图。
- **三端独立 `Aa` 字体缩放设置：**
  - 在统计页、侧边栏与底部状态卡片同步提供 `Aa` 字体大小调节面板，支持 **统计页**（`usageFontScale`）、**侧边栏**（`sidebarFontScale`）与 **底部状态卡片**（`inlineFontScale`）三项独立调节（`80%`–`150%`，5% 步进或直接输入），并通过 `preferences.json` 跨重启持久化同步。

### 下载产物与迁移说明

- **App / CLI：** `antigrative-dashboard-0.12.2.zip`、`antigrative-dashboard-0.12.2.zip.sha256`
- **独立 Antigravity IDE：** `antigrative-dashboard-ide-0.12.2.vsix`、`antigrative-dashboard-ide-0.12.2.vsix.sha256`

更多说明请参阅 [CHANGELOG.md](CHANGELOG.md)、[中文 README](README.zh-CN.md) 与 [ide/README.md](ide/README.md)。
