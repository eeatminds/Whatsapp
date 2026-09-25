const numberFormat = new Intl.NumberFormat();
const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function formatNumber(n: number | null | undefined): string {
  return numberFormat.format(n ?? 0);
}

export function compact(n: number): string {
  return Math.abs(n) >= 10_000 ? compactFormat.format(n) : numberFormat.format(n);
}

export function percent(part: number, whole: number, digits = 0): string {
  if (!whole) return '–';
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

export function formatPhone(phone: string): string {
  // Light grouping for readability; the stored value is always E.164 digits.
  if (phone.startsWith('91') && phone.length === 12) return `+91 ${phone.slice(2, 7)} ${phone.slice(7)}`;
  if (phone.startsWith('1') && phone.length === 11) return `+1 ${phone.slice(1, 4)} ${phone.slice(4, 7)} ${phone.slice(7)}`;
  return `+${phone}`;
}

export function displayName(contact: { name: string | null; phone: string }): string {
  return contact.name?.trim() || formatPhone(contact.phone);
}

export function initials(name: string | null, phone: string): string {
  const source = name?.trim();
  if (!source) return phone.slice(-2);
  const parts = source.split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  const units: Array<[number, string]> = [
    [86_400_000 * 365, 'y'],
    [86_400_000 * 30, 'mo'],
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
  ];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const value = Math.floor(abs / ms);
      return future ? `in ${value}${label}` : `${value}${label} ago`;
    }
  }
  return future ? 'in a moment' : 'just now';
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${days} d ${h} h` : `${days} d`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Local datetime-input value ("2026-09-25T14:30") <-> ISO. */
export function toLocalInput(iso: string | null): string {
  const date = iso ? new Date(iso) : new Date(Date.now() + 3_600_000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}

export const CONSENT_LABEL: Record<string, string> = {
  opted_in: 'Opted in',
  unknown: 'No consent recorded',
  opted_out: 'Opted out',
};

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}
