#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { UsageLedger } from '../sidecars/panel/usage.mjs';

const HASH_FILE_RE = /^[a-f0-9]{64}\.json$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const KEYS = ['uncached', 'cacheRead', 'cacheWrite', 'output'];

const sha = s => createHash('sha256').update(String(s).toLowerCase()).digest('hex');
const tokSum = r => (r.uncached || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0) + (r.output || 0);

function parseArgs(argv) {
  const args = { apply: false, dryRun: true, usageDir: null, agRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') { args.apply = true; args.dryRun = false; }
    else if (a === '--dry-run') { args.apply = false; args.dryRun = true; }
    else if (a === '--data-dir' && argv[i + 1]) args.usageDir = argv[++i];
    else if (a === '--ag-root' && argv[i + 1]) args.agRoot = argv[++i];
  }
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  args.agRoot ||= join(home, '.gemini', 'antigravity');
  args.usageDir ||= join(args.agRoot, 'sidecar_data', 'antigravity-pulse', 'panel', 'data', 'usage-v1');
  return args;
}

async function readJsonSafe(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function writeAtomic(file, data) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
  await rename(temp, file);
}

async function buildUuidMap(usageDir, historyDir, agRoot, ownershipObj) {
  const map = new Map();
  const addId = id => {
    if (typeof id !== 'string') return;
    const m = id.match(UUID_RE);
    if (!m) return;
    const norm = m[0].toLowerCase();
    map.set(`${sha(norm)}.json`, norm);
  };
  for (const k of Object.keys(ownershipObj || {})) addId(k);
  try {
    const hDirs = await readdir(historyDir, { withFileTypes: true });
    for (const d of hDirs) {
      if (!d.isDirectory()) continue;
      const files = await readdir(join(historyDir, d.name)).catch(() => []);
      for (const f of files) {
        addId(f);
        if (f.endsWith('.json')) {
          const obj = await readJsonSafe(join(historyDir, d.name, f));
          if (obj?.conversationId) addId(obj.conversationId);
          if (obj?.id) addId(obj.id);
        }
      }
    }
  } catch {}
  for (const sub of ['conversations', 'brain']) {
    const entries = await readdir(join(agRoot, sub)).catch(() => []);
    for (const e of entries) addId(e);
  }
  const scopes = await readdir(usageDir, { withFileTypes: true }).catch(() => []);
  for (const s of scopes) {
    if (!s.isDirectory() || !HASH_RE.test(s.name)) continue;
    const files = await readdir(join(usageDir, s.name)).catch(() => []);
    for (const f of files) {
      if (!HASH_FILE_RE.test(f)) continue;
      const rec = await readJsonSafe(join(usageDir, s.name, f));
      if (rec?.id) addId(rec.id);
      if (rec?.conversationId) addId(rec.conversationId);
    }
  }
  return map;
}

async function loadHistorySignals(historyDir, scopes) {
  const byScope = new Map();
  for (const s of scopes) {
    const map = new Map();
    let earliestAt = Infinity;
    const files = await readdir(join(historyDir, s)).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const full = join(historyDir, s, f);
      const st = await stat(full).catch(() => null);
      const obj = await readJsonSafe(full);
      const idMatch = (obj?.conversationId || obj?.id || f).match(UUID_RE);
      const entries = Array.isArray(obj?.entries) ? obj.entries : Array.isArray(obj?.samples) ? obj.samples : [];
      let minTs = st?.mtimeMs ?? Infinity;
      for (const e of entries) {
        const t = typeof e?.at === 'number' ? e.at : typeof e?.timestamp === 'number' ? e.timestamp : Date.parse(e?.at || e?.timestamp || '');
        if (Number.isFinite(t) && t > 1e12 && t < minTs) minTs = t;
      }
      if (minTs < earliestAt) earliestAt = minTs;
      if (idMatch) {
        const fn = `${sha(idMatch[0].toLowerCase())}.json`;
        map.set(fn, { mtimeMs: st?.mtimeMs ?? Infinity, minTs });
      }
    }
    byScope.set(s, { convs: map, earliestAt });
  }
  return byScope;
}

function detectBulkBursts(items) {
  // Find mtime clusters (>= 5 files within 120s) where >= 5 files are delayed > 30m after maxAt.
  // Any file in such a cluster written >= 60s after maxAt (not generated live that second) is part of the sweep.
  const sorted = [...items].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const burstFiles = new Set();
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j < sorted.length && sorted[j].mtimeMs - sorted[i].mtimeMs <= 120 * 1000) j++;
    const cluster = sorted.slice(i, j);
    const delayedCount = cluster.filter(x => Number.isFinite(x.maxAt) && (x.mtimeMs - x.maxAt) > 30 * 60 * 1000).length;
    if (cluster.length >= 5 && delayedCount >= 5) {
      for (const item of cluster) {
        if (!Number.isFinite(item.maxAt) || (item.mtimeMs - item.maxAt) >= 60 * 1000) {
          burstFiles.add(item.fileName);
        }
      }
    }
  }
  return burstFiles;
}

