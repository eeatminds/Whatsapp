import { z } from 'zod';
import type { Core } from '../context.js';
import { nowIso } from '../db/database.js';
import { badRequest } from '../lib/errors.js';
import { localDateKey, startOfLocalDay } from '../lib/time.js';
import type { SettingsService } from './settings.js';
import type { ContactsService } from './contacts.js';
import type { MessagesService } from './messages.js';
import { MARKETING_SOURCES } from './messages.js';

export interface DailyPoint {
  date: string;
  sent: number;
  delivered: number;
  read: number;
  received: number;
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date like 2026-11-18');
/** Either the last `days` days (today included), or the days from `from` to `to`. */
export const dashboardRangeSchema = z.object({ days: z.coerce.number().int().min(1).max(366).optional(), from: ymd.optional(), to: ymd.optional() });

/** Who sent the business's outgoing messages, in the words the dashboard uses. */
const SENDERS: Record<string, 'inbox' | 'autoReply' | 'phone' | 'marketing' | 'other'> = {
  manual: 'inbox',
  auto_reply: 'autoReply',
  phone: 'phone',
  campaign: 'marketing',
  sequence: 'marketing',
};

/** "2026-11-05" plus some days, as a date (no time zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export class AnalyticsService {
  constructor(
    private readonly core: Core,
    private readonly settings: SettingsService,
    private readonly contacts: ContactsService,
    private readonly messages: MessagesService,
  ) {}

  /** UTC instant at which the local day `date` (+ `add` days) starts in the business's time zone. */
  private dayStart(date: string, add = 0): string {
    const [y, m, d] = date.split('-').map(Number);
    return startOfLocalDay(new Date(Date.UTC(y, m - 1, d + add, 12)), this.settings.get().timezone).toISOString();
  }

  /**
   * The chosen days (default: the last 14, today included) and the same number of days just before,
   * for "vs before" comparisons. Dates are the business's own calendar days.
   */
  range(input: unknown): { from: string; to: string; days: number; previous: { from: string; to: string } } {
    const q = dashboardRangeSchema.parse(input ?? {});
    const today = localDateKey(this.core.clock(), this.settings.get().timezone);
    const to = q.to ?? today;
    const from = q.from ?? addDays(to, -((q.days ?? 14) - 1));
    const days = daysBetween(from, to) + 1;
    if (days < 1) throw badRequest('The start date is after the end date');
    if (days > 366) throw badRequest('Choose a year or less');
    return { from, to, days, previous: { from: addDays(from, -days), to: addDays(from, -1) } };
  }

  /**
   * WhatsApp messages, contacts and chats for the dashboard over a range of days. Leads, calls and
   * the team come from their own reports, so every page agrees.
   */
  dashboard(range: { from: string; to: string; days: number; previous: { from: string; to: string } }) {
    const tz = this.settings.get().timezone;
    const start = this.dayStart(range.from);
    const end = this.dayStart(range.to, 1);
    const prevStart = this.dayStart(range.previous.from);

    const series = new Map<string, DailyPoint>();
    for (let i = 0; i < range.days; i++) {
      const date = addDays(range.from, i);
      series.set(date, { date, sent: 0, delivered: 0, read: 0, received: 0 });
    }
    const totals = { sent: 0, delivered: 0, read: 0, failed: 0, received: 0 };
    const senders = { inbox: 0, autoReply: 0, phone: 0, marketing: 0, other: 0 };
    const rows = this.core.db.all<{ created_at: string; direction: string; status: string; source_type: string }>(
      'SELECT created_at, direction, status, source_type FROM messages WHERE created_at >= ? AND created_at < ?',
      start,
      end,
    );
    for (const row of rows) {
      const point = series.get(localDateKey(new Date(row.created_at), tz));
      if (row.direction === 'in') {
        totals.received++;
        if (point) point.received++;
        continue;
      }
      totals.sent++;
      senders[SENDERS[row.source_type] ?? 'other']++;
      if (point) point.sent++;
      if (row.status === 'delivered' || row.status === 'read') {
        totals.delivered++;
        if (point) point.delivered++;
      }
      if (row.status === 'read') {
        totals.read++;
        if (point) point.read++;
      }
      if (row.status === 'failed') totals.failed++;
    }
    const before = this.core.db.get<{ sent: number | null; received: number | null }>(
      "SELECT SUM(direction = 'out') AS sent, SUM(direction = 'in') AS received FROM messages WHERE created_at >= ? AND created_at < ?",
      prevStart,
      start,
    );
    const consent = this.core.db.get<{ optedIn: number | null; optedOut: number | null }>(
      `SELECT SUM(consent = 'opted_in') AS optedIn, SUM(consent = 'opted_out') AS optedOut
         FROM contacts WHERE saved = 1 AND consent_at >= ? AND consent_at < ?`,
      start,
      end,
    );

    const stats = this.contacts.stats();
    const added = this.core.db.get<{ now: number | null; before: number | null }>(
      'SELECT SUM(created_at >= ? AND created_at < ?) AS now, SUM(created_at >= ? AND created_at < ?) AS before FROM contacts WHERE saved = 1',
      start,
      end,
      prevStart,
      start,
    );

    // Chats: people who wrote in during the days; "waiting" when their chat's last message is still theirs.
    const chats = this.core.db.get<{ conversations: number; waiting: number | null }>(
      `SELECT COUNT(*) AS conversations, SUM(last_direction = 'in') AS waiting FROM (
         SELECT m.contact_id,
                (SELECT x.direction FROM messages x WHERE x.contact_id = m.contact_id ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS last_direction
           FROM messages m
          WHERE m.direction = 'in' AND m.contact_id IS NOT NULL AND m.created_at >= ? AND m.created_at < ?
          GROUP BY m.contact_id)`,
      start,
      end,
    );

    return {
      messages: {
        ...totals,
        before: { sent: before?.sent ?? 0, received: before?.received ?? 0 },
        optedIn: consent?.optedIn ?? 0,
        optedOut: consent?.optedOut ?? 0,
        senders,
        series: [...series.values()],
      },
      contacts: {
        total: stats.total,
        onWhatsApp: stats.valid,
        notOnWhatsApp: stats.invalid,
        unchecked: stats.total - stats.valid - stats.invalid,
        added: added?.now ?? 0,
        addedBefore: added?.before ?? 0,
      },
      chats: {
        conversations: chats?.conversations ?? 0,
        waiting: chats?.waiting ?? 0,
        unread: this.messages.unreadCount(),
      },
      today: this.today(),
    };
  }

