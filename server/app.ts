import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Core } from './context.js';
import type { Services } from './services/index.js';
import { HttpError } from './lib/errors.js';
import type { Platform, TenantRuntime } from './platform/platform.js';
import { toPublicUser } from './platform/platform.js';
import { registerAccountRoutes, registerAdminRoutes, type AuthInfo } from './routes/admin.js';
import { OpenWAError } from './openwa/client.js';
import { parseCookies, serializeCookie, signSession, verifySession, verifyOpenWASignature } from './lib/crypto.js';
import { isBotUserAgent } from './lib/links.js';
import { registerApiRoutes } from './routes/api.js';
import type { WebhookEnvelope } from './services/inbound.js';

export const SESSION_COOKIE = 'wr_session';
const SESSION_TTL_MS = 30 * 24 * 3_600_000;
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/health']);

interface SessionPayload {
  uid: number;
  ver: number;
  /** Business a platform admin has opened. */
  tid?: string | null;
  exp: number;
}

export interface AppOptions {
  /** Directory with the built SPA; null disables static serving (API-only / tests). */
  staticDir?: string | null;
  logger?: boolean;
}

function errorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof ZodError) {
    const details = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }));
    const first = details[0];
    return {
      status: 400,
      body: { error: first ? (first.path ? `${first.path}: ${first.message}` : first.message) : 'Invalid request', details },
    };
  }
  if (error instanceof HttpError) return { status: error.statusCode, body: { error: error.message, details: error.details } };
  if (error instanceof OpenWAError) {
    if (error.kind === 'network') return { status: 502, body: { error: error.message, gateway: true } };
    if (error.kind === 'auth') {
      return { status: 502, body: { error: 'OpenWA rejected our API key. Check OPENWA_API_KEY.', gateway: true } };
    }
    if (error.status >= 400 && error.status < 500) return { status: error.status, body: { error: error.message, gateway: true } };
    return { status: 502, body: { error: error.message, gateway: true } };
  }
  const fastifyError = error as { statusCode?: number; message?: string; validation?: unknown };
  if (fastifyError?.statusCode && fastifyError.statusCode < 500) {
    return { status: fastifyError.statusCode, body: { error: fastifyError.message ?? 'Bad request' } };
  }
  return { status: 500, body: { error: 'Internal server error' } };
}

/** Counts failed sign-ins per key (IP address, and separately per email) in a 15-minute window. */
class LoginLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly max: number) {}
  private entry(key: string): { count: number; resetAt: number } {
    const now = Date.now();
    if (this.attempts.size > 50_000) {
      for (const [k, v] of this.attempts) if (v.resetAt < now) this.attempts.delete(k);
    }
    let entry = this.attempts.get(key);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + 15 * 60_000 };
      this.attempts.set(key, entry);
    }
    return entry;
  }
  blocked(key: string): boolean {
    return this.entry(key).count >= this.max;
  }
  fail(key: string): void {
    this.entry(key).count++;
  }
  reset(key: string): void {
    this.attempts.delete(key);
  }
}

/** Reject cross-site state-changing requests (defense in depth on top of SameSite=Lax cookies). */
function sameOrigin(request: FastifyRequest, publicUrl: string | null): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    // Proxies differ in which header keeps the browser's host (GitHub Codespaces rewrites Host and
    // X-Forwarded-Host inconsistently), so accept a match on any of them or on the configured PUBLIC_URL.
    const forwarded = request.headers['x-forwarded-host'];
    const candidates = [request.headers.host, ...(Array.isArray(forwarded) ? forwarded : String(forwarded ?? '').split(','))]
      .map(h => h?.trim())
      .filter(Boolean);
    if (publicUrl) candidates.push(new URL(publicUrl).host);
    return candidates.includes(originHost);
  } catch {
    return false;
  }
}

