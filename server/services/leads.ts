import { z } from 'zod';
import type { Core } from '../context.js';
import { nowIso, parseJson } from '../db/database.js';
import { badRequest, notFound } from '../lib/errors.js';
import { randomToken, safeEqual } from '../lib/crypto.js';
import { chatIdFor, formatPhone, normalizePhone } from '../lib/phone.js';
import type { SettingsService } from './settings.js';
import type { ContactsService } from './contacts.js';
import type { TagsService } from './tags.js';
import type { SequencesService } from './sequences.js';
import type { OutboxService } from './outbox.js';

/**
 * Lead sources: a private link per source (a Google Sheet, a website form, Wix, Zapier...) that
 * turns each submitted lead into a contact and runs the business's chosen actions: add tags, start
 * a follow-up series, and ping the owner on WhatsApp. The link's secret token is the only
 * credential, so each source can be reset on its own if a link leaks.
 */

const id = z.coerce.number().int().positive();

export const LEAD_KINDS = ['google_sheet', 'website', 'wix', 'other'] as const;

const actionsSchema = z.object({
  tagIds: z.array(id).max(20).default([]),
  sequenceId: id.nullish(),
  /** The form asked for permission to message them, so record them as opted in. */
  markOptedIn: z.boolean().default(false),
  /** Owner's WhatsApp number to notify about each new lead. */
  notifyPhone: z.string().trim().max(40).nullish(),
});

export const leadSourceInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(LEAD_KINDS).default('other'),
  active: z.boolean().default(true),
  actions: actionsSchema.default({ tagIds: [], markOptedIn: false }),
  /** Where a plain HTML form is sent after submitting. */
  thankYouUrl: z
    .string()
    .trim()
    .max(500)
    .refine(v => v === '' || /^https?:\/\/\S+$/i.test(v), 'Use a full web address starting with https://')
    .nullish(),
});

export type LeadActions = z.infer<typeof actionsSchema>;

interface SourceRow {
  id: number;
  name: string;
  kind: (typeof LEAD_KINDS)[number];
  token: string;
  active: number;
  actions: string;
  thank_you_url: string | null;
  received: number;
  failed: number;
  last_received_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeadSource {
  id: number;
  name: string;
  kind: SourceRow['kind'];
  active: boolean;
  actions: LeadActions;
  thankYouUrl: string | null;
  url: string | null;
  received: number;
  failed: number;
  lastReceivedAt: string | null;
  createdAt: string;
}

const MAX_ATTRIBUTES = 20;
const RESERVED = /^(token|secret|password|api[_-]?key|g-recaptcha-response|_.*)$/i;
const PHONE_KEY = /(phone|mobile|whats ?app|contact ?(no|number)|^number$|^tel$|cell)/i;
const EMAIL_KEY = /e-?mail/i;
const NAME_KEY = /^(full ?name|your ?name|name|customer ?name|contact ?name)$/i;
const FIRST_KEY = /^(first ?name|fname|given ?name)$/i;
const LAST_KEY = /^(last ?name|lname|surname|family ?name)$/i;

/** Human-friendly key: "your-city" / "Your City" / "data.city" → "your_city" / "city". */
function cleanKey(key: string): string {
  const last = key.split('.').pop() ?? key;
  return last
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * Flatten whatever a form tool sends into label → text pairs. Handles flat JSON, nested objects
 * (Wix wraps fields in `data`), and arrays of { label|key|name, value } (form-builder submissions).
 */
export function flattenLead(input: unknown, prefix = '', depth = 0, out: Array<[string, string]> = []): Array<[string, string]> {
  if (out.length > 200 || depth > 4 || input === null || input === undefined) return out;
  if (Array.isArray(input)) {
    for (const item of input.slice(0, 50)) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        const label = record.label ?? record.key ?? record.name ?? record.field ?? record.title;
        if (typeof label === 'string' && ['string', 'number', 'boolean'].includes(typeof record.value)) {
          out.push([label, String(record.value)]);
          continue;
        }
      }
      flattenLead(item, prefix, depth + 1, out);
    }
    return out;
  }
  if (typeof input === 'object') {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === 'object') flattenLead(value, path, depth + 1, out);
      else if (value !== undefined && value !== null) out.push([path, String(value)]);
    }
    return out;
  }
  out.push([prefix || 'value', String(input)]);
  return out;
}

export interface ParsedLead {
  phone: string | null;
  name: string | null;
  email: string | null;
  attributes: Record<string, string>;
  fields: string[];
}

