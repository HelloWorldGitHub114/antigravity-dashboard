# Antigrative Dashboard v0.12.4

> [!NOTE]
> **Independent Continuation Fork (`v0.12.4`):**
> This release is published by the independent continuation fork [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard), maintained from `v0.8.7` of the MIT-licensed open-source project `antigrative-dashboard` (`Copyright (c) 2026 AG Pulse contributors`). Releases from `v0.8.8` onward are independently developed and maintained without affiliation with or endorsement from the original upstream authors.

> [!IMPORTANT]
> **Prebuilt Rust Native Binaries Included (`pulse-accel` & `ag-pulse-statusline`):**
> Both `antigrative-dashboard-0.12.4.zip` and `antigrative-dashboard-ide-0.12.4.vsix` bundle the prebuilt `pulse-accel.<platform>-<arch>.node` addons for all 5 platforms (`win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`), and the ZIP also ships the standalone `ag-pulse-statusline` CLI binaries under `cli/bin/`. You can disable native acceleration at runtime with `PULSE_DISABLE_NATIVE_ACCEL=1` (falling back seamlessly to pure TypeScript) or roll back to **`v0.11.0`** if needed.

## What's New in v0.12.4

- **Antigravity `2.33.0` Bottom-Bar Opt-In & Sidebar Gear Popover (`src/lifecycle/{debug-launch,installer,manage-cli}.ts`, `src/ui/panel-webview/settings-popover.ts`):**
  - Antigravity `2.33.0` disables loopback remote debugging by default. Replaced the header `Aa` / language controls with a compact gear popover (`#settings-button` / `#settings-popover`) combining an **opt-in (default OFF)** OS shortcut/launcher debug-flag toggle (`#debug-launch-toggle` + live status readout via `/api/debug-launch` and `manage.mjs debug-launch <status|on|off>`), `简体中文` / `English` language switching, and 3-row `Aa` font scaling (`Usage modal`, `Sidebar`, `Bottom card`). Patched shortcuts/launchers are automatically cleaned up when turned off or uninstalled.
- **Standalone Sidebar Usage Stats Entry (`#open-usage-button`, `src/telemetry/{main,preview-server}.ts`, `src/ui/panel-webview/index.ts`, `src/ui/usage-modal/*`):**
  - Added a dedicated **Usage stats** (`用量统计`) button on the sidebar `.sampled-model` row so users running without the inline bottom bar can open the full Token Usage dashboard directly from the sidebar. Invokes `RuntimeUi.openUsageModal()` over `/api/usage/open` when connected, or falls back seamlessly to an embedded `createUsageDashboard` inside `#panel-usage-host` backed by `/api/usage/*` endpoints and responsive narrow-pane styles (`@media (max-width: 520px)`).
- **Fixed Antigravity `2.33.0` Sidebar Wheel Scrolling & "Open Sidebar" Button (`src/ui/panel-webview/panel.css`, `src/ui/host-adapter/{redux-sidebar,react-fiber}.ts`):**
  - Bounded non-standalone `body:not(.standalone) > .widget` to `calc(100% - 20px)` (`min-height: 0; flex: 1 1 0%`) with `overflow: hidden` on the sidecar viewport so overflowing sidebar sections scroll smoothly with the mouse wheel while preserving `.standalone` preview layout and `data-pin-bottom`.
  - Updated `dispatchSidecarOpen` and `probeReduxDependencies` to inspect `auxPaneComponent?.redesignEnabled`, send both Antigravity `2.33.0`'s `panelScope` and legacy `treeId` across `sidePanelV2/setContent`, `sidePanel/setContent`, and `sidePanel/setSidePanelOpen`, and extract `?cascadeId=` in `readDesktopConversationId()`.

## Downloads

- **App / CLI:** `antigrative-dashboard-0.12.4.zip` and `antigrative-dashboard-0.12.4.zip.sha256`
- **Standalone Antigravity IDE:** `antigrative-dashboard-ide-0.12.4.vsix` and `antigrative-dashboard-ide-0.12.4.vsix.sha256`

