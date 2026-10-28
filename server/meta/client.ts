/**
 * Client for Meta's official WhatsApp Business Platform (Cloud API), used by businesses that
 * connect their own Meta app instead of linking a phone by QR code. Every call carries the
 * business's own access token; nothing here is shared between businesses.
 *
 * Reference: developers.facebook.com/documentation/business-messaging/whatsapp
 */
import { OpenWAError, type OpenWAErrorKind } from '../openwa/client.js';

export const META_GRAPH_VERSION = /^v\d{2}\.\d$/.test(process.env.META_GRAPH_VERSION ?? '') ? process.env.META_GRAPH_VERSION! : 'v25.0';
const GRAPH_HOST = 'graph.facebook.com';

export interface MetaPhoneNumber {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
}

export interface MetaTemplateButton {
  type: string;
  text?: string;
  url?: string;
  phone_number?: string;
}

export interface MetaTemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: MetaTemplateButton[];
  /** Carousel templates: 2 to 10 cards, each with its own header, body and buttons. */
  cards?: Array<{ components?: MetaTemplateComponent[] }>;
  /** Limited-time offer templates. */
  limited_time_offer?: { text?: string; has_expiration?: boolean };
  example?: unknown;
}

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  components?: MetaTemplateComponent[];
  rejected_reason?: string;
  quality_score?: { score?: string };
}

/** Friendlier wording for the Cloud API errors businesses actually run into. */
const MESSAGES: Record<number, string> = {
  4: 'Too many requests to Meta right now; sending will retry shortly',
  10: 'The access token is missing a permission. Generate it with whatsapp_business_messaging and whatsapp_business_management',
  100: 'Meta rejected a value in the request',
  190: 'The access token is invalid or has expired. Create a permanent System User token and update it on the WhatsApp numbers page',
  200: 'The access token does not have permission for this WhatsApp account',
  368: 'Meta has temporarily blocked this account for a policy violation',
  80007: 'Meta rate limit reached for this WhatsApp account; sending will retry shortly',
  130429: 'Meta throughput limit reached; sending will retry shortly',
  131000: 'Meta had a temporary problem sending this message',
  131005: 'The access token does not have permission to send messages',
  131008: 'A required value is missing from the message',
  131009: 'A value in the message is not valid',
  131016: 'WhatsApp is temporarily unavailable; sending will retry shortly',
  131021: 'The recipient is the same number as the sender',
  131026: 'Message undeliverable: the number may not be on WhatsApp, or is on an old WhatsApp version',
  131030: 'This number is not in your test recipient list. Add it in your Meta app (WhatsApp → API Setup), or finish adding your own business number',
  131031: 'Your WhatsApp Business Account is locked or restricted. Check WhatsApp Manager',
  131042: 'Payment problem on your WhatsApp Business Account. Add a valid payment method in Meta Business Settings',
  131045: 'The phone number is not registered for the Cloud API yet',
  131047: 'More than 24 hours have passed since the customer last messaged, so only an approved template can be sent',
  131048: 'Meta limited sending from this number because of spam reports; slow down and review your content',
  131049: 'Meta did not deliver this marketing message to keep customer engagement healthy; it may succeed later',
  131050: 'This customer has stopped marketing messages from your business',
  131051: 'This message type is not supported',
  131052: 'Meta could not download the media file',
  131053: 'Meta could not process the media file; check its format and size',
  131056: 'Too many messages to the same customer in a short time; sending will retry shortly',
  131063: 'Marketing templates are switched off for Cloud API on this account',
  132000: 'The number of template variables does not match the approved template',
  132001: 'This template does not exist in that language, or is not approved yet',
  132005: 'The filled-in template text is too long',
  132007: 'The template content breaks WhatsApp policy',
  132012: 'Template variables are in the wrong format',
  132015: 'This template is paused by Meta because of low quality',
  132016: 'This template has been disabled by Meta',
  132018: 'A template variable contains line breaks or too many spaces',
  133010: 'The phone number is not registered on the Cloud API. Finish registering it in your Meta app',
  133016: 'Too many registration attempts; wait and try again',
};

export function metaErrorText(code: number | undefined, fallback: string): string {
  return (code !== undefined && MESSAGES[code]) || fallback || 'Meta rejected the request';
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131048, 131056]);
const ACCOUNT_CODES = new Set([10, 190, 200, 368, 131005, 131031, 131042, 131045, 133010]);
const TEMPORARY_CODES = new Set([1, 2, 131000, 131016]);

