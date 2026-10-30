import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestEnv, type TestEnv } from './helpers.js';
import { openDatabase } from '../server/db/database.js';
import { PLATFORM_MIGRATIONS } from '../server/platform/schema.js';

let env: TestEnv;
beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  await env.close();
});

async function login(email: string, password: string): Promise<string> {
  const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  expect(res.statusCode, `sign in as ${email}`).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0];
}

/** API calls signed in as someone (with their session cookie), like the browser makes them. */
function as(cookie: string) {
  return async (method: string, url: string, body?: unknown) => {
    const res = await env.app.inject({ method: method as 'GET', url, payload: body as object | undefined, headers: { cookie } });
    let parsed: any = res.body;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      // CSV and other text bodies stay as text.
    }
    return { status: res.statusCode, body: parsed };
  };
}

const addLead = async (phone: string, name: string): Promise<number> => (await env.api('POST', '/api/contacts', { phone, name })).body.contact.id;

describe('team roles', () => {
  it('lets the admin add callers who only work the leads given to them', async () => {
    const admin = as(await login(env.owner.email, env.owner.password));
    const ram = await admin('POST', '/api/account/users', { email: 'ramgopal@shop.example', name: 'Ramgopal', role: 'caller' });
    expect(ram.status).toBe(201);
    expect(ram.body.user).toMatchObject({ role: 'caller', leadScope: 'assigned', name: 'Ramgopal' });
    const akshay = (await admin('POST', '/api/account/users', { email: 'akshay@shop.example', role: 'caller' })).body;

    const asha = await addLead('9876500001', 'Asha');
    const ravi = await addLead('9876500002', 'Ravi');
    const kiran = await addLead('9876500003', 'Kiran');

    // The admin gives leads out; only to people in the team.
    expect((await admin('POST', '/api/leads/assign', { ids: [asha, ravi], userId: ram.body.user.id })).body).toEqual({ affected: 2 });
    await admin('POST', '/api/leads/assign', { ids: [kiran], userId: akshay.user.id });
    expect((await admin('POST', '/api/leads/assign', { ids: [asha], userId: 999 })).status).toBe(400);
    expect((await admin('GET', '/api/team')).body.items.map((m: any) => [m.email, m.role])).toEqual([
      [env.owner.email, 'owner'],
      ['akshay@shop.example', 'caller'],
      ['ramgopal@shop.example', 'caller'],
    ]);
    expect((await admin('GET', `/api/contacts?assignee=${ram.body.user.id}`)).body.total).toBe(2);
    expect((await admin('GET', '/api/contacts?assignee=none')).body.total).toBe(0);
    expect((await admin('GET', `/api/leads/report?assignee=${akshay.user.id}`)).body.total).toBe(1);

    const caller = as(await login('ramgopal@shop.example', ram.body.password));
    // The business's name, but not its plan, price or payments.
    const me = (await caller('GET', '/api/auth/me')).body;
    expect(me.user).toMatchObject({ role: 'caller', email: 'ramgopal@shop.example' });
    expect(me.tenant).toEqual({ id: env.tenantId, name: 'Test Shop', status: 'active', access: 'active' });

    // Only their own leads, even when asking for someone else's.
    const names = async (url: string) => ((await caller('GET', url)).body.items as Array<{ name: string }>).map(c => c.name).sort();
    expect(await names('/api/contacts?pageSize=500')).toEqual(['Asha', 'Ravi']);
    expect(await names(`/api/contacts?assignee=${akshay.user.id}`)).toEqual(['Asha', 'Ravi']);
    expect((await caller('GET', '/api/leads/report')).body.total).toBe(2);

    // Stage and call remark on their own leads, signed with their name.
    const saved = await caller('PUT', `/api/contacts/${asha}/lead`, { stage: 'warm', remark: 'Visiting the showroom on Sunday' });
    expect(saved.body).toMatchObject({ leadStage: 'warm', leadRemark: 'Visiting the showroom on Sunday', leadRemarkBy: 'Ramgopal' });
    expect((await caller('PUT', `/api/contacts/${kiran}/lead`, { stage: 'cold' })).status).toBe(404);

    // Nothing else: no inbox, export, contact details, campaigns, team, billing or settings.
    const refused: Array<[string, string]> = [
      ['GET', '/api/inbox'],
      ['GET', '/api/contacts/export.csv'],
      ['GET', `/api/contacts/${asha}`],
      ['PATCH', `/api/contacts/${asha}`],
      ['DELETE', `/api/contacts/${asha}`],
      ['POST', '/api/contacts/bulk'],
      ['GET', '/api/campaigns'],
      ['GET', '/api/lead-sources'],
      ['POST', '/api/leads/assign'],
      ['GET', '/api/team'],
      ['GET', '/api/settings'],
      ['GET', '/api/account/'],
      ['POST', '/api/account/users'],
      ['POST', '/api/account/password'],
    ];
    for (const [method, url] of refused) {
      const res = await caller(method, url, method === 'GET' ? undefined : {});
      expect(res.status, `${method} ${url}`).toBe(403);
      expect(res.body.error).toMatch(/Callers can only use the Leads page/);
    }

    // The admin can let a caller see every lead.
    expect((await admin('PATCH', `/api/account/users/${ram.body.user.id}`, { leadScope: 'all' })).body.leadScope).toBe('all');
    expect((await caller('GET', '/api/contacts')).body.total).toBe(3);
    expect((await caller('PUT', `/api/contacts/${kiran}/lead`, { stage: 'cold' })).status).toBe(200);
  });

  it('only the admin sets passwords and manages the team', async () => {
    const admin = as(await login(env.owner.email, env.owner.password));
    const added = (await admin('POST', '/api/account/users', { email: 'caller@shop.example', role: 'caller' })).body;
    const caller = as(await login('caller@shop.example', added.password));
    expect((await caller('POST', '/api/account/password', { current: added.password, next: 'my-own-password' })).status).toBe(403);

    // A password the admin types in: the caller is signed out and signs in with the new one.
    expect((await admin('POST', `/api/account/users/${added.user.id}/password`, { password: 'naveen-tiles-2026' })).body).toEqual({ password: 'naveen-tiles-2026' });
    expect((await caller('GET', '/api/contacts')).status).toBe(401);
    await login('caller@shop.example', 'naveen-tiles-2026');
    // Or one made up for them.
    const made = (await admin('POST', `/api/account/users/${added.user.id}/password`, {})).body.password;
    await login('caller@shop.example', made);
    expect((await admin('POST', `/api/account/users/${added.user.id}/password`, { password: 'short' })).status).toBe(400);
    // The admin's own account is changed from its own password form, and can't be removed.
    const ownerId = (await admin('GET', '/api/account/')).body.users.find((u: any) => u.role === 'owner').id;
    expect((await admin('POST', `/api/account/users/${ownerId}/password`, { password: 'whatever-1234' })).status).toBe(400);
    expect((await admin('DELETE', `/api/account/users/${ownerId}`)).status).toBe(400);
    expect((await admin('PATCH', `/api/account/users/${ownerId}`, { role: 'caller' })).status).toBe(400);

    // A full-access team member works everywhere but can't manage the team or passwords.
    const member = (await admin('POST', '/api/account/users', { email: 'manager@shop.example', role: 'member' })).body;
    const manager = as(await login('manager@shop.example', member.password));
    expect((await manager('GET', '/api/inbox')).status).toBe(200);
    expect((await manager('POST', `/api/account/users/${added.user.id}/password`, {})).status).toBe(403);
    expect((await manager('POST', '/api/account/users', { email: 'x@shop.example', role: 'member' })).status).toBe(403);
    // Turned into a caller, they lose everything but the Leads page at once.
    await admin('PATCH', `/api/account/users/${member.user.id}`, { role: 'caller' });
    expect((await manager('GET', '/api/inbox')).status).toBe(403);
    expect((await manager('GET', '/api/contacts')).status).toBe(200);
  });

  it('gives new leads to callers in turn, and hands them back when a caller is removed', async () => {
    const admin = as(await login(env.owner.email, env.owner.password));
    const one = (await admin('POST', '/api/account/users', { email: 'one@shop.example', role: 'caller' })).body.user;
    const two = (await admin('POST', '/api/account/users', { email: 'two@shop.example', role: 'caller' })).body.user;
    expect((await admin('POST', '/api/lead-sources', { name: 'Bad', actions: { assignTo: [12345] } })).status).toBe(400);
    const source = (await admin('POST', '/api/lead-sources', { name: 'Website', kind: 'website', actions: { assignTo: [one.id, two.id] } })).body;
    expect(source.actions.assignTo).toEqual([one.id, two.id]);

    const send = (phone: string) => env.app.inject({ method: 'POST', url: new URL(source.url).pathname, payload: { name: 'Lead', phone } });
    for (const phone of ['9876500011', '9876500012', '9876500013']) expect((await send(phone)).statusCode).toBe(200);
    // The same number again is a duplicate and keeps its caller.
    await send('9876500011');
    const given = () => env.core.db.all<{ assigned_to: number | null }>('SELECT assigned_to FROM contacts ORDER BY id').map(r => r.assigned_to);
    expect(given()).toEqual([one.id, two.id, one.id]);

    // Removing a caller: their leads go back to no one, and the source stops giving them leads.
    expect((await admin('DELETE', `/api/account/users/${one.id}`)).status).toBe(200);
    expect(given()).toEqual([null, two.id, null]);
    expect((await admin('GET', `/api/lead-sources/${source.id}`)).body.source.actions.assignTo).toEqual([two.id]);
    await send('9876500014');
    expect(given()).toEqual([null, two.id, null, two.id]);
  });

  it('upgrades an older account database without losing who recorded payments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-reach-platform-'));
    try {
      const path = join(dir, 'platform.sqlite');
      const old = openDatabase(path, PLATFORM_MIGRATIONS.slice(0, 1));
      old.run("INSERT INTO tenants (id, name, paid_until, created_at, updated_at) VALUES ('abcd', 'Shop', '2026-12-01', 't', 't')");
      old.run("INSERT INTO users (id, email, password_hash, role, tenant_id, created_at) VALUES (1, 'admin@x.example', 'h', 'platform_admin', NULL, 't')");
      old.run("INSERT INTO users (id, email, password_hash, role, tenant_id, created_at) VALUES (2, 'owner@x.example', 'h', 'owner', 'abcd', 't')");
      old.run("INSERT INTO payments (tenant_id, amount, months, method, period_start, period_end, recorded_by, paid_at) VALUES ('abcd', 1000, 1, 'upi', 'a', 'b', 1, 'c')");
      old.close();

      const db = openDatabase(path, PLATFORM_MIGRATIONS);
      expect(db.get('SELECT recorded_by FROM payments')).toEqual({ recorded_by: 1 });
      expect(db.all('SELECT id, role, lead_scope FROM users ORDER BY id')).toEqual([
        { id: 1, role: 'platform_admin', lead_scope: 'assigned' },
        { id: 2, role: 'owner', lead_scope: 'assigned' },
      ]);
      db.run("INSERT INTO users (email, password_hash, role, tenant_id, created_at) VALUES ('caller@x.example', 'h', 'caller', 'abcd', 't')");
      expect(() => db.run("INSERT INTO users (email, password_hash, role, created_at) VALUES ('boss@x.example', 'h', 'boss', 't')")).toThrow();
      expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
      // Deleting a business still removes its users.
      db.run("DELETE FROM tenants WHERE id = 'abcd'");
      expect(db.all('SELECT email FROM users')).toEqual([{ email: 'admin@x.example' }]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
