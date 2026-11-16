import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_TOOLS = dirname(fileURLToPath(import.meta.url));
const sharedBrowserStore = new AsyncLocalStorage();

export function isDirectEntry(metaUrl) {
  return Boolean(process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(metaUrl)));
}

export function getBrowserLaunchOptions(overrides = {}) {
  const defaults =
    process.platform === 'win32' && !process.env.CI
      ? { channel: 'msedge', headless: true }
      : { headless: true };
  return { ...defaults, ...overrides };
}

export async function loadPlaywrightChromium() {
  const target = process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : 'playwright';
  const mod = await import(target);
  return mod.chromium;
}

export function createScopedBrowser(sharedBrowser) {
  const contexts = new Set();
  return {
    isScoped: true,
    async newContext(options) {
      const ctx = await sharedBrowser.newContext(options);
      contexts.add(ctx);
      const rawClose = ctx.close.bind(ctx);
      ctx.close = async (...args) => {
        try {
          return await rawClose(...args);
        } finally {
          contexts.delete(ctx);
        }
      };
      return ctx;
    },
    async newPage(options) {
      const ctx = await sharedBrowser.newContext(options);
      contexts.add(ctx);
      const page = await ctx.newPage();
      const rawClose = page.close.bind(page);
      page.close = async (...args) => {
        try {
          await rawClose(...args);
        } finally {
          contexts.delete(ctx);
          await ctx.close().catch(() => {});
        }
      };
      return page;
    },
    async close() {
      const list = [...contexts];
      contexts.clear();
      await Promise.all(list.map((ctx) => ctx.close().catch(() => {})));
    },
  };
}

export async function launchTestBrowser(overrides = {}) {
  const store = sharedBrowserStore.getStore();
  if (store?.browser) {
    return createScopedBrowser(store.browser);
  }
  const chromium = await loadPlaywrightChromium();
  return chromium.launch(getBrowserLaunchOptions(overrides));
}

export async function launchPersistentTestContext(profileDir, options = {}) {
  const chromium = await loadPlaywrightChromium();
  return chromium.launchPersistentContext(profileDir, getBrowserLaunchOptions(options));
}

export async function withSharedBrowser(sharedBrowser, fn) {
  return sharedBrowserStore.run({ browser: sharedBrowser }, fn);
}

const SUITES = {
  ui: {
    concurrent: [
      { file: 'check-theme-ui.mjs', args: [] },
      { file: 'check-localized-ui.mjs', args: [] },
      { file: 'check-inline-layout.mjs', args: [] },
      { file: 'check-inline-hover.mjs', args: [] },
      { file: 'check-subagent-ui.mjs', args: [] },
      { file: 'check-teamwork-ui.mjs', args: [] },
      { file: 'check-cold-start-ui.mjs', args: [] },
      { file: 'check-language-persistence.mjs', args: [] },
      { file: 'check-language-guide.mjs', args: [] },
      { file: 'check-token-usage-ui.mjs', args: [] },
      { file: 'check-update-ui.mjs', args: [] },
    ],
    sequential: [{ file: 'check-density-motion.mjs', args: [] }],
  },
  usage: {
    concurrent: [
      { file: 'check-usage-ui.mjs', args: [] },
      { file: 'check-usage-ui.mjs', args: ['--ide'] },
    ],
    sequential: [{ file: 'check-usage-performance.mjs', args: [] }],
  },
  panel: {
    concurrent: [{ file: 'check-panel-ui.mjs', args: [] }],
    sequential: [],
  },
  ide: {
    concurrent: [{ file: 'check-ide-ui.mjs', args: [] }],
    sequential: [],
  },
};

function selectSuiteTasks(suiteName, filter) {
  const groups = suiteName === 'all' ? [SUITES.ui, SUITES.usage, SUITES.panel, SUITES.ide] : [SUITES[suiteName]];
  if (!groups[0]) {
    throw new Error(`Unknown UI suite "${suiteName}". Expected one of: ui, usage, panel, ide, all.`);
  }
  const matchesFilter = (task) => {
    if (!filter) return true;
    const label = `${task.file} ${task.args.join(' ')}`;
    return label.includes(filter);
  };
  return {
    concurrent: groups.flatMap((g) => g.concurrent).filter(matchesFilter),
    sequential: groups.flatMap((g) => g.sequential).filter(matchesFilter),
  };
}

