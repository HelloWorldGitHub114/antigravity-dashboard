import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolvePricingKey,
  resolveModelPricing,
  calculateBucketCost,
  summarizeSnapshotPeriodCosts,
  formatUsd,
  listConfigurablePricingRows,
} from '../metrics.mjs';
import { PreferencesStore } from '../../../compat/preferences.mjs';

test('resolvePricingKey normalizes variant suffixes and orchestrator names', () => {
  assert.equal(resolvePricingKey('Gemini 4 Neon (XHigh)'), 'gemini-4-neon');
  assert.equal(resolvePricingKey('Orchestrator (Neon)'), 'gemini-4-neon');
  assert.equal(resolvePricingKey('Gemini 4 Argon (Medium)'), 'gemini-4-argon');
  assert.equal(resolvePricingKey('Orchestrator (Argon)'), 'gemini-4-argon');
  assert.equal(resolvePricingKey('Gemini 4 Carbon (High)'), 'gemini-4-carbon');
  assert.equal(resolvePricingKey('Gemini 4 Hydrogen (Orchestrator)'), 'gemini-4-hydrogen');
  assert.equal(resolvePricingKey('gemini-3.8-flash-tiered'), 'gemini-3.8-flash');
  assert.equal(resolvePricingKey('Gemini 3.5 Flash Lite'), 'gemini-3.5-flash-lite');
  assert.equal(resolvePricingKey('Claude Opus 5.5 (High)'), 'claude-opus-5.5');
  assert.equal(resolvePricingKey('Claude Sonnet 5.5 (Medium)'), 'claude-sonnet-5.5');
  assert.equal(resolvePricingKey('GPT-OSS 120B (Medium)'), 'gpt-oss-120b');
});

test('calculateBucketCost applies 4-tier token rates and scheduled promo transitions', () => {
  // Gemini 4 Neon: $3 in / $0.15 cache read / $3.75 cache write / $15 out
  const neonCost = calculateBucketCost(
    'Gemini 4 Neon (XHigh)',
    { uncached: 1_000_000, cacheRead: 10_000_000, cacheWrite: 0, output: 200_000 },
    '2026-11-21',
  );
  // 3.00 + 1.50 + 3.00 = 7.50
  assert.ok(Math.abs((neonCost ?? 0) - 7.5) < 1e-6);

  // Gemini 4 Argon: Nov 30 intro ($2/$0.10/$10) vs Dec 1 standard ($4/$0.20/$20)
  const argonCounts = { uncached: 1_000_000, cacheRead: 5_000_000, cacheWrite: 0, output: 100_000 };
  const argonNov = calculateBucketCost('Gemini 4 Argon (Medium)', argonCounts, '2026-11-30');
  const argonDec = calculateBucketCost('Gemini 4 Argon (Medium)', argonCounts, '2026-12-01');
  assert.ok(Math.abs((argonNov ?? 0) - 3.5) < 1e-6);
  assert.ok(Math.abs((argonDec ?? 0) - 7.0) < 1e-6);

  // User override takes precedence over built-in pricing and handles unpriced models
  const customOverrides = {
    'gemini-4-argon': { input: 5, cacheRead: 0.5, cacheWrite: 5, output: 25 },
    'custom-model-x': { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 4 },
  };
  const argonOverride = calculateBucketCost('Gemini 4 Argon (Medium)', argonCounts, '2026-11-21', customOverrides);
  assert.ok(Math.abs((argonOverride ?? 0) - 10.0) < 1e-6);

  const unpriced = calculateBucketCost('Custom Model X (High)', argonCounts, '2026-11-21');
  assert.equal(unpriced, null);
  const customPriced = calculateBucketCost('Custom Model X (High)', argonCounts, '2026-11-21', customOverrides);
  assert.ok(Math.abs((customPriced ?? 0) - 1.9) < 1e-6);
  assert.equal(resolveModelPricing('Custom Model X', '2026-11-21', customOverrides)?.source, 'override');
});

test('summarizeSnapshotPeriodCosts and formatUsd compute period totals cleanly', () => {
  const snapshot = {
    today: '2026-11-21', // Saturday, week starts Monday 2026-11-16
    unknownTokens: 1000,
    days: [
      {
        date: '2026-10-15', // prior month -> total only
        models: {
          'Gemini 4 Neon (XHigh)': { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0, total: 1_000_000, requests: 1 },
        },
      },
      {
        date: '2026-11-05', // same month, prior week -> month + total
        models: {
          'Claude Sonnet 5.5 (Medium)': { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0, total: 1_000_000, requests: 1 },
        },
      },
      {
        date: '2026-11-18', // same week -> week + month + total
        models: {
          'Gemini 4 Hydrogen (High)': { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0, total: 1_000_000, requests: 1 },
        },
      },
      {
        date: '2026-11-21', // today -> today + week + month + total
        models: {
          'Gemini 4 Neon (XHigh)': { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0, total: 1_000_000, requests: 1 },
          'Mystery Unpriced Model': { uncached: 500, cacheRead: 0, cacheWrite: 0, output: 0, total: 500, requests: 1 },
        },
      },
    ],
  };

  const costs = summarizeSnapshotPeriodCosts(snapshot);
  assert.ok(Math.abs(costs.today.costUsd - 3.0) < 1e-6);
  assert.equal(costs.today.hasUnpriced, true);
  assert.ok(Math.abs(costs.week.costUsd - 4.5) < 1e-6);
  assert.ok(Math.abs(costs.month.costUsd - 6.5) < 1e-6);
  assert.ok(Math.abs(costs.total.costUsd - 9.5) < 1e-6);
  assert.equal(costs.total.unpricedTokens, 1500);

  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.002), '<$0.01');
  assert.equal(formatUsd(0.002, { precise: true }), '$0.002');
  assert.equal(formatUsd(44.0612, { approx: true }), '≈ $44.06');

  const rows = listConfigurablePricingRows(['Gemini 4 Neon (XHigh)', 'Mystery Unpriced Model'], {}, '2026-11-21');
  assert.ok(rows.some((r) => r.key === 'gemini-4-neon' && r.builtin));
  assert.ok(rows.some((r) => r.key === 'mystery-unpriced-model' && !r.builtin));
});

test('PreferencesStore validates, persists, and resets modelPricingOverrides', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-pulse-pref-price-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = new PreferencesStore({ file: join(dir, 'preferences.json') });
  const initial = await store.get();
  assert.equal(initial.modelPricingOverrides, undefined);

  const saved = await store.set({
    modelPricingOverrides: {
      'gemini-4-neon': { input: 3.5, cacheRead: 0.2, cacheWrite: 4.0, output: 16.0 },
    },
  });
  assert.deepEqual(saved.modelPricingOverrides, {
    'gemini-4-neon': { input: 3.5, cacheRead: 0.2, cacheWrite: 4, output: 16 },
  });

  // Reload from disk with a fresh instance
  const reloaded = await new PreferencesStore({ file: join(dir, 'preferences.json') }).get();
  assert.deepEqual(reloaded.modelPricingOverrides, saved.modelPricingOverrides);

  // Reject invalid rates
  await assert.rejects(
    () => store.set({ modelPricingOverrides: { bad: { input: -1, cacheRead: 0, output: 1 } } }),
    /Invalid model pricing preference/,
  );

  // Reset to empty clears overrides (omitted from state for backward compatibility)
  const cleared = await store.set({ modelPricingOverrides: {} });
  assert.equal(cleared.modelPricingOverrides, undefined);
});
