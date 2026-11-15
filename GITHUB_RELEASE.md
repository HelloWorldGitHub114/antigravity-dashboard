# Antigrative Dashboard v0.10.1

> [!NOTE]
> **Independent Continuation Fork — First Public Release (`v0.10.1`):**
> This is the first public GitHub Release from the independent continuation fork [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard), maintained from `v0.8.7` of the MIT-licensed upstream project `antigrative-dashboard` (`Copyright (c) 2026 AG Pulse contributors`). Releases from `v0.8.8` onward are independently developed and maintained without affiliation with or endorsement from the original upstream authors.

## What's New in v0.10.1

- **Live sidecar & Teamwork subagent capture fixes:** Switched `MetricsStore` `owns` predicates to synchronous `ownership.running`, added `invokeSubagentSpec` extraction (`conversationId`, `role`, `typeName`), transitive multi-level descendant resolution, preserved `role`/`parentId`/`depth` hints after subagents leave active summaries, root `taskUsage` inheritance on subagent composers without overwriting own stats, and root-preferred default panel polling.
- **Simple / Detailed model grouping in Token usage:** Added `#model-view-controls` (**Simple / Detailed** / **简易 / 详细**, defaulting to simple in the "By Model" view), normalizing variant suffixes and casing via `baseModelName()` while preserving `Orchestrator (Argon)`, with clickable/keyboard-accessible grouped rows (`tr.model-group-row`) to expand inline per-variant breakdown rows (`tr.model-variant-row`).

## Highlights (v0.9.0 – v0.10.1)

Building on the `v0.8.9`–`v0.8.14` foundation (Remote Agent normalization, settled-request TPS binding, adaptive panel sizing, and nested subagent trees), this release delivers:

- **Cloud Remote Agent support:** Full support for `v1/default/jetski_remote_agents_3p/...` sessions with tiered 50-step tail cold loading, sparse background history backfill, incremental `initialStepsPageBounds` slicing, and stuck `RUNNING` revalidation.
- **Hybrid Orchestrator identity & multi-model usage rings:** Maps `MODEL_PLACEHOLDER_M668` / `M669` to `Orchestrator (Argon)` / `Gemini Flash` (`speed.planModel`, `speed.activeModel`), renders `Orchestrator (Argon) → Gemini Flash` in the sidebar with planner/worker quota-split notes, and adds TrustedHTML-safe multi-model SVG donut rings (inline `36px` Top-3 ring and sidebar `78px` interactive breakdown with `Total`/`Output`/`Calls` and `Session only`/`Include subagents` switchers).
- **Opt-in model call timeline tree (`modelTimelineEnabled`):** Disabled by default (`modelTimeline: null`, zero `timeline-v1` disk writes). When enabled, captures strictly structural metadata (no prompts, responses, thinking text, paths, or commands) into `Plan` / `Worker` / `Tools·Agents` swimlanes and a collapsible `Turn → Phase → Model Call / Tool Group / Subagent` tree bounded on disk (`<= 400` nodes / `<= 192 KiB`) with one-click `clearTimeline`.
- **Multi-account isolation & statistics:** Decoupled UI viewing scope (`viewScope` with `All Accounts (Aggregated)` and `accounts-v1.json` email labels), enforced strict per-account conversation ownership across live `DesktopUsage.ingest` and historical `DesktopUsage.runSync` to eliminate cross-account inflation, added **By Model** / **By User** breakdown switching and manual remote-project ledger CRUD, plus `tools/reconcile-usage-ledger.mjs` for duplicate cleanup.
- **24-hour trend chart & usage modal enhancements:** Added an interactive 24-hour SVG smooth bezier trend line chart (period-combined and single-day views), custom date range picker, single-bar drilldown, active vs. historical model legend accordion, and per-subagent context occupancy rings with localized status labels.

## Downloads

- **App / CLI:** `antigrative-dashboard-0.10.1.zip` and `antigrative-dashboard-0.10.1.zip.sha256`
- **Standalone Antigravity IDE:** `antigrative-dashboard-ide-0.10.1.vsix` and `antigrative-dashboard-ide-0.10.1.vsix.sha256`

> [!IMPORTANT]
> **Standalone IDE Extension ID Change:** The IDE extension identifier is now `shzbz.antigrative-dashboard-ide` (global storage path: `User/globalStorage/shzbz.antigrative-dashboard-ide/`). If migrating from upstream `you-should-know-me.antigrative-dashboard-ide`, quit the IDE, copy `history-v1/`, `usage-v1/`, and `preferences.json` to the new storage folder, and uninstall the old extension before relaunching. See [ide/README.md](ide/README.md).

Python 3.10+ is required for App installation/updates; CLI requires Node.js 20+.

Details: [full changelog](CHANGELOG.md) · [English README](README.md) · [IDE guide](ide/README.md) · [usage accounting](docs/USAGE.md) · [update verification](docs/UPDATES.md).

---

## 中文发布说明（v0.10.1）

