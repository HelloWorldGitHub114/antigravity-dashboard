import { setImmediate as yieldLoop } from 'node:timers/promises';
import type { TaskUsageState, TaskUsageSummary } from '../../contracts/metrics.ts';
import { trajectoryMetrics } from '../metrics/index.ts';
import type {
  ChildTimelineSummary,
  DelegatedClientLike,
  DelegatedTaskState,
  DelegatedUsageOptions,
} from './delegated-types.ts';
import { delegatedHints, delegatedIds } from './delegation.ts';
import {
  extractChildTimeRange,
  findSummaryEntry,
  mergeTaskHint,
  resolveTaskHint,
} from './hints.ts';
import {
  taskModelRecords,
  taskRecords,
  type TaskModelRecord,
  type TaskUsageRecord,
} from './task-usage.ts';

export function buildTimelineChildren(
  task: DelegatedTaskState,
  summaries: Record<string, unknown>,
): ChildTimelineSummary[] {
  return [...task.children]
    .map((cid): ChildTimelineSummary | null => {
      const tl = task.childTimelines?.get(cid);
      if (tl) return tl;
      const d = task.details?.get(cid);
      if (!d) return null;
      const s = findSummaryEntry(summaries, cid);
      const meta =
        s.trajectoryMetadata && typeof s.trajectoryMetadata === 'object'
          ? (s.trajectoryMetadata as Record<string, unknown>)
          : null;
      const spec =
        meta?.subagentSpec && typeof meta.subagentSpec === 'object'
          ? (meta.subagentSpec as Record<string, unknown>)
          : null;
      const hintRole = task.hints?.get(cid)?.role || null;
      const safeRole =
        (typeof spec?.role === 'string' && spec.role) ||
        (typeof spec?.typeName === 'string' && spec.typeName) ||
        (typeof meta?.subagentRole === 'string' && meta.subagentRole) ||
        hintRole ||
        (typeof spec?.modelTier === 'string' && spec.modelTier
          ? `worker (${spec.modelTier})`
          : 'subagent');
      return {
        id: cid,
        role: safeRole,
        parentId: d.parentId,
        depth: d.depth,
        model: d.model,
        planModel: null,
        activeModel: d.model,
        requests: 0,
        totalTokens: d.totalTokens ?? 0,
        outputTokens: 0,
        tokens: null,
        tps: d.tps,
        status: d.status,
        steps: d.steps,
        startedAt: null,
        endedAt: null,
        durationMs: 0,
        modelUsage: null,
      };
    })
    .filter((item): item is ChildTimelineSummary => item !== null);
}

export interface CollectContext {
  client: DelegatedClientLike;
  now: () => number;
  modelTimelineEnabled: boolean;
  addChildren: (task: DelegatedTaskState, ids: string[]) => void;
  put: (task: DelegatedTaskState, id: string, rows: TaskUsageRecord[]) => boolean;
  putModels: (task: DelegatedTaskState, id: string, rows: TaskModelRecord[]) => boolean;
  buildResult: (task: DelegatedTaskState, state: TaskUsageState) => TaskUsageSummary;
  onSource: NonNullable<DelegatedUsageOptions['onSource']>;
  onUpdate: NonNullable<DelegatedUsageOptions['onUpdate']>;
}

