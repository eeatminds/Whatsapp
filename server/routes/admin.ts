import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Platform, UserRow } from '../platform/platform.js';
import { toPublicUser } from '../platform/platform.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';

export interface AuthInfo {
  user: UserRow | null;
  tenantId: string | null;
  via: 'cookie' | 'api_key';
  impersonating: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo | null;
  }
}

const idParam = z.object({ id: z.string().min(1).max(40) });
const userParam = z.object({ id: z.string().min(1).max(40), userId: z.coerce.number().int().positive() });

/** Platform-owner routes: businesses, subscriptions, payments, users, white-label settings. */
export async function registerAdminRoutes(app: FastifyInstance, platform: Platform, enter: (request: FastifyRequest, tenantId: string | null) => string): Promise<void> {
  // Second, independent check (the app-wide hook already enforces this).
  app.addHook('onRequest', async request => {
    if (request.auth?.user?.role !== 'platform_admin') throw new HttpError(403, 'Platform admins only');
  });

  app.get('/overview', async () => {
    const overview = platform.overview();
    let gateway: { reachable: boolean; sessions: number; ready: number; error?: string } = { reachable: false, sessions: 0, ready: 0 };
    try {
      const sessions = await platform.fetchAllSessions();
      gateway = { reachable: true, sessions: sessions.length, ready: sessions.filter(s => s.status === 'ready').length };
    } catch (error) {
      gateway = { reachable: false, sessions: 0, ready: 0, error: error instanceof Error ? error.message : String(error) };
    }
    return { ...overview, gateway, settings: platform.settings() };
  });

  app.get('/tenants', async () => platform.tenants().map(t => ({ ...t, stats: platform.tenantStats(t.id), owner: platform.users(t.id).find(u => u.role === 'owner') ?? null })));

  app.post('/tenants', async (request, reply) => reply.status(201).send(platform.createTenant(request.body)));

  app.get('/tenants/:id', async request => {
    const { id } = idParam.parse(request.params);
    return {
      tenant: platform.tenant(id),
      stats: platform.tenantStats(id),
      users: platform.users(id),
      payments: platform.payments({ tenantId: id }),
      sending: platform.sendingLimits(id),
    };
  });

  app.put('/tenants/:id/sending', async request => platform.setSendingLimits(idParam.parse(request.params).id, request.body));

  app.patch('/tenants/:id', async request => platform.updateTenant(idParam.parse(request.params).id, request.body));

  app.post('/tenants/:id/suspend', async request => platform.setStatus(idParam.parse(request.params).id, 'suspended'));
  app.post('/tenants/:id/activate', async request => platform.setStatus(idParam.parse(request.params).id, 'active'));

  app.post('/tenants/:id/payments', async request =>
    platform.recordPayment(idParam.parse(request.params).id, request.body, request.auth?.user?.id ?? null),
  );

  app.delete('/tenants/:id', async request => {
    const { id } = idParam.parse(request.params);
    const { confirm } = z.object({ confirm: z.string() }).parse(request.body ?? {});
    if (confirm !== platform.tenant(id).name) throw badRequest('Type the business name exactly to confirm');
    await platform.deleteTenant(id);
    return { ok: true };
  });

  app.post('/tenants/:id/users', async (request, reply) => reply.status(201).send(platform.addUser(idParam.parse(request.params).id, request.body)));

  app.post('/tenants/:id/users/:userId/reset-password', async request => {
    const { id, userId } = userParam.parse(request.params);
    if (platform.user(userId)?.tenant_id !== id) throw notFound('User');
    return { password: platform.resetPassword(userId) };
  });

  app.post('/tenants/:id/users/:userId/disable', async request => {
    const { id, userId } = userParam.parse(request.params);
    if (platform.user(userId)?.tenant_id !== id) throw notFound('User');
    const { disabled } = z.object({ disabled: z.boolean() }).parse(request.body);
    platform.setUserDisabled(userId, disabled);
    return { ok: true };
  });

  app.delete('/tenants/:id/users/:userId', async request => {
    const { id, userId } = userParam.parse(request.params);
    if (platform.user(userId)?.tenant_id !== id) throw notFound('User');
    platform.deleteUser(userId);
    return { ok: true };
  });

  /** Open a business's workspace as the platform admin (to help set it up or support it). */
  app.post('/tenants/:id/enter', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    platform.tenant(id);
    reply.header('Set-Cookie', enter(request, id));
    return { ok: true };
  });

  app.post('/exit', async (request, reply) => {
    reply.header('Set-Cookie', enter(request, null));
    return { ok: true };
  });

  app.get('/payments', async () => platform.payments({ limit: 500 }));

  app.get('/settings', async () => platform.settings());
  app.put('/settings', async request => platform.updateSettings(request.body));

  app.post('/password', async request => {
    const { current, next } = z.object({ current: z.string(), next: z.string() }).parse(request.body);
    platform.changeOwnPassword(request.auth!.user!.id, current, next);
    return { ok: true };
  });
}

/** Business-owner routes: own subscription, team, API key, password. */
export async function registerAccountRoutes(app: FastifyInstance, platform: Platform): Promise<void> {
  app.addHook('onRequest', async request => {
    if (!request.auth?.tenantId) throw new HttpError(401, 'Authentication required');
  });

  const tenantOf = (request: FastifyRequest): string => {
    const tenantId = request.auth?.tenantId;
    if (!tenantId) throw new HttpError(403, 'No business selected');
    return tenantId;
  };
  const requireOwner = (request: FastifyRequest) => {
    const user = request.auth?.user;
    if (!user || (user.role !== 'owner' && user.role !== 'platform_admin')) throw new HttpError(403, 'Only the account owner can do this');
  };

  app.get('/', async request => {
    if (!request.auth?.user) throw new HttpError(403, 'Sign in to see account details');
    const tenantId = tenantOf(request);
    return {
      tenant: platform.tenant(tenantId),
      users: platform.users(tenantId),
      payments: platform.payments({ tenantId }),
      support: platform.settings().supportContact,
      currencySymbol: platform.settings().currencySymbol,
    };
  });

  app.post('/password', async request => {
    const user = request.auth?.user;
    if (!user) throw new HttpError(403, 'Sign in with your email to change your password');
    const { current, next } = z.object({ current: z.string(), next: z.string() }).parse(request.body);
    platform.changeOwnPassword(user.id, current, next);
    return { ok: true };
  });

  app.post('/api-key', async request => {
    requireOwner(request);
    return { key: platform.rotateApiKey(tenantOf(request)) };
  });

  app.delete('/api-key', async request => {
    requireOwner(request);
    platform.revokeApiKey(tenantOf(request));
    return { ok: true };
  });

  app.post('/users', async (request, reply) => {
    requireOwner(request);
    const body = z.object({ email: z.string(), name: z.string().optional() }).parse(request.body);
    return reply.status(201).send(platform.addUser(tenantOf(request), { ...body, role: 'member' }));
  });

  app.delete('/users/:userId', async request => {
    requireOwner(request);
    const { userId } = z.object({ userId: z.coerce.number().int().positive() }).parse(request.params);
    const target = platform.user(userId);
    if (!target || target.tenant_id !== tenantOf(request)) throw notFound('User');
    if (target.role === 'owner') throw badRequest('The owner account cannot be removed');
    platform.deleteUser(userId);
    return { ok: true };
  });
}

export { toPublicUser };
