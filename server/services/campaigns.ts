import { z } from 'zod';
import type { Core } from '../context.js';
import { nowIso, parseJson } from '../db/database.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { randomToken } from '../lib/crypto.js';
import { extractUrls, replaceUrls } from '../lib/links.js';
import { contactVariables, renderTemplate } from '../lib/template.js';
import { chatIdFor, normalizePhone } from '../lib/phone.js';
import { toCsv } from '../lib/csv.js';
import type { SettingsService } from './settings.js';
import type { SegmentsService, SqlFragment } from './segments.js';
import { andFragments } from './segments.js';
import type { ContactRow } from './contacts.js';
import { toContact } from './contacts.js';
import type { MediaService } from './media.js';
import type { Sender } from './sender.js';
import type { MessagesService } from './messages.js';

const id = z.coerce.number().int().positive();
const ids = z.array(id).max(100_000);

export const variantSchema = z
  .object({
    key: z.enum(['A', 'B', 'C']),
    body: z.string().max(4000).default(''),
    mediaId: id.nullish(),
    weight: z.coerce.number().int().min(0).max(100).default(100),
  })
  .refine(v => v.body.trim() !== '' || !!v.mediaId, 'Each variant needs text, media, or both');

export const audienceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all'), excludeTagIds: ids.default([]) }),
  z.object({ type: z.literal('segment'), segmentId: id, excludeTagIds: ids.default([]) }),
  z.object({ type: z.literal('tags'), tagIds: ids.min(1), excludeTagIds: ids.default([]) }),
  z.object({ type: z.literal('contacts'), contactIds: ids.min(1), excludeTagIds: ids.default([]) }),
]);

export const optionsSchema = z.object({
  perMinute: z.coerce.number().int().min(1).max(60),
  respectQuietHours: z.boolean(),
  requireOptIn: z.boolean(),
  appendOptOut: z.boolean(),
  trackLinks: z.boolean(),
  validateNumbers: z.boolean(),
});

export const campaignInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sessionId: z.string().trim().min(1).nullish(),
  audience: audienceSchema.default({ type: 'all', excludeTagIds: [] }),
  variants: z.array(variantSchema).min(1).max(3),
  options: optionsSchema.partial().default({}),
  scheduledAt: z.iso.datetime({ offset: true }).nullish(),
});

export type Variant = z.infer<typeof variantSchema>;
export type Audience = z.infer<typeof audienceSchema>;
export type CampaignOptions = z.infer<typeof optionsSchema>;
export type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled';

export interface CampaignStats {
  total: number;
  queued: number;
  sending: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  clicked: number;
  optedOut: number;
  failed: number;
  skipped: number;
  unknown: number;
}

export interface Campaign {
  id: number;
  name: string;
  status: CampaignStatus;
  sessionId: string | null;
  audience: Audience;
  variants: Variant[];
  options: CampaignOptions;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  pausedReason: string | null;
  createdAt: string;
  updatedAt: string;
  stats: CampaignStats;
}

interface CampaignRow {
  id: number;
  name: string;
  status: CampaignStatus;
  session_id: string | null;
  audience: string;
  variants: string;
  options: string;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  paused_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecipientRow {
  id: number;
  campaign_id: number;
  contact_id: number;
  variant: string;
  status: string;
  token: string;
  wa_message_id: string | null;
  error: string | null;
  attempts: number;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  clicked_at: string | null;
  opted_out_at: string | null;
  failed_at: string | null;
}

export const SKIP_REASONS: Record<string, string> = {
  opted_out: 'Contact opted out',
  no_consent: 'No opt-in recorded (campaign requires opt-in)',
  not_on_whatsapp: 'Number is not on WhatsApp',
  frequency_cap: 'Messaged recently (frequency cap)',
  campaign_cancelled: 'Campaign was cancelled',
};

const EMPTY_STATS: CampaignStats = {
  total: 0,
  queued: 0,
  sending: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  replied: 0,
  clicked: 0,
  optedOut: 0,
  failed: 0,
  skipped: 0,
  unknown: 0,
};

const STATS_SQL = `SELECT campaign_id,
       COUNT(*) AS total,
       SUM(status = 'queued') AS queued,
       SUM(status = 'sending') AS sending,
       SUM(status IN ('sent', 'delivered', 'read')) AS sent,
       SUM(status IN ('delivered', 'read')) AS delivered,
       SUM(status = 'read') AS read,
       SUM(replied_at IS NOT NULL) AS replied,
       SUM(clicked_at IS NOT NULL) AS clicked,
       SUM(opted_out_at IS NOT NULL) AS optedOut,
       SUM(status = 'failed') AS failed,
       SUM(status = 'skipped') AS skipped,
       SUM(status = 'unknown') AS unknown
  FROM campaign_recipients`;

function statsFromRow(row: Record<string, number> | undefined): CampaignStats {
  if (!row) return { ...EMPTY_STATS };
  const out = { ...EMPTY_STATS };
  for (const key of Object.keys(EMPTY_STATS) as Array<keyof CampaignStats>) out[key] = Number(row[key] ?? 0);
  return out;
}

export class CampaignsService {
  private readonly linkCache = new Map<number, Map<string, string>>();

