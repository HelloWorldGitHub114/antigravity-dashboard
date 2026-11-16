import { mergeGeneratorMetadata, normalizeRemoteSnapshot, settled } from './remote-snapshot.ts';
import type {
  ContextWindowUsageLike,
  ProjectedStep,
  RawGeneratorMetadataLike,
  RemoteReaderHost,
  RemoteUpdateLike,
  TrajectoryCacheEntry,
  TrajectoryResult,
} from './types.ts';

function errorMeta(error: unknown): { message: string; status: number | undefined } {
  if (!error || typeof error !== 'object') return { message: String(error || ''), status: undefined };
  const record = error as { message?: unknown; status?: unknown };
  return {
    message: typeof record.message === 'string' ? record.message : '',
    status: typeof record.status === 'number' ? record.status : undefined,
  };
}

/**
 * Read a remote or cloud-proxied conversation via `GetConversationMetadata` + `StreamAgentStateUpdates`,
 * supporting incremental tail reads and background history backfill.
 */
export async function readRemoteTrajectory(
  host: RemoteReaderHost,
  id: string,
  entry: TrajectoryCacheEntry,
  force: boolean,
  assertCurrent: () => void,
  wantTimeline: boolean,
): Promise<TrajectoryResult> {
  const old = entry.data;
  const timelineMismatch = Boolean(old) && entry.withTimeline !== wantTimeline;
  let remoteSteps: number | null = null;

  if (!force && !timelineMismatch && old?.isRemote) {
    if (settled(old.status) && host.client.now() - (entry.verifiedAt ?? 0) < host.idleRecheckMs) {
      host.entries.delete(id);
      host.entries.set(id, entry);
      return old;
    }
    if (id.includes('/')) {
      try {
        const meta = await host.client.call<{ numSteps?: unknown }>('GetConversationMetadata', { conversationId: id });
        assertCurrent();
        remoteSteps = meta?.numSteps === undefined ? null : Number(meta.numSteps);
        const unchanged = Number.isSafeInteger(remoteSteps) && remoteSteps === old.numTotalSteps;
        if ((settled(old.status) || unchanged) && unchanged) {
          entry.verifiedAt = host.client.now();
          host.entries.delete(id);
          host.entries.set(id, entry);
          return old;
        }
      } catch (err) {
        if (errorMeta(err).message === '后台已重新连接，请等待刷新') throw err;
      }
    }
  }

  if (id.includes('/') && remoteSteps === null) {
    try {
      const meta = await host.client.call<{ numSteps?: unknown }>('GetConversationMetadata', { conversationId: id });
      assertCurrent();
      remoteSteps = meta?.numSteps === undefined ? null : Number(meta.numSteps);
    } catch (err) {
      if (errorMeta(err).message === '后台已重新连接，请等待刷新') throw err;
    }
  }

  const canIncremental =
    !force &&
    !timelineMismatch &&
    Boolean(old?.isRemote) &&
    remoteSteps !== null &&
    Number.isSafeInteger(remoteSteps) &&
    remoteSteps > (old?.numTotalSteps ?? 0) &&
    Array.isArray(old?.trajectory?.steps);
  const isColdTail = !canIncremental && remoteSteps !== null && Number.isSafeInteger(remoteSteps) && remoteSteps > 50;

  let update: RemoteUpdateLike;
  let isIncrementalSlice = false;
  let sliceStart = 0;
  const readSnapshot = host.client.readAgentStateSnapshot!.bind(host.client);
  try {
    if (canIncremental && old && remoteSteps !== null) {
      sliceStart = old.numTotalSteps;
      update = await readSnapshot(id, { initialStepsPageBounds: { startIndex: sliceStart, endIndexExclusive: remoteSteps } });
      isIncrementalSlice = true;
    } else if (isColdTail && remoteSteps !== null) {
      sliceStart = remoteSteps - 50;
      update = await readSnapshot(id, { initialStepsPageBounds: { startIndex: sliceStart, endIndexExclusive: remoteSteps } });
      isIncrementalSlice = true;
    } else {
      update = await readSnapshot(id);
    }
  } catch (err) {
    const { message, status } = errorMeta(err);
    if (/cloud conversations are not enabled/i.test(message)) {
      throw new Error('当前登录账号未开启远程 Agent (Cloud Conversations) 权限');
    }
    if (id.includes('/') && /超时|timeout/i.test(message)) {
      throw new Error('远程环境休眠或同步较慢，请稍候刷新');
    }
    if ((status !== undefined && [404, 403].includes(status)) || /not found|无权访问|权限/i.test(message)) {
      throw new Error('会话暂时没有可用统计');
    }
    throw err;
  }

  assertCurrent();
  const normalized = normalizeRemoteSnapshot(update, id, isIncrementalSlice ? sliceStart : 0, {
    modelTimelineEnabled: wantTimeline,
  });
  let steps: Array<ProjectedStep | undefined>;
  let generatorMetadata: RawGeneratorMetadataLike[];
  let contextWindowUsage: ContextWindowUsageLike | undefined;

  if (isIncrementalSlice && remoteSteps !== null) {
    if (canIncremental && old) {
      if (normalized.steps.length >= remoteSteps) {
        steps = normalized.steps;
        generatorMetadata = normalized.generatorMetadata;
        entry.pendingBackfillOffset = 0;
        entry.backfillGen = (entry.backfillGen || 0) + 1;
      } else {
        steps = [...old.trajectory.steps.slice(0, old.numTotalSteps), ...normalized.steps];
        generatorMetadata = mergeGeneratorMetadata(old.trajectory.generatorMetadata || [], normalized.generatorMetadata);
      }
      contextWindowUsage = normalized.contextWindowUsage || old.contextWindowUsage;
    } else {
      if (normalized.steps.length >= remoteSteps) {
        steps = normalized.steps;
        entry.pendingBackfillOffset = 0;
        entry.backfillGen = (entry.backfillGen || 0) + 1;
      } else {
        steps = new Array<ProjectedStep | undefined>(remoteSteps);
        for (let i = 0; i < normalized.steps.length; i++) steps[sliceStart + i] = normalized.steps[i];
        entry.pendingBackfillOffset = sliceStart;
        entry.backfillGen = (entry.backfillGen || 0) + 1;
      }
      generatorMetadata = normalized.generatorMetadata;
      contextWindowUsage = normalized.contextWindowUsage;
    }
  } else {
    steps = normalized.steps;
    generatorMetadata = normalized.generatorMetadata;
    contextWindowUsage = normalized.contextWindowUsage;
    entry.pendingBackfillOffset = 0;
    entry.backfillGen = (entry.backfillGen || 0) + 1;
  }

  const cascadeId = normalized.cascadeId || old?.trajectory?.cascadeId || id;
  const planModel = normalized.planModel || (canIncremental ? old?.trajectory?.planModel : undefined) || undefined;
  const bytes = Buffer.byteLength(JSON.stringify({ steps, generatorMetadata }));
  if (bytes > host.budgetBytes) throw new Error('会话统计数据超过内存预算');

  const status = update.status || 'CASCADE_RUN_STATUS_IDLE';
  const totalSteps = remoteSteps !== null && Number.isSafeInteger(remoteSteps) ? remoteSteps : steps.length;
  const value: TrajectoryResult = {
    trajectory: { cascadeId, ...(planModel ? { planModel } : {}), steps, generatorMetadata },
    contextWindowUsage,
    status,
    numTotalSteps: totalSteps,
    numTotalGeneratorMetadata: generatorMetadata.length,
    isRemote: true,
  };
  const mark = JSON.stringify([totalSteps, status, contextWindowUsage?.estimatedTokensUsed]);
  assertCurrent();
  host.cachedBytes -= entry.bytes;
  entry.bytes = bytes;
  host.cachedBytes += bytes;
  entry.data = value;
  entry.summary = { stepCount: totalSteps, status: value.status, lastModifiedTime: new Date().toISOString() };
  entry.mark = mark;
  entry.withTimeline = wantTimeline;
  entry.rev = (entry.rev || 0) + 1;
  entry.verifiedAt = host.client.now();
  host.entries.delete(id);
  host.entries.set(id, entry);
  host.trim(id);
  if (entry.pendingBackfillOffset && entry.pendingBackfillOffset > 0 && !entry.backfilling) {
    scheduleRemoteBackfill(host, id, entry);
  }
  return value;
}

