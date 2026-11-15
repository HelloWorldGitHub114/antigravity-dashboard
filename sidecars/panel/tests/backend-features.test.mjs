import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { UsageLedger, DesktopUsage, dateKey, hourKey, dateTimeParts, addManualUsage, deleteManualUsage } from '../usage.mjs';
import { MetricsStore } from '../store.mjs';
import { RuntimeUi, makeRendererSource } from '../../../compat/runtime-ui.mjs';
import installAgPulseIpc from '../../../compat/ipc-host.cjs';
import { runInNewContext } from 'node:vm';

const hash = v => createHash('sha256').update(v).digest('hex');
const accountA = hash('account-a@example.com');
const accountB = hash('account-b@example.com');

async function makeTempDir() {
  return await mkdtemp(join(tmpdir(), 'ag-test-backend-'));
}

test('hourly aggregation computes 0-23 hours and todayHours based on timeZone', async t => {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const ledger = new UsageLedger(dir, { timeZone: 'Asia/Shanghai' });

  // 2026-11-11T02:30:00Z is 2026-11-11 10:30:00 in Asia/Shanghai (Hour 10)
  // 2026-11-11T06:15:00Z is 2026-11-11 14:15:00 in Asia/Shanghai (Hour 14)
  const t1 = Date.parse('2026-11-11T02:30:00Z');
  const t2 = Date.parse('2026-11-11T06:15:00Z');

  assert.equal(dateTimeParts(t1, 'Asia/Shanghai').hour, 10);
  assert.equal(dateTimeParts(t2, 'Asia/Shanghai').hour, 14);

  // Ingest manual usages or raw records
  await ledger.addManualUsage(accountA, {
    timestamp: t1,
    model: 'gemini-2.5-pro',
    tokens: { prompt: 100, candidates: 50, total: 150 }
  });

  await ledger.addManualUsage(accountA, {
    timestamp: t2,
    model: 'gemini-2.5-pro',
    tokens: { prompt: 200, candidates: 80, total: 280 }
  });

  const summary = await ledger.summary(accountA, Date.parse('2026-11-11T12:00:00Z'));
  assert.ok(summary);
  assert.equal(summary.today, '2026-11-11');
  assert.equal(summary.todayHours.length, 24);
  assert.equal(summary.todayHours[10], 150);
  assert.equal(summary.todayHours[14], 280);
  assert.equal(summary.todayHours[0], 0);

  const day = summary.days.find(d => d.date === '2026-11-11');
  assert.ok(day);
  assert.equal(day.hours.length, 24);
  assert.equal(day.hours[10], 150);
  assert.equal(day.hours[14], 280);
  assert.equal(day.hours[1], 0);
});

test('multi-account isolation maintains ownership-v1.json and skips foreign conversations', async t => {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const ledger = new UsageLedger(dir);
  const conv1 = '11111111-1111-1111-1111-111111111111';
  const conv2 = '22222222-2222-2222-2222-222222222222';

  // Initially register conv1 to accountA
  await ledger.registerOwnership(conv1, accountA);
  const initialRegistry = await ledger.ownership();
  assert.equal(initialRegistry[conv1], accountA);

  const calls = [];
  const fakeStoreB = {
    identity: accountB,
    epoch: 1,
    listConversations: async () => [],
    client: {
      trajectory: async id => {
        calls.push(id);
        return {
          trajectory: {
            steps: [{ type: 'PLANNER_RESPONSE', metadata: { createdAt: '2026-11-11T00:00:00Z' } }],
            generatorMetadata: [{
              chatModel: { model: 'test-model', usage: { inputTokens: 50, outputTokens: 25 } },
              stepIndices: [0]
            }]
          }
        };
      }
    }
  };

  // discoverLocal returns both conv1 (owned by accountA) and conv2 (unowned)
  const discoverLocal = async () => ({
    conversations: [
      { id: conv1, signature: 'sig1' },
      { id: conv2, signature: 'sig2' }
    ]
  });

  const desktopB = new DesktopUsage(fakeStoreB, ledger, { discoverLocal, host: 'app' });
  await desktopB.sync(true);

  // conv1 should be skipped because it belongs to accountA!
  // Only conv2 should have been imported!
  assert.ok(!calls.includes(conv1), 'conv1 owned by accountA must NOT be imported by accountB');
  assert.ok(calls.includes(conv2), 'conv2 unowned should be imported by accountB');

  // Verify ownership registry updated conv2 to accountB
  const updatedRegistry = await ledger.ownership();
  assert.equal(updatedRegistry[conv1], accountA);
  assert.equal(updatedRegistry[conv2], accountB);

  // Also verify file on disk matches ownership-v1.json format
  const diskContent = JSON.parse(await readFile(join(dir, 'ownership-v1.json'), 'utf8'));
  assert.equal(diskContent[conv1], accountA);
  assert.equal(diskContent[conv2], accountB);
});

