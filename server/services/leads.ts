import { z } from 'zod';
import type { Core } from '../context.js';
import { nowIso, parseJson } from '../db/database.js';
import { badRequest, notFound } from '../lib/errors.js';
import { randomToken, safeEqual } from '../lib/crypto.js';
import { chatIdFor, formatPhone, normalizePhone, type PhoneResult } from '../lib/phone.js';
import type { SettingsService } from './settings.js';
import type { ContactsService, FieldRule } from './contacts.js';
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

const tabName = z.string().trim().min(1).max(100);
/**
 * Which tabs of a Google Sheet to read: all (new tabs too), all except some (new tabs too), or only
 * the chosen ones; and whether rows already in a tab when it is first read are left alone ("skip")
 * or added as contacts without any message ("import"). The sheet's script asks for these each
 * minute, so changes need no new script.
 */
export const sheetSettingsSchema = z.object({
  mode: z.enum(['all', 'except', 'only']).default('all'),
  selected: z.array(tabName).max(50).default([]),
  excluded: z.array(tabName).max(50).default([]),
  existing: z.enum(['skip', 'import']).default('skip'),
});
export type SheetSettings = z.infer<typeof sheetSettingsSchema>;

/** The tabs of a sheet that are read, given the tabs it has now. */
export function tabsToRead(settings: SheetSettings, tabs: string[]): string[] {
  if (settings.mode === 'only') return tabs.filter(t => settings.selected.includes(t));
  if (settings.mode === 'except') return tabs.filter(t => !settings.excluded.includes(t));
  return tabs;
}

interface SourceRow {
  id: number;
  name: string;
  kind: (typeof LEAD_KINDS)[number];
  token: string;
  active: number;
  actions: string;
  thank_you_url: string | null;
  field_map: string;
  fields_seen: string;
  sheet_tabs: string;
  sheet_config: string;
  sheet_synced_at: string | null;
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
  /** What the business said each column is (columns not listed are detected automatically). */
  fieldMap: FieldMap;
  /** Columns this source has sent, and what each became last time. */
  fieldsSeen: SeenField[];
  /** Google Sheets only: the tabs the sheet reported, which ones are read, and leads from each. */
  sheet: SheetSettings & { tabs: string[]; syncedAt: string | null; leadsByTab: Record<string, number> };
  url: string | null;
  received: number;
  failed: number;
  lastReceivedAt: string | null;
  createdAt: string;
}

const MAX_ATTRIBUTES = 50;
const RESERVED = /^(token|secret|password|api_key|g_recaptcha_response|wa_status)$|^_/;
/** Joins nested keys from JSON payloads; a header like "Mob. No." keeps its dots. */
const PATH_SEP = '\u001f';

/** What a column becomes. "custom" keeps it as a custom field; "ignore" drops it. */
export const FIELD_TARGETS = ['phone', 'country_code', 'name', 'first_name', 'last_name', 'email', 'custom', 'ignore'] as const;
export type FieldTarget = (typeof FIELD_TARGETS)[number];
export type FieldMap = Record<string, FieldTarget>;
/** A column a source has sent: what it became last time, and an example value (not kept for "don't save"). */
export interface SeenField {
  key: string;
  as: FieldTarget;
  sample?: string;
}
const fieldMapSchema = z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.enum(FIELD_TARGETS)).refine(m => Object.keys(m).length <= 100, 'Too many columns');
export const fieldsInputSchema = z.object({ fieldMap: fieldMapSchema });

// Matched against the cleaned column name with spaces, e.g. "student name", "mob no".
const PHONE_KEY = /(phone|mobile|\bmob\b|whats ?app|contact ?(no|num|number)|^contact$|^number$|\btel\b|telephone|\bcell\b|\bph\b)/;
const COUNTRY_CODE_KEY = /(country ?(code|dial|calling)|dial(l?ing)? ?code|calling ?code|\bisd\b|^cc$|phone ?code|^code$|^country$)/;
const COUNTRY_CODE_VALUE = /^\s*(\+?\d{1,4}|[a-z]{2}|.*\(\s*\+?\d{1,4}\s*\).*|.*\+\d{1,4}.*)\s*$/i;
const EMAIL_KEY = /(e ?mail|mail ?id|^mail$)/;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_KEY = /^((your |full |your full )?name|(customer|contact|lead|client|student|candidate|applicant|patient|person|buyer|guest|visitor) ?name|enter your name|what is your name)$/;
const FIRST_KEY = /^(first ?name|fname|given ?name|forename)$/;
const LAST_KEY = /^(last ?name|lname|surname|family ?name)$/;
/** "<something> name" columns that are not the person: ad/campaign/form names, course, company... */
const NOT_A_PERSON =
  /\b(ad|ads|adset|set|campaign|form|page|company|business|firm|brand|course|program|programme|product|plan|school|college|university|institute|organi[sz]ation|org|file|user|platform|city|state|country|father|mother|parent|guardian|spouse|husband|wife|reference|referrer|referral|agent|executive|counsell?or|sales|owner|project|event|item|service|branch|centre|center|domain|site|website|account|group|team|batch|class|subject|hospital|doctor|clinic|shop|store|restaurant|middle|nick|display)\b/;

