import type { Core } from '../context.js';
import { nowIso } from '../db/database.js';
import { chatIdFor, phoneFromChatId } from '../lib/phone.js';
import type { SettingsService } from './settings.js';
import type { ContactsService } from './contacts.js';
import type { MessagesService } from './messages.js';
import type { CampaignsService } from './campaigns.js';
import type { AutoRepliesService } from './auto-replies.js';
import { normalizeKeywordText } from './auto-replies.js';
import type { OutboxService } from './outbox.js';
import type { SessionsService } from './sessions.js';
import type { Bus } from './bus.js';
import type { SessionStatus } from '../openwa/client.js';
import type { OfficialNumbersService, TemplateStatusEvent } from './official.js';
import { metaErrorText } from '../meta/client.js';

/** The parts of Meta's Cloud API webhook we use (object "whatsapp_business_account"). */
interface MetaWebhook {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<Record<string, any>>;
        statuses?: Array<{
          id?: string;
          status?: string;
          recipient_id?: string;
          errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }>;
        }>;
        event?: string;
        message_template_name?: string;
        message_template_language?: string;
      };
    }>;
  }>;
}

/** The customer's words in any message type we can reply to; '' for types with no text. */
function metaText(message: Record<string, any>): string {
  switch (message.type) {
    case 'text':
      return String(message.text?.body ?? '');
    case 'button':
      return String(message.button?.text ?? message.button?.payload ?? '');
    case 'interactive':
      return String(message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? '');
    case 'image':
    case 'video':
    case 'document':
      return String(message[message.type]?.caption ?? '');
    case 'location':
      return [message.location?.name, message.location?.address].filter(Boolean).join(', ');
    default:
      return '';
  }
}

/**
 * Message types with nothing a person wrote: WhatsApp's system notices ("messages are end-to-end
 * encrypted", security-code changes), call logs and deleted-message stubs. OpenWA reports most of
 * these as `unknown` with an empty body; they never appear as texts on the phone, so they are
 * dropped instead of filling the inbox and creating contacts.
 */
export const NON_MESSAGE_TYPES = new Set([
  'unknown',
  'revoked',
  'call',
  'call_log',
  'masked',
  'e2e_notification',
  'notification',
  'notification_template',
  'gp2',
  'protocol',
  'ciphertext',
  'broadcast_notification',
]);

/** Meta's "Stop promotions" button on marketing templates is an opt-out, whatever the keyword list says. */
const STOP_PROMOTIONS = /^stop promotions?$/i;
/** Meta error: the customer stopped marketing messages from this business on WhatsApp. */
const MARKETING_STOPPED = 131050;

/** OpenWA webhook body (docs/06-api-specification.md §6.6). */
export interface WebhookEnvelope {
  event: string;
  timestamp?: string;
  sessionId: string;
  idempotencyKey?: string;
  deliveryId?: string;
  data?: Record<string, unknown>;
}

export interface IncomingMessage {
  id?: string;
  from?: string;
  to?: string;
  chatId?: string;
  body?: string;
  type?: string;
  timestamp?: number;
  isGroup?: boolean;
  kind?: string;
  fromMe?: boolean;
  isStatusBroadcast?: boolean;
  senderPhone?: string | null;
  contact?: { name?: string; pushName?: string };
  media?: { mimetype?: string; filename?: string; data?: string; omitted?: boolean; sizeBytes?: number };
  location?: { latitude?: number; longitude?: number; description?: string; address?: string };
}

/** Longest message text kept in the Inbox (WhatsApp's own limit is 65,536 characters). */
const MAX_BODY = 65_536;

/**
 * What of a WhatsApp message goes into the Inbox: its text (a caption for files, a place for
 * locations) and what file it carries. Null for things that are not messages a person wrote.
 */