  constructor(
    private readonly core: Core,
    private readonly settings: SettingsService,
    private readonly segments: SegmentsService,
    private readonly media: MediaService,
    private readonly sender: Sender,
    private readonly messages: MessagesService,
  ) {}

  private now(): string {
    return nowIso(this.core.clock());
  }

  defaultOptions(): CampaignOptions {
    return {
      perMinute: this.settings.get().sending.defaultPerMinute,
      respectQuietHours: true,
      requireOptIn: false,
      appendOptOut: true,
      trackLinks: true,
      validateNumbers: false,
    };
  }

  private toCampaign(row: CampaignRow, stats?: CampaignStats): Campaign {
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      sessionId: row.session_id,
      audience: audienceSchema.parse(parseJson(row.audience, { type: 'all' })),
      variants: parseJson<Variant[]>(row.variants, []),
      options: { ...this.defaultOptions(), ...parseJson<Partial<CampaignOptions>>(row.options, {}) },
      scheduledAt: row.scheduled_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      pausedReason: row.paused_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      stats: stats ?? this.stats(row.id),
    };
  }

  stats(campaignId: number): CampaignStats {
    return statsFromRow(this.core.db.get<Record<string, number>>(`${STATS_SQL} WHERE campaign_id = ?`, campaignId));
  }

  list(): Campaign[] {
    const stats = new Map<number, CampaignStats>();
    for (const row of this.core.db.all<Record<string, number>>(`${STATS_SQL} GROUP BY campaign_id`)) {
      stats.set(row.campaign_id, statsFromRow(row));
    }
    return this.core.db
      .all<CampaignRow>('SELECT * FROM campaigns ORDER BY created_at DESC, id DESC')
      .map(row => this.toCampaign(row, stats.get(row.id) ?? { ...EMPTY_STATS }));
  }

  private row(campaignId: number): CampaignRow {
    const row = this.core.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', campaignId);
    if (!row) throw notFound('Campaign');
    return row;
  }

  get(campaignId: number): Campaign {
    return this.toCampaign(this.row(campaignId));
  }

  private validate(input: unknown) {
    const data = campaignInputSchema.parse(input);
    const keys = data.variants.map(v => v.key);
    if (new Set(keys).size !== keys.length) throw badRequest('Variant keys must be unique');
    if (data.variants.length === 1) data.variants[0].weight = 100;
    const totalWeight = data.variants.reduce((sum, v) => sum + v.weight, 0);
    if (totalWeight !== 100) throw badRequest(`Variant split must add up to 100% (currently ${totalWeight}%)`);
    for (const variant of data.variants) {
      if (variant.mediaId && !this.media.exists(variant.mediaId)) throw badRequest(`Variant ${variant.key}: media file no longer exists`);
    }
    if (data.audience.type === 'segment') this.segments.get(data.audience.segmentId);
    const options: CampaignOptions = { ...this.defaultOptions(), ...data.options };
    return { ...data, options };
  }