/** Human-friendly key: "Your City" / "data.city" (nested JSON) / "Mob. No." → "your_city" / "city" / "mob_no". */
export function cleanKey(key: string): string {
  const last = key.split(PATH_SEP).pop() ?? key;
  return last
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** Dates as Google Sheets/JavaScript print them ("Tue Oct 27 2026 00:00:00 GMT+0530 (...)") become "27 Oct 2026". */
const JS_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}) (\d{4}) (\d{2}):(\d{2}):\d{2} GMT[+-]\d{4}(?: \([^)]*\))?$/;
export function tidyValue(value: string): string {
  const m = JS_DATE.exec(value);
  if (!m) return value;
  const date = `${Number(m[2])} ${m[1]} ${m[3]}`;
  return m[4] === '00' && m[5] === '00' ? date : `${date} ${m[4]}:${m[5]}`;
}

/** A phone number, using a separate country-code column ("+91", "91", "IN", "India (+91)") when there is one. */
export function phoneWithCountry(value: string, countryCode: string | null, defaultCountry: string): PhoneResult {
  const raw = value.trim();
  const international = raw.startsWith('+') || raw.replace(/[^\d+]/g, '').startsWith('00');
  if (countryCode && !international) {
    const cc = countryCode.trim();
    if (/^[a-z]{2}$/i.test(cc)) {
      const local = normalizePhone(raw, cc.toUpperCase());
      if (local.ok) return local;
    }
    const dial = /\+\s*(\d{1,4})/.exec(cc)?.[1] ?? /^(\d{1,4})$/.exec(cc)?.[1] ?? /\((\d{1,4})\)/.exec(cc)?.[1];
    if (dial) {
      const digits = raw.replace(/\D/g, '').replace(/^0+/, '');
      const tries = digits.startsWith(dial) ? [`+${digits}`, `+${dial}${digits}`] : [`+${dial}${digits}`, `+${digits}`];
      for (const attempt of tries) {
        const result = normalizePhone(attempt, defaultCountry);
        if (result.ok) return result;
      }
    }
  }
  return normalizePhone(raw, defaultCountry);
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
      const path = prefix ? `${prefix}${PATH_SEP}${key}` : key;
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
  /** Every column received (cleaned names), in order. */
  fields: string[];
  /** What each column became, for the source's Columns screen. */
  roles: Record<string, FieldTarget>;
  /** Each column's value as received (tidied), for examples on the Columns screen. */
  values: Record<string, string>;
  /** Columns that made up the name / held the email (used to tidy custom fields). */
  nameKeys: string[];
  emailKey: string | null;
}

/**
 * Work out phone, name and email from whatever columns a form or sheet sends. A business can say
 * what a column is (`fieldMap`); other columns are recognised by their names (and emails by their
 * values). Everything else is kept as custom fields.
 */
