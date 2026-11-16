import test from 'node:test';
import assert from 'node:assert/strict';
import { LazyVertexController } from '../../../src/telemetry/lazy-vertex.ts';
import { HostLivenessWatchdog } from '../../../src/telemetry/host-watchdog.ts';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeInstance(counts) {
  const store = {
    timelineEnabled: false,
    setModelTimelineEnabled(enabled) {
      this.timelineEnabled = enabled;
    },
    dispose() {
      counts.storeDisposed++;
    },
  };
  const usage = {
    dispose() {
      counts.usageDisposed++;
    },
  };
  const integration = {
    sessions: new Map(),
    started: false,
    stopped: false,
    start() {
      this.started = true;
      counts.integrationStarted++;
    },
    async stop() {
      this.stopped = true;
      counts.integrationStopped++;
    },
  };
  return { store, usage, integration };
}

test('LazyVertexController stays dormant until triggered and singleflights concurrent ensureStarted calls', async (t) => {
  const counts = {
    created: 0,
    storeDisposed: 0,
    usageDisposed: 0,
    integrationStarted: 0,
    integrationStopped: 0,
  };
  let releaseCreate = null;
  const gate = new Promise((resolve) => {
    releaseCreate = resolve;
  });

  const controller = new LazyVertexController({
    idleTtlMs: 5000,
    probeIntervalMs: 0,
    probeActive: async () => false,
    createInstance: async () => {
      counts.created++;
      await gate;
      return createFakeInstance(counts);
    },
  });
  t.after(() => controller.dispose());

  controller.start();
  assert.equal(controller.getState(), 'dormant');
  assert.equal(controller.getInstance(), null);
  assert.equal(controller.getStore(), null);
  assert.equal(controller.getUsage(), null);
  assert.equal(controller.getIntegration(), null);
  assert.equal(counts.created, 0);

  const p1 = controller.ensureStarted('query-1');
  const p2 = controller.ensureStarted('query-2');
  const p3 = controller.touch('query-3');
  assert.equal(controller.getState(), 'starting');

  releaseCreate();
  const [i1, i2, i3] = await Promise.all([p1, p2, p3]);

  assert.equal(counts.created, 1);
  assert.equal(counts.integrationStarted, 1);
  assert.equal(controller.getState(), 'active');
  assert.ok(i1);
  assert.equal(i1, i2);
  assert.equal(i1, i3);
  assert.equal(controller.getInstance(), i1);
});

test('LazyVertexController touch resets idle timer and auto-disposes back to dormant after idleTtlMs', async (t) => {
  const counts = {
    created: 0,
    storeDisposed: 0,
    usageDisposed: 0,
    integrationStarted: 0,
    integrationStopped: 0,
  };
  let clock = 1000;
  const controller = new LazyVertexController({
    idleTtlMs: 60,
    probeIntervalMs: 0,
    now: () => clock,
    createInstance: () => {
      counts.created++;
      return createFakeInstance(counts);
    },
  });
  t.after(() => controller.dispose());

  await controller.ensureStarted('initial');
  assert.equal(controller.getState(), 'active');

  // Advance close to TTL and touch to reset idle window.
  await sleep(35);
  clock += 35;
  await controller.touch('ui-query');
  assert.equal(controller.getState(), 'active');

  // Original 60ms deadline passed (35 + 35 = 70ms), but touch reset it.
  await sleep(35);
  clock += 35;
  assert.equal(controller.getState(), 'active');
  assert.equal(counts.integrationStopped, 0);

  // Now let full idleTtlMs elapse with no further touches.
  clock += 80;
  await sleep(80);

  assert.equal(controller.getState(), 'dormant');
  assert.equal(controller.getInstance(), null);
  assert.equal(controller.getStore(), null);
  assert.equal(counts.usageDisposed, 1);
  assert.equal(counts.storeDisposed, 1);
  assert.equal(counts.integrationStopped, 1);

  // Can reactivate cleanly after returning to dormant.
  const reactivated = await controller.ensureStarted('second-wake');
  assert.ok(reactivated);
  assert.equal(counts.created, 2);
  assert.equal(controller.getState(), 'active');
});

