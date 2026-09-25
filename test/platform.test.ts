import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, inbound, type TestEnv } from './helpers.js';
import { signOpenWABody } from '../server/lib/crypto.js';

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  await env.close();
});

async function login(email: string, password: string): Promise<string> {
  const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0];
}

async function as(cookie: string, method: string, url: string, body?: unknown) {
  const res = await env.app.inject({ method: method as 'GET', url, payload: body as object, headers: { cookie } });
  let parsed: any = res.body;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    // keep text
  }
  return { status: res.statusCode, body: parsed, headers: res.headers };
}

describe('platform admin', () => {
  it('creates a business whose owner can sign in and sees only its own data', async () => {
    const admin = await login('admin@example.com', 'platform-admin-password');
    const created = await as(admin, 'POST', '/api/admin/tenants', { name: 'Sharma Salon', ownerEmail: 'Priya@Salon.example', ownerName: 'Priya' });
    expect(created.status).toBe(201);
    expect(created.body.password).toMatch(/^[a-z]+-\d{4}-[a-z]+$/);
    expect(created.body.tenant).toMatchObject({ name: 'Sharma Salon', priceMonthly: 1000, maxNumbers: 1, access: 'active' });

    const owner = await login('priya@salon.example', created.body.password);
    const me = await as(owner, 'GET', '/api/auth/me');
    expect(me.body).toMatchObject({ user: { role: 'owner' }, tenant: { name: 'Sharma Salon' }, brand: { brandName: 'WA Reach' } });

    // The first business's contact is invisible to the second.
    await env.api('POST', '/api/contacts', { phone: '9876500001', name: 'Shop customer' });
    await as(owner, 'POST', '/api/contacts', { phone: '9876500002', name: 'Salon customer' });
    expect((await env.api('GET', '/api/contacts')).body.items.map((c: { name: string }) => c.name)).toEqual(['Shop customer']);
    expect((await as(owner, 'GET', '/api/contacts')).body.items.map((c: { name: string }) => c.name)).toEqual(['Salon customer']);

    // Owners can't reach the admin panel; admins must open a business to use its workspace.
    expect((await as(owner, 'GET', '/api/admin/tenants')).status).toBe(403);
    expect((await as(admin, 'GET', '/api/contacts')).status).toBe(403);
    const entered = await as(admin, 'POST', `/api/admin/tenants/${created.body.tenant.id}/enter`);
    const adminInSalon = String(entered.headers['set-cookie']).split(';')[0];
    expect((await as(adminInSalon, 'GET', '/api/contacts')).body.items[0].name).toBe('Salon customer');
    expect((await as(adminInSalon, 'GET', '/api/auth/me')).body.impersonating).toBe(true);

    const list = await as(admin, 'GET', '/api/admin/tenants');
    expect(list.body.map((t: { name: string }) => t.name)).toEqual(['Sharma Salon', 'Test Shop']);
    expect(list.body.find((t: { name: string }) => t.name === 'Test Shop').stats).toMatchObject({ numbers: 1, contacts: 1 });
  });

  it('signs a user out everywhere when their password is reset', async () => {
    const cookie = await login(env.owner.email, env.owner.password);
    const admin = await login('admin@example.com', 'platform-admin-password');
    const ownerId = (await as(cookie, 'GET', '/api/auth/me')).body.user.id;
    const reset = await as(admin, 'POST', `/api/admin/tenants/${env.tenantId}/users/${ownerId}/reset-password`);
    expect(reset.body.password).toBeTruthy();
    expect((await as(cookie, 'GET', '/api/contacts')).status).toBe(401);
    await login(env.owner.email, reset.body.password);
  });

  it('lets an owner change their password, add team members and issue an API key', async () => {
    const cookie = await login(env.owner.email, env.owner.password);
    expect((await as(cookie, 'POST', '/api/account/password', { current: 'wrong', next: 'new-password-456' })).status).toBe(400);
    expect((await as(cookie, 'POST', '/api/account/password', { current: env.owner.password, next: 'new-password-456' })).status).toBe(200);
    const fresh = await login(env.owner.email, 'new-password-456');
    const member = await as(fresh, 'POST', '/api/account/users', { email: 'staff@shop.example' });
    expect(member.status).toBe(201);
    const staff = await login('staff@shop.example', member.body.password);
    expect((await as(staff, 'POST', '/api/account/api-key')).status).toBe(403);
    const key = (await as(fresh, 'POST', '/api/account/api-key')).body.key as string;
    const viaKey = await env.app.inject({ method: 'GET', url: '/api/contacts', headers: { 'x-api-key': key } });
    expect(viaKey.statusCode).toBe(200);
    // Rotating replaces the old key.
    expect((await env.app.inject({ method: 'GET', url: '/api/contacts', headers: { 'x-api-key': env.apiKey } })).statusCode).toBe(401);
  });
});

