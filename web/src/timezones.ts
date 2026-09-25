/**
 * Time zone choices for dropdowns: every IANA zone the browser knows, labelled with its current GMT
 * offset and name, e.g. "(GMT+05:30) Kolkata, Asia — India Standard Time", sorted by offset.
 */

export interface TimeZoneOption {
  id: string;
  label: string;
  offsetMinutes: number;
}

/** Browsers still list some zones under their old names; show the names people know today. */
const MODERN_NAMES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv',
  'America/Godthab': 'America/Nuuk',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
  'Pacific/Enderbury': 'Pacific/Kanton',
};

const FALLBACK = ['UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York'];

function isValid(id: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: id });
    return true;
  } catch {
    return false;
  }
}

function zonePart(id: string, style: 'longOffset' | 'long', at: Date): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: style }).formatToParts(at).find(p => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** Minutes east of GMT right now (so daylight saving is reflected). */
export function offsetMinutes(id: string, at = new Date()): number {
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(zonePart(id, 'longOffset', at));
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === '-' ? -minutes : minutes;
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `GMT${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function describe(id: string, at: Date): TimeZoneOption {
  const offset = offsetMinutes(id, at);
  if (id === 'UTC') return { id, offsetMinutes: 0, label: `(${formatOffset(0)}) UTC — Coordinated Universal Time` };
  const parts = id.split('/');
  const city = parts[parts.length - 1].replace(/_/g, ' ');
  const region = parts.length > 1 ? parts[0].replace(/_/g, ' ') : '';
  const name = zonePart(id, 'long', at);
  // Some zones have no proper name and just repeat the offset ("GMT+05:45"); leave that out.
  const showName = name && !/^GMT([+-]|$)/.test(name);
  return {
    id,
    offsetMinutes: offset,
    label: `(${formatOffset(offset)}) ${city}${region ? `, ${region}` : ''}${showName ? ` — ${name}` : ''}`,
  };
}

let cache: TimeZoneOption[] | null = null;

export function timeZoneOptions(): TimeZoneOption[] {
  if (cache) return cache;
  let ids: string[];
  try {
    ids = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    ids = FALLBACK;
  }
  const at = new Date();
  const unique = new Set<string>(['UTC']);
  for (const id of ids) {
    const modern = MODERN_NAMES[id];
    unique.add(modern && isValid(modern) ? modern : id);
  }
  cache = [...unique]
    .filter(isValid)
    .map(id => describe(id, at))
    .sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.label.localeCompare(b.label));
  return cache;
}

/** The zones most people pick: this computer's, India, and the one already saved. */
export function suggestedTimeZones(current: string): TimeZoneOption[] {
  const all = timeZoneOptions();
  let local = '';
  try {
    local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // ignore
  }
  const at = new Date();
  const ids = [...new Set([current, MODERN_NAMES[local] ?? local, 'Asia/Kolkata'].filter(Boolean))];
  return ids.filter(isValid).map(id => all.find(o => o.id === id) ?? describe(id, at));
}
