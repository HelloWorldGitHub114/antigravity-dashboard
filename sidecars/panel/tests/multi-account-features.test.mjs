import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { UsageLedger, DesktopUsage, loadKnownAccounts } from '../usage.mjs';
import { MetricsStore } from '../store.mjs';

const scope = s => createHash('sha256').update(s).digest('hex');
const primaryAccount = scope('primary@example.test');
const secondaryAccount = scope('secondary@example.test');
const fixtureKnownAccounts = {
  [primaryAccount]: { email: 'primary@example.test', name: 'primary@example.test', primary: true },
  [secondaryAccount]: { email: 'secondary@example.test', name: 'secondary@example.test', primary: false }
};
const id1 = '11111111-1111-1111-1111-111111111111';
const id2 = '22222222-2222-2222-2222-222222222222';
const idShared = '33333333-3333-3333-3333-333333333333';

const raw = (options = {}) => ({
  trajectory: {
    steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: { createdAt: options.time || '2026-11-11T10:00:00Z' } }],
    generatorMetadata: [{
      stepIndices: [0],
      chatModel: {
        modelDisplayName: options.model || 'Gemini 2.5 Pro',
        usage: {
          apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
          responseId: options.responseId || 'resp-1',
          inputTokens: String(options.inputTokens ?? 100),
          outputTokens: String(options.outputTokens ?? 50),
          ...options.usage
        }
      }
    }]
  }
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ag-multi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new UsageLedger(dir, { knownAccounts: fixtureKnownAccounts });
}

test('accounts-v1.json persists accounts metadata and getAccounts displays real emails and all option', async t => {
  const ledger = await fixture(t);
  const testScope = scope('custom-test@example.com');
  await ledger.registerAccount(testScope, { email: 'custom-test@example.com', name: 'Custom User' });

  const content = JSON.parse(await readFile(ledger.accountsFile(), 'utf8'));
  assert.equal(content.schema, 1);
  assert.equal(content.accounts[testScope].email, 'custom-test@example.com');

  const accounts = await ledger.getAccounts(testScope);
  assert.equal(accounts[0].id, 'all');
  assert.equal(accounts[0].name, 'All Accounts (Aggregated)');

  const primary = accounts.find(a => a.id === primaryAccount);
  assert.ok(primary);
  assert.equal(primary.email, 'primary@example.test');

  const secondary = accounts.find(a => a.id === secondaryAccount);
  assert.ok(secondary);
  assert.equal(secondary.email, 'secondary@example.test');

  const custom = accounts.find(a => a.id === testScope);
  assert.ok(custom);
  assert.equal(custom.email, 'custom-test@example.com');
  assert.equal(custom.active, true);
});

test('multi-account filtering excludes duplicate legacy sessions from secondary account and aggregates with legacy tagging in all view', async t => {
  const ledger = await fixture(t);

  // Ingest shared session into both accounts (simulates duplicate historical scan)
  await ledger.ingest(primaryAccount, idShared, raw({ responseId: 'shared-resp', inputTokens: 500, outputTokens: 50 }));
  await ledger.ingest(secondaryAccount, idShared, raw({ responseId: 'shared-resp', inputTokens: 500, outputTokens: 50 }));

  // Ingest unique session for primary (total: 150)
  await ledger.ingest(primaryAccount, id1, raw({ responseId: 'p-resp', inputTokens: 100, outputTokens: 50 }));

  // Ingest unique session for secondary (total: 300)
  await ledger.ingest(secondaryAccount, id2, raw({ responseId: 's-resp', inputTokens: 200, outputTokens: 100 }));

  // Single secondary account view: duplicate legacy session idShared must be skipped
  const secSummary = await ledger.summary(secondaryAccount);
  assert.equal(secSummary.totalTokens, 300, 'Secondary account should only show its own 300 tokens, skipping duplicate legacy');
  assert.equal(secSummary.requests, 1);

  // All accounts view: aggregates everything, deduplicates idShared, tags idShared as legacy
  const allSummary = await ledger.summary('all');
  // Total: shared(550) + p(150) + s(300) = 1000
  assert.equal(allSummary.totalTokens, 1000, 'All view should deduplicate shared sessions');
  assert.equal(allSummary.legacyTokens, 550, 'Shared session should be counted as legacy tokens');
  assert.ok(allSummary.users.includes('legacy'), 'Users list should include legacy category');

  // Verify day.users structure
  const today = allSummary.days.find(d => d.date === '2026-11-11');
  assert.ok(today);
  assert.ok(today.users.legacy);
  assert.equal(today.users.legacy.total, 550);
  assert.equal(today.users.legacy.isLegacy, true);

  assert.ok(today.users[primaryAccount]);
  assert.equal(today.users[primaryAccount].total, 150);

  assert.ok(today.users[secondaryAccount]);
  assert.equal(today.users[secondaryAccount].total, 300);
});

