// Pure transforms. No credentials, prompts, or message text enter the public result.
import { contextMetrics, formatModelName, normalizeModelId, isOrchestratorModel } from './context.mjs';
import { classifyRates, RATE_VERSION, RATE_REASONS } from './rate-quality.mjs';

const MODEL_ROLES = new Set(['plan', 'worker', 'subagent', 'model']);
const ROLE_ORDER = { plan: 0, worker: 1, model: 2, subagent: 3 };
const safeAdd = (a, b) => {
  const sum = a + b;
  return Number.isSafeInteger(sum) && sum >= 0 ? sum : Number.MAX_SAFE_INTEGER;
};

export function resolveChatModelName(chat = null) {
  if (!chat || typeof chat !== 'object') return null;
  const usage = chat.usage && typeof chat.usage === 'object' ? chat.usage : null;
  if (typeof chat.modelDisplayName === 'string' && chat.modelDisplayName.trim()) {
    const formatted = formatModelName(chat.modelDisplayName);
    if (formatted) return formatted;
  }
  for (const cand of [chat.model, chat.responseModel, usage?.model]) {
    const formatted = formatModelName(cand);
    if (formatted && !/^MODEL_PLACEHOLDER_M\d+$/i.test(formatted)) return formatted;
  }
  for (const cand of [chat.model, chat.responseModel, usage?.model]) {
    const formatted = formatModelName(cand);
    if (formatted) return formatted;
  }
  return null;
}

export function extractPlanModel(response) {
  const trajectory = response?.trajectory || {};
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : Array.isArray(response?.steps) ? response.steps : [];
  let raw = null;
  for (const step of steps) {
    const pm = step?.userInput?.userConfig?.plannerConfig?.planModel;
    if (typeof pm === 'string' && pm.trim()) raw = pm;
  }
  if (!raw) {
    const direct = trajectory.planModel || response?.planModel;
    if (typeof direct === 'string' && direct.trim()) raw = direct;
  }
  if (raw) return formatModelName(raw);
  const generators = trajectory.generatorMetadata || response?.generatorMetadata || [];
  for (const g of generators) {
    const pm = g?.plannerConfig?.planModel;
    if (typeof pm === 'string' && pm.trim()) return formatModelName(pm);
  }
  for (const g of generators) {
    const name = resolveChatModelName(g?.chatModel);
    if (name && isOrchestratorModel(name)) return name;
  }
  return null;
}

export function buildModelUsage(rawBuckets, { planModel = null, activeModel = null, maxModels = 64 } = {}) {
  const cleanPlan = formatModelName(planModel);
  const cleanActive = formatModelName(activeModel);
  const list = [...(rawBuckets || [])].filter(b => b && typeof b === 'object' && typeof b.id === 'string' && b.id);
  const ownBuckets = list.filter(b => b.hasOwn !== false);
  const planId = cleanPlan ? normalizeModelId(cleanPlan) : null;
  const hasHybridOwn = ownBuckets.length > 1 || ownBuckets.some(b => isOrchestratorModel(b.name)) || (planId && ownBuckets.some(b => b.id !== planId));
  const models = list.map(b => {
    let role;
    if (b.hasOwn === false && b.hasChild === true) {
      role = 'subagent';
    } else if (hasHybridOwn) {
      role = ((planId && b.id === planId) || isOrchestratorModel(b.name)) ? 'plan' : 'worker';
    } else {
      role = 'model';
    }
    const uncachedTokens = tokenCount(b.uncachedTokens) ?? 0;
    const cachedTokens = tokenCount(b.cachedTokens) ?? 0;
    const cacheWriteTokens = tokenCount(b.cacheWriteTokens) ?? 0;
    const inputTokens = tokenCount(b.inputTokens) ?? safeAdd(safeAdd(uncachedTokens, cachedTokens), cacheWriteTokens);
    const outputTokens = tokenCount(b.outputTokens) ?? 0;
    const thinkingTokens = tokenCount(b.thinkingTokens) ?? 0;
    const totalTokens = tokenCount(b.totalTokens) ?? safeAdd(inputTokens, outputTokens);
    const requests = tokenCount(b.requests) ?? 0;
    const name = formatModelName(b.name || b.id) || 'Unknown';
    const id = normalizeModelId(b.id) || normalizeModelId(name) || 'unknown';
    return {
      id, name, role, requests,
      inputTokens, uncachedTokens, cachedTokens, cacheWriteTokens,
      outputTokens, thinkingTokens, totalTokens,
    };
  });
  models.sort((a, b) =>
    (b.totalTokens - a.totalTokens) ||
    (b.requests - a.requests) ||
    ((ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9)) ||
    a.name.localeCompare(b.name)
  );
  const capped = models.slice(0, Math.max(1, maxModels));
  let totalTokens = 0, outputTokens = 0, totalRequests = 0;
  for (const m of capped) {
    totalTokens = safeAdd(totalTokens, m.totalTokens);
    outputTokens = safeAdd(outputTokens, m.outputTokens);
    totalRequests = safeAdd(totalRequests, m.requests);
  }
  return {
    planModel: cleanPlan,
    activeModel: cleanActive,
    totalTokens,
    outputTokens,
    totalRequests,
    models: capped,
  };
}