test('remote project manual usage creates hashed json file and delete removes it', async t => {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const ledger = new UsageLedger(dir);
  const now = Date.parse('2026-11-11T08:00:00Z');

  const added = await ledger.addManualUsage(accountA, {
    timestamp: now,
    model: 'gemini-2.5-flash',
    tokens: { prompt: 500, candidates: 250, total: 750 },
    projectName: 'Remote-Work-X',
    note: 'Initial import of remote experiment'
  });

  assert.ok(added.id);
  assert.ok(added.hash);
  assert.match(added.file, /^[a-f0-9]{64}\.json$/);
  assert.equal(added.source, 'remote-manual');
  assert.equal(added.model, 'gemini-2.5-flash');
  assert.equal(added.projectName, 'Remote-Work-X');

  // Verify file on disk
  const filePath = join(dir, accountA, added.file);
  const content = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(content.schema, 1);
  assert.equal(content.account, accountA);
  assert.equal(content.metadata.source, 'remote-manual');
  assert.equal(content.metadata.projectName, 'Remote-Work-X');
  assert.equal(content.records[0].uncached, 500);
  assert.equal(content.records[0].output, 250);

  // Verify summary includes manual tokens
  let summary = await ledger.summary(accountA, now);
  assert.equal(summary.totalTokens, 750);
  assert.equal(summary.manualEntries.length, 1);
  assert.equal(summary.manualEntries[0].projectName, 'Remote-Work-X');

  // Delete manual usage using the generated UUID id
  const deleted = await ledger.deleteManualUsage(accountA, added.id);
  assert.equal(deleted, true);

  // Verify file removed
  const files = await readdir(join(dir, accountA));
  assert.ok(!files.includes(added.file));

  // Verify summary refreshed
  summary = await ledger.summary(accountA, now);
  assert.equal(summary.totalTokens, 0);
  assert.equal(summary.manualEntries.length, 0);
});

test('runtime-ui bridge exposes manual usage and account APIs to renderer and handles events', async t => {
  const window = {};
  window.top = window;
  const source = makeRendererSource('module.exports = function(){return {};};', 'module.exports = function(){};');
  runInNewContext(source, { window, setTimeout, clearTimeout });

  assert.ok(window.agPulseHost);
  assert.ok(window.agPulseBridge);
  assert.equal(typeof window.agPulseHost.addManualUsage, 'function');
  assert.equal(typeof window.agPulseHost.deleteManualUsage, 'function');
  assert.equal(typeof window.agPulseHost.getAccounts, 'function');
  assert.equal(typeof window.agPulseHost.switchAccount, 'function');

  // Test RuntimeUi.event handling
  let addCalled = null, deleteCalled = null, getAccountsCalled = false, switchCalled = null;
  const ui = new RuntimeUi({
    addManualUsage: async input => { addCalled = input; return { success: true, id: 'test-123' }; },
    deleteManualUsage: async input => { deleteCalled = input; return { success: true }; },
    getAccounts: async () => { getAccountsCalled = true; return [{ id: accountA, active: true }]; },
    switchAccount: async input => { switchCalled = input; return { success: true, active: input.account }; }
  });

  const connection = {
    contexts: new Set([1]),
    inflight: 0,
    commands: [],
    async command(method, params) {
      this.commands.push({ method, params });
      return {};
    }
  };

  // Simulate binding called for addManualUsage
  await ui.event(connection, {
    method: 'Runtime.bindingCalled',
    params: {
      name: ui.binding,
      executionContextId: 1,
      payload: JSON.stringify({
        id: 101,
        type: 'addManualUsage',
        input: { scope: accountA, projectName: 'Project Z', tokens: { prompt: 10 } }
      })
    }
  });

  assert.ok(addCalled);
  assert.equal(addCalled.projectName, 'Project Z');
  assert.ok(connection.commands.some(c => c.params.expression?.includes('test-123')));

  // Simulate binding called for deleteManualUsage
  await ui.event(connection, {
    method: 'Runtime.bindingCalled',
    params: {
      name: ui.binding,
      executionContextId: 1,
      payload: JSON.stringify({
        id: 102,
        type: 'deleteManualUsage',
        input: { scope: accountA, id: 'test-123' }
      })
    }
  });

  assert.ok(deleteCalled);
  assert.equal(deleteCalled.id, 'test-123');

  // Simulate binding called for getAccounts
  await ui.event(connection, {
    method: 'Runtime.bindingCalled',
    params: {
      name: ui.binding,
      executionContextId: 1,
      payload: JSON.stringify({
        id: 103,
        type: 'getAccounts',
        input: {}
      })
    }
  });

  assert.equal(getAccountsCalled, true);

  // Simulate binding called for switchAccount
  await ui.event(connection, {
    method: 'Runtime.bindingCalled',
    params: {
      name: ui.binding,
      executionContextId: 1,
      payload: JSON.stringify({
        id: 104,
        type: 'switchAccount',
        input: { account: accountB }
      })
    }
  });

  assert.ok(switchCalled);
  assert.equal(switchCalled.account, accountB);
});

test('ipc-host registers add-manual-usage, delete-manual-usage, get-accounts, switch-account handlers', async () => {
  const handlers = new Map();
  const fakeElectron = {
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn),
      on: () => {}
    }
  };

  installAgPulseIpc(fakeElectron, []);

  assert.ok(handlers.has('ag-pulse:add-manual-usage'));
  assert.ok(handlers.has('ag-pulse:addManualUsage'));
  assert.ok(handlers.has('ag-pulse:delete-manual-usage'));
  assert.ok(handlers.has('ag-pulse:deleteManualUsage'));
  assert.ok(handlers.has('ag-pulse:get-accounts'));
  assert.ok(handlers.has('ag-pulse:getAccounts'));
  assert.ok(handlers.has('ag-pulse:switch-account'));
  assert.ok(handlers.has('ag-pulse:switchAccount'));

  // Test switchAccount handler
  const switchFn = handlers.get('ag-pulse:switch-account');
  const fakeEvent = { senderFrame: { url: 'http://127.0.0.1:5000/app' } };
  const res = await switchFn(fakeEvent, { account: accountA });
  assert.deepEqual(res, { success: true, active: accountA, activeAccount: accountA });
});