test('LazyVertexController safely handles dispose during startup and honors PULSE_LAZY_VERTEX=0', async (t) => {
  const counts = {
    created: 0,
    storeDisposed: 0,
    usageDisposed: 0,
    integrationStarted: 0,
    integrationStopped: 0,
  };
  let releaseCreate = null;
  const gate = new Promise((resolve) => {
    releaseCreate = resolve;
  });

  const controller = new LazyVertexController({
    idleTtlMs: 50,
    probeIntervalMs: 0,
    createInstance: async () => {
      counts.created++;
      await gate;
      return createFakeInstance(counts);
    },
  });

  const startPromise = controller.ensureStarted('concurrent-dispose');
  assert.equal(controller.getState(), 'starting');

  const disposePromise = controller.dispose();
  releaseCreate();

  const [started] = await Promise.all([startPromise, disposePromise]);
  assert.equal(started, null);
  assert.equal(controller.getState(), 'disposed');
  assert.equal(controller.getInstance(), null);
  assert.equal(counts.integrationStarted, 0);
  assert.equal(counts.usageDisposed, 1);
  assert.equal(counts.storeDisposed, 1);
  assert.equal(counts.integrationStopped, 1);
  assert.equal(await controller.ensureStarted('after-dispose'), null);

  // Verify PULSE_LAZY_VERTEX=0 opts out of lazy activation and idle hibernation.
  const optOutCounts = {
    created: 0,
    storeDisposed: 0,
    usageDisposed: 0,
    integrationStarted: 0,
    integrationStopped: 0,
  };
  const optOutController = new LazyVertexController({
    idleTtlMs: 30,
    probeIntervalMs: 0,
    env: { PULSE_LAZY_VERTEX: '0' },
    createInstance: () => {
      optOutCounts.created++;
      return createFakeInstance(optOutCounts);
    },
  });
  t.after(() => optOutController.dispose());

  optOutController.start();
  await sleep(60);
  assert.equal(optOutCounts.created, 1);
  assert.equal(optOutController.getState(), 'active');
  assert.equal(optOutCounts.integrationStopped, 0);
});

test('LazyVertexController activates on probeActive trigger A', async (t) => {
  const counts = {
    created: 0,
    storeDisposed: 0,
    usageDisposed: 0,
    integrationStarted: 0,
    integrationStopped: 0,
  };
  let vertexActive = false;
  const controller = new LazyVertexController({
    idleTtlMs: 5000,
    probeIntervalMs: 0,
    probeActive: async () => vertexActive,
    createInstance: () => {
      counts.created++;
      return createFakeInstance(counts);
    },
  });
  t.after(() => controller.dispose());

  assert.equal(await controller.probe(), false);
  assert.equal(controller.getState(), 'dormant');

  vertexActive = true;
  assert.equal(await controller.probe(), true);
  assert.equal(controller.getState(), 'active');
  assert.equal(counts.created, 1);
});

test('HostLivenessWatchdog enforces startupGraceMs when host never seen before triggering onShutdown', async (t) => {
  let clock = 10_000;
  let shutdownCount = 0;
  const watchdog = new HostLivenessWatchdog({
    pollIntervalMs: 10,
    startupGraceMs: 120,
    absenceThresholdMs: 30,
    probeHostAlive: () => false,
    probeRendererCount: () => 0,
    now: () => clock,
    onShutdown: () => {
      shutdownCount++;
    },
  });
  t.after(() => watchdog.stop());

  watchdog.start();
  await sleep(10);
  assert.equal(shutdownCount, 0);

  // Elapsed 60ms >= absenceThresholdMs(30) but < startupGraceMs(120): must NOT shutdown.
  clock += 60;
  await watchdog.tick();
  assert.equal(shutdownCount, 0);
  assert.equal(watchdog.getStatus().hasSeenHost, false);

  // Advance past startupGraceMs(120): absence tracking begins at grace expiry (no instant shutdown).
  clock += 70;
  await watchdog.tick();
  assert.equal(shutdownCount, 0);
  assert.equal(watchdog.getStatus().triggered, false);

  // Advance full absenceThresholdMs(30) after grace expiry -> shutdown once.
  clock += 30;
  await watchdog.tick();
  assert.equal(shutdownCount, 1);
  assert.equal(watchdog.getStatus().triggered, true);

  // Subsequent ticks must not re-trigger.
  clock += 100;
  await watchdog.tick();
  assert.equal(shutdownCount, 1);
});

