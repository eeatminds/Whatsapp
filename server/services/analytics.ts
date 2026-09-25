import type { Core } from '../context.js';
import { nowIso } from '../db/database.js';
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

export class AnalyticsService {
  constructor(
    private readonly core: Core,
    private readonly settings: SettingsService,
    private readonly contacts: ContactsService,
    private readonly messages: MessagesService,
  ) {}

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