/**
 * Progressively backfill earlier 50-step slices for cold-loaded remote trajectories.
 */
export function scheduleRemoteBackfill(host: RemoteReaderHost, id: string, entry: TrajectoryCacheEntry): void {
  if (entry.backfilling || !entry.pendingBackfillOffset || entry.pendingBackfillOffset <= 0) return;
  if (typeof host.client.readAgentStateSnapshot !== 'function') return;
  const readSnapshot = host.client.readAgentStateSnapshot.bind(host.client);
  entry.backfilling = true;
  const epoch = host.epoch;
  const gen = entry.backfillGen || 0;
  const wantTimeline = entry.withTimeline === true;

  void (async () => {
    while (
      (entry.pendingBackfillOffset ?? 0) > 0 &&
      host.epoch === epoch &&
      host.entries.get(id) === entry &&
      (entry.backfillGen || 0) === gen
    ) {
      const end = entry.pendingBackfillOffset!;
      const start = Math.max(0, end - 50);
      try {
        const chunk = await readSnapshot(id, {
          initialStepsPageBounds: { startIndex: start, endIndexExclusive: end },
        });
        if (host.epoch !== epoch || host.entries.get(id) !== entry || (entry.backfillGen || 0) !== gen) break;
        const normalized = normalizeRemoteSnapshot(chunk, id, start, { modelTimelineEnabled: wantTimeline });
        const currentSteps = entry.data?.trajectory?.steps;
        if (Array.isArray(currentSteps)) {
          for (let i = 0; i < normalized.steps.length; i++) currentSteps[start + i] = normalized.steps[i];
          if (normalized.planModel && entry.data?.trajectory && !entry.data.trajectory.planModel) {
            entry.data.trajectory.planModel = normalized.planModel;
          }
          entry.data!.trajectory.generatorMetadata = mergeGeneratorMetadata(
            normalized.generatorMetadata,
            entry.data!.trajectory.generatorMetadata || [],
          );
          entry.data!.numTotalGeneratorMetadata = entry.data!.trajectory.generatorMetadata.length;
          const delta =
            Math.max(0, Buffer.byteLength(JSON.stringify(normalized.steps)) - normalized.steps.length * 5) +
            Buffer.byteLength(JSON.stringify(normalized.generatorMetadata));
          entry.bytes = (entry.bytes || 0) + delta;
          host.cachedBytes += delta;
          entry.rev = (entry.rev || 0) + 1;
          host.trim(id);
        }
        entry.pendingBackfillOffset = start;
        if (typeof host.onTrajectory === 'function' && entry.data) {
          try { host.onTrajectory(id, entry.data); } catch {}
        }
      } catch {
        if ((entry.backfillGen || 0) === gen) entry.pendingBackfillOffset = 0;
        break;
      }
    }
  })().finally(() => {
    entry.backfilling = false;
    if ((entry.pendingBackfillOffset ?? 0) > 0 && host.epoch === epoch && host.entries.get(id) === entry) {
      scheduleRemoteBackfill(host, id, entry);
    }
  });
}