export async function buildApp(platform: Platform, options: AppOptions = {}): Promise<FastifyInstance> {
  const config = platform.config;
  const app = Fastify({
    logger: options.logger
      ? {
          level: process.env.LOG_LEVEL ?? 'info',
          // Log paths without query strings: searches and filters can contain customers' names and numbers.
          serializers: {
            req: (req: { method: string; url: string; ip?: string }) => ({ method: req.method, url: req.url.split('?')[0], ip: req.ip }),
          },
        }
      : false,
    // Trust X-Forwarded-* only from proxies on private networks (Docker, a local nginx/Caddy), so a
    // client on the internet cannot spoof its IP past the login rate limit. TRUST_PROXY overrides.
    trustProxy: process.env.TRUST_PROXY ?? 'loopback,linklocal,uniquelocal',
    bodyLimit: 2 * 1024 * 1024,
  });
  app.decorateRequest('auth', null);

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.cookieSecure || _request.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!reply.hasHeader('Content-Security-Policy')) reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const { status, body } = errorResponse(error);
    if (status >= 500) request.log.error(error);
    void reply.status(status).send(body);
  });

  // ---------------------------------------------------------------- auth

  // 10 wrong passwords per address, and 20 per account from anywhere, per 15 minutes.
  const ipLimiter = new LoginLimiter(10);
  const emailLimiter = new LoginLimiter(20);
  const tenantContext = new AsyncLocalStorage<TenantRuntime>();

  const sessionCookie = (request: FastifyRequest, payload: Omit<SessionPayload, 'exp'> | null): string => {
    const secure = config.cookieSecure || request.protocol === 'https';
    if (!payload) return serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure });
    const token = signSession({ ...payload, exp: Date.now() + SESSION_TTL_MS }, config.appSecret);
    return serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: SESSION_TTL_MS / 1000, secure });
  };

  const resolveAuth = (request: FastifyRequest): AuthInfo | null => {
    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey) {
      const tenantId = platform.tenantByApiKey(apiKey);
      return tenantId ? { user: null, tenantId, via: 'api_key', impersonating: false } : null;
    }
    const payload = verifySession<SessionPayload>(parseCookies(request.headers.cookie)[SESSION_COOKIE], config.appSecret);
    if (!payload) return null;
    const user = platform.user(payload.uid);
    if (!user || user.disabled || user.session_version !== payload.ver) return null;
    if (user.role === 'platform_admin') {
      const tenantId = payload.tid && platform.db.get('SELECT 1 FROM tenants WHERE id = ?', payload.tid) ? payload.tid : null;
      return { user, tenantId, via: 'cookie', impersonating: !!tenantId };
    }
    return { user, tenantId: user.tenant_id, via: 'cookie', impersonating: false };
  };

  // Callback-style hook so the rest of the request runs inside the business's context.
  app.addHook('onRequest', (request, reply, done) => {
    // Decide on the route that actually matched, never the raw URL: the router decodes paths, so a
    // raw-URL check can be sidestepped with encodings like /%61pi/... . Unmatched URLs have no route.
    const path = request.routeOptions.url ?? '';
    if (!path.startsWith('/api/') || PUBLIC_API.has(path)) return done();
    const auth = resolveAuth(request);
    if (!auth) return void reply.status(401).send({ error: 'Authentication required' });
    if (request.method !== 'GET' && request.method !== 'HEAD' && auth.via === 'cookie' && !sameOrigin(request, config.publicUrl)) {
      return void reply.status(403).send({ error: 'Cross-origin request refused' });
    }
    request.auth = auth;
    const isAdmin = auth.user?.role === 'platform_admin';
    if (path.startsWith('/api/admin/')) {
      if (!isAdmin) return void reply.status(403).send({ error: 'Platform admins only' });
      return done();
    }
    if (!auth.tenantId) {
      return void reply.status(403).send({ error: isAdmin ? 'Open a business from the admin panel first' : 'No business on this account' });
    }
    if (path.startsWith('/api/account')) return done();
    // A lapsed or suspended business can still look around, but not change anything.
    if (request.method !== 'GET' && request.method !== 'HEAD' && !isAdmin) {
      try {
        platform.assertWritable(auth.tenantId);
      } catch (error) {
        const { status, body } = errorResponse(error);
        return void reply.status(status).send(body);
      }
    }
    let runtime: TenantRuntime;
    try {
      runtime = platform.runtime(auth.tenantId);
    } catch {
      return void reply.status(404).send({ error: 'Business not found' });
    }
    tenantContext.run(runtime, () => done());
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/auth/me', async request => {
    const settings = platform.settings();
    const brand = { brandName: settings.brandName, supportContact: settings.supportContact, currencySymbol: settings.currencySymbol };
    const auth = resolveAuth(request);
    if (!auth || !auth.user) return { authenticated: false, brand };
    return {
      authenticated: true,
      brand,
      user: toPublicUser(auth.user),
      tenant: auth.tenantId ? platform.tenant(auth.tenantId) : null,
      impersonating: auth.impersonating,
    };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
    if (typeof body.email !== 'string' || typeof body.password !== 'string' || body.email.length > 200 || body.password.length > 200) {
      return reply.status(400).send({ error: 'Enter your email and password' });
    }
    const ipKey = `ip:${request.ip}`;
    const emailKey = `email:${body.email.trim().toLowerCase()}`;
    if (ipLimiter.blocked(ipKey) || emailLimiter.blocked(emailKey)) {
      return reply.status(429).send({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const user = platform.authenticate(body.email, body.password);
    if (!user) {
      ipLimiter.fail(ipKey);
      emailLimiter.fail(emailKey);
      return reply.status(401).send({ error: 'Wrong email or password' });
    }
    ipLimiter.reset(ipKey);
    emailLimiter.reset(emailKey);
    reply.header('Set-Cookie', sessionCookie(request, { uid: user.id, ver: user.session_version }));
    return { authenticated: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.header('Set-Cookie', sessionCookie(request, null));
    return { authenticated: false };
  });

  const enter = (request: FastifyRequest, tenantId: string | null): string => {
    const user = request.auth!.user!;
    return sessionCookie(request, { uid: user.id, ver: user.session_version, tid: tenantId });
  };

  await app.register(async scope => registerAdminRoutes(scope, platform, enter), { prefix: '/api/admin' });
  await app.register(async scope => registerAccountRoutes(scope, platform), { prefix: '/api/account' });

  // ---------------------------------------------------------------- OpenWA webhooks (raw body, HMAC), one URL per business

  await app.register(async scope => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => {
      done(null, body);
    });
    scope.post('/webhooks/openwa/:tenantId', async (request, reply) => {
      const raw = request.body as Buffer;
      if (!Buffer.isBuffer(raw) || !verifyOpenWASignature(raw, request.headers['x-openwa-signature'] as string | undefined, config.openwa.webhookSecret)) {
        return reply.status(401).send({ error: 'Invalid signature' });
      }
      const { tenantId } = request.params as { tenantId: string };
      let runtime: TenantRuntime;
      try {
        runtime = platform.runtime(tenantId);
      } catch {
        return reply.status(404).send({ error: 'Unknown business' });
      }
      let envelope: WebhookEnvelope;
      try {
        envelope = JSON.parse(raw.toString('utf8')) as WebhookEnvelope;
      } catch {
        return reply.status(400).send({ error: 'Invalid JSON' });
      }
      // A webhook can only speak for sessions this business owns.
      if (typeof envelope?.sessionId === 'string' && !runtime.scope.owns(envelope.sessionId)) return { ok: true, outcome: 'ignored' };
      const key = request.headers['x-openwa-idempotency-key'];
      const outcome = await runtime.services.inbound.handle(envelope, typeof key === 'string' ? key : undefined);
      return { ok: true, outcome };
    });
  });

  // ---------------------------------------------------------------- click tracking

  const redirect = async (request: FastifyRequest<{ Params: { tenantId: string; code: string; token?: string } }>, reply: FastifyReply) => {
    const { tenantId, code, token } = request.params;
    if (!/^[a-z0-9]{4,12}$/.test(tenantId) || !/^[A-Za-z0-9]{4,16}$/.test(code) || (token && !/^[a-f0-9]{8,32}$/.test(token))) {
      return reply.status(404).type('text/plain').send('Link not found');
    }
    let runtime: TenantRuntime;
    try {
      runtime = platform.runtime(tenantId);
    } catch {
      return reply.status(404).type('text/plain').send('Link not found');
    }
    const userAgent = request.headers['user-agent'];
    const url = runtime.services.campaigns.recordClick(code, token ?? null, userAgent, isBotUserAgent(userAgent));
    if (!url) return reply.status(404).type('text/plain').send('Link not found');
    reply.header('Cache-Control', 'no-store');
    return reply.redirect(url, 302);
  };
  app.get('/t/:tenantId/r/:code', redirect);
  app.get('/t/:tenantId/r/:code/:token', redirect);

  // ---------------------------------------------------------------- business API + SPA

  const current = (): TenantRuntime => {
    const runtime = tenantContext.getStore();
    if (!runtime) throw new HttpError(403, 'No business selected');
    return runtime;
  };
  const core = new Proxy({} as Core, { get: (_target, key) => current().core[key as keyof Core] });
  const services = new Proxy({} as Services, { get: (_target, key) => current().services[key as keyof Services] });
  await app.register(
    async scope => {
      // Second, independent check: every business route needs a signed-in business context.
      scope.addHook('onRequest', async request => {
        if (!request.auth?.tenantId || !tenantContext.getStore()) throw new HttpError(401, 'Authentication required');
      });
      await registerApiRoutes(scope, core, services);
    },
    { prefix: '/api' },
  );

  const staticDir = options.staticDir;
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: staticDir, wildcard: false, index: 'index.html' });
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split('?')[0];
      if (request.method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/webhooks/')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not found' });
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: 'Not found' }));
  }

  return app;
}
