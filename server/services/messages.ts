import type { Core } from '../context.js';
import { nowIso } from '../db/database.js';
import { startOfLocalDay } from '../lib/time.js';

export type SourceType = 'campaign' | 'sequence' | 'auto_reply' | 'manual' | 'system' | 'inbound' | 'test';

export interface MessageRow {
  id: number;
  contact_id: number | null;
  session_id: string;
  chat_id: string;
  direction: 'in' | 'out';
  wa_message_id: string | null;
  type: string;
  body: string | null;
  media_id: number | null;
  status: string;
  source_type: SourceType;
  source_id: number | null;
  recipient_id: number | null;
  seen: number;
  created_at: string;
}

export interface Message {
  id: number;
  contactId: number | null;
  sessionId: string;
  direction: 'in' | 'out';
  type: string;
  body: string | null;
  mediaId: number | null;
  status: string;
  sourceType: SourceType;
  sourceId: number | null;
  createdAt: string;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    contactId: row.contact_id,
    sessionId: row.session_id,
    direction: row.direction,
    type: row.type,
    body: row.body,
    mediaId: row.media_id,
    status: row.status,
    sourceType: row.source_type,
    sourceId: row.source_id,
    createdAt: row.created_at,
  };
}

/** Outbound delivery states in the order WhatsApp advances them. Acks only ever move forward. */
const RANK: Record<string, number> = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

export function normalizeAckStatus(status: unknown): 'delivered' | 'read' | 'failed' | null {
  if (status === 'delivered') return 'delivered';
  if (status === 'read' || status === 'played') return 'read';
  if (status === 'failed' || status === 'error') return 'failed';
  return null;
}

export const MARKETING_SOURCES = "('campaign', 'sequence')";

export class MessagesService {
  constructor(private readonly core: Core) {}

  recordOutbound(input: {
    contactId: number | null;
    sessionId: string;
    chatId: string;
    waMessageId: string | null;
    body: string | null;
    mediaId?: number | null;
    type?: string;
    sourceType: SourceType;
    sourceId?: number | null;
    recipientId?: number | null;
    at?: string;
  }): void {
    const at = input.at ?? nowIso(this.core.clock());
    this.core.db.run(
      `INSERT INTO messages (contact_id, session_id, chat_id, direction, wa_message_id, type, body, media_id, status,
                             source_type, source_id, recipient_id, seen, created_at)
       VALUES (?, ?, ?, 'out', ?, ?, ?, ?, 'sent', ?, ?, ?, 1, ?)
       ON CONFLICT (session_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING`,
      input.contactId,
      input.sessionId,
      input.chatId,
      input.waMessageId,
      input.type ?? 'text',
      input.body,
      input.mediaId ?? null,
      input.sourceType,
      input.sourceId ?? null,
      input.recipientId ?? null,
      at,
    );
    if (input.contactId) {
      this.core.db.run('UPDATE contacts SET last_outbound_at = ? WHERE id = ?', at, input.contactId);
    }
  }

  /** Returns false when the message was already recorded (webhook retries, engine re-fires). */
  recordInbound(input: {
    contactId: number;
    sessionId: string;
    chatId: string;
    waMessageId: string | null;
    body: string | null;
    type: string;
    at: string;
  }): boolean {
    const { changes } = this.core.db.run(
      `INSERT INTO messages (contact_id, session_id, chat_id, direction, wa_message_id, type, body, status, source_type, seen, created_at)
       VALUES (?, ?, ?, 'in', ?, ?, ?, 'received', 'inbound', 0, ?)
       ON CONFLICT (session_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING`,
      input.contactId,
      input.sessionId,
      input.chatId,
      input.waMessageId,
      input.type,
      input.body,
      input.at,
    );
    return changes > 0;
  }

  /**
   * Apply a delivery receipt to the message log and, for campaign messages, the recipient row.
   * Forward-only: a late "delivered" never downgrades "read", and "failed" only lands on a message
   * WhatsApp had not yet delivered.
   */
  applyAck(sessionId: string, waMessageId: string, rawStatus: unknown): boolean {
    const status = normalizeAckStatus(rawStatus);
    if (!status || !waMessageId) return false;
    const message = this.core.db.get<MessageRow>(
      "SELECT * FROM messages WHERE session_id = ? AND wa_message_id = ? AND direction = 'out'",
      sessionId,
      waMessageId,
    );
    if (!message) return false;
    const at = nowIso(this.core.clock());
    const current = RANK[message.status] ?? -1;
    if (status === 'failed') {
      if (current >= RANK.delivered) return false;
    } else if (current >= RANK[status]) {
      return false;
    }
    this.core.db.run('UPDATE messages SET status = ? WHERE id = ?', status, message.id);
    if (message.recipient_id) this.advanceRecipient(message.recipient_id, status, at);
    return true;
  }

