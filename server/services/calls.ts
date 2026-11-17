import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Core } from '../context.js';
import { nowIso } from '../db/database.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { randomToken } from '../lib/crypto.js';
import { normalizePhone } from '../lib/phone.js';
import { startOfLocalDay } from '../lib/time.js';
import type { SettingsService } from './settings.js';
import type { ContactsService } from './contacts.js';

/**
 * Calls made from team members' phones, sent by the WA Reach Calls Android app. The app reads the
 * phone's call log and sends what's new; only calls with a lead's number are kept, so the phone's
 * other calls are never stored. When the phone's own dialer records calls, the app uploads the
 * recording of each kept call that was answered. Admins see, per lead, whether and how long it was
 * called, and per person, calls made, answered and talk time.
 */

/** The app version the server expects; older apps are told an update is available. */
export const CALL_APP_VERSION = '1.0.0';

export type CallDirection = 'outgoing' | 'incoming' | 'missed' | 'rejected';
/** Android's CallLog.Calls.TYPE values. */
const CALL_TYPES: Record<number, CallDirection> = { 1: 'incoming', 2: 'outgoing', 3: 'missed', 4: 'missed', 5: 'rejected', 6: 'rejected', 7: 'incoming' };

const DAY = 86_400_000;
/** A remark is only "without a call" if no call came before it (or within this long after). */
const REMARK_GRACE_MS = 30 * 60_000;
/** The app keeps looking for a recording this long after a call, then gives up. */
const RECORDING_WAIT_MS = 2 * DAY;

export interface DeviceRow {
  id: number;
  user_id: number;
  name: string;
  token_hash: string;
  session_version: number;
  app_version: string | null;
  recordings: 'allowed' | 'denied' | null;
  since: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

interface CallRow {
  id: number;
  device_id: number;
  user_id: number;
  contact_id: number | null;
  phone: string;
  direction: CallDirection;
  started_at: string;
  duration: number;
  recording_status: 'pending' | 'saved' | 'none' | 'deleted';
  recording_file: string | null;
  recording_mime: string | null;
  recording_size: number | null;
  created_at: string;
}

export interface Call {
  id: number;
  userId: number;
  contactId: number | null;
  contactName: string | null;
  phone: string;
  direction: CallDirection;
  startedAt: string;
  duration: number;
  answered: boolean;
  recording: 'pending' | 'saved' | 'none' | 'deleted';
  recordingMime: string | null;
  device: string;
}

export interface CallDevice {
  id: number;
  userId: number;
  name: string;
  appVersion: string | null;
  recordings: 'allowed' | 'denied' | null;
  connectedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

/** What a lead's calls look like on the Leads page. */
export interface LeadCalls {
  calls: number;
  answered: number;
  talkSeconds: number;
  last: { at: string; duration: number; direction: CallDirection; userId: number } | null;
  /** The lead has a remark but no call was recorded before it. */
  remarkWithoutCall: boolean;
}

const uploadSchema = z.object({
  device: z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      appVersion: z.string().trim().max(20).optional(),
      recordings: z.enum(['allowed', 'denied']).optional(),
    })
    .default({}),
  calls: z
    .array(
      z.object({
        number: z.string().max(40),
        type: z.number().int(),
        /** When the call started, in milliseconds since 1970 (as Android's call log keeps it). */
        startedAt: z.number().int().positive(),
        duration: z.number().int().min(0).max(DAY / 1000),
      }),
    )
    .max(500)
    .default([]),
});

