import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Platform, TenantRuntime, UserRow } from '../platform/platform.js';
import { CALL_APP_VERSION, type DeviceRow } from '../services/calls.js';

/**
 * The WA Reach Calls phone app's API (/device-api). A team member signs in on the phone with their
 * WA Reach email and password; the phone gets its own secret and never keeps the password. That
 * secret only lets it send its own calls and recordings: it reads nothing back. Changing the
 * person's password, switching them off or removing them signs the phone out too.
 */

export interface Limiter {
  blocked(key: string): boolean;
  fail(key: string): void;
  reset(key: string): void;
}

interface DeviceContext {
  tenantId: string;
  runtime: TenantRuntime;
  device: DeviceRow;
  user: UserRow;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });

export async function registerDeviceRoutes(
  app: FastifyInstance,
  platform: Platform,
  options: { ipLimiter: Limiter; emailLimiter: Limiter; appUrl: () => string | null },
): Promise<void> {
  // A recording arrives as the file itself; its content is checked before it is kept.
  app.addContentTypeParser(/^(audio\/[a-z0-9.+-]+|application\/octet-stream)$/i, { parseAs: 'buffer', bodyLimit: 60 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  const signedOut = (reply: FastifyReply) =>
    reply.status(401).send({ error: 'This phone was signed out of WA Reach. Sign in again with your WA Reach email and password.', signedOut: true });

  const authed = (request: FastifyRequest): DeviceContext | null => {
    const match = /^Bearer ([a-z0-9]{4,12})\.([A-Za-z0-9]{40})$/.exec(String(request.headers.authorization ?? ''));
    if (!match) return null;
    const [, tenantId, secret] = match;
    let runtime: TenantRuntime;
    try {
      runtime = platform.runtime(tenantId);
    } catch {
      return null;
    }
    const device = runtime.services.calls.device(secret);
    if (!device) return null;
    const user = platform.user(device.user_id);
    if (!user || user.disabled || user.tenant_id !== tenantId || user.session_version !== device.session_version) {
      runtime.services.calls.revoke(device.id);
      return null;
    }
    return { tenantId, runtime, device, user };
  };

  const about = (ctx: { tenantId: string; user: UserRow }) => ({
    business: platform.tenant(ctx.tenantId).name,
    user: { name: ctx.user.name, email: ctx.user.email },
    latestVersion: CALL_APP_VERSION,
    appUrl: options.appUrl(),
  });

  app.post('/login', async (request, reply) => {
    const body = z
      .object({ email: z.string().max(200), password: z.string().max(200), device: z.string().trim().max(80).default('Phone') })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Enter your email and password' });
    const ipKey = `ip:${request.ip}`;
    const emailKey = `email:${body.data.email.trim().toLowerCase()}`;
    if (options.ipLimiter.blocked(ipKey) || options.emailLimiter.blocked(emailKey)) {
      return reply.status(429).send({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const user = platform.authenticate(body.data.email, body.data.password);
    if (!user) {
      options.ipLimiter.fail(ipKey);
      options.emailLimiter.fail(emailKey);
      return reply.status(401).send({ error: 'Wrong email or password' });
    }
    options.ipLimiter.reset(ipKey);
    options.emailLimiter.reset(emailKey);
    if (user.role === 'platform_admin' || !user.tenant_id) {
      return reply.status(403).send({ error: 'Sign in with your business login, the one your WA Reach admin gave you.' });
    }
    platform.assertWritable(user.tenant_id);
    const runtime = platform.runtime(user.tenant_id);
    const { secret, since } = runtime.services.calls.connect(user.id, user.session_version, body.data.device);
    return { token: `${user.tenant_id}.${secret}`, since: Date.parse(since), ...about({ tenantId: user.tenant_id, user }) };
  });

  app.get('/status', async (request, reply) => {
    const ctx = authed(request);
    if (!ctx) return signedOut(reply);
    ctx.runtime.services.calls.touch(ctx.device);
    return { ok: true, ...about(ctx) };
  });

  app.post('/calls', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const ctx = authed(request);
    if (!ctx) return signedOut(reply);
    platform.assertWritable(ctx.tenantId);
    return ctx.runtime.services.calls.receive(ctx.device, request.body);
  });

  app.post('/recordings/:id', async (request, reply) => {
    const ctx = authed(request);
    if (!ctx) return signedOut(reply);
    if (!Buffer.isBuffer(request.body)) return reply.status(415).send({ error: 'Send the recording file itself' });
    platform.assertWritable(ctx.tenantId);
    return ctx.runtime.services.calls.saveRecording(ctx.device, idParam.parse(request.params).id, request.body);
  });

  app.post('/recordings/:id/none', async (request, reply) => {
    const ctx = authed(request);
    if (!ctx) return signedOut(reply);
    return ctx.runtime.services.calls.noRecording(ctx.device, idParam.parse(request.params).id);
  });

  app.post('/logout', async (request, reply) => {
    const ctx = authed(request);
    if (!ctx) return signedOut(reply);
    ctx.runtime.services.calls.revoke(ctx.device.id);
    return { ok: true };
  });
}
