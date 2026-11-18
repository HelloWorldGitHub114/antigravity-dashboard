import type { LedgerTzTransition } from '../../platform/native-bridge.ts';

export interface DateTimeParts {
  date: string;
  hour: number;
}

export interface TimeZoneSpec {
  fixedOffsetSecs: number | null;
  tzMinMs: number | null;
  tzMaxMs: number | null;
  tzTransitions: LedgerTzTransition[] | null;
}

const UTC_ZONES = new Set(['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT']);
const UTC8_MODERN_ZONES = new Set([
  'Asia/Shanghai',
  'Asia/Chongqing',
  'Asia/Harbin',
  'Asia/Taipei',
  'Asia/Hong_Kong',
  'Asia/Singapore',
]);
const UTC9_MODERN_ZONES = new Set(['Asia/Tokyo', 'Asia/Seoul']);
const MODERN_FIXED_MIN_MS = Date.UTC(1992, 0, 1);

const UTC_SPEC: TimeZoneSpec = { fixedOffsetSecs: 0, tzMinMs: null, tzMaxMs: null, tzTransitions: null };
const UTC8_SPEC: TimeZoneSpec = { fixedOffsetSecs: 28800, tzMinMs: MODERN_FIXED_MIN_MS, tzMaxMs: null, tzTransitions: null };
const UTC9_SPEC: TimeZoneSpec = { fixedOffsetSecs: 32400, tzMinMs: MODERN_FIXED_MIN_MS, tzMaxMs: null, tzTransitions: null };

const tzTransitionCache = new Map<string, TimeZoneSpec>();
const defaultZoneSpecCache = new Map<string, TimeZoneSpec>();
const dtfCache = new Map<string, Intl.DateTimeFormat>();
const offsetDtfCache = new Map<string, Intl.DateTimeFormat>();

const PAD2: readonly string[] = Array.from({ length: 100 }, (_, i) =>
  i < 10 ? `0${i}` : String(i),
);

let cachedDayNum = Number.NaN;
let cachedDayStr = '';

function getDateTimeFormatter(zone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(zone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      hourCycle: 'h23',
    });
    dtfCache.set(zone, dtf);
  }
  return dtf;
}

function getOffsetFormatter(zone: string): Intl.DateTimeFormat {
  let dtf = offsetDtfCache.get(zone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    offsetDtfCache.set(zone, dtf);
  }
  return dtf;
}

/**
 * Resolves a timezone into a fixed-offset fast spec or a cached DST transition
 * table covering `[min(2020, nowYear-2), max(2031, nowYear+2))`.
 */
export function resolveTimeZoneSpec(zone: string, nowMs: number = Date.now()): TimeZoneSpec {
  if (UTC_ZONES.has(zone)) return UTC_SPEC;
  if (UTC8_MODERN_ZONES.has(zone)) return UTC8_SPEC;
  if (UTC9_MODERN_ZONES.has(zone)) return UTC9_SPEC;

  const nowYear = new Date(nowMs).getUTCFullYear();
  const minYear = Math.min(2020, nowYear - 2);
  const maxYear = Math.max(2031, nowYear + 2);
  const cacheKey = `${zone}:${minYear}:${maxYear}`;
  const cached = tzTransitionCache.get(cacheKey);
  if (cached) return cached;

  const minMs = Date.UTC(minYear, 0, 1);
  const maxMs = Date.UTC(maxYear, 0, 1);
  const dtf = getOffsetFormatter(zone);
  const offsetAt = (ms: number): number => {
    const parts = dtf.formatToParts(ms);
    let y = 1970;
    let m = 1;
    let d = 1;
    let h = 0;
    let min = 0;
    let s = 0;
    for (const p of parts) {
      if (p.type === 'year') y = Number.parseInt(p.value, 10);
      else if (p.type === 'month') m = Number.parseInt(p.value, 10);
      else if (p.type === 'day') d = Number.parseInt(p.value, 10);
      else if (p.type === 'hour') h = Number.parseInt(p.value, 10);
      else if (p.type === 'minute') min = Number.parseInt(p.value, 10);
      else if (p.type === 'second') s = Number.parseInt(p.value, 10);
    }
    const localSec = Math.floor(Date.UTC(y, m - 1, d, h, min, s) / 1000);
    const utcSec = Math.floor(ms / 1000);
    return localSec - utcSec;
  };

  const stepMs = 7 * 86400 * 1000;
  let curMs = minMs;
  let curOff = offsetAt(curMs);
  const transitions: LedgerTzTransition[] = [{ atMs: minMs, offsetSecs: curOff }];
  while (curMs < maxMs) {
    const nextMs = Math.min(maxMs, curMs + stepMs);
    const nextOff = offsetAt(nextMs);
    if (nextOff !== curOff) {
      let loSec = Math.floor(curMs / 1000);
      let hiSec = Math.floor(nextMs / 1000);
      while (loSec + 1 < hiSec) {
        const midSec = Math.floor((loSec + hiSec) / 2);
        if (offsetAt(midSec * 1000) === curOff) loSec = midSec;
        else hiSec = midSec;
      }
      curOff = nextOff;
      transitions.push({ atMs: hiSec * 1000, offsetSecs: curOff });
    }
    curMs = nextMs;
  }

  const spec: TimeZoneSpec = {
    fixedOffsetSecs: null,
    tzMinMs: minMs,
    tzMaxMs: maxMs,
    tzTransitions: transitions,
  };
  tzTransitionCache.set(cacheKey, spec);
  return spec;
}