describe('sending limits', () => {
  it('are set by the platform admin per business; the owner cannot raise them', async () => {
    const admin = await login('admin@example.com', 'platform-admin-password');
    await as(admin, 'PUT', '/api/admin/settings', { defaultDailyCap: 100, defaultPerMinuteCap: 5 });
    const created = await as(admin, 'POST', '/api/admin/tenants', { name: 'New Shop', ownerEmail: 'new@shop.example', ownerPassword: 'new-shop-password' });
    const id = created.body.tenant.id;
    // New businesses start from the admin's defaults.
    const detail = await as(admin, 'GET', `/api/admin/tenants/${id}`);
    expect(detail.body.sending).toMatchObject({ dailyCapPerSession: 100, sessionMaxPerMinute: 5, defaultPerMinute: 5 });

    // The owner's attempt to raise limits is ignored; other settings still save.
    const owner = await login('new@shop.example', 'new-shop-password');
    const saved = await as(owner, 'PUT', '/api/settings', { businessName: 'Renamed', sending: { dailyCapPerSession: 5000 } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ businessName: 'Renamed', sending: { dailyCapPerSession: 100 } });

    // The admin raises the limit month on month.
    const raised = await as(admin, 'PUT', `/api/admin/tenants/${id}/sending`, { dailyCapPerSession: 200, sessionMaxPerMinute: 4 });
    expect(raised.body).toMatchObject({ dailyCapPerSession: 200, sessionMaxPerMinute: 4, defaultPerMinute: 4 });
    expect((await as(owner, 'GET', '/api/settings')).body.sending.dailyCapPerSession).toBe(200);
    // Owners can't reach the admin endpoint.
    expect((await as(owner, 'PUT', `/api/admin/tenants/${id}/sending`, { dailyCapPerSession: 9999 })).status).toBe(403);
  });
});