  create(input: unknown): Campaign {
    const data = this.validate(input);
    const now = this.now();
    const { lastInsertRowid } = this.core.db.run(
      `INSERT INTO campaigns (name, status, session_id, audience, variants, options, scheduled_at, created_at, updated_at)
       VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
      data.name,
      data.sessionId ?? null,
      JSON.stringify(data.audience),
      JSON.stringify(data.variants),
      JSON.stringify(data.options),
      data.scheduledAt ? nowIso(new Date(data.scheduledAt)) : null,
      now,
      now,
    );
    return this.get(lastInsertRowid);
  }

  update(campaignId: number, input: unknown): Campaign {
    const row = this.row(campaignId);
    const data = this.validate(input);
    if (row.status === 'draft' || row.status === 'scheduled') {
      this.core.db.run(
        `UPDATE campaigns SET name = ?, session_id = ?, audience = ?, variants = ?, options = ?, scheduled_at = COALESCE(?, scheduled_at),
                updated_at = ? WHERE id = ?`,
        data.name,
        data.sessionId ?? null,
        JSON.stringify(data.audience),
        JSON.stringify(data.variants),
        JSON.stringify(data.options),
        data.scheduledAt ? nowIso(new Date(data.scheduledAt)) : null,
        this.now(),
        campaignId,
      );
    } else if (row.status === 'paused') {
      // The audience is fixed once recipients exist; message and pacing can still be corrected.
      const existingKeys = parseJson<Variant[]>(row.variants, []).map(v => v.key).sort().join();
      if (data.variants.map(v => v.key).sort().join() !== existingKeys) {
        throw badRequest('Variants cannot be added or removed after a campaign has started');
      }
      this.core.db.run(
        'UPDATE campaigns SET name = ?, session_id = COALESCE(?, session_id), variants = ?, options = ?, updated_at = ? WHERE id = ?',
        data.name,
        data.sessionId ?? null,
        JSON.stringify(data.variants),
        JSON.stringify(data.options),
        this.now(),
        campaignId,
      );
      this.linkCache.delete(campaignId);
      this.createLinks(campaignId, data.variants, data.options);
    } else {
      throw conflict(`A ${row.status} campaign cannot be edited${row.status === 'running' ? '; pause it first' : ''}`);
    }
    return this.get(campaignId);
  }

  delete(campaignId: number): void {
    const row = this.row(campaignId);
    if (row.status === 'running') throw conflict('Pause or cancel the campaign before deleting it');
    this.core.db.run('DELETE FROM campaigns WHERE id = ?', campaignId);
    this.linkCache.delete(campaignId);
  }

  duplicate(campaignId: number): Campaign {
    const campaign = this.get(campaignId);
    return this.create({
      name: `${campaign.name} (copy)`.slice(0, 120),
      sessionId: campaign.sessionId,
      audience: campaign.audience,
      variants: campaign.variants,
      options: campaign.options,
    });
  }

  // ---------------------------------------------------------------- audience

  /** Contacts matched by the audience definition, before consent/validity exclusions. */
  private audienceSql(audience: Audience): SqlFragment {
    const parts: SqlFragment[] = [];
    switch (audience.type) {
      case 'segment':
        parts.push(this.segments.where(this.segments.get(audience.segmentId).rules));
        break;
      case 'tags':
        parts.push({
          sql: 'EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id IN (SELECT value FROM json_each(?)))',
          params: [JSON.stringify(audience.tagIds)],
        });
        break;
      case 'contacts':
        parts.push({ sql: 'c.id IN (SELECT value FROM json_each(?))', params: [JSON.stringify(audience.contactIds)] });
        break;
      case 'all':
        break;
    }
    if (audience.excludeTagIds.length) {
      parts.push({
        sql: 'NOT EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id IN (SELECT value FROM json_each(?)))',
        params: [JSON.stringify(audience.excludeTagIds)],
      });
    }
    return andFragments(parts);
  }

  private eligibilitySql(options: Pick<CampaignOptions, 'requireOptIn'>): SqlFragment {
    return {
      sql: `c.consent <> 'opted_out' AND c.wa_status <> 'invalid'${options.requireOptIn ? " AND c.consent = 'opted_in'" : ''}`,
      params: [],
    };
  }

  audiencePreview(input: unknown): {
    matched: number;
    eligible: number;
    excluded: { optedOut: number; noConsent: number; invalid: number };
    sample: Array<{ id: number; name: string | null; phone: string }>;
  } {
    const data = z.object({ audience: audienceSchema, options: optionsSchema.partial().default({}) }).parse(input);
    const options = { ...this.defaultOptions(), ...data.options };
    const where = this.audienceSql(data.audience);
    const row = this.core.db.get<Record<string, number>>(
      `SELECT COUNT(*) AS matched,
              SUM(c.consent = 'opted_out') AS optedOut,
              SUM(c.consent = 'unknown') AS unknownConsent,
              SUM(c.consent <> 'opted_out' AND c.wa_status = 'invalid') AS invalid
         FROM contacts c WHERE ${where.sql}`,
      ...where.params,
    );
    const eligibleWhere = andFragments([where, this.eligibilitySql(options)]);
    const eligible =
      this.core.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts c WHERE ${eligibleWhere.sql}`, ...eligibleWhere.params)?.n ?? 0;
    const sample = this.core.db.all<{ id: number; name: string | null; phone: string }>(
      `SELECT c.id, c.name, c.phone FROM contacts c WHERE ${eligibleWhere.sql} ORDER BY c.id LIMIT 8`,
      ...eligibleWhere.params,
    );
    return {
      matched: row?.matched ?? 0,
      eligible,
      excluded: {
        optedOut: row?.optedOut ?? 0,
        noConsent: options.requireOptIn ? (row?.unknownConsent ?? 0) : 0,
        invalid: row?.invalid ?? 0,
      },
      sample,
    };
  }

