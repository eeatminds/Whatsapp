import type { Core } from '../context.js';
import { nowIso } from '../db/database.js';
import { startOfLocalDay } from '../lib/time.js';

/** 'phone': typed on the phone (or WhatsApp Web) itself, not sent by WA Reach. */
export type SourceType = 'campaign' | 'sequence' | 'auto_reply' | 'manual' | 'system' | 'inbound' | 'test' | 'phone';

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
  media_mime: string | null;
  media_name: string | null;
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
  /** A photo, video, voice note or document from WhatsApp, served by /api/inbox/media/:id. */
  file: { kind: MediaKind; mimetype: string | null; name: string | null } | null;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

/** What a WhatsApp message type shows as, when it carries a file. */
export function mediaKind(type: string): MediaKind | null {
  switch (type) {
    case 'image':
    case 'sticker':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
    case 'voice':
    case 'ptt':
      return 'audio';
    case 'document':
      return 'document';
    default:
      return null;
  }
}

function toMessage(row: MessageRow): Message {
  // Files sent from WA Reach's own media library are shown from there (mediaId).
  const kind = row.media_id ? null : mediaKind(row.type);
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
    file: kind ? { kind, mimetype: row.media_mime, name: row.media_name } : null,
  };
}

/** One message read from a phone's chat history or reported by the gateway. */
export interface CopiedMessage {
  contactId: number;
  sessionId: string;
  chatId: string;
  direction: 'in' | 'out';
  waMessageId: string;
  type: string;
  body: string | null;
  mediaMime?: string | null;
  mediaName?: string | null;
  at: string;
  seen: boolean;
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

const PREVIEW: Record<string, string> = {
  image: '📷 Photo',
  sticker: 'Sticker',
  video: '🎥 Video',
  audio: '🎵 Audio',
  voice: '🎤 Voice message',
  ptt: '🎤 Voice message',
  document: '📄 Document',
  location: '📍 Location',
  contact: '👤 Contact card',
  poll: '📊 Poll',
};

/** How a message with no text shows in the chat list. */
export function previewOf(type: string): string | null {
  return type === 'text' ? null : (PREVIEW[type] ?? `[${type}]`);
}

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
    // WhatsApp echoes every sent message back (message.sent). When that echo arrives before the
    // send is recorded here, the echo row is relabelled with what WA Reach actually sent.
    this.core.db.run(
      `INSERT INTO messages (contact_id, session_id, chat_id, direction, wa_message_id, type, body, media_id, status,
                             source_type, source_id, recipient_id, seen, created_at)
       VALUES (?, ?, ?, 'out', ?, ?, ?, ?, 'sent', ?, ?, ?, 1, ?)
       ON CONFLICT (session_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO UPDATE SET
         contact_id = COALESCE(excluded.contact_id, contact_id),
         body = COALESCE(excluded.body, body),
         media_id = COALESCE(excluded.media_id, media_id),
         source_type = excluded.source_type,
         source_id = excluded.source_id,
         recipient_id = excluded.recipient_id
       WHERE messages.source_type = 'phone' AND excluded.source_type <> 'phone'`,
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
    mediaMime?: string | null;
    mediaName?: string | null;
  }): boolean {
    const { changes } = this.core.db.run(
      `INSERT INTO messages (contact_id, session_id, chat_id, direction, wa_message_id, type, body, status, source_type, seen, created_at,
                             media_mime, media_name)
       VALUES (?, ?, ?, 'in', ?, ?, ?, 'received', 'inbound', 0, ?, ?, ?)
       ON CONFLICT (session_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING`,
      input.contactId,
      input.sessionId,
      input.chatId,
      input.waMessageId,
      input.type,
      input.body,
      input.at,
      input.mediaMime ?? null,
      input.mediaName ?? null,
    );
    return changes > 0;
  }

  /**
   * Keep a copy of a message that WA Reach did not send or receive live: one typed on the phone, or
   * one read from the phone's chat history. Nothing is triggered by it (no auto-replies, no reports).
   * Returns false when the message is already in the Inbox.
   */
  recordCopy(input: CopiedMessage): boolean {
    const { changes } = this.core.db.run(
      `INSERT INTO messages (contact_id, session_id, chat_id, direction, wa_message_id, type, body, status, source_type, seen, created_at,
                             media_mime, media_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING`,
      input.contactId,
      input.sessionId,
      input.chatId,
      input.direction,
      input.waMessageId,
      input.type,
      input.body,
      input.direction === 'in' ? 'received' : 'sent',
      input.direction === 'in' ? 'inbound' : 'phone',
      input.seen || input.direction === 'out' ? 1 : 0,
      input.at,
      input.mediaMime ?? null,
      input.mediaName ?? null,
    );
    return changes > 0;
  }

  /** Messages this number has for one chat (to know how far back the Inbox copy reaches). */
  countForChat(contactId: number, sessionId: string): number {
    return this.core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE contact_id = ? AND session_id = ?', contactId, sessionId)?.n ?? 0;
  }

  /** The chat id WhatsApp uses for this contact on this number (a phone chat id or a privacy id). */
  chatIdFor(contactId: number, sessionId: string): string | null {
    return (
      this.core.db.get<{ chat_id: string }>(
        'SELECT chat_id FROM messages WHERE contact_id = ? AND session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
        contactId,
        sessionId,
      )?.chat_id ?? null
    );
  }

  byId(id: number): MessageRow | null {
    return this.core.db.get<MessageRow>('SELECT * FROM messages WHERE id = ?', id) ?? null;
  }

  /**
   * Apply a delivery receipt to the message log and, for campaign messages, the recipient row.
   * Forward-only: a late "delivered" never downgrades "read", and "failed" only lands on a message
   * WhatsApp had not yet delivered.
   */
  applyAck(sessionId: string, waMessageId: string, rawStatus: unknown, error?: string): boolean {
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
    if (message.recipient_id) this.advanceRecipient(message.recipient_id, status, at, error);
    return true;
  }

  private advanceRecipient(recipientId: number, status: 'delivered' | 'read' | 'failed', at: string, error?: string): void {
    if (status === 'failed') {
      this.core.db.run(
        "UPDATE campaign_recipients SET status = 'failed', error = ?, failed_at = ? WHERE id = ? AND status = 'sent'",
        (error || 'WhatsApp reported the message as failed').slice(0, 500),
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

  conversations(options: { q?: string; unreadOnly?: boolean; repliedOnly?: boolean; limit?: number }): Array<{
    contactId: number;
    name: string | null;
    phone: string;
    consent: string;
    lastMessage: string | null;
    lastDirection: 'in' | 'out';
    lastAt: string;
    unread: number;
    sessionId: string;
    saved: boolean;
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
      saved: number;
    }>(
      // Latest by time, not insert order: chat history copied from the phone arrives after newer messages.
      `WITH ranked AS (
         SELECT contact_id, id, ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY created_at DESC, id DESC) AS rn FROM messages
          WHERE contact_id IS NOT NULL
            ${options.unreadOnly || options.repliedOnly ? "AND contact_id IN (SELECT DISTINCT contact_id FROM messages WHERE direction = 'in' AND contact_id IS NOT NULL)" : ''}
       ),
       latest AS (SELECT contact_id, id FROM ranked WHERE rn = 1)
       SELECT m.contact_id, c.name, c.phone, c.consent, c.saved, m.body, m.type, m.direction, m.created_at, m.session_id,
              (SELECT COUNT(*) FROM messages u WHERE u.contact_id = m.contact_id AND u.direction = 'in' AND u.seen = 0) AS unread
         FROM latest l JOIN messages m ON m.id = l.id JOIN contacts c ON c.id = m.contact_id
        WHERE 1 ${filter}
        ORDER BY m.created_at DESC, m.id DESC
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
        lastMessage: r.body || previewOf(r.type),
        lastDirection: r.direction,
        lastAt: r.created_at,
        unread: r.unread,
        sessionId: r.session_id,
        saved: r.saved !== 0,
      }));
  }

  /** The latest `limit` messages, oldest first, and whether older ones are stored. */
  thread(contactId: number, limit = 200): { messages: Message[]; hasOlder: boolean } {
    const max = Math.min(Math.max(limit, 1), 5000);
    const rows = this.core.db.all<MessageRow>(
      'SELECT * FROM messages WHERE contact_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      contactId,
      max + 1,
    );
    return { messages: rows.slice(0, max).reverse().map(toMessage), hasOlder: rows.length > max };
  }

  /** Mark messages received up to `at` as read (the business answered on the phone). */
  markSeenUntil(contactId: number, at: string): number {
    return this.core.db.run("UPDATE messages SET seen = 1 WHERE contact_id = ? AND direction = 'in' AND seen = 0 AND created_at <= ?", contactId, at).changes;
  }

  markSeen(contactId: number): number {
    return this.core.db.run("UPDATE messages SET seen = 1 WHERE contact_id = ? AND direction = 'in' AND seen = 0", contactId).changes;
  }

  unreadCount(): number {
    // People with unread messages, not messages: someone who writes three times counts once.
    return (
      this.core.db.get<{ n: number }>(
        "SELECT COUNT(DISTINCT contact_id) AS n FROM messages WHERE direction = 'in' AND seen = 0 AND contact_id IS NOT NULL",
      )?.n ?? 0
    );
  }

  lastSessionFor(contactId: number): string | null {
    return (
      this.core.db.get<{ session_id: string }>(
        'SELECT session_id FROM messages WHERE contact_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
        contactId,
      )?.session_id ?? null
    );
  }
}
