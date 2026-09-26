import { z } from 'zod';
import type { Core } from '../context.js';
import { nowIso, parseJson } from '../db/database.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { randomToken, safeEqual } from '../lib/crypto.js';
import { SecretBox } from '../lib/secret-box.js';
import { chatIdFor, phoneFromChatId } from '../lib/phone.js';
import { MetaError, type MetaTemplate, type MetaTemplateComponent } from '../meta/client.js';
import { buildTemplateComponents, describeTemplate, type TemplateShape } from '../meta/templates.js';
import type { OpenWASession } from '../openwa/client.js';
import type { MediaService } from './media.js';
import type { OutgoingContent, SentMessage } from './sender.js';

/**
 * WhatsApp numbers a business connects through Meta's official Cloud API, with its own Meta app.
 *
 * Each number is exposed to the rest of the app as a "session" whose id starts with "official-",
 * so campaigns, drips, auto-replies and the inbox work the same as with QR-linked numbers. The
 * differences WhatsApp imposes are enforced here:
 *   - conversations can only be started with a Meta-approved template (campaigns pick one);
 *   - free-form text and media only go out within 24 hours of the customer's last message.
 *
 * Access tokens and app secrets are encrypted at rest and never returned to the browser.
 */

export const OFFICIAL_PREFIX = 'official-';
const WINDOW_MS = 24 * 3_600_000;
/** Stop free-form sends a few minutes early so a message sent at 23:59 isn't refused by Meta. */
const WINDOW_MARGIN_MS = 5 * 60_000;
/** Meta keeps uploaded media for 30 days. */
const MEDIA_REUSE_MS = 25 * 86_400_000;
const VERIFY_TOKEN_KEY = 'meta_verify_token';
const VERIFIED_AT_KEY = 'meta_webhook_verified_at';

export const WINDOW_CLOSED_MESSAGE =
  "The 24-hour reply window is closed: this customer hasn't messaged your official number in the last 24 hours. WhatsApp only allows Meta-approved templates now, so send a campaign with a template, or wait for them to message you.";

/** Formats the Cloud API accepts (it takes JPEG/PNG images only, and no CSV or ZIP files). */
const META_MEDIA: Record<string, 'image' | 'video' | 'audio' | 'document'> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'video/mp4': 'video',
  'video/3gpp': 'video',
  'audio/mpeg': 'audio',
  'audio/ogg': 'audio',
  'audio/aac': 'audio',
  'audio/mp4': 'audio',
  'application/pdf': 'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.ms-excel': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.ms-powerpoint': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
  'text/plain': 'document',
};

const metaId = (label: string) => z.string().trim().regex(/^\d{5,25}$/, `${label} is a long number (digits only)`);
const accessToken = z
  .string()
  .trim()
  .min(40, 'That access token looks too short. Copy the whole token')
  .max(2048)
  .regex(/^[A-Za-z0-9_\-.|]+$/, 'Paste the access token exactly, without spaces or quotes');
const appSecret = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{16,128}$/, 'The app secret is a 32-character code from App settings → Basic in your Meta app');
const displayName = z.string().trim().min(2, 'Give the number a short name').max(40);

export const officialInputSchema = z.object({
  name: displayName,
  phoneNumberId: metaId('Phone number ID'),
  wabaId: metaId('WhatsApp Business Account ID'),
  accessToken,
  appSecret,
});

export const officialUpdateSchema = z
  .object({ name: displayName.optional(), accessToken: accessToken.optional(), appSecret: appSecret.optional() })
  .refine(v => v.name !== undefined || v.accessToken !== undefined || v.appSecret !== undefined, 'Nothing to update');

export const templateChoiceSchema = z.object({
  name: z.string().trim().min(1).max(512),
  language: z.string().trim().min(2).max(15),
  /** Slot key → text with {{variables}}, e.g. { "body:1": "{{first_name|there}}" }. */
  params: z.record(z.string().max(80), z.string().max(1000)).default({}),
  headerMediaId: z.coerce.number().int().positive().nullish(),
});
export type TemplateChoice = z.infer<typeof templateChoiceSchema>;