  // ---------------------------------------------------------------- lifecycle

  launch(campaignId: number, input: unknown): Campaign {
    const { scheduledAt } = z.object({ scheduledAt: z.iso.datetime({ offset: true }).nullish() }).parse(input ?? {});
    const campaign = this.get(campaignId);
    if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
      throw conflict(`Campaign is already ${campaign.status}`);
    }
    const sessionId = campaign.sessionId ?? this.settings.get().defaultSessionId;
    if (!sessionId) throw badRequest('Choose which WhatsApp number sends this campaign');
    const preview = this.audiencePreview({ audience: campaign.audience, options: campaign.options });
    if (preview.eligible === 0) throw badRequest('No eligible recipients: the audience is empty after removing opted-out and invalid numbers');
    if (campaign.options.trackLinks && !this.core.config.publicUrl) {
      const hasUrl = campaign.variants.some(v => extractUrls(v.body).length > 0);
      if (hasUrl) this.core.log.warn(`Campaign ${campaignId}: link tracking skipped because PUBLIC_URL is not set`);
    }
    this.core.db.run('UPDATE campaigns SET session_id = ? WHERE id = ?', sessionId, campaignId);

    const when = scheduledAt ? new Date(scheduledAt) : null;
    if (when && when.getTime() > this.core.clock().getTime() + 30_000) {
      this.core.db.run(
        "UPDATE campaigns SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?",
        nowIso(when),
        this.now(),
        campaignId,
      );
      return this.get(campaignId);
    }
    this.start(campaignId);
    return this.get(campaignId);
  }

  /** Freeze the audience into recipient rows and begin sending. */
  start(campaignId: number): void {
    const campaign = this.get(campaignId);
    this.core.db.tx(() => {
      const where = andFragments([this.audienceSql(campaign.audience), this.eligibilitySql(campaign.options)]);
      const total = this.core.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts c WHERE ${where.sql}`, ...where.params)?.n ?? 0;
      // Weighted A/B/C split over a random ordering, so every variant gets a fair cross-section and
      // sends interleave rather than all A first.
      let cumulative = 0;
      const thresholds = campaign.variants.map(v => {
        cumulative += v.weight;
        return { key: v.key, upTo: Math.round((total * cumulative) / 100) };
      });
      const caseSql = thresholds.map(() => 'WHEN rn <= ? THEN ?').join(' ');
      const caseParams = thresholds.flatMap(t => [t.upTo, t.key]);
      this.core.db.run(
        `INSERT OR IGNORE INTO campaign_recipients (campaign_id, contact_id, variant, token)
         SELECT ?, id, CASE ${caseSql} ELSE ? END, lower(hex(randomblob(8)))
           FROM (SELECT c.id, ROW_NUMBER() OVER (ORDER BY random()) AS rn FROM contacts c WHERE ${where.sql})
          ORDER BY rn`,
        campaignId,
        ...caseParams,
        campaign.variants.at(-1)!.key,
        ...where.params,
      );
      this.createLinks(campaignId, campaign.variants, campaign.options);
      this.core.db.run(
        "UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, ?), paused_reason = NULL, updated_at = ? WHERE id = ?",
        this.now(),
        this.now(),
        campaignId,
      );
    });
    this.core.log.info(`Campaign ${campaignId} started`);
  }

  pause(campaignId: number, reason: string | null = null): Campaign {
    const row = this.row(campaignId);
    if (row.status !== 'running' && row.status !== 'scheduled') throw conflict(`Only running or scheduled campaigns can be paused`);
    this.core.db.run(
      "UPDATE campaigns SET status = 'paused', paused_reason = ?, updated_at = ? WHERE id = ?",
      reason,
      this.now(),
      campaignId,
    );
    return this.get(campaignId);
  }

  resume(campaignId: number): Campaign {
    const row = this.row(campaignId);
    if (row.status !== 'paused') throw conflict('Only paused campaigns can be resumed');
    if (!row.started_at) {
      // Paused while still scheduled: recipients were never created.
      this.start(campaignId);
    } else {
      this.core.db.run(
        "UPDATE campaigns SET status = 'running', paused_reason = NULL, updated_at = ? WHERE id = ?",
        this.now(),
        campaignId,
      );
    }
    return this.get(campaignId);
  }

  cancel(campaignId: number): Campaign {
    const row = this.row(campaignId);
    if (row.status === 'completed' || row.status === 'cancelled') throw conflict(`Campaign is already ${row.status}`);
    this.core.db.tx(() => {
      this.core.db.run(
        "UPDATE campaign_recipients SET status = 'skipped', error = 'campaign_cancelled' WHERE campaign_id = ? AND status = 'queued'",
        campaignId,
      );
      this.core.db.run(
        "UPDATE campaigns SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?",
        this.now(),
        this.now(),
        campaignId,
      );
    });
    return this.get(campaignId);
  }

  /** Start scheduled campaigns whose time has come. Returns the ids started. */
  promoteScheduled(now: Date): number[] {
    const due = this.core.db.all<{ id: number }>(
      "SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= ?",
      nowIso(now),
    );
    const started: number[] = [];
    for (const { id: campaignId } of due) {
      try {
        this.start(campaignId);
        started.push(campaignId);
      } catch (error) {
        this.core.log.error(`Scheduled campaign ${campaignId} failed to start: ${String(error)}`);
        this.core.db.run("UPDATE campaigns SET status = 'paused', paused_reason = ? WHERE id = ?", `Failed to start: ${String(error)}`, campaignId);
      }
    }
    return started;
  }

  completeFinished(): number[] {
    const done = this.core.db.all<{ id: number }>(
      `SELECT c.id FROM campaigns c WHERE c.status = 'running'
          AND NOT EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status IN ('queued', 'sending'))`,
    );
    for (const { id: campaignId } of done) {
      this.core.db.run(
        "UPDATE campaigns SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
        this.now(),
        this.now(),
        campaignId,
      );
      this.core.log.info(`Campaign ${campaignId} completed`);
    }
    return done.map(d => d.id);
  }

  // ---------------------------------------------------------------- dispatcher support

  runningForSession(sessionId: string): Campaign[] {
    return this.core.db
      .all<CampaignRow>("SELECT * FROM campaigns WHERE status = 'running' AND session_id = ? ORDER BY id", sessionId)
      .map(row => this.toCampaign(row, { ...EMPTY_STATS }));
  }

  runningSessionIds(): string[] {
    return this.core.db
      .all<{ session_id: string }>("SELECT DISTINCT session_id FROM campaigns WHERE status = 'running' AND session_id IS NOT NULL")
      .map(r => r.session_id);
  }

  /** Atomically move the next queued recipient to 'sending'. Single-process, so no row can be claimed twice. */
  claimNext(campaignId: number): { recipient: RecipientRow; contact: ContactRow } | null {
    const next = this.core.db.get<RecipientRow>(
      "SELECT * FROM campaign_recipients WHERE campaign_id = ? AND status = 'queued' ORDER BY id LIMIT 1",
      campaignId,
    );
    if (!next) return null;
    const { changes } = this.core.db.run(
      "UPDATE campaign_recipients SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'queued'",
      next.id,
    );
    if (!changes) return null;
    const contact = this.core.db.get<ContactRow>('SELECT * FROM contacts WHERE id = ?', next.contact_id);
    if (!contact) {
      this.core.db.run("UPDATE campaign_recipients SET status = 'skipped', error = 'contact_deleted' WHERE id = ?", next.id);
      return null;
    }
    return { recipient: { ...next, status: 'sending', attempts: next.attempts + 1 }, contact };
  }

  hasQueued(campaignId: number): boolean {
    return !!this.core.db.get("SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND status = 'queued' LIMIT 1", campaignId);
  }

  markSent(recipientId: number, waMessageId: string): void {
    this.core.db.run(
      "UPDATE campaign_recipients SET status = 'sent', wa_message_id = ?, sent_at = ?, error = NULL WHERE id = ?",
      waMessageId,
      this.now(),
      recipientId,
    );
  }

  markSkipped(recipientId: number, reason: string): void {
    this.core.db.run("UPDATE campaign_recipients SET status = 'skipped', error = ? WHERE id = ?", reason, recipientId);
  }

  markFailed(recipientId: number, error: string): void {
    this.core.db.run(
      "UPDATE campaign_recipients SET status = 'failed', error = ?, failed_at = ? WHERE id = ?",
      error.slice(0, 500),
      this.now(),
      recipientId,
    );
  }

  /** Put a recipient back after a transient failure. `countAttempt: false` for pacing refusals. */
  requeue(recipientId: number, error: string, countAttempt: boolean): void {
    this.core.db.run(
      `UPDATE campaign_recipients SET status = 'queued', error = ?, attempts = attempts - ? WHERE id = ?`,
      error.slice(0, 500),
      countAttempt ? 0 : 1,
      recipientId,
    );
  }

  // ---------------------------------------------------------------- rendering + links

  private createLinks(campaignId: number, variants: Variant[], options: CampaignOptions): void {
    if (!options.trackLinks || !this.core.config.publicUrl) return;
    const urls = new Set(variants.flatMap(v => extractUrls(v.body)));
    for (const url of urls) {
      const exists = this.core.db.get('SELECT 1 FROM links WHERE campaign_id = ? AND url = ?', campaignId, url);
      if (exists) continue;
      this.core.db.run(
        'INSERT INTO links (code, url, campaign_id, created_at) VALUES (?, ?, ?, ?)',
        randomToken(7),
        url,
        campaignId,
        this.now(),
      );
    }
    this.linkCache.delete(campaignId);
  }

  private links(campaignId: number): Map<string, string> {
    let map = this.linkCache.get(campaignId);
    if (!map) {
      map = new Map(
        this.core.db.all<{ url: string; code: string }>('SELECT url, code FROM links WHERE campaign_id = ?', campaignId).map(l => [l.url, l.code]),
      );
      this.linkCache.set(campaignId, map);
    }
    return map;
  }

  /** The exact text a recipient receives: personalization, tracked links, opt-out footer. */
  render(campaign: Campaign, variant: Variant, contact: ContactRow, token: string | null): string {
    const settings = this.settings.get();
    let text = renderTemplate(variant.body, contactVariables(toContact(contact), { business_name: settings.businessName })).text;
    const publicUrl = this.core.config.publicUrl;
    if (campaign.options.trackLinks && publicUrl && token) {
      const links = this.links(campaign.id);
      if (links.size) {
        text = replaceUrls(text, url => {
          const code = links.get(url);
          return code ? `${publicUrl}/r/${code}/${token}` : null;
        });
      }
    }
    const footer = settings.compliance.optOutFooter.trim();
    if (campaign.options.appendOptOut && footer) text = text.trim() ? `${text.trimEnd()}\n\n${footer}` : footer;
    return text;
  }

  variantFor(campaign: Campaign, key: string): Variant {
    return campaign.variants.find(v => v.key === key) ?? campaign.variants[0];
  }

  async testSend(campaignId: number, input: unknown): Promise<{ messageId: string }> {
    const data = z.object({ phone: z.string().min(3), variant: z.enum(['A', 'B', 'C']).default('A'), sessionId: z.string().optional() }).parse(input);
    const campaign = this.get(campaignId);
    const sessionId = data.sessionId ?? campaign.sessionId ?? this.settings.get().defaultSessionId;
    if (!sessionId) throw badRequest('Choose which WhatsApp number to send the test from');
    const normalized = normalizePhone(data.phone, this.settings.get().defaultCountry);
    if (!normalized.ok) throw badRequest(`Invalid phone number: ${normalized.reason}`);
    const contact =
      this.core.db.get<ContactRow>('SELECT * FROM contacts WHERE phone = ?', normalized.phone) ??
      ({
        id: 0,
        phone: normalized.phone,
        name: 'Test Recipient',
        email: null,
        attributes: '{}',
        consent: 'opted_in',
        wa_chat_id: null,
      } as unknown as ContactRow);
    const variant = this.variantFor(campaign, data.variant);
    const text = this.render(campaign, variant, contact, null);
    const chatId = contact.wa_chat_id ?? chatIdFor(normalized.phone);
    const sent = await this.sender.send(sessionId, chatId, { text, mediaId: variant.mediaId });
    this.messages.recordOutbound({
      contactId: contact.id || null,
      sessionId,
      chatId,
      waMessageId: sent.messageId,
      body: text,
      mediaId: variant.mediaId,
      type: sent.type,
      sourceType: 'test',
      sourceId: campaignId,
    });
    return { messageId: sent.messageId };
  }

  // ---------------------------------------------------------------- reporting

  report(campaignId: number) {
    const campaign = this.get(campaignId);
    const variants = this.core.db
      .all<Record<string, number | string>>(
        `SELECT variant,
                COUNT(*) AS total,
                SUM(status IN ('sent', 'delivered', 'read')) AS sent,
                SUM(status IN ('delivered', 'read')) AS delivered,
                SUM(status = 'read') AS read,
                SUM(replied_at IS NOT NULL) AS replied,
                SUM(clicked_at IS NOT NULL) AS clicked,
                SUM(opted_out_at IS NOT NULL) AS optedOut,
                SUM(status = 'failed') AS failed
           FROM campaign_recipients WHERE campaign_id = ? GROUP BY variant ORDER BY variant`,
        campaignId,
      )
      .map(v => ({
        key: String(v.variant),
        total: Number(v.total),
        sent: Number(v.sent),
        delivered: Number(v.delivered),
        read: Number(v.read),
        replied: Number(v.replied),
        clicked: Number(v.clicked),
        optedOut: Number(v.optedOut),
        failed: Number(v.failed),
      }));
    const skipReasons = this.core.db
      .all<{ reason: string; count: number }>(
        "SELECT COALESCE(error, 'unknown') AS reason, COUNT(*) AS count FROM campaign_recipients WHERE campaign_id = ? AND status = 'skipped' GROUP BY reason ORDER BY count DESC",
        campaignId,
      )
      .map(r => ({ ...r, label: SKIP_REASONS[r.reason] ?? r.reason }));
    const failureReasons = this.core.db.all<{ reason: string; count: number }>(
      "SELECT COALESCE(error, 'unknown') AS reason, COUNT(*) AS count FROM campaign_recipients WHERE campaign_id = ? AND status = 'failed' GROUP BY reason ORDER BY count DESC LIMIT 10",
      campaignId,
    );
    const timeline = this.core.db.all<{ hour: string; sent: number; read: number; replied: number }>(
      `SELECT substr(sent_at, 1, 13) || ':00:00Z' AS hour,
              COUNT(*) AS sent,
              SUM(read_at IS NOT NULL) AS read,
              SUM(replied_at IS NOT NULL) AS replied
         FROM campaign_recipients WHERE campaign_id = ? AND sent_at IS NOT NULL
        GROUP BY hour ORDER BY hour`,
      campaignId,
    );
    const links = this.core.db.all<{ code: string; url: string; clicks: number; uniqueClicks: number }>(
      `SELECT l.code, l.url, COUNT(k.id) AS clicks, COUNT(DISTINCT k.recipient_id) AS uniqueClicks
         FROM links l LEFT JOIN link_clicks k ON k.link_id = l.id
        WHERE l.campaign_id = ? GROUP BY l.id ORDER BY clicks DESC`,
      campaignId,
    );
    const settings = this.settings.get();
    const rate = Math.min(campaign.options.perMinute, settings.sending.sessionMaxPerMinute);
    const remaining = campaign.stats.queued + campaign.stats.sending;
    return {
      campaign,
      variants,
      skipReasons,
      failureReasons,
      timeline,
      links,
      trackingEnabled: campaign.options.trackLinks && !!this.core.config.publicUrl,
      estimate: remaining > 0 ? { remaining, minutes: Math.ceil(remaining / rate) } : null,
    };
  }

  recipients(campaignId: number, filter: { status?: string; page?: number; pageSize?: number }) {
    this.row(campaignId);
    const size = Math.min(Math.max(filter.pageSize ?? 50, 1), 500);
    const page = Math.max(filter.page ?? 1, 1);
    const statusSql =
      filter.status === 'replied'
        ? ' AND r.replied_at IS NOT NULL'
        : filter.status === 'clicked'
          ? ' AND r.clicked_at IS NOT NULL'
          : filter.status === 'opted_out'
            ? ' AND r.opted_out_at IS NOT NULL'
            : filter.status
              ? ' AND r.status = ?'
              : '';
    const params = filter.status && !['replied', 'clicked', 'opted_out'].includes(filter.status) ? [filter.status] : [];
    const total =
      this.core.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM campaign_recipients r WHERE r.campaign_id = ?${statusSql}`, campaignId, ...params)
        ?.n ?? 0;
    const items = this.core.db.all<RecipientRow & { name: string | null; phone: string }>(
      `SELECT r.*, c.name, c.phone FROM campaign_recipients r JOIN contacts c ON c.id = r.contact_id
        WHERE r.campaign_id = ?${statusSql} ORDER BY r.id LIMIT ? OFFSET ?`,
      campaignId,
      ...params,
      size,
      (page - 1) * size,
    );
    return {
      total,
      page,
      pageSize: size,
      items: items.map(r => ({
        id: r.id,
        contactId: r.contact_id,
        name: r.name,
        phone: r.phone,
        variant: r.variant,
        status: r.status,
        error: r.error ? (SKIP_REASONS[r.error] ?? r.error) : null,
        sentAt: r.sent_at,
        deliveredAt: r.delivered_at,
        readAt: r.read_at,
        repliedAt: r.replied_at,
        clickedAt: r.clicked_at,
        optedOutAt: r.opted_out_at,
      })),
    };
  }

  recipientsCsv(campaignId: number): string {
    this.row(campaignId);
    const rows = this.core.db.all<RecipientRow & { name: string | null; phone: string }>(
      `SELECT r.*, c.name, c.phone FROM campaign_recipients r JOIN contacts c ON c.id = r.contact_id WHERE r.campaign_id = ? ORDER BY r.id`,
      campaignId,
    );
    return toCsv(
      ['phone', 'name', 'variant', 'status', 'reason', 'sent_at', 'delivered_at', 'read_at', 'replied_at', 'clicked_at', 'opted_out_at'],
      rows.map(r => [
        `+${r.phone}`,
        r.name,
        r.variant,
        r.status,
        r.error ? (SKIP_REASONS[r.error] ?? r.error) : '',
        r.sent_at,
        r.delivered_at,
        r.read_at,
        r.replied_at,
        r.clicked_at,
        r.opted_out_at,
      ]),
    );
  }

  // ---------------------------------------------------------------- attribution + clicks

  /** Credit an inbound reply to the most recent campaign message this contact received. */
  attributeReply(contactId: number, at: string): number | null {
    const windowStart = nowIso(new Date(new Date(at).getTime() - this.settings.get().attributionWindowHours * 3_600_000));
    const recipient = this.core.db.get<{ id: number; campaign_id: number }>(
      `SELECT id, campaign_id FROM campaign_recipients
        WHERE contact_id = ? AND sent_at IS NOT NULL AND sent_at >= ? AND sent_at <= ? AND replied_at IS NULL
        ORDER BY sent_at DESC LIMIT 1`,
      contactId,
      windowStart,
      at,
    );
    if (!recipient) return null;
    // Replying proves the message reached them and was seen, even if the read receipt never came
    // (read receipts can be turned off).
    this.core.db.run(
      `UPDATE campaign_recipients SET replied_at = ?,
              status = CASE WHEN status IN ('sent', 'delivered') THEN 'read' ELSE status END,
              delivered_at = COALESCE(delivered_at, ?), read_at = COALESCE(read_at, ?)
        WHERE id = ?`,
      at,
      at,
      at,
      recipient.id,
    );
    return recipient.campaign_id;
  }

  /** Credit an opt-out to the campaign that most recently messaged the contact, if any. */
  attributeOptOut(contactId: number, at: string): number | null {
    const windowStart = nowIso(new Date(new Date(at).getTime() - this.settings.get().attributionWindowHours * 3_600_000));
    const recipient = this.core.db.get<{ id: number; campaign_id: number }>(
      `SELECT id, campaign_id FROM campaign_recipients
        WHERE contact_id = ? AND sent_at IS NOT NULL AND sent_at >= ? AND sent_at <= ? AND opted_out_at IS NULL
        ORDER BY sent_at DESC LIMIT 1`,
      contactId,
      windowStart,
      at,
    );
    if (!recipient) return null;
    this.core.db.run('UPDATE campaign_recipients SET opted_out_at = ? WHERE id = ?', at, recipient.id);
    return recipient.campaign_id;
  }

  recordClick(code: string, token: string | null, userAgent: string | undefined, isBot: boolean): string | null {
    const link = this.core.db.get<{ id: number; url: string; campaign_id: number | null }>(
      'SELECT id, url, campaign_id FROM links WHERE code = ?',
      code,
    );
    if (!link) return null;
    if (isBot) return link.url;
    const recipient = token
      ? this.core.db.get<{ id: number }>('SELECT id FROM campaign_recipients WHERE token = ? AND campaign_id IS ?', token, link.campaign_id)
      : undefined;
    const at = this.now();
    this.core.db.run(
      'INSERT INTO link_clicks (link_id, recipient_id, user_agent, clicked_at) VALUES (?, ?, ?, ?)',
      link.id,
      recipient?.id ?? null,
      userAgent?.slice(0, 300) ?? null,
      at,
    );
    if (recipient) {
      this.core.db.run('UPDATE campaign_recipients SET clicked_at = COALESCE(clicked_at, ?) WHERE id = ?', at, recipient.id);
    }
    return link.url;
  }
}
