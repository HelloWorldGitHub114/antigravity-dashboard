export interface DateTimeParts {
  date: string;
  hour: number;
}

/**
 * Formats a timestamp into calendar date (`YYYY-MM-DD`) and 0-23 hour in `zone`.
 */
export function dateTimeParts(time: number | Date, zone = 'Asia/Shanghai'): DateTimeParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(time);
  const get = (key: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((p) => p.type === key)?.value;
  const num = Number.parseInt(get('hour') ?? '', 10);
  return {
    date: `${get('year') ?? ''}-${get('month') ?? ''}-${get('day') ?? ''}`,
    hour: Number.isInteger(num) && num >= 0 && num <= 23 ? num : 0,
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