interface OfficialRow {
  id: string;
  name: string;
  phone_number_id: string;
  waba_id: string;
  display_phone: string | null;
  verified_name: string | null;
  quality_rating: string | null;
  access_token: string;
  app_secret: string;
  status: 'ready' | 'failed';
  last_error: string | null;
  webhook_seen_at: string | null;
  checked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TemplateRow {
  id: number;
  waba_id: string;
  meta_id: string | null;
  name: string;
  language: string;
  status: string;
  category: string | null;
  components: string;
  synced_at: string;
}

export interface OfficialInfo {
  phoneNumberId: string;
  wabaId: string;
  qualityRating: string | null;
  webhookSeenAt: string | null;
  checkedAt: string | null;
}

export type OfficialSession = OpenWASession & { channel: 'official'; official: OfficialInfo };

export interface OfficialTemplate extends TemplateShape {
  name: string;
  language: string;
  status: string;
  category: string | null;
}

function digitsOnly(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits || null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class OfficialNumbersService {
  private readonly box: SecretBox;

  constructor(
    private readonly core: Core,
    private readonly media: MediaService,
  ) {
    this.box = new SecretBox(core.config.appSecret);
  }

  private now(): string {
    return nowIso(this.core.clock());
  }

  // ---------------------------------------------------------------- lookup

  isOfficial(id: string | null | undefined): boolean {
    return !!id && id.startsWith(OFFICIAL_PREFIX) && !!this.core.db.get('SELECT 1 FROM official_numbers WHERE id = ?', id);
  }

  private row(id: string): OfficialRow {
    const row = id.startsWith(OFFICIAL_PREFIX) ? this.core.db.get<OfficialRow>('SELECT * FROM official_numbers WHERE id = ?', id) : undefined;
    if (!row) throw notFound('Official WhatsApp number');
    return row;
  }

  byPhoneNumberId(phoneNumberId: string): OfficialRow | undefined {
    return this.core.db.get<OfficialRow>('SELECT * FROM official_numbers WHERE phone_number_id = ?', phoneNumberId);
  }

  count(): number {
    return this.core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM official_numbers')?.n ?? 0;
  }

  private toSession(row: OfficialRow): OfficialSession {
    return {
      id: row.id,
      name: row.name,
      status: row.status === 'ready' ? 'ready' : 'failed',
      phone: digitsOnly(row.display_phone),
      pushName: row.verified_name,
      connectedAt: row.created_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      channel: 'official',
      official: {
        phoneNumberId: row.phone_number_id,
        wabaId: row.waba_id,
        qualityRating: row.quality_rating,
        webhookSeenAt: row.webhook_seen_at,
        checkedAt: row.checked_at,
      },
    };
  }

  sessions(): OfficialSession[] {
    return this.core.db.all<OfficialRow>('SELECT * FROM official_numbers ORDER BY created_at, id').map(r => this.toSession(r));
  }

  session(id: string): OfficialSession {
    return this.toSession(this.row(id));
  }

  templateCounts(): Map<string, { approved: number; total: number }> {
    const counts = new Map<string, { approved: number; total: number }>();
    for (const r of this.core.db.all<{ waba_id: string; approved: number; total: number }>(
      "SELECT waba_id, SUM(status = 'APPROVED') AS approved, COUNT(*) AS total FROM official_templates GROUP BY waba_id",
    )) {
      counts.set(r.waba_id, { approved: Number(r.approved), total: Number(r.total) });
    }
    return counts;
  }

  // ---------------------------------------------------------------- credentials

  private token(row: OfficialRow): string {
    try {
      return this.box.open(row.access_token, `${row.id}:token`);
    } catch {
      this.markFailed(row.id, "The saved access token can't be read (the server's secret key changed). Update the access token and app secret.");
      throw new MetaError(401, 'The saved access token for this number cannot be read. Update it on the WhatsApp numbers page.', 190);
    }
  }

  /** App secrets of every connected number, used to check Meta's webhook signatures. */
  appSecrets(): string[] {
    const secrets = new Set<string>();
    for (const row of this.core.db.all<OfficialRow>('SELECT id, app_secret FROM official_numbers')) {
      try {
        secrets.add(this.box.open(row.app_secret, `${row.id}:secret`));
      } catch {
        // Unreadable after an APP_SECRET change; the number shows an error until it is updated.
      }
    }
    return [...secrets];
  }

  private markFailed(id: string, error: string): void {
    this.core.db.run("UPDATE official_numbers SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", error.slice(0, 500), this.now(), id);
  }

  /** Account-level failures (bad token, payment problem) take the number offline until fixed. */
  private async guard<T>(row: OfficialRow, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof MetaError && error.kind === 'auth') this.markFailed(row.id, error.message);
      throw error;
    }
  }