export function copyOf(
  message: IncomingMessage,
): { type: string; body: string | null; mediaMime: string | null; mediaName: string | null; mediaSize: number | null } | null {
  const type = message.type ?? 'text';
  if (NON_MESSAGE_TYPES.has(type) || message.isStatusBroadcast) return null;
  let body = typeof message.body === 'string' ? message.body : '';
  if (type === 'location' && (message.location || /^[A-Za-z0-9+/=]{200,}$/.test(body))) {
    // A location's body is a base64 map picture; keep the place and a map link instead.
    const place = [message.location?.description, message.location?.address].filter(Boolean).join(', ');
    const lat = Number(message.location?.latitude);
    const lng = Number(message.location?.longitude);
    const link = Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng) ? `https://maps.google.com/?q=${lat},${lng}` : '';
    body = [place, link].filter(Boolean).join('\n');
  }
  if ((type === 'text' || type === 'chat') && !body.trim()) return null;
  const mimetype = typeof message.media?.mimetype === 'string' ? message.media.mimetype.slice(0, 100) : null;
  const filename = typeof message.media?.filename === 'string' ? message.media.filename.slice(0, 255) : null;
  const declared = Number(message.media?.sizeBytes);
  const inline = typeof message.media?.data === 'string' && !/^https?:/i.test(message.media.data) ? Buffer.byteLength(message.media.data, 'base64') : 0;
  const size = Number.isFinite(declared) && declared > 0 ? Math.round(declared) : inline || null;
  return {
    type: type === 'chat' ? 'text' : type,
    body: body ? body.slice(0, MAX_BODY) : null,
    mediaMime: mimetype || null,
    mediaName: filename || null,
    mediaSize: size,
  };
}

/** WhatsApp chats with one person (not groups, channels, broadcasts or status). */
export function isPersonChat(chatId: string | undefined, kind?: string, isGroup?: boolean): boolean {
  if (!chatId || isGroup) return false;
  if (kind && kind !== 'individual') return false;
  return /@(c\.us|s\.whatsapp\.net|lid)$/.test(chatId);
}

export type InboundOutcome =
  | 'duplicate'
  | 'ignored'
  | 'ack'
  | 'session_status'
  | 'unresolved_sender'
  | 'unknown_sender'
  | 'inbox_only'
  | 'duplicate_message'
  | 'opted_out'
  | 'opted_in'
  | 'auto_reply'
  | 'sent_from_phone'
  | 'received';

/**
 * Turns OpenWA events into marketing state: delivery receipts, inbound replies, STOP/START
 * handling, reply attribution and auto-replies. Everything is idempotent — OpenWA delivers
 * at-least-once, and both the idempotency key and the message id are deduplicated.
 */
export class InboundService {
  constructor(
    private readonly core: Core,
    private readonly settings: SettingsService,
    private readonly contacts: ContactsService,
    private readonly messages: MessagesService,
    private readonly campaigns: CampaignsService,
    private readonly autoReplies: AutoRepliesService,
    private readonly outbox: OutboxService,
    private readonly sessions: SessionsService,
    private readonly bus: Bus,
    private readonly official?: OfficialNumbersService,
    /** How long to wait before treating an echoed message as typed on the phone (see handleOwnMessage). */
    private readonly phoneReadDelayMs = 15_000,
  ) {}

  private alreadyProcessed(key: string | undefined): boolean {
    return !!key && !!this.core.db.get('SELECT 1 FROM webhook_receipts WHERE idempotency_key = ?', key);
  }

  /** Recorded only after processing succeeds, so a delivery that failed midway is retried by OpenWA. */
  private markProcessed(key: string | undefined): void {
    if (!key) return;
    this.core.db.run('INSERT OR IGNORE INTO webhook_receipts (idempotency_key, received_at) VALUES (?, ?)', key, nowIso(this.core.clock()));
  }

