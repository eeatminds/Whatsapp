import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Core } from '../context.js';
import { OpenWAError } from '../openwa/client.js';
import { mediaKind, type MessageRow, type MessagesService } from './messages.js';
import type { SessionsService } from './sessions.js';

/** WhatsApp only sends files along with the last 100 messages of a chat. */
const PHONE_WINDOW = 100;
/** Messages WhatsApp counts that the Inbox doesn't keep (notices, calls), allowed for when reaching back. */
const WINDOW_SLACK = 10;
/** Largest file kept (WhatsApp's own limit for documents is 2 GB; the gateway stops at 50 MB). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface ChatFile {
  mimetype: string;
  data: Buffer;
  name: string | null;
}

/**
 * Photos, videos, voice notes and documents of WhatsApp chats, shown in the Inbox as WhatsApp Web
 * shows them. Each file is downloaded once and kept in the business's own chat-media folder. The
 * gateway keeps the files of messages that arrive (or are sent from the phone) while the number is
 * linked; when it couldn't (too big, or the download failed), the file is read from the phone with
 * the chat's last 100 messages. Only files of messages already in the Inbox are kept.
 */
export class ChatMediaService {
  /** One read from the phone per chat at a time (a chat opening asks for all its photos at once). */
  private readonly reading = new Map<string, { limit: number; run: Promise<Map<string, 'kept' | 'skipped' | 'none'>> }>();

  constructor(
    private readonly core: Core,
    private readonly messages: MessagesService,
    private readonly sessions: SessionsService,
  ) {}