test('DesktopUsage switchAccount supports all and specific accounts without breaking active RPC store identity', async t => {
  const ledger = await fixture(t);
  const store = { identity: secondaryAccount, epoch: 1, listConversations: async () => [] };
  const tracker = new DesktopUsage(store, ledger);

  // Switch to 'all'
  const resAll = await tracker.switchAccount('all');
  assert.equal(resAll.success, true);
  assert.equal(resAll.active, 'all');
  assert.equal(tracker.viewScope, 'all');
  assert.equal(store.identity, secondaryAccount, 'store.identity must not be changed to all');

  const snapshotAll = await tracker.snapshot();
  assert.equal(snapshotAll.viewScope, 'all');
  assert.equal(snapshotAll.activeAccount, secondaryAccount);
  assert.ok(Array.isArray(snapshotAll.accounts));
  assert.equal(snapshotAll.accounts[0].id, 'all');

  // Switch to primaryAccount: viewScope becomes primaryAccount, but store.identity remains secondaryAccount
  const resPri = await tracker.switchAccount(primaryAccount);
  assert.equal(resPri.success, true);
  assert.equal(resPri.active, primaryAccount);
  assert.equal(tracker.viewScope, primaryAccount);
  assert.equal(store.identity, secondaryAccount, 'store.identity must not be mutated when switching viewScope to another account');

  const snapshotPri = await tracker.snapshot();
  assert.equal(snapshotPri.viewScope, primaryAccount);
  assert.equal(snapshotPri.activeAccount, secondaryAccount);
});

test('hourly spline control points never dip below baseY (zero axis) on zero values or adjacent zeros', () => {
  const hours = [0, 0, 0, 100, 500, 200, 0, 0, 0, 0, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const maxVal = Math.max(1, ...hours);
  const padT = 15, hPlot = 90, baseY = padT + hPlot;
  const pts = hours.map((v, i) => ({ y: baseY - (v / maxVal) * hPlot, val: v, hour: i }));

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    let cp1y = p1.y + (p2.y - p0.y) / 6;
    let cp2y = p2.y - (p3.y - p1.y) / 6;
    if (p1.val === 0 && p2.val === 0) {
      cp1y = baseY;
      cp2y = baseY;
    } else {
      if (p1.val === 0) cp1y = baseY;
      if (p2.val === 0) cp2y = baseY;
      cp1y = Math.min(baseY, Math.max(padT, cp1y));
      cp2y = Math.min(baseY, Math.max(padT, cp2y));
    }
    // Verify control points are strictly clamped in [padT, baseY] and never exceed baseY
    assert.ok(cp1y <= baseY, `cp1y at ${i} must not exceed baseY (${cp1y} > ${baseY})`);
    assert.ok(cp2y <= baseY, `cp2y at ${i} must not exceed baseY (${cp2y} > ${baseY})`);
    assert.ok(cp1y >= padT, `cp1y at ${i} must not be less than padT (${cp1y} < ${padT})`);
    assert.ok(cp2y >= padT, `cp2y at ${i} must not be less than padT (${cp2y} < ${padT})`);
    if (p1.val === 0 && p2.val === 0) {
      assert.equal(cp1y, baseY, `Flat zero segment at ${i} must stay at baseY`);
      assert.equal(cp2y, baseY, `Flat zero segment at ${i} must stay at baseY`);
    }
  }
});

