import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Core } from '../context.js';
import { nowIso, parseJson } from '../db/database.js';
import { badRequest, notFound } from '../lib/errors.js';
import { chatIdFor, countryName, countryOfPhone, normalizePhone, phoneFromChatId, spreadsheetPhone } from '../lib/phone.js';
import { startOfLocalDay } from '../lib/time.js';
import { parseCsv, toCsv } from '../lib/csv.js';
import { renameVariable } from '../lib/template.js';
import type { SettingsService } from './settings.js';
import type { TagsService, Tag } from './tags.js';
import { andFragments, escapeLike, type SegmentsService, type SqlFragment } from './segments.js';
import type { Bus } from './bus.js';

export type Consent = 'opted_in' | 'unknown' | 'opted_out';
export type WaStatus = 'unknown' | 'valid' | 'invalid';
export const LEAD_STAGES = ['untouched', 'warm', 'cold', 'closed'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/** Where a contact came from, for the leads report. Lead sources are keyed `src:<id>`. */
const CHANNEL_NAMES: Record<string, string> = {
  import: 'CSV import',
  manual: 'Added manually',
  inbound: 'Messaged on WhatsApp',
  whatsapp: 'Chat on your WhatsApp',
  'auto-reply': 'WhatsApp keyword',
  'opt-in': 'Opted in on WhatsApp',
  'lead-form': 'Lead form',
  api: 'API',
};
function channelName(source: string | null): string {
  return CHANNEL_NAMES[source ?? ''] ?? (source ? source : 'Other');
}

export interface ContactRow {
  id: number;
  phone: string;
  name: string | null;
  email: string | null;
  attributes: string;
  consent: Consent;
  consent_source: string | null;
  consent_at: string | null;
  wa_status: WaStatus;
  wa_chat_id: string | null;
  wa_checked_at: string | null;
  wa_check_requested_at: string | null;
  source: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  lead_stage: LeadStage;
  lead_stage_at: string | null;
  lead_remark: string | null;
  lead_remark_by: string | null;
  lead_remark_at: string | null;
  lead_source_id: number | null;
  /** 0: someone who messaged in and is only in the Inbox, not (yet) a contact. */
  saved: number;
  /** ISO country of the number ('ZZ': unknown); null until worked out. */
  country: string | null;
  created_at: string;
  updated_at: string;
}

/** The tag for numbers from the business's own country: "Indian" for India, else the country's name. */
export function localTagName(home: string): string {
  return home.toUpperCase() === 'IN' ? 'Indian' : countryName(home);
}
export const INTERNATIONAL_TAG = 'International';

export interface Contact {
  id: number;
  phone: string;
  name: string | null;
  email: string | null;
  attributes: Record<string, string>;
  consent: Consent;
  consentSource: string | null;
  consentAt: string | null;
  waStatus: WaStatus;
  waChatId: string | null;
  waCheckedAt: string | null;
  waCheckPending: boolean;
  source: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  leadStage: LeadStage;
  leadStageAt: string | null;
  leadRemark: string | null;
  leadRemarkBy: string | null;
  leadRemarkAt: string | null;
  /** Where the lead came from: a lead source's name, or e.g. "CSV import". */
  channel: string;
  channelKey: string;
  /** False for people who only messaged in: shown in the Inbox, not in Contacts. */
  saved: boolean;
  /** The number's country (ISO code), when known. */
  country: string | null;
  createdAt: string;
  updatedAt: string;
  tags: Tag[];
}

export function toContact(row: ContactRow, tags: Tag[] = [], sourceNames: Map<number, string> = new Map()): Contact {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    email: row.email,
    attributes: parseJson<Record<string, string>>(row.attributes, {}),
    consent: row.consent,
    consentSource: row.consent_source,
    consentAt: row.consent_at,
    waStatus: row.wa_status,
    waChatId: row.wa_chat_id,
    waCheckedAt: row.wa_checked_at,
    waCheckPending: !!row.wa_check_requested_at,
    source: row.source,
    lastInboundAt: row.last_inbound_at,
    lastOutboundAt: row.last_outbound_at,
    leadStage: row.lead_stage ?? 'untouched',
    leadStageAt: row.lead_stage_at ?? null,
    leadRemark: row.lead_remark ?? null,
    leadRemarkBy: row.lead_remark_by ?? null,
    leadRemarkAt: row.lead_remark_at ?? null,
    channel: row.lead_source_id ? (sourceNames.get(row.lead_source_id) ?? 'Lead form') : channelName(row.source),
    channelKey: row.lead_source_id ? `src:${row.lead_source_id}` : (row.source ?? 'other'),
    saved: row.saved !== 0,
    country: row.country && row.country !== 'ZZ' ? row.country : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags,
  };
}

export function normalizeAttrKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

const RESERVED_ATTRS = new Set(['name', 'full_name', 'first_name', 'last_name', 'phone', 'email']);

function cleanAttributes(input: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = normalizeAttrKey(rawKey);
    if (!key || RESERVED_ATTRS.has(key)) continue;
    if (rawValue === null || rawValue === undefined) continue;
    const value = String(rawValue).trim().slice(0, 500);
    if (value) out[key] = value;
  }
  if (Object.keys(out).length > 100) throw badRequest('A contact can have at most 100 attributes');
  return out;
}

const consentSchema = z.enum(['opted_in', 'unknown', 'opted_out']);