const listSchema = z.object({
  contactId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Audio formats phone dialers record in, recognised by their first bytes (never by the name). */
export function sniffAudio(data: Buffer): { ext: string; mime: string } | null {
  if (data.length < 12) return null;
  const ascii = (start: number, end: number) => data.subarray(start, end).toString('latin1');
  if (ascii(4, 8) === 'ftyp') return ascii(8, 11) === '3gp' || ascii(8, 11) === '3g2' ? { ext: '3gp', mime: 'audio/3gpp' } : { ext: 'm4a', mime: 'audio/mp4' };
  if (ascii(0, 5) === '#!AMR') return { ext: 'amr', mime: 'audio/amr' };
  if (ascii(0, 4) === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  if (ascii(0, 4) === 'fLaC') return { ext: 'flac', mime: 'audio/flac' };
  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return { ext: 'webm', mime: 'audio/webm' };
  if (data[0] === 0xff && (data[1] & 0xf6) === 0xf0) return { ext: 'aac', mime: 'audio/aac' };
  if (ascii(0, 3) === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return { ext: 'mp3', mime: 'audio/mpeg' };
  return null;
}

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();

export class CallsService {
  constructor(
    private readonly core: Core,
    private readonly settings: SettingsService,
    private readonly contacts: ContactsService,
  ) {}

  private now(): Date {
    return this.core.clock();
  }

  private get dir(): string {
    return join(dirname(this.core.config.mediaDir), 'call-recordings');
  }

  // ---------------------------------------------------------------- phones

  /**
   * A team member signs in on a phone. Returns the secret the phone sends with every request (only
   * its hash is stored). Calls from the day before are sent too, for remarks written that morning.
   */
  connect(userId: number, sessionVersion: number, name: string): { secret: string; deviceId: number; since: string } {
    const secret = randomToken(40);
    const now = this.now();
    const since = iso(now.getTime() - DAY);
    const { lastInsertRowid } = this.core.db.run(
      'INSERT INTO call_devices (user_id, name, token_hash, session_version, since, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      userId,
      name.trim().slice(0, 80) || 'Phone',
      hashSecret(secret),
      sessionVersion,
      since,
      nowIso(now),
      nowIso(now),
    );
    return { secret, deviceId: lastInsertRowid, since };
  }

  /** The phone signed in with this secret, unless it was signed out. */
  device(secret: string): DeviceRow | null {
    if (!/^[A-Za-z0-9]{40}$/.test(secret)) return null;
    return this.core.db.get<DeviceRow>('SELECT * FROM call_devices WHERE token_hash = ? AND revoked_at IS NULL', hashSecret(secret)) ?? null;
  }

  touch(device: DeviceRow): void {
    this.core.db.run('UPDATE call_devices SET last_seen_at = ? WHERE id = ?', nowIso(this.now()), device.id);
  }

  revoke(deviceId: number): void {
    const { changes } = this.core.db.run('UPDATE call_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', nowIso(this.now()), deviceId);
    if (!changes && !this.core.db.get('SELECT 1 FROM call_devices WHERE id = ?', deviceId)) throw notFound('Phone');
  }

  /** Someone left the team: their phones stop sending (their calls stay on record). */
  revokeUser(userId: number): void {
    this.core.db.run('UPDATE call_devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', nowIso(this.now()), userId);
  }

  devices(): CallDevice[] {
    return this.core.db
      .all<DeviceRow>('SELECT * FROM call_devices WHERE revoked_at IS NULL ORDER BY last_seen_at DESC, id DESC')
      .map(d => ({
        id: d.id,
        userId: d.user_id,
        name: d.name,
        appVersion: d.app_version,
        recordings: d.recordings,
        connectedAt: d.created_at,
        lastSeenAt: d.last_seen_at,
        revokedAt: d.revoked_at,
      }));
  }

  /** When the business connected its first phone: remarks before then aren't checked for calls. */
  private trackingSince(): string | null {
    return this.core.db.get<{ at: string | null }>('SELECT MIN(created_at) AS at FROM call_devices')?.at ?? null;
  }

  // ---------------------------------------------------------------- from the phone

  /**
   * New entries from a phone's call log. Calls with someone who isn't a lead are dropped here and
   * never stored. Returns the kept calls the app should look for a recording of.
   */
  receive(device: DeviceRow, input: unknown): { stored: number; ignored: number; recordingsWanted: Array<{ id: number; number: string; startedAt: number; duration: number }> } {
    const data = uploadSchema.parse(input);
    const now = this.now();
    this.core.db.run(
      'UPDATE call_devices SET last_seen_at = ?, name = COALESCE(?, name), app_version = COALESCE(?, app_version), recordings = COALESCE(?, recordings) WHERE id = ?',
      nowIso(now),
      data.device.name ?? null,
      data.device.appVersion ?? null,
      data.device.recordings ?? null,
      device.id,
    );
    const since = Date.parse(device.since);
    const country = this.settings.get().defaultCountry;
    let stored = 0;
    let ignored = 0;
    this.core.db.tx(() => {
      for (const call of data.calls) {
        const direction = CALL_TYPES[call.type];
        if (!direction || call.startedAt < since || call.startedAt > now.getTime() + 3_600_000) {
          ignored++;
          continue;
        }
        const phone = normalizePhone(call.number, country);
        const contact = phone.ok ? this.contacts.findByPhone(phone.phone) : undefined;
        if (!phone.ok || !contact || !contact.saved) {
          ignored++;
          continue;
        }
        const talked = call.duration > 0 && (direction === 'outgoing' || direction === 'incoming');
        const { changes } = this.core.db.run(
          `INSERT INTO calls (device_id, user_id, contact_id, phone, direction, started_at, duration, recording_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, phone, started_at) DO NOTHING`,
          device.id,
          device.user_id,
          contact.id,
          phone.phone,
          direction,
          iso(call.startedAt),
          talked ? call.duration : 0,
          talked ? 'pending' : 'none',
          nowIso(now),
        );
        stored += changes;
      }
    });
    const recordings = data.device.recordings ?? device.recordings;
    return { stored, ignored, recordingsWanted: recordings === 'allowed' ? this.wanted(device.id) : [] };
  }

  /** Recent answered calls from this phone still waiting for their recording. */
  private wanted(deviceId: number) {
    return this.core.db
      .all<Pick<CallRow, 'id' | 'phone' | 'started_at' | 'duration'>>(
        `SELECT id, phone, started_at, duration FROM calls
          WHERE device_id = ? AND recording_status = 'pending' AND started_at >= ? ORDER BY started_at LIMIT 20`,
        deviceId,
        iso(this.now().getTime() - RECORDING_WAIT_MS),
      )
      .map(r => ({ id: r.id, number: r.phone, startedAt: Date.parse(r.started_at), duration: r.duration }));
  }

  private ownCall(device: DeviceRow, callId: number): CallRow {
    const call = this.core.db.get<CallRow>('SELECT * FROM calls WHERE id = ? AND device_id = ?', callId, device.id);
    if (!call) throw notFound('Call');
    return call;
  }

  /** The dialer's recording of a kept call. Only real audio is accepted, checked by its content. */
  saveRecording(device: DeviceRow, callId: number, data: Buffer): { ok: true } {
    const call = this.ownCall(device, callId);
    if (call.recording_status === 'saved') return { ok: true };
    if (call.recording_status !== 'pending') throw badRequest('This call no longer needs a recording');
    const kind = sniffAudio(data);
    if (!kind) throw new HttpError(415, 'That file is not a recording');
    mkdirSync(this.dir, { recursive: true });
    const file = `c${call.id}.${kind.ext}`;
    writeFileSync(join(this.dir, file), data, { mode: 0o600 });
    this.core.db.run(
      "UPDATE calls SET recording_status = 'saved', recording_file = ?, recording_mime = ?, recording_size = ? WHERE id = ?",
      file,
      kind.mime,
      data.length,
      call.id,
    );
    return { ok: true };
  }

  /** The phone found no recording for this call (the dialer doesn't record, or recording was off). */
  noRecording(device: DeviceRow, callId: number): { ok: true } {
    const call = this.ownCall(device, callId);
    if (call.recording_status === 'pending') this.core.db.run("UPDATE calls SET recording_status = 'none' WHERE id = ?", call.id);
    return { ok: true };
  }

  // ---------------------------------------------------------------- for the business

  private toCall(row: CallRow & { contact_name: string | null; device_name: string | null }): Call {
    return {
      id: row.id,
      userId: row.user_id,
      contactId: row.contact_id,
      contactName: row.contact_name,
      phone: row.phone,
      direction: row.direction,
      startedAt: row.started_at,
      duration: row.duration,
      answered: row.duration > 0,
      recording: row.recording_status,
      recordingMime: row.recording_status === 'saved' ? row.recording_mime : null,
      device: row.device_name ?? 'Phone',
    };
  }

  /** Start of a local day (YYYY-MM-DD, + days) in the business's time zone, as an ISO string. */
  private dayStart(ymd: string, addDays = 0): string {
    const [y, m, d] = ymd.split('-').map(Number);
    return startOfLocalDay(new Date(Date.UTC(y, m - 1, d + addDays, 12)), this.settings.get().timezone).toISOString();
  }

  list(query: unknown, onlyUser?: number): { items: Call[]; total: number; page: number; pageSize: number } {
    const q = listSchema.parse(query ?? {});
    const where: string[] = ['1'];
    const params: Array<string | number> = [];
    const userId = onlyUser ?? q.userId;
    if (q.contactId) where.push('k.contact_id = ?'), params.push(q.contactId);
    if (userId) where.push('k.user_id = ?'), params.push(userId);
    if (q.from) where.push('k.started_at >= ?'), params.push(this.dayStart(q.from));
    if (q.to) where.push('k.started_at < ?'), params.push(this.dayStart(q.to, 1));
    const sql = where.join(' AND ');
    const total = this.core.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM calls k WHERE ${sql}`, ...params)?.n ?? 0;
    const rows = this.core.db.all<CallRow & { contact_name: string | null; device_name: string | null }>(
      `SELECT k.*, c.name AS contact_name, d.name AS device_name FROM calls k
         LEFT JOIN contacts c ON c.id = k.contact_id LEFT JOIN call_devices d ON d.id = k.device_id
        WHERE ${sql} ORDER BY k.started_at DESC, k.id DESC LIMIT ? OFFSET ?`,
      ...params,
      q.pageSize,
      (q.page - 1) * q.pageSize,
    );
    return { items: rows.map(r => this.toCall(r)), total, page: q.page, pageSize: q.pageSize };
  }

  /** Calls per lead, for the Leads page: how often, how long, the last call, and remarks without one. */
  summary(contactIds: number[]): { tracking: boolean; leads: Record<number, LeadCalls> } {
    const since = this.trackingSince();
    const out: Record<number, LeadCalls> = {};
    if (contactIds.length === 0) return { tracking: !!since, leads: out };
    const ids = JSON.stringify(contactIds);
    const stats = this.core.db.all<{ contact_id: number; n: number; answered: number; talk: number; first_at: string }>(
      `SELECT contact_id, COUNT(*) AS n, SUM(duration > 0) AS answered, SUM(duration) AS talk, MIN(started_at) AS first_at
         FROM calls WHERE contact_id IN (SELECT value FROM json_each(?)) GROUP BY contact_id`,
      ids,
    );
    const last = this.core.db.all<CallRow>(
      `SELECT * FROM (SELECT k.*, ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY started_at DESC, id DESC) AS rn
         FROM calls k WHERE contact_id IN (SELECT value FROM json_each(?))) WHERE rn = 1`,
      ids,
    );
    const lastBy = new Map(last.map(r => [r.contact_id, r]));
    const statBy = new Map(stats.map(s => [s.contact_id, s]));
    const remarks = this.core.db.all<{ id: number; lead_remark_at: string | null }>(
      'SELECT id, lead_remark_at FROM contacts WHERE id IN (SELECT value FROM json_each(?))',
      ids,
    );
    for (const { id, lead_remark_at } of remarks) {
      const stat = statBy.get(id);
      const row = lastBy.get(id);
      const remarked = !!since && !!lead_remark_at && lead_remark_at >= since;
      const calledBefore = !!stat && Date.parse(stat.first_at) <= Date.parse(lead_remark_at ?? '') + REMARK_GRACE_MS;
      out[id] = {
        calls: stat?.n ?? 0,
        answered: stat?.answered ?? 0,
        talkSeconds: stat?.talk ?? 0,
        last: row ? { at: row.started_at, duration: row.duration, direction: row.direction, userId: row.user_id } : null,
        remarkWithoutCall: remarked && !calledBefore,
      };
    }
    return { tracking: !!since, leads: out };
  }

  /** Per team member over a period: calls, answered, talk time, leads called, and remarks without a call. */
  report(query: unknown) {
    const q = listSchema.pick({ from: true, to: true }).parse(query ?? {});
    const from = q.from ? this.dayStart(q.from) : '0000';
    const to = q.to ? this.dayStart(q.to, 1) : '9999';
    const rows = this.core.db.all<{ user_id: number; calls: number; outgoing: number; answered: number; talk: number; leads: number; recorded: number }>(
      `SELECT user_id, COUNT(*) AS calls, SUM(direction = 'outgoing') AS outgoing, SUM(duration > 0) AS answered,
              SUM(duration) AS talk, COUNT(DISTINCT contact_id) AS leads, SUM(recording_status = 'saved') AS recorded
         FROM calls WHERE started_at >= ? AND started_at < ? GROUP BY user_id`,
      from,
      to,
    );
    const since = this.trackingSince();
    // Leads given to someone that got a remark in the period with no call before it.
    const unchecked = since
      ? this.core.db.all<{ user_id: number; n: number }>(
          `SELECT c.assigned_to AS user_id, COUNT(*) AS n FROM contacts c
            WHERE c.saved = 1 AND c.assigned_to IS NOT NULL AND c.lead_remark_at IS NOT NULL
              AND c.lead_remark_at >= ? AND c.lead_remark_at >= ? AND c.lead_remark_at < ?
              AND NOT EXISTS (SELECT 1 FROM calls k WHERE k.contact_id = c.id
                                AND k.started_at <= strftime('%Y-%m-%dT%H:%M:%fZ', c.lead_remark_at, '+30 minutes'))
            GROUP BY c.assigned_to`,
          since,
          from,
          to,
        )
      : [];
    const empty = (userId: number) => ({ userId, calls: 0, outgoing: 0, answered: 0, talkSeconds: 0, leadsCalled: 0, recorded: 0, remarksWithoutCall: 0 });
    const byUser = new Map<number, ReturnType<typeof empty>>();
    for (const r of rows) {
      byUser.set(r.user_id, { ...empty(r.user_id), calls: r.calls, outgoing: r.outgoing, answered: r.answered, talkSeconds: r.talk, leadsCalled: r.leads, recorded: r.recorded });
    }
    for (const u of unchecked) byUser.set(u.user_id, { ...(byUser.get(u.user_id) ?? empty(u.user_id)), remarksWithoutCall: u.n });
    return { tracking: !!since, people: [...byUser.values()].sort((a, b) => b.calls - a.calls), devices: this.devices() };
  }

  /** The stored recording of a call, for playing in the browser. */
  recording(callId: number): { path: string; mime: string; size: number; name: string } {
    const call = this.core.db.get<CallRow>('SELECT * FROM calls WHERE id = ?', callId);
    if (!call || call.recording_status !== 'saved' || !call.recording_file) throw notFound('Recording');
    const path = join(this.dir, call.recording_file);
    if (!existsSync(path)) throw notFound('Recording');
    const stamp = call.started_at.slice(0, 16).replace(/[-:T]/g, '');
    return { path, mime: call.recording_mime ?? 'application/octet-stream', size: call.recording_size ?? 0, name: `call-${call.phone}-${stamp}.${call.recording_file.split('.').pop()}` };
  }

  /** Daily upkeep: recordings past the business's retention are deleted; old waits are given up. */
  prune(): { deleted: number } {
    const now = this.now().getTime();
    const cutoff = iso(now - this.settings.get().callRecordingDays * DAY);
    const old = this.core.db.all<{ id: number; recording_file: string | null }>(
      "SELECT id, recording_file FROM calls WHERE recording_status = 'saved' AND started_at < ?",
      cutoff,
    );
    for (const row of old) {
      if (row.recording_file) rmSync(join(this.dir, row.recording_file), { force: true });
      this.core.db.run("UPDATE calls SET recording_status = 'deleted', recording_file = NULL WHERE id = ?", row.id);
    }
    this.core.db.run("UPDATE calls SET recording_status = 'none' WHERE recording_status = 'pending' AND started_at < ?", iso(now - RECORDING_WAIT_MS - DAY));
    return { deleted: old.length };
  }
}