export function parseLead(input: unknown, defaultCountry: string, fieldMap: FieldMap = {}): ParsedLead {
  const seen = new Set<string>();
  const pairs: Array<{ key: string; value: string }> = [];
  for (const [rawKey, rawValue] of flattenLead(input)) {
    const key = cleanKey(rawKey);
    const value = tidyValue(rawValue.trim());
    if (!key || !value || RESERVED.test(key) || seen.has(key)) continue;
    seen.add(key);
    pairs.push({ key, value });
  }
  const roles: Record<string, FieldTarget> = {};
  const words = (key: string) => key.replace(/_/g, ' ');
  const free = (key: string) => !fieldMap[key] && !roles[key];
  const take = (key: string, role: FieldTarget) => (roles[key] = role);
  const mapped = (target: FieldTarget) => pairs.filter(p => fieldMap[p.key] === target);

  // Country code first, so the phone can use it.
  const ccPair = mapped('country_code')[0] ?? pairs.find(p => free(p.key) && COUNTRY_CODE_KEY.test(words(p.key)) && COUNTRY_CODE_VALUE.test(p.value));
  if (ccPair) take(ccPair.key, 'country_code');

  let phone: string | null = null;
  const phoneCandidates = mapped('phone').length ? mapped('phone') : pairs.filter(p => free(p.key) && PHONE_KEY.test(words(p.key)));
  for (const p of phoneCandidates) {
    const result = phoneWithCountry(p.value, ccPair?.value ?? null, defaultCountry);
    if (result.ok) {
      phone = result.phone;
      take(p.key, 'phone');
      break;
    }
  }

  const emailPair =
    mapped('email').find(p => EMAIL_VALUE.test(p.value)) ??
    pairs.find(p => free(p.key) && EMAIL_KEY.test(words(p.key)) && EMAIL_VALUE.test(p.value)) ??
    pairs.find(p => free(p.key) && EMAIL_VALUE.test(p.value));
  if (emailPair) take(emailPair.key, 'email');

  const fullPair =
    mapped('name')[0] ?? pairs.find(p => free(p.key) && NAME_KEY.test(words(p.key)));
  const firstPair = mapped('first_name')[0] ?? pairs.find(p => free(p.key) && FIRST_KEY.test(words(p.key)));
  const lastPair = mapped('last_name')[0] ?? pairs.find(p => free(p.key) && LAST_KEY.test(words(p.key)));
  // Last resort: a "<something> name" column that is about the person, e.g. "Name of the student".
  const loosePair =
    !fullPair && !firstPair && !lastPair
      ? pairs.find(p => free(p.key) && /\bname\b/.test(words(p.key)) && !NOT_A_PERSON.test(words(p.key)))
      : undefined;
  const nameParts = fullPair || loosePair ? [fullPair ?? loosePair!] : [firstPair, lastPair].filter((p): p is { key: string; value: string } => !!p);
  if (fullPair || loosePair) take((fullPair ?? loosePair)!.key, 'name');
  if (!fullPair && !loosePair) {
    if (firstPair) take(firstPair.key, 'first_name');
    if (lastPair) take(lastPair.key, 'last_name');
  }
  const name = nameParts.map(p => p.value).join(' ').replace(/\s+/g, ' ').slice(0, 120) || null;

  const attributes: Record<string, string> = {};
  for (const p of pairs) {
    if (roles[p.key]) continue;
    if (fieldMap[p.key] === 'ignore') {
      take(p.key, 'ignore');
      continue;
    }
    take(p.key, 'custom');
    if (Object.keys(attributes).length < MAX_ATTRIBUTES) attributes[p.key] = p.value.slice(0, 300);
  }
  return {
    phone,
    name,
    email: emailPair?.value.slice(0, 200) ?? null,
    attributes,
    fields: pairs.map(p => p.key),
    roles,
    values: Object.fromEntries(pairs.map(p => [p.key, p.value])),
    nameKeys: nameParts.map(p => p.key),
    emailKey: emailPair?.key ?? null,
  };
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
      fieldMap: fieldMapSchema.catch({}).parse(parseJson(row.field_map, {})),
      fieldsSeen: parseJson<SeenField[]>(row.fields_seen, []),
      sheet: {
        ...sheetSettingsSchema.catch({ mode: 'all', selected: [], excluded: [], existing: 'skip' }).parse(parseJson(row.sheet_config, {})),
        tabs: parseJson<string[]>(row.sheet_tabs, []),
        syncedAt: row.sheet_synced_at,
        leadsByTab: row.kind === 'google_sheet' ? this.leadsByTab(row.id) : {},
      },
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

  /** Tags newly added to a source are also given to the leads it already brought in. */
  update(sourceId: number, input: unknown): LeadSource {
    const before = this.toSource(this.row(sourceId));
    const data = this.validate(input);
    const newTags = data.actions.tagIds.filter(id => !before.actions.tagIds.includes(id));
    if (newTags.length) {
      const ids = this.core.db.all<{ id: number }>('SELECT id FROM contacts WHERE lead_source_id = ?', sourceId).map(r => r.id);
      this.contacts.addTags(ids, newTags);
    }
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

  /** The source's own column choices, on top of the business-wide field rules. */
  private effectiveMap(source: LeadSource, rules: Record<string, FieldRule>): FieldMap {
    const map: FieldMap = {};
    for (const [key, rule] of Object.entries(rules)) if (rule.target !== 'rename') map[key] = rule.target;
    return { ...map, ...source.fieldMap };
  }

  private rememberFields(source: LeadSource, lead: ParsedLead): void {
    const seen = new Map(source.fieldsSeen.map(f => [f.key, f]));
    for (const key of lead.fields) {
      const as = lead.roles[key] ?? 'custom';
      seen.set(key, as === 'ignore' ? { key, as } : { key, as, sample: lead.values[key]?.slice(0, 80) });
    }
    const next = [...seen.values()].slice(-60);
    const json = JSON.stringify(next);
    if (json !== JSON.stringify(source.fieldsSeen)) this.core.db.run('UPDATE lead_sources SET fields_seen = ? WHERE id = ?', json, source.id);
  }

  /**
   * The sheet's script checks in: it reports its tabs and gets back which to read and what to do with
   * rows that were already there. Returns the tab names to read.
   */
  sheetSync(source: LeadSource, tabs: unknown): { tabs: string[]; existing: SheetSettings['existing'] } {
    const names = z.array(z.string()).max(200).catch([]).parse(tabs).map(t => t.trim().slice(0, 100)).filter(Boolean).slice(0, 50);
    this.core.db.run('UPDATE lead_sources SET sheet_tabs = ?, sheet_synced_at = ? WHERE id = ?', JSON.stringify(names), this.now(), source.id);
    return { tabs: tabsToRead(source.sheet, names), existing: source.sheet.existing };
  }

  /** Leads that came from each tab of a sheet (by their "Sheet tab" field). */
  private leadsByTab(sourceId: number): Record<string, number> {
    const rows = this.core.db.all<{ tab: string | null; n: number }>(
      `SELECT CAST(json_extract(attributes, '$.sheet_tab') AS TEXT) AS tab, COUNT(*) AS n FROM contacts
        WHERE lead_source_id = ? GROUP BY tab`,
      sourceId,
    );
    return Object.fromEntries(rows.filter(r => r.tab).map(r => [r.tab!, r.n]));
  }

  setSheet(sourceId: number, input: unknown): LeadSource {
    this.row(sourceId);
    const settings = sheetSettingsSchema.parse(input);
    if (settings.mode === 'only' && settings.selected.length === 0) throw badRequest('Tick at least one tab, or read new tabs automatically');
    this.core.db.run('UPDATE lead_sources SET sheet_config = ?, updated_at = ? WHERE id = ?', JSON.stringify(settings), this.now(), sourceId);
    return this.get(sourceId);
  }

  /** Save what each column is, then fix leads already received with the new choices. */
  setFields(sourceId: number, input: unknown): { source: LeadSource; fixed: number } {
    this.row(sourceId);
    const { fieldMap } = fieldsInputSchema.parse(input);
    if (Object.values(fieldMap).filter(t => t === 'phone').length > 1) throw badRequest('Choose one phone column');
    this.core.db.run('UPDATE lead_sources SET field_map = ?, updated_at = ? WHERE id = ?', JSON.stringify(fieldMap), this.now(), sourceId);
    return { source: this.get(sourceId), fixed: this.repair(sourceId) };
  }

  /**
   * Leads that arrived without a name or email but carry one in a custom field (a column that was
   * not recognised then) get it moved into the right place. Only blanks are filled.
   */
  repair(sourceId?: number): number {
    const country = this.settings.get().defaultCountry;
    const rules = this.contacts.fieldRules();
    let fixed = 0;
    for (const source of sourceId ? [this.get(sourceId)] : this.list()) {
      const fieldMap = this.effectiveMap(source, rules);
      const rows = this.core.db.all<{ id: number; name: string | null; email: string | null; attributes: string }>(
        "SELECT id, name, email, attributes FROM contacts WHERE lead_source_id = ? AND (name IS NULL OR name = '' OR email IS NULL OR email = '') AND attributes != '{}'",
        source.id,
      );
      for (const row of rows) {
        const attrs = parseJson<Record<string, string>>(row.attributes, {});
        const parsed = parseLead(attrs, country, fieldMap);
        let name = row.name || null;
        let email = row.email || null;
        if (!name && parsed.name) {
          name = parsed.name;
          for (const key of parsed.nameKeys) delete attrs[key];
        }
        if (!email && parsed.email && parsed.emailKey) {
          email = parsed.email;
          delete attrs[parsed.emailKey];
        }
        if (name === (row.name || null) && email === (row.email || null)) continue;
        this.core.db.run('UPDATE contacts SET name = ?, email = ?, attributes = ?, updated_at = ? WHERE id = ?', name, email, JSON.stringify(attrs), this.now(), row.id);
        fixed++;
      }
    }
    return fixed;
  }

  /**
   * For the Columns screen: an example value per column, from this source's latest leads, and how
   * many of its leads still have no name or email.
   */
  columnInfo(sourceId: number): {
    samples: Record<string, string>;
    /** The custom-field name each column is saved under (after renames). */
    savedAs: Record<string, string>;
    leads: number;
    missingName: number;
    missingEmail: number;
  } {
    const source = this.get(sourceId);
    const rules = this.contacts.fieldRules();
    const map = this.effectiveMap(source, rules);
    const rows = this.core.db.all<{ phone: string; name: string | null; email: string | null; attributes: string }>(
      'SELECT phone, name, email, attributes FROM contacts WHERE lead_source_id = ? ORDER BY id DESC LIMIT 25',
      sourceId,
    );
    const samples: Record<string, string> = {};
    const savedAs: Record<string, string> = {};
    for (const { key, as, sample } of source.fieldsSeen) {
      const stored = rules[key]?.target === 'rename' && rules[key].renameTo ? rules[key].renameTo! : key;
      savedAs[key] = stored;
      if (sample) {
        samples[key] = tidyValue(sample).slice(0, 60);
        continue;
      }
      // Sources from before examples were kept: find one in the leads themselves.
      const target = map[key] ?? as;
      for (const row of rows) {
        const attrs = parseJson<Record<string, string>>(row.attributes, {});
        const value =
          target === 'phone'
            ? `+${row.phone}`
            : target === 'email'
              ? (row.email ?? attrs[stored])
              : target === 'name' || target === 'first_name' || target === 'last_name'
                ? (attrs[stored] ?? row.name)
                : attrs[stored];
        if (value) {
          samples[key] = tidyValue(value).slice(0, 60);
          break;
        }
      }
    }
    const counts = this.core.db.get<{ leads: number; missingName: number; missingEmail: number }>(
      `SELECT COUNT(*) AS leads, SUM(CASE WHEN name IS NULL OR trim(name) = '' THEN 1 ELSE 0 END) AS missingName,
              SUM(CASE WHEN email IS NULL OR trim(email) = '' THEN 1 ELSE 0 END) AS missingEmail
         FROM contacts WHERE lead_source_id = ?`,
      sourceId,
    );
    return { samples, savedAs, leads: counts?.leads ?? 0, missingName: counts?.missingName ?? 0, missingEmail: counts?.missingEmail ?? 0 };
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

  private logEvent(sourceId: number, status: 'added' | 'updated' | 'duplicate' | 'failed', contactId: number | null, detail: string | null): void {
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

  /**
   * Turn one submitted lead into a contact and run the source's actions.
   * One number, one lead: if the number is already saved (from any source), nothing about it changes
   * — no overwritten details, no second welcome message — and the submission is logged as a duplicate.
   */
  receive(
    source: LeadSource,
    payload: unknown,
    options: { backfill?: boolean } = {},
  ): { ok: true; contactId: number; created: boolean; duplicate: boolean } | { ok: false; error: string } {
    const settings = this.settings.get();
    const rules = this.contacts.fieldRules();
    const lead = parseLead(payload, settings.defaultCountry, this.effectiveMap(source, rules));
    this.rememberFields(source, lead);
    lead.attributes = this.contacts.applyFieldRenames(lead.attributes, rules);
    if (!lead.phone) {
      const error = lead.fields.length
        ? `No valid phone number found. Fields received: ${lead.fields.slice(0, 12).join(', ')}. Name the phone column "Phone".`
        : 'The lead was empty.';
      this.logEvent(source.id, 'failed', null, error.slice(0, 300));
      return { ok: false, error };
    }
    const existing = this.contacts.findByPhone(lead.phone);
    // Someone who only messaged in before is a new lead now (not a duplicate).
    if (existing?.saved) {
      const since = existing.created_at.slice(0, 10);
      // Never a second contact or a second welcome; only blanks (no name yet, say) are filled in.
      const filled = this.contacts.fillBlanks(existing.id, { name: lead.name, email: lead.email, attributes: lead.attributes });
      this.logEvent(source.id, 'duplicate', existing.id, `Already a lead since ${since}; kept the first details${filled.length ? `, filled in ${filled.join(', ')}` : ''}`);
      return { ok: true, contactId: existing.id, created: false, duplicate: true };
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
        if (upserted.created) this.contacts.setLeadSource(contactId, source.id);
        // Rows that were already in a sheet are added quietly: no welcome series, no owner ping.
        if (actions.sequenceId && !options.backfill) {
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
    this.logEvent(source.id, result.created ? 'added' : 'updated', result.contactId, options.backfill ? 'Earlier row from the sheet: added without messages' : null);
    if (!options.backfill) this.notifyOwner(source, lead, result.created);
    return { ok: true, ...result, duplicate: false };
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
