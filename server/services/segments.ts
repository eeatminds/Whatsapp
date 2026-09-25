import { z } from 'zod';
import type { Core } from '../context.js';
import { nowIso, parseJson, type SqlParam } from '../db/database.js';
import { notFound } from '../lib/errors.js';

/**
 * Dynamic audiences. A segment is a saved rule set evaluated at query time, so "opened the Diwali
 * campaign but didn't reply" or "tagged vip, city = Pune, messaged us in the last 30 days" always
 * reflects the current data.
 */

const id = z.coerce.number().int().positive();

export const conditionSchema = z.union([
  z.object({ field: z.literal('tag'), op: z.enum(['has', 'not_has']), value: id }),
  z.object({ field: z.literal('consent'), op: z.enum(['is', 'is_not']), value: z.enum(['opted_in', 'unknown', 'opted_out']) }),
  z.object({ field: z.literal('wa_status'), op: z.enum(['is', 'is_not']), value: z.enum(['unknown', 'valid', 'invalid']) }),
  z.object({
    field: z.enum(['name', 'email', 'phone', 'source']),
    op: z.enum(['contains', 'not_contains', 'starts_with', 'equals', 'is_empty', 'is_not_empty']),
    value: z.string().max(200).optional(),
  }),
  z.object({
    field: z.literal('attribute'),
    key: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_]{1,64}$/, 'Attribute keys use letters, digits and underscores'),
    op: z.enum(['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty', 'gt', 'lt']),
    value: z.string().max(200).optional(),
  }),
  z.object({
    field: z.enum(['created_at', 'last_inbound_at', 'last_outbound_at']),
    op: z.enum(['within_days', 'older_than_days', 'never', 'ever']),
    value: z.coerce.number().int().min(0).max(3650).optional(),
  }),
  z.object({
    field: z.literal('campaign'),
    op: z.enum(['sent', 'not_sent', 'delivered', 'read', 'not_read', 'replied', 'not_replied', 'clicked']),
    value: id,
  }),
]);

export const rulesSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(conditionSchema).max(30).default([]),
});

export type Condition = z.infer<typeof conditionSchema>;
export type Rules = z.infer<typeof rulesSchema>;

export interface SqlFragment {
  sql: string;
  params: SqlParam[];
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

const SENT_STATUSES = "('sent', 'delivered', 'read')";

function compileCondition(cond: Condition, now: Date): SqlFragment {
  switch (cond.field) {
    case 'tag': {
      const exists = 'EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id = ?)';
      return { sql: cond.op === 'has' ? exists : `NOT ${exists}`, params: [cond.value] };
    }
    case 'consent':
    case 'wa_status': {
      const column = cond.field === 'consent' ? 'c.consent' : 'c.wa_status';
      return { sql: `${column} ${cond.op === 'is' ? '=' : '<>'} ?`, params: [cond.value] };
    }
    case 'name':
    case 'email':
    case 'phone':
    case 'source': {
      const column = `COALESCE(c.${cond.field}, '')`;
      let value = (cond.value ?? '').trim();
      if (cond.field === 'phone') value = value.replace(/\D/g, '');
      switch (cond.op) {
        case 'contains':
          return { sql: `${column} LIKE ? ESCAPE '\\'`, params: [`%${escapeLike(value)}%`] };
        case 'not_contains':
          return { sql: `${column} NOT LIKE ? ESCAPE '\\'`, params: [`%${escapeLike(value)}%`] };
        case 'starts_with':
          return { sql: `${column} LIKE ? ESCAPE '\\'`, params: [`${escapeLike(value)}%`] };
        case 'equals':
          return { sql: `LOWER(${column}) = LOWER(?)`, params: [value] };
        case 'is_empty':
          return { sql: `${column} = ''`, params: [] };
        case 'is_not_empty':
          return { sql: `${column} <> ''`, params: [] };
      }
      break;
    }
    case 'attribute': {
      const expr = `COALESCE(json_extract(c.attributes, ?), '')`;
      const path = `$.${cond.key}`;
      const value = (cond.value ?? '').trim();
      switch (cond.op) {
        case 'equals':
          return { sql: `LOWER(${expr}) = LOWER(?)`, params: [path, value] };
        case 'not_equals':
          return { sql: `LOWER(${expr}) <> LOWER(?)`, params: [path, value] };
        case 'contains':
          return { sql: `${expr} LIKE ? ESCAPE '\\'`, params: [path, `%${escapeLike(value)}%`] };
        case 'is_empty':
          return { sql: `${expr} = ''`, params: [path] };
        case 'is_not_empty':
          return { sql: `${expr} <> ''`, params: [path] };
        case 'gt':
        case 'lt': {
          const number = Number(value);
          if (!Number.isFinite(number)) return { sql: '0', params: [] };
          return {
            sql: `(${expr} <> '' AND CAST(json_extract(c.attributes, ?) AS REAL) ${cond.op === 'gt' ? '>' : '<'} ?)`,
            params: [path, path, number],
          };
        }
      }
      break;
    }
    case 'created_at':
    case 'last_inbound_at':
    case 'last_outbound_at': {
      const column = `c.${cond.field}`;
      const cutoff = nowIso(new Date(now.getTime() - (cond.value ?? 0) * 86_400_000));
      switch (cond.op) {
        case 'within_days':
          return { sql: `${column} >= ?`, params: [cutoff] };
        case 'older_than_days':
          return { sql: `${column} < ?`, params: [cutoff] };
        case 'never':
          return { sql: `${column} IS NULL`, params: [] };
        case 'ever':
          return { sql: `${column} IS NOT NULL`, params: [] };
      }
      break;
    }
    case 'campaign': {
      const base = 'SELECT 1 FROM campaign_recipients r WHERE r.contact_id = c.id AND r.campaign_id = ?';
      const clause: Record<typeof cond.op, string> = {
        sent: `EXISTS (${base} AND r.status IN ${SENT_STATUSES})`,
        not_sent: `NOT EXISTS (${base} AND r.status IN ${SENT_STATUSES})`,
        delivered: `EXISTS (${base} AND r.status IN ('delivered', 'read'))`,
        read: `EXISTS (${base} AND r.status = 'read')`,
        not_read: `EXISTS (${base} AND r.status IN ('sent', 'delivered'))`,
        replied: `EXISTS (${base} AND r.replied_at IS NOT NULL)`,
        not_replied: `EXISTS (${base} AND r.status IN ${SENT_STATUSES} AND r.replied_at IS NULL)`,
        clicked: `EXISTS (${base} AND r.clicked_at IS NOT NULL)`,
      };
      return { sql: clause[cond.op], params: [cond.value] };
    }
  }
  return { sql: '1', params: [] };
}

export function compileRules(rules: Rules, now: Date): SqlFragment {
  if (rules.conditions.length === 0) return { sql: '1', params: [] };
  const parts = rules.conditions.map(cond => compileCondition(cond, now));
  const joiner = rules.match === 'any' ? ' OR ' : ' AND ';
  return {
    sql: `(${parts.map(p => `(${p.sql})`).join(joiner)})`,
    params: parts.flatMap(p => p.params),
  };
}

export function andFragments(fragments: SqlFragment[]): SqlFragment {
  const used = fragments.filter(f => f.sql && f.sql !== '1');
  if (used.length === 0) return { sql: '1', params: [] };
  return { sql: used.map(f => `(${f.sql})`).join(' AND '), params: used.flatMap(f => f.params) };
}

export interface SegmentRow {
  id: number;
  name: string;
  description: string | null;
  rules: string;
  created_at: string;
  updated_at: string;
}

export interface Segment {
  id: number;
  name: string;
  description: string | null;
  rules: Rules;
  createdAt: string;
  updatedAt: string;
  count?: number;
}

export const segmentInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullish(),
  rules: rulesSchema,
});

