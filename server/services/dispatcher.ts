import type { Core } from '../context.js';
import { nowIso } from '../db/database.js';
import { OpenWAError } from '../openwa/client.js';
import { chatIdFor } from '../lib/phone.js';
import { isQuietTime } from '../lib/time.js';
import type { Settings, SettingsService } from './settings.js';
import type { SessionsService } from './sessions.js';
import type { Campaign, CampaignsService, RecipientRow } from './campaigns.js';
import type { SequencesService, EnrollmentRow } from './sequences.js';
import type { MessagesService } from './messages.js';
import type { OutboxService, OutboxRow } from './outbox.js';
import type { ContactsService, ContactRow } from './contacts.js';
import type { Sender, SentMessage } from './sender.js';
import { MetaError } from '../meta/client.js';
import type { InboundService } from './inbound.js';
import type { AutoRepliesService } from './auto-replies.js';

export interface DispatcherDeps {
  settings: SettingsService;
  sessions: SessionsService;
  campaigns: CampaignsService;
  sequences: SequencesService;
  messages: MessagesService;
  outbox: OutboxService;
  contacts: ContactsService;
  sender: Sender;
  inbound: InboundService;
  autoReplies: AutoRepliesService;
}

type SendOutcome = 'sent' | 'failed' | 'skipped' | 'transient' | 'empty';

/** Transient failures (gateway down, number disconnected) tolerated per recipient before giving up. */
export const MAX_SEND_ATTEMPTS = 5;
const TRANSACTIONAL_GAP_MS = 1500;
const VALIDATION_GAP_MS = 2500;
const MAX_SKIPS_PER_TICK = 50;
const BACKOFF_START_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const MAINTENANCE_EVERY_MS = 10 * 60_000;
/** Meta errors that mean the template itself can't be sent, so every recipient would fail the same way. */
const TEMPLATE_PROBLEMS = new Set([132000, 132001, 132007, 132012, 132015, 132016, 131063]);

function asOpenWAError(error: unknown): OpenWAError {
  if (error instanceof OpenWAError) return error;
  return new OpenWAError(400, error instanceof Error ? error.message : String(error));
}

/**
 * The sending engine. One tick per interval; each ready WhatsApp number sends at most one message
 * per tick, chosen by priority:
 *
 *   1. transactional replies (auto-replies, STOP/START confirmations) — immediate
 *   2. due drip-sequence steps
 *   3. running campaigns, round-robin, each at its own pace
 *
 * Every number is capped at settings.sending.sessionMaxPerMinute and dailyCapPerSession, sends are
 * jittered, quiet hours hold marketing traffic, and a campaign that keeps failing pauses itself.
 *
 * Crash safety: a recipient is marked 'sending' before the API call and 'sent' after. On restart
 * anything left in 'sending' becomes 'unknown' and is never retried — a missing message is
 * recoverable, a duplicate marketing blast is not.
 */
export class Dispatcher {
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private readonly sessionNextAt = new Map<string, number>();
  private readonly backoff = new Map<string, { until: number; delayMs: number; reason: string }>();
  private readonly campaignNextAt = new Map<number, number>();
  private readonly consecutiveFailures = new Map<number, number>();
  private readonly rotation = new Map<string, number>();
  private readonly waiting = new Map<number, string | null>();
  private validationNextAt = 0;
  private lastMaintenance = 0;

  constructor(
    private readonly core: Core,
    private readonly deps: DispatcherDeps,
    private readonly random: () => number = Math.random,
  ) {}

  private nowMs(): number {
    return this.core.clock().getTime();
  }

  // ---------------------------------------------------------------- lifecycle