function lookupTransitionOffset(transitions: readonly LedgerTzTransition[], ms: number): number {
  let lo = 0;
  let hi = transitions.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (transitions[mid].atMs <= ms) lo = mid;
    else hi = mid - 1;
  }
  return transitions[lo].offsetSecs;
}

function formatCivilDateFromDays(days: number): string {
  if (days === cachedDayNum) return cachedDayStr;
  // Howard Hinnant civil_from_days
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const year = y + (m <= 2 ? 1 : 0);
  const yyyy = year >= 0 && year <= 9999 ? String(year).padStart(4, '0') : String(year);
  const date = `${yyyy}-${PAD2[m]}-${PAD2[d]}`;
  cachedDayNum = days;
  cachedDayStr = date;
  return date;
}

function partsFromOffset(ms: number, offsetSecs: number): DateTimeParts {
  const shiftedSec = Math.floor(ms / 1000) + offsetSecs;
  const days = Math.floor(shiftedSec / 86400);
  const secOfDay = shiftedSec - days * 86400;
  return {
    date: formatCivilDateFromDays(days),
    hour: Math.floor(secOfDay / 3600),
  };
}

/**
 * Formats a timestamp into calendar date (`YYYY-MM-DD`) and 0-23 hour in `zone`.
 */
export function dateTimeParts(time: number | Date, zone = 'Asia/Shanghai'): DateTimeParts {
  const rawMs = time instanceof Date ? time.getTime() : time;
  if (Number.isFinite(rawMs)) {
    const ms = Math.trunc(rawMs);
    if (UTC_ZONES.has(zone)) {
      return partsFromOffset(ms, 0);
    }
    if (UTC8_MODERN_ZONES.has(zone)) {
      if (ms >= MODERN_FIXED_MIN_MS) return partsFromOffset(ms, 28800);
    } else if (UTC9_MODERN_ZONES.has(zone)) {
      if (ms >= MODERN_FIXED_MIN_MS) return partsFromOffset(ms, 32400);
    } else {
      let spec = defaultZoneSpecCache.get(zone);
      if (!spec) {
        spec = resolveTimeZoneSpec(zone);
        defaultZoneSpecCache.set(zone, spec);
      }
      if (
        spec.tzTransitions &&
        spec.tzTransitions.length > 0 &&
        spec.tzMinMs !== null &&
        spec.tzMaxMs !== null &&
        ms >= spec.tzMinMs &&
        ms < spec.tzMaxMs
      ) {
        return partsFromOffset(ms, lookupTransitionOffset(spec.tzTransitions, ms));
      }
    }
  }

  const parts = getDateTimeFormatter(zone).formatToParts(time);
  let year = '';
  let month = '';
  let day = '';
  let hour = 0;
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
    else if (p.type === 'hour') {
      const num = Number.parseInt(p.value, 10);
      if (Number.isInteger(num) && num >= 0 && num <= 23) hour = num;
    }
  }
  return {
    date: `${year}-${month}-${day}`,
    hour,
  };
}

/**
 * Returns the `YYYY-MM-DD` date key for `time` in `zone`.
 */
export function dateKey(time: number | Date, zone = 'Asia/Shanghai'): string {
  return dateTimeParts(time, zone).date;
}

/**
 * Returns the 0-23 hour key for `time` in `zone`.
 */
export function hourKey(time: number | Date, zone = 'Asia/Shanghai'): number {
  return dateTimeParts(time, zone).hour;
}

/**
 * Returns the Monday (`YYYY-MM-DD`) starting the ISO week containing `date`.
 */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