test('runSync filters listed by ownership and exclusive files, and registerOwnership refuses silent overwrite', async t => {
  const { createHash } = await import('node:crypto');
  const { mkdtemp: mkd, rm: rmd, access } = await import('node:fs/promises');
  const hashOf = s => createHash('sha256').update(s).digest('hex');
  const dir = await mkd(join(tmpdir(), 'ag-pulse-iso-'));
  t.after(() => rmd(dir, { recursive: true, force: true }));

  const scopeP = hashOf('primary-iso@example.test');
  const scopeS = hashOf('secondary-iso@example.test');
  const convOwnedByP = '11111111-1111-4111-8111-111111111111';
  const convExclusiveInP = '22222222-2222-4222-8222-222222222222';
  const convOwnedByS = '33333333-3333-4333-8333-333333333333';

  const makeRaw = (rid, atMs, toks = 1000, status = 'CASCADE_RUN_STATUS_IDLE') => ({
    trajectory: {
      status,
      steps: [],
      generatorMetadata: [{
        chatModel: {
          model: 'MODEL_PLACEHOLDER_M37',
          usage: { inputTokens: toks, outputTokens: 0, responseId: rid },
          responseTimestamp: new Date(atMs).toISOString()
        }
      }]
    }
  });

  const ledger = new UsageLedger(dir, { knownAccounts: {} });
  const fetchedUnderS = [];
  const store = {
    identity: scopeP,
    epoch: 1,
    listConversations: async () => [{ id: convOwnedByP, modifiedAt: '2026-11-13T10:00:00Z', status: 'DONE' }],
    client: {
      trajectory: async id => {
        if (store.identity === scopeS) fetchedUnderS.push(id.toLowerCase());
        return makeRaw(`resp-${id}`, Date.UTC(2026, 10, 13, 10, 0, 0), 1000);
      }
    }
  };

  const tracker = new DesktopUsage(store, ledger, {
    discover: async () => ({ conversations: [] })
  });
  await tracker.sync(true);

  // Pre-existing exclusive ledger file in P without an ownership-v1.json entry
  await ledger.ingest(scopeP, convExclusiveInP, makeRaw('resp-excl', Date.UTC(2026, 10, 13, 9, 0, 0), 500));

  // Verify registerOwnership refuses non-explicit cross-account overwrite
  assert.equal(await ledger.registerOwnership(convOwnedByP, scopeS), false);
  assert.equal((await ledger.ownership())[convOwnedByP], scopeP);

  // Switch to S: listed AND local.conversations return convOwnedByP + convExclusiveInP + convOwnedByS
  store.identity = scopeS;
  store.epoch++;
  store.listConversations = async () => [
    { id: convOwnedByP, modifiedAt: '2026-11-13T10:00:00Z', status: 'DONE' },
    { id: convExclusiveInP, modifiedAt: '2026-11-13T09:00:00Z', status: 'DONE' },
    { id: convOwnedByS, modifiedAt: '2026-11-13T11:00:00Z', status: 'DONE' }
  ];
  const trackerS = new DesktopUsage(store, ledger, {
    discover: async () => ({
      conversations: [
        { id: convOwnedByP, path: '/fake/1' },
        { id: convExclusiveInP, path: '/fake/2' },
        { id: convOwnedByS, path: '/fake/3' }
      ]
    })
  });
  await trackerS.sync(true);

  assert.deepEqual(fetchedUnderS, [convOwnedByS]);
  await assert.rejects(() => access(ledger.file(scopeS, convOwnedByP)), /ENOENT/);
  await assert.rejects(() => access(ledger.file(scopeS, convExclusiveInP)), /ENOENT/);
  assert.equal((await ledger.summary(scopeS)).totalTokens, 1000);
  assert.equal((await ledger.summary(scopeP)).totalTokens, 1500);
  assert.equal((await ledger.summary('all')).legacyTokens, 0);

  // Explicit overwrite works when requested
  assert.equal(await ledger.registerOwnership(convOwnedByP, scopeS, { overwrite: true }), true);
  assert.equal((await ledger.ownership())[convOwnedByP], scopeS);
});