export function parseLead(input: unknown, defaultCountry: string): ParsedLead {
  const pairs = flattenLead(input)
    .map(([key, value]) => [key, value.trim()] as [string, string])
    .filter(([key, value]) => value !== '' && !RESERVED.test(cleanKey(key)));
  let phone: string | null = null;
  let phoneKey: string | null = null;
  for (const [key, value] of pairs) {
    if (!PHONE_KEY.test(cleanKey(key).replace(/_/g, ' '))) continue;
    const normalized = normalizePhone(value, defaultCountry);
    if (normalized.ok) {
      phone = normalized.phone;
      phoneKey = key;
      break;
    }
  }
  const find = (pattern: RegExp) => pairs.find(([key]) => pattern.test(cleanKey(key).replace(/_/g, ' ')));
  const full = find(NAME_KEY)?.[1];
  const first = find(FIRST_KEY)?.[1];
  const last = find(LAST_KEY)?.[1];
  const name = (full || [first, last].filter(Boolean).join(' ')).slice(0, 120) || null;
  const emailPair = pairs.find(([key, value]) => EMAIL_KEY.test(key) && /^\S+@\S+\.\S+$/.test(value));
  const used = new Set([phoneKey, find(NAME_KEY)?.[0], find(FIRST_KEY)?.[0], find(LAST_KEY)?.[0], emailPair?.[0]]);
  const attributes: Record<string, string> = {};
  for (const [key, value] of pairs) {
    if (used.has(key)) continue;
    const clean = cleanKey(key);
    if (!clean || clean in attributes || Object.keys(attributes).length >= MAX_ATTRIBUTES) continue;
    attributes[clean] = value.slice(0, 300);
  }
  return { phone, name, email: emailPair?.[1].slice(0, 200) ?? null, attributes, fields: pairs.map(([key]) => cleanKey(key)).filter(Boolean) };
}

export class LeadsService {
  constructor(
    private readonly core: Core,
    private readonly settings: SettingsService,
    private readonly contacts: ContactsService,
    private readonly tags: TagsService,
    private readonly sequences: SequencesService,
    private readonly outbox: OutboxService,
  ) {}

  private now(): string {
    return nowIso(this.core.clock());
  }

  /** Public link for a source: <PUBLIC_URL>/hooks/leads/<business>/<token>. */
  private url(token: string): string | null {
    return this.core.config.leadHookUrl ? `${this.core.config.leadHookUrl}/${token}` : null;
  }