function toSegment(row: SegmentRow): Segment {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rules: rulesSchema.parse(parseJson(row.rules, { match: 'all', conditions: [] })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SegmentsService {
  constructor(private readonly core: Core) {}

  list(): Segment[] {
    return this.core.db
      .all<SegmentRow>('SELECT * FROM segments ORDER BY name COLLATE NOCASE')
      .map(toSegment)
      .map(segment => ({ ...segment, count: this.count(segment.rules) }));
  }

  get(segmentId: number): Segment {
    const row = this.core.db.get<SegmentRow>('SELECT * FROM segments WHERE id = ?', segmentId);
    if (!row) throw notFound('Segment');
    return toSegment(row);
  }

  create(input: unknown): Segment {
    const data = segmentInputSchema.parse(input);
    const now = nowIso(this.core.clock());
    const { lastInsertRowid } = this.core.db.run(
      'INSERT INTO segments (name, description, rules, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      data.name,
      data.description ?? null,
      JSON.stringify(data.rules),
      now,
      now,
    );
    return this.get(lastInsertRowid);
  }

  update(segmentId: number, input: unknown): Segment {
    this.get(segmentId);
    const data = segmentInputSchema.parse(input);
    this.core.db.run(
      'UPDATE segments SET name = ?, description = ?, rules = ?, updated_at = ? WHERE id = ?',
      data.name,
      data.description ?? null,
      JSON.stringify(data.rules),
      nowIso(this.core.clock()),
      segmentId,
    );
    return this.get(segmentId);
  }

  delete(segmentId: number): void {
    const { changes } = this.core.db.run('DELETE FROM segments WHERE id = ?', segmentId);
    if (!changes) throw notFound('Segment');
  }

  where(rules: Rules): SqlFragment {
    return compileRules(rules, this.core.clock());
  }

  count(rules: Rules): number {
    const where = this.where(rules);
    return this.core.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts c WHERE ${where.sql}`, ...where.params)?.n ?? 0;
  }

  preview(input: unknown): { count: number; sample: Array<{ id: number; name: string | null; phone: string }> } {
    const rules = rulesSchema.parse(input);
    const where = this.where(rules);
    const sample = this.core.db.all<{ id: number; name: string | null; phone: string }>(
      `SELECT c.id, c.name, c.phone FROM contacts c WHERE ${where.sql} ORDER BY c.created_at DESC LIMIT 10`,
      ...where.params,
    );
    return { count: this.count(rules), sample };
  }
}
