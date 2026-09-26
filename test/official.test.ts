import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers.js';
import { signOpenWABody } from '../server/lib/crypto.js';

const PHONE_ID = '1098765432101';
const WABA = '2098765432101';
const TOKEN = 'EAAG' + 'x'.repeat(60);
const SECRET = 'abcdef0123456789abcdef0123456789';
const NUMBER = `official-${PHONE_ID}`;

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
  env.meta.addNumber({ id: PHONE_ID, wabaId: WABA, token: TOKEN });
  env.meta.templatesByWaba.set(WABA, [
    {
      id: 't1',
      name: 'diwali_offer',
      language: 'en',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, enjoy {{2}} off at our store!' },
        { type: 'FOOTER', text: 'Tap Stop promotions to opt out' },
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Shop now', url: 'https://shop.example.com/{{1}}' }, { type: 'QUICK_REPLY', text: 'Stop promotions' }] },
      ],
    },
    { id: 't2', name: 'pending_one', language: 'en', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hello' }] },
  ]);
});
afterEach(async () => {
  await env.close();
});

async function connect() {
  const res = await env.api('POST', '/api/official/numbers', { name: 'Main line', phoneNumberId: PHONE_ID, wabaId: WABA, accessToken: TOKEN, appSecret: SECRET });
  expect(res.status).toBe(201);
  return res.body;
}

async function metaWebhook(value: Record<string, unknown>, secret = SECRET) {
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: WABA, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, ...value } }] }],
  });
  const response = await env.app.inject({
    method: 'POST',
    url: `/webhooks/meta/${env.tenantId}`,
    payload: raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signOpenWABody(raw, secret) },
  });
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

const customerSays = (phone: string, text: string, id = `wamid.in.${Math.random().toString(36).slice(2)}`) =>
  metaWebhook({
    contacts: [{ wa_id: phone, profile: { name: 'Asha Rao' } }],
    messages: [{ from: phone, id, timestamp: String(Math.floor(env.clock.now().getTime() / 1000)), type: 'text', text: { body: text } }],
  });

