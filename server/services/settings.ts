import { z } from 'zod';
import type { Db } from '../db/database.js';
import { parseJson } from '../db/database.js';
import { isValidTimeZone, parseHhMm } from '../lib/time.js';

const hhmm = z.string().refine(v => parseHhMm(v) !== null, 'Use 24-hour HH:MM');
const keywordList = z
  .array(z.string().trim().min(1).max(40))
  .max(30)
  .transform(list => [...new Set(list.map(k => k.toUpperCase()))]);

export const settingsSchema = z.object({
  businessName: z.string().trim().max(80),
  timezone: z.string().refine(isValidTimeZone, 'Unknown IANA time zone'),
  defaultCountry: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'Two-letter ISO country code')
    .transform(v => v.toUpperCase()),
  defaultSessionId: z.string().nullable(),
  quietHours: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }),
  sending: z.object({
    /** Hard ceiling per WhatsApp number, across every campaign and sequence sharing it. */
    sessionMaxPerMinute: z.number().int().min(1).max(60),
    /** Marketing sends (campaigns + sequences) per number per local day. Replies don't count. */
    dailyCapPerSession: z.number().int().min(1).max(100_000),
    /** Skip a campaign recipient who got any marketing message within this many hours (0 = off). */
    frequencyCapHours: z.number().int().min(0).max(24 * 30),
    /** Consecutive send failures after which a campaign pauses itself. */
    breakerThreshold: z.number().int().min(1).max(100),
    defaultPerMinute: z.number().int().min(1).max(60),
  }),
  compliance: z.object({
    optOutKeywords: keywordList,
    optInKeywords: keywordList,
    optOutReply: z.string().max(1000),
    optInReply: z.string().max(1000),
    optOutFooter: z.string().max(200),
  }),
  /** A reply within this many hours of a campaign message counts as a reply to that campaign. */
  attributionWindowHours: z.number().int().min(1).max(24 * 30),
});

export type Settings = z.infer<typeof settingsSchema>;

export function defaultSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const tz = env.DEFAULT_TIMEZONE && isValidTimeZone(env.DEFAULT_TIMEZONE) ? env.DEFAULT_TIMEZONE : 'Asia/Kolkata';
  const country = env.DEFAULT_COUNTRY && /^[A-Za-z]{2}$/.test(env.DEFAULT_COUNTRY) ? env.DEFAULT_COUNTRY.toUpperCase() : 'IN';
  return {
    businessName: '',
    timezone: tz,
    defaultCountry: country,
    defaultSessionId: null,
    quietHours: { enabled: true, start: '21:00', end: '09:00' },
    sending: {
      sessionMaxPerMinute: 10,
      dailyCapPerSession: 250,
      frequencyCapHours: 0,
      breakerThreshold: 5,
      defaultPerMinute: 6,
    },
    compliance: {
      optOutKeywords: ['STOP', 'UNSUBSCRIBE', 'STOPALL', 'CANCEL', 'OPT OUT', 'OPTOUT'],
      optInKeywords: ['START', 'SUBSCRIBE', 'JOIN', 'OPT IN', 'OPTIN'],
      optOutReply: "You've been unsubscribed and won't receive marketing messages from us. Reply START to subscribe again.",
      optInReply: "You're subscribed! You'll receive updates from us here. Reply STOP anytime to unsubscribe.",
      optOutFooter: 'Reply STOP to unsubscribe.',
    },
    attributionWindowHours: 72,
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

function mergeDeep<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch || typeof patch !== 'object') return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = mergeDeep(current, value as DeepPartial<typeof current>);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

export class SettingsService {
  private cache: Settings | null = null;

  constructor(
    private readonly db: Db,
    private readonly defaults: Settings = defaultSettings(),
  ) {}

  get(): Settings {
    if (this.cache) return this.cache;
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'app'");
    const stored = parseJson<DeepPartial<Settings>>(row?.value, {});
    const merged = mergeDeep(this.defaults, stored);
    // A stored document from an older version could fail today's schema; fall back per field.
    const parsed = settingsSchema.safeParse(merged);
    this.cache = parsed.success ? parsed.data : this.defaults;
    return this.cache;
  }

  update(patch: unknown): Settings {
    const next = settingsSchema.parse(mergeDeep(this.get(), patch as DeepPartial<Settings>));
    this.db.run(
      "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      JSON.stringify(next),
    );
    this.cache = next;
    return next;
  }
}
