import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, inbound, type TestEnv } from './helpers.js';

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  await env.close();
});

describe('webhook security and idempotency', () => {
  it('rejects unsigned or wrongly signed deliveries', async () => {
    const bad = await env.webhook('message.received', inbound('919876511111', 'hi'), { secret: 'wrong-secret-wrong-secret' });
    expect(bad.status).toBe(401);
    const unsigned = await env.app.inject({
      method: 'POST',
      url: `/webhooks/openwa/${env.tenantId}`,
      payload: JSON.stringify({ event: 'message.received', sessionId: env.sessionId, data: inbound('919876511111', 'hi') }),
      headers: { 'content-type': 'application/json' },
    });
    expect(unsigned.statusCode).toBe(401);
    expect((await env.api('GET', '/api/contacts')).body.total).toBe(0);
  });

  it('processes a retried delivery once', async () => {
    const payload = inbound('919876511112', 'hello', 'wa_msg_1');
    const first = await env.webhook('message.received', payload, { key: 'same-key' });
    const retry = await env.webhook('message.received', payload, { key: 'same-key' });
    const refire = await env.webhook('message.received', payload, { key: 'other-key' });
    expect([first.body.outcome, retry.body.outcome, refire.body.outcome]).toEqual(['received', 'duplicate', 'duplicate_message']);
    const contacts = await env.api('GET', '/api/contacts');
    expect(contacts.body.total).toBe(1);
    const thread = await env.api('GET', `/api/inbox/${contacts.body.items[0].id}`);
    expect(thread.body.messages).toHaveLength(1);
  });

  it('ignores group messages and resolves @lid senders through OpenWA', async () => {
    const group = await env.webhook('message.received', { ...inbound('1', 'hi'), from: '120363000000000000@g.us', isGroup: true, kind: 'group' });
    expect(group.body.outcome).toBe('ignored');
    env.fake.lidMap.set('88888888888888@lid', '919876511113');
    const lid = await env.webhook('message.received', { ...inbound('1', 'hello'), from: '88888888888888@lid' });
    expect(lid.body.outcome).toBe('received');
    const contacts = await env.api('GET', '/api/contacts');
    expect(contacts.body.items[0]).toMatchObject({ phone: '919876511113', waStatus: 'valid', source: 'inbound', name: 'Customer' });
    const unresolved = await env.webhook('message.received', { ...inbound('1', 'hello'), from: '77777777777777@lid' });
    expect(unresolved.body.outcome).toBe('unresolved_sender');
  });
});

describe('consent keywords', () => {
  it('handles STOP and START with confirmations, and imports cannot override an opt-out', async () => {
    const stop = await env.webhook('message.received', inbound('919876522221', ' Stop! '));
    expect(stop.body.outcome).toBe('opted_out');
    let contact = (await env.api('GET', '/api/contacts')).body.items[0];
    expect(contact).toMatchObject({ consent: 'opted_out', consentSource: 'keyword' });

    // A CSV claiming opt-in must not re-subscribe them.
    const csv = 'phone,name\n919876522221,Test';
    await env.api('POST', '/api/contacts/import', { csv, mapping: { '0': 'phone', '1': 'name' }, consent: 'opted_in' });
    contact = (await env.api('GET', `/api/contacts/${contact.id}`)).body.contact;
    expect(contact.consent).toBe('opted_out');

    const start = await env.webhook('message.received', inbound('919876522221', 'START'));
    expect(start.body.outcome).toBe('opted_in');
    contact = (await env.api('GET', `/api/contacts/${contact.id}`)).body.contact;
    expect(contact.consent).toBe('opted_in');

    await env.run(10, 1000);
    const texts = env.fake.sent.map(m => m.text);
    expect(texts[0]).toMatch(/unsubscribed/);
    expect(texts[1]).toMatch(/subscribed/);
  });

  it('attributes an opt-out to the campaign that triggered it', async () => {
    await env.api('POST', '/api/contacts', { phone: '9876522222', name: 'Z' });
    const created = await env.api('POST', '/api/campaigns', { name: 'Promo', variants: [{ key: 'A', body: 'Deal' }] });
    await env.api('POST', `/api/campaigns/${created.body.id}/launch`, {});
    await env.run(2);
    await env.webhook('message.received', inbound('919876522222', 'unsubscribe'));
    const report = await env.api('GET', `/api/campaigns/${created.body.id}/report`);
    expect(report.body.campaign.stats.optedOut).toBe(1);
    expect(report.body.campaign.stats.replied).toBe(0);
  });
});