export function safeModelUsage(value, { maxModels = 64 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.models)) return null;
  const models = [];
  const seen = new Set();
  for (const item of value.models) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = formatModelName(item.name || item.id);
    const id = normalizeModelId(item.id || name);
    if (!name || !id || seen.has(id)) continue;
    const requests = tokenCount(item.requests);
    const uncachedTokens = tokenCount(item.uncachedTokens) ?? 0;
    const cachedTokens = tokenCount(item.cachedTokens) ?? 0;
    const cacheWriteTokens = tokenCount(item.cacheWriteTokens) ?? 0;
    const inputTokens = tokenCount(item.inputTokens) ?? safeAdd(safeAdd(uncachedTokens, cachedTokens), cacheWriteTokens);
    const outputTokens = tokenCount(item.outputTokens);
    const thinkingTokens = tokenCount(item.thinkingTokens) ?? 0;
    const totalTokens = tokenCount(item.totalTokens) ?? (outputTokens !== null ? safeAdd(inputTokens, outputTokens) : null);
    if (requests === null || outputTokens === null || totalTokens === null) continue;
    const role = MODEL_ROLES.has(item.role) ? item.role : 'model';
    seen.add(id);
    models.push({
      id, name, role, requests,
      inputTokens, uncachedTokens, cachedTokens, cacheWriteTokens,
      outputTokens, thinkingTokens, totalTokens,
    });
    if (models.length >= Math.max(1, maxModels)) break;
  }
  let totalTokens = 0, outputTokens = 0, totalRequests = 0;
  for (const m of models) {
    totalTokens = safeAdd(totalTokens, m.totalTokens);
    outputTokens = safeAdd(outputTokens, m.outputTokens);
    totalRequests = safeAdd(totalRequests, m.requests);
  }
  return {
    planModel: formatModelName(value.planModel),
    activeModel: formatModelName(value.activeModel),
    totalTokens,
    outputTokens,
    totalRequests,
    models,
  };
}
export function seconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?s$/.test(value)) {
    const n = Number(value.slice(0, -1));
    return Number.isFinite(n) ? n : null;
  }
  if (value && typeof value === 'object') {
    if (value.seconds === undefined && value.nanos === undefined) return null;
    const whole = Number(value.seconds ?? 0), nanos = Number(value.nanos ?? 0);
    if (!Number.isSafeInteger(whole) || whole < 0 || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1e9) return null;
    const n = whole + nanos / 1e9;
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

export function tokenCount(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function requestCacheMetrics(usage) {
  const input = tokenCount(usage.inputTokens);
  if ((usage.cacheReadTokens !== undefined && tokenCount(usage.cacheReadTokens) === null) ||
      (usage.cacheWriteTokens !== undefined && tokenCount(usage.cacheWriteTokens) === null)) return null;
  const read = tokenCount(usage.cacheReadTokens) ?? 0;
  const write = tokenCount(usage.cacheWriteTokens) ?? 0;
  const provider = String(usage.apiProvider || '');
  if (input === null) return null;
  // Antigravity ModelUsageStats normalizes inputTokens to uncached input,
  // including Gemini (verified against live records with cacheRead > input).
  // These are NOT upstream Gemini/OpenAI prompt_tokens. Add the separate
  // cache read/write counts exactly once for this local interface.
  const total = input + read + write;
  // A tool follow-up can explicitly report zero input. It is a valid neutral
  // sample, even though an all-zero denominator cannot produce a hit ratio.
  if (!Number.isSafeInteger(total) || total < 0 || read + write > total) return null;
  // A provider label is unnecessary for a validated zero denominator: it
  // contributes neither numerator nor denominator and never invents a ratio.
  if (total > 0 && !/GOOGLE_GEMINI|OPENAI|ANTHROPIC/.test(provider)) return null;
  return { inputTokens:total, cachedTokens:read, cacheWriteTokens:write, uncachedTokens:total-read-write };
}

function unionSeconds(intervals) {
  const sorted = intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a).sort((a, b) => a[0] - b[0]);
  let total = 0, start = null, end = null;
  for (const [a, b] of sorted) {
    if (start === null) { start = a; end = b; }
    else if (a <= end) end = Math.max(end, b);
    else { total += end - start; start = a; end = b; }
  }
  if (start !== null) total += end - start;
  return total / 1000;
}

export function trajectoryMetrics(response) {
  const trajectory = response.trajectory || {};
  const generators = trajectory.generatorMetadata || [];
  const samples = [], ids = new Map(), modelBuckets = new Map();
  const steps = trajectory.steps || [];
  const counts = { input: 0, output: 0, responseOutput: 0, thinkingOutput: 0, cacheRead: 0, cacheWrite: 0 };
  let modelSeconds = 0, ttftSeconds = 0, ttftSamples = 0, missingTiming = 0;
  const cache = { inputTokens:0, cachedTokens:0, cacheWriteTokens:0, uncachedTokens:0, outputTokens:0, measuredRequests:0, missingRequests:0 };
  // Token availability is independent of cache-ratio availability. In particular,
  // a historical request may retain output usage but lack normalized input data.
  const tokens = { inputTokens:0, cachedTokens:0, cacheWriteTokens:0, uncachedTokens:0, outputTokens:0,
    measuredRequests:0, inputRequests:0, outputRequests:0, missingInputRequests:0, missingOutputRequests:0,
    uncachedRequests:0, cachedRequests:0, cacheWriteRequests:0 };
  for (const [index, generator] of generators.entries()) {
    const chat = generator.chatModel;
    if (!chat?.usage) continue;
    const usage = chat.usage;
    // IDE executionId identifies a planner run/turn, not an individual model
    // request: tool follow-ups share it while having distinct responseIds.
    // Never collapse those follow-ups, even when no request ID was returned.
    const id = usage.responseId ? `response:${usage.apiProvider||''}:${usage.responseId}`
      : usage.messageId ? `message:${usage.messageId}` : `index:${index}`;
    const signature = JSON.stringify([usage.outputTokens,usage.responseOutputTokens,usage.thinkingOutputTokens,
      seconds(chat.streamingDuration),seconds(chat.timeToFirstToken),chat.responseModel,chat.model,usage.model]);
    if (ids.has(id)) {
      const previous = ids.get(id);
      if (previous.signature !== signature && !previous.sample.reasons.includes('duplicate-scope')) previous.sample.reasons.push('duplicate-scope');
      continue;
    }
    const cached = requestCacheMetrics(usage);
    if(cached) {
      for(const key of ['inputTokens','cachedTokens','cacheWriteTokens','uncachedTokens'])cache[key]+=cached[key];
      cache.outputTokens+=tokenCount(usage.outputTokens)??0;
      cache.measuredRequests++;
    } else cache.missingRequests++;
    const output = tokenCount(usage.outputTokens);
    // These fields come from the local normalized ModelUsageStats contract,
    // not upstream prompt_tokens. Account for each readable component even
    // when another component (or the cache-ratio provider) is unavailable.
    const input = tokenCount(usage.inputTokens);
    const read = usage.cacheReadTokens === undefined && input !== null ? 0 : tokenCount(usage.cacheReadTokens);
    const write = usage.cacheWriteTokens === undefined && input !== null ? 0 : tokenCount(usage.cacheWriteTokens);
    const parts = [['uncachedTokens','uncachedRequests',input],['cachedTokens','cachedRequests',read],['cacheWriteTokens','cacheWriteRequests',write]];
    for (const [field,coverage,value] of parts) if (value !== null) {
      tokens[field] = tokens[field] === null ? null : tokenCount(tokens[field]+value);
      tokens[coverage]++;
    }
    if (input !== null && read !== null && write !== null && tokenCount(input+read+write) !== null) tokens.inputRequests++;
    else tokens.missingInputRequests++;
    if (output !== null) { tokens.outputTokens = tokens.outputTokens === null ? null : tokenCount(tokens.outputTokens+output); tokens.outputRequests++; }
    else tokens.missingOutputRequests++;
    if (parts.some(([, ,value])=>value!==null) || output !== null) tokens.measuredRequests++;
    const visible = tokenCount(usage.responseOutputTokens);
    const thinking = tokenCount(usage.thinkingOutputTokens);
    const resolvedModelName = resolveChatModelName(chat) || 'Unknown';
    const resolvedModelId = normalizeModelId(resolvedModelName) || 'unknown';
    let bucket = modelBuckets.get(resolvedModelId);
    if (!bucket) {
      bucket = {
        id: resolvedModelId, name: resolvedModelName, hasOwn: true, hasChild: false,
        requests: 0, inputTokens: 0, uncachedTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
        outputTokens: 0, thinkingTokens: 0, totalTokens: 0,
      };
      modelBuckets.set(resolvedModelId, bucket);
    }
    const bUncached = input ?? 0;
    const bCached = read ?? 0;
    const bWrite = write ?? 0;
    const bInput = safeAdd(safeAdd(bUncached, bCached), bWrite);
    const bOutput = output ?? 0;
    bucket.requests = safeAdd(bucket.requests, 1);
    bucket.uncachedTokens = safeAdd(bucket.uncachedTokens, bUncached);
    bucket.cachedTokens = safeAdd(bucket.cachedTokens, bCached);
    bucket.cacheWriteTokens = safeAdd(bucket.cacheWriteTokens, bWrite);
    bucket.inputTokens = safeAdd(bucket.inputTokens, bInput);
    bucket.outputTokens = safeAdd(bucket.outputTokens, bOutput);
    bucket.thinkingTokens = safeAdd(bucket.thinkingTokens, thinking ?? 0);
    bucket.totalTokens = safeAdd(bucket.totalTokens, safeAdd(bInput, bOutput));
    // Short thinking may finish inside TTFT before the first visible token, while
    // multi-block thought summaries end TTFT early so remaining thinking streams
    // inside streamingDuration. Align the token numerator with the actual span.
    const rawVisible = visible ?? (output !== null && thinking !== null ? Math.max(0, output - thinking) : output);
    const duration = seconds(chat.streamingDuration);
    const ttft = seconds(chat.timeToFirstToken);
    counts.input += tokenCount(usage.inputTokens) ?? 0;
    counts.output += output ?? 0;
    counts.responseOutput += rawVisible ?? 0;
    counts.thinkingOutput += thinking ?? 0;
    counts.cacheRead += tokenCount(usage.cacheReadTokens) ?? 0;
    counts.cacheWrite += tokenCount(usage.cacheWriteTokens) ?? 0;
    if (ttft !== null) { ttftSeconds += ttft; ttftSamples++; }
    modelSeconds += (ttft ?? 0) + (duration ?? 0);
    const reasons = [];
    if (['outputTokens','responseOutputTokens','thinkingOutputTokens'].some(key=>usage[key] !== undefined && tokenCount(usage[key]) === null) ||
        output !== null && (visible !== null && visible > output || thinking !== null && thinking > output ||
          visible !== null && thinking !== null && visible + thinking > output)) reasons.push('token-scope');
    // One retryInfos entry is the ordinary attempt record, not evidence of a retry.
    // Multiple differing usage records lack attempt-specific timing in this API.
    const attempts = (Array.isArray(chat.retryInfos) ? chat.retryInfos : []).filter(info=>info?.usage);
    if (attempts.length > 1 && attempts.some(info=>['outputTokens','responseOutputTokens','thinkingOutputTokens'].some(key=>
        tokenCount(info.usage[key]) !== tokenCount(usage[key])))) reasons.push('retry-scope');
    const planners = (generator.stepIndices || []).map(i=>Number.isInteger(i) && i >= 0 ? steps[i] : null)
      .filter(step=>/PLANNER_RESPONSE/.test(String(step?.type || '')));
    const hasTools = planners.some(step=>step.plannerResponse?.toolCalls?.length > 0);
    const toolOnly = planners.length > 0 && planners.every(step=>step.plannerResponse?.toolCalls?.length > 0 &&
      !String(step.plannerResponse?.response || '').trim());
    const rawBasis = visible !== null || thinking !== null ? 'response' : 'all-output';
    let responseTokens = rawVisible;
    let basis = rawBasis;
    if (!reasons.length && thinking !== null && thinking > 0 && output !== null && rawVisible !== null && duration > 0) {
      const fullRate = ttft !== null && ttft + duration > 0 ? output / (ttft + duration) : null;
      const visRate = rawVisible / duration;
      const spilled = rawVisible === 0 || (fullRate !== null && visRate < fullRate * 0.85) || (ttft === null && thinking > rawVisible && duration >= 2);
      if (spilled) {
        if (!hasTools && duration > 0 || duration >= 15 || (ttft !== null && duration >= Math.max(2, ttft * 2))) {
          responseTokens = output;
          basis = 'all-output';
        } else {
          reasons.push('token-scope');
        }
      }
    }
    const sample = { responseTokens, rawOutput: output, duration, ttft, reasons, hasTools, toolOnly,
      tps: responseTokens !== null && responseTokens > 0 && duration > 0 ? responseTokens / duration : null,
      model: chat.modelDisplayName || chat.responseModel || String(chat.model || usage.model || ''), basis,
      profile: JSON.stringify([usage.apiProvider || '',chat.responseModel || usage.model || chat.model || chat.modelDisplayName || '',rawBasis]) };
    samples.push(sample);
    ids.set(id,{signature,sample});
  }
  classifyRates(samples);
  const accepted = samples.filter(sample=>sample.status === 'ok');
  const isSettled = /IDLE|DONE|COMPLETED|CANCELLED|CANCELED|STOPPED|FAILED|ERROR/.test(String(response.status || ''));
  const isRunning = !isSettled && (/RUNNING/i.test(String(response.status || '')) || response.running === true);
  const lastChat = [...generators].reverse().find(g => g.chatModel)?.chatModel;
  const inFlightDur = seconds(lastChat?.streamingDuration);
  const hasActiveGen = isRunning && lastChat && (inFlightDur === null || inFlightDur === 0) &&
    Boolean(lastChat.chatStartMetadata?.createdAt || lastChat.timeToFirstToken !== undefined || lastChat.usage);
  const hasActiveInSamples = Boolean(hasActiveGen && lastChat?.usage);
  missingTiming = samples.filter(sample=>sample.status === 'missing' && (sample.responseTokens > 0 || sample.rawOutput > 0) && (!hasActiveInSamples || sample !== samples.at(-1))).length;
  const excludedTiming = samples.filter(sample=>sample.status === 'unreliable').length;
  const rateWarnings = samples.filter(sample=>sample.status === 'ok' && (sample.duration < 1 || sample.outlier)).length;
  const timingReasons = Object.fromEntries(RATE_REASONS.map(reason=>[reason,samples.filter(sample=>sample.reasons.includes(reason)).length]));
  const streamingSeconds = accepted.reduce((sum, s) => sum + s.duration, 0);
  const sampledTokens = accepted.reduce((sum, s) => sum + s.responseTokens, 0);
  const basisSamples = accepted.length ? accepted : samples;
  const tools = steps.filter(s => /SEARCH_WEB|BROWSE|RUN_COMMAND|COMMAND|READ|WRITE|EDIT|CODE_ACTION|TOOL|MCP|LIST|GREP|VIEW|FIND|TERMINAL/i.test(String(s.type || '')) || s.metadata?.toolCall);
  const toolSeconds = unionSeconds(tools.map(s => [Date.parse(s.metadata.startedAt || s.metadata.createdAt), Date.parse(s.metadata.completedAt)]));
  let latest = null;
  if (isRunning) {
    const completedSamples = (hasActiveInSamples && samples.length > 0) ? samples.slice(0, -1) : samples;
    latest = [...completedSamples].reverse().find(s => s.status === 'ok') ||
      [...completedSamples].reverse().find(s => s.reasons.length || s.duration > 0 || (s.rawOutput ?? 0) > 0 || (s.responseTokens ?? 0) > 0) ||
      completedSamples.at(-1) || null;
  } else {
    latest = [...samples].reverse().find(s => s.reasons.length || s.duration > 0 || (s.rawOutput ?? 0) > 0 || (s.responseTokens ?? 0) > 0) || samples.at(-1) || null;
  }
  let latestRateStatus = latest?.status ?? 'missing';
  let latestTps = latest?.status === 'ok' ? latest.tps : null;
  const inputParts=[tokens.uncachedTokens,tokens.cachedTokens,tokens.cacheWriteTokens];
  tokens.inputTokens = tokenCount(inputParts.reduce((sum,value)=>sum+(value??0),0));
  const totalTokens=tokenCount((tokens.inputTokens??0)+(tokens.outputTokens??0));
  const planModel = extractPlanModel(response);
  const lastStepModel = [...steps].reverse().find(s => typeof s?.metadata?.generatorModel === 'string' && s.metadata.generatorModel.trim())?.metadata?.generatorModel || null;
  const activeModel = resolveChatModelName(lastChat) || (latest?.model ? formatModelName(latest.model) : null) || (lastStepModel ? formatModelName(lastStepModel) : null);
  const modelUsage = buildModelUsage(modelBuckets.values(), { planModel, activeModel });
  return {
    source: 'Antigravity request metadata', status: response.status || null,
    conversationId: trajectory.cascadeId || null,
    planModel, activeModel, modelUsage,
    steps: Number(response.numTotalSteps ?? steps.length), rounds: steps.filter(s => /USER_INPUT/.test(String(s.type))).length,
    requests: ids.size, measuredRequests: accepted.length, missingTiming, excludedTiming, rateWarnings, timingReasons, rateVersion: RATE_VERSION, counts,
    tokens:{...tokens,totalTokens,
      complete:tokens.missingInputRequests===0&&tokens.missingOutputRequests===0&&inputParts.every(value=>value!==null)&&tokens.outputTokens!==null&&totalTokens!==null},
    cache:{...cache,totalTokens:cache.inputTokens+cache.outputTokens,hitRate:cache.inputTokens>0?cache.cachedTokens/cache.inputTokens:null,complete:cache.missingRequests===0},
    tps: streamingSeconds > 0 ? sampledTokens / streamingSeconds : null, latestTps,
    latestRateStatus,
    rateBasis: basisSamples.length && basisSamples.every(s => s.basis === 'response') ? 'response' : 'all-output',
    streamingSeconds, modelSeconds, toolSeconds, ttftSeconds: ttftSamples ? ttftSeconds / ttftSamples : null,
    latestShortSample: latest?.status === 'ok' && latest.duration < 1, model: latest?.model || null,
    context: contextMetrics(lastChat?.chatStartMetadata?.contextWindowMetadata || response.contextWindowUsage || trajectory.contextWindowUsage, {
      model:lastChat?.modelDisplayName || lastChat?.responseModel || String(lastChat?.model || '') || null,
      sampledAt:lastChat?.chatStartMetadata?.createdAt,
    }),
    complete: Number(response.numTotalGeneratorMetadata ?? generators.length) === generators.length,
  };
}

export function quotaMetrics(response, now = Date.now()) {
  const root = response.response || response;
  const groups = root.groups?.length ? root.groups : root.buckets?.length ? [{ displayName: '账户额度', buckets: root.buckets }] : [];
  return groups.map((group, index) => ({
    id: group.buckets?.[0]?.bucketId?.replace(/-(5h|weekly)$/, '') || `group-${index}`,
    name: group.displayName || `额度组 ${index + 1}`, description: group.description || '',
    windows: Object.fromEntries(['5h', 'weekly'].map(window => {
      const bucket = (group.buckets || []).find(b => b.window === window || b.bucketId?.endsWith(`-${window}`));
      if (!bucket) return [window, { available: false, reason: '账户未返回此额度窗口' }];
      const fraction = Number(bucket.remainingFraction);
      const remaining = bucket.remainingFraction !== undefined && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction : null;
      const date = Date.parse(bucket.resetTime);
      return [window, { available: true, id: bucket.bucketId, remaining, amount: tokenCount(bucket.remainingAmount),
        resetAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
        expired: Number.isFinite(date) && date <= now, disabled: bucket.disabled === true, description: bucket.description || '' }];
    })),
  }));
}