/**
 * A Cloud API failure. It extends the gateway error type so the sending engine reacts the same
 * way: rate limits and outages keep the message queued, account problems hold the number, and a
 * refusal of this one message fails only that message.
 */
export class MetaError extends OpenWAError {
  constructor(
    status: number,
    message: string,
    readonly metaCode?: number,
    retryAfterSeconds?: number,
  ) {
    super(status, message, metaCode !== undefined ? String(metaCode) : undefined, retryAfterSeconds);
    this.name = 'MetaError';
  }

  override get kind(): OpenWAErrorKind {
    if (this.status === 0) return 'network';
    const code = this.metaCode;
    if (code !== undefined && RATE_LIMIT_CODES.has(code)) return 'rate_limited';
    if (code !== undefined && ACCOUNT_CODES.has(code)) return 'auth';
    if (code !== undefined && TEMPORARY_CODES.has(code)) return 'unavailable';
    if (this.status === 429) return 'rate_limited';
    if (this.status === 401 || this.status === 403) return 'auth';
    if (this.status >= 500) return 'unavailable';
    return 'rejected';
  }
}

/** The calls the app makes to Meta; tests substitute an in-memory fake. */
export interface MetaApi {
  phoneNumber(token: string, phoneNumberId: string): Promise<MetaPhoneNumber>;
  subscribeApp(token: string, wabaId: string): Promise<void>;
  templates(token: string, wabaId: string): Promise<MetaTemplate[]>;
  send(token: string, phoneNumberId: string, message: Record<string, unknown>): Promise<{ messageId: string }>;
  uploadMedia(token: string, phoneNumberId: string, file: { data: Buffer; mimetype: string; filename: string }): Promise<string>;
  /** Submit a new template for review. */
  createTemplate(token: string, wabaId: string, template: Record<string, unknown>): Promise<{ id: string; status: string; category?: string }>;
  /** Replace an existing template's components (and category, unless approved): it is reviewed again. */
  editTemplate(token: string, templateId: string, changes: Record<string, unknown>): Promise<void>;
  /** Delete one template (by its id) or every language of a name. */
  deleteTemplate(token: string, wabaId: string, name: string, templateId?: string | null): Promise<void>;
  /** The Meta app an access token belongs to (needed to upload template examples). */
  appId(token: string): Promise<string>;
  /** Upload an example image, video or PDF for a template header; returns the handle Meta reviews. */
  uploadSample(token: string, appId: string, file: { data: Buffer; mimetype: string; filename: string }): Promise<string>;
}

const numericId = (value: string, label: string): string => {
  if (!/^\d{5,25}$/.test(value)) throw new MetaError(400, `${label} must be digits only`);
  return value;
};

