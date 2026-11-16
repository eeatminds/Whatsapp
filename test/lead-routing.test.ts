import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTestEnv, type TestEnv } from './helpers.js';

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
function as(cookie: string) {
  return async (method: string, url: string, body?: unknown) => {
    const res = await env.app.inject({ method: method as 'GET', url, payload: body as object | undefined, headers: { cookie } });
    let parsed: any = res.body;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      // non-JSON bodies stay as text
    }
    return { status: res.statusCode, body: parsed };
  };
}
const postLead = (url: string, body: Record<string, string>) =>
  env.app.inject({ method: 'POST', url: new URL(url).pathname, payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const assigneeOf = (phone: string) =>
  env.core.db.get<{ assigned_to: number | null }>('SELECT assigned_to FROM contacts WHERE phone = ?', phone)?.assigned_to ?? null;

describe('auto-assigning new leads between callers', () => {
  it('shares new leads round-robin among all callers, unless the source or settings say otherwise', async () => {
    const admin = as(await login(env.owner.email, env.owner.password));
    const a = (await admin('POST', '/api/account/users', { email: 'a@shop.example', name: 'Asha', role: 'caller' })).body.user;
    const b = (await admin('POST', '/api/account/users', { email: 'b@shop.example', name: 'Bala', role: 'caller' })).body.user;
    const source = (await admin('POST', '/api/lead-sources', { name: 'Website', kind: 'website' })).body;

    // Off by default: new leads go to no one.
    await postLead(source.url, { name: 'Zero', phone: '+91 90000 00000' });
    expect(assigneeOf('919000000000')).toBeNull();

    // Turn on auto-assign among all callers: leads alternate A, B, A, B…
    expect((await admin('PUT', '/api/settings', { autoAssign: { enabled: true, among: 'all', userIds: [] } })).status).toBe(200);
    for (const phone of ['919000000001', '919000000002', '919000000003', '919000000004']) await postLead(source.url, { name: 'Lead', phone });
    expect([assigneeOf('919000000001'), assigneeOf('919000000002'), assigneeOf('919000000003'), assigneeOf('919000000004')]).toEqual([a.id, b.id, a.id, b.id]);

    // A newly added caller joins the rotation automatically under "all callers".
    const c = (await admin('POST', '/api/account/users', { email: 'c@shop.example', name: 'Chandra', role: 'caller' })).body.user;
    for (const phone of ['919000000005', '919000000006', '919000000007']) await postLead(source.url, { name: 'Lead', phone });
    expect([assigneeOf('919000000005'), assigneeOf('919000000006'), assigneeOf('919000000007')]).toEqual([a.id, b.id, c.id]);

    // Only the chosen callers: validated against the team, and leads only go to them.
    expect((await admin('PUT', '/api/settings', { autoAssign: { enabled: true, among: 'chosen', userIds: [999999] } })).status).toBe(400);
    await admin('PUT', '/api/settings', { autoAssign: { enabled: true, among: 'chosen', userIds: [b.id] } });
    for (const phone of ['919000000008', '919000000009']) await postLead(source.url, { name: 'Lead', phone });
    expect([assigneeOf('919000000008'), assigneeOf('919000000009')]).toEqual([b.id, b.id]);

    // A lead source that names its own people still wins over the business-wide default.
    const own = (await admin('POST', '/api/lead-sources', { name: 'Instagram', kind: 'website', actions: { assignTo: [a.id] } })).body;
    await postLead(own.url, { name: 'Lead', phone: '919000000010' });
    expect(assigneeOf('919000000010')).toBe(a.id);

    // Removing a caller takes them out of the chosen list and hands their leads back.
    await admin('DELETE', `/api/account/users/${b.id}`);
    expect((await admin('GET', '/api/settings')).body.autoAssign.userIds).toEqual([]);
    expect(assigneeOf('919000000008')).toBeNull();
  });
});

describe('a caller limited to one tag', () => {
  it('sees and works only the leads carrying their tag', async () => {
    const admin = as(await login(env.owner.email, env.owner.password));
    const website = (await admin('POST', '/api/tags', { name: 'website' })).body;
    const walkin = (await admin('POST', '/api/tags', { name: 'walk-in' })).body;

    // A tag scope needs a tag that exists.
    expect((await admin('POST', '/api/account/users', { email: 'x@shop.example', role: 'caller', leadScope: 'tag', leadTag: 999999 })).status).toBe(400);
    const caller = (await admin('POST', '/api/account/users', { email: 'web@shop.example', name: 'Web caller', role: 'caller', leadScope: 'tag', leadTag: website.id })).body;
    expect(caller.user).toMatchObject({ leadScope: 'tag', leadTag: website.id });

    const online = (await env.api('POST', '/api/contacts', { phone: '+91 98765 00001', name: 'Online lead', tagIds: [website.id] })).body.contact.id;
    const shop = (await env.api('POST', '/api/contacts', { phone: '+91 98765 00002', name: 'Walk-in lead', tagIds: [walkin.id] })).body.contact.id;

    const web = as(await login('web@shop.example', caller.password));
    // Only the website-tagged lead is visible, whoever it is assigned to.
    expect((await web('GET', '/api/contacts?pageSize=100')).body.items.map((c: any) => c.id)).toEqual([online]);
    expect((await web('GET', `/api/calls/summary?ids=${online},${shop}`)).body.leads).toHaveProperty(String(online));
    expect((await web('GET', `/api/calls/summary?ids=${online},${shop}`)).body.leads).not.toHaveProperty(String(shop));
    // Can work their tag's lead, but not one outside the tag (indistinguishable from "not found").
    expect((await web('PUT', `/api/contacts/${online}/lead`, { stage: 'warm' })).status).toBe(200);
    expect((await web('PUT', `/api/contacts/${shop}/lead`, { stage: 'warm' })).status).toBe(404);

    // Switching the caller to a different tag changes what they see; the report is scoped too.
    await admin('PATCH', `/api/account/users/${caller.user.id}`, { leadTag: walkin.id });
    expect((await web('GET', '/api/contacts?pageSize=100')).body.items.map((c: any) => c.id)).toEqual([shop]);
    expect((await web('GET', '/api/leads/report')).body.total).toBe(1);
  });
});

describe('inbox cleanup keeps space in check', () => {
  const insertMessage = (contactId: number, daysAgo: number, mediaFile: string | null) => {
    const at = new Date(env.clock.now().getTime() - daysAgo * 86_400_000).toISOString();
    const id = env.core.db.run(
      `INSERT INTO messages (contact_id, session_id, chat_id, direction, type, body, status, source_type, seen, created_at, media_file)
       VALUES (?, 'main', '919000000001@c.us', 'in', ?, 'hi', 'received', 'inbound', 0, ?, ?)`,
      contactId,
      mediaFile ? 'image' : 'text',
      at,
      mediaFile,
    ).lastInsertRowid;
    return id;
  };

  it('deletes messages (and their files) older than the chosen days, keeping the contact', async () => {
    const contact = (await env.api('POST', '/api/contacts', { phone: '+91 98765 00001', name: 'Old chat' })).body.contact.id;
    const oldId = insertMessage(contact, 40, `m1`);
    insertMessage(contact, 2, null);
    const dir = join(dirname(env.config.mediaDir), 'chat-media');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'm1');
    writeFileSync(file, 'audio-or-image-bytes');
    expect(oldId).toBeTruthy();

    // 0 days keeps everything.
    expect(env.s.chatMedia.pruneOldMessages(0)).toEqual({ messages: 0, files: 0 });
    // 30 days removes the 40-day-old message and its file, keeps the recent one and the contact.
    expect(env.s.chatMedia.pruneOldMessages(30)).toEqual({ messages: 1, files: 1 });
    expect(existsSync(file)).toBe(false);
    expect(env.core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE contact_id = ?', contact)!.n).toBe(1);
    expect(env.core.db.get('SELECT 1 FROM contacts WHERE id = ?', contact)).toBeTruthy();
  });
});
