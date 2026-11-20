import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers.js';
import { addDays } from '../server/services/analytics.js';

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
function as(cookie: string) {
  return async (method: string, url: string, body?: unknown) => {
    const res = await env.app.inject({ method: method as 'GET', url, payload: body as object | undefined, headers: { cookie } });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
}

describe('the dashboard', () => {
  it('adds up messages, chats, contacts, leads, calls and the team for the chosen days', async () => {
    const admin = as(await login(env.owner.email, env.owner.password));
    const caller = (await admin('POST', '/api/account/users', { email: 'shreyas@shop.example', name: 'Shreyas', role: 'caller' })).body;
    const other = (await admin('POST', '/api/account/users', { email: 'geetha@shop.example', name: 'Geetha', role: 'caller' })).body;

    const add = async (phone: string, name: string) => (await env.api('POST', '/api/contacts', { phone, name })).body.contact.id as number;
    const asha = await add('+91 98765 00001', 'Asha');
    const ravi = await add('+91 98765 00002', 'Ravi');
    const meena = await add('+91 98765 00003', 'Meena');
    await admin('POST', '/api/leads/assign', { ids: [asha, ravi], userId: caller.user.id });
    await admin('PUT', `/api/contacts/${asha}/lead`, { stage: 'warm' });
    await admin('PUT', `/api/contacts/${ravi}/lead`, { stage: 'closed' });

    const now = env.clock.now().getTime();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
    const message = (contact: number, direction: 'in' | 'out', status: string, source: string, hoursAgo: number) =>
      env.core.db.run(
        `INSERT INTO messages (contact_id, session_id, chat_id, direction, type, body, status, source_type, seen, created_at)
         VALUES (?, 'main', 'x@c.us', ?, 'text', 'hi', ?, ?, 1, ?)`,
        contact,
        direction,
        status,
        source,
        at(hoursAgo),
      );
    // Asha wrote in and was answered; Meena wrote in last and is waiting.
    message(asha, 'in', 'received', 'inbound', 5);
    message(asha, 'out', 'delivered', 'manual', 4);
    message(meena, 'out', 'read', 'auto_reply', 3);
    message(meena, 'in', 'received', 'inbound', 2);
    message(ravi, 'out', 'failed', 'campaign', 1);
    // Twenty days ago: in the 14 days before, so it counts for "vs before" only.
    message(ravi, 'out', 'read', 'manual', 20 * 24);

    // Shreyas's phone: one call to Asha, answered.
    const token = (await env.app.inject({ method: 'POST', url: '/device-api/login', payload: { email: 'shreyas@shop.example', password: caller.password } })).json().token;
    await env.app.inject({
      method: 'POST',
      url: '/device-api/calls',
      headers: { authorization: `Bearer ${token}` },
      payload: { calls: [{ number: '9876500001', type: 2, startedAt: now - 30 * 60_000, duration: 95 }] },
    });

    const res = await admin('GET', '/api/dashboard');
    expect(res.status).toBe(200);
    const d = res.body;
    expect(d.range).toMatchObject({ days: 14 });
    expect(d.range.from).toBe(addDays(d.range.to, -13));

    // Messages: totals, outcomes, who sent them, and the 14 days before.
    expect(d.messages).toMatchObject({ sent: 3, delivered: 2, read: 1, failed: 1, received: 2, before: { sent: 1, received: 0 } });
    expect(d.messages.senders).toEqual({ inbox: 1, autoReply: 1, phone: 0, marketing: 1, other: 0 });
    expect(d.messages.series).toHaveLength(14);
    const sum = (key: string) => d.messages.series.reduce((n: number, p: Record<string, number>) => n + p[key], 0);
    expect([sum('sent'), sum('received'), sum('delivered'), sum('read')]).toEqual([3, 2, 2, 1]);

    // Chats: two people wrote in; Meena's last message is hers, so she's waiting.
    expect(d.chats).toMatchObject({ conversations: 2, waiting: 1 });
    expect(d.contacts).toMatchObject({ total: 3, added: 3, addedBefore: 0 });

    // Leads: the funnel is nested, and the stages add up to the total.
    expect(d.leads.total).toBe(3);
    expect(d.leads.byStage).toEqual({ untouched: 1, warm: 1, cold: 0, closed: 1 });
    expect(d.leads.funnel.map((s: { count: number }) => s.count)).toEqual([3, 2, 2, 1]);
    expect(d.leads).toMatchObject({ unassigned: 1, unassignedUntouched: 1 });

    // Calls and the team: every caller listed, with their leads, calls and phone.
    expect(d.calls).toMatchObject({ calls: 1, answered: 1, talkSeconds: 95 });
    expect(d.team.find((t: { userId: number }) => t.userId === caller.user.id)).toMatchObject({ leads: 2, calls: 1, talkSeconds: 95, callApp: 'working' });
    expect(d.team.find((t: { userId: number }) => t.userId === other.user.id)).toMatchObject({ leads: 0, calls: 0, callApp: 'none' });
    expect(d.setup).toMatchObject({ autoAssign: false, callApp: { callers: 2, connected: 1 }, phonesNeedingHelp: 0 });
  });

  it('takes the days asked for, and refuses ranges that make no sense', async () => {
    const admin = as(await login(env.owner.email, env.owner.password));
    const today = (await admin('GET', '/api/dashboard')).body.range.to as string;
    const week = (await admin('GET', `/api/dashboard?from=${addDays(today, -6)}&to=${today}`)).body;
    expect(week.range).toMatchObject({ days: 7, previous: { from: addDays(today, -13), to: addDays(today, -7) } });
    expect(week.messages.series).toHaveLength(7);
    // "The last 30 days" and "today", in the business's own calendar.
    expect((await admin('GET', '/api/dashboard?days=30')).body.range).toMatchObject({ days: 30, from: addDays(today, -29), to: today });
    expect((await admin('GET', '/api/dashboard?days=1')).body.range).toMatchObject({ days: 1, from: today, to: today });
    expect((await admin('GET', `/api/dashboard?from=${today}&to=${addDays(today, -1)}`)).status).toBe(400);
    expect((await admin('GET', `/api/dashboard?from=${addDays(today, -400)}&to=${today}`)).status).toBe(400);
    expect((await admin('GET', '/api/dashboard?from=yesterday')).status).toBe(400);
  });

  it('is not for callers', async () => {
    const admin = as(await login(env.owner.email, env.owner.password));
    const caller = (await admin('POST', '/api/account/users', { email: 'c@shop.example', role: 'caller' })).body;
    const asCaller = as(await login('c@shop.example', caller.password));
    expect((await asCaller('GET', '/api/dashboard')).status).toBe(403);
  });
});