export class MetaGraphClient implements MetaApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { version?: string; fetchImpl?: typeof fetch } = {}) {
    this.base = `https://${GRAPH_HOST}/${options.version ?? META_GRAPH_VERSION}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(token: string, method: string, url: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    let response: Response;
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new MetaError(0, `Could not reach Meta: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!response.ok) {
      const error =
        (data as { error?: { message?: string; code?: number; error_user_msg?: string; error_user_title?: string; error_data?: { details?: string } } }).error ?? {};
      const code = typeof error.code === 'number' ? error.code : undefined;
      // Meta's own wording for the person (template problems especially) is clearer than the code.
      const forPerson = [error.error_user_title, error.error_user_msg].filter(Boolean).join(': ');
      const detail = forPerson || error.error_data?.details || error.message || response.statusText;
      const retryAfter = Number(response.headers.get('retry-after')) || undefined;
      const text = code === 100 && detail ? detail : metaErrorText(code, detail);
      throw new MetaError(response.status, `${text}${code !== undefined ? ` (Meta error ${code})` : ''}`, code, retryAfter);
    }
    return data as T;
  }

  phoneNumber(token: string, phoneNumberId: string): Promise<MetaPhoneNumber> {
    const id = numericId(phoneNumberId, 'Phone number ID');
    return this.request(token, 'GET', `${this.base}/${id}?fields=id,display_phone_number,verified_name,quality_rating`);
  }

  async subscribeApp(token: string, wabaId: string): Promise<void> {
    await this.request(token, 'POST', `${this.base}/${numericId(wabaId, 'WhatsApp Business Account ID')}/subscribed_apps`);
  }

  async templates(token: string, wabaId: string): Promise<MetaTemplate[]> {
    const id = numericId(wabaId, 'WhatsApp Business Account ID');
    const out: MetaTemplate[] = [];
    let url: string | null = `${this.base}/${id}/message_templates?fields=id,name,language,status,category,components,rejected_reason,quality_score&limit=100`;
    for (let page = 0; url && page < 30; page++) {
      const result: { data?: MetaTemplate[]; paging?: { next?: string } } = await this.request(token, 'GET', url);
      out.push(...(result.data ?? []));
      const next = result.paging?.next;
      // Follow pagination only on Meta's own API host, so a response can't redirect the token elsewhere.
      url = next && new URL(next).host === GRAPH_HOST ? next : null;
    }
    return out;
  }

  async send(token: string, phoneNumberId: string, message: Record<string, unknown>): Promise<{ messageId: string }> {
    const result = await this.request<{ messages?: Array<{ id?: string }> }>(
      token,
      'POST',
      `${this.base}/${numericId(phoneNumberId, 'Phone number ID')}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', ...message },
      30_000,
    );
    const messageId = result.messages?.[0]?.id;
    if (!messageId) throw new MetaError(502, 'Meta accepted the message but returned no message id');
    return { messageId };
  }

  async createTemplate(token: string, wabaId: string, template: Record<string, unknown>): Promise<{ id: string; status: string; category?: string }> {
    const result = await this.request<{ id?: string; status?: string; category?: string }>(
      token,
      'POST',
      `${this.base}/${numericId(wabaId, 'WhatsApp Business Account ID')}/message_templates`,
      template,
      60_000,
    );
    if (!result.id) throw new MetaError(502, 'Meta accepted the template but returned no id');
    return { id: result.id, status: (result.status ?? 'PENDING').toUpperCase(), category: result.category };
  }

  async editTemplate(token: string, templateId: string, changes: Record<string, unknown>): Promise<void> {
    await this.request(token, 'POST', `${this.base}/${numericId(templateId, 'Template ID')}`, changes, 60_000);
  }

  async deleteTemplate(token: string, wabaId: string, name: string, templateId?: string | null): Promise<void> {
    if (!/^[a-z0-9_]{1,512}$/.test(name)) throw new MetaError(400, 'Template name is not valid');
    const id = templateId ? `&hsm_id=${numericId(templateId, 'Template ID')}` : '';
    await this.request(token, 'DELETE', `${this.base}/${numericId(wabaId, 'WhatsApp Business Account ID')}/message_templates?name=${name}${id}`);
  }

  async appId(token: string): Promise<string> {
    const app = await this.request<{ id?: string }>(token, 'GET', `${this.base}/app?fields=id`);
    if (!app.id || !/^\d{5,25}$/.test(app.id)) throw new MetaError(502, 'Meta did not say which app this access token belongs to');
    return app.id;
  }

  async uploadSample(token: string, appId: string, file: { data: Buffer; mimetype: string; filename: string }): Promise<string> {
    // Resumable Upload API: open an upload session for the app, then send the bytes to it.
    const query = new URLSearchParams({ file_name: file.filename.slice(0, 200), file_length: String(file.data.length), file_type: file.mimetype });
    const session = await this.request<{ id?: string }>(token, 'POST', `${this.base}/${numericId(appId, 'App ID')}/uploads?${query}`);
    if (!session.id || !/^upload:[^\s/#]+$/.test(session.id)) throw new MetaError(502, 'Meta did not open an upload for the example file');
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}/${session.id}`, {
        method: 'POST',
        headers: { Authorization: `OAuth ${token}`, file_offset: '0', 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(file.data),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      throw new MetaError(0, `Could not reach Meta: ${error instanceof Error ? error.message : String(error)}`);
    }
    const result = (await response.json().catch(() => ({}))) as { h?: string; error?: { message?: string; code?: number } };
    if (!response.ok || !result.h) {
      const code = typeof result.error?.code === 'number' ? result.error.code : undefined;
      throw new MetaError(response.status || 502, `Uploading the example file to Meta failed: ${metaErrorText(code, result.error?.message ?? response.statusText)}`, code);
    }
    return result.h;
  }

  async uploadMedia(token: string, phoneNumberId: string, file: { data: Buffer; mimetype: string; filename: string }): Promise<string> {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', file.mimetype);
    form.set('file', new Blob([new Uint8Array(file.data)], { type: file.mimetype }), file.filename);
    const result = await this.request<{ id?: string }>(token, 'POST', `${this.base}/${numericId(phoneNumberId, 'Phone number ID')}/media`, form, 120_000);
    if (!result.id) throw new MetaError(502, 'Meta accepted the upload but returned no media id');
    return result.id;
  }
}