export async function collectTaskChildren(
  ctx: CollectContext,
  task: DelegatedTaskState,
  force: boolean,
  current: () => boolean,
): Promise<void> {
  const deadline = ctx.now() + 30000;
  let failed = false;
  try {
    // Resume oldest/unread sources first after a bounded pass. Starting from
    // the same first child every time can starve late children in a large task.
    const queue = [...task.children].sort(
      (a, b) => (task.attempted.get(a) || 0) - (task.attempted.get(b) || 0),
    );
    const queued = new Set(queue);
    for (const id of queue) {
      if (!current()) return;
      if (ctx.now() > deadline) {
        failed = true;
        break;
      }
      const failure = task.failures.get(id);
      if (!force && failure && failure.retryAt > ctx.now()) {
        failed = true;
        continue;
      }
      task.attempted.set(id, ++task.order);
      try {
        const summaries = ctx.client.reader?.summaries || {};
        const summary = findSummaryEntry(summaries, id);
        const raw = await ctx.client.trajectory(id, { summary, force, isCurrent: current });
        if (!current()) return;
        const rawObj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
        const traj =
          rawObj?.trajectory && typeof rawObj.trajectory === 'object'
            ? (rawObj.trajectory as Record<string, unknown>)
            : null;
        if (
          !traj ||
          !Array.isArray(traj.generatorMetadata) ||
          (!traj.generatorMetadata.length &&
            !(Array.isArray(traj.steps) && traj.steps.length) &&
            !Object.keys(summary).length)
        ) {
          throw Error('Delegated statistics unavailable');
        }
        const { role, parentId, depth, specRole, meta } = resolveTaskHint(task, id, summaries, raw);
        mergeTaskHint(task.hints, task.id, id, { role: specRole || role, parentId, depth });
        ctx.addChildren(task, delegatedIds(id, raw, summaries));
        for (const [cid, h] of delegatedHints(id, raw, summaries, depth)) {
          mergeTaskHint(task.hints, task.id, cid, h);
        }
        for (const child of task.children) {
          if (!queued.has(child)) {
            queued.add(child);
            queue.push(child);
          }
        }
        if (!ctx.put(task, id, taskRecords(raw, id))) {
          task.truncated = true;
          failed = true;
          break;
        }
        ctx.putModels(task, id, taskModelRecords(raw, id));
        const m = trajectoryMetrics(raw);
        const context = m.context
          ? {
              usedTokens: m.context.usedTokens,
              maxTokens: m.context.maxTokens,
              usedFraction: m.context.usedFraction,
            }
          : null;
        const rawStatus = typeof rawObj?.status === 'string' ? rawObj.status : null;
        const rawSteps = typeof rawObj?.numTotalSteps === 'number' ? rawObj.numTotalSteps : 0;
        task.details.set(id, {
          id,
          role,
          parentId,
          depth,
          model: m.model || null,
          tps: m.tps ?? null,
          latestTps: m.latestTps ?? null,
          latestRateStatus: m.latestRateStatus || 'missing',
          totalTokens: m.tokens?.totalTokens ?? null,
          context,
          status: m.status || rawStatus || 'CASCADE_RUN_STATUS_IDLE',
          steps: m.steps ?? rawSteps,
        });
        if (ctx.modelTimelineEnabled) {
          const span = extractChildTimeRange(raw);
          const spec =
            meta?.subagentSpec && typeof meta.subagentSpec === 'object'
              ? (meta.subagentSpec as Record<string, unknown>)
              : null;
          task.childTimelines?.set(id, {
            id,
            role:
              specRole ||
              task.hints?.get(id)?.role ||
              (typeof spec?.modelTier === 'string' && spec.modelTier
                ? `worker (${spec.modelTier})`
                : 'subagent'),
            parentId,
            depth,
            model: m.activeModel || m.model || null,
            planModel: m.planModel || null,
            activeModel: m.activeModel || null,
            requests: m.requests ?? 0,
            totalTokens: m.tokens?.totalTokens ?? 0,
            outputTokens: m.tokens?.outputTokens ?? 0,
            tokens: m.tokens
              ? {
                  inputTokens: m.tokens.inputTokens ?? 0,
                  outputTokens: m.tokens.outputTokens ?? 0,
                  thinkingTokens: m.counts?.thinkingOutput ?? 0,
                  cachedTokens: m.tokens.cachedTokens ?? 0,
                  totalTokens: m.tokens.totalTokens ?? 0,
                }
              : null,
            tps: m.tps ?? null,
            status: m.status || rawStatus || 'CASCADE_RUN_STATUS_IDLE',
            steps: m.steps ?? rawSteps,
            ...span,
            modelUsage: m.modelUsage || null,
          });
        }
        await ctx.onSource(task.scope, id, raw, { isCurrent: current, guardKey: task });
        if (!current()) return;
        task.failures.delete(id);
      } catch {
        if (!current()) return;
        failed = true;
        const failures = (failure?.failures || 0) + 1;
        task.failures.set(id, {
          failures,
          retryAt: ctx.now() + Math.min(300000, 5000 * 2 ** Math.min(failures - 1, 6)),
        });
      }
      await yieldLoop();
    }
    if (!current()) return;
    task.lastAt = ctx.now();
    task.result = ctx.buildResult(task, failed ? 'partial' : 'ready');
    await ctx.onUpdate(task.scope, task.id, task.result, [...task.children]);
  } catch {
    if (current()) {
      task.lastAt = ctx.now();
      task.result = ctx.buildResult(task, 'partial');
    }
  }
}