  private toSource(row: SourceRow): LeadSource {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      active: !!row.active,
      actions: actionsSchema.parse(parseJson(row.actions, {})),
      thankYouUrl: row.thank_you_url,
      url: this.url(row.token),
      received: row.received,
      failed: row.failed,
      lastReceivedAt: row.last_received_at,
      createdAt: row.created_at,
    };
  }

  private row(sourceId: number): SourceRow {
    const row = this.core.db.get<SourceRow>('SELECT * FROM lead_sources WHERE id = ?', sourceId);
    if (!row) throw notFound('Lead source');
    return row;
  }

  list(): LeadSource[] {
    return this.core.db.all<SourceRow>('SELECT * FROM lead_sources ORDER BY created_at DESC, id DESC').map(r => this.toSource(r));
  }

  get(sourceId: number): LeadSource {
    return this.toSource(this.row(sourceId));
  }

  private validate(input: unknown) {
    const data = leadSourceInputSchema.parse(input);
    for (const tagId of data.actions.tagIds) if (!this.tags.exists(tagId)) throw badRequest(`Tag ${tagId} does not exist`);
    if (data.actions.sequenceId) this.sequences.get(data.actions.sequenceId);
    if (data.actions.notifyPhone) {
      const phone = normalizePhone(data.actions.notifyPhone, this.settings.get().defaultCountry);
      if (!phone.ok) throw badRequest(`The WhatsApp number to notify is not valid: ${phone.reason}`);
      data.actions.notifyPhone = phone.phone;
    }
    return data;
  }

  create(input: unknown): LeadSource {
    const data = this.validate(input);
    const now = this.now();
    const { lastInsertRowid } = this.core.db.run(
      `INSERT INTO lead_sources (name, kind, token, active, actions, thank_you_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      data.name,
      data.kind,
      randomToken(32),
      data.active,
      JSON.stringify(data.actions),
      data.thankYouUrl || null,
      now,
      now,
    );
    return this.get(lastInsertRowid);
  }

  update(sourceId: number, input: unknown): LeadSource {
    this.row(sourceId);
    const data = this.validate(input);
    this.core.db.run(
      'UPDATE lead_sources SET name = ?, kind = ?, active = ?, actions = ?, thank_you_url = ?, updated_at = ? WHERE id = ?',
      data.name,
      data.kind,
      data.active,
      JSON.stringify(data.actions),
      data.thankYouUrl || null,
      this.now(),
      sourceId,
    );
    return this.get(sourceId);
  }

  delete(sourceId: number): void {
    this.row(sourceId);
    this.core.db.run('DELETE FROM lead_sources WHERE id = ?', sourceId);
  }

  /** Issue a new secret link; the old one stops working at once. */
  resetLink(sourceId: number): LeadSource {
    this.row(sourceId);
    this.core.db.run('UPDATE lead_sources SET token = ?, updated_at = ? WHERE id = ?', randomToken(32), this.now(), sourceId);
    return this.get(sourceId);
  }

  events(sourceId: number, limit = 50) {
    this.row(sourceId);
    return this.core.db
      .all<{ id: number; status: string; detail: string | null; created_at: string; contact_id: number | null; name: string | null; phone: string | null }>(
        `SELECT e.id, e.status, e.detail, e.created_at, e.contact_id, c.name, c.phone
           FROM lead_events e LEFT JOIN contacts c ON c.id = e.contact_id
          WHERE e.source_id = ? ORDER BY e.id DESC LIMIT ?`,
        sourceId,
        Math.min(limit, 200),
      )
      .map(e => ({ id: e.id, status: e.status, detail: e.detail, createdAt: e.created_at, contactId: e.contact_id, name: e.name, phone: e.phone }));
  }

  private logEvent(sourceId: number, status: 'added' | 'updated' | 'failed', contactId: number | null, detail: string | null): void {
    const at = this.now();
    this.core.db.run('INSERT INTO lead_events (source_id, contact_id, status, detail, created_at) VALUES (?, ?, ?, ?, ?)', sourceId, contactId, status, detail, at);
    this.core.db.run(
      `UPDATE lead_sources SET ${status === 'failed' ? 'failed = failed + 1' : 'received = received + 1'}, last_received_at = ? WHERE id = ?`,
      at,
      sourceId,
    );
    // Keep the log short: the last 200 events per source.
    this.core.db.run(
      'DELETE FROM lead_events WHERE source_id = ? AND id NOT IN (SELECT id FROM lead_events WHERE source_id = ? ORDER BY id DESC LIMIT 200)',
      sourceId,
      sourceId,
    );
  }

  /** The source for a link token (constant-time compare), or null. */
  byToken(token: string): LeadSource | null {
    if (!/^[A-Za-z0-9]{32}$/.test(token)) return null;
    const row = this.core.db.get<SourceRow>('SELECT * FROM lead_sources WHERE token = ?', token);
    return row && safeEqual(row.token, token) ? this.toSource(row) : null;
  }

  /** Turn one submitted lead into a contact and run the source's actions. */
  receive(source: LeadSource, payload: unknown): { ok: true; contactId: number; created: boolean } | { ok: false; error: string } {
    const settings = this.settings.get();
    const lead = parseLead(payload, settings.defaultCountry);
    if (!lead.phone) {
      const error = lead.fields.length
        ? `No valid phone number found. Fields received: ${lead.fields.slice(0, 12).join(', ')}. Name the phone column "Phone".`
        : 'The lead was empty.';
      this.logEvent(source.id, 'failed', null, error.slice(0, 300));
      return { ok: false, error };
    }
    const { actions } = source;
    let result;
    try {
      result = this.core.db.tx(() => {
        const upserted = this.contacts.upsert({
          phone: lead.phone!,
          name: lead.name,
          email: lead.email,
          attributes: lead.attributes,
          tagIds: actions.tagIds,
          source: 'lead-form',
          ...(actions.markOptedIn ? { consent: 'opted_in' as const, consentSource: `form: ${source.name}`.slice(0, 120) } : {}),
        });
        const contactId = upserted.contact.id;
        if (actions.sequenceId) {
          try {
            this.sequences.enroll(actions.sequenceId, [contactId], false);
          } catch (error) {
            this.core.log.warn(`Lead source ${source.id}: could not start sequence: ${String(error)}`);
          }
        }
        return { contactId, created: upserted.created };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent(source.id, 'failed', null, message.slice(0, 300));
      return { ok: false, error: message };
    }
    this.logEvent(source.id, result.created ? 'added' : 'updated', result.contactId, null);
    this.notifyOwner(source, lead, result.created);
    return { ok: true, ...result };
  }

  private notifyOwner(source: LeadSource, lead: ParsedLead, created: boolean): void {
    const to = source.actions.notifyPhone;
    const sessionId = this.settings.get().defaultSessionId;
    if (!to || !sessionId) return;
    const extra = Object.entries(lead.attributes)
      .slice(0, 6)
      .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value.slice(0, 80)}`);
    const body = [
      `${created ? 'New lead' : 'Lead again'} from *${source.name}*`,
      `${lead.name ?? 'No name'}, ${formatPhone(lead.phone!)}`,
      ...(lead.email ? [lead.email] : []),
      ...extra,
    ].join('\n');
    try {
      this.outbox.enqueue({ sessionId, contactId: null, chatId: chatIdFor(to), body, sourceType: 'system', delayMs: 1000 });
    } catch (error) {
      this.core.log.warn(`Lead notification failed: ${String(error)}`);
    }
  }
}