> [!NOTE]
> **独立接续维护分支首个公开 Release（`v0.10.1`）：**
> 本版本是基于原 MIT 协议开源项目 `antigrative-dashboard`（`Copyright (c) 2026 AG Pulse contributors`）`v0.8.7` 独立接续维护仓库（`ShZbz/antigravity-dashboard`）发布的**首个公开版本**。自 `v0.8.8` 起的所有更新均由当前仓库独立开发与维护，与原上游作者不存在从属或背书关系。

### v0.10.1 重点更新

- **修复实时 sidecar 与 Teamwork 子代理捕获：** 将 `MetricsStore` 的 `owns` 判定改为同步 `ownership.running`，新增 `invokeSubagentSpec`（`conversationId`、`role`、`typeName`）提取与多级子代理传递解析，在子代理离开活跃摘要后保留 `role`/`parentId`/`depth` 提示，支持子代理输入框继承根任务 `taskUsage`（不覆盖自身统计），并在默认侧边栏轮询中优先选择根会话。
- **用量统计「简易 / 详细」模型分组：** 在「按模型统计」视图中新增 `#model-view-controls`（「简易 / 详细」切换，默认简易），通过 `baseModelName()` 归并模型后缀与大小写变体（保留 `Orchestrator (Argon)`），并支持点击或键盘展开分组行（`tr.model-group-row`）查看各变体明细（`tr.model-variant-row`）。

### v0.9.0 – v0.10.1 主要更新汇总

在 `v0.8.9`–`v0.8.14` 底层增强（Remote Agent 适配、已结算请求 TPS 锚定、侧边栏自适应布局、多级子代理树）的基础上，新增以下核心功能：

- **Cloud Remote Agent 支持：** 完整支持 `v1/default/jetski_remote_agents_3p/...` 云端远程会话，提供 50 步尾部冷读窗口、后台稀疏异步补全、基于 `initialStepsPageBounds` 的增量切片以及卡死 `RUNNING` 状态自动重校。
- **Hybrid Orchestrator 身份与多模型占比环：** 支持 `Orchestrator (Argon)` / `Gemini Flash` 身份识别与 `Orchestrator (Argon) → Gemini Flash` 渲染及配额拆分提示；在嵌入式卡片（`36px` Top-3 环形图）与侧边栏（`78px` 交互式环形图 + 明细，支持 `总计 / 输出 / 调用` 与 `仅当前会话 / 包含子代理` 切换）中展示多模型占比。
- **可选结构化调用时间线树（`modelTimelineEnabled`）：** 默认关闭（`modelTimeline: null`，零 `timeline-v1` 磁盘写入）；开启后仅提取结构化元数据（不记录提示词、回复、思考文本、路径或命令参数），展示 `Plan` / `Worker` / `Tools·Agents` 泳道与可折叠 `Turn → Phase → Model Call / Tool Group / Subagent` 调用树（磁盘上限 `<= 400` 节点 / `<= 192 KiB`），支持一键清理 `clearTimeline`。
- **多账号隔离与统计增强：** 解耦连接账号与查看视角（`viewScope` 支持「全部账号汇总」及 `accounts-v1.json` 邮箱展示），在实时入账 `DesktopUsage.ingest` 与历史回溯 `DesktopUsage.runSync` 中强制执行严格按账号会话归属隔离，防止跨账号重复累计；新增「按模型 / 按用户」统计切换、远程项目手动用量录入及去重修复脚本 `tools/reconcile-usage-ledger.mjs`。
- **24 小时趋势图与用量视图升级：** 新增交互式 24 小时 SVG 平滑贝塞尔趋势折线图（支持区间汇总与单日视图）、自定义日期范围、单柱下钻、活跃/历史模型折叠图例，以及子代理上下文占用环与本地化状态标签。

### 下载产物与迁移说明

- **App / CLI：** `antigrative-dashboard-0.10.1.zip`、`antigrative-dashboard-0.10.1.zip.sha256`
- **独立 Antigravity IDE：** `antigrative-dashboard-ide-0.10.1.vsix`、`antigrative-dashboard-ide-0.10.1.vsix.sha256`

> [!IMPORTANT]
> **IDE 扩展 ID 变更提示：** 独立 IDE 扩展 ID 已变更为 `shzbz.antigrative-dashboard-ide`（数据目录位于 `User/globalStorage/shzbz.antigrative-dashboard-ide/`）。若从原上游 `you-should-know-me.antigrative-dashboard-ide` 迁移，请先完整退出 IDE，将旧目录下的 `history-v1/`、`usage-v1/` 与 `preferences.json` 复制到新目录并卸载旧版扩展。详情见 [ide/README.md](ide/README.md)。

App 安装/更新需 Python 3.10+；CLI 需 Node.js 20+。更多说明请参阅 [CHANGELOG.md](CHANGELOG.md)、[中文 README](README.zh-CN.md) 与 [ide/README.md](ide/README.md)。