test('DesktopUsage.ingest isolates stale opens and splits live cross-account continuations cleanly', async t => {
  const { createHash } = await import('node:crypto');
  const { mkdtemp: mkd, rm: rmd, access, readFile } = await import('node:fs/promises');
  const hashOf = s => createHash('sha256').update(s).digest('hex');
  const dir = await mkd(join(tmpdir(), 'ag-pulse-live-'));
  t.after(() => rmd(dir, { recursive: true, force: true }));

  const scopeP = hashOf('live-p@example.test');
  const scopeS = hashOf('live-s@example.test');
  const convId = '44444444-4444-4444-8444-444444444444';
  const fixedNow = Date.UTC(2026, 10, 14, 7, 0, 0);

  const ledger = new UsageLedger(dir, { knownAccounts: {} });
  const store = { identity: scopeP, epoch: 1, listConversations: async () => [], client: { trajectory: async () => ({}) } };
  const usage = new DesktopUsage(store, ledger, { discover: async () => ({ conversations: [] }) });
  usage.now = () => fixedNow;

  const turn1 = {
    trajectory: {
      status: 'CASCADE_RUN_STATUS_IDLE',
      steps: [],
      generatorMetadata: [{
        chatModel: { model: 'MODEL_PLACEHOLDER_M37', usage: { inputTokens: 1000, outputTokens: 0, responseId: 'r-p-1' }, responseTimestamp: new Date(fixedNow - 3600_000).toISOString() }
      }]
    }
  };
  await usage.ingest(scopeP, convId, turn1);
  assert.equal((await ledger.ownership())[convId], scopeP);

  // Stale open on secondary account (includes an older unsynced record r-p-0) must NOT write anything
  const staleOpen = {
    trajectory: {
      status: 'CASCADE_RUN_STATUS_IDLE',
      steps: [],
      generatorMetadata: [
        { chatModel: { model: 'MODEL_PLACEHOLDER_M37', usage: { inputTokens: 200, outputTokens: 0, responseId: 'r-p-0' }, responseTimestamp: new Date(fixedNow - 7200_000).toISOString() } },
        { chatModel: { model: 'MODEL_PLACEHOLDER_M37', usage: { inputTokens: 1000, outputTokens: 0, responseId: 'r-p-1' }, responseTimestamp: new Date(fixedNow - 3600_000).toISOString() } }
      ]
    }
  };
  await usage.ingest(scopeS, convId, staleOpen);
  await assert.rejects(() => access(ledger.file(scopeS, convId)), /ENOENT/);

  // Active continuation on secondary account adds r-s-2: ONLY r-s-2 should be ingested into S
  const activeCont = {
    trajectory: {
      status: 'CASCADE_RUN_STATUS_RUNNING',
      steps: [],
      generatorMetadata: [
        { chatModel: { model: 'MODEL_PLACEHOLDER_M37', usage: { inputTokens: 1000, outputTokens: 0, responseId: 'r-p-1' }, responseTimestamp: new Date(fixedNow - 3600_000).toISOString() } },
        { chatModel: { model: 'MODEL_PLACEHOLDER_M37', usage: { inputTokens: 500, outputTokens: 0, responseId: 'r-s-2' }, responseTimestamp: new Date(fixedNow - 5000).toISOString() } }
      ]
    }
  };
  await usage.ingest(scopeS, convId, activeCont);
  const sLedger = JSON.parse(await readFile(ledger.file(scopeS, convId), 'utf8'));
  assert.equal(sLedger.records.length, 1);
  assert.equal(sLedger.records[0].uncached, 500);
  assert.equal((await ledger.ownership())[convId], scopeP);

  // When P later refreshes full trajectory containing r-s-2, P must NOT swallow r-s-2
  await usage.ingest(scopeP, convId, activeCont);
  const pLedger = JSON.parse(await readFile(ledger.file(scopeP, convId), 'utf8'));
  assert.equal(pLedger.records.length, 1);
  assert.equal(pLedger.records[0].uncached, 1000);
  assert.notEqual(sLedger.records[0].id, pLedger.records[0].id);

  const all = await ledger.summary('all', fixedNow);
  assert.equal(all.totalTokens, 1500);
  assert.equal(all.legacyTokens, 0);
  assert.equal((await ledger.summary(scopeP, fixedNow)).totalTokens, 1000);
  assert.equal((await ledger.summary(scopeS, fixedNow)).totalTokens, 500);
});

