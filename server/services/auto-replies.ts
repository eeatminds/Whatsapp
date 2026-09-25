import { z } from 'zod';
import type { Core } from '../context.js';
import { nowIso, parseJson } from '../db/database.js';
import { badRequest, notFound } from '../lib/errors.js';
import { contactVariables, renderTemplate } from '../lib/template.js';
import type { SettingsService } from './settings.js';
import type { MediaService } from './media.js';
import type { TagsService } from './tags.js';
import type { ContactsService, ContactRow } from './contacts.js';
import { toContact } from './contacts.js';
import type { SequencesService } from './sequences.js';
import type { OutboxService } from './outbox.js';

const id = z.coerce.number().int().positive();

export const MATCH_TYPES = ['exact', 'contains', 'starts_with', 'regex', 'any'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

export const actionsSchema = z.object({
  addTagIds: z.array(id).max(20).default([]),
  removeTagIds: z.array(id).max(20).default([]),
  setConsent: z.enum(['opted_in', 'opted_out']).nullish(),
  enrollSequenceId: id.nullish(),
});

export const autoReplyInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    active: z.boolean().default(true),
    priority: z.coerce.number().int().min(0).max(1000).default(100),
    matchType: z.enum(MATCH_TYPES),
    keywords: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    replyBody: z.string().max(4000).default(''),
    replyMediaId: id.nullish(),
    actions: actionsSchema.default({ addTagIds: [], removeTagIds: [] }),
    sessionId: z.string().trim().min(1).nullish(),
    cooldownMinutes: z.coerce.number().int().min(0).max(60 * 24 * 30).default(60),
  })
  .refine(r => r.matchType === 'any' || r.keywords.length > 0, 'Add at least one keyword')
  .refine(
    r =>
      r.replyBody.trim() !== '' ||
      !!r.replyMediaId ||
      r.actions.addTagIds.length > 0 ||
      r.actions.removeTagIds.length > 0 ||
      !!r.actions.setConsent ||
      !!r.actions.enrollSequenceId,
    'The rule must reply or take at least one action',
  );

export type Actions = z.infer<typeof actionsSchema>;