test('HostLivenessWatchdog waits full absenceThresholdMs after host disappears and resets when host or renderer reappears', async (t) => {
  let clock = 50_000;
  let hostAlive = true;
  let rendererCount = 0;
  let shutdownCount = 0;

  const watchdog = new HostLivenessWatchdog({
    pollIntervalMs: 1000,
    startupGraceMs: 60_000,
    absenceThresholdMs: 100,
    probeHostAlive: () => hostAlive,
    probeRendererCount: () => rendererCount,
    now: () => clock,
    onShutdown: () => {
      shutdownCount++;
    },
  });
  t.after(() => watchdog.stop());

  watchdog.start();
  await watchdog.tick();
  assert.equal(watchdog.getStatus().hasSeenHost, true);
  assert.equal(shutdownCount, 0);

  // Host disappears at t=50_000.
  hostAlive = false;
  await watchdog.tick();
  assert.equal(watchdog.getStatus().absentSince, 50_000);
  assert.equal(shutdownCount, 0);

  // 80ms absent (< 100ms): must not shutdown.
  clock += 80;
  await watchdog.tick();
  assert.equal(shutdownCount, 0);

  // Renderer reappears: resets absence counter!
  rendererCount = 1;
  clock += 10;
  await watchdog.tick();
  assert.equal(watchdog.getStatus().absentSince, null);
  assert.equal(shutdownCount, 0);

  // Renderer disappears again at t=50_090.
  rendererCount = 0;
  await watchdog.tick();
  assert.equal(watchdog.getStatus().absentSince, 50_090);

  // Host reappears briefly at +50ms: resets counter again.
  clock += 50;
  hostAlive = true;
  await watchdog.tick();
  assert.equal(watchdog.getStatus().absentSince, null);

  // Both absent at t=50_140.
  hostAlive = false;
  await watchdog.tick();
  assert.equal(watchdog.getStatus().absentSince, 50_140);

  clock += 99;
  await watchdog.tick();
  assert.equal(shutdownCount, 0);

  clock += 1;
  await watchdog.tick();
  assert.equal(shutdownCount, 1);
});

test('HostLivenessWatchdog stop cancels timers cleanly and respects PULSE_DISABLE_HOST_WATCHDOG=1', async (t) => {
  let clock = 1000;
  let shutdownCount = 0;
  const watchdog = new HostLivenessWatchdog({
    pollIntervalMs: 15,
    startupGraceMs: 10,
    absenceThresholdMs: 10,
    probeHostAlive: () => false,
    probeRendererCount: () => 0,
    now: () => clock,
    onShutdown: () => {
      shutdownCount++;
    },
  });
  t.after(() => watchdog.stop());

  watchdog.start();
  watchdog.stop();
  clock += 1000;
  await sleep(45);
  assert.equal(shutdownCount, 0);
  assert.equal(watchdog.getStatus().stopped, true);

  const disabled = new HostLivenessWatchdog({
    pollIntervalMs: 10,
    startupGraceMs: 0,
    absenceThresholdMs: 0,
    env: { PULSE_DISABLE_HOST_WATCHDOG: '1' },
    probeHostAlive: () => false,
    probeRendererCount: () => 0,
    onShutdown: () => {
      shutdownCount++;
    },
  });
  t.after(() => disabled.stop());
  assert.equal(disabled.isDisabled(), true);
  disabled.start();
  await sleep(30);
  assert.equal(shutdownCount, 0);
  assert.equal(disabled.getStatus().running, false);
});
