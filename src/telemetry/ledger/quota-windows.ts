import { join } from 'node:path';
import type { QuotaGroup, QuotaWindowUsage } from '../../contracts/index.ts';
import {
  buildQuotaWindowSpecs,
  classifyQuotaGroupId,
  finalizeQuotaWindows,
  quotaWindowMeta,
  type QuotaWindowMetaMap,
  type QuotaWindowRawCount,
} from '../../shared/quota-forecast.ts';
import { isErrno, mapPool, recordSum, validRow } from './helpers.ts';
import { recordQuotaCycleBoundaries } from './quota-cycles.ts';
import type { UsageLedger } from './summary.ts';
import { HASH_RE, LEDGER_FILE_RE, MAX_RECORD_FILE_BYTES, type LedgerDocument } from './types.ts';

interface QuotaWindowCacheEntry {
  key: string;
  revision: number;
  counts: Record<string, QuotaWindowRawCount>;
  meta: QuotaWindowMetaMap;
}

// 按 UsageLedger 实例隔离缓存，避免污染多实例或单元测试状态
const quotaWindowCaches = new WeakMap<UsageLedger, QuotaWindowCacheEntry>();

/**
 * 统计当前账号在各活跃额度窗口（5h / 周）内的实测流经 Token，并推算同比例满额容量。
 * 仅扫描 mtime 落在本周期起始之后的账本文件，配合缓存确保轮询开销近乎为零。
 */
export async function summarizeQuotaWindows(
  ledger: UsageLedger,
  accountScope: string | null | undefined,
  groups: ReadonlyArray<QuotaGroup> | null | undefined,
): Promise<Record<string, QuotaWindowUsage>> {
  if (!accountScope || !HASH_RE.test(accountScope)) return {};
  const { specs, groupInfos } = buildQuotaWindowSpecs(groups);
  if (!specs.length) return {};

  // 后台轻量记录已锁定（非空闲）的真实周期边界，供历史额度周期回溯使用
  void recordQuotaCycleBoundaries(ledger, accountScope, groups, specs).catch(() => {});

  // 空闲窗口（remaining === 1）的 resetAt 随当前时间滑动，缓存键忽略其 resetMinute 以避免无谓重扫与界面闪烁
  const specsKey = specs
    .map((s) => `${s.id}:${s.idle ? 'idle' : s.resetMinute}`)
    .join('|');
  const cacheKey = `${accountScope}|${specsKey}`;
  const cached = quotaWindowCaches.get(ledger);
  if (cached && cached.key === cacheKey && cached.revision === ledger.revision) {
    return finalizeQuotaWindows(specs, cached.counts, cached.meta);
  }

  let minStart = Infinity;
  for (const spec of specs) {
    if (spec.startAt < minStart) minStart = spec.startAt;
  }
  if (!Number.isFinite(minStart)) return {};

  const scopeDir = join(ledger.directory, accountScope);
  let files: string[] = [];
  try {
    files = (await ledger.fs.readdir(scopeDir)) as string[];
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return {};
    return {};
  }

  const validFiles = files.filter((name) => LEDGER_FILE_RE.test(name));
  if (!validFiles.length) return {};

  const startRevision = ledger.revision;
  // 按请求 ID 去重，取 Token 总量最大的记录（与主账本口径一致）
  const dedup = new Map<string, { at: number; model: string; total: number }>();

  await mapPool(validFiles, 16, async (name) => {
    const fullPath = join(scopeDir, name);
    let doc: LedgerDocument | null = null;
    try {
      const st = await ledger.fs.stat(fullPath);
      if (!st) return;
      const mtimeMs = Number(st.mtimeMs ?? 0);
      // 跳过早于所有活跃窗口起点的历史文件（留 2 分钟时钟容差）
      if (Number.isFinite(mtimeMs) && mtimeMs > 0 && mtimeMs < minStart - 120000) {
        return;
      }
      if (Number(st.size) > MAX_RECORD_FILE_BYTES) return;
      const text = await ledger.fs.readFile(fullPath, 'utf8');
      if (text.length > MAX_RECORD_FILE_BYTES) return;
      const parsed = JSON.parse(text) as LedgerDocument;
      if (
        parsed.schema !== 1 ||
        parsed.account !== accountScope ||
        !Array.isArray(parsed.records) ||
        !parsed.records.every(validRow)
      ) {
        return;
      }
      doc = parsed;
    } catch {
      return;
    }
    if (!doc) return;
    for (const r of doc.records) {
      if (typeof r.at !== 'number' || !Number.isFinite(r.at) || r.at < minStart) continue;
      const total = recordSum(r);
      const prev = dedup.get(r.id);
      if (!prev || total > prev.total) {
        dedup.set(r.id, { at: r.at, model: r.model, total });
      }
    }
  });

  const counts: Record<string, QuotaWindowRawCount> = {};
  for (const r of dedup.values()) {
    const gid = classifyQuotaGroupId(groupInfos, r.model);
    if (!gid) continue;
    for (const spec of specs) {
      if (spec.groupId === gid && r.at >= spec.startAt && r.at <= spec.endAt) {
        const item = counts[spec.id] || { observedTokens: 0, requests: 0 };
        item.observedTokens += r.total;
        item.requests += 1;
        counts[spec.id] = item;
      }
    }
  }

  const meta = quotaWindowMeta(specs);
  if (ledger.revision === startRevision) {
    quotaWindowCaches.set(ledger, { key: cacheKey, revision: startRevision, counts, meta });
  }
  return finalizeQuotaWindows(specs, counts, meta);
}