> [!IMPORTANT]
> **Standalone IDE Extension ID:** The IDE extension identifier is `shzbz.antigrative-dashboard-ide` (global storage path: `User/globalStorage/shzbz.antigrative-dashboard-ide/`). If migrating from upstream `you-should-know-me.antigrative-dashboard-ide`, quit the IDE, copy `history-v1/`, `usage-v1/`, and `preferences.json` to the new storage folder, and uninstall the old extension before relaunching. See [ide/README.md](ide/README.md).

Details: [full changelog](CHANGELOG.md) · [English README](README.md) · [IDE guide](ide/README.md) · [usage accounting](docs/USAGE.md) · [update verification](docs/UPDATES.md).

---

## 中文发布说明（v0.12.4）

> [!NOTE]
> **独立接续维护分支发布（`v0.12.4`）：**
> 本版本由基于原 MIT 协议开源项目 `antigrative-dashboard`（`Copyright (c) 2026 AG Pulse contributors`）`v0.8.7` 独立接续维护的仓库 [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard) 发布。自 `v0.8.8` 起的所有更新均由当前仓库独立开发与维护，与原上游作者不存在从属或背书关系。

> [!IMPORTANT]
> **已内置 5 平台预编译 Rust 原生引擎：**
> `antigrative-dashboard-0.12.4.zip` 与 `antigrative-dashboard-ide-0.12.4.vsix` 均已直接内置全部 5 个平台（`win32-x64`、`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`）的预编译 `pulse-accel.<platform>-<arch>.node` 原生模块，ZIP 内 `cli/bin/` 同步附带独立原生状态栏可执行文件 `ag-pulse-statusline.*`。如需临时关闭原生加速，仍可通过环境变量 `PULSE_DISABLE_NATIVE_ACCEL=1` 无缝切回纯 TypeScript 模式。

### v0.12.4 新增与改进

- **适配 Antigravity `2.33.0` 默认关闭调试端口与侧边栏齿轮设置弹窗：**
  - Antigravity `2.33.0` 默认关闭了本地调试接口，将侧边栏右上角原有 `Aa` 与语言切换整合为齿轮设置弹窗（`#settings-button` / `#settings-popover`）：新增**可选且默认关闭**的「自动启用底栏调试」开关（Windows 快捷方式 / macOS `.command` 启动器 / Linux `.desktop` 按需注入 `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1`，关闭或卸载自动清理还原，并同步支持 `manage.mjs debug-launch <status|on|off>` 与 `install --enable-debug-launch`），同时整合 `简体中文` / `English` 切换与三端独立 `Aa` 字体缩放。
- **侧边栏新增「用量统计」入口：**
  - 在侧边栏「采样模型」行右侧新增 **用量统计**（`#open-usage-button`）按钮：底栏已挂载时直接调起宿主全屏统计弹窗；即使未启用调试启动（无底栏），也会通过侧边栏内嵌的 `#panel-usage-host` 与 `/api/usage/*` 接口无缝弹出完整的 Token 用量大盘。
- **修复 Antigravity `2.33.0` 侧边栏无法滚轮滚动与底栏「打开侧边栏」失效问题：**
  - 修复非独立预览模式下 `.widget` 随内容无限拉长导致鼠标滚轮失效的问题，锁定视口高度并将滚动限定在圆角卡片内部，同时保留 `data-pin-bottom` 与独立预览样式。
  - 适配 Antigravity `2.33.0` Hub 将 Redux `treeId` 重命名为 `panelScope` 与 `auxPaneComponent.redesignEnabled` / `?cascadeId=` 路由参数的变化，在 `sidePanelV2/setContent`、`sidePanel/setContent` 与 `sidePanel/setSidePanelOpen` 同时派发 `panelScope` 与 `treeId`，恢复底栏卡片一键打开侧边栏功能。

### 下载产物与迁移说明

- **App / CLI：** `antigrative-dashboard-0.12.4.zip`、`antigrative-dashboard-0.12.4.zip.sha256`
- **独立 Antigravity IDE：** `antigrative-dashboard-ide-0.12.4.vsix`、`antigrative-dashboard-ide-0.12.4.vsix.sha256`

更多说明请参阅 [CHANGELOG.md](CHANGELOG.md)、[中文 README](README.zh-CN.md) 与 [ide/README.md](ide/README.md)。
