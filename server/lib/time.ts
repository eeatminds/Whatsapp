/** Time-zone helpers built on Intl, so no tz database dependency is needed. */

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of the zone from UTC at the given instant, in milliseconds. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Minutes since local midnight in the zone. */
export function localMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

/** "YYYY-MM-DD" of the date in the zone. */
export function localDateKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The UTC instant at which the local day containing `date` began. */
export function startOfLocalDay(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  const guess = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  // Correct by the offset in force at the guessed instant (handles DST days).
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - offset);
}

export function parseHhMm(value: string): number | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Whether `date` falls inside the quiet window [start, end) in the zone. Windows may wrap past
 * midnight ("21:00"-"09:00"). An empty window (start === end) is never quiet.
 */
export function isQuietTime(date: Date, timeZone: string, start: string, end: string): boolean {
  const s = parseHhMm(start);
  const e = parseHhMm(end);
  if (s === null || e === null || s === e) return false;
  const now = localMinutes(date, timeZone);
  return s < e ? now >= s && now < e : now >= s || now < e;
}

/** Minutes until the quiet window ends (0 when not quiet). Used to tell the user when sending resumes. */
export function minutesUntilQuietEnds(date: Date, timeZone: string, start: string, end: string): number {
  if (!isQuietTime(date, timeZone, start, end)) return 0;
  const e = parseHhMm(end)!;
  const now = localMinutes(date, timeZone);
  return (e - now + 24 * 60) % (24 * 60);
}