  async handle(envelope: WebhookEnvelope, idempotencyHeader?: string): Promise<InboundOutcome> {
    if (!envelope || typeof envelope.event !== 'string' || typeof envelope.sessionId !== 'string') return 'ignored';
    const key = idempotencyHeader ?? envelope.idempotencyKey;
    if (this.alreadyProcessed(key)) return 'duplicate';
    const outcome = await this.dispatch(envelope);
    this.markProcessed(key);
    return outcome;
  }

  private async dispatch(envelope: WebhookEnvelope): Promise<InboundOutcome> {
    const data = envelope.data ?? {};
    switch (envelope.event) {
      case 'message.ack':
      case 'message.failed': {
        const messageId = String(data.messageId ?? data.id ?? '');
        const status = envelope.event === 'message.failed' ? 'failed' : data.status;
        this.messages.applyAck(envelope.sessionId, messageId, status);
        return 'ack';
      }
      case 'session.status':
        if (typeof data.status === 'string') this.sessions.applyStatus(envelope.sessionId, data.status as SessionStatus);
        return 'session_status';
      case 'message.received':
        return this.handleMessage(envelope.sessionId, data as IncomingMessage);
      case 'message.sent':
        return this.handleOwnMessage(envelope.sessionId, data as IncomingMessage);
      default:
        return 'ignored';
    }
  }

  private async resolvePhone(sessionId: string, message: IncomingMessage): Promise<string | null> {
    return resolveChatPhone(this.core, sessionId, message.from, message.senderPhone);
  }

  /**
   * A message the business sent from the phone itself (or WhatsApp Web), so the Inbox shows the
   * whole conversation. WhatsApp also echoes WA Reach's own sends here; those are recorded once.
   * Nothing is triggered: no auto-replies, no reports, no new contacts in lists.
   */
  private async handleOwnMessage(sessionId: string, message: IncomingMessage): Promise<InboundOutcome> {
    if (!message.fromMe || !message.id) return 'ignored';
    const chatId = message.chatId ?? message.to;
    if (!isPersonChat(chatId, message.kind, message.isGroup)) return 'ignored';
    const copy = copyOf(message);
    if (!copy) return 'ignored';
    if (this.core.db.get('SELECT 1 FROM messages WHERE session_id = ? AND wa_message_id = ?', sessionId, message.id)) return 'duplicate_message';
    const phone = await resolveChatPhone(this.core, sessionId, chatId, null);
    if (!phone) return 'unresolved_sender';
    const now = this.core.clock();
    const at = nowIso(typeof message.timestamp === 'number' && message.timestamp > 0 ? new Date(Math.min(message.timestamp * 1000, now.getTime())) : now);
    return this.core.db.tx(() => {
      const contact = this.contacts.forChat(phone, chatId!, null);
      const inserted = this.messages.recordCopy({ contactId: contact.id, sessionId, chatId: chatId!, direction: 'out', waMessageId: message.id!, ...copy, at, seen: true });
      if (!inserted) return 'duplicate_message' as const;
      this.core.db.run('UPDATE contacts SET last_outbound_at = MAX(COALESCE(last_outbound_at, ?), ?) WHERE id = ?', at, at, contact.id);
      // Answering on the phone reads the chat, as it does in WhatsApp. WhatsApp also echoes WA Reach's
      // own sends here, sometimes before the send is recorded; so the chat is only marked read once
      // the message is known to be from the phone (a campaign must never hide an unread reply).
      const markRead = () => {
        try {
          const row = this.core.db.get<{ source_type: string }>('SELECT source_type FROM messages WHERE session_id = ? AND wa_message_id = ?', sessionId, message.id);
          if (row?.source_type === 'phone') this.messages.markSeenUntil(contact.id, at);
        } catch {
          // The business's database was closed (shutdown).
        }
      };
      if (this.phoneReadDelayMs > 0) setTimeout(markRead, this.phoneReadDelayMs).unref?.();
      else markRead();
      return 'sent_from_phone' as const;
    });
  }

