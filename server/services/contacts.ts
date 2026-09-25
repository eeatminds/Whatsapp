import { z } from 'zod';
import type { Core } from '../context.js';
import { nowIso, parseJson } from '../db/database.js';
import { badRequest, notFound } from '../lib/errors.js';
import { normalizePhone, spreadsheetPhone } from '../lib/phone.js';
import { parseCsv, toCsv } from '../lib/csv.js';
import type { SettingsService } from './settings.js';
import type { TagsService, Tag } from './tags.js';
import { andFragments, escapeLike, type SegmentsService, type SqlFragment } from './segments.js';
import type { Bus } from './bus.js';

export type Consent = 'opted_in' | 'unknown' | 'opted_out';
export type WaStatus = 'unknown' | 'valid' | 'invalid';

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
  created_at: string;
  updated_at: string;
}

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
  createdAt: string;
  updatedAt: string;
  tags: Tag[];
}

export function toContact(row: ContactRow, tags: Tag[] = []): Contact {
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
  ids: z.array(z.coerce.number().int().positive()).max(100_000).optional(),
});

export type ContactFilter = z.infer<typeof contactFilterSchema>;

export const bulkActionSchema = z.object({
  filter: contactFilterSchema,
  action: z.enum(['add_tags', 'remove_tags', 'set_consent', 'delete', 'validate']),
  tagIds: z.array(z.coerce.number().int().positive()).max(50).optional(),
  consent: consentSchema.optional(),
});

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
  updateExisting: z.boolean().default(true),
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
const SYSTEM_COLUMNS = new Set(['consent', 'consent_source', 'whatsapp', 'wa_status', 'source', 'created_at', 'updated_at', 'id']);

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

  // ---------------------------------------------------------------- queries

  filterSql(filter: ContactFilter): SqlFragment {
    const parts: SqlFragment[] = [];
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
    if (filter.waStatus) parts.push({ sql: 'c.wa_status = ?', params: [filter.waStatus] });
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
    return rows.map(row => toContact(row, byContact.get(row.id) ?? []));
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
      if (existing) {
        const attrs = { ...parseJson<Record<string, string>>(existing.attributes, {}), ...cleanAttributes(data.attributes) };
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
          JSON.stringify(cleanAttributes(data.attributes)),
          data.source ?? 'manual',
          now,
          now,
        ).lastInsertRowid;
        created = true;
      }
      if (data.consent) this.setConsent(contactId, data.consent, data.consentSource ?? data.source ?? 'manual');
      this.addTags([contactId], tagIds);
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
            "UPDATE contacts SET phone = ?, wa_status = 'unknown', wa_chat_id = NULL, wa_checked_at = NULL WHERE id = ?",
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
      return this.get(contactId);
    });
  }

  delete(contactId: number): void {
    const { changes } = this.core.db.run('DELETE FROM contacts WHERE id = ?', contactId);
    if (!changes) throw notFound('Contact');
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
          affected: this.core.db.run('DELETE FROM contacts WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids)).changes,
        };
      case 'validate':
        return { affected: this.requestValidation(ids) };
    }
  }

  // ---------------------------------------------------------------- inbound + validation helpers

  /** Contact for an inbound WhatsApp sender, creating it on first contact. */
  touchInbound(phone: string, chatId: string | null, pushName: string | null, at: string): { row: ContactRow; created: boolean } {
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
      `INSERT INTO contacts (phone, name, wa_status, wa_chat_id, source, last_inbound_at, created_at, updated_at)
       VALUES (?, ?, 'valid', ?, 'inbound', ?, ?, ?)`,
      phone,
      pushName,
      chatId,
      at,
      at,
      at,
    ).lastInsertRowid;
    return { row: this.row(id), created: true };
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
          else record.attrs[field.slice(5)] = value;
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
        if (existing) {
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
          result.created++;
        }
        if (data.consent === 'opted_in') this.setConsent(contactId, 'opted_in', consentSource);
        this.addTags([contactId], [...new Set(tagIds)]);
      }
    });
    return result;
  }

  exportCsv(filter: ContactFilter): string {
    const where = this.filterSql(filter);
    const rows = this.core.db.all<ContactRow>(`SELECT c.* FROM contacts c WHERE ${where.sql} ORDER BY c.id`, ...where.params);
    const contacts = this.withTags(rows);
    const attrKeys = [...new Set(contacts.flatMap(c => Object.keys(c.attributes)))].sort();
    const header = ['phone', 'name', 'email', 'consent', 'consent_source', 'whatsapp', 'tags', 'source', 'created_at', ...attrKeys];
    const body = contacts.map(c => [
      spreadsheetPhone(c.phone),
      c.name,
      c.email,
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
         FROM contacts`,
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

