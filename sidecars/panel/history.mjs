import { readFile, mkdir, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { safeContext, formatModelName } from './context.mjs';
import { safeTranscriptStats } from './transcript.mjs';
import { safeTaskUsage } from './task-usage.mjs';
import { safeModelUsage } from './metrics.mjs';
import { RATE_VERSION, RATE_REASONS } from './rate-quality.mjs';

const GUID = /^(?:[a-zA-Z0-9_.-]+\/)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = /^[0-9a-f]{64}$/;
const numeric = ['steps','rounds','requests','measuredRequests','missingTiming','tps','latestTps','streamingSeconds','modelSeconds','toolSeconds','ttftSeconds','excludedTiming','rateWarnings'];
const counts = ['input','output','responseOutput','thinkingOutput','cacheRead','cacheWrite'];
const cache = ['inputTokens','cachedTokens','cacheWriteTokens','uncachedTokens','outputTokens','measuredRequests','missingRequests','totalTokens','hitRate'];
const tokens = ['inputTokens','cachedTokens','cacheWriteTokens','uncachedTokens','outputTokens','measuredRequests','inputRequests','outputRequests','missingInputRequests','missingOutputRequests','totalTokens'];
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const tokenNumber = value => number(value) && Number.isSafeInteger(value);

export function safeMetrics(value, conversationId) {
  if (!GUID.test(conversationId) || !value || typeof value !== 'object') throw new Error('Invalid conversation statistics');
  const result = { conversationId, counts: {}, cache: {}, source: 'Antigravity request metadata' };
  for (const key of numeric) result[key] = number(value[key]) ? value[key] : null;
  for (const key of counts) result.counts[key] = tokenNumber(value.counts?.[key]) ? value.counts[key] : 0;
  for (const key of cache) result.cache[key] = (key==='hitRate'?number:tokenNumber)(value.cache?.[key]) ? value.cache[key] : null;
  if (result.cache.hitRate > 1) result.cache.hitRate = null;
  for (const key of ['complete','latestShortSample']) result[key] = value[key] === true;
  result.cache.complete = value.cache?.complete === true;
  result.tokens = {};
  if (value.tokens && typeof value.tokens === 'object') {
    for (const key of tokens) result.tokens[key] = tokenNumber(value.tokens[key]) ? value.tokens[key] : null;
    // Earlier token records counted only requests with complete input. That
    // count remains a conservative component-coverage fallback on upgrade.
    for (const key of ['uncachedRequests','cachedRequests','cacheWriteRequests']) result.tokens[key] =
      tokenNumber(value.tokens[key]) ? value.tokens[key] : result.tokens.inputRequests;
    result.tokens.outputAvailable = tokenNumber(result.tokens.outputTokens) &&
      (value.tokens.outputAvailable === true || result.tokens.outputRequests > 0);
    const suppliedTotal = result.tokens.totalTokens;
    const total = (result.tokens.inputTokens??0)+(result.tokens.outputTokens??0);
    result.tokens.totalTokens = (result.tokens.inputTokens!==null||result.tokens.outputTokens!==null)&&tokenNumber(total) ? total : null;
    result.tokens.coverageUnknown = value.tokens.coverageUnknown === true || tokens.some(key=>result.tokens[key]===null) || suppliedTotal!==result.tokens.totalTokens;
    result.tokens.complete = value.tokens.complete === true && !result.tokens.coverageUnknown &&
      result.tokens.missingInputRequests === 0 && result.tokens.missingOutputRequests === 0 &&
      result.tokens.inputRequests === result.requests && result.tokens.outputRequests === result.requests &&
      tokens.every(key=>result.tokens[key]!==null) &&
      result.tokens.inputTokens === result.tokens.uncachedTokens+result.tokens.cachedTokens+result.tokens.cacheWriteTokens &&
      suppliedTotal === result.tokens.totalTokens;
  } else {
    // Schema-1 records used a cache-only total, but already saved all output
    // usage in counts. Recover those real counts without deleting user history.
    const inputRequests = result.cache.measuredRequests || 0;
    const outputAvailable = tokenNumber(value.counts?.output);
    // The legacy counts group already saved readable normalized input parts,
    // including requests rejected by the old cache eligibility check.
    for (const [key,counter] of [['uncachedTokens','input'],['cachedTokens','cacheRead'],['cacheWriteTokens','cacheWrite']]) {
      result.tokens[key] = tokenNumber(value.counts?.[counter]) ? value.counts[counter] : result.cache[key] || 0;
    }
    const inputTotal=result.tokens.uncachedTokens+result.tokens.cachedTokens+result.tokens.cacheWriteTokens;
    result.tokens.inputTokens=tokenNumber(inputTotal)?inputTotal:null;
    const minimumCoverage=field=>Math.max(inputRequests,result.tokens[field]>0?1:0);
    const total=(result.tokens.inputTokens??0)+result.counts.output;
    Object.assign(result.tokens,{outputTokens:result.counts.output,inputRequests,outputRequests:null,outputAvailable,
      uncachedRequests:minimumCoverage('uncachedTokens'),cachedRequests:minimumCoverage('cachedTokens'),cacheWriteRequests:minimumCoverage('cacheWriteTokens'),
      measuredRequests:Math.max(inputRequests,result.counts.output>0||inputTotal>0?1:0),
      missingInputRequests:Math.max(0,(result.requests||0)-inputRequests),
      // Old counts defaulted missing output to zero and did not save coverage.
      // The aggregate can be recovered, but completeness cannot be inferred.
      missingOutputRequests:null,coverageUnknown:true,
      totalTokens:tokenNumber(total)?total:null,
      complete:false});
  }
  for (const key of ['speedRestoredFromHistory','cacheRestoredFromHistory']) result[key] = value[key] === true;
  for (const key of ['speedSavedAt','cacheSavedAt']) result[key] = typeof value[key] === 'string' && Number.isFinite(Date.parse(value[key])) ? new Date(value[key]).toISOString() : null;
  result.rateBasis = value.rateBasis === 'response' ? 'response' : 'all-output';
  result.model = typeof value.model === 'string' ? value.model.slice(0,256) : null;
  result.planModel = formatModelName(value.planModel);
  result.activeModel = formatModelName(value.activeModel);
  const modelUsage = safeModelUsage(value.modelUsage, { maxModels: 32 });
  if (modelUsage) result.modelUsage = modelUsage;
  result.status = typeof value.status === 'string' && /^[A-Z0-9_]+$/.test(value.status) ? value.status : null;
  result.context = safeContext(value.context) || null;
  const transcript=safeTranscriptStats(value.transcriptStats);
  // Transient loading/I/O status must not churn history timestamps or revive
  // a prior estimate. Persist only a measured numeric snapshot.
  if(transcript&&['ready','partial'].includes(transcript.status)&&(transcript.matchedSteps>0||transcript.complete))result.transcriptStats=transcript;
  const taskUsage = safeTaskUsage(value.taskUsage);
  if (taskUsage) result.taskUsage = taskUsage;
  if (Array.isArray(value.delegatedConversations)) {
    const ids = value.delegatedConversations.filter(id => typeof id === 'string' && GUID.test(id)).map(id => id.toLowerCase());
    if (ids.length) result.delegatedConversations = [...new Set(ids)];
  }
  result.rateVersion = value.rateVersion === RATE_VERSION ? RATE_VERSION : 0;
  result.timingReasons = Object.fromEntries(RATE_REASONS.map(key=>[key,number(value.timingReasons?.[key]) ? value.timingReasons[key] : 0]));
  result.latestRateStatus = ['ok','missing','unreliable'].includes(value.latestRateStatus) ? value.latestRateStatus : 'missing';
  if (result.rateVersion !== RATE_VERSION) {
    // Old aggregates cannot be repaired without the raw trajectory. Retain
    // usage/context, but never present a legacy unvalidated rate as trustworthy.
    result.tps = result.latestTps = result.streamingSeconds = null;
    result.measuredRequests = 0;
    result.latestRateStatus = 'legacy';
    result.latestShortSample = false;
  }
  return result;
}

export function usableMetrics(metrics) {
  return number(metrics?.tps) && metrics.measuredRequests > 0 || metrics?.tokens?.measuredRequests > 0 || metrics?.cache?.measuredRequests > 0 ||
    metrics?.requests > 0 && metrics?.counts?.output > 0 || !!safeContext(metrics?.context) ||
    (number(metrics?.taskUsage?.tokens?.totalTokens) && metrics.taskUsage.tokens.totalTokens > 0) ||
    (metrics?.taskUsage?.subagents > 0 && number(metrics?.taskUsage?.tokens?.totalTokens));
}

export function shouldKeepSaved(saved, fresh) {
  // A quality reclassification can intentionally reduce measuredRequests.
  // Protect raw coverage rather than retaining the older polluted TPS.
  return usableMetrics(saved) && (!usableMetrics(fresh) || fresh.complete === false ||
    fresh.requests < saved.requests || fresh.counts?.output < saved.counts?.output);
}

export function reconcileMetrics(saved, fresh, savedAt = null) {
  if (shouldKeepSaved(saved,fresh)) {
    const keptUsage = (fresh?.modelUsage?.totalTokens||0) > (saved?.modelUsage?.totalTokens||0)
      ? fresh.modelUsage : (saved?.modelUsage || fresh?.modelUsage || null);
    return {...saved,transcriptStats:fresh.transcriptStats||null,transcriptRestoredFromHistory:false,context:fresh.context || null,contextRestored:false,
      restoredFromHistory:true,savedAt,taskUsage:fresh.taskUsage||saved.taskUsage||null,delegatedConversations:fresh.delegatedConversations||saved.delegatedConversations||null,
      planModel:fresh.planModel??saved.planModel??null,activeModel:fresh.activeModel??saved.activeModel??null,
      ...(keptUsage?{modelUsage:keptUsage}:{})};
  }
  const result = {...fresh,contextRestored:false,transcriptRestoredFromHistory:false,restoredFromHistory:false,
    speedRestoredFromHistory:fresh.speedRestoredFromHistory===true,
    cacheRestoredFromHistory:fresh.cacheRestoredFromHistory===true};
  if (saved?.taskUsage && !result.taskUsage) result.taskUsage = saved.taskUsage;
  if (saved?.delegatedConversations && !result.delegatedConversations) result.delegatedConversations = saved.delegatedConversations;
  if (result.planModel == null && saved?.planModel) result.planModel = saved.planModel;
  if (result.activeModel == null && saved?.activeModel) result.activeModel = saved.activeModel;
  if (saved?.modelUsage && (!result.modelUsage || (result.modelUsage.totalRequests||0) < (saved.modelUsage.totalRequests||0))) {
    result.modelUsage = saved.modelUsage;
  }
  if (!usableMetrics(saved)) return result;
  // Protect only reduced cache coverage. Current quality reclassification can
  // deliberately reject timing; never revive an older, unvalidated rate.
  if ((fresh.cache?.measuredRequests||0) < (saved.cache?.measuredRequests||0)) {
    result.cache = saved.cache;
    result.cacheRestoredFromHistory = true;
    result.cacheSavedAt = saved.cacheSavedAt || savedAt;
  }
  return result;
}

export class SessionHistory {
  pending = new Map();
  createdDirs = new Set();
  writeCache = new Map();
  constructor(directory = join(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(homedir(),'.gemini','antigravity','sidecar_data','antigravity-pulse','panel','data'),'history-v1')) {
    this.directory = directory;
  }
  async stamp(file) {
    try {
      const s = await stat(file, { bigint: true });
      return `${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`;
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      return undefined;
    }
  }
  rememberWrite(file, fileStamp, result, metricsJson) {
    this.writeCache.delete(file);
    if (this.writeCache.size >= 64) {
      this.writeCache.delete(this.writeCache.keys().next().value);
    }
    this.writeCache.set(file, { fileStamp, result, metricsJson });
  }
  file(scope, id) {
    if (!SCOPE.test(scope) || !GUID.test(id)) throw new Error('Invalid history scope');
    const safeId = id.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    return join(this.directory, scope, safeId + '.json');
  }
  async load(scope, id) {
    if (!scope) return null;
    try {
      const text = await readFile(this.file(scope,id),'utf8');
      if (text.length > 65536) return null;
      const record = JSON.parse(text);
      if (record.schema !== 1 || record.account !== scope || record.conversationId !== id.toLowerCase() || !Number.isFinite(Date.parse(record.savedAt))) return null;
      const metrics = safeMetrics(record.metrics,id);
      return usableMetrics(metrics) ? { metrics, savedAt: record.savedAt } : null;
    } catch { return null; }
  }
  async save(scope, id, value) {
    if (!scope) return null;
    const key = this.file(scope,id);
    const previous = this.pending.get(key) || Promise.resolve();
    const pending = previous.catch(()=>{}).then(()=>this.write(scope,id,value));
    this.pending.set(key,pending);
    try { return await pending; }
    finally { if (this.pending.get(key) === pending) this.pending.delete(key); }
  }
  async write(scope, id, value) {
    let metrics = safeMetrics(value,id);
    const file = this.file(scope,id);
    if (!usableMetrics(metrics)) return null;
    const cached = this.writeCache.get(file);
    const fileStamp = await this.stamp(file);
    let previous = null, previousJson = null;
    if (fileStamp === null) {
      this.writeCache.delete(file);
    } else if (cached && fileStamp !== undefined && cached.fileStamp === fileStamp) {
      previous = cached.result;
      previousJson = cached.metricsJson;
    } else {
      previous = await this.load(scope,id);
    }
    if (previous && shouldKeepSaved(previous.metrics,metrics)) {
      // Regression guards protect cumulative TPS/cache. A valid current context
      // can shrink after compaction; it must still replace the prior snapshot.
      if (!metrics.context&&!Object.hasOwn(value,'transcriptStats')) return previous;
      metrics = reconcileMetrics(previous.metrics,metrics,previous.savedAt);
    } else if (previous) {
      metrics = reconcileMetrics(previous.metrics,metrics,previous.savedAt);
    }
    metrics = safeMetrics(metrics,id);
    const savedAt = new Date().toISOString();
    const convId = id.toLowerCase();
    const makePayload = (m) => `{"schema":1,"account":${JSON.stringify(scope)},"conversationId":${JSON.stringify(convId)},"savedAt":${JSON.stringify(savedAt)},"metrics":${JSON.stringify(m)}}`;
    let payload = makePayload(metrics);
    if (Buffer.byteLength(payload, 'utf8') > 65536) {
      if (metrics.modelUsage?.models?.length > 8) {
        metrics.modelUsage = safeModelUsage(metrics.modelUsage, { maxModels: 8 });
        payload = makePayload(metrics);
      }
      if (Buffer.byteLength(payload, 'utf8') > 65536 && metrics.taskUsage?.modelUsage?.models?.length > 8) {
        metrics.taskUsage = { ...metrics.taskUsage, modelUsage: safeModelUsage(metrics.taskUsage.modelUsage, { maxModels: 8 }) };
        payload = makePayload(metrics);
      }
      if (Buffer.byteLength(payload, 'utf8') > 65536 && Array.isArray(metrics.taskUsage?.items)) {
        const items = [...metrics.taskUsage.items];
        while (items.length && Buffer.byteLength(payload, 'utf8') > 65536) {
          items.pop();
          metrics.taskUsage = items.length ? { ...metrics.taskUsage, items } : (({ items: _drop, ...rest }) => rest)(metrics.taskUsage);
          payload = makePayload(metrics);
        }
      }
      if (Buffer.byteLength(payload, 'utf8') > 65536 && metrics.modelUsage?.models?.length) {
        metrics.modelUsage = { ...metrics.modelUsage, models: metrics.modelUsage.models.slice(0, 4) };
        payload = makePayload(metrics);
      }
      if (Buffer.byteLength(payload, 'utf8') > 65536) return previous || null;
    }
    const metricsJson = JSON.stringify(metrics);
    if (previous && (previousJson ?? JSON.stringify(previous.metrics)) === metricsJson) {
      if (fileStamp) this.rememberWrite(file, fileStamp, previous, metricsJson);
      return previous;
    }
    const dir = join(this.directory,scope);
    const temporary = file + '.' + randomUUID() + '.tmp';
    if (!this.createdDirs.has(dir)) {
      await mkdir(dir,{recursive:true});
      this.createdDirs.add(dir);
    }
    try {
      await writeFile(temporary,payload,{encoding:'utf8',mode:0o600});
      await rename(temporary,file);
    }
    catch (error) {
      this.writeCache.delete(file);
      if (error?.code === 'ENOENT') {
        this.createdDirs.delete(dir);
        await mkdir(dir,{recursive:true});
        this.createdDirs.add(dir);
        try {
          await writeFile(temporary,payload,{encoding:'utf8',mode:0o600});
          await rename(temporary,file);
        } catch (retryError) {
          await unlink(temporary).catch(()=>{});
          throw retryError;
        }
      } else {
        await unlink(temporary).catch(()=>{});
        throw error;
      }
    }
    const result = {metrics,savedAt};
    const nextStamp = await this.stamp(file);
    if (nextStamp) this.rememberWrite(file, nextStamp, result, metricsJson);
    return result;
  }
}