  /**
   * Events from Meta's Cloud API for official numbers: customer messages go through the same path
   * as QR-linked numbers (opt-outs, attribution, auto-replies); delivery receipts update reports.
   * Meta retries deliveries, and messages and receipts are both idempotent.
   */
  async handleMeta(payload: MetaWebhook): Promise<{ messages: number; statuses: number }> {
    const counts = { messages: 0, statuses: 0 };
    if (!this.official || payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return counts;
    for (const entry of payload.entry) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        const value = change?.value ?? {};
        if (change?.field === 'message_template_status_update') {
          this.official.applyTemplateStatus(String(entry.id ?? ''), value as TemplateStatusEvent);
          continue;
        }
        if (change?.field !== 'messages') continue;
        const number = this.official.byPhoneNumberId(String(value.metadata?.phone_number_id ?? ''));
        if (!number) continue;
        this.official.markWebhookSeen(number.id);
        const names = new Map((value.contacts ?? []).map(c => [String(c.wa_id ?? ''), c.profile?.name]));

        for (const message of Array.isArray(value.messages) ? value.messages : []) {
          // Customers who hide their number behind a username can't be matched to a contact yet.
          if (typeof message?.from !== 'string' || !/^\d{6,20}$/.test(message.from)) continue;
          if (['reaction', 'system', 'unsupported', 'errors', 'ephemeral'].includes(message.type)) continue;
          const body = metaText(message);
          const isText = ['text', 'button', 'interactive'].includes(message.type);
          await this.handleMessage(
            number.id,
            {
              id: typeof message.id === 'string' ? message.id : undefined,
              from: `${message.from}@c.us`,
              body,
              type: isText ? 'text' : String(message.type ?? 'text'),
              timestamp: Number(message.timestamp) || 0,
              kind: 'individual',
              contact: { pushName: names.get(message.from) ?? undefined },
            },
            { optOut: message.type === 'button' && STOP_PROMOTIONS.test(body.trim()) },
          );
          counts.messages++;
        }

        for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
          if (typeof status?.id !== 'string') continue;
          const problem = status.errors?.[0];
          const error = problem
            ? `${metaErrorText(problem.code, problem.error_data?.details ?? problem.message ?? problem.title ?? '')}${problem.code ? ` (Meta error ${problem.code})` : ''}`
            : undefined;
          this.messages.applyAck(number.id, status.id, status.status, error);
          if (status.status === 'failed' && problem?.code === MARKETING_STOPPED && status.recipient_id) {
            const contact = this.contacts.findByPhone(status.recipient_id.replace(/\D/g, ''));
            if (contact && this.contacts.setConsent(contact.id, 'opted_out', 'whatsapp')) {
              this.campaigns.attributeOptOut(contact.id, nowIso(this.core.clock()));
            }
          }
          counts.statuses++;
        }
      }
    }
    return counts;
  }

  private async handleMessage(sessionId: string, message: IncomingMessage, options: { optOut?: boolean } = {}): Promise<InboundOutcome> {
    if (message.fromMe) return 'ignored';
    const kind = message.kind ?? (message.isGroup ? 'group' : 'individual');
    if (kind !== 'individual') return 'ignored';
    const copy = copyOf(message);
    if (!copy) return 'ignored';

    const phone = await this.resolvePhone(sessionId, message);
    if (!phone) {
      this.core.log.warn(`Inbound message from ${message.from ?? 'unknown'} ignored: sender has no resolvable phone number`);
      return 'unresolved_sender';
    }
    const now = this.core.clock();
    // WhatsApp timestamps are epoch seconds; never trust one from the future.
    const sentAt = typeof message.timestamp === 'number' && message.timestamp > 0 ? new Date(Math.min(message.timestamp * 1000, now.getTime())) : now;
    const at = nowIso(sentAt);
    const chatId = phoneFromChatId(message.from) ? message.from! : chatIdFor(phone);
    const pushName = message.contact?.pushName || message.contact?.name || null;
    // Everyone who writes in reaches the Inbox. Only the business adds contacts, unless it chose to
    // save everyone who writes in; until then a new person is kept for the Inbox only.
    const save = this.settings.get().saveUnknownSenders;

    return this.core.db.tx(() => {
      const { row: contact } = this.contacts.touchInbound(phone, chatId, pushName, at, save);
      // Keywords and auto-replies read what the person wrote (a caption for photos); not map links.
      const body = copy.type === 'location' ? '' : (copy.body ?? '');
      const inserted = this.messages.recordInbound({
        contactId: contact.id,
        sessionId,
        chatId,
        waMessageId: message.id ?? null,
        body: copy.body,
        type: copy.type,
        at,
        mediaMime: copy.mediaMime,
        mediaName: copy.mediaName,
        mediaSize: copy.mediaSize,
      });
      if (!inserted) return 'duplicate_message' as const;

      const settings = this.settings.get();
      const keyword = normalizeKeywordText(body);
      if (options.optOut || (keyword && settings.compliance.optOutKeywords.some(k => normalizeKeywordText(k) === keyword))) {
        const changed = this.contacts.setConsent(contact.id, 'opted_out', 'keyword');
        this.campaigns.attributeOptOut(contact.id, at);
        if (changed && settings.compliance.optOutReply.trim()) {
          this.outbox.enqueue({ sessionId, contactId: contact.id, chatId, body: settings.compliance.optOutReply, sourceType: 'system', delayMs: 1000 });
        }
        return 'opted_out' as const;
      }
      if (keyword && settings.compliance.optInKeywords.some(k => normalizeKeywordText(k) === keyword)) {
        // Asking for your messages ("JOIN", "START") makes someone a contact.
        if (!contact.saved) this.contacts.addToContacts(contact.id, 'opt-in');
        const changed = this.contacts.setConsent(contact.id, 'opted_in', 'keyword');
        if (changed && settings.compliance.optInReply.trim()) {
          this.outbox.enqueue({ sessionId, contactId: contact.id, chatId, body: settings.compliance.optInReply, sourceType: 'system', delayMs: 1000 });
        }
        return 'opted_in' as const;
      }

      this.campaigns.attributeReply(contact.id, at);
      this.bus.emit('contact.replied', { contactId: contact.id, at });

      // Keyword rules answer anyone; a catch-all reply only goes to saved contacts, so friends and
      // family writing to a connected personal number don't get business auto-replies.
      const rule = this.autoReplies.findMatch(body, sessionId, contact.id, { catchAll: contact.saved !== 0 });
      if (rule) {
        this.autoReplies.apply(rule, this.contacts.row(contact.id), sessionId, chatId);
        return 'auto_reply' as const;
      }
      return contact.saved ? ('received' as const) : ('inbox_only' as const);
    });
  }

  pruneReceipts(): number {
    const cutoff = nowIso(new Date(this.core.clock().getTime() - 7 * 86_400_000));
    return this.core.db.run('DELETE FROM webhook_receipts WHERE received_at < ?', cutoff).changes;
  }
}

/**
 * The phone number behind a WhatsApp chat id. Privacy ids (@lid) hide it, so the gateway's
 * best-effort mapping is asked; null when the number can't be known.
 */
export async function resolveChatPhone(core: Core, sessionId: string, chatId: string | undefined, senderPhone: string | null | undefined): Promise<string | null> {
  const direct = phoneFromChatId(chatId);
  if (direct) return direct;
  if (typeof senderPhone === 'string' && /^\d{6,20}$/.test(senderPhone)) return senderPhone;
  if (chatId?.endsWith('@lid')) {
    try {
      const resolved = await core.openwa.resolvePhone(sessionId, chatId);
      if (resolved.phone && /^\d{6,20}$/.test(resolved.phone)) return resolved.phone;
    } catch (error) {
      core.log.warn(`Could not resolve ${chatId} to a phone number: ${String(error)}`);
    }
  }
  return null;
}
