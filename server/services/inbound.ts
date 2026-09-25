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

  private async handleMessage(sessionId: string, message: IncomingMessage): Promise<InboundOutcome> {
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
      if (keyword && settings.compliance.optOutKeywords.some(k => normalizeKeywordText(k) === keyword)) {
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