  private async verify(token: string, phoneNumberId: string, wabaId: string) {
    let info;
    try {
      info = await this.core.meta.phoneNumber(token, phoneNumberId);
    } catch (error) {
      throw badRequest(`Meta did not accept this Phone number ID with this access token: ${messageOf(error)}`);
    }
    try {
      // Subscribing our app to the account is what makes Meta send its webhooks (replies, receipts).
      await this.core.meta.subscribeApp(token, wabaId);
    } catch (error) {
      throw badRequest(
        `The number was found, but the WhatsApp Business Account ID was not accepted: ${messageOf(error)}. Check the ID, and that the token has the whatsapp_business_management permission.`,
      );
    }
    return info;
  }

  // ---------------------------------------------------------------- lifecycle

  async add(input: unknown): Promise<OfficialSession> {
    const data = officialInputSchema.parse(input);
    const id = `${OFFICIAL_PREFIX}${data.phoneNumberId}`;
    if (this.byPhoneNumberId(data.phoneNumberId)) throw conflict('This number is already connected');
    const info = await this.verify(data.accessToken, data.phoneNumberId, data.wabaId);
    const now = this.now();
    this.core.db.run(
      `INSERT INTO official_numbers (id, name, phone_number_id, waba_id, display_phone, verified_name, quality_rating, access_token, app_secret,
                                     status, checked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
      id,
      data.name,
      data.phoneNumberId,
      data.wabaId,
      info.display_phone_number ?? null,
      info.verified_name ?? null,
      info.quality_rating ?? null,
      this.box.seal(data.accessToken, `${id}:token`),
      this.box.seal(data.appSecret, `${id}:secret`),
      now,
      now,
      now,
    );
    try {
      await this.syncTemplates(id);
    } catch (error) {
      this.core.db.run('UPDATE official_numbers SET last_error = ? WHERE id = ?', `Connected, but templates could not be loaded: ${messageOf(error)}`.slice(0, 500), id);
    }
    this.core.log.info(`Official WhatsApp number ${id} connected`);
    return this.session(id);
  }

  async update(id: string, input: unknown): Promise<OfficialSession> {
    const row = this.row(id);
    const data = officialUpdateSchema.parse(input);
    const now = this.now();
    if (data.accessToken) {
      const info = await this.verify(data.accessToken, row.phone_number_id, row.waba_id);
      this.core.db.run(
        `UPDATE official_numbers SET access_token = ?, display_phone = ?, verified_name = ?, quality_rating = ?, status = 'ready', last_error = NULL,
                checked_at = ?, updated_at = ? WHERE id = ?`,
        this.box.seal(data.accessToken, `${id}:token`),
        info.display_phone_number ?? row.display_phone,
        info.verified_name ?? row.verified_name,
        info.quality_rating ?? row.quality_rating,
        now,
        now,
        id,
      );
    }
    if (data.appSecret) this.core.db.run('UPDATE official_numbers SET app_secret = ?, updated_at = ? WHERE id = ?', this.box.seal(data.appSecret, `${id}:secret`), now, id);
    if (data.name) this.core.db.run('UPDATE official_numbers SET name = ?, updated_at = ? WHERE id = ?', data.name, now, id);
    return this.session(id);
  }

  /** Re-check the token and number with Meta; also clears a failure once the business fixed it. */
  async check(id: string): Promise<OfficialSession> {
    const row = this.row(id);
    const now = this.now();
    try {
      const info = await this.verify(this.token(row), row.phone_number_id, row.waba_id);
      this.core.db.run(
        `UPDATE official_numbers SET display_phone = ?, verified_name = ?, quality_rating = ?, status = 'ready', last_error = NULL, checked_at = ?, updated_at = ?
          WHERE id = ?`,
        info.display_phone_number ?? row.display_phone,
        info.verified_name ?? row.verified_name,
        info.quality_rating ?? row.quality_rating,
        now,
        now,
        id,
      );
    } catch (error) {
      this.markFailed(id, messageOf(error));
      this.core.db.run('UPDATE official_numbers SET checked_at = ? WHERE id = ?', now, id);
    }
    return this.session(id);
  }

  remove(id: string): void {
    const row = this.row(id);
    this.core.db.tx(() => {
      this.core.db.run('DELETE FROM official_numbers WHERE id = ?', id);
      if (!this.core.db.get('SELECT 1 FROM official_numbers WHERE waba_id = ?', row.waba_id)) {
        this.core.db.run('DELETE FROM official_templates WHERE waba_id = ?', row.waba_id);
      }
    });
  }

  // ---------------------------------------------------------------- webhook setup

  verifyToken(): string {
    const stored = this.core.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', VERIFY_TOKEN_KEY)?.value;
    if (stored) return stored;
    const token = randomToken(32);
    this.core.db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', VERIFY_TOKEN_KEY, token);
    return this.core.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', VERIFY_TOKEN_KEY)!.value;
  }

  /** Meta's subscription handshake: echo the challenge only when the verify token matches. */
  acceptVerification(mode: unknown, token: unknown): boolean {
    if (mode !== 'subscribe' || typeof token !== 'string' || !safeEqual(token, this.verifyToken())) return false;
    this.core.db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      VERIFIED_AT_KEY,
      this.now(),
    );
    return true;
  }

  setup(): { webhookUrl: string | null; verifyToken: string; webhookVerifiedAt: string | null } {
    return {
      webhookUrl: this.core.config.metaWebhookUrl,
      verifyToken: this.verifyToken(),
      webhookVerifiedAt: this.core.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', VERIFIED_AT_KEY)?.value ?? null,
    };
  }

  markWebhookSeen(id: string): void {
    this.core.db.run('UPDATE official_numbers SET webhook_seen_at = ? WHERE id = ?', this.now(), id);
  }

  // ---------------------------------------------------------------- templates

  async syncTemplates(id: string): Promise<OfficialTemplate[]> {
    const row = this.row(id);
    const templates: MetaTemplate[] = await this.guard(row, async () => this.core.meta.templates(this.token(row), row.waba_id));
    const now = this.now();
    this.core.db.tx(() => {
      for (const t of templates) {
        if (!t?.name || !t.language) continue;
        this.core.db.run(
          `INSERT INTO official_templates (waba_id, meta_id, name, language, status, category, components, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (waba_id, name, language) DO UPDATE SET meta_id = excluded.meta_id, status = excluded.status,
             category = excluded.category, components = excluded.components, synced_at = excluded.synced_at`,
          row.waba_id,
          t.id ?? null,
          t.name,
          t.language,
          (t.status ?? 'UNKNOWN').toUpperCase(),
          t.category ?? null,
          JSON.stringify(t.components ?? []),
          now,
        );
      }
      // Anything Meta no longer lists was deleted there.
      this.core.db.run('DELETE FROM official_templates WHERE waba_id = ? AND synced_at <> ?', row.waba_id, now);
    });
    return this.templates(id);
  }

  private toTemplate(row: TemplateRow): OfficialTemplate {
    return {
      name: row.name,
      language: row.language,
      status: row.status,
      category: row.category,
      ...describeTemplate(parseJson<MetaTemplateComponent[]>(row.components, []), row.category),
    };
  }

  templates(id: string): OfficialTemplate[] {
    const row = this.row(id);
    return this.core.db
      .all<TemplateRow>(
        "SELECT * FROM official_templates WHERE waba_id = ? ORDER BY status = 'APPROVED' DESC, name COLLATE NOCASE, language",
        row.waba_id,
      )
      .map(t => this.toTemplate(t));
  }

  applyTemplateStatus(wabaId: string, name: unknown, language: unknown, status: unknown): void {
    if (typeof name !== 'string' || typeof language !== 'string' || typeof status !== 'string') return;
    this.core.db.run(
      'UPDATE official_templates SET status = ? WHERE waba_id = ? AND name = ? AND language = ?',
      status.toUpperCase().slice(0, 40),
      wabaId,
      name,
      language,
    );
  }

  private templateRow(row: OfficialRow, choice: Pick<TemplateChoice, 'name' | 'language'>): TemplateRow | undefined {
    return this.core.db.get<TemplateRow>(
      'SELECT * FROM official_templates WHERE waba_id = ? AND name = ? AND language = ?',
      row.waba_id,
      choice.name,
      choice.language,
    );
  }

  /** Why a template choice can't be sent from this number, or null when it can. */
  choiceProblem(id: string, choice: TemplateChoice): string | null {
    const row = this.row(id);
    const template = this.templateRow(row, choice);
    if (!template) return `Template “${choice.name}” (${choice.language}) was not found. Sync templates on the WhatsApp numbers page.`;
    if (template.status !== 'APPROVED') return `Template “${choice.name}” is ${template.status.toLowerCase().replace(/_/g, ' ')} in Meta, not approved yet`;
    const shape = this.toTemplate(template);
    if (!shape.supported) return shape.reason;
    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(shape.headerFormat) && !choice.headerMediaId) {
      return `Template “${choice.name}” needs a header ${shape.headerFormat.toLowerCase()}. Choose one.`;
    }
    const empty = shape.slots.find(slot => !(choice.params[slot.key] ?? '').trim());
    if (empty) return `Fill in ${empty.label} for template “${choice.name}”`;
    return null;
  }

  // ---------------------------------------------------------------- sending

  private recipient(chatId: string): string {
    const phone = phoneFromChatId(chatId);
    if (!phone) throw new MetaError(400, 'This contact has no phone number that WhatsApp can message');
    return phone;
  }

  /** When the customer service window with this chat closes, or null when it is closed. */
  windowOpenUntil(id: string, chatId: string): string | null {
    const phone = phoneFromChatId(chatId);
    if (!phone) return null;
    const last = this.core.db.get<{ at: string | null }>(
      "SELECT MAX(created_at) AS at FROM messages WHERE session_id = ? AND chat_id = ? AND direction = 'in'",
      id,
      chatIdFor(phone),
    )?.at;
    if (!last) return null;
    const closes = new Date(last).getTime() + WINDOW_MS;
    return closes - WINDOW_MARGIN_MS > this.core.clock().getTime() ? nowIso(new Date(closes)) : null;
  }

  private async upload(row: OfficialRow, token: string, mediaId: number): Promise<{ id: string; kind: 'image' | 'video' | 'audio' | 'document'; filename: string }> {
    const media = this.media.get(mediaId);
    const kind = META_MEDIA[media.mimetype];
    if (!kind) {
      throw new MetaError(400, `The official WhatsApp API doesn't accept ${media.filename}. Use a JPG or PNG image, MP4 video, MP3/OGG/AAC audio, or a PDF/Office document.`);
    }
    const cached = this.core.db.get<{ meta_media_id: string; uploaded_at: string }>(
      'SELECT meta_media_id, uploaded_at FROM official_media WHERE number_id = ? AND media_id = ?',
      row.id,
      mediaId,
    );
    if (cached && this.core.clock().getTime() - new Date(cached.uploaded_at).getTime() < MEDIA_REUSE_MS) {
      return { id: cached.meta_media_id, kind, filename: media.filename };
    }
    const { data } = await this.media.read(mediaId);
    const uploaded = await this.core.meta.uploadMedia(token, row.phone_number_id, { data, mimetype: media.mimetype, filename: media.filename });
    this.core.db.run(
      `INSERT INTO official_media (number_id, media_id, meta_media_id, uploaded_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (number_id, media_id) DO UPDATE SET meta_media_id = excluded.meta_media_id, uploaded_at = excluded.uploaded_at`,
      row.id,
      mediaId,
      uploaded,
      this.now(),
    );
    return { id: uploaded, kind, filename: media.filename };
  }

  /** Free-form text or media: only inside the 24-hour customer service window. */
  async send(id: string, chatId: string, content: OutgoingContent): Promise<SentMessage> {
    const row = this.row(id);
    const to = this.recipient(chatId);
    if (!this.windowOpenUntil(id, chatId)) throw new MetaError(400, WINDOW_CLOSED_MESSAGE, 131047);
    const text = content.text.trim();
    if (text.length > 4096) throw new MetaError(400, `Message is ${text.length} characters after personalization; WhatsApp allows 4096`);
    if (!content.mediaId && !text) throw new MetaError(400, 'Message has no text and no media');
    const token = this.token(row);
    return this.guard(row, async () => {
      const sendText = (body: string) =>
        this.core.meta.send(token, row.phone_number_id, { to, type: 'text', text: { body, preview_url: /https?:\/\//i.test(body) } });
      if (!content.mediaId) return { messageId: (await sendText(text)).messageId, type: 'text' };

      const media = await this.upload(row, token, content.mediaId);
      const captionFits = media.kind !== 'audio' && text.length <= 1024;
      const payload: Record<string, string> = { id: media.id };
      if (captionFits && text) payload.caption = text;
      if (media.kind === 'document') payload.filename = media.filename;
      const result = await this.core.meta.send(token, row.phone_number_id, { to, type: media.kind, [media.kind]: payload });
      const sent: SentMessage = { messageId: result.messageId, type: media.kind };
      if (!captionFits && text) {
        // The media already went out; a failure here must not make the caller retry (and resend) it.
        try {
          sent.followUp = { messageId: (await sendText(text)).messageId, text };
        } catch (error) {
          this.core.log.warn(`Follow-up text after media failed for ${to}: ${messageOf(error)}`);
        }
      }
      return sent;
    });
  }

  /**
   * An approved template, which may start a conversation at any time. `value(slotKey)` returns the
   * personalized text for each of the template's variables.
   */
  async sendTemplate(id: string, chatId: string, choice: TemplateChoice, value: (key: string) => string): Promise<SentMessage & { text: string }> {
    const row = this.row(id);
    const to = this.recipient(chatId);
    const problem = this.choiceProblem(id, choice);
    // 132001 marks it as a template problem, so a campaign pauses instead of failing every recipient.
    if (problem) throw new MetaError(400, problem, 132001);
    const template = this.toTemplate(this.templateRow(row, choice)!);
    const token = this.token(row);
    return this.guard(row, async () => {
      let headerMedia: { kind: 'image' | 'video' | 'document'; id: string; filename?: string } | null = null;
      if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(template.headerFormat)) {
        const uploaded = await this.upload(row, token, choice.headerMediaId!);
        if (uploaded.kind !== template.headerFormat.toLowerCase()) {
          throw new MetaError(400, `Template “${choice.name}” needs a header ${template.headerFormat.toLowerCase()}, but the chosen file is ${uploaded.kind === 'image' ? 'an' : 'a'} ${uploaded.kind}`, 132001);
        }
        headerMedia = { kind: uploaded.kind as 'image' | 'video' | 'document', id: uploaded.id, filename: uploaded.filename };
      }
      const built = buildTemplateComponents(template, value, headerMedia);
      const result = await this.core.meta.send(token, row.phone_number_id, {
        to,
        type: 'template',
        template: { name: template.name, language: { code: template.language }, ...(built.components.length ? { components: built.components } : {}) },
      });
      return { messageId: result.messageId, type: 'template', text: built.text };
    });
  }
}