export const contactInputSchema = z.object({
  phone: z.string().trim().min(3).max(40),
  name: z.string().trim().max(120).nullish(),
  email: z.string().trim().max(200).nullish(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  consent: consentSchema.optional(),
  consentSource: z.string().trim().max(120).optional(),
  tagIds: z.array(z.coerce.number().int().positive()).max(50).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
  source: z.string().trim().max(40).optional(),
});

export const contactPatchSchema = z.object({
  phone: z.string().trim().min(3).max(40).optional(),
  name: z.string().trim().max(120).nullish(),
  email: z.string().trim().max(200).nullish(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  consent: consentSchema.optional(),
  consentSource: z.string().trim().max(120).optional(),
  tagIds: z.array(z.coerce.number().int().positive()).max(50).optional(),
});

export const contactFilterSchema = z.object({
  q: z.string().trim().max(100).optional(),
  tagId: z.coerce.number().int().positive().optional(),
  consent: consentSchema.optional(),
  waStatus: z.enum(['unknown', 'valid', 'invalid']).optional(),
  segmentId: z.coerce.number().int().positive().optional(),
  stage: z.enum(LEAD_STAGES).optional(),
  /** A channel key from the leads report: `src:<lead source id>`, or a source such as `import`. */
  channel: z
    .string()
    .regex(/^(src:\d{1,9}|[a-z-]{1,20})$/)
    .optional(),
  /** A custom field: contacts that have it, or whose value contains `fieldValue`. */
  field: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
  fieldValue: z.string().trim().max(100).optional(),
  /** Numbers from the business's own country (e.g. Indian) or from anywhere else. */
  origin: z.enum(['local', 'international']).optional(),
  /** Added on or after / before these dates (YYYY-MM-DD, in the business's time zone). */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ids: z.array(z.coerce.number().int().positive()).max(100_000).optional(),
});

export type ContactFilter = z.infer<typeof contactFilterSchema>;

export interface FieldRule {
  target: 'rename' | 'name' | 'email' | 'ignore';
  renameTo: string | null;
}
const fieldKey = z.string().regex(/^[a-z0-9_]{1,64}$/, 'Unknown field');
/** JSON path for a custom field key (keys are [a-z0-9_] only). */
const jsonPath = (key: string) => `$."${key}"`;

export const bulkActionSchema = z.object({
  filter: contactFilterSchema,
  action: z.enum(['add_tags', 'remove_tags', 'set_consent', 'set_stage', 'delete', 'validate']),
  tagIds: z.array(z.coerce.number().int().positive()).max(50).optional(),
  consent: consentSchema.optional(),
  stage: z.enum(LEAD_STAGES).optional(),
});

export const leadUpdateSchema = z
  .object({
    stage: z.enum(LEAD_STAGES).optional(),
    remark: z.string().trim().max(2000).optional(),
  })
  .refine(v => v.stage !== undefined || v.remark !== undefined, 'Nothing to change');

export type ImportField = 'phone' | 'name' | 'first_name' | 'last_name' | 'email' | 'tags' | 'ignore' | `attr:${string}`;

export const importSchema = z.object({
  csv: z.string().min(1).max(25 * 1024 * 1024),
  mapping: z.record(z.string(), z.string()),
  tagIds: z.array(z.coerce.number().int().positive()).max(20).default([]),
  consent: z.enum(['opted_in', 'unknown']).default('unknown'),
  consentSource: z.string().trim().max(120).optional(),
  defaultCountry: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional(),
  /** Off by default: a number already saved keeps its first details (one number, one lead). */
  updateExisting: z.boolean().default(false),
});

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: Array<{ row: number; value: string; reason: string }>;
}

const MAX_IMPORT_ROWS = 100_000;

/** Columns our own export adds that describe WA Reach state, not the person; skipped on re-import. */
const SYSTEM_COLUMNS = new Set([
  'consent',
  'consent_source',
  'whatsapp',
  'wa_status',
  'source',
  'created_at',
  'updated_at',
  'id',
  'lead_stage',
  'lead_remark',
  'lead_remark_by',
  'channel',
]);

export function suggestField(header: string): ImportField {
  const h = header.trim().toLowerCase();
  if (SYSTEM_COLUMNS.has(h.replace(/[\s-]+/g, '_'))) return 'ignore';
  if (/(phone|mobile|whatsapp|wa number|cell|contact no|contact number|msisdn|^number$|^tel)/.test(h)) return 'phone';
  if (/^(first[\s_-]?name|fname|given[\s_-]?name)$/.test(h)) return 'first_name';
  if (/^(last[\s_-]?name|lname|surname|family[\s_-]?name)$/.test(h)) return 'last_name';
  if (/^(name|full[\s_-]?name|customer[\s_-]?name|contact[\s_-]?name|client[\s_-]?name)$/.test(h)) return 'name';
  if (/e-?mail/.test(h)) return 'email';
  if (/^(tags?|labels?|groups?|lists?)$/.test(h)) return 'tags';
  const key = normalizeAttrKey(header);
  return key ? `attr:${key}` : 'ignore';
}

export class ContactsService {
  constructor(
    private readonly core: Core,
    private readonly settings: SettingsService,
    private readonly tags: TagsService,
    private readonly segments: SegmentsService,
    private readonly bus: Bus,
  ) {}

  private now(): string {
    return nowIso(this.core.clock());
  }

  // ---------------------------------------------------------------- opt-out memory

  /** Keyed hash, so the stored value can't be turned back into the phone number. */
  private phoneHash(phone: string): string {
    return createHmac('sha256', this.core.config.appSecret).update(`suppressed:${phone}`).digest('hex');
  }

  /** Before deleting contacts, remember the numbers that had unsubscribed. */
  private rememberOptOuts(idsJson: string): void {
    const rows = this.core.db.all<{ phone: string }>(
      "SELECT phone FROM contacts WHERE consent = 'opted_out' AND id IN (SELECT value FROM json_each(?))",
      idsJson,
    );
    for (const { phone } of rows) {
      this.core.db.run('INSERT OR IGNORE INTO suppressed_phones (phone_hash, created_at) VALUES (?, ?)', this.phoneHash(phone), this.now());
    }
  }

  /** A newly created contact whose number unsubscribed before (and was deleted) starts as opted out. */
  private applySuppression(contactId: number, phone: string): void {
    if (!this.core.db.get('SELECT 1 FROM suppressed_phones WHERE phone_hash = ?', this.phoneHash(phone))) return;
    const now = this.now();
    this.core.db.run(
      "UPDATE contacts SET consent = 'opted_out', consent_source = 'unsubscribed before', consent_at = ?, updated_at = ? WHERE id = ?",
      now,
      now,
      contactId,
    );
  }

  // ---------------------------------------------------------------- queries

  filterSql(filter: ContactFilter): SqlFragment {
    // People who only messaged in (not saved as contacts) never appear in lists, exports or bulk actions.
    const parts: SqlFragment[] = [{ sql: 'c.saved = 1', params: [] }];
    if (filter.segmentId) parts.push(this.segments.where(this.segments.get(filter.segmentId).rules));
    if (filter.q) {
      const q = filter.q.trim();
      const digits = q.replace(/\D/g, '');
      const like = `%${escapeLike(q)}%`;
      if (digits.length >= 3) {
        parts.push({
          sql: "(c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')",
          params: [like, like, `%${escapeLike(digits)}%`],
        });
      } else {
        parts.push({ sql: "(c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\')", params: [like, like] });
      }
    }
    if (filter.tagId) {
      parts.push({ sql: 'EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id = ?)', params: [filter.tagId] });
    }
    if (filter.consent) parts.push({ sql: 'c.consent = ?', params: [filter.consent] });
    if (filter.stage) parts.push({ sql: 'c.lead_stage = ?', params: [filter.stage] });
    if (filter.field) {
      // The key is limited to [a-z0-9_], so it is safe inside the JSON path.
      const value = `json_extract(c.attributes, '$."${filter.field}"')`;
      if (filter.fieldValue) parts.push({ sql: `CAST(${value} AS TEXT) LIKE ? ESCAPE '\\'`, params: [`%${escapeLike(filter.fieldValue)}%`] });
      else parts.push({ sql: `${value} IS NOT NULL AND ${value} != ''`, params: [] });
    }
    if (filter.channel) {
      if (filter.channel.startsWith('src:')) parts.push({ sql: 'c.lead_source_id = ?', params: [Number(filter.channel.slice(4))] });
      else parts.push({ sql: 'c.lead_source_id IS NULL AND c.source = ?', params: [filter.channel] });
    }
    if (filter.from) parts.push({ sql: 'c.created_at >= ?', params: [this.dayStart(filter.from)] });
    if (filter.to) parts.push({ sql: 'c.created_at < ?', params: [this.dayStart(filter.to, 1)] });
    if (filter.waStatus) parts.push({ sql: 'c.wa_status = ?', params: [filter.waStatus] });
    if (filter.origin) {
      const home = this.settings.get().defaultCountry;
      parts.push(
        filter.origin === 'local'
          ? { sql: 'c.country = ?', params: [home] }
          : { sql: 'c.country IS NOT NULL AND c.country <> ?', params: [home] },
      );
    }
    if (filter.ids) {
      if (filter.ids.length === 0) parts.push({ sql: '0', params: [] });
      else parts.push({ sql: `c.id IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(filter.ids)] });
    }
    return andFragments(parts);
  }

  list(filter: ContactFilter, page = 1, pageSize = 50): { items: Contact[]; total: number; page: number; pageSize: number } {
    const where = this.filterSql(filter);
    const size = Math.min(Math.max(pageSize, 1), 500);
    const offset = (Math.max(page, 1) - 1) * size;
    const total = this.core.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts c WHERE ${where.sql}`, ...where.params)?.n ?? 0;
    const rows = this.core.db.all<ContactRow>(
      `SELECT c.* FROM contacts c WHERE ${where.sql} ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`,
      ...where.params,
      size,
      offset,
    );
    return { items: this.withTags(rows), total, page: Math.max(page, 1), pageSize: size };
  }

  ids(filter: ContactFilter): number[] {
    const where = this.filterSql(filter);
    return this.core.db.all<{ id: number }>(`SELECT c.id FROM contacts c WHERE ${where.sql}`, ...where.params).map(r => r.id);
  }

  withTags(rows: ContactRow[]): Contact[] {
    if (rows.length === 0) return [];
    const tagRows = this.core.db.all<{ contact_id: number; id: number; name: string; color: string }>(
      `SELECT ct.contact_id, t.id, t.name, t.color FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
        WHERE ct.contact_id IN (SELECT value FROM json_each(?)) ORDER BY t.name COLLATE NOCASE`,
      JSON.stringify(rows.map(r => r.id)),
    );
    const byContact = new Map<number, Tag[]>();
    for (const t of tagRows) {
      const list = byContact.get(t.contact_id) ?? [];
      list.push({ id: t.id, name: t.name, color: t.color });
      byContact.set(t.contact_id, list);
    }
    const names = this.sourceNames();
    return rows.map(row => toContact(row, byContact.get(row.id) ?? [], names));
  }

  row(contactId: number): ContactRow {
    const row = this.core.db.get<ContactRow>('SELECT * FROM contacts WHERE id = ?', contactId);
    if (!row) throw notFound('Contact');
    return row;
  }

  get(contactId: number): Contact {
    return this.withTags([this.row(contactId)])[0];
  }

  findByPhone(phone: string): ContactRow | undefined {
    return this.core.db.get<ContactRow>('SELECT * FROM contacts WHERE phone = ?', phone);
  }

  findByChatId(chatId: string): ContactRow | undefined {
    return this.core.db.get<ContactRow>('SELECT * FROM contacts WHERE wa_chat_id = ?', chatId);
  }

  // ---------------------------------------------------------------- mutations

  private normalizeOrThrow(phone: string): string {
    const result = normalizePhone(phone, this.settings.get().defaultCountry);
    if (!result.ok) throw badRequest(`Invalid phone number '${phone}': ${result.reason}`);
    return result.phone;
  }

  /**
   * Create a contact, or merge into the existing one with the same phone number.
   * Consent only moves in allowed directions: an opt-out recorded from the contact themselves is
   * never overwritten by an import or API call claiming opt-in (see setConsent for the rule).
   */
  upsert(input: unknown): { contact: Contact; created: boolean } {
    const data = contactInputSchema.parse(input);
    const phone = this.normalizeOrThrow(data.phone);
    const tagIds = [...(data.tagIds ?? [])];
    for (const name of data.tags ?? []) tagIds.push(this.tags.ensure(name));
    for (const tagId of tagIds) if (!this.tags.exists(tagId)) throw badRequest(`Tag ${tagId} does not exist`);

    return this.core.db.tx(() => {
      const existing = this.findByPhone(phone);
      const now = this.now();
      let contactId: number;
      let created = false;
      const incoming = this.applyFieldRenames(cleanAttributes(data.attributes));
      if (existing && !existing.saved) {
        // Someone who messaged in is now being added as a contact.
        this.promote(existing.id, data.source ?? 'manual');
        created = true;
      }
      if (existing) {
        const attrs = { ...parseJson<Record<string, string>>(existing.attributes, {}), ...incoming };
        this.core.db.run(
          'UPDATE contacts SET name = COALESCE(?, name), email = COALESCE(?, email), attributes = ?, updated_at = ? WHERE id = ?',
          data.name || null,
          data.email || null,
          JSON.stringify(attrs),
          now,
          existing.id,
        );
        contactId = existing.id;
      } else {
        contactId = this.core.db.run(
          `INSERT INTO contacts (phone, name, email, attributes, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          phone,
          data.name || null,
          data.email || null,
          JSON.stringify(incoming),
          data.source ?? 'manual',
          now,
          now,
        ).lastInsertRowid;
        this.applySuppression(contactId, phone);
        created = true;
      }
      if (data.consent) this.setConsent(contactId, data.consent, data.consentSource ?? data.source ?? 'manual');
      this.addTags([contactId], tagIds);
      this.assignCountry(contactId);
      return { contact: this.get(contactId), created };
    });
  }

  update(contactId: number, input: unknown): Contact {
    const data = contactPatchSchema.parse(input);
    const row = this.row(contactId);
    return this.core.db.tx(() => {
      const now = this.now();
      if (data.phone !== undefined) {
        const phone = this.normalizeOrThrow(data.phone);
        if (phone !== row.phone) {
          const clash = this.findByPhone(phone);
          if (clash) throw badRequest(`Another contact already uses +${phone}`);
          this.core.db.run(
            "UPDATE contacts SET phone = ?, wa_status = 'unknown', wa_chat_id = NULL, wa_checked_at = NULL, country = NULL WHERE id = ?",
            phone,
            contactId,
          );
        }
      }
      if (data.name !== undefined) this.core.db.run('UPDATE contacts SET name = ? WHERE id = ?', data.name || null, contactId);
      if (data.email !== undefined) this.core.db.run('UPDATE contacts SET email = ? WHERE id = ?', data.email || null, contactId);
      if (data.attributes !== undefined) {
        this.core.db.run('UPDATE contacts SET attributes = ? WHERE id = ?', JSON.stringify(cleanAttributes(data.attributes)), contactId);
      }
      if (data.consent !== undefined) this.setConsent(contactId, data.consent, data.consentSource ?? 'manual', true);
      if (data.tagIds !== undefined) {
        for (const tagId of data.tagIds) if (!this.tags.exists(tagId)) throw badRequest(`Tag ${tagId} does not exist`);
        const current = this.core.db.all<{ tag_id: number }>('SELECT tag_id FROM contact_tags WHERE contact_id = ?', contactId).map(r => r.tag_id);
        const remove = current.filter(id => !data.tagIds!.includes(id));
        this.removeTags([contactId], remove);
        this.addTags([contactId], data.tagIds);
      }
      this.core.db.run('UPDATE contacts SET updated_at = ? WHERE id = ?', now, contactId);
      this.assignCountry(contactId);
      return this.get(contactId);
    });
  }

  delete(contactId: number): void {
    this.core.db.tx(() => {
      this.rememberOptOuts(JSON.stringify([contactId]));
      const { changes } = this.core.db.run('DELETE FROM contacts WHERE id = ?', contactId);
      if (!changes) throw notFound('Contact');
    });
  }

  /**
   * Record consent. `manualOverride` is true only for an operator editing one contact by hand in
   * the UI; imports, APIs and automations can never flip an opted_out contact back to opted_in —
   * only the contact can, by texting an opt-in keyword (source 'keyword').
   */
  setConsent(contactId: number, consent: Consent, source: string, manualOverride = false): boolean {
    const row = this.row(contactId);
    if (row.consent === consent) return false;
    if (row.consent === 'opted_out' && consent !== 'opted_out' && source !== 'keyword' && !manualOverride) return false;
    this.core.db.run(
      'UPDATE contacts SET consent = ?, consent_source = ?, consent_at = ?, updated_at = ? WHERE id = ?',
      consent,
      source,
      this.now(),
      this.now(),
      contactId,
    );
    if (consent === 'opted_in') this.core.db.run('DELETE FROM suppressed_phones WHERE phone_hash = ?', this.phoneHash(row.phone));
    this.bus.emit('consent.changed', { contactId, from: row.consent, to: consent });
    return true;
  }

  addTags(contactIds: number[], tagIds: number[]): number {
    if (contactIds.length === 0 || tagIds.length === 0) return 0;
    let added = 0;
    const now = this.now();
    this.core.db.tx(() => {
      for (const contactId of contactIds) {
        for (const tagId of tagIds) {
          const { changes } = this.core.db.run(
            'INSERT OR IGNORE INTO contact_tags (contact_id, tag_id, created_at) VALUES (?, ?, ?)',
            contactId,
            tagId,
            now,
          );
          if (changes) {
            added++;
            this.bus.emit('tag.added', { contactId, tagId });
          }
        }
      }
    });
    return added;
  }

  removeTags(contactIds: number[], tagIds: number[]): number {
    if (contactIds.length === 0 || tagIds.length === 0) return 0;
    return this.core.db.run(
      `DELETE FROM contact_tags WHERE contact_id IN (SELECT value FROM json_each(?)) AND tag_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(contactIds),
      JSON.stringify(tagIds),
    ).changes;
  }

  requestValidation(contactIds: number[]): number {
    if (contactIds.length === 0) return 0;
    return this.core.db.run(
      `UPDATE contacts SET wa_check_requested_at = ? WHERE id IN (SELECT value FROM json_each(?)) AND wa_check_requested_at IS NULL`,
      this.now(),
      JSON.stringify(contactIds),
    ).changes;
  }

  bulk(input: unknown): { affected: number } {
    const data = bulkActionSchema.parse(input);
    const ids = this.ids(data.filter);
    switch (data.action) {
      case 'add_tags':
        if (!data.tagIds?.length) throw badRequest('tagIds is required');
        return { affected: this.addTags(ids, data.tagIds) };
      case 'remove_tags':
        if (!data.tagIds?.length) throw badRequest('tagIds is required');
        return { affected: this.removeTags(ids, data.tagIds) };
      case 'set_consent': {
        if (!data.consent) throw badRequest('consent is required');
        let affected = 0;
        this.core.db.tx(() => {
          for (const id of ids) if (this.setConsent(id, data.consent!, 'bulk')) affected++;
        });
        return { affected };
      }
      case 'delete':
        return {
          affected: this.core.db.tx(() => {
            this.rememberOptOuts(JSON.stringify(ids));
            return this.core.db.run('DELETE FROM contacts WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids)).changes;
          }),
        };
      case 'validate':
        return { affected: this.requestValidation(ids) };
      case 'set_stage': {
        if (!data.stage) throw badRequest('stage is required');
        const now = this.now();
        return {
          affected: this.core.db.run(
            'UPDATE contacts SET lead_stage = ?, lead_stage_at = ?, updated_at = ? WHERE lead_stage != ? AND id IN (SELECT value FROM json_each(?))',
            data.stage,
            now,
            now,
            data.stage,
            JSON.stringify(ids),
          ).changes,
        };
      }
    }
  }

  // ---------------------------------------------------------------- lead tracking

  /** Set a lead's stage and/or its shared remark. `by` is who made the change (shown to the team). */
  setLead(contactId: number, input: unknown, by: string): Contact {
    const data = leadUpdateSchema.parse(input);
    const row = this.row(contactId);
    const now = this.now();
    this.core.db.tx(() => {
      if (data.stage !== undefined && data.stage !== row.lead_stage) {
        this.core.db.run('UPDATE contacts SET lead_stage = ?, lead_stage_at = ? WHERE id = ?', data.stage, now, contactId);
      }
      if (data.remark !== undefined && data.remark !== (row.lead_remark ?? '')) {
        this.core.db.run(
          'UPDATE contacts SET lead_remark = ?, lead_remark_by = ?, lead_remark_at = ? WHERE id = ?',
          data.remark || null,
          data.remark ? by.slice(0, 120) : null,
          data.remark ? now : null,
          contactId,
        );
      }
      this.core.db.run('UPDATE contacts SET updated_at = ? WHERE id = ?', now, contactId);
    });
    return this.get(contactId);
  }

  /** Fill in only what a contact is missing (name, email, custom fields); returns what was filled. */
  fillBlanks(contactId: number, data: { name?: string | null; email?: string | null; attributes?: Record<string, string> }): string[] {
    const row = this.row(contactId);
    const attrs = parseJson<Record<string, string>>(row.attributes, {});
    const filled: string[] = [];
    const name = !row.name && data.name ? data.name.slice(0, 120) : row.name;
    const email = !row.email && data.email ? data.email.slice(0, 200) : row.email;
    if (name !== row.name) filled.push('name');
    if (email !== row.email) filled.push('email');
    let added = 0;
    for (const [key, value] of Object.entries(data.attributes ?? {})) {
      const clean = normalizeAttrKey(key);
      if (!clean || RESERVED_ATTRS.has(clean) || clean in attrs || Object.keys(attrs).length >= 100) continue;
      const text = String(value).trim().slice(0, 500);
      if (!text) continue;
      attrs[clean] = text;
      added++;
    }
    if (added) filled.push(`${added} custom field${added === 1 ? '' : 's'}`);
    if (filled.length) {
      this.core.db.run('UPDATE contacts SET name = ?, email = ?, attributes = ?, updated_at = ? WHERE id = ?', name, email, JSON.stringify(attrs), this.now(), contactId);
    }
    return filled;
  }

  /** Turn an Inbox-only person into a contact; "added" is now. Returns false if already a contact. */
  private promote(contactId: number, source: string): boolean {
    const now = this.now();
    return (
      this.core.db.run('UPDATE contacts SET saved = 1, source = ?, created_at = ?, updated_at = ? WHERE id = ? AND saved = 0', source, now, now, contactId).changes > 0
    );
  }

  /** "Add to contacts" from the Inbox (or an auto-reply that tags someone). */
  addToContacts(contactId: number, source = 'inbound'): Contact {
    this.row(contactId);
    this.promote(contactId, source);
    return this.get(contactId);
  }

  /** Remember which lead source brought a new contact in (first source only). */
  setLeadSource(contactId: number, sourceId: number): void {
    this.core.db.run('UPDATE contacts SET lead_source_id = ? WHERE id = ? AND lead_source_id IS NULL', sourceId, contactId);
  }

  private sourceNames(): Map<number, string> {
    return new Map(this.core.db.all<{ id: number; name: string }>('SELECT id, name FROM lead_sources').map(r => [r.id, r.name]));
  }

  /** UTC instant at which the local day `ymd` (+ `addDays`) starts in the business's time zone. */
  private dayStart(ymd: string, addDays = 0): string {
    const [y, m, d] = ymd.split('-').map(Number);
    const noon = new Date(Date.UTC(y, m - 1, d + addDays, 12));
    return startOfLocalDay(noon, this.settings.get().timezone).toISOString();
  }

  /** Scoreboard, channel table and funnel for leads added in a date range. */
  leadReport(input: unknown) {
    const filter = contactFilterSchema.pick({ from: true, to: true }).parse(input ?? {});
    const where = this.filterSql(filter);
    const byStage = Object.fromEntries(LEAD_STAGES.map(stage => [stage, 0])) as Record<LeadStage, number>;
    for (const r of this.core.db.all<{ lead_stage: LeadStage; n: number }>(
      `SELECT c.lead_stage, COUNT(*) AS n FROM contacts c WHERE ${where.sql} GROUP BY c.lead_stage`,
      ...where.params,
    )) {
      byStage[r.lead_stage] = r.n;
    }
    const total = LEAD_STAGES.reduce((sum, stage) => sum + byStage[stage], 0);
    const names = this.sourceNames();
    const channels = new Map<string, { key: string; name: string; leads: number } & Record<LeadStage, number>>();
    for (const r of this.core.db.all<{ lead_source_id: number | null; source: string | null; lead_stage: LeadStage; n: number }>(
      `SELECT c.lead_source_id, c.source, c.lead_stage, COUNT(*) AS n FROM contacts c WHERE ${where.sql}
        GROUP BY c.lead_source_id, CASE WHEN c.lead_source_id IS NULL THEN c.source END, c.lead_stage`,
      ...where.params,
    )) {
      const key = r.lead_source_id ? `src:${r.lead_source_id}` : (r.source ?? 'other');
      const name = r.lead_source_id ? (names.get(r.lead_source_id) ?? 'Lead form') : channelName(r.source);
      const entry = channels.get(key) ?? { key, name, leads: 0, untouched: 0, warm: 0, cold: 0, closed: 0 };
      entry.leads += r.n;
      entry[r.lead_stage] += r.n;
      channels.set(key, entry);
    }
    return {
      range: { from: filter.from ?? null, to: filter.to ?? null },
      total,
      byStage,
      channels: [...channels.values()].sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name)),
      funnel: [
        { key: 'total', label: 'Total leads', count: total },
        { key: 'contacted', label: 'Followed up', count: total - byStage.untouched },
        { key: 'interested', label: 'Warm or closed', count: byStage.warm + byStage.closed },
        { key: 'closed', label: 'Closed', count: byStage.closed },
      ],
    };
  }

  // ---------------------------------------------------------------- inbound + validation helpers

  /** Contact for an inbound WhatsApp sender, creating it on first contact. */
  touchInbound(phone: string, chatId: string | null, pushName: string | null, at: string, save = true): { row: ContactRow; created: boolean } {
    const existing = this.findByPhone(phone);
    if (existing) {
      this.core.db.run(
        `UPDATE contacts SET last_inbound_at = ?, wa_status = 'valid', wa_chat_id = COALESCE(?, wa_chat_id),
                name = COALESCE(name, ?), updated_at = ? WHERE id = ?`,
        at,
        chatId,
        pushName,
        at,
        existing.id,
      );
      return { row: this.row(existing.id), created: false };
    }
    const id = this.core.db.run(
      `INSERT INTO contacts (phone, name, wa_status, wa_chat_id, source, last_inbound_at, saved, created_at, updated_at)
       VALUES (?, ?, 'valid', ?, 'inbound', ?, ?, ?, ?)`,
      phone,
      pushName,
      chatId,
      at,
      save ? 1 : 0,
      at,
      at,
    ).lastInsertRowid;
    this.applySuppression(id, phone);
    this.assignCountry(id);
    return { row: this.row(id), created: true };
  }

  /**
   * The contact for a WhatsApp chat copied into the Inbox (a message typed on the phone, or chat
   * history). Someone new is kept for the Inbox only, never added to Contacts or campaigns.
   */
  forChat(phone: string, chatId: string, name: string | null, lastInboundAt: string | null = null): ContactRow {
    const existing = this.findByPhone(phone);
    const now = this.now();
    // Messages are sent to the number's own chat, never to a privacy id (@lid) that hides it.
    chatId = phoneFromChatId(chatId) ? chatId : chatIdFor(phone);
    if (existing) {
      this.core.db.run(
        `UPDATE contacts SET wa_status = 'valid', wa_chat_id = COALESCE(wa_chat_id, ?), name = COALESCE(name, ?),
                last_inbound_at = CASE WHEN ? IS NOT NULL AND (last_inbound_at IS NULL OR last_inbound_at < ?) THEN ? ELSE last_inbound_at END
          WHERE id = ?`,
        chatId,
        name,
        lastInboundAt,
        lastInboundAt,
        lastInboundAt,
        existing.id,
      );
      return this.row(existing.id);
    }
    const id = this.core.db.run(
      `INSERT INTO contacts (phone, name, wa_status, wa_chat_id, source, last_inbound_at, saved, created_at, updated_at)
       VALUES (?, ?, 'valid', ?, 'whatsapp', ?, 0, ?, ?)`,
      phone,
      name,
      chatId,
      lastInboundAt,
      now,
      now,
    ).lastInsertRowid;
    this.applySuppression(id, phone);
    this.assignCountry(id);
    return this.row(id);
  }

  // ---------------------------------------------------------------- Indian / International

  /**
   * The two country tags, created when first needed. Their ids are remembered, so a business can
   * rename them ("India", "NRI") and new numbers still get the renamed tag.
   */
  private countryTagIds(): { local: number; international: number } {
    const home = this.settings.get().defaultCountry;
    const stored = parseJson<{ home?: string; local?: number; international?: number }>(
      this.core.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'country_tags'")?.value,
      {},
    );
    const valid = (id: number | undefined) => (id && this.tags.exists(id) ? id : null);
    const local = (stored.home === home ? valid(stored.local) : null) ?? this.tags.ensure(localTagName(home));
    const international = valid(stored.international) ?? this.tags.ensure(INTERNATIONAL_TAG);
    if (stored.home !== home || stored.local !== local || stored.international !== international) {
      this.core.db.run(
        "INSERT INTO settings (key, value) VALUES ('country_tags', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        JSON.stringify({ home, local, international }),
      );
    }
    return { local, international };
  }

  /** Tag one contact by its country, replacing the other country tag (no automations are started). */
  private tagByCountry(contactId: number, country: string, tags: { local: number; international: number }, home: string): void {
    const [add, drop] = country === home ? [tags.local, tags.international] : [tags.international, tags.local];
    this.core.db.run('DELETE FROM contact_tags WHERE contact_id = ? AND tag_id = ?', contactId, drop);
    this.core.db.run('INSERT OR IGNORE INTO contact_tags (contact_id, tag_id, created_at) VALUES (?, ?, ?)', contactId, add, this.now());
  }

  /** Work out the country of a new or changed number and tag it Indian / International. */
  assignCountry(contactId: number): void {
    const row = this.core.db.get<{ phone: string; country: string | null }>('SELECT phone, country FROM contacts WHERE id = ?', contactId);
    if (!row || row.country !== null) return;
    const country = countryOfPhone(row.phone) ?? 'ZZ';
    this.core.db.run('UPDATE contacts SET country = ? WHERE id = ?', country, contactId);
    const settings = this.settings.get();
    if (settings.countryTags) this.tagByCountry(contactId, country, this.countryTagIds(), settings.defaultCountry);
  }

  /** Every number whose country is not worked out yet (after an import, or once after an update). */
  assignCountries(): number {
    let total = 0;
    for (;;) {
      const rows = this.core.db.all<{ id: number }>('SELECT id FROM contacts WHERE country IS NULL LIMIT 500');
      if (rows.length === 0) return total;
      this.core.db.tx(() => {
        for (const row of rows) this.assignCountry(row.id);
      });
      total += rows.length;
    }
  }

  /** Tag everyone again by country (when the tags are turned on, or the business's country changes). */
  retagCountries(): number {
    const settings = this.settings.get();
    if (!settings.countryTags) return 0;
    this.assignCountries();
    const tags = this.countryTagIds();
    const rows = this.core.db.all<{ id: number; country: string }>('SELECT id, country FROM contacts WHERE country IS NOT NULL');
    this.core.db.tx(() => {
      for (const row of rows) this.tagByCountry(row.id, row.country, tags, settings.defaultCountry);
    });
    return rows.length;
  }

  recordValidation(contactId: number, exists: boolean, chatId: string | null): void {
    this.core.db.run(
      `UPDATE contacts SET wa_status = ?, wa_chat_id = COALESCE(?, wa_chat_id), wa_checked_at = ?, wa_check_requested_at = NULL,
              updated_at = ? WHERE id = ?`,
      exists ? 'valid' : 'invalid',
      exists ? chatId : null,
      this.now(),
      this.now(),
      contactId,
    );
  }

  // ---------------------------------------------------------------- CSV

  previewImport(csv: string): { headers: string[]; rows: string[][]; totalRows: number; mapping: Record<string, ImportField> } {
    const rows = parseCsv(csv);
    if (rows.length === 0) throw badRequest('The file is empty');
    const headers = rows[0].map(h => h.trim());
    const mapping: Record<string, ImportField> = {};
    let phoneAssigned = false;
    headers.forEach((header, index) => {
      let field = suggestField(header);
      if (field === 'phone') {
        if (phoneAssigned) field = `attr:${normalizeAttrKey(header) || `column_${index + 1}`}`;
        phoneAssigned = true;
      }
      mapping[String(index)] = field;
    });
    return { headers, rows: rows.slice(1, 6), totalRows: rows.length - 1, mapping };
  }

  importCsv(input: unknown): ImportResult {
    const data = importSchema.parse(input);
    const rows = parseCsv(data.csv);
    if (rows.length < 2) throw badRequest('The file has no data rows');
    if (rows.length - 1 > MAX_IMPORT_ROWS) throw badRequest(`At most ${MAX_IMPORT_ROWS} rows per import`);
    const mapping = new Map<number, ImportField>();
    for (const [index, field] of Object.entries(data.mapping)) {
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0) continue;
      if (field === 'ignore') continue;
      if (!['phone', 'name', 'first_name', 'last_name', 'email', 'tags'].includes(field) && !/^attr:[a-z0-9_]{1,64}$/.test(field)) {
        throw badRequest(`Unknown mapping target '${field}'`);
      }
      mapping.set(i, field as ImportField);
    }
    const phoneColumns = [...mapping.entries()].filter(([, f]) => f === 'phone');
    if (phoneColumns.length !== 1) throw badRequest('Map exactly one column to Phone');
    for (const tagId of data.tagIds) if (!this.tags.exists(tagId)) throw badRequest(`Tag ${tagId} does not exist`);

    const country = data.defaultCountry?.toUpperCase() ?? this.settings.get().defaultCountry;
    const result: ImportResult = { total: rows.length - 1, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
    const tagCache = new Map<string, number>();
    const seen = new Set<string>();
    const consentSource = data.consentSource || 'import';
    const rules = this.fieldRules();

    this.core.db.tx(() => {
      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r];
        const record: { phone?: string; name?: string; first?: string; last?: string; email?: string; tags: string[]; attrs: Record<string, string> } = {
          tags: [],
          attrs: {},
        };
        for (const [index, field] of mapping) {
          const value = (cells[index] ?? '').trim();
          if (!value) continue;
          if (field === 'phone') record.phone = value;
          else if (field === 'name') record.name = value;
          else if (field === 'first_name') record.first = value;
          else if (field === 'last_name') record.last = value;
          else if (field === 'email') record.email = value;
          else if (field === 'tags') record.tags.push(...value.split(/[,;|]/).map(t => t.trim()).filter(Boolean));
          else {
            const key = field.slice(5);
            const rule = rules[key];
            if (rule?.target === 'ignore') continue;
            record.attrs[rule?.target === 'rename' && rule.renameTo ? rule.renameTo : key] = value;
          }
        }
        const normalized = normalizePhone(record.phone, country);
        if (!normalized.ok) {
          result.skipped++;
          if (result.errors.length < 200) result.errors.push({ row: r + 1, value: record.phone ?? '', reason: normalized.reason });
          continue;
        }
        if (seen.has(normalized.phone)) {
          result.skipped++;
          if (result.errors.length < 200) result.errors.push({ row: r + 1, value: record.phone ?? '', reason: 'duplicate of an earlier row' });
          continue;
        }
        seen.add(normalized.phone);
        const name = record.name ?? ([record.first, record.last].filter(Boolean).join(' ') || undefined);
        const tagIds = [...data.tagIds];
        for (const tagName of record.tags) {
          const key = tagName.toLowerCase();
          if (!tagCache.has(key)) tagCache.set(key, this.tags.ensure(tagName));
          tagIds.push(tagCache.get(key)!);
        }
        const existing = this.findByPhone(normalized.phone);
        const now = this.now();
        let contactId: number;
        if (existing && !existing.saved) {
          // Someone who only messaged in: this import adds them as a contact.
          contactId = existing.id;
          this.promote(contactId, 'import');
          this.core.db.run(
            'UPDATE contacts SET name = COALESCE(?, name), email = COALESCE(?, email), attributes = ? WHERE id = ?',
            name ?? null,
            record.email ?? null,
            JSON.stringify({ ...parseJson<Record<string, string>>(existing.attributes, {}), ...cleanAttributes(record.attrs) }),
            contactId,
          );
          result.created++;
        } else if (existing) {
          contactId = existing.id;
          if (data.updateExisting) {
            const attrs = { ...parseJson<Record<string, string>>(existing.attributes, {}), ...cleanAttributes(record.attrs) };
            const changed =
              (name && name !== existing.name) ||
              (record.email && record.email !== existing.email) ||
              JSON.stringify(attrs) !== existing.attributes;
            if (changed) {
              this.core.db.run(
                'UPDATE contacts SET name = COALESCE(?, name), email = COALESCE(?, email), attributes = ?, updated_at = ? WHERE id = ?',
                name ?? null,
                record.email ?? null,
                JSON.stringify(attrs),
                now,
                contactId,
              );
              result.updated++;
            } else {
              result.unchanged++;
            }
          } else {
            result.unchanged++;
          }
        } else {
          contactId = this.core.db.run(
            `INSERT INTO contacts (phone, name, email, attributes, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'import', ?, ?)`,
            normalized.phone,
            name ?? null,
            record.email ?? null,
            JSON.stringify(cleanAttributes(record.attrs)),
            now,
            now,
          ).lastInsertRowid;
          this.applySuppression(contactId, normalized.phone);
          result.created++;
        }
        if (data.consent === 'opted_in') this.setConsent(contactId, 'opted_in', consentSource);
        this.addTags([contactId], [...new Set(tagIds)]);
      }
    });
    this.assignCountries();
    return result;
  }

  exportCsv(filter: ContactFilter): string {
    const where = this.filterSql(filter);
    const rows = this.core.db.all<ContactRow>(`SELECT c.* FROM contacts c WHERE ${where.sql} ORDER BY c.id`, ...where.params);
    const contacts = this.withTags(rows);
    const attrKeys = [...new Set(contacts.flatMap(c => Object.keys(c.attributes)))].sort();
    const header = ['phone', 'name', 'email', 'lead_stage', 'lead_remark', 'lead_remark_by', 'channel', 'consent', 'consent_source', 'whatsapp', 'tags', 'source', 'created_at', ...attrKeys];
    const body = contacts.map(c => [
      spreadsheetPhone(c.phone),
      c.name,
      c.email,
      c.leadStage,
      c.leadRemark,
      c.leadRemarkBy,
      c.channel,
      c.consent,
      c.consentSource,
      c.waStatus,
      c.tags.map(t => t.name).join(', '),
      c.source,
      c.createdAt,
      ...attrKeys.map(k => c.attributes[k] ?? ''),
    ]);
    return toCsv(header, body);
  }

  // ---------------------------------------------------------------- custom fields (business-wide)

  /** Custom fields in use, how many contacts have each, and an example value from a recent contact. */
  fields(): Array<{ key: string; count: number; sample: string | null }> {
    const fields = this.core.db.all<{ key: string; count: number }>(
      "SELECT j.key AS key, COUNT(*) AS count FROM contacts c, json_each(c.attributes) j WHERE j.value IS NOT NULL AND j.value != '' GROUP BY j.key ORDER BY j.key LIMIT 500",
    );
    const samples = new Map<string, string>();
    for (const row of this.core.db.all<{ attributes: string }>("SELECT attributes FROM contacts WHERE attributes != '{}' ORDER BY id DESC LIMIT 300")) {
      for (const [key, value] of Object.entries(parseJson<Record<string, string>>(row.attributes, {}))) {
        if (!samples.has(key) && String(value).trim()) samples.set(key, String(value).slice(0, 60));
      }
    }
    return fields.map(f => ({ ...f, sample: samples.get(f.key) ?? null }));
  }

  /**
   * Custom-field values that are JavaScript dates as Google Sheets sends them
   * ("Tue Oct 27 2026 00:00:00 GMT+0530 (India Standard Time)") become "27 Oct 2026".
   */
  tidyDateValues(tidy: (value: string) => string): number {
    let fixed = 0;
    const rows = this.core.db.all<{ id: number; attributes: string }>(
      "SELECT id, attributes FROM contacts WHERE attributes LIKE '%GMT+%' OR attributes LIKE '%GMT-%'",
    );
    for (const row of rows) {
      const attrs = parseJson<Record<string, string>>(row.attributes, {});
      let changed = false;
      for (const [key, value] of Object.entries(attrs)) {
        const next = typeof value === 'string' ? tidy(value) : value;
        if (next !== value) {
          attrs[key] = next;
          changed = true;
        }
      }
      if (changed) {
        this.core.db.run('UPDATE contacts SET attributes = ? WHERE id = ?', JSON.stringify(attrs), row.id);
        fixed++;
      }
    }
    return fixed;
  }

  /** What happens to a field in new leads and imports: renamed, put into name/email, or not saved. */
  fieldRules(): Record<string, FieldRule> {
    const rules: Record<string, FieldRule> = {};
    for (const r of this.core.db.all<{ key: string; target: FieldRule['target']; rename_to: string | null }>('SELECT key, target, rename_to FROM field_rules')) {
      rules[r.key] = { target: r.target, renameTo: r.rename_to };
    }
    return rules;
  }

  removeFieldRule(key: string): void {
    this.core.db.run('DELETE FROM field_rules WHERE key = ?', fieldKey.parse(key));
  }

  /** Custom fields with any renames applied (used for new leads, imports and API calls). */
  applyFieldRenames(attrs: Record<string, string>, rules = this.fieldRules()): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(attrs)) {
      const rule = rules[key];
      if (rule?.target === 'ignore') continue;
      const target = rule?.target === 'rename' && rule.renameTo ? rule.renameTo : key;
      if (!(target in out)) out[target] = value;
    }
    return out;
  }

  private setFieldRule(key: string, target: FieldRule['target'], renameTo: string | null = null): void {
    this.core.db.run(
      'INSERT INTO field_rules (key, target, rename_to, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET target = excluded.target, rename_to = excluded.rename_to, updated_at = excluded.updated_at',
      key,
      target,
      renameTo,
      this.now(),
    );
  }

  /**
   * Rename a custom field for every contact, in saved messages ({{old}} -> {{new}}) and segments,
   * and for future leads/imports. A contact that already has the new field keeps its value.
   */
  renameField(input: unknown): { renamed: number } {
    const { from, to: rawTo } = z.object({ from: fieldKey, to: z.string().trim().min(1).max(64) }).parse(input);
    const to = normalizeAttrKey(rawTo);
    if (!to) throw badRequest('Use letters or numbers in the new name');
    if (RESERVED_ATTRS.has(to)) throw badRequest(`"${rawTo}" is a built-in field; use "Move into Name/Email" instead`);
    if (to === from) return { renamed: 0 };
    const pf = jsonPath(from);
    const pt = jsonPath(to);
    return this.core.db.tx(() => {
      const now = this.now();
      const moved = this.core.db.run(
        `UPDATE contacts SET attributes = json_set(json_remove(attributes, ?), ?, json_extract(attributes, ?)), updated_at = ?
          WHERE json_type(attributes, ?) IS NOT NULL AND json_type(attributes, ?) IS NULL`,
        pf, pt, pf, now, pf, pt,
      ).changes;
      const merged = this.core.db.run('UPDATE contacts SET attributes = json_remove(attributes, ?), updated_at = ? WHERE json_type(attributes, ?) IS NOT NULL', pf, now, pf).changes;

      // Saved messages and audiences that use the old name.
      const bodies: Array<[table: string, column: string]> = [
        ['templates', 'body'],
        ['auto_replies', 'reply_body'],
        ['sequences', 'steps'],
        ['campaigns', 'variants'],
      ];
      for (const [table, column] of bodies) {
        for (const row of this.core.db.all<{ id: number; text: string }>(`SELECT id, ${column} AS text FROM ${table} WHERE ${column} LIKE '%{{%'`)) {
          const next = renameVariable(row.text, from, to);
          if (next !== row.text) this.core.db.run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, next, row.id);
        }
      }
      this.core.db.run('UPDATE segments SET rules = replace(rules, ?, ?) WHERE instr(rules, ?) > 0', `"key":"${from}"`, `"key":"${to}"`, `"key":"${from}"`);

      // New leads and imports: the old name now arrives as the new one.
      this.core.db.run("UPDATE field_rules SET rename_to = ? WHERE target = 'rename' AND rename_to = ?", to, from);
      this.core.db.run('DELETE FROM field_rules WHERE key = ?', to);
      this.setFieldRule(from, 'rename', to);
      return { renamed: moved + merged };
    });
  }

  /** Move a custom field into the name or email of contacts that have none, and do so for new leads. */
  moveField(input: unknown): { moved: number; left: number } {
    const { from, to } = z.object({ from: fieldKey, to: z.enum(['name', 'email']) }).parse(input);
    const pf = jsonPath(from);
    return this.core.db.tx(() => {
      const now = this.now();
      const moved =
        to === 'name'
          ? this.core.db.run(
              `UPDATE contacts SET name = substr(trim(json_extract(attributes, ?)), 1, 120), attributes = json_remove(attributes, ?), updated_at = ?
                WHERE (name IS NULL OR trim(name) = '') AND trim(coalesce(json_extract(attributes, ?), '')) != ''`,
              pf, pf, now, pf,
            ).changes
          : this.core.db.run(
              `UPDATE contacts SET email = substr(trim(json_extract(attributes, ?)), 1, 200), attributes = json_remove(attributes, ?), updated_at = ?
                WHERE (email IS NULL OR trim(email) = '') AND trim(json_extract(attributes, ?)) LIKE '%_@_%._%' AND instr(trim(json_extract(attributes, ?)), ' ') = 0`,
              pf, pf, now, pf, pf,
            ).changes;
      this.setFieldRule(from, to);
      const left = this.core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contacts WHERE json_type(attributes, ?) IS NOT NULL', pf)?.n ?? 0;
      return { moved, left };
    });
  }

  /** Remove a custom field from every contact; by default new leads stop saving it too. */
  deleteField(input: unknown): { removed: number } {
    const { key, future } = z.object({ key: fieldKey, future: z.boolean().default(true) }).parse(input);
    const path = jsonPath(key);
    return this.core.db.tx(() => {
      const removed = this.core.db.run('UPDATE contacts SET attributes = json_remove(attributes, ?), updated_at = ? WHERE json_type(attributes, ?) IS NOT NULL', path, this.now(), path).changes;
      if (future) this.setFieldRule(key, 'ignore');
      return { removed };
    });
  }

  attributeKeys(): string[] {
    return this.core.db
      .all<{ key: string }>('SELECT DISTINCT j.key AS key FROM contacts c, json_each(c.attributes) j ORDER BY j.key LIMIT 200')
      .map(r => r.key);
  }

  stats(): { total: number; optedIn: number; optedOut: number; unknown: number; valid: number; invalid: number; newLast7Days: number } {
    const since = nowIso(new Date(this.core.clock().getTime() - 7 * 86_400_000));
    const row = this.core.db.get<Record<string, number>>(
      `SELECT COUNT(*) AS total,
              SUM(consent = 'opted_in') AS optedIn,
              SUM(consent = 'opted_out') AS optedOut,
              SUM(consent = 'unknown') AS unknown,
              SUM(wa_status = 'valid') AS valid,
              SUM(wa_status = 'invalid') AS invalid,
              SUM(created_at >= ?) AS newLast7Days
         FROM contacts WHERE saved = 1`,
      since,
    );
    return {
      total: row?.total ?? 0,
      optedIn: row?.optedIn ?? 0,
      optedOut: row?.optedOut ?? 0,
      unknown: row?.unknown ?? 0,
      valid: row?.valid ?? 0,
      invalid: row?.invalid ?? 0,
      newLast7Days: row?.newLast7Days ?? 0,
    };
  }
}

