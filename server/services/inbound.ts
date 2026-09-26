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
import type { OfficialNumbersService } from './official.js';
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

interface IncomingMessage {
  id?: string;
  from?: string;
  body?: string;
  type?: string;
  timestamp?: number;
  isGroup?: boolean;
  kind?: string;
  fromMe?: boolean;
  senderPhone?: string | null;
  contact?: { name?: string; pushName?: string };
}

export type InboundOutcome =
  | 'duplicate'
  | 'ignored'
  | 'ack'
  | 'session_status'
  | 'unresolved_sender'
  | 'duplicate_message'
  | 'opted_out'
  | 'opted_in'
  | 'auto_reply'
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
      default:
        return 'ignored';
    }
  }

  private async resolvePhone(sessionId: string, message: IncomingMessage): Promise<string | null> {
    const direct = phoneFromChatId(message.from);
    if (direct) return direct;
    if (typeof message.senderPhone === 'string' && /^\d{6,20}$/.test(message.senderPhone)) return message.senderPhone;
    if (message.from?.endsWith('@lid')) {
      // WhatsApp privacy ids hide the number; ask the gateway for its best-effort mapping.
      try {
        const resolved = await this.core.openwa.resolvePhone(sessionId, message.from);
        if (resolved.phone && /^\d{6,20}$/.test(resolved.phone)) return resolved.phone;
      } catch (error) {
        this.core.log.warn(`Could not resolve ${message.from} to a phone number: ${String(error)}`);
      }
    }
    return null;
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
          this.official.applyTemplateStatus(String(entry.id ?? ''), value.message_template_name, value.message_template_language, value.event);
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

    return this.core.db.tx(() => {
      const { row: contact } = this.contacts.touchInbound(phone, chatId, pushName, at);
      const body = typeof message.body === 'string' ? message.body : '';
      const inserted = this.messages.recordInbound({
        contactId: contact.id,
        sessionId,
        chatId,
        waMessageId: message.id ?? null,
        body: body || null,
        type: message.type ?? 'text',
        at,
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
        const changed = this.contacts.setConsent(contact.id, 'opted_in', 'keyword');
        if (changed && settings.compliance.optInReply.trim()) {
          this.outbox.enqueue({ sessionId, contactId: contact.id, chatId, body: settings.compliance.optInReply, sourceType: 'system', delayMs: 1000 });
        }
        return 'opted_in' as const;
      }

      this.campaigns.attributeReply(contact.id, at);
      this.bus.emit('contact.replied', { contactId: contact.id, at });

      const rule = this.autoReplies.findMatch(body, sessionId, contact.id);
      if (rule) {
        this.autoReplies.apply(rule, this.contacts.row(contact.id), sessionId, chatId);
        return 'auto_reply' as const;
      }
      return 'received' as const;
    });
  }

  pruneReceipts(): number {
    const cutoff = nowIso(new Date(this.core.clock().getTime() - 7 * 86_400_000));
    return this.core.db.run('DELETE FROM webhook_receipts WHERE received_at < ?', cutoff).changes;
  }
}
