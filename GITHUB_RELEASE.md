# Antigrative Dashboard v0.12.0

> [!NOTE]
> **Independent Continuation Fork (`v0.12.0`):**
> This release is published by the independent continuation fork [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard), maintained from `v0.8.7` of the MIT-licensed upstream project `antigrative-dashboard` (`Copyright (c) 2026 AG Pulse contributors`). Releases from `v0.8.8` onward are independently developed and maintained without affiliation with or endorsement from the original upstream authors.

> [!IMPORTANT]
> **New Rust Native Engine (`pulse-accel`) & Fallback Guidance:**
> `v0.12.0` introduces the Rust N-API native engine (`pulse-accel`) for dramatically faster responsiveness and much lower V8 memory usage. If you encounter any issues or regressions with the Rust engine, please report them promptly on [GitHub Issues](https://github.com/ShZbz/antigravity-dashboard/issues). You can disable native acceleration at runtime with `PULSE_DISABLE_NATIVE_ACCEL=1` (falling back seamlessly to pure TypeScript) or roll back to **`v0.11.0`** if needed.

## What's New in v0.12.0

- **Rust N-API native engine & zero-RPC SQLite direct-read bypass (`native/pulse-accel`, `src/platform/native-bridge.ts`):** Direct SQLite + Protobuf wire decoding (`proto_wire.rs`, `enums.rs`, `sqlite_trajectory.rs`) eliminates heavy `language_server` RPC round-trips for settled local conversations across `TrajectoryReader`, `local-conversations.ts`, `UsageLedger`/`backfill-sync.ts`, and `delegated-collector.ts` with automatic JS/RPC fallback.
- **Much lower V8 heap usage & faster hot paths (`ledger_index`, `snapshot_diff`, `shared_cache`, `transcript_scan`, `svg_compiler`, `log_rotator`):** Caches parsed usage records in binary `ledger-compact-v1.bin` and cross-process `shared-usage-cache-v1.db`, diffs session snapshots and rotates logs off the V8 heap, tails large JSONL transcripts natively, and accelerates SVG spline/swimlane generation and Win32 process/port discovery.
- **Commercial / Enterprise / Vertex cache-hit fix & lazy Vertex polling (`src/telemetry/lazy-vertex.ts`, `src/telemetry/metrics/primitives.ts`):** Fixes missing (`—`) cache hit rates on commercial Vertex/Evergreen providers, self-heals incomplete `history-v1` and `shared-usage-cache-v1.db` entries, ships standalone native `ag-pulse-statusline` (`--snapshot`), and keeps `.antigravity-vertex` polling dormant until needed.
- **Cross-platform CI & lifecycle hardening:** Runs `npm ci` before `tools/build.mjs --check` in CI/release workflows, removes `paths` restriction on `native.yml` tag triggers, distinguishes target symlinks/junctions from ancestor symlinks such as macOS `/var -> /private/var`, deduplicates concurrent Playwright Chromium launches (`tools/ui-runner.mjs`), and skips native-only assertions gracefully when the `.node` addon is absent.

## Downloads

- **App / CLI:** `antigrative-dashboard-0.12.0.zip` and `antigrative-dashboard-0.12.0.zip.sha256`
- **Standalone Antigravity IDE:** `antigrative-dashboard-ide-0.12.0.vsix` and `antigrative-dashboard-ide-0.12.0.vsix.sha256`

> [!IMPORTANT]
> **Standalone IDE Extension ID:** The IDE extension identifier is `shzbz.antigrative-dashboard-ide` (global storage path: `User/globalStorage/shzbz.antigrative-dashboard-ide/`). If migrating from upstream `you-should-know-me.antigrative-dashboard-ide`, quit the IDE, copy `history-v1/`, `usage-v1/`, and `preferences.json` to the new storage folder, and uninstall the old extension before relaunching. See [ide/README.md](ide/README.md).

Details: [full changelog](CHANGELOG.md) · [English README](README.md) · [IDE guide](ide/README.md) · [usage accounting](docs/USAGE.md) · [update verification](docs/UPDATES.md).

---

## 中文发布说明（v0.12.0）

> [!NOTE]
> **独立接续维护分支发布（`v0.12.0`）：**
> 本版本由基于原 MIT 协议开源项目 `antigrative-dashboard`（`Copyright (c) 2026 AG Pulse contributors`）`v0.8.7` 独立接续维护的仓库 [`ShZbz/antigravity-dashboard`](https://github.com/ShZbz/antigravity-dashboard) 发布。自 `v0.8.8` 起的所有更新均由当前仓库独立开发与维护，与原上游作者不存在从属或背书关系。

> [!IMPORTANT]
> **Rust 原生引擎上线与回退说明：**
> `v0.12.0` 正式引入 **Rust 原生加速引擎（`pulse-accel`）**，大幅提升监控刷新、回填与交互响应速度，并显著降低原先版本的 V8 内存占用。若您在使用过程中遇到任何由新引擎引起的异常或不适，请及时在 [GitHub Issues](https://github.com/ShZbz/antigravity-dashboard/issues) 反馈；可通过环境变量 `PULSE_DISABLE_NATIVE_ACCEL=1` 即时切回纯 TypeScript 回退路径，若仍无法接受也可回退至 **`v0.11.0`** 版本。

### v0.12.0 重点更新

- **Rust N-API 原生加速引擎与 SQLite 零 RPC 直读旁路（`native/pulse-accel`、`src/platform/native-bridge.ts`）：** 直接解码本地 `.db` SQLite 与 Protobuf 线缆数据（`proto_wire.rs`、`enums.rs`、`sqlite_trajectory.rs`），绕过已静止会话的繁重 `language_server` RPC 调用，支持自动 JS/RPC 无感回退。
- **显著降内存与热点全面加速：** 新增 `ledger-compact-v1.bin` 二进制账本增量索引与 `shared-usage-cache-v1.db` 跨进程共享 SQLite 缓存；将快照指纹 Diff、日志截断、JSONL 尾扫描、开源脱敏审计、SVG 曲线/泳道编译与 Win32 进程端口发现迁移至堆外 Rust。
- **商用 / Enterprise / Vertex 缓存命中率修复与懒惰实例轮询：** 完善多类 Vertex/Evergreen 商用 provider 校验与 `history-v1` / 共享缓存自愈，提供原生独立状态栏 CLI `ag-pulse-statusline`（`--snapshot`），并将 `.antigravity-vertex` 轮询改为按需懒启动。
- **三平台 CI、开源导出与生命周期稳定性加固：** 修复 GitHub CI 未先安装 `esbuild` 导致 `build.mjs --check` 失败、修复开源导出树构建校验与 `.pytest_cache` 过滤、修复 macOS `/var -> /private/var` 上层祖先符号链接误判、修复 Playwright 并发共享浏览器竞态以及无原生 `.node` 环境下的测试跳过逻辑。

### 下载产物与迁移说明

- **App / CLI：** `antigrative-dashboard-0.12.0.zip`、`antigrative-dashboard-0.12.0.zip.sha256`
- **独立 Antigravity IDE：** `antigrative-dashboard-ide-0.12.0.vsix`、`antigrative-dashboard-ide-0.12.0.vsix.sha256`

更多说明请参阅 [CHANGELOG.md](CHANGELOG.md)、[中文 README](README.zh-CN.md) 与 [ide/README.md](ide/README.md)。
