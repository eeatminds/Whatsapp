import type { Core } from '../context.js';
import { nowIso } from '../db/database.js';
import { badRequest, notFound } from '../lib/errors.js';
import { OpenWAError, type OpenWAChat, type OpenWAHistoryMessage } from '../openwa/client.js';
import type { ContactsService } from './contacts.js';
import { copyOf, isPersonChat, resolveChatPhone, type IncomingMessage } from './inbound.js';
import type { MessagesService } from './messages.js';
import type { SessionsService } from './sessions.js';

/** Chats read from a phone the first time (most recent first), and messages per chat. */
const FIRST_SYNC_CHATS = 300;
const FIRST_SYNC_PER_CHAT = 100;
/** "Load earlier messages" reaches this much further back each time; WhatsApp allows 2000 per chat. */
const EARLIER_STEP = 200;
const MAX_PER_CHAT = 2000;

export interface HistorySync {
  sessionId: string;
  state: 'running' | 'done' | 'failed';
  chatsTotal: number;
  chatsDone: number;
  messages: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface SyncRow {
  session_id: string;
  state: HistorySync['state'];
  chats_total: number;
  chats_done: number;
  messages: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

function toSync(row: SyncRow): HistorySync {
  return {
    sessionId: row.session_id,
    state: row.state,
    chatsTotal: row.chats_total,
    chatsDone: row.chats_done,
    messages: row.messages,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** A chat name WhatsApp shows that is only the number itself is no name. */
function chatName(chat: OpenWAChat): string | null {
  const name = typeof chat.name === 'string' ? chat.name.trim() : '';
  if (!name || name === chat.id || /^[+\d\s()-]+$/.test(name)) return null;
  return name.slice(0, 200);
}

/**
 * Makes the Inbox a copy of WhatsApp: the first time a number is linked by QR code, its recent
 * chats with people (not groups) are read from the phone, and each chat can reach further back on
 * demand. Copied messages trigger nothing: no auto-replies, no reports, and people who are not
 * contacts stay out of Contacts and campaigns.
 */
export class HistoryService {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly core: Core,
    private readonly contacts: ContactsService,
    private readonly messages: MessagesService,
    private readonly sessions: SessionsService,
    /** Pause between chats, so reading a phone's history never looks like a burst to WhatsApp. */
    private readonly gapMs = 400,
  ) {}

  status(sessionId: string): HistorySync | null {
    const row = this.core.db.get<SyncRow>('SELECT * FROM history_syncs WHERE session_id = ?', sessionId);
    if (!row) return null;
    // A sync cut short by a restart is shown as stopped, so it can be started again.
    if (row.state === 'running' && !this.running.has(sessionId)) return { ...toSync(row), state: 'failed', error: 'Stopped by a restart' };
    return toSync(row);
  }

  list(): HistorySync[] {
    return this.core.db.all<SyncRow>('SELECT * FROM history_syncs ORDER BY started_at DESC').map(row => this.status(row.session_id)!);
  }

  /** Waits for syncs in progress (for shutdown and tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.running.values()].map(run => run.catch(() => undefined)));
  }

  /** Called on each dispatcher tick for connected numbers: copies a phone's chats the first time. */
  autoSync(sessionId: string): void {
    if (this.sessions.isOfficial(sessionId) || this.running.has(sessionId)) return;
    const row = this.core.db.get<SyncRow>('SELECT * FROM history_syncs WHERE session_id = ?', sessionId);
    if (row && row.state !== 'running') return;
    this.begin(sessionId);
  }

  /** Copy (again) the recent chats of a number linked by QR code. Messages already copied are skipped. */
  start(sessionId: string): HistorySync {
    if (!this.sessions.owns(sessionId)) throw notFound('WhatsApp number');
    if (this.sessions.isOfficial(sessionId)) {
      throw badRequest('Official numbers can only show messages from the time they were connected: Meta does not share older chats');
    }
    if (!this.running.has(sessionId)) this.begin(sessionId);
    return this.status(sessionId)!;
  }

  private begin(sessionId: string): void {
    const now = nowIso(this.core.clock());
    this.core.db.run(
      `INSERT INTO history_syncs (session_id, state, chats_total, chats_done, messages, error, started_at, finished_at)
       VALUES (?, 'running', 0, 0, 0, NULL, ?, NULL)
       ON CONFLICT (session_id) DO UPDATE SET state = 'running', chats_total = 0, chats_done = 0, messages = 0, error = NULL,
         started_at = excluded.started_at, finished_at = NULL`,
      sessionId,
      now,
    );
    const run = this.syncChats(sessionId)
      .then(() => {
        this.core.db.run("UPDATE history_syncs SET state = 'done', finished_at = ? WHERE session_id = ?", nowIso(this.core.clock()), sessionId);
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.core.log.warn(`Copying WhatsApp chats for ${sessionId} failed: ${message}`);
        try {
          this.core.db.run(
            "UPDATE history_syncs SET state = 'failed', error = ?, finished_at = ? WHERE session_id = ?",
            message.slice(0, 300),
            nowIso(this.core.clock()),
            sessionId,
          );
        } catch {
          // The business's database was closed (shutdown): nothing to record.
        }
      })
      .finally(() => this.running.delete(sessionId));
    this.running.set(sessionId, run);
  }

  private async syncChats(sessionId: string): Promise<void> {
    const all = await this.core.openwa.listChats(sessionId, FIRST_SYNC_CHATS);
    const chats = (Array.isArray(all) ? all : []).filter(c => isPersonChat(c.id, c.kind, c.isGroup));
    this.core.db.run('UPDATE history_syncs SET chats_total = ? WHERE session_id = ?', chats.length, sessionId);
    for (const chat of chats) {
      let added = 0;
      try {
        const history = await this.core.openwa.chatHistory(sessionId, chat.id, FIRST_SYNC_PER_CHAT);
        added = await this.copyChat(sessionId, chat, Array.isArray(history) ? history : []);
      } catch (error) {
        // The number disconnected or the gateway went away: stop, the rest can be copied later.
        if (error instanceof OpenWAError && (error.status === 0 || error.status === 409 || error.status === 501 || error.status === 503)) throw error;
        this.core.log.warn(`Could not copy chat ${chat.id}: ${String(error)}`);
      }
      this.core.db.run('UPDATE history_syncs SET chats_done = chats_done + 1, messages = messages + ? WHERE session_id = ?', added, sessionId);
      if (this.gapMs > 0) await new Promise(resolve => setTimeout(resolve, this.gapMs));
    }
  }

  /** Copy messages of one chat into the Inbox; returns how many were new. */
  private async copyChat(sessionId: string, chat: OpenWAChat, history: OpenWAHistoryMessage[]): Promise<number> {
    const now = this.core.clock();
    const items = history
      .filter(m => typeof m?.id === 'string' && m.id && !m.isStatusBroadcast)
      .map(m => ({ m, copy: copyOf(m as IncomingMessage) }))
      .filter((x): x is { m: OpenWAHistoryMessage; copy: NonNullable<ReturnType<typeof copyOf>> } => x.copy !== null);
    if (items.length === 0) return 0;
    const senderPhone = items.find(x => !x.m.fromMe && x.m.senderPhone)?.m.senderPhone ?? null;
    const phone = await resolveChatPhone(this.core, sessionId, chat.id, senderPhone);
    if (!phone) return 0;

    const at = (m: OpenWAHistoryMessage) =>
      nowIso(typeof m.timestamp === 'number' && m.timestamp > 0 ? new Date(Math.min(m.timestamp * 1000, now.getTime())) : now);
    const incoming = items.filter(x => !x.m.fromMe);
    // As on the phone: the chat's unread messages stay unread here.
    const unread = new Set(incoming.slice(Math.max(0, incoming.length - Math.max(0, Number(chat.unreadCount) || 0))).map(x => x.m.id));
    const pushName = incoming.map(x => x.m.contact?.pushName || x.m.contact?.name).find(Boolean) ?? null;
    const lastInbound = incoming.length ? at(incoming[incoming.length - 1].m) : null;

    return this.core.db.tx(() => {
      const contact = this.contacts.forChat(phone, chat.id, chatName(chat) ?? (pushName ? pushName.slice(0, 200) : null), lastInbound);
      let added = 0;
      for (const { m, copy } of items) {
        const inserted = this.messages.recordCopy({
          contactId: contact.id,
          sessionId,
          chatId: chat.id,
          direction: m.fromMe ? 'out' : 'in',
          waMessageId: m.id,
          ...copy,
          at: at(m),
          seen: !unread.has(m.id),
        });
        if (inserted) added++;
      }
      return added;
    });
  }

  /**
   * Read further back in one chat from the phone ("Load earlier messages"). Returns how many
   * messages were new, and whether WhatsApp has more.
   */
  async earlier(contactId: number): Promise<{ added: number; more: boolean }> {
    const contact = this.contacts.row(contactId);
    const sessionId = this.messages.lastSessionFor(contactId);
    if (!sessionId || this.sessions.isOfficial(sessionId) || !this.sessions.owns(sessionId)) return { added: 0, more: false };
    const chatId = this.messages.chatIdFor(contactId, sessionId) ?? contact.wa_chat_id;
    if (!chatId || !isPersonChat(chatId)) return { added: 0, more: false };
    const have = this.messages.countForChat(contactId, sessionId);
    const limit = Math.min(MAX_PER_CHAT, have + EARLIER_STEP);
    const history = await this.core.openwa.chatHistory(sessionId, chatId, limit, limit > 100);
    const list = Array.isArray(history) ? history : [];
    const added = await this.copyChat(sessionId, { id: chatId, name: null, unreadCount: 0 }, list);
    return { added, more: list.length >= limit && limit < MAX_PER_CHAT };
  }
}