async function runPool(items, limit, worker) {
  const errors = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      try {
        await worker(items[idx]);
      } catch (err) {
        errors.push({ item: items[idx], error: err });
      }
    }
  });
  await Promise.all(runners);
  return errors;
}

export async function runUiSuite({
  suite = 'ui',
  concurrency = Number(process.env.AG_UI_CONCURRENCY) || 4,
  filter = '',
  browser: providedBrowser = null,
  launchBrowser = null,
  tasks = null,
} = {}) {
  const plan = tasks ?? selectSuiteTasks(suite, filter);
  const total = plan.concurrent.length + plan.sequential.length;
  if (total === 0) {
    console.log(`[ui-runner] No matching UI checks for suite=${suite}${filter ? ` filter=${filter}` : ''}.`);
    return { passed: 0, total: 0 };
  }

  let ownedBrowser = null;
  let ownedBrowserPromise = null;
  const sharedBrowser = providedBrowser ?? null;

  const ensureBrowser = () => {
    if (sharedBrowser) return Promise.resolve(sharedBrowser);
    if (!ownedBrowserPromise) {
      ownedBrowserPromise = (async () => {
        if (launchBrowser) {
          ownedBrowser = await launchBrowser();
        } else {
          const chromium = await loadPlaywrightChromium();
          ownedBrowser = await chromium.launch(getBrowserLaunchOptions());
        }
        return ownedBrowser;
      })().catch((err) => {
        ownedBrowserPromise = null;
        throw err;
      });
    }
    return ownedBrowserPromise;
  };

  const runTask = async (task) => {
    const label = task.args?.length > 0 ? `${task.file} ${task.args.join(' ')}` : task.file;
    const started = performance.now();
    const browser = await ensureBrowser();
    if (typeof task.run === 'function') {
      await withSharedBrowser(browser, () => task.run(task.args ?? []));
    } else {
      const mod = await import(pathToFileURL(join(ROOT_TOOLS, task.file)).href);
      if (typeof mod.runCheck !== 'function') {
        throw new Error(`${task.file} does not export runCheck(args)`);
      }
      await withSharedBrowser(browser, () => mod.runCheck(task.args));
    }
    const ms = Math.round(performance.now() - started);
    console.log(`[ui-runner] PASS ${label} (${ms}ms)`);
  };

  const failures = [];
  try {
    if (plan.concurrent.length > 0) {
      console.log(
        `[ui-runner] Wave 1: running ${plan.concurrent.length} checks concurrently (limit=${Math.max(1, concurrency)})...`,
      );
      const wave1Errors = await runPool(plan.concurrent, Math.max(1, concurrency), runTask);
      failures.push(...wave1Errors);
    }

    if (plan.sequential.length > 0) {
      console.log(`[ui-runner] Wave 2: running ${plan.sequential.length} timing-sensitive checks sequentially...`);
      for (const task of plan.sequential) {
        try {
          await runTask(task);
        } catch (err) {
          failures.push({ item: task, error: err });
        }
      }
    }
  } finally {
    const browserToClose = ownedBrowserPromise ? await ownedBrowserPromise.catch(() => null) : ownedBrowser;
    if (browserToClose) {
      await browserToClose.close().catch(() => {});
    }
  }

  if (failures.length > 0) {
    for (const { item, error } of failures) {
      const label = item.args?.length > 0 ? `${item.file} ${item.args.join(' ')}` : item.file;
      console.error(`[ui-runner] FAIL ${label}:`, error instanceof Error ? error.stack || error.message : error);
    }
    throw new Error(`${failures.length} of ${total} UI checks failed.`);
  }

  console.log(`[ui-runner] All ${total} checks in suite=${suite} passed.`);
  return { passed: total, total };
}

function parseCliArgs(argv) {
  let suite = 'ui';
  let concurrency = Number(process.env.AG_UI_CONCURRENCY) || 4;
  let filter = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--suite') {
      suite = argv[i + 1] ?? suite;
      i += 1;
    } else if (arg === '--concurrency') {
      concurrency = Number(argv[i + 1] ?? concurrency);
      i += 1;
    } else if (arg === '--filter') {
      filter = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return { suite, concurrency, filter };
}

if (isDirectEntry(import.meta.url)) {
  runUiSuite(parseCliArgs(process.argv.slice(2))).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
