import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import type { Core } from './context.js';
import type { Services } from './services/index.js';
import { HttpError } from './lib/errors.js';
import { OpenWAError } from './openwa/client.js';
import { parseCookies, safeEqual, serializeCookie, signSession, verifySession, verifyOpenWASignature } from './lib/crypto.js';
import { isBotUserAgent } from './lib/links.js';
import { registerApiRoutes } from './routes/api.js';
import type { WebhookEnvelope } from './services/inbound.js';

export const SESSION_COOKIE = 'wr_session';
const SESSION_TTL_MS = 30 * 24 * 3_600_000;
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/health']);

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

class LoginLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt < now) {
      this.attempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
      return true;
    }
    entry.count++;
    return entry.count <= 10;
  }
  reset(key: string): void {
    this.attempts.delete(key);
  }
}

export function isAuthenticated(core: Core, request: FastifyRequest): boolean {
  const apiKey = request.headers['x-api-key'];
  if (core.config.apiKey && typeof apiKey === 'string' && safeEqual(apiKey, core.config.apiKey)) return true;
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  return !!verifySession(token, core.config.appSecret);
}

/** Reject cross-site state-changing requests (defense in depth on top of SameSite=Lax cookies). */
function sameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const host = request.headers['x-forwarded-host'] ?? request.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function buildApp(core: Core, services: Services, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ? { level: process.env.LOG_LEVEL ?? 'info' } : false,
    // Trust X-Forwarded-* only from proxies on private networks (Docker, a local nginx/Caddy), so a
    // client on the internet cannot spoof its IP past the login rate limit. TRUST_PROXY overrides.
    trustProxy: process.env.TRUST_PROXY ?? 'loopback,linklocal,uniquelocal',
    bodyLimit: 2 * 1024 * 1024,
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header(
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

  const limiter = new LoginLimiter();

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/') || PUBLIC_API.has(path)) return;
    if (!isAuthenticated(core, request)) {
      return reply.status(401).send({ error: 'Authentication required' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && !sameOrigin(request)) {
      return reply.status(403).send({ error: 'Cross-origin request refused' });
    }
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/auth/me', async request => ({ authenticated: isAuthenticated(core, request) }));

  app.post('/api/auth/login', async (request, reply) => {
    if (!limiter.allow(request.ip)) return reply.status(429).send({ error: 'Too many attempts. Try again in 15 minutes.' });
    const password = (request.body as { password?: unknown } | undefined)?.password;
    if (typeof password !== 'string' || !safeEqual(password, core.config.adminPassword)) {
      return reply.status(401).send({ error: 'Wrong password' });
    }
    limiter.reset(request.ip);
    const token = signSession({ sub: 'admin', exp: Date.now() + SESSION_TTL_MS }, core.config.appSecret);
    const secure = core.config.cookieSecure || request.protocol === 'https';
    reply.header('Set-Cookie', serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: SESSION_TTL_MS / 1000, secure }));
    return { authenticated: true };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.header('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0 }));
    return { authenticated: false };
  });

  // ---------------------------------------------------------------- OpenWA webhook (raw body, HMAC)

  await app.register(async scope => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => {
      done(null, body);
    });
    scope.post('/webhooks/openwa', async (request, reply) => {
      const raw = request.body as Buffer;
      if (!Buffer.isBuffer(raw) || !verifyOpenWASignature(raw, request.headers['x-openwa-signature'] as string | undefined, core.config.openwa.webhookSecret)) {
        return reply.status(401).send({ error: 'Invalid signature' });
      }
      let envelope: WebhookEnvelope;
      try {
        envelope = JSON.parse(raw.toString('utf8')) as WebhookEnvelope;
      } catch {
        return reply.status(400).send({ error: 'Invalid JSON' });
      }
      const key = request.headers['x-openwa-idempotency-key'];
      const outcome = await services.inbound.handle(envelope, typeof key === 'string' ? key : undefined);
      return { ok: true, outcome };
    });
  });

  // ---------------------------------------------------------------- click tracking

  const redirect = async (request: FastifyRequest<{ Params: { code: string; token?: string } }>, reply: FastifyReply) => {
    const { code, token } = request.params;
    if (!/^[A-Za-z0-9]{4,16}$/.test(code) || (token && !/^[a-f0-9]{8,32}$/.test(token))) {
      return reply.status(404).type('text/plain').send('Link not found');
    }
    const userAgent = request.headers['user-agent'];
    const url = services.campaigns.recordClick(code, token ?? null, userAgent, isBotUserAgent(userAgent));
    if (!url) return reply.status(404).type('text/plain').send('Link not found');
    reply.header('Cache-Control', 'no-store');
    return reply.redirect(url, 302);
  };
  app.get('/r/:code', redirect);
  app.get('/r/:code/:token', redirect);

  // ---------------------------------------------------------------- API + SPA

  await app.register(async scope => registerApiRoutes(scope, core, services), { prefix: '/api' });

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
