import {
  diffSessionSnapshots,
  type SessionDescriptorInput,
  type SessionDiffItem,
  type SnapshotDiffOutput,
  type SnapshotStatusKind,
  type SnapshotTransition,
} from '../platform/native-bridge.ts';

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x0100000001b3n;
const U64_MASK = 0xffffffffffffffffn;
const UTF8 = new TextEncoder();

const RUNNING_STATUS_RE = /(?:RUNNING|GENERATING|WAITING|QUEUED)/i;
const SETTLED_STATUS_RE = /(?:IDLE|DONE|COMPLETED|CANCELLED|CANCELED|STOPPED|FAILED|ERROR)/i;

function fnv1aByte(hash: bigint, byte: number): bigint {
  return ((hash ^ BigInt(byte & 0xff)) * FNV_PRIME) & U64_MASK;
}

function fnv1aU64Le(hash: bigint, value: bigint): bigint {
  let v = BigInt.asUintN(64, value);
  for (let i = 0; i < 8; i++) {
    hash = ((hash ^ (v & 0xffn)) * FNV_PRIME) & U64_MASK;
    v >>= 8n;
  }
  return hash;
}

function fnv1aI32Le(hash: bigint, value: number): bigint {
  let v = value | 0;
  for (let i = 0; i < 4; i++) {
    hash = ((hash ^ BigInt(v & 0xff)) * FNV_PRIME) & U64_MASK;
    v >>= 8;
  }
  return hash;
}

function fnv1aU32Le(hash: bigint, value: number): bigint {
  let v = value >>> 0;
  for (let i = 0; i < 4; i++) {
    hash = ((hash ^ BigInt(v & 0xff)) * FNV_PRIME) & U64_MASK;
    v >>>= 8;
  }
  return hash;
}

/**
 * Pure-TS 64-bit FNV-1a fingerprint matching `snapshot_diff.rs` bit-for-bit.
 */
export function computeSessionFingerprintHex(
  mtimeMs: number,
  sizeBytes: number,
  stepCount: number,
  lastUserInputStepIndex: number,
  status: string,
): string {
  const safeMtime = Number.isFinite(mtimeMs) ? Math.trunc(mtimeMs) : 0;
  const safeSize = Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.trunc(sizeBytes) : 0;
  const safeSteps = Number.isFinite(stepCount) ? Math.trunc(stepCount) : 0;
  const safeUserIdx = Number.isFinite(lastUserInputStepIndex) ? Math.trunc(lastUserInputStepIndex) : -1;
  const statusBytes = UTF8.encode(typeof status === 'string' ? status : '');

  let hash = FNV_OFFSET_BASIS;
  hash = fnv1aU64Le(hash, BigInt(safeMtime));
  hash = fnv1aByte(hash, 0xff);
  hash = fnv1aU64Le(hash, BigInt(safeSize));
  hash = fnv1aByte(hash, 0xff);
  hash = fnv1aI32Le(hash, safeSteps);
  hash = fnv1aByte(hash, 0xff);
  hash = fnv1aI32Le(hash, safeUserIdx);
  hash = fnv1aByte(hash, 0xff);
  hash = fnv1aU32Le(hash, statusBytes.length);
  for (let i = 0; i < statusBytes.length; i++) {
    hash = ((hash ^ BigInt(statusBytes[i])) * FNV_PRIME) & U64_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Classifies a conversation status string into `running`, `settled`, or `unknown`.
 */
export function classifySnapshotStatus(status: string): SnapshotStatusKind {
  if (RUNNING_STATUS_RE.test(status)) return 'running';
  if (SETTLED_STATUS_RE.test(status)) return 'settled';
  return 'unknown';
}

/**
 * Pure-TS fallback implementation of `diffSessionSnapshots` when native acceleration
 * is unavailable or disabled via `PULSE_DISABLE_NATIVE_ACCEL=1`.
 */
export function diffSessionSnapshotsFallback(
  inputs: readonly SessionDescriptorInput[],
): SnapshotDiffOutput {
  const dirtyIds: string[] = [];
  const newlySettledIds: string[] = [];
  const runningIds: string[] = [];
  const items: SessionDiffItem[] = new Array(inputs.length);

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const status = typeof input.status === 'string' ? input.status : '';
    const sizeBytes = Number.isFinite(input.sizeBytes) && input.sizeBytes > 0 ? Math.trunc(input.sizeBytes) : 0;
    const fingerprint = computeSessionFingerprintHex(
      input.mtimeMs,
      sizeBytes,
      input.stepCount,
      input.lastUserInputStepIndex,
      status,
    );
    const statusKind = classifySnapshotStatus(status);
    const isRunning = statusKind === 'running';
    const isSettled = statusKind === 'settled';
    const prevFp = input.prevFingerprint ?? null;
    const fpChanged = prevFp !== fingerprint;

    let transition: SnapshotTransition;
    if (prevFp === null) {
      transition = 'newly_discovered';
    } else if (input.prevSettled === false && isSettled) {
      transition = 'newly_settled';
    } else if (fpChanged) {
      transition = 'modified';
    } else {
      transition = 'unchanged';
    }

    const needsPoll = isRunning || fpChanged;
    const preferSqlite = sizeBytes > 0 && !isRunning;

    if (isRunning) runningIds.push(input.cascadeId);
    if (transition === 'newly_settled') newlySettledIds.push(input.cascadeId);
    if (needsPoll || transition === 'newly_settled') dirtyIds.push(input.cascadeId);

    items[i] = {
      cascadeId: input.cascadeId,
      fingerprint,
      statusKind,
      transition,
      needsPoll,
      preferSqlite,
    };
  }

  return { dirtyIds, newlySettledIds, runningIds, items };
}

/**
 * Runs native Rust `diffSessionSnapshots` when available, transparently falling back
 * to the exact pure-TS implementation otherwise.
 */
export function diffSessionSnapshotsWithFallback(
  inputs: readonly SessionDescriptorInput[],
): SnapshotDiffOutput {
  return diffSessionSnapshots(inputs) ?? diffSessionSnapshotsFallback(inputs);
}

/**
 * Parses an optional ISO timestamp string into epoch milliseconds, returning `0` when absent/invalid.
 */
export function parseSummaryMtimeMs(modifiedAt: string | undefined): number {
  if (typeof modifiedAt !== 'string' || !modifiedAt) return 0;
  const ms = Date.parse(modifiedAt);
  return Number.isFinite(ms) ? Math.trunc(ms) : 0;
}