export interface AutoReply {
  id: number;
  name: string;
  active: boolean;
  priority: number;
  matchType: MatchType;
  keywords: string[];
  replyBody: string;
  replyMediaId: number | null;
  actions: Actions;
  sessionId: string | null;
  cooldownMinutes: number;
  hitCount: number;
  lastHitAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AutoReplyRow {
  id: number;
  name: string;
  active: number;
  priority: number;
  match_type: MatchType;
  keywords: string;
  reply_body: string;
  reply_media_id: number | null;
  actions: string;
  session_id: string | null;
  cooldown_minutes: number;
  hit_count: number;
  last_hit_at: string | null;
  created_at: string;
  updated_at: string;
}

function toAutoReply(row: AutoReplyRow): AutoReply {
  return {
    id: row.id,
    name: row.name,
    active: !!row.active,
    priority: row.priority,
    matchType: row.match_type,
    keywords: parseJson<string[]>(row.keywords, []),
    replyBody: row.reply_body,
    replyMediaId: row.reply_media_id,
    actions: actionsSchema.parse(parseJson(row.actions, {})),
    sessionId: row.session_id,
    cooldownMinutes: row.cooldown_minutes,
    hitCount: row.hit_count,
    lastHitAt: row.last_hit_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Uppercase, punctuation-free, single-spaced: "Stop!!" and " stop " both become "STOP". */
export function normalizeKeywordText(text: string): string {
  return text
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchesRule(rule: Pick<AutoReply, 'matchType' | 'keywords'>, body: string): boolean {
  if (rule.matchType === 'any') return true;
  const text = normalizeKeywordText(body);
  if (rule.matchType === 'regex') {
    const sample = body.slice(0, 1000);
    return rule.keywords.some(pattern => {
      try {
        return new RegExp(pattern, 'iu').test(sample);
      } catch {
        return false;
      }
    });
  }
  if (!text) return false;
  return rule.keywords.some(raw => {
    const keyword = normalizeKeywordText(raw);
    if (!keyword) return false;
    switch (rule.matchType) {
      case 'exact':
        return text === keyword;
      case 'starts_with':
        return text === keyword || text.startsWith(`${keyword} `);
      case 'contains':
        return ` ${text} `.includes(` ${keyword} `);
      default:
        return false;
    }
  });
}

export class AutoRepliesService {
  constructor(
    private readonly core: Core,
    private readonly settings: SettingsService,
    private readonly media: MediaService,
    private readonly tags: TagsService,
    private readonly contacts: ContactsService,
    private readonly sequences: SequencesService,
    private readonly outbox: OutboxService,
  ) {}

  list(): AutoReply[] {
    return this.core.db.all<AutoReplyRow>('SELECT * FROM auto_replies ORDER BY priority, id').map(toAutoReply);
  }

  get(ruleId: number): AutoReply {
    const row = this.core.db.get<AutoReplyRow>('SELECT * FROM auto_replies WHERE id = ?', ruleId);
    if (!row) throw notFound('Auto-reply');
    return toAutoReply(row);
  }

  private validate(input: unknown) {
    const data = autoReplyInputSchema.parse(input);
    if (data.matchType === 'regex') {
      for (const pattern of data.keywords) {
        try {
          new RegExp(pattern, 'iu');
        } catch (error) {
          throw badRequest(`Invalid pattern '${pattern}': ${(error as Error).message}`);
        }
      }
    }
    for (const tagId of [...data.actions.addTagIds, ...data.actions.removeTagIds]) {
      if (!this.tags.exists(tagId)) throw badRequest(`Tag ${tagId} does not exist`);
    }
    if (data.actions.enrollSequenceId) this.sequences.get(data.actions.enrollSequenceId);
    if (data.replyMediaId && !this.media.exists(data.replyMediaId)) throw badRequest('The reply media file no longer exists');
    return data;
  }

  create(input: unknown): AutoReply {
    const data = this.validate(input);
    const now = nowIso(this.core.clock());
    const { lastInsertRowid } = this.core.db.run(
      `INSERT INTO auto_replies (name, active, priority, match_type, keywords, reply_body, reply_media_id, actions, session_id,
                                 cooldown_minutes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.name,
      data.active,
      data.priority,
      data.matchType,
      JSON.stringify(data.keywords),
      data.replyBody,
      data.replyMediaId ?? null,
      JSON.stringify(data.actions),
      data.sessionId ?? null,
      data.cooldownMinutes,
      now,
      now,
    );
    return this.get(lastInsertRowid);
  }

  update(ruleId: number, input: unknown): AutoReply {
    this.get(ruleId);
    const data = this.validate(input);
    this.core.db.run(
      `UPDATE auto_replies SET name = ?, active = ?, priority = ?, match_type = ?, keywords = ?, reply_body = ?, reply_media_id = ?,
              actions = ?, session_id = ?, cooldown_minutes = ?, updated_at = ? WHERE id = ?`,
      data.name,
      data.active,
      data.priority,
      data.matchType,
      JSON.stringify(data.keywords),
      data.replyBody,
      data.replyMediaId ?? null,
      JSON.stringify(data.actions),
      data.sessionId ?? null,
      data.cooldownMinutes,
      nowIso(this.core.clock()),
      ruleId,
    );
    return this.get(ruleId);
  }

  delete(ruleId: number): void {
    const { changes } = this.core.db.run('DELETE FROM auto_replies WHERE id = ?', ruleId);
    if (!changes) throw notFound('Auto-reply');
  }

  /** The first active rule (by priority) that matches and is not cooling down for this contact. */
  findMatch(body: string, sessionId: string, contactId: number): AutoReply | null {
    const rules = this.core.db
      .all<AutoReplyRow>('SELECT * FROM auto_replies WHERE active = 1 AND (session_id IS NULL OR session_id = ?) ORDER BY priority, id', sessionId)
      .map(toAutoReply);
    const now = this.core.clock().getTime();
    for (const rule of rules) {
      if (!matchesRule(rule, body)) continue;
      if (rule.cooldownMinutes > 0) {
        const since = nowIso(new Date(now - rule.cooldownMinutes * 60_000));
        const recent = this.core.db.get(
          'SELECT 1 FROM auto_reply_hits WHERE rule_id = ? AND contact_id = ? AND hit_at >= ? LIMIT 1',
          rule.id,
          contactId,
          since,
        );
        if (recent) continue;
      }
      return rule;
    }
    return null;
  }

  /** Run the rule's actions, then queue its reply. */
  apply(rule: AutoReply, contact: ContactRow, sessionId: string, chatId: string): void {
    const at = nowIso(this.core.clock());
    this.core.db.tx(() => {
      this.core.db.run('INSERT INTO auto_reply_hits (rule_id, contact_id, hit_at) VALUES (?, ?, ?)', rule.id, contact.id, at);
      this.core.db.run('UPDATE auto_replies SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?', at, rule.id);
      if (rule.actions.addTagIds.length) this.contacts.addTags([contact.id], rule.actions.addTagIds);
      if (rule.actions.removeTagIds.length) this.contacts.removeTags([contact.id], rule.actions.removeTagIds);
      // The contact is texting us, so a keyword opt-in is their own consent.
      if (rule.actions.setConsent) this.contacts.setConsent(contact.id, rule.actions.setConsent, 'keyword');
      if (rule.actions.enrollSequenceId) {
        try {
          this.sequences.enroll(rule.actions.enrollSequenceId, [contact.id]);
        } catch (error) {
          this.core.log.warn(`Auto-reply ${rule.id}: enrollment failed: ${String(error)}`);
        }
      }
      if (rule.replyBody.trim() || rule.replyMediaId) {
        const fresh = this.contacts.row(contact.id);
        const text = renderTemplate(
          rule.replyBody,
          contactVariables(toContact(fresh), { business_name: this.settings.get().businessName }),
        ).text;
        this.outbox.enqueue({
          sessionId,
          contactId: contact.id,
          chatId,
          body: text,
          mediaId: rule.replyMediaId,
          sourceType: 'auto_reply',
          sourceId: rule.id,
          // A short, human-looking pause before answering.
          delayMs: 1500 + Math.floor(Math.random() * 2500),
        });
      }
    });
  }

  pruneHits(): void {
    const cutoff = nowIso(new Date(this.core.clock().getTime() - 31 * 86_400_000));
    this.core.db.run('DELETE FROM auto_reply_hits WHERE hit_at < ?', cutoff);
  }
}