describe('official WhatsApp numbers (Meta Cloud API)', () => {
  it('connects with verified credentials, stores them encrypted and never returns them', async () => {
    const number = await connect();
    expect(number).toMatchObject({ id: NUMBER, channel: 'official', status: 'ready', phone: '919900011111', pushName: 'Test Shop' });
    const raw = env.core.db.get<{ access_token: string; app_secret: string }>('SELECT access_token, app_secret FROM official_numbers');
    expect(raw!.access_token).not.toContain('xxxx');
    expect(raw!.app_secret).not.toContain(SECRET);

    const list = await env.api('GET', '/api/sessions');
    const body = JSON.stringify(list.body);
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain(SECRET);
    expect(list.body.items.find((s: { id: string }) => s.id === NUMBER).templates).toEqual({ approved: 1, total: 2 });

    const bad = await env.api('POST', '/api/official/numbers', { name: 'Other', phoneNumberId: '1098765432199', wabaId: WABA, accessToken: TOKEN, appSecret: SECRET });
    expect(bad.status).toBe(400);
    const wrongToken = await env.api('PATCH', `/api/official/numbers/${NUMBER}`, { accessToken: 'EAAG' + 'y'.repeat(60) });
    expect(wrongToken.status).toBe(400);
    expect(wrongToken.body.error).toMatch(/access token/i);
  });

  it('counts official numbers toward the plan limit', async () => {
    env.platform.updateTenant(env.tenantId, { maxNumbers: 1 });
    const res = await env.api('POST', '/api/official/numbers', { name: 'Main line', phoneNumberId: PHONE_ID, wabaId: WABA, accessToken: TOKEN, appSecret: SECRET });
    expect(res.status).toBe(403);
  });

  it('answers Meta’s webhook handshake only with the right verify token', async () => {
    const setup = await env.api('GET', '/api/official/setup');
    expect(setup.body.webhookUrl).toBe(`https://reach.example.com/webhooks/meta/${env.tenantId}`);
    const ok = await env.app.inject({
      method: 'GET',
      url: `/webhooks/meta/${env.tenantId}?hub.mode=subscribe&hub.verify_token=${setup.body.verifyToken}&hub.challenge=12345`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('12345');
    const wrong = await env.app.inject({ method: 'GET', url: `/webhooks/meta/${env.tenantId}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345` });
    expect(wrong.statusCode).toBe(403);
    expect((await env.api('GET', '/api/official/setup')).body.webhookVerifiedAt).toBeTruthy();
  });

  it('refuses unsigned or wrongly signed webhooks', async () => {
    await connect();
    expect((await customerSays('919876500001', 'hi')).status).toBe(200);
    const forged = await metaWebhook({ messages: [{ from: '919876500002', id: 'x', type: 'text', text: { body: 'hi' } }] }, 'wrong-secret-wrong-secret');
    expect(forged.status).toBe(401);
    expect(env.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM contacts WHERE phone = '919876500002'")!.n).toBe(0);
  });

  it('receives replies into the inbox and answers free-form only inside the 24-hour window', async () => {
    await connect();
    // Before the customer writes, a free-form message is refused without calling Meta.
    const contact = await env.api('POST', '/api/contacts', { phone: '+919876500001', name: 'Asha Rao' });
    const early = await env.api('POST', `/api/inbox/${contact.body.contact.id}/send`, { text: 'Hello!', sessionId: NUMBER });
    expect(early.status).toBe(400);
    expect(early.body.error).toMatch(/24-hour/);
    expect(env.meta.sent).toHaveLength(0);

    const received = await customerSays('919876500001', 'Do you have sizes?');
    expect(received.body).toMatchObject({ ok: true, messages: 1 });
    const thread = await env.api('GET', `/api/inbox/${contact.body.contact.id}`);
    expect(thread.body.sessionId).toBe(NUMBER);
    expect(thread.body.official.windowOpenUntil).toBeTruthy();
    expect(thread.body.messages.at(-1)).toMatchObject({ direction: 'in', body: 'Do you have sizes?' });

    const reply = await env.api('POST', `/api/inbox/${contact.body.contact.id}/send`, { text: 'Yes, all sizes!' });
    expect(reply.status).toBe(200);
    expect(env.meta.sent[0].message).toMatchObject({ to: '919876500001', type: 'text', text: { body: 'Yes, all sizes!' } });

    env.clock.advance(25 * 3_600_000);
    const late = await env.api('POST', `/api/inbox/${contact.body.contact.id}/send`, { text: 'Still there?' });
    expect(late.status).toBe(400);
  });

  it('sends campaigns as approved templates and tracks receipts, failures and opt-outs', async () => {
    await connect();
    for (const [phone, name] of [
      ['+919876500001', 'Asha Rao'],
      ['+919876500002', ''],
      ['+919876500003', 'Chitra'],
    ]) {
      await env.api('POST', '/api/contacts', { phone, name });
    }

    const plain = await env.api('POST', '/api/campaigns', { name: 'No template', sessionId: NUMBER, audience: { type: 'all' }, variants: [{ key: 'A', body: 'Hi' }] });
    const refused = await env.api('POST', `/api/campaigns/${plain.body.id}/launch`, {});
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/approved template/);

    const pending = await env.api('POST', '/api/campaigns', {
      name: 'Pending',
      sessionId: NUMBER,
      audience: { type: 'all' },
      variants: [{ key: 'A', template: { name: 'pending_one', language: 'en' } }],
    });
    expect((await env.api('POST', `/api/campaigns/${pending.body.id}/launch`, {})).body.error).toMatch(/not approved/);

    const campaign = await env.api('POST', '/api/campaigns', {
      name: 'Diwali',
      sessionId: NUMBER,
      audience: { type: 'all' },
      variants: [{ key: 'A', template: { name: 'diwali_offer', language: 'en', params: { 'body:1': '{{first_name|there}}', 'body:2': '20%', 'button:0:1': 'diwali?c={{first_name|x}}' } } }],
      options: { perMinute: 60 },
    });
    expect(campaign.status).toBe(201);
    const launched = await env.api('POST', `/api/campaigns/${campaign.body.id}/launch`, {});
    expect(launched.status).toBe(200);
    await env.run(60, 1000);

    expect(env.meta.sent).toHaveLength(3);
    const asha = env.meta.sent.find(s => s.message.to === '919876500001')!.message;
    expect(asha).toMatchObject({ type: 'template', template: { name: 'diwali_offer', language: { code: 'en' } } });
    expect(asha.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Asha' }, { type: 'text', text: '20%' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'diwali?c=Asha' }] },
    ]);
    const nameless = env.meta.sent.find(s => s.message.to === '919876500002')!.message;
    expect(nameless.template.components[0].parameters[0].text).toBe('there');

    // The inbox shows the filled-in template text.
    const logged = env.core.db.get<{ body: string; session_id: string }>("SELECT body, session_id FROM messages WHERE source_type = 'campaign' ORDER BY id LIMIT 1");
    expect(logged!.session_id).toBe(NUMBER);
    expect(logged!.body).toContain('enjoy 20% off');

    // Receipts from Meta: Asha read it, the second number stopped marketing messages.
    const ids = env.meta.sent.map(s => ({ to: s.message.to, id: '' }));
    const rows = env.core.db.all<{ wa_message_id: string; phone: string }>(
      "SELECT m.wa_message_id, c.phone FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.source_type = 'campaign'",
    );
    expect(rows).toHaveLength(ids.length);
    const idFor = (phone: string) => rows.find(r => r.phone === phone)!.wa_message_id;
    await metaWebhook({
      statuses: [
        { id: idFor('919876500001'), status: 'delivered', recipient_id: '919876500001' },
        { id: idFor('919876500001'), status: 'read', recipient_id: '919876500001' },
        { id: idFor('919876500002'), status: 'failed', recipient_id: '919876500002', errors: [{ code: 131050, title: 'stopped' }] },
      ],
    });
    const report = await env.api('GET', `/api/campaigns/${campaign.body.id}/report`);
    expect(report.body.campaign.stats).toMatchObject({ read: 1, failed: 1 });
    expect(report.body.failureReasons[0].reason).toMatch(/stopped marketing messages/);
    expect(env.core.db.get<{ consent: string }>("SELECT consent FROM contacts WHERE phone = '919876500002'")!.consent).toBe('opted_out');
  });

  it('treats the Stop promotions button as an opt-out', async () => {
    await connect();
    await metaWebhook({
      messages: [{ from: '919876500009', id: 'wamid.btn', timestamp: '0', type: 'button', button: { text: 'Stop promotions', payload: 'STOP' } }],
    });
    expect(env.core.db.get<{ consent: string }>("SELECT consent FROM contacts WHERE phone = '919876500009'")!.consent).toBe('opted_out');
  });

  it('pauses a campaign when Meta says the template itself is broken', async () => {
    await connect();
    await env.api('POST', '/api/contacts', { phone: '+919876500001', name: 'Asha' });
    const campaign = await env.api('POST', '/api/campaigns', {
      name: 'Diwali',
      sessionId: NUMBER,
      audience: { type: 'all' },
      variants: [{ key: 'A', template: { name: 'diwali_offer', language: 'en', params: { 'body:1': 'x', 'body:2': 'y', 'button:0:1': 'z' } } }],
    });
    env.meta.failNext = { code: 132015 };
    await env.api('POST', `/api/campaigns/${campaign.body.id}/launch`, {});
    await env.run(5, 1000);
    const after = await env.api('GET', `/api/campaigns/${campaign.body.id}`);
    expect(after.body.status).toBe('paused');
    expect(after.body.pausedReason).toMatch(/paused by Meta/);
    expect(after.body.stats).toMatchObject({ queued: 1, failed: 0 });
  });

  it('marks the number as needing attention when the token stops working', async () => {
    await connect();
    env.meta.numbers.get(PHONE_ID)!.token = 'EAAG-rotated';
    const checked = await env.api('POST', `/api/official/numbers/${NUMBER}/check`, {});
    expect(checked.body).toMatchObject({ status: 'failed' });
    expect(checked.body.lastError).toMatch(/access token/i);
    const qr = await env.api('GET', `/api/sessions/${NUMBER}/qr`);
    expect(qr.status).toBe(400);
  });
});
