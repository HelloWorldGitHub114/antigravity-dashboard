import type { TaskUsageSummary, TranscriptStats } from '../../contracts/metrics.ts';

export type ComparableTranscriptStats = TranscriptStats | Record<string, unknown> | null | undefined;
export type ComparableTaskUsage = TaskUsageSummary | Record<string, unknown> | null | undefined;

/**
 * Allocation-free structural equality for JSON-like values (plain objects,
 * arrays, primitives). Undefined object properties are treated as omitted.
 */
export function samePlainValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  const isArrayA = Array.isArray(a);
  if (isArrayA !== Array.isArray(b)) return false;
  if (isArrayA) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i++) {
      if (!samePlainValue(arrA[i], arrB[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  let countA = 0;
  for (const key in objA) {
    if (!Object.hasOwn(objA, key)) continue;
    const va = objA[key];
    if (va === undefined) continue;
    countA++;
    if (!Object.hasOwn(objB, key) || !samePlainValue(va, objB[key])) return false;
  }
  let countB = 0;
  for (const key in objB) {
    if (!Object.hasOwn(objB, key)) continue;
    if (objB[key] !== undefined) countB++;
  }
  return countA === countB;
}

/**
 * Lightweight exact equality for `transcriptStats` snapshots without `JSON.stringify`.
 */
export function sameTranscriptStats(a: ComparableTranscriptStats, b: ComparableTranscriptStats): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const lhs = a as Partial<TranscriptStats>;
  const rhs = b as Partial<TranscriptStats>;
  if (
    lhs.version !== rhs.version ||
    lhs.status !== rhs.status ||
    lhs.reason !== rhs.reason ||
    lhs.complete !== rhs.complete ||
    lhs.totalTokens !== rhs.totalTokens ||
    lhs.matchedSteps !== rhs.matchedSteps
  ) {
    return false;
  }
  return samePlainValue(a, b);
}

/**
 * Lightweight exact equality for `taskUsage` snapshots without `JSON.stringify`.
 */
export function sameTaskUsage(a: ComparableTaskUsage, b: ComparableTaskUsage): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const lhs = a as Partial<TaskUsageSummary>;
  const rhs = b as Partial<TaskUsageSummary>;
  if (
    lhs.state !== rhs.state ||
    lhs.complete !== rhs.complete ||
    lhs.subagents !== rhs.subagents ||
    lhs.loadedSubagents !== rhs.loadedSubagents ||
    lhs.ownTokens !== rhs.ownTokens ||
    lhs.subagentTokens !== rhs.subagentTokens ||
    lhs.truncated !== rhs.truncated ||
    lhs.error !== rhs.error ||
    lhs.tokens?.totalTokens !== rhs.tokens?.totalTokens ||
    lhs.tokens?.complete !== rhs.tokens?.complete ||
    lhs.cache?.totalTokens !== rhs.cache?.totalTokens ||
    lhs.items?.length !== rhs.items?.length ||
    lhs.modelUsage?.totalTokens !== rhs.modelUsage?.totalTokens ||
    lhs.modelUsage?.models?.length !== rhs.modelUsage?.models?.length
  ) {
    return false;
  }
  return samePlainValue(a, b);
}

/**
 * Fast equality check for optional ordered string arrays.
 */
export function sameStringList(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a?.length && !b?.length) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
