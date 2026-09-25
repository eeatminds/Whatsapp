import type { Core } from '../context.js';
import { OpenWAError, type OpenWASession, type SessionStatus } from '../openwa/client.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';

export const WEBHOOK_EVENTS = ['message.received', 'message.ack', 'message.failed', 'session.status'];

const REFRESH_MS = 10_000;

export interface GatewayStatus {
  reachable: boolean;
  lastError: string | null;
  checkedAt: string | null;
  webhookUrl: string;
}

/**
 * Limits a business to its own WhatsApp numbers on a gateway shared by many businesses. Without a
 * scope (single-business installs and most tests) every session on the gateway is visible.
 */
export interface SessionScope {
  /** Every session on the gateway; the platform caches this across businesses. */
  fetchAll(force: boolean): Promise<OpenWASession[]>;
  owns(sessionId: string): boolean;
  add(sessionId: string): void;
  remove(sessionId: string): void;
  /** Prepended to OpenWA session names, which are unique across the whole gateway. */
  namePrefix: string;
  /** Plan limit on connected numbers; null means unlimited. */
  maxNumbers(): number | null;
}

/**
 * WhatsApp numbers live in OpenWA as "sessions". This service proxies their lifecycle, keeps a
 * short-lived cache of which ones are ready to send, and makes sure each one has our webhook.
 */
export class SessionsService {
  private cache: OpenWASession[] = [];
  private cachedAt = 0;
  private refreshing: Promise<OpenWASession[]> | null = null;
  private status: GatewayStatus;
  private readonly webhookSynced = new Set<string>();
  private readonly webhookInFlight = new Map<string, Promise<'created' | 'updated'>>();

  constructor(
    private readonly core: Core,
    private readonly scope?: SessionScope,
  ) {
    this.status = { reachable: false, lastError: null, checkedAt: null, webhookUrl: core.config.webhookUrl };
  }

  gatewayStatus(): GatewayStatus {
    return { ...this.status };
  }

  async list(force = false): Promise<OpenWASession[]> {
    if (!force && Date.now() - this.cachedAt < REFRESH_MS) return this.cache;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const all = this.scope ? await this.scope.fetchAll(force) : await this.core.openwa.listSessions();
        const sessions = Array.isArray(all) ? all : [];
        this.cache = this.scope ? sessions.filter(s => this.scope!.owns(s.id)).map(s => this.displayed(s)) : sessions;
        this.cachedAt = Date.now();
        this.status = { ...this.status, reachable: true, lastError: null, checkedAt: new Date().toISOString() };
        // Sessions created in OpenWA's own dashboard get our webhook the first time we see them.
        for (const session of this.cache) {
          if (!this.webhookSynced.has(session.id)) {
            void this.ensureWebhook(session.id).catch(error =>
              this.core.log.warn(`Webhook sync for session ${session.id} failed: ${String(error)}`),
            );
          }
        }
        return this.cache;
      } catch (error) {
        this.status = {
          ...this.status,
          reachable: false,
          lastError: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString(),
        };
        this.cachedAt = Date.now();
        this.cache = [];
        return this.cache;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async readySessionIds(): Promise<string[]> {
    return (await this.list()).filter(s => s.status === 'ready').map(s => s.id);
  }

  async isReady(sessionId: string): Promise<boolean> {
    return (await this.readySessionIds()).includes(sessionId);
  }

  /** Called from the session.status webhook so the cache reflects changes before the next poll. */
  applyStatus(sessionId: string, status: SessionStatus): void {
    const session = this.cache.find(s => s.id === sessionId);
    if (session) session.status = status;
    else this.cachedAt = 0;
  }

  invalidate(): void {
    this.cachedAt = 0;
  }

  /** Whether this business may use the session (always true without a scope). */
  owns(sessionId: string): boolean {
    return !this.scope || this.scope.owns(sessionId);
  }

  private guard(sessionId: string): void {
    if (!this.owns(sessionId)) throw notFound('WhatsApp number');
  }

  private displayed(session: OpenWASession): OpenWASession {
    const prefix = this.scope?.namePrefix ?? '';
    return prefix && session.name.startsWith(prefix) ? { ...session, name: session.name.slice(prefix.length) } : { ...session };
  }

  async create(name: string): Promise<OpenWASession> {
    const clean = name.trim();
    const prefix = this.scope?.namePrefix ?? '';
    const maxLength = 50 - prefix.length;
    if (!new RegExp(`^[A-Za-z0-9-]{3,${maxLength}}$`).test(clean)) {
      throw badRequest(`Name must be 3-${maxLength} characters: letters, digits and hyphens`);
    }
    if (this.scope) {
      const limit = this.scope.maxNumbers();
      const owned = (await this.list(true)).length;
      if (limit !== null && owned >= limit) {
        throw new HttpError(403, `Your plan allows ${limit} WhatsApp number${limit === 1 ? '' : 's'}. Remove one or ask to upgrade.`);
      }
    }
    const created = await this.core.openwa.createSession(prefix + clean);
    this.scope?.add(created.id);
    const session = this.displayed(created);
    this.invalidate();
    await this.ensureWebhook(session.id);
    try {
      await this.core.openwa.startSession(session.id);
    } catch (error) {
      this.core.log.warn(`Session ${session.id} created but failed to start: ${String(error)}`);
    }
    return session;
  }

  async start(sessionId: string): Promise<void> {
    this.guard(sessionId);
    await this.ensureWebhook(sessionId).catch(error => this.core.log.warn(`Webhook sync failed: ${String(error)}`));
    await this.core.openwa.startSession(sessionId);
    this.invalidate();
  }

  async stop(sessionId: string): Promise<void> {
    this.guard(sessionId);
    await this.core.openwa.stopSession(sessionId);
    this.invalidate();
  }

  async logout(sessionId: string): Promise<void> {
    this.guard(sessionId);
    await this.core.openwa.logoutSession(sessionId);
    this.invalidate();
  }

  async remove(sessionId: string): Promise<void> {
    this.guard(sessionId);
    await this.core.openwa.deleteSession(sessionId);
    this.scope?.remove(sessionId);
    this.webhookSynced.delete(sessionId);
    this.invalidate();
  }

  qr(sessionId: string) {
    this.guard(sessionId);
    return this.core.openwa.getQr(sessionId);
  }

  pairingCode(sessionId: string, phone: string) {
    this.guard(sessionId);
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8) throw badRequest('Enter the full number with country code');
    return this.core.openwa.requestPairingCode(sessionId, digits);
  }