  /** Messages so far today (marketing ones count against each number's daily limit). */
  private today() {
    const now = this.core.clock();
    const todayStart = nowIso(startOfLocalDay(now, this.settings.get().timezone));
    const today = this.core.db.get<{ marketing: number | null }>(
      `SELECT SUM(direction = 'out' AND source_type IN ${MARKETING_SOURCES}) AS marketing FROM messages WHERE created_at >= ?`,
      todayStart,
    );
    return { marketingSent: today?.marketing ?? 0, dailyCap: this.settings.get().sending.dailyCapPerSession };
  }

  overview(days = 14) {
    const settings = this.settings.get();
    const tz = settings.timezone;
    const now = this.core.clock();
    const since = startOfLocalDay(new Date(now.getTime() - (days - 1) * 86_400_000), tz);

    const rows = this.core.db.all<{ created_at: string; direction: string; status: string; source_type: string }>(
      `SELECT created_at, direction, status, source_type FROM messages WHERE created_at >= ?`,
      nowIso(since),
    );
    const series = new Map<string, DailyPoint>();
    for (let i = 0; i < days; i++) {
      const key = localDateKey(new Date(since.getTime() + i * 86_400_000 + 12 * 3_600_000), tz);
      series.set(key, { date: key, sent: 0, delivered: 0, read: 0, received: 0 });
    }
    for (const row of rows) {
      const point = series.get(localDateKey(new Date(row.created_at), tz));
      if (!point) continue;
      if (row.direction === 'in') {
        point.received++;
        continue;
      }
      point.sent++;
      if (row.status === 'delivered' || row.status === 'read') point.delivered++;
      if (row.status === 'read') point.read++;
    }

    // Campaign funnel over the last 30 days.
    const thirty = nowIso(new Date(now.getTime() - 30 * 86_400_000));
    const funnel = this.core.db.get<Record<string, number>>(
      `SELECT SUM(status IN ('sent', 'delivered', 'read')) AS sent,
              SUM(status IN ('delivered', 'read')) AS delivered,
              SUM(status = 'read') AS read,
              SUM(replied_at IS NOT NULL) AS replied,
              SUM(clicked_at IS NOT NULL) AS clicked,
              SUM(opted_out_at IS NOT NULL) AS optedOut
         FROM campaign_recipients WHERE sent_at >= ?`,
      thirty,
    );

    const todayStart = nowIso(startOfLocalDay(now, tz));
    const today = this.core.db.get<{ marketing: number; total: number; received: number }>(
      `SELECT SUM(direction = 'out' AND source_type IN ${MARKETING_SOURCES}) AS marketing,
              SUM(direction = 'out') AS total,
              SUM(direction = 'in') AS received
         FROM messages WHERE created_at >= ?`,
      todayStart,
    );

    const campaigns = this.core.db.get<Record<string, number>>(
      `SELECT SUM(status = 'running') AS running, SUM(status = 'scheduled') AS scheduled, SUM(status = 'paused') AS paused,
              SUM(status = 'completed') AS completed FROM campaigns`,
    );
    const sequences = this.core.db.get<{ active: number }>(
      "SELECT COUNT(*) AS active FROM sequence_enrollments WHERE status IN ('active', 'sending')",
    );

    return {
      contacts: this.contacts.stats(),
      today: { marketingSent: today?.marketing ?? 0, totalSent: today?.total ?? 0, received: today?.received ?? 0 },
      dailyCap: settings.sending.dailyCapPerSession,
      funnel30d: {
        sent: funnel?.sent ?? 0,
        delivered: funnel?.delivered ?? 0,
        read: funnel?.read ?? 0,
        replied: funnel?.replied ?? 0,
        clicked: funnel?.clicked ?? 0,
        optedOut: funnel?.optedOut ?? 0,
      },
      campaigns: {
        running: campaigns?.running ?? 0,
        scheduled: campaigns?.scheduled ?? 0,
        paused: campaigns?.paused ?? 0,
        completed: campaigns?.completed ?? 0,
      },
      activeDripEnrollments: sequences?.active ?? 0,
      unreadConversations: this.messages.unreadCount(),
      series: [...series.values()],
    };
  }
}