function mergeRows(rowArrays) {
  const merged = new Map();
  for (const rows of rowArrays) {
    for (const row of rows) {
      const old = merged.get(row.id);
      if (!old) { merged.set(row.id, { ...row }); continue; }
      const next = tokSum(row) >= tokSum(old) ? { ...old, ...row } : { ...row, ...old };
      next.at = row.at ?? old.at ?? null;
      if (old.at !== null && old.at !== undefined && (row.at === null || row.at === undefined)) next.timeBasis = old.timeBasis;
      for (const k of KEYS) next[k] = tokSum(row) >= tokSum(old) ? (row[k] ?? old[k] ?? null) : (old[k] ?? row[k] ?? null);
      merged.set(row.id, next);
    }
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function classifyOverlap(fileName, infos, meta, historyByScope) {
  if (infos.length !== 2) {
    const withHist = infos.filter(x => x.inHistory);
    if (withHist.length === 1) return { kind: 'single', owner: withHist[0].scope, reason: 'unique-history' };
    return { kind: 'ambiguous', reason: 'multi-scope-overlap' };
  }
  const [a, b] = infos;
  const idsA = new Set(a.records.map(r => r.id));
  const idsB = new Set(b.records.map(r => r.id));
  const onlyA = a.records.filter(r => !idsB.has(r.id));
  const onlyB = b.records.filter(r => !idsA.has(r.id));

  // Case 1: Genuine cross-account continuation (both have history-v1, neither is a sweep burst, strictly newer timestamps)
  const trySplit = (early, late, onlyLate) => {
    if (!onlyLate.length || !early.inHistory || !late.inHistory || early.inBurst || late.inBurst) return null;
    const minOnlyLate = Math.min(...onlyLate.map(r => r.at).filter(Number.isFinite));
    const maxShared = Math.max(...early.records.map(r => r.at).filter(Number.isFinite));
    const lateLag = Math.abs(late.mtimeMs - late.maxAt);
    const earlyLag = Math.abs(early.mtimeMs - maxShared);
    if (Number.isFinite(minOnlyLate) && Number.isFinite(maxShared) && minOnlyLate > maxShared && lateLag <= 2 * 3600 * 1000 && earlyLag <= 2 * 3600 * 1000) {
      return { kind: 'split', owner: early.scope, splitScope: late.scope, keepIdsInSplit: new Set(onlyLate.map(r => r.id)), reason: 'cross-account-continuation' };
    }
    return null;
  };
  if (onlyB.length && !onlyA.length) {
    const sp = trySplit(a, b, onlyB);
    if (sp) return sp;
  }
  if (onlyA.length && !onlyB.length) {
    const sp = trySplit(b, a, onlyA);
    if (sp) return sp;
  }

  // Case 2: Exclusive history-v1 presence
  if (a.inHistory !== b.inHistory) {
    const winner = a.inHistory ? a : b;
    const loser = a.inHistory ? b : a;
    if (!winner.inBurst || loser.inBurst) return { kind: 'single', owner: winner.scope, reason: 'history-v1-exclusive' };
  }

  // Case 3: Pure delayed burst vs real-time write
  if (a.inBurst !== b.inBurst) {
    const winner = a.inBurst ? b : a;
    return { kind: 'single', owner: winner.scope, reason: 'non-burst-realtime' };
  }

  // Case 4: Pre-secondary era (before secondary's earliest history-v1 timestamp; or primary wrote >24h earlier while secondary was delayed copy)
  const rank = s => (meta[s]?.primary === true ? 0 : meta[s]?.primary === false ? 2 : 1);
  const sorted = [...infos].sort((x, y) => rank(x.scope) - rank(y.scope));
  const primary = sorted[0], secondary = sorted[1];
  const secHistStart = historyByScope.get(secondary.scope)?.earliestAt ?? Infinity;
  const convMaxAt = Math.max(primary.maxAt || 0, secondary.maxAt || 0);
  if (Number.isFinite(secHistStart) && convMaxAt > 0 && convMaxAt < secHistStart - 5 * 60 * 1000) {
    if (!secondary.inHistory || (primary.mtimeMs < secondary.mtimeMs - 24 * 3600 * 1000 && secondary.mtimeMs - convMaxAt > 24 * 3600 * 1000)) {
      return { kind: 'single', owner: primary.scope, reason: 'before-secondary-era' };
    }
  }

  // Case 5: Real-time writer (<= 5m from maxAt) vs delayed sync copy (>= 45m after maxAt)
  const lagA = Number.isFinite(a.maxAt) ? Math.abs(a.mtimeMs - a.maxAt) : Infinity;
  const lagB = Number.isFinite(b.maxAt) ? Math.abs(b.mtimeMs - b.maxAt) : Infinity;
  if (lagA <= 5 * 60 * 1000 && lagB >= 45 * 60 * 1000) {
    return { kind: 'single', owner: a.scope, reason: 'realtime-mtime-match' };
  }
  if (lagB <= 5 * 60 * 1000 && lagA >= 45 * 60 * 1000) {
    return { kind: 'single', owner: b.scope, reason: 'realtime-mtime-match' };
  }

  return { kind: 'ambiguous', reason: 'both-realtime-or-tied' };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ledger = new UsageLedger(opts.usageDir);
  const historyDir = join(dirname(opts.usageDir), 'history-v1');
  const ownershipFile = ledger.ownershipFile();
  const existingOwnership = (await readJsonSafe(ownershipFile)) || {};
  const meta = (await readJsonSafe(join(opts.usageDir, 'accounts-v1.json'))) || {};
  const scopes = await ledger.scopeDirectories();
  const beforeAll = await ledger.summary('all');

  const historyByScope = await loadHistorySignals(historyDir, scopes);
  const uuidMap = await buildUuidMap(opts.usageDir, historyDir, opts.agRoot, existingOwnership);

  const fileEntries = new Map();
  const backfillByScope = new Map();
  const scopeRawItems = new Map();

  for (const s of scopes) {
    const bf = (await readJsonSafe(join(opts.usageDir, s, 'backfill-v1.json'))) || null;
    backfillByScope.set(s, bf);
    const items = [];
    const files = await readdir(join(opts.usageDir, s)).catch(() => []);
    for (const f of files.filter(x => HASH_FILE_RE.test(x))) {
      const full = join(opts.usageDir, s, f);
      const st = await stat(full);
      const doc = await readJsonSafe(full);
      if (!doc || doc.schema !== 1 || !Array.isArray(doc.records)) continue;
      const ats = doc.records.map(r => r.at).filter(Number.isFinite);
      const maxAt = ats.length ? Math.max(...ats) : NaN;
      const minAt = ats.length ? Math.min(...ats) : NaN;
      const key = f.replace(/\.json$/, '');
      const item = {
        scope: s, fileName: f, full, doc, records: doc.records,
        mtimeMs: st.mtimeMs, maxAt, minAt,
        inHistory: historyByScope.get(s)?.convs.has(f) || false,
        inBackfill: Boolean(bf && typeof bf === 'object' && (bf[key] || bf.entries?.[key])),
        inBurst: false
      };
      items.push(item);
      if (!fileEntries.has(f)) fileEntries.set(f, []);
      fileEntries.get(f).push(item);
    }
    scopeRawItems.set(s, items);
  }

  const burstByScope = new Map();
  for (const [s, items] of scopeRawItems.entries()) {
    const bursts = detectBulkBursts(items);
    burstByScope.set(s, bursts);
    for (const item of items) item.inBurst = bursts.has(item.fileName);
  }

  // Compute ground-truth unique request records across disk before mutations
  const expectedByRecordId = new Map();
  for (const infos of fileEntries.values()) {
    for (const item of infos) {
      for (const r of item.records) {
        const cur = expectedByRecordId.get(r.id) || 0;
        const val = tokSum(r);
        if (val > cur) expectedByRecordId.set(r.id, val);
      }
    }
  }
  const expectedUniqueTotal = [...expectedByRecordId.values()].reduce((a, b) => a + b, 0);

  const stats = { singleOwnerAssigned: 0, splitCount: 0, ambiguousLeft: 0, exclusiveOwnershipAdded: 0, deletedFiles: 0, removedBackfillKeys: 0, byReason: {} };
  const actions = [];
  const nextOwnership = { ...existingOwnership };

  const hasRecordOverlap = infos => {
    const seenIds = new Set();
    for (const info of infos) {
      for (const r of info.records) {
        if (seenIds.has(r.id)) return true;
        seenIds.add(r.id);
      }
    }
    return false;
  };
  for (const [fileName, infos] of fileEntries.entries()) {
    const convId = uuidMap.get(fileName) || null;
    if (infos.length === 1) {
      if (convId && !nextOwnership[convId]) {
        nextOwnership[convId] = infos[0].scope;
        stats.exclusiveOwnershipAdded++;
      }
      continue;
    }
    if (!hasRecordOverlap(infos)) continue;
    const cls = classifyOverlap(fileName, infos, meta, historyByScope, burstByScope);
    stats.byReason[cls.reason] = (stats.byReason[cls.reason] || 0) + 1;
    if (cls.kind === 'ambiguous') {
      stats.ambiguousLeft++;
      if (convId && nextOwnership[convId]) delete nextOwnership[convId];
      continue;
    }
    if (cls.kind === 'single') {
      stats.singleOwnerAssigned++;
      const winnerItem = infos.find(x => x.scope === cls.owner);
      const merged = mergeRows(infos.map(x => x.records));
      const needsUpdate = JSON.stringify(winnerItem.doc.records) !== JSON.stringify(merged);
      const deletes = infos.filter(x => x.scope !== cls.owner);
      stats.deletedFiles += deletes.length;
      if (convId) nextOwnership[convId] = cls.owner;
      actions.push({ type: 'single', fileName, convId, owner: cls.owner, winnerItem, merged, needsUpdate, deletes, reason: cls.reason });
    } else if (cls.kind === 'split') {
      stats.splitCount++;
      const earlyItem = infos.find(x => x.scope === cls.owner);
      const splitItem = infos.find(x => x.scope === cls.splitScope);
      const earlyMerged = mergeRows([earlyItem.records, splitItem.records.filter(r => !cls.keepIdsInSplit.has(r.id))]);
      const splitKept = splitItem.records.filter(r => cls.keepIdsInSplit.has(r.id));
      if (convId) nextOwnership[convId] = cls.owner;
      actions.push({ type: 'split', fileName, convId, owner: cls.owner, earlyItem, earlyMerged, splitItem, splitKept, reason: cls.reason });
    }
  }

  const bfRemovalPlanned = [];
  for (const act of actions) {
    const key = act.fileName.replace(/\.json$/, '');
    const rmScopes = act.type === 'single' ? act.deletes.map(d => d.scope) : act.type === 'split' ? [act.splitItem.scope] : [];
    for (const sc of rmScopes) {
      const bf = backfillByScope.get(sc);
      if (bf && typeof bf === 'object' && (bf[key] || bf.entries?.[key])) bfRemovalPlanned.push({ scope: sc, key });
    }
  }
  stats.removedBackfillKeys = bfRemovalPlanned.length;

  const projectedSeen = new Map();
  const addProjected = (userKey, records) => {
    for (const r of records) {
      const prev = projectedSeen.get(r.id);
      if (!prev || tokSum(r) > prev.tok) {
        projectedSeen.set(r.id, { at: r.at, userKey, tok: tokSum(r) });
      }
    }
  };
  const actedFiles = new Set(actions.map(a => a.fileName));
  for (const [fn, infos] of fileEntries.entries()) {
    if (infos.length === 1) addProjected(infos[0].scope.slice(0, 8), infos[0].records);
    else if (!actedFiles.has(fn)) {
      const uniq = new Map();
      for (const i of infos) for (const r of i.records) if (!uniq.has(r.id) || tokSum(r) > tokSum(uniq.get(r.id))) uniq.set(r.id, r);
      addProjected('legacy', [...uniq.values()]);
    }
  }
  for (const a of actions) {
    if (a.type === 'single') addProjected(a.owner.slice(0, 8), a.merged);
    else if (a.type === 'split') {
      addProjected(a.owner.slice(0, 8), a.earlyMerged);
      addProjected(a.splitItem.scope.slice(0, 8), a.splitKept);
    }
  }
  const projectedDays = new Map();
  for (const { at, userKey, tok } of projectedSeen.values()) {
    if (!Number.isFinite(at)) continue;
    const d = new Date(at + 8 * 3600 * 1000).toISOString().slice(0, 10);
    if (d < '2026-11-08') continue;
    if (!projectedDays.has(d)) projectedDays.set(d, {});
    const row = projectedDays.get(d);
    row[userKey] = (row[userKey] || 0) + tok;
  }
  const projectedRecentDays = [...projectedDays.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, users]) => ({
    date, total: Object.values(users).reduce((x, y) => x + y, 0), users
  }));

  let backupDir = null;
  let backupSummary = null;
  if (opts.apply) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupDir = join(dirname(opts.usageDir), `${basename(opts.usageDir)}.backup-${stamp}`);
    await cp(opts.usageDir, backupDir, { recursive: true });
    backupSummary = await new UsageLedger(backupDir).summary('all');

    const dirtyBackfills = new Set();
    for (const act of actions) {
      if (act.type === 'single') {
        const latestWinner = (await readJsonSafe(act.winnerItem.full)) || act.winnerItem.doc;
        const latestMerged = mergeRows([latestWinner.records || [], ...act.deletes.map(d => d.records), act.winnerItem.records]);
        if (JSON.stringify(latestWinner.records) !== JSON.stringify(latestMerged)) {
          await writeAtomic(act.winnerItem.full, { ...latestWinner, records: latestMerged });
        }
        for (const del of act.deletes) await rm(del.full, { force: true });
      } else if (act.type === 'split') {
        const latestEarly = (await readJsonSafe(act.earlyItem.full)) || act.earlyItem.doc;
        const earlyMerged = mergeRows([latestEarly.records || [], act.earlyMerged]);
        await writeAtomic(act.earlyItem.full, { ...latestEarly, records: earlyMerged });
        await writeAtomic(act.splitItem.full, { ...act.splitItem.doc, records: act.splitKept });
      }
    }
    for (const { scope: sc, key } of bfRemovalPlanned) {
      const bf = backfillByScope.get(sc);
      if (bf?.[key]) { delete bf[key]; dirtyBackfills.add(sc); }
      if (bf?.entries?.[key]) { delete bf.entries[key]; dirtyBackfills.add(sc); }
    }
    for (const s of dirtyBackfills) {
      await writeAtomic(join(opts.usageDir, s, 'backfill-v1.json'), backfillByScope.get(s));
    }
    const latestOwnership = (await readJsonSafe(ownershipFile)) || {};
    const mergedOwnership = { ...latestOwnership, ...nextOwnership };
    for (const [f, infos] of fileEntries.entries()) {
      if (infos.length > 1 && hasRecordOverlap(infos) && !actedFiles.has(f)) {
        const cid = uuidMap.get(f);
        if (cid) delete mergedOwnership[cid];
      }
    }
    await writeAtomic(ownershipFile, mergedOwnership);
  }

  const afterAll = opts.apply ? await new UsageLedger(opts.usageDir).summary('all') : null;
  const recentDays = (afterAll || beforeAll)?.days?.filter(d => d.date >= '2026-11-08').map(d => ({
    date: d.date, total: d.totalTokens ?? Object.values(d.models || {}).reduce((a, b) => a + b.total, 0),
    users: Object.fromEntries(Object.entries(d.users || {}).map(([k, v]) => [k.slice(0, 8), v.total]))
  }));

  const refBefore = backupSummary || beforeAll;
  const report = {
    mode: opts.apply ? 'apply' : 'dry-run',
    usageDir: opts.usageDir,
    backupDir,
    scopes,
    overlapFiles: [...fileEntries.values()].filter(v => v.length > 1 && hasRecordOverlap(v)).length,
    stats,
    before: { totalTokens: refBefore?.totalTokens, requests: refBefore?.requests, legacyTokens: refBefore?.legacyTokens, uniqueSumCheck: expectedUniqueTotal },
    after: afterAll ? { totalTokens: afterAll.totalTokens, requests: afterAll.requests, legacyTokens: afterAll.legacyTokens } : null,
    recentDaysBeforeOrAfter: recentDays,
    projectedRecentDays: opts.apply ? undefined : projectedRecentDays,
    splits: actions.filter(a => a.type === 'split').map(a => ({ fileName: a.fileName, convId: a.convId, early: a.owner.slice(0, 8), split: a.splitItem.scope.slice(0, 8), keptSplitRecords: a.splitKept.length })),
    ambiguousFiles: [...fileEntries.entries()].filter(([f, infos]) => infos.length > 1 && hasRecordOverlap(infos) && classifyOverlap(f, infos, meta, historyByScope, burstByScope).kind === 'ambiguous').map(([f, infos]) => ({ fileName: f, convId: uuidMap.get(f) || null, scopes: infos.map(i => ({ s: i.scope.slice(0, 8), inHistory: i.inHistory, maxAt: Number.isFinite(i.maxAt) ? new Date(i.maxAt).toISOString() : null, mtime: new Date(i.mtimeMs).toISOString() })) }))
  };

  console.log(JSON.stringify(report, null, 2));
  if (opts.apply && (afterAll.totalTokens < refBefore.totalTokens || afterAll.requests < refBefore.requests)) {
    throw Error(`Conservation check failed! before=${refBefore.totalTokens}/${refBefore.requests} after=${afterAll.totalTokens}/${afterAll.requests}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
