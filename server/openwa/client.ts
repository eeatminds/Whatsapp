/**
 * Typed client for the parts of the OpenWA REST API this app uses.
 * Reference: OpenWA docs/06-api-specification.md (auth is the X-API-Key header, never a query param).
 */

export type SessionStatus =
  | 'created'
  | 'initializing'
  | 'qr_ready'
  | 'authenticating'
  | 'ready'
  | 'disconnected'
  | 'action_required'
  | 'failed';

export interface OpenWASession {
  id: string;
  name: string;
  status: SessionStatus;
  phone: string | null;
  pushName: string | null;
  connectedAt: string | null;
  lastActive?: string | null;
  lastError?: string | null;
  engineLoaded?: boolean;
  restriction?: { active?: boolean; kind?: string; expiresAt?: string | null } | null;
  createdAt: string;
}

export interface OpenWAWebhook {
  id: string;
  sessionId: string;
  url: string;
  events: string[];
  active: boolean;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

export interface OutboundMedia {
  kind: MediaKind;
  base64: string;
  mimetype: string;
  filename?: string;
}

export interface SendResult {
  messageId: string;
  timestamp: number;
}

export type OpenWAErrorKind = 'rate_limited' | 'unavailable' | 'rejected' | 'auth' | 'network';

export class OpenWAError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'OpenWAError';
  }

  /**
   * How the dispatcher should react:
   *  - rate_limited: OpenWA's send pacing refused (429). Back off, keep the message queued.
   *  - unavailable: session not ready / gateway busy (409, 5xx). Back off, keep queued.
   *  - network: gateway unreachable. Back off, keep queued.
   *  - auth: our API key is wrong (401/403). Back off; nothing will succeed until fixed.
   *  - rejected: this particular message was refused (400, 404, 413...). Fail it.
   */
  get kind(): OpenWAErrorKind {
    if (this.status === 0) return 'network';
    if (this.status === 429) return 'rate_limited';
    if (this.status === 401 || this.status === 403) return 'auth';
    if (this.status === 409 || this.status >= 500) return 'unavailable';
    return 'rejected';
  }
}

export interface OpenWAClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class OpenWAClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenWAClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api${path}`, {
        method,
        headers: {
          'X-API-Key': this.apiKey,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new OpenWAError(0, `OpenWA unreachable at ${this.baseUrl}: ${reason}`);
    }
    const text = await response.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      const obj = (typeof data === 'object' && data !== null ? data : {}) as {
        message?: string | string[];
        code?: string;
        retryAfterSeconds?: number;
      };
      const message = Array.isArray(obj.message)
        ? obj.message.join('; ')
        : (obj.message ?? (typeof data === 'string' && data ? data.slice(0, 300) : response.statusText));
      throw new OpenWAError(response.status, `OpenWA ${response.status}: ${message}`, obj.code, obj.retryAfterSeconds);
    }
    return data as T;
  }

  health(): Promise<{ status: string }> {
    return this.request('GET', '/health', undefined, 5_000);
  }

  listSessions(): Promise<OpenWASession[]> {
    return this.request('GET', '/sessions');
  }

  getSession(id: string): Promise<OpenWASession> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}`);
  }

  createSession(name: string): Promise<OpenWASession> {
    return this.request('POST', '/sessions', { name });
  }

  startSession(id: string): Promise<unknown> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/start`, undefined, 60_000);
  }

  stopSession(id: string): Promise<unknown> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/stop`, undefined, 30_000);
  }

  logoutSession(id: string): Promise<unknown> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/logout`, undefined, 30_000);
  }

  deleteSession(id: string): Promise<unknown> {
    return this.request('DELETE', `/sessions/${encodeURIComponent(id)}`, undefined, 30_000);
  }

  getQr(id: string): Promise<{ qrCode: string; status: SessionStatus }> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/qr`);
  }

  requestPairingCode(id: string, phoneNumber: string): Promise<{ pairingCode: string; status: string }> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/pairing-code`, { phoneNumber }, 30_000);
  }

  listWebhooks(sessionId: string): Promise<OpenWAWebhook[]> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/webhooks`);
  }

  createWebhook(sessionId: string, dto: { url: string; events: string[]; secret: string }): Promise<OpenWAWebhook> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/webhooks`, dto);
  }

  updateWebhook(
    sessionId: string,
    webhookId: string,
    dto: { url: string; events: string[]; secret: string; active: boolean },
  ): Promise<OpenWAWebhook> {
    return this.request(
      'PUT',
      `/sessions/${encodeURIComponent(sessionId)}/webhooks/${encodeURIComponent(webhookId)}`,
      dto,
    );
  }

  checkNumber(sessionId: string, phone: string): Promise<{ number: string; exists: boolean; whatsappId: string | null }> {
    return this.request(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/contacts/check/${encodeURIComponent(phone)}`,
      undefined,
      20_000,
    );
  }

  resolvePhone(sessionId: string, contactId: string): Promise<{ contactId: string; phone: string | null }> {
    return this.request(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/contacts/${encodeURIComponent(contactId)}/phone`,
      undefined,
      10_000,
    );
  }

  sendText(sessionId: string, chatId: string, text: string): Promise<SendResult> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, { chatId, text }, 60_000);
  }

  sendMedia(sessionId: string, chatId: string, media: OutboundMedia, caption?: string): Promise<SendResult> {
    const body: Record<string, unknown> = {
      chatId,
      base64: media.base64,
      mimetype: media.mimetype,
    };
    if (media.filename) body.filename = media.filename;
    // Audio carries no caption on WhatsApp; the dispatcher sends any text separately.
    if (caption && media.kind !== 'audio') body.caption = caption;
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/messages/send-${media.kind}`, body, 120_000);
  }
}

/** The subset of the client the rest of the app depends on, so tests can substitute a fake. */
export type OpenWAApi = Pick<
  OpenWAClient,
  | 'health'
  | 'listSessions'
  | 'getSession'
  | 'createSession'
  | 'startSession'
  | 'stopSession'
  | 'logoutSession'
  | 'deleteSession'
  | 'getQr'
  | 'requestPairingCode'
  | 'listWebhooks'
  | 'createWebhook'
  | 'updateWebhook'
  | 'checkNumber'
  | 'resolvePhone'
  | 'sendText'
  | 'sendMedia'
>;