  /** Next to the business's media library; left out of backups (it is a copy of what is on the phone). */
  private dir(): string {
    const dir = join(dirname(this.core.config.mediaDir), 'chat-media');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private usable(row: MessageRow | null): row is MessageRow & { wa_message_id: string } {
    return (
      !!row &&
      !!row.wa_message_id &&
      !row.media_id &&
      !!mediaKind(row.type) &&
      !!row.contact_id &&
      this.sessions.owns(row.session_id) &&
      !this.sessions.isOfficial(row.session_id)
    );
  }

  private cached(row: MessageRow): ChatFile | null {
    if (!row.media_file || !/^m\d+$/.test(row.media_file)) return null;
    const path = join(this.dir(), row.media_file);
    if (!existsSync(path)) return null;
    return { data: readFileSync(path), mimetype: row.media_mime ?? 'application/octet-stream', name: row.media_name };
  }

  private save(row: MessageRow, data: Buffer, mimetype: string | null, filename: string | null): void {
    if (data.length === 0 || data.length > MAX_FILE_BYTES) return;
    const name = `m${row.id}`;
    writeFileSync(join(this.dir(), name), data);
    this.core.db.run(
      `UPDATE messages SET media_file = ?, media_mime = COALESCE(?, media_mime), media_name = COALESCE(media_name, ?), media_size = ?, media_missing = 0
        WHERE id = ?`,
      name,
      mimetype ? mimetype.split(';')[0].trim().toLowerCase().slice(0, 100) || null : null,
      filename ? filename.slice(0, 255) : null,
      data.length,
      row.id,
    );
  }

  private markMissing(id: number): void {
    this.core.db.run('UPDATE messages SET media_missing = 1 WHERE id = ? AND media_file IS NULL', id);
  }

  /** How many messages of its chat are newer than this one, as far as the Inbox knows. */
  private position(row: MessageRow): number {
    return (
      this.core.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM messages
          WHERE contact_id = ? AND session_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))`,
        row.contact_id,
        row.session_id,
        row.created_at,
        row.created_at,
        row.id,
      )?.n ?? 0
    );
  }

  /** The copy the gateway kept of a file that arrived live. False when it has none. */
  private async fromGateway(row: MessageRow & { wa_message_id: string }): Promise<boolean> {
    try {
      const stored = await this.core.openwa.getMedia(row.session_id, row.chat_id, row.wa_message_id);
      this.save(row, stored.data, stored.mimetype, null);
      return true;
    } catch (error) {
      if (error instanceof OpenWAError && error.status === 404) return false;
      throw error;
    }
  }

  /**
   * The file of an Inbox message, downloading it the first time. Null when WhatsApp no longer has
   * it (or it is too far back in the chat to download); `retry` tries again after that.
   */
  async file(messageId: number, options: { retry?: boolean } = {}): Promise<ChatFile | null> {
    const row = this.messages.byId(messageId);
    if (!this.usable(row)) return null;
    const kept = this.cached(row);
    if (kept) return kept;
    if (row.media_missing && !options.retry) return null;
    if (await this.fromGateway(row)) return this.cached(this.messages.byId(messageId)!);
    await this.fromPhone([row]);
    return this.cached(this.messages.byId(messageId)!);
  }

  /**
   * Older files, read from the phone with the chat's recent messages: one read reaching back to the
   * oldest of them. A file left out because the read grew too big is asked for again on its own
   * (it is then first in line); a file WhatsApp sent nothing for is marked as no longer there.
   */
  private async fromPhone(rows: Array<MessageRow & { wa_message_id: string }>): Promise<void> {
    const within = rows.filter(row => {
      if (this.position(row) < PHONE_WINDOW) return true;
      this.markMissing(row.id);
      return false;
    });
    if (within.length === 0) return;
    const { session_id: sessionId, chat_id: chatId } = within[0];
    const reach = (row: MessageRow) => Math.min(PHONE_WINDOW, this.position(row) + 1 + WINDOW_SLACK);
    const found = await this.readFromPhone(sessionId, chatId, Math.max(...within.map(reach)));
    for (const row of within) {
      if (this.messages.byId(row.id)?.media_file) continue;
      let state = found.get(row.wa_message_id);
      if (state === 'skipped') state = (await this.readFromPhone(sessionId, chatId, reach(row))).get(row.wa_message_id);
      if (state !== 'kept' && state !== 'skipped') this.markMissing(row.id);
    }
  }

  /**
   * Start downloading the files of a chat that aren't on this server yet (when the chat is opened,
   * like WhatsApp Web does). Returns how many are being downloaded.
   */
  prepare(contactId: number): number {
    const rows = this.core.db.all<MessageRow>(
      `SELECT * FROM messages WHERE contact_id = ? AND media_file IS NULL AND media_missing = 0 AND media_id IS NULL
          AND type IN ('image', 'sticker', 'video', 'audio', 'voice', 'ptt', 'document') AND wa_message_id IS NOT NULL
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      contactId,
      PHONE_WINDOW,
    );
    const wanted = rows.filter((r): r is MessageRow & { wa_message_id: string } => this.usable(r));
    if (wanted.length === 0) return 0;
    const key = `prepare|${contactId}`;
    if (this.reading.has(key)) return wanted.length;
    const run = (async () => {
      const fromPhone: Array<MessageRow & { wa_message_id: string }> = [];
      for (const row of wanted) if (!(await this.fromGateway(row))) fromPhone.push(row);
      // A chat's messages can sit on more than one of the business's numbers.
      for (const sessionId of new Set(fromPhone.map(r => `${r.session_id}|${r.chat_id}`))) {
        await this.fromPhone(fromPhone.filter(r => `${r.session_id}|${r.chat_id}` === sessionId));
      }
      return new Map<string, 'kept' | 'skipped' | 'none'>();
    })();
    this.reading.set(key, { limit: 0, run });
    run
      .catch(error => this.core.log.warn(`Could not download chat files: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.reading.delete(key));
    return wanted.length;
  }

  /**
   * The Inbox starts from the moment a number is linked. An earlier version copied a phone's old
   * chats in as well; those messages (from before the number was linked), their files, and people
   * who were only in the Inbox because of them are removed, once.
   */
  removeCopiedHistory(): { messages: number; contacts: number } {
    const synced = this.core.db.all<{ session_id: string }>('SELECT session_id FROM history_syncs');
    if (synced.length === 0) return { messages: 0, contacts: 0 };
    const files: string[] = [];
    const result = this.core.db.tx(() => {
      let messages = 0;
      for (const { session_id: sessionId } of synced) {
        const since = this.core.db.get<{ created_at: string }>('SELECT created_at FROM owned_sessions WHERE session_id = ?', sessionId)?.created_at;
        if (!since) continue;
        for (const row of this.core.db.all<{ media_file: string | null }>(
          'SELECT media_file FROM messages WHERE session_id = ? AND created_at < ? AND media_file IS NOT NULL',
          sessionId,
          since,
        )) {
          if (row.media_file && /^m\d+$/.test(row.media_file)) files.push(row.media_file);
        }
        messages += this.core.db.run('DELETE FROM messages WHERE session_id = ? AND created_at < ?', sessionId, since).changes;
      }
      const contacts = this.core.db.run(
        `DELETE FROM contacts WHERE saved = 0 AND source = 'whatsapp' AND lead_source_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = contacts.id)`,
      ).changes;
      this.core.db.run('DELETE FROM history_syncs');
      return { messages, contacts };
    });
    for (const name of files) rmSync(join(this.dir(), name), { force: true });
    return result;
  }

  /** Waits for downloads in progress (for shutdown and tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.reading.values()].map(r => r.run.catch(() => undefined)));
  }

  /**
   * Read a chat's last `limit` messages from the phone with their files, and keep the files of
   * messages the Inbox has. Concurrent asks for the same chat share one read. Returns, per message
   * id sent back, whether its file came with it ('kept'), was left out for size ('skipped'), or had
   * none ('none').
   */
  private async readFromPhone(sessionId: string, chatId: string, limit: number): Promise<Map<string, 'kept' | 'skipped' | 'none'>> {
    const key = `${sessionId}|${chatId}`;
    const running = this.reading.get(key);
    if (running && running.limit >= limit) return running.run;
    const run = (async () => {
      const found = new Map<string, 'kept' | 'skipped' | 'none'>();
      const history = await this.core.openwa.chatHistory(sessionId, chatId, limit, false, true);
      for (const m of Array.isArray(history) ? history : []) {
        if (typeof m?.id !== 'string') continue;
        const row = this.core.db.get<MessageRow>('SELECT * FROM messages WHERE session_id = ? AND wa_message_id = ?', sessionId, m.id);
        const data = m.media?.data;
        if (typeof data === 'string' && data && !/^https?:/i.test(data)) {
          found.set(m.id, 'kept');
          if (row && !row.media_file && this.usable(row)) this.save(row, Buffer.from(data, 'base64'), m.media?.mimetype ?? null, m.media?.filename ?? null);
        } else {
          found.set(m.id, m.media?.omitted ? 'skipped' : 'none');
          if (row && m.media?.filename && !row.media_name) {
            this.core.db.run(
              'UPDATE messages SET media_name = ?, media_mime = COALESCE(media_mime, ?), media_size = COALESCE(media_size, ?) WHERE id = ?',
              m.media.filename.slice(0, 255),
              m.media.mimetype ?? null,
              Number(m.media.sizeBytes) || null,
              row.id,
            );
          }
        }
      }
      return found;
    })();
    this.reading.set(key, { limit, run });
    try {
      return await run;
    } finally {
      if (this.reading.get(key)?.run === run) this.reading.delete(key);
    }
  }
}