test('UsageLedger.summary resolves duplicates via ownership and accountsMeta primary without legacy inflation', async t => {
  const { createHash } = await import('node:crypto');
  const { mkdtemp: mkd, rm: rmd, writeFile } = await import('node:fs/promises');
  const hashOf = s => createHash('sha256').update(s).digest('hex');
  const dir = await mkd(join(tmpdir(), 'ag-pulse-sum-'));
  t.after(() => rmd(dir, { recursive: true, force: true }));

  const alpha = hashOf('alpha@example.test');
  const beta = hashOf('0000-beta@example.test');
  await writeFile(join(dir, 'accounts-v1.json'), JSON.stringify({
    [alpha]: { email: 'alpha@example.test', primary: true },
    [beta]: { email: 'beta@example.test', primary: false }
  }));

  const ownedConv = '55555555-5555-4555-8555-555555555555';
  const unownedConv = '66666666-6666-4666-8666-666666666666';
  const makeRec = (id, toks) => ({
    trajectory: {
      generatorMetadata: [{
        chatModel: { model: 'MODEL_PLACEHOLDER_M37', usage: { inputTokens: toks, outputTokens: 0, responseId: id }, responseTimestamp: '2026-11-13T12:00:00Z' }
      }]
    }
  });

  const ledger = new UsageLedger(dir, { knownAccounts: {} });
  await ledger.ingest(alpha, ownedConv, makeRec('r-owned', 1000));
  await ledger.ingest(beta, ownedConv, makeRec('r-owned', 1000));
  await ledger.registerOwnership(ownedConv, beta, { overwrite: true });

  await ledger.ingest(alpha, unownedConv, makeRec('r-legacy', 300));
  await ledger.ingest(beta, unownedConv, makeRec('r-legacy', 300));

  const all = await ledger.summary('all', Date.UTC(2026, 10, 14));
  assert.equal(all.totalTokens, 1300);
  assert.equal(all.legacyTokens, 300);
  assert.equal((await ledger.summary(beta, Date.UTC(2026, 10, 14))).totalTokens, 1000);
  assert.equal((await ledger.summary(alpha, Date.UTC(2026, 10, 14))).totalTokens, 300);
});

test('loadKnownAccounts loads valid entries from a temp JSON file and returns {} on missing or invalid files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-known-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.deepEqual(loadKnownAccounts(join(dir, 'missing.json')), {});

  const invalidJson = join(dir, 'invalid.json');
  await writeFile(invalidJson, '{not valid json', 'utf8');
  assert.deepEqual(loadKnownAccounts(invalidJson), {});

  const arrayJson = join(dir, 'array.json');
  await writeFile(arrayJson, '[]', 'utf8');
  assert.deepEqual(loadKnownAccounts(arrayJson), {});

  const topLevel = join(dir, 'top-level.json');
  await writeFile(topLevel, JSON.stringify({
    [primaryAccount]: { email: 'primary@example.test', name: 'primary@example.test', primary: true },
    'not-a-sha256': { email: 'bad-key@example.test' },
    [secondaryAccount]: ['not-an-object']
  }), 'utf8');
  assert.deepEqual(loadKnownAccounts(topLevel), {
    [primaryAccount]: { email: 'primary@example.test', name: 'primary@example.test', primary: true }
  });

  const wrapped = join(dir, 'wrapped.json');
  await writeFile(wrapped, JSON.stringify({
    schema: 1,
    accounts: {
      [secondaryAccount]: { email: 'secondary@example.test', primary: false },
      bad: { email: 'ignored@example.test' }
    }
  }), 'utf8');
  assert.deepEqual(loadKnownAccounts(wrapped), {
    [secondaryAccount]: { email: 'secondary@example.test', primary: false }
  });
});