  /**
   * Create or refresh our webhook on the session. OpenWA never returns secrets, so an existing
   * webhook is updated with ours unconditionally — that also heals a rotated secret.
   */
  ensureWebhook(sessionId: string): Promise<'created' | 'updated'> {
    // Concurrent callers (background auto-sync, a manual sync, session creation) share one run;
    // two parallel list-then-create passes would register the webhook twice.
    const pending = this.webhookInFlight.get(sessionId);
    if (pending) return pending;
    const run = this.syncWebhook(sessionId).finally(() => this.webhookInFlight.delete(sessionId));
    this.webhookInFlight.set(sessionId, run);
    return run;
  }

  private async syncWebhook(sessionId: string): Promise<'created' | 'updated'> {
    const url = this.core.config.webhookUrl;
    const secret = this.core.config.openwa.webhookSecret;
    const hooks = await this.core.openwa.listWebhooks(sessionId);
    const existing = hooks.find(h => h.url === url);
    let result: 'created' | 'updated';
    if (existing) {
      await this.core.openwa.updateWebhook(sessionId, existing.id, { url, events: WEBHOOK_EVENTS, secret, active: true });
      result = 'updated';
    } else {
      try {
        await this.core.openwa.createWebhook(sessionId, { url, events: WEBHOOK_EVENTS, secret });
      } catch (error) {
        if (error instanceof OpenWAError && error.status === 400 && /ssrf|private|internal|resolve/i.test(error.message)) {
          throw new OpenWAError(
            400,
            `${error.message}. OpenWA refuses webhook URLs on private networks unless the host is listed in its SSRF_ALLOWED_HOSTS setting.`,
          );
        }
        throw error;
      }
      result = 'created';
    }
    this.webhookSynced.add(sessionId);
    return result;
  }

  async syncWebhooks(): Promise<Array<{ sessionId: string; name: string; result: string }>> {
    const sessions = await this.list(true);
    if (!this.status.reachable) throw new OpenWAError(0, this.status.lastError ?? 'OpenWA is unreachable');
    const results: Array<{ sessionId: string; name: string; result: string }> = [];
    for (const session of sessions) {
      try {
        results.push({ sessionId: session.id, name: session.name, result: await this.ensureWebhook(session.id) });
      } catch (error) {
        results.push({ sessionId: session.id, name: session.name, result: `error: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return results;
  }
}
