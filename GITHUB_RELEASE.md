# Antigrative Dashboard v0.12.1

> [!NOTE]
> **Independent Continuation Fork (`v0.12.1`):**
> This release is published by the independent continuation fork [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard), maintained from `v0.8.7` of the MIT-licensed upstream project `antigrative-dashboard` (`Copyright (c) 2026 AG Pulse contributors`). Releases from `v0.8.8` onward are independently developed and maintained without affiliation with or endorsement from the original upstream authors.

> [!IMPORTANT]
> **Prebuilt Rust Native Binaries Now Bundled (`pulse-accel` & `ag-pulse-statusline`):**
> `v0.12.1` fixes the `v0.12.0` release packaging gap where the prebuilt Rust binaries compiled by CI were not bundled into the Release ZIP and IDE VSIX. Both `antigrative-dashboard-0.12.1.zip` and `antigrative-dashboard-ide-0.12.1.vsix` now directly include the prebuilt `pulse-accel.<platform>-<arch>.node` addons for all 5 platforms (`win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`), and the ZIP also ships the standalone `ag-pulse-statusline` CLI binaries under `cli/bin/`. You can still disable native acceleration at runtime with `PULSE_DISABLE_NATIVE_ACCEL=1` (falling back seamlessly to pure TypeScript) or roll back to **`v0.11.0`** if needed.

## What's New in v0.12.1

- **Bundle prebuilt 5-platform Rust binaries in ZIP & VSIX (`src/platform/manifest.ts`, `src/lifecycle/packager.ts`, `manage.py`, `ide/package.py`):** Explicitly includes tagged `sidecars/panel/pulse-accel.<platform>-<arch>.node` addons in both the App/CLI ZIP and standalone IDE VSIX (with `[Content_Types].xml` `.node` registration), and includes `cli/bin/ag-pulse-statusline.<platform>-<arch>` binaries in the App/CLI ZIP with preserved Unix `0755` executable permissions.
- **Wire `native.yml` into `release.yml` with strict verification (`tools/publish-release.py`, `.github/workflows/{native,release}.yml`):** Invokes the 5-platform Rust build matrix via `workflow_call`, downloads all `pulse-native-*` artifacts before packaging, and enforces `--require-native` (`AG_PULSE_REQUIRE_NATIVE=1`) checks before publishing.

## Downloads

- **App / CLI:** `antigrative-dashboard-0.12.1.zip` and `antigrative-dashboard-0.12.1.zip.sha256`
- **Standalone Antigravity IDE:** `antigrative-dashboard-ide-0.12.1.vsix` and `antigrative-dashboard-ide-0.12.1.vsix.sha256`

> [!IMPORTANT]
> **Standalone IDE Extension ID:** The IDE extension identifier is `shzbz.antigrative-dashboard-ide` (global storage path: `User/globalStorage/shzbz.antigrative-dashboard-ide/`). If migrating from upstream `you-should-know-me.antigrative-dashboard-ide`, quit the IDE, copy `history-v1/`, `usage-v1/`, and `preferences.json` to the new storage folder, and uninstall the old extension before relaunching. See [ide/README.md](ide/README.md).

Details: [full changelog](CHANGELOG.md) · [English README](README.md) · [IDE guide](ide/README.md) · [usage accounting](docs/USAGE.md) · [update verification](docs/UPDATES.md).

---

## 中文发布说明（v0.12.1）

> [!NOTE]
> **独立接续维护分支发布（`v0.12.1`）：**
> 本版本由基于原 MIT 协议开源项目 `antigrative-dashboard`（`Copyright (c) 2026 AG Pulse contributors`）`v0.8.7` 独立接续维护的仓库 [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard) 发布。自 `v0.8.8` 起的所有更新均由当前仓库独立开发与维护，与原上游作者不存在从属或背书关系。

> [!IMPORTANT]
> **预编译 Rust 原生引擎已正式打入发布包：**
> `v0.12.1` 修复了 `v0.12.0` 发布包遗漏 Rust 原生二进制导致下载用户静默回退到 TypeScript 的问题。现在 `antigrative-dashboard-0.12.1.zip` 与 `antigrative-dashboard-ide-0.12.1.vsix` 均已直接内置全部 5 个平台（`win32-x64`、`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`）的预编译 `pulse-accel.<platform>-<arch>.node` 原生模块，ZIP 内 `cli/bin/` 也同步附带独立原生状态栏可执行文件 `ag-pulse-statusline.*`。如需临时关闭原生加速，仍可通过环境变量 `PULSE_DISABLE_NATIVE_ACCEL=1` 无缝切回纯 TypeScript 模式。

### v0.12.1 修复与改进

- **将 5 平台预编译 Rust 原生二进制打包进 ZIP 与 VSIX：** 调整发布打包白名单与 VSIX `[Content_Types].xml` 配置，在继续排除本地未标记开发二进制与调试符号的同时，正式收录 5 平台 `pulse-accel.<platform>-<arch>.node` 与 `cli/bin/ag-pulse-statusline.*`，并在 Windows 打包环境下自动为 Linux/macOS 可执行文件写入 `0755` 权限位。
- **打通 `native.yml` 与 `release.yml` 并强制校验：** 发布工作流在打包前自动拉取 5 平台 Rust 编译产物，并通过 `--require-native` / `AG_PULSE_REQUIRE_NATIVE=1` 对 ZIP、VSIX 内容做完整性校验后再对外发布。

### 下载产物与迁移说明

- **App / CLI：** `antigrative-dashboard-0.12.1.zip`、`antigrative-dashboard-0.12.1.zip.sha256`
- **独立 Antigravity IDE：** `antigrative-dashboard-ide-0.12.1.vsix`、`antigrative-dashboard-ide-0.12.1.vsix.sha256`

更多说明请参阅 [CHANGELOG.md](CHANGELOG.md)、[中文 README](README.zh-CN.md) 与 [ide/README.md](ide/README.md)。
