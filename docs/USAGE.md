# Local Token usage

This feature supports Antigravity desktop and its standalone IDE. Each uses its own data directory and local trajectories. The CLI adapter is unchanged.

Open the database/cache icon, then **View token usage**:
- **Activity tab:** Daily and weekly contribution heatmaps with hover counts and year selection.
- **Usage details tab:**
  - **Account scope selector:** Switch between individual local accounts (`accounts-v1.json` / optional local `.data/usage-accounts.local.json`) or **All Accounts (Aggregated)**.
  - **Dimension & model grouping controls:** Toggle between **By Model** (`按模型统计`) and **By User** (`按用户统计`). In the model view, switch between **Simple** (`简易`, default) and **Detailed** (`详细`): Simple mode normalizes and groups model variant suffixes and casing via `baseModelName()` (while preserving `Orchestrator (Argon)`), and clicking or pressing Enter/Space on any grouped table row (`tr.model-group-row`) expands inline per-variant breakdown rows (`tr.model-variant-row`).
  - **Date range & single-bar drilldown:** Switch between **Day**, **Week**, **Month**, and **Custom** date range (`<input type="date">` with adaptive horizontal scrolling for ranges `> 31` days). Clicking a bar highlights that bucket (`.selected`) and filters the breakdown table to that period, with a one-click reset.
  - **24-hour trend line chart (`Hourly trend`):** Collapsible interactive SVG 24-point smooth Catmull-Rom / Bezier spline chart with gradient area fill, crosshair inspection, non-negative geometric clamping, and **Period total** (`区间汇总`) vs. **Today** (`今日`) views.
  - **Remote Project Manual Usage (`+ Remote Usage`):** Create, edit, or delete manual token usage entries for mobile or external remote sessions, persisted as SHA-256 hashed JSON records across both the CDP bridge and Electron IPC.

On first opening, a compact introduction explains local history import, missing/deleted history, the difference from account billing, `Asia/Shanghai` (UTC+8) date boundaries, and local-only numeric storage. **Got it** saves acknowledgment independently of language and theme.

The window uses a top-layer popover with dialog semantics, a backdrop, and explicit keyboard/focus containment (`src/ui/usage-modal/`), avoiding Chromium's whole-document modal inertness stalls on long chats. Model and user colors are synthesized dynamically from the active host accent and background (`src/shared/color.ts` and `src/ui/usage-modal/palette.ts`) with at least 3:1 contrast against the background.

## Accounting & multi-account isolation

- `Total = uncached input + cache reads + cache writes + output` (output includes thinking tokens).
- Token usage is independent of TPS timing-quality exclusions.
- Request creation time determines the date (falling back to the matching planner step's creation time); undated requests contribute only to the all-time total.
- Date grouping uses `Asia/Shanghai` (UTC+8) and Monday-start weeks.
- **Strict per-account ownership (`ownership-v1.json`):** Both live ingestion (`DesktopUsage.ingest`) and historical backfill (`DesktopUsage.runSync`) enforce per-account conversation ownership (`registerOwnership`, `otherScopeFiles`, `inspectOtherAccounts`, primary-account tie-breaking, and time-bounded splitting of cross-account active continuations). Switching accounts or rescanning shared local disk directories never inflates or leaks token counts across accounts. `tools/reconcile-usage-ledger.mjs` (`dry-run` / `--apply`) is also provided to audit and clean any historical duplicate ledger files with conservation verification.
- **Incremental `fileIndex` & batched backfill checkpoints (`v0.11.0`):** `UsageLedger` maintains an in-memory file metadata index (`mtime + size` with `keyVersions` concurrency guards) and separated read/write queues (`writeQueue`), so `summary()` only parses newly added or modified `<sha256>.json` files without head-of-line blocking during background ingestion. `DesktopUsage.runSync()` flushes `backfill-v1.json` checkpoints once per 3-second batch slice rather than inside the inner conversation loop.
- History discovery scans candidate IDs from local `conversations/*.db` and `brain/<conversation-id>` directories plus the authenticated local API. Files only identify candidates; Token counters always come from the authenticated local API or explicit manual entries.
- Only available local records can be recovered. Deleting a conversation does not subtract already recorded consumption. This is observed local usage, not provider billing.

## Storage and privacy

The `usage-v1` directory is separate from `history-v1` (latest conversation statistics) and `timeline-v1` (opt-in structural call timeline). It stores request time, model, Token counters, and hashed request/conversation/account identifiers. Prompts, replies, and credentials are never stored. Personal account display labels can be configured locally in gitignored `.data/usage-accounts.local.json` and are never embedded in source code or release packages.

- **Desktop path:** `~/.gemini/antigravity/sidecar_data/antigravity-pulse/panel/data/usage-v1/`
- **IDE path:** `User/globalStorage/shzbz.antigrative-dashboard-ide/usage-v1/` under the IDE profile (see `ide/README.md` if migrating from `you-should-know-me.antigrative-dashboard-ide`).

## Verification

`node --test sidecars/panel/tests/usage*.test.mjs sidecars/panel/tests/multi-account-features.test.mjs` verifies persistence, incremental `fileIndex` caching, read/write queue separation, deduplication, multi-account ownership isolation, manual CRUD, and batched backfill checkpoints. `npm run test:usage-ui` (`tools/check-usage-ui.mjs` and `tools/check-usage-performance.mjs` via `tools/ui-runner.mjs`) exercises the usage modal, 24-hour trend chart, Simple/Detailed variant expansion, account switching, and 20,000-element host performance in Chromium.