describe('auto-replies', () => {
  it('replies to keywords, applies actions and respects cooldown and priority', async () => {
    const tag = (await env.api('POST', '/api/tags', { name: 'pricing-lead' })).body;
    await env.api('POST', '/api/auto-replies', {
      name: 'Fallback',
      matchType: 'any',
      priority: 900,
      replyBody: 'Thanks! A human will reply soon.',
      cooldownMinutes: 1440,
    });
    const rule = await env.api('POST', '/api/auto-replies', {
      name: 'Price',
      matchType: 'contains',
      keywords: ['price', 'rate card'],
      priority: 10,
      replyBody: 'Hi {{first_name|there}}, our rate card: https://example.com/rates',
      actions: { addTagIds: [tag.id] },
      cooldownMinutes: 60,
    });
    expect(rule.status).toBe(201);

    const first = await env.webhook('message.received', { ...inbound('919876533331', 'What is the PRICE?'), contact: { pushName: 'Meera K' } });
    expect(first.body.outcome).toBe('auto_reply');
    const again = await env.webhook('message.received', inbound('919876533331', 'price again'));
    expect(again.body.outcome).toBe('auto_reply'); // falls through to the fallback while Price cools down
    const third = await env.webhook('message.received', inbound('919876533331', 'hello?'));
    expect(third.body.outcome).toBe('received'); // both rules cooling down

    await env.run(10, 1000);
    expect(env.fake.sent.map(m => m.text)).toEqual(['Hi Meera, our rate card: https://example.com/rates', 'Thanks! A human will reply soon.']);
    const contact = (await env.api('GET', '/api/contacts')).body.items[0];
    expect(contact.tags.map((t: { name: string }) => t.name)).toEqual(['pricing-lead']);

    const test = await env.api('POST', '/api/auto-replies/test', { text: 'rate card pls' });
    expect(test.body).toMatchObject({ match: 'rule', rule: { name: 'Price' } });
    expect((await env.api('POST', '/api/auto-replies/test', { text: 'stop' })).body.match).toBe('opt_out');
  });

  it('validates regex patterns', async () => {
    const res = await env.api('POST', '/api/auto-replies', { name: 'Bad', matchType: 'regex', keywords: ['(unclosed'], replyBody: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('drip sequences', () => {
  it('enrolls on tag, sends steps on schedule, and stops on reply', async () => {
    const tag = (await env.api('POST', '/api/tags', { name: 'new-lead' })).body;
    const seq = await env.api('POST', '/api/sequences', {
      name: 'Welcome',
      trigger: { type: 'tag_added', tagId: tag.id },
      steps: [
        { delayMinutes: 0, body: 'Welcome {{first_name}}!' },
        { delayMinutes: 60, body: 'Here is our catalogue.' },
        { delayMinutes: 1440, body: 'Any questions?' },
      ],
      options: { appendOptOut: false },
    });
    expect(seq.status).toBe(201);

    await env.api('POST', '/api/contacts', { phone: '9876544441', name: 'Ravi Kumar', tags: ['new-lead'] });
    await env.api('POST', '/api/contacts', { phone: '9876544442', name: 'Sita' });
    await env.run(2);
    expect(env.fake.sent.map(m => m.text)).toEqual(['Welcome Ravi!']);

    await env.run(1, 30 * 60_000);
    expect(env.fake.sent).toHaveLength(1);
    await env.run(1, 31 * 60_000);
    expect(env.fake.sent.map(m => m.text)).toEqual(['Welcome Ravi!', 'Here is our catalogue.']);

    // Replying stops the sequence (stopOnReply defaults to true).
    await env.webhook('message.received', inbound('919876544441', 'Thanks, interested'));
    await env.run(1, 25 * 3_600_000);
    expect(env.fake.sent).toHaveLength(2);
    const enrollments = await env.api('GET', `/api/sequences/${seq.body.id}/enrollments`);
    expect(enrollments.body.items[0]).toMatchObject({ status: 'stopped', stopReason: 'replied', currentStep: 2 });
  });

  it('enrolls on keyword opt-in and stops everything on opt-out', async () => {
    const seq = await env.api('POST', '/api/sequences', {
      name: 'Subscribers',
      trigger: { type: 'opted_in' },
      steps: [
        { delayMinutes: 5, body: 'Step one' },
        { delayMinutes: 5, body: 'Step two' },
      ],
      options: { appendOptOut: false, stopOnReply: false },
    });
    await env.webhook('message.received', inbound('919876544443', 'JOIN'));
    await env.run(3, 1000); // confirmation only
    expect(env.fake.sent.map(m => m.text)).toEqual([expect.stringMatching(/subscribed/)]);
    await env.run(1, 5 * 60_000);
    expect(env.fake.sent.at(-1)?.text).toBe('Step one');
    await env.webhook('message.received', inbound('919876544443', 'STOP'));
    await env.run(3, 10 * 60_000);
    expect(env.fake.sent.map(m => m.text)).not.toContain('Step two');
    const enrollments = await env.api('GET', `/api/sequences/${seq.body.id}/enrollments`);
    expect(enrollments.body.items[0]).toMatchObject({ status: 'stopped', stopReason: 'opted_out' });
  });
});

describe('auth', () => {
  it('requires login or API key, and logs in with the admin password', async () => {
    const anon = await env.app.inject({ method: 'GET', url: '/api/contacts' });
    expect(anon.statusCode).toBe(401);
    const wrong = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: env.owner.email, password: 'nope' } });
    expect(wrong.statusCode).toBe(401);
    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: env.owner });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect(cookie).toMatch(/^wr_session=/);
    const authed = await env.app.inject({ method: 'GET', url: '/api/contacts', headers: { cookie } });
    expect(authed.statusCode).toBe(200);
    const crossSite = await env.app.inject({
      method: 'POST',
      url: '/api/tags',
      payload: { name: 'x' },
      headers: { cookie, origin: 'https://evil.example', host: 'reach.example.com' },
    });
    expect(crossSite.statusCode).toBe(403);
  });
});

describe('inbox', () => {
  it('lists conversations, sends manual replies and tracks unread', async () => {
    await env.webhook('message.received', inbound('919876555551', 'Do you deliver to Indiranagar?'));
    const inbox = await env.api('GET', '/api/inbox');
    expect(inbox.body.unread).toBe(1);
    const convo = inbox.body.items[0];
    expect(convo).toMatchObject({ phone: '919876555551', unread: 1, lastDirection: 'in' });
    const sent = await env.api('POST', `/api/inbox/${convo.contactId}/send`, { text: 'Yes, same day!' });
    expect(sent.status).toBe(200);
    expect(env.fake.sent.at(-1)).toMatchObject({ chatId: '919876555551@c.us', text: 'Yes, same day!' });
    const after = await env.api('GET', '/api/inbox');
    expect(after.body.unread).toBe(0);
    expect(after.body.items[0].lastDirection).toBe('out');
  });
});

describe('default number', () => {
  it('adopts the first connected number when none is set, so drips can send', async () => {
    env.s.settings.update({ defaultSessionId: null });
    await env.api('POST', '/api/sequences', { name: 'Drip', steps: [{ delayMinutes: 0, body: 'Hello' }], options: { appendOptOut: false } });
    const contact = (await env.api('POST', '/api/contacts', { phone: '9876566661' })).body.contact;
    const seq = (await env.api('GET', '/api/sequences')).body[0];
    await env.api('POST', `/api/sequences/${seq.id}/enroll`, { contactIds: [contact.id] });
    await env.run(3);
    expect(env.s.settings.get().defaultSessionId).toBe(env.sessionId);
    expect(env.fake.sent.map(m => m.text)).toEqual(['Hello']);
  });
});
