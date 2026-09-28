/**
 * Platform health: what needs the platform owner's attention right now, and WhatsApp alerts about it.
 *
 * Checked every few minutes: the WhatsApp gateway, server memory and disk, backups, and for each paying
 * business its numbers, auto-paused campaigns and upcoming renewal. A problem is alerted once it has
 * lasted 10 minutes (so a brief reconnect doesn't page anyone), and again when it is resolved.
 */
import { readFileSync, statfsSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { nowIso, parseJson } from '../db/database.js';
import { chatIdFor, normalizePhone } from '../lib/phone.js';
import type { Logger } from '../context.js';
import type { Platform } from './platform.js';

export interface HealthIssue {
  key: string;
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  business: { id: string; name: string } | null;
  /** Also send a WhatsApp alert (some issues are only shown on the admin page). */
  notify: boolean;
}

export interface BackupStatus {
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  lastFile: string | null;
}

interface AlertState {
  [key: string]: { firstSeen: string; alertedAt: string | null; title: string };
}

const CHECK_EVERY_MS = 5 * 60_000;
const ALERT_AFTER_MS = 10 * 60_000;
const BACKUP_STALE_MS = 36 * 3_600_000;
const DAY = 86_400_000;

function memory(): { availableRatio: number; availableMb: number } {
  try {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const total = Number(/MemTotal:\s+(\d+)/.exec(info)?.[1]);
    const available = Number(/MemAvailable:\s+(\d+)/.exec(info)?.[1]);
    if (total && available) return { availableRatio: available / total, availableMb: Math.round(available / 1024) };
  } catch {
    // Not Linux: fall back to Node's view.
  }
  return { availableRatio: freemem() / totalmem(), availableMb: Math.round(freemem() / 1_048_576) };
}

function disk(path: string): { freeRatio: number; freeGb: number } | null {
  try {
    const stats = statfsSync(path);
    const free = stats.bavail * stats.bsize;
    return { freeRatio: free / (stats.blocks * stats.bsize), freeGb: Math.round((free / 1_073_741_824) * 10) / 10 };
  } catch {
    return null;
  }
}

export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly platform: Platform,
    private readonly log: Logger,
  ) {}

  backupStatus(): BackupStatus | null {
    const row = this.platform.db.get<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'backup'");
    if (!row) return null;
    const value = parseJson<Partial<BackupStatus>>(row.value, {});
    return { lastRunAt: value.lastRunAt ?? null, lastOkAt: value.lastOkAt ?? null, lastError: value.lastError ?? null, lastFile: value.lastFile ?? null };
  }

  async issues(): Promise<HealthIssue[]> {
    const issues: HealthIssue[] = [];
    const now = this.platform.clock().getTime();

    let sessions: Awaited<ReturnType<Platform['fetchAllSessions']>> | null = null;
    try {
      sessions = await this.platform.fetchAllSessions(true);
    } catch (error) {
      issues.push({
        key: 'gateway',
        severity: 'critical',
        title: 'WhatsApp gateway is down',
        detail: `QR-linked numbers cannot send or receive. ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
        business: null,
        notify: true,
      });
    }

    const mem = memory();
    if (mem.availableRatio < 0.1) {
      issues.push({
        key: 'memory',
        severity: mem.availableRatio < 0.05 ? 'critical' : 'warning',
        title: 'Server memory is almost full',
        detail: `Only ${mem.availableMb} MB free. Each QR-linked number uses about 300-500 MB; upgrade the server or move big senders to the official API.`,
        business: null,
        notify: true,
      });
    }
    const space = disk(this.platform.config.dataDir);
    if (space && (space.freeRatio < 0.1 || space.freeGb < 2)) {
      issues.push({
        key: 'disk',
        severity: space.freeGb < 1 ? 'critical' : 'warning',
        title: 'Server disk is almost full',
        detail: `Only ${space.freeGb} GB free. Delete old files in the backups folder or add disk space.`,
        business: null,
        notify: true,
      });
    }

    const backup = this.backupStatus();
    if (!backup) {
      issues.push({ key: 'backup:none', severity: 'warning', title: 'Backups are not set up', detail: 'Set up daily Google Drive backups (README, Daily backups).', business: null, notify: false });
    } else if (!backup.lastOkAt || now - new Date(backup.lastOkAt).getTime() > BACKUP_STALE_MS || (backup.lastError && backup.lastRunAt && backup.lastRunAt > backup.lastOkAt)) {
      issues.push({
        key: 'backup:stale',
        severity: 'warning',
        title: 'Backup did not complete',
        detail: backup.lastError ?? `Last successful backup: ${backup.lastOkAt ?? 'never'}`,
        business: null,
        notify: true,
      });
    }

    for (const tenant of this.platform.tenants()) {
      if (tenant.access !== 'active' && tenant.access !== 'grace') continue;
      const business = { id: tenant.id, name: tenant.name };
      if (tenant.access === 'active' && tenant.daysLeft <= 3) {
        issues.push({
          key: `renewal:${tenant.id}`,
          severity: 'warning',
          title: `${tenant.name}: renewal due in ${Math.max(tenant.daysLeft, 0)} day${tenant.daysLeft === 1 ? '' : 's'}`,
          detail: `Paid until ${tenant.paidUntil.slice(0, 10)}. Record the payment to keep them sending.`,
          business,
          notify: true,
        });
      }
      if (tenant.access === 'grace') {
        issues.push({
          key: `grace:${tenant.id}`,
          severity: 'warning',
          title: `${tenant.name}: payment overdue`,
          detail: 'In the grace period; sending stops when it ends.',
          business,
          notify: true,
        });
      }
      const runtime = this.platform.runtime(tenant.id);
      const db = runtime.core.db;
      if (sessions) {
        for (const session of sessions.filter(s => runtime.scope.owns(s.id) && s.status !== 'ready')) {
          const name = session.name.startsWith(runtime.scope.namePrefix) ? session.name.slice(runtime.scope.namePrefix.length) : session.name;
          issues.push({
            key: `number:${tenant.id}:${session.id}`,
            severity: 'critical',
            title: `${tenant.name}: WhatsApp number “${name}” is disconnected`,
            detail: `Status: ${session.status.replace(/_/g, ' ')}${session.phone ? ` (+${session.phone})` : ''}. It may need its QR code scanned again.`,
            business,
            notify: true,
          });
        }
      }
      for (const number of db.all<{ id: string; name: string; last_error: string | null }>("SELECT id, name, last_error FROM official_numbers WHERE status = 'failed'")) {
        issues.push({
          key: `official:${tenant.id}:${number.id}`,
          severity: 'critical',
          title: `${tenant.name}: official number “${number.name}” needs attention`,
          detail: (number.last_error ?? 'Meta refused its credentials').slice(0, 300),
          business,
          notify: true,
        });
      }
      const since = nowIso(new Date(now - DAY));
      for (const campaign of db.all<{ id: number; name: string; paused_reason: string }>(
        "SELECT id, name, paused_reason FROM campaigns WHERE status = 'paused' AND paused_reason IS NOT NULL AND updated_at >= ?",
        since,
      )) {
        issues.push({
          key: `campaign:${tenant.id}:${campaign.id}`,
          severity: 'warning',
          title: `${tenant.name}: campaign “${campaign.name}” paused itself`,
          detail: campaign.paused_reason.slice(0, 300),
          business,
          notify: true,
        });
      }
    }
    return issues;
  }

  private state(): AlertState {
    const row = this.platform.db.get<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'health_alerts'");
    return parseJson<AlertState>(row?.value, {});
  }

  private saveState(state: AlertState): void {
    this.platform.db.run(
      "INSERT INTO platform_settings (key, value) VALUES ('health_alerts', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      JSON.stringify(state),
    );
  }

  /** Send a WhatsApp message to the admin through the chosen business's default number. */
  sendAlert(body: string): { ok: true } | { ok: false; error: string } {
    const settings = this.platform.settings();
    if (!settings.alertPhone || !settings.alertTenantId) return { ok: false, error: 'Choose an alert number and the business that sends it' };
    const phone = normalizePhone(settings.alertPhone, 'IN');
    if (!phone.ok) return { ok: false, error: `Alert number is not valid: ${phone.reason}` };
    let runtime;
    try {
      runtime = this.platform.runtime(settings.alertTenantId);
    } catch {
      return { ok: false, error: 'The business chosen to send alerts no longer exists' };
    }
    const sessionId = runtime.services.settings.get().defaultSessionId;
    if (!sessionId) return { ok: false, error: 'That business has no default WhatsApp number' };
    runtime.services.outbox.enqueue({ sessionId, contactId: null, chatId: chatIdFor(phone.phone), body, sourceType: 'system' });
    if (runtime.running) void runtime.services.dispatcher.tick().catch(() => undefined);
    return { ok: true };
  }

  /** One pass: find issues, alert on ones that lasted 10 minutes, report resolved ones. */
  async check(): Promise<void> {
    const now = this.platform.clock();
    const issues = (await this.issues()).filter(i => i.notify);
    const previous = this.state();
    const next: AlertState = {};
    const fresh: HealthIssue[] = [];
    for (const issue of issues) {
      const seen = previous[issue.key] ?? { firstSeen: nowIso(now), alertedAt: null, title: issue.title };
      if (!seen.alertedAt && now.getTime() - new Date(seen.firstSeen).getTime() >= ALERT_AFTER_MS) {
        fresh.push(issue);
        seen.alertedAt = nowIso(now);
      }
      next[issue.key] = { ...seen, title: issue.title };
    }
    const resolved = Object.entries(previous).filter(([key, value]) => value.alertedAt && !next[key]).map(([, value]) => value.title);
    const url = this.platform.config.publicUrl ? `\n\nOpen: ${this.platform.config.publicUrl}/admin` : '';
    const brand = this.platform.settings().brandName;
    if (fresh.length) {
      const lines = fresh.slice(0, 8).map(i => `• ${i.severity === 'critical' ? '*' + i.title + '*' : i.title}\n  ${i.detail}`);
      this.trySend(`${brand} alert: ${fresh.length} problem${fresh.length > 1 ? 's' : ''}\n\n${lines.join('\n')}${fresh.length > 8 ? `\n…and ${fresh.length - 8} more` : ''}${url}`);
    }
    if (resolved.length) this.trySend(`${brand}: resolved\n\n${resolved.slice(0, 8).map(t => `• ${t}`).join('\n')}`);
    this.saveState(next);
  }

  private trySend(body: string): void {
    const result = this.sendAlert(body);
    if (!result.ok) this.log.warn(`Health alert not sent: ${result.error}`);
  }

  start(): void {
    if (this.timer) return;
    const run = () => {
      if (this.running) return;
      this.running = this.check()
        .catch(error => this.log.warn(`Health check failed: ${String(error)}`))
        .finally(() => {
          this.running = null;
        });
    };
    this.timer = setInterval(run, CHECK_EVERY_MS);
    this.timer.unref?.();
    setTimeout(run, 60_000).unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