  private advanceRecipient(recipientId: number, status: 'delivered' | 'read' | 'failed', at: string): void {
    if (status === 'failed') {
      this.core.db.run(
        "UPDATE campaign_recipients SET status = 'failed', error = 'WhatsApp reported the message as failed', failed_at = ? WHERE id = ? AND status = 'sent'",
        at,
        recipientId,
      );
      return;
    }
    if (status === 'delivered') {
      this.core.db.run(
        "UPDATE campaign_recipients SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?) WHERE id = ? AND status = 'sent'",
        at,
        recipientId,
      );
      return;
    }
    // A read receipt implies delivery, even when the delivered ack never arrived.
    this.core.db.run(
      `UPDATE campaign_recipients SET status = 'read', delivered_at = COALESCE(delivered_at, ?), read_at = COALESCE(read_at, ?)
        WHERE id = ? AND status IN ('sent', 'delivered')`,
      at,
      at,
      recipientId,
    );
  }

  /** Campaign + sequence sends from this number since local midnight. Replies and confirmations don't count. */
  marketingSentToday(sessionId: string, timeZone: string): number {
    const since = nowIso(startOfLocalDay(this.core.clock(), timeZone));
    return (
      this.core.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND direction = 'out' AND created_at >= ?
            AND source_type IN ${MARKETING_SOURCES}`,
        sessionId,
        since,
      )?.n ?? 0
    );
  }

  /** Whether the contact got any marketing message since `since`, optionally ignoring one campaign. */
  receivedMarketingSince(contactId: number, since: string, exceptCampaignId?: number): boolean {
    return !!this.core.db.get(
      `SELECT 1 FROM messages m
        WHERE m.contact_id = ? AND m.direction = 'out' AND m.created_at >= ? AND m.source_type IN ${MARKETING_SOURCES}
          AND NOT (m.source_type = 'campaign' AND m.source_id IS ?)
        LIMIT 1`,
      contactId,
      since,
      exceptCampaignId ?? -1,
    );
  }

  // ---------------------------------------------------------------- inbox

  conversations(options: { q?: string; unreadOnly?: boolean; limit?: number }): Array<{
    contactId: number;
    name: string | null;
    phone: string;
    consent: string;
    lastMessage: string | null;
    lastDirection: 'in' | 'out';
    lastAt: string;
    unread: number;
    sessionId: string;
  }> {
    const params: Array<string | number> = [];
    let filter = '';
    if (options.q) {
      filter = "AND (c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')";
      const like = `%${options.q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
      params.push(like, like);
    }
    const rows = this.core.db.all<{
      contact_id: number;
      name: string | null;
      phone: string;
      consent: string;
      body: string | null;
      type: string;
      direction: 'in' | 'out';
      created_at: string;
      session_id: string;
      unread: number;
    }>(
      `WITH latest AS (
         SELECT contact_id, MAX(id) AS id FROM messages
          WHERE contact_id IS NOT NULL
            AND contact_id IN (SELECT DISTINCT contact_id FROM messages WHERE direction = 'in' AND contact_id IS NOT NULL)
          GROUP BY contact_id
       )
       SELECT m.contact_id, c.name, c.phone, c.consent, m.body, m.type, m.direction, m.created_at, m.session_id,
              (SELECT COUNT(*) FROM messages u WHERE u.contact_id = m.contact_id AND u.direction = 'in' AND u.seen = 0) AS unread
         FROM latest l JOIN messages m ON m.id = l.id JOIN contacts c ON c.id = m.contact_id
        WHERE 1 ${filter}
        ORDER BY m.id DESC
        LIMIT ?`,
      ...params,
      Math.min(options.limit ?? 100, 500),
    );
    return rows
      .filter(r => !options.unreadOnly || r.unread > 0)
      .map(r => ({
        contactId: r.contact_id,
        name: r.name,
        phone: r.phone,
        consent: r.consent,
        lastMessage: r.body || (r.type !== 'text' ? `[${r.type}]` : null),
        lastDirection: r.direction,
        lastAt: r.created_at,
        unread: r.unread,
        sessionId: r.session_id,
      }));
  }

  thread(contactId: number, limit = 200): Message[] {
    return this.core.db
      .all<MessageRow>('SELECT * FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT ?', contactId, Math.min(limit, 1000))
      .reverse()
      .map(toMessage);
  }

  markSeen(contactId: number): number {
    return this.core.db.run("UPDATE messages SET seen = 1 WHERE contact_id = ? AND direction = 'in' AND seen = 0", contactId).changes;
  }

  unreadCount(): number {
    return this.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in' AND seen = 0")?.n ?? 0;
  }

  lastSessionFor(contactId: number): string | null {
    return (
      this.core.db.get<{ session_id: string }>('SELECT session_id FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT 1', contactId)
        ?.session_id ?? null
    );
  }
}