describe('subscriptions', () => {
  it('stops changes after the paid period plus grace, and a payment restores access', async () => {
    const tenant = env.platform.tenant(env.tenantId);
    expect(tenant.access).toBe('active');
    env.clock.set(new Date(new Date(tenant.paidUntil).getTime() + 86_400_000).toISOString());
    expect(env.platform.tenant(env.tenantId).access).toBe('grace');
    expect((await env.api('POST', '/api/tags', { name: 'still-ok' })).status).toBe(201);

    env.clock.advance(3 * 86_400_000);
    expect(env.platform.tenant(env.tenantId).access).toBe('expired');
    expect(env.platform.canSend(env.tenantId)).toBe(false);
    const blocked = await env.api('POST', '/api/tags', { name: 'blocked' });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error).toMatch(/expired/);
    expect((await env.api('GET', '/api/contacts')).status).toBe(200);

    const admin = await login('admin@example.com', 'platform-admin-password');
    const paid = await as(admin, 'POST', `/api/admin/tenants/${env.tenantId}/payments`, { months: 1, amount: 1000, method: 'upi', reference: 'UPI-1234' });
    expect(paid.body.access).toBe('active');
    // Renewal after lapsing runs from today, not from the old end date.
    const expected = new Date(env.clock.now());
    expected.setUTCMonth(expected.getUTCMonth() + 1);
    expect(paid.body.paidUntil).toBe(expected.toISOString());
    expect((await env.api('POST', '/api/tags', { name: 'back' })).status).toBe(201);

    // Paying early extends from the current end date.
    const early = await as(admin, 'POST', `/api/admin/tenants/${env.tenantId}/payments`, { months: 2, amount: 2000, method: 'cash' });
    const endAfterEarly = new Date(expected);
    endAfterEarly.setUTCMonth(endAfterEarly.getUTCMonth() + 2);
    expect(early.body.paidUntil).toBe(endAfterEarly.toISOString());

    const overview = await as(admin, 'GET', '/api/admin/overview');
    expect(overview.body).toMatchObject({ businesses: 1, active: 1, monthlyRecurring: 1000, collectedThisMonth: 3000 });
    expect((await as(admin, 'GET', '/api/admin/payments')).body).toHaveLength(2);
  });

  it('blocks a suspended business immediately', async () => {
    const admin = await login('admin@example.com', 'platform-admin-password');
    await as(admin, 'POST', `/api/admin/tenants/${env.tenantId}/suspend`);
    const res = await env.api('POST', '/api/tags', { name: 'x' });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatch(/suspended/);
    await as(admin, 'POST', `/api/admin/tenants/${env.tenantId}/activate`);
    expect((await env.api('POST', '/api/tags', { name: 'x' })).status).toBe(201);
  });
});

describe('WhatsApp number isolation', () => {
  it('hides, refuses and ignores numbers that belong to another business', async () => {
    const other = env.platform.createTenant({ name: 'Other Biz', ownerEmail: 'o@other.example', ownerPassword: 'other-password-1' });
    const otherCookie = await login('o@other.example', 'other-password-1');

    // Other business sees none of Test Shop's numbers and cannot operate them.
    expect((await as(otherCookie, 'GET', '/api/sessions')).body.items).toEqual([]);
    expect((await as(otherCookie, 'POST', `/api/sessions/${env.sessionId}/stop`)).status).toBe(404);
    expect((await as(otherCookie, 'GET', `/api/sessions/${env.sessionId}/qr`)).status).toBe(404);

    // Nor send through them from its inbox.
    const contact = (await as(otherCookie, 'POST', '/api/contacts', { phone: '9876512345' })).body.contact;
    const hijack = await as(otherCookie, 'POST', `/api/inbox/${contact.id}/send`, { text: 'hi', sessionId: env.sessionId });
    expect(hijack.status).toBe(403);
    expect(env.fake.sent).toHaveLength(0);

    // A webhook for Test Shop's session posted to the other business's URL is ignored.
    const raw = JSON.stringify({ event: 'message.received', sessionId: env.sessionId, idempotencyKey: 'x1', data: inbound('919876599990', 'hello') });
    const res = await env.app.inject({
      method: 'POST',
      url: `/webhooks/openwa/${other.tenant.id}`,
      payload: raw,
      headers: { 'content-type': 'application/json', 'x-openwa-signature': signOpenWABody(raw, env.config.openwa.webhookSecret) },
    });
    expect(res.json().outcome).toBe('ignored');
    expect((await as(otherCookie, 'GET', '/api/contacts')).body.total).toBe(1);

    // Numbers it creates are prefixed on the gateway but shown with the plain name, and capped by plan.
    const created = await as(otherCookie, 'POST', '/api/sessions', { name: 'front-desk' });
    expect(created.body.name).toBe('front-desk');
    expect(env.fake.sessions.find(s => s.id === created.body.id)?.name).toBe(`${other.tenant.id}-front-desk`);
    expect(env.fake.webhooks.find(w => w.sessionId === created.body.id)?.url).toBe(`http://wa-reach.test/webhooks/openwa/${other.tenant.id}`);
    const second = await as(otherCookie, 'POST', '/api/sessions', { name: 'second-line' });
    expect(second.status).toBe(403);
    expect(second.body.error).toMatch(/plan allows 1/);
  });
});