  recover(): { recipients: number; outbox: number; enrollments: number } {
    const db = this.core.db;
    const recipients = db.run(
      "UPDATE campaign_recipients SET status = 'unknown', error = 'Interrupted by a restart while sending; not retried to avoid a duplicate' WHERE status = 'sending'",
    ).changes;
    const outbox = db.run("UPDATE outbox SET status = 'unknown', error = 'Interrupted by a restart while sending' WHERE status = 'sending'").changes;
    const stuck = db.all<EnrollmentRow>("SELECT * FROM sequence_enrollments WHERE status = 'sending'");
    for (const enrollment of stuck) {
      // The step may well have gone out; moving on is safer than sending it twice.
      try {
        this.deps.sequences.advance(enrollment, this.deps.sequences.get(enrollment.sequence_id));
      } catch {
        db.run("UPDATE sequence_enrollments SET status = 'stopped', stop_reason = 'interrupted' WHERE id = ?", enrollment.id);
      }
    }
    if (recipients + outbox + stuck.length > 0) {
      this.core.log.warn(`Recovered after restart: ${recipients} campaign sends, ${outbox} replies, ${stuck.length} drip steps were mid-send`);
    }
    return { recipients, outbox, enrollments: stuck.length };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(error => this.core.log.error(`Dispatcher tick failed: ${String(error)}`));
    }, this.core.config.dispatcherIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking?.catch(() => undefined);
  }

  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** Why a running campaign is not sending right now, for the UI. */
  campaignWaitReason(campaignId: number): string | null {
    return this.waiting.get(campaignId) ?? null;
  }

  sessionBackoff(sessionId: string): { until: string; reason: string } | null {
    const entry = this.backoff.get(sessionId);
    if (!entry || entry.until <= this.nowMs()) return null;
    return { until: nowIso(new Date(entry.until)), reason: entry.reason };
  }

  // ---------------------------------------------------------------- tick

  private async runTick(): Promise<void> {
    const now = this.core.clock();
    this.maintenance(now);
    this.deps.campaigns.promoteScheduled(now);

    const sessions = await this.deps.sessions.list();
    const ready = sessions.filter(s => s.status === 'ready').map(s => s.id);
    // A number linked in OpenWA's own dashboard never went through our "add number" flow, so adopt
    // the first connected one as the default; drip sequences and tests rely on having one.
    if (!this.deps.settings.get().defaultSessionId && ready.length > 0) {
      this.deps.settings.update({ defaultSessionId: ready[0] });
    }
    const reachable = this.deps.sessions.gatewayStatus().reachable;
    for (const sessionId of this.deps.campaigns.runningSessionIds()) {
      if (!ready.includes(sessionId)) {
        const number = sessions.find(s => s.id === sessionId);
        const reason =
          number?.channel === 'official'
            ? `The official WhatsApp number needs attention${number.lastError ? `: ${number.lastError}` : ''}`
            : reachable
              ? 'The WhatsApp number is not connected'
              : 'The OpenWA gateway is unreachable';
        for (const campaign of this.deps.campaigns.runningForSession(sessionId)) this.waiting.set(campaign.id, reason);
      }
    }

    await Promise.all(
      ready.map(sessionId =>
        this.tickSession(sessionId, ready).catch(error => this.core.log.error(`Dispatch for session ${sessionId} failed: ${String(error)}`)),
      ),
    );
    this.deps.campaigns.completeFinished();
  }

  private maintenance(now: Date): void {
    if (now.getTime() - this.lastMaintenance < MAINTENANCE_EVERY_MS) return;
    this.lastMaintenance = now.getTime();
    try {
      this.deps.outbox.expireStale();
      this.deps.inbound.pruneReceipts();
      this.deps.autoReplies.pruneHits();
    } catch (error) {
      this.core.log.warn(`Maintenance failed: ${String(error)}`);
    }
  }

  private async tickSession(sessionId: string, ready: string[]): Promise<void> {
    const t = this.nowMs();
    const settings = this.deps.settings.get();
    const running = this.deps.campaigns.runningForSession(sessionId);

    const hold = this.backoff.get(sessionId);
    if (hold && t < hold.until) {
      for (const campaign of running) this.waiting.set(campaign.id, hold.reason);
      return;
    }
    if (t < (this.sessionNextAt.get(sessionId) ?? 0)) return;

    // 1. Transactional replies.
    const job = this.deps.outbox.nextDue(sessionId);
    if (job) {
      await this.sendOutbox(job);
      this.sessionNextAt.set(sessionId, this.nowMs() + TRANSACTIONAL_GAP_MS);
      return;
    }

    // 2 + 3. Marketing traffic, bounded per number per day.
    const now = this.core.clock();
    const quiet = settings.quietHours.enabled && isQuietTime(now, settings.timezone, settings.quietHours.start, settings.quietHours.end);
    const sentToday = this.deps.messages.marketingSentToday(sessionId, settings.timezone);
    if (sentToday >= settings.sending.dailyCapPerSession) {
      const reason = `Daily limit of ${settings.sending.dailyCapPerSession} messages for this number reached; sending resumes tomorrow`;
      for (const campaign of running) this.waiting.set(campaign.id, reason);
      await this.maybeValidate(sessionId, ready, settings);
      return;
    }

    for (const enrollment of this.deps.sequences.due(sessionId, settings.defaultSessionId, quiet, 10)) {
      const outcome = await this.sendSequenceStep(enrollment, sessionId);
      if (outcome === 'sent' || outcome === 'failed' || outcome === 'transient') {
        if (outcome !== 'transient') this.sessionNextAt.set(sessionId, this.nowMs() + this.sessionGap(settings));
        return;
      }
    }

    if (running.length > 0 && (await this.sendCampaignTurn(sessionId, running, settings, quiet))) return;

    await this.maybeValidate(sessionId, ready, settings);
  }

  private sessionGap(settings: Settings): number {
    return this.jitter(60_000 / settings.sending.sessionMaxPerMinute);
  }

  private jitter(ms: number): number {
    return Math.round(ms * (0.75 + this.random() * 0.5));
  }

  // ---------------------------------------------------------------- campaigns

  /** Give the next campaign in rotation its turn. Returns true when a send was attempted. */
  private async sendCampaignTurn(sessionId: string, running: Campaign[], settings: Settings, quiet: boolean): Promise<boolean> {
    const start = (this.rotation.get(sessionId) ?? 0) % running.length;
    for (let k = 0; k < running.length; k++) {
      const campaign = running[(start + k) % running.length];
      if (campaign.options.respectQuietHours && quiet) {
        this.waiting.set(campaign.id, `Quiet hours (${settings.quietHours.start}–${settings.quietHours.end} ${settings.timezone}); sending resumes at ${settings.quietHours.end}`);
        continue;
      }
      if (this.nowMs() < (this.campaignNextAt.get(campaign.id) ?? 0)) {
        this.waiting.set(campaign.id, null);
        continue;
      }
      const outcome = await this.sendNextRecipient(campaign, sessionId, settings);
      if (outcome === 'empty' || outcome === 'skipped') continue;
      this.rotation.set(sessionId, (start + k + 1) % running.length);
      if (outcome === 'sent' || outcome === 'failed') {
        const t = this.nowMs();
        this.campaignNextAt.set(campaign.id, t + this.jitter(60_000 / campaign.options.perMinute));
        this.sessionNextAt.set(sessionId, t + this.sessionGap(settings));
      }
      return true;
    }
    return false;
  }

  private async sendNextRecipient(campaign: Campaign, sessionId: string, settings: Settings): Promise<SendOutcome> {
    for (let i = 0; i < MAX_SKIPS_PER_TICK; i++) {
      const claimed = this.deps.campaigns.claimNext(campaign.id);
      if (!claimed) {
        if (this.deps.campaigns.hasQueued(campaign.id)) continue;
        return 'empty';
      }
      const { recipient, contact } = claimed;
      const check = await this.checkRecipient(campaign, contact, sessionId, settings);
      if ('skip' in check) {
        this.deps.campaigns.markSkipped(recipient.id, check.skip);
        continue;
      }
      return this.sendToRecipient(campaign, recipient, contact, check.chatId, sessionId, settings);
    }
    return 'skipped';
  }

  private async checkRecipient(
    campaign: Campaign,
    contact: ContactRow,
    sessionId: string,
    settings: Settings,
  ): Promise<{ skip: string } | { chatId: string }> {
    // Consent is re-read at send time: someone who replied STOP after launch is never messaged.
    if (contact.consent === 'opted_out') return { skip: 'opted_out' };
    if (campaign.options.requireOptIn && contact.consent !== 'opted_in') return { skip: 'no_consent' };
    if (contact.wa_status === 'invalid') return { skip: 'not_on_whatsapp' };
    if (settings.sending.frequencyCapHours > 0) {
      const since = nowIso(new Date(this.nowMs() - settings.sending.frequencyCapHours * 3_600_000));
      if (this.deps.messages.receivedMarketingSince(contact.id, since, campaign.id)) return { skip: 'frequency_cap' };
    }
    let chatId = contact.wa_chat_id ?? chatIdFor(contact.phone);
    // Meta has no number lookup; the official API reports undeliverable numbers after sending.
    if (campaign.options.validateNumbers && contact.wa_status === 'unknown' && !this.deps.sender.isOfficial(sessionId)) {
      try {
        const result = await this.core.openwa.checkNumber(sessionId, contact.phone);
        this.deps.contacts.recordValidation(contact.id, result.exists, result.whatsappId);
        if (!result.exists) return { skip: 'not_on_whatsapp' };
        if (result.whatsappId) chatId = result.whatsappId;
      } catch (error) {
        // Validation is best-effort; the send itself will surface a real problem.
        this.core.log.debug(`Number check for ${contact.phone} failed: ${String(error)}`);
      }
    }
    return { chatId };
  }

  private async sendToRecipient(
    campaign: Campaign,
    recipient: RecipientRow,
    contact: ContactRow,
    chatId: string,
    sessionId: string,
    settings: Settings,
  ): Promise<SendOutcome> {
    const variant = this.deps.campaigns.variantFor(campaign, recipient.variant);
    let text = '';
    let mediaId = variant.mediaId ?? null;
    let send: () => Promise<SentMessage & { text?: string }>;
    if (this.deps.sender.isOfficial(sessionId)) {
      const choice = variant.template;
      if (!choice) {
        this.deps.campaigns.requeue(recipient.id, 'Waiting for a Meta-approved template', false);
        this.deps.campaigns.pause(campaign.id, 'Official WhatsApp numbers can only send Meta-approved templates. Edit the campaign, choose a template, then resume.');
        return 'skipped';
      }
      mediaId = choice.headerMediaId ?? null;
      const values = this.deps.campaigns.templateValues(variant, contact);
      send = () => this.deps.sender.sendTemplate(sessionId, chatId, choice, values);
    } else {
      try {
        text = this.deps.campaigns.render(campaign, variant, contact, recipient.token);
      } catch (error) {
        this.deps.campaigns.markFailed(recipient.id, `Could not render message: ${String(error)}`);
        return 'failed';
      }
      send = () => this.deps.sender.send(sessionId, chatId, { text, mediaId: variant.mediaId });
    }
    try {
      const sent = await send();
      if (sent.text) text = sent.text;
      this.core.db.tx(() => {
        this.deps.campaigns.markSent(recipient.id, sent.messageId);
        this.deps.messages.recordOutbound({
          contactId: contact.id,
          sessionId,
          chatId,
          waMessageId: sent.messageId,
          body: sent.followUp ? null : text,
          mediaId,
          type: sent.type,
          sourceType: 'campaign',
          sourceId: campaign.id,
          recipientId: recipient.id,
        });
        if (sent.followUp) {
          this.deps.messages.recordOutbound({
            contactId: contact.id,
            sessionId,
            chatId,
            waMessageId: sent.followUp.messageId,
            body: sent.followUp.text,
            sourceType: 'campaign',
            sourceId: campaign.id,
          });
        }
      });
      this.consecutiveFailures.set(campaign.id, 0);
      this.waiting.set(campaign.id, null);
      this.backoff.delete(sessionId);
      return 'sent';
    } catch (raw) {
      const error = asOpenWAError(raw);
      if (error instanceof MetaError && error.kind === 'rejected' && error.metaCode !== undefined && TEMPLATE_PROBLEMS.has(error.metaCode)) {
        // Fix the template once, not a failure per recipient: keep this one queued and pause.
        this.deps.campaigns.requeue(recipient.id, error.message, false);
        this.deps.campaigns.pause(campaign.id, `Paused: ${error.message}`);
        return 'skipped';
      }
      if (error.kind === 'rejected') {
        this.deps.campaigns.markFailed(recipient.id, error.message);
        const failures = (this.consecutiveFailures.get(campaign.id) ?? 0) + 1;
        this.consecutiveFailures.set(campaign.id, failures);
        if (failures >= settings.sending.breakerThreshold) {
          this.consecutiveFailures.set(campaign.id, 0);
          this.deps.campaigns.pause(
            campaign.id,
            `Paused automatically after ${failures} failed sends in a row. Last error: ${error.message}`,
          );
          this.core.log.warn(`Campaign ${campaign.id} paused by the failure breaker`);
        }
        return 'failed';
      }
      this.handleTransient(sessionId, error, recipient.attempts, {
        requeue: countAttempt => this.deps.campaigns.requeue(recipient.id, error.message, countAttempt),
        giveUp: () => this.deps.campaigns.markFailed(recipient.id, `Gave up after ${recipient.attempts} attempts: ${error.message}`),
      });
      const hold = this.backoff.get(sessionId);
      if (hold) this.waiting.set(campaign.id, hold.reason);
      return 'transient';
    }
  }

  /** Requeue after a gateway-side problem and hold the whole number for a while. */
  private handleTransient(
    sessionId: string,
    error: OpenWAError,
    attempts: number,
    actions: { requeue: (countAttempt: boolean) => void; giveUp: () => void },
  ): void {
    if (error.kind === 'rate_limited') {
      actions.requeue(false);
      const retryMs = Math.min(Math.max((error.retryAfterSeconds ?? 60) * 1000, 60_000), 60 * 60_000);
      this.hold(sessionId, retryMs, error instanceof MetaError ? `Meta rate limit: ${error.message}` : `OpenWA send pacing limit reached (${error.message.replace(/^OpenWA 429: /, '')})`);
      return;
    }
    if (attempts >= MAX_SEND_ATTEMPTS) actions.giveUp();
    else actions.requeue(true);
    const previous = this.backoff.get(sessionId)?.delayMs ?? 0;
    const delay = previous ? Math.min(previous * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
    const reason =
      error instanceof MetaError
        ? `Meta: ${error.message}`
        : error.kind === 'auth'
        ? 'OpenWA rejected the API key (check OPENWA_API_KEY)'
        : error.kind === 'network'
          ? 'The OpenWA gateway is unreachable'
          : `WhatsApp number temporarily unavailable (${error.message})`;
    this.hold(sessionId, delay, reason);
    this.deps.sessions.invalidate();
  }

  private hold(sessionId: string, delayMs: number, reason: string): void {
    this.backoff.set(sessionId, { until: this.nowMs() + delayMs, delayMs, reason });
    this.core.log.warn(`Holding sends on ${sessionId} for ${Math.round(delayMs / 1000)}s: ${reason}`);
  }

  // ---------------------------------------------------------------- sequences

  private async sendSequenceStep(enrollment: EnrollmentRow, sessionId: string): Promise<SendOutcome> {
    const sequences = this.deps.sequences;
    if (!sequences.claim(enrollment.id)) return 'skipped';
    let sequence;
    try {
      sequence = sequences.get(enrollment.sequence_id);
    } catch {
      return 'skipped';
    }
    const step = sequence.steps[enrollment.current_step];
    if (!step) {
      sequences.advance({ ...enrollment, current_step: sequence.steps.length - 1 }, sequence);
      return 'skipped';
    }
    const contact = this.core.db.get<ContactRow>('SELECT * FROM contacts WHERE id = ?', enrollment.contact_id);
    if (!contact) return 'skipped';
    if (contact.consent === 'opted_out') {
      sequences.stopEnrollment(enrollment.id, 'opted_out');
      return 'skipped';
    }
    if (sequence.options.requireOptIn && contact.consent !== 'opted_in') {
      sequences.stopEnrollment(enrollment.id, 'no_consent');
      return 'skipped';
    }
    if (contact.wa_status === 'invalid') {
      sequences.stopEnrollment(enrollment.id, 'not_on_whatsapp');
      return 'skipped';
    }
    const chatId = contact.wa_chat_id ?? chatIdFor(contact.phone);
    const text = sequences.render(sequence, step, contact);
    try {
      const sent = await this.deps.sender.send(sessionId, chatId, { text, mediaId: step.mediaId });
      this.core.db.tx(() => {
        this.deps.messages.recordOutbound({
          contactId: contact.id,
          sessionId,
          chatId,
          waMessageId: sent.messageId,
          body: sent.followUp ? null : text,
          mediaId: step.mediaId,
          type: sent.type,
          sourceType: 'sequence',
          sourceId: enrollment.id,
        });
        if (sent.followUp) {
          this.deps.messages.recordOutbound({
            contactId: contact.id,
            sessionId,
            chatId,
            waMessageId: sent.followUp.messageId,
            body: sent.followUp.text,
            sourceType: 'sequence',
            sourceId: enrollment.id,
          });
        }
        sequences.advance(enrollment, sequence);
      });
      this.backoff.delete(sessionId);
      return 'sent';
    } catch (raw) {
      const error = asOpenWAError(raw);
      if (error.kind === 'rejected') {
        sequences.stopEnrollment(enrollment.id, `send_failed: ${error.message}`.slice(0, 300));
        return 'failed';
      }
      this.handleTransient(sessionId, error, 0, {
        requeue: () => sequences.release(enrollment.id),
        giveUp: () => sequences.release(enrollment.id),
      });
      return 'transient';
    }
  }

  // ---------------------------------------------------------------- transactional

  private async sendOutbox(job: OutboxRow): Promise<void> {
    if (!this.deps.outbox.claim(job.id)) return;
    try {
      const sent = await this.deps.sender.send(job.session_id, job.chat_id, { text: job.body, mediaId: job.media_id });
      this.core.db.tx(() => {
        this.deps.outbox.markSent(job.id);
        this.deps.messages.recordOutbound({
          contactId: job.contact_id,
          sessionId: job.session_id,
          chatId: job.chat_id,
          waMessageId: sent.messageId,
          body: sent.followUp ? null : job.body,
          mediaId: job.media_id,
          type: sent.type,
          sourceType: job.source_type,
          sourceId: job.source_id,
        });
        if (sent.followUp) {
          this.deps.messages.recordOutbound({
            contactId: job.contact_id,
            sessionId: job.session_id,
            chatId: job.chat_id,
            waMessageId: sent.followUp.messageId,
            body: sent.followUp.text,
            sourceType: job.source_type,
            sourceId: job.source_id,
          });
        }
      });
      this.backoff.delete(job.session_id);
    } catch (raw) {
      const error = asOpenWAError(raw);
      if (error.kind === 'rejected') {
        this.deps.outbox.markFailed(job.id, error.message);
        return;
      }
      this.handleTransient(job.session_id, error, 0, {
        requeue: () => this.deps.outbox.requeue(job.id, error.message, BACKOFF_START_MS),
        giveUp: () => this.deps.outbox.markFailed(job.id, error.message),
      });
    }
  }

  // ---------------------------------------------------------------- number validation (idle work)

  private async maybeValidate(sessionId: string, ready: string[], settings: Settings): Promise<void> {
    // Number lookups need a QR-linked number; Meta's API has none.
    const linked = ready.filter(id => !this.deps.sender.isOfficial(id));
    const validator = settings.defaultSessionId && linked.includes(settings.defaultSessionId) ? settings.defaultSessionId : linked[0];
    if (sessionId !== validator || this.nowMs() < this.validationNextAt) return;
    const next = this.core.db.get<{ id: number; phone: string }>(
      'SELECT id, phone FROM contacts WHERE wa_check_requested_at IS NOT NULL ORDER BY wa_check_requested_at, id LIMIT 1',
    );
    if (!next) return;
    this.validationNextAt = this.nowMs() + VALIDATION_GAP_MS;
    try {
      const result = await this.core.openwa.checkNumber(sessionId, next.phone);
      this.deps.contacts.recordValidation(next.id, result.exists, result.whatsappId);
    } catch (raw) {
      const error = asOpenWAError(raw);
      if (error.kind === 'rejected') this.deps.contacts.recordValidation(next.id, false, null);
      else this.validationNextAt = this.nowMs() + BACKOFF_START_MS;
    }
  }
}
