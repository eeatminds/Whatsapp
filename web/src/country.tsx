import { useApi, type Settings } from './api';

/** "India", "United Arab Emirates". */
export function countryName(code: string | null | undefined): string {
  if (!code) return '';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/** 🇮🇳 for "IN". */
export function flag(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map(ch => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/** What numbers from the business's own country are called: "Indian" for India, else the country's name. */
export function useLocalLabel(): string {
  const { data } = useApi<Settings>('/api/settings');
  const home = data?.defaultCountry ?? 'IN';
  return home === 'IN' ? 'Indian' : countryName(home);
}

export type Origin = 'local' | 'international';

/** All numbers / Indian numbers / International numbers. */
export function OriginSelect({ value, onChange }: { value: Origin | undefined; onChange: (value: Origin | undefined) => void }) {
  const local = useLocalLabel();
  return (
    <select
      className="select sm"
      style={{ width: 'auto' }}
      value={value ?? ''}
      onChange={e => onChange((e.target.value || undefined) as Origin | undefined)}
      aria-label={`${local} or international numbers`}
    >
      <option value="">All numbers</option>
      <option value="local">{local} numbers</option>
      <option value="international">International numbers</option>
    </select>
  );
}
