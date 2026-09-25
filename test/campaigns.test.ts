import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, inbound, type TestEnv } from './helpers.js';

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  await env.close();
});

async function importContacts(rows: string[], extra: Record<string, unknown> = {}) {
  const csv = ['phone,name,city,tags', ...rows].join('\n');
  const preview = await env.api('POST', '/api/contacts/import/preview', { csv });
  expect(preview.status).toBe(200);
  const result = await env.api('POST', '/api/contacts/import', { csv, mapping: preview.body.mapping, ...extra });
  expect(result.status).toBe(200);
  return result.body;
}

describe('campaign lifecycle', () => {
  it('sends a personalized, paced, tracked campaign and records the funnel', async () => {
    const imported = await importContacts([
      '+91 98765 00001,Asha Rao,Pune,vip',
      '98765 00002,Ben,Mumbai,vip',
      '98765 00003,Chitra,Pune,',
      'not-a-number,Bad,Nowhere,',
      '98765 00001,Dup,Pune,',
    ]);
    expect(imported).toMatchObject({ total: 5, created: 3, skipped: 2 });
    expect(imported.errors.map((e: { row: number }) => e.row)).toEqual([5, 6]);

    const created = await env.api('POST', '/api/campaigns', {
      name: 'Diwali sale',
      audience: { type: 'all' },
      variants: [{ key: 'A', body: 'Hi {{first_name|there}} from {{city}}! 20% off: https://shop.example.com/diwali' }],
      options: { perMinute: 30 },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const preview = await env.api('POST', '/api/campaigns/audience-preview', { audience: { type: 'all' } });
    expect(preview.body).toMatchObject({ matched: 3, eligible: 3 });

    const launched = await env.api('POST', `/api/campaigns/${id}/launch`, {});
    expect(launched.body.status).toBe('running');
    expect(launched.body.stats.total).toBe(3);

    // Pacing: 30/min per campaign => one send every ~2s, and session max 10/min => ~6s gaps.
    await env.run(1);
    expect(env.fake.sent).toHaveLength(1);
    await env.run(3, 1000);
    expect(env.fake.sent).toHaveLength(1);
    await env.run(30, 1000);
    expect(env.fake.sent).toHaveLength(3);

    const texts = env.fake.sent.map(m => m.text!);
    const asha = texts.find(t => t.startsWith('Hi Asha from Pune!'))!;
    expect(asha).toMatch(new RegExp(`https://reach\\.example\\.com/t/${env.tenantId}/r/[A-Za-z0-9]{7}/[a-f0-9]{16}`));
    expect(asha).not.toContain('shop.example.com');
    expect(asha.endsWith('Reply STOP to unsubscribe.')).toBe(true);
    expect(env.fake.sent.map(m => m.chatId).sort()).toEqual(['919876500001@c.us', '919876500002@c.us', '919876500003@c.us']);

    const campaign = await env.api('GET', `/api/campaigns/${id}`);
    expect(campaign.body.status).toBe('completed');
    expect(campaign.body.stats).toMatchObject({ sent: 3, delivered: 0 });

    // Receipts: forward-only.
    const [first, second] = env.fake.sent;
    await env.webhook('message.ack', { id: first.messageId, messageId: first.messageId, status: 'read', ack: 3 });
    await env.webhook('message.ack', { id: first.messageId, messageId: first.messageId, status: 'delivered', ack: 2 });
    await env.webhook('message.ack', { id: second.messageId, messageId: second.messageId, status: 'delivered', ack: 2 });

    // Reply attribution + click tracking.
    const phoneOfFirst = first.chatId.replace('@c.us', '');
    await env.webhook('message.received', inbound(phoneOfFirst, 'Is the offer valid in store?'));
    const url = /https:\/\/reach\.example\.com(\/t\/\S+)/.exec(asha)![1];
    const click = await env.app.inject({ method: 'GET', url, headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari/604.1' } });
    expect(click.statusCode).toBe(302);
    expect(click.headers.location).toBe('https://shop.example.com/diwali');
    const botClick = await env.app.inject({ method: 'GET', url, headers: { 'user-agent': 'WhatsApp/2.24' } });
    expect(botClick.statusCode).toBe(302);

    const report = await env.api('GET', `/api/campaigns/${id}/report`);
    expect(report.body.campaign.stats).toMatchObject({ total: 3, sent: 3, delivered: 2, read: 1, replied: 1, clicked: 1 });
    expect(report.body.links).toEqual([expect.objectContaining({ url: 'https://shop.example.com/diwali', clicks: 1, uniqueClicks: 1 })]);

    const csv = await env.api('GET', `/api/campaigns/${id}/recipients.csv`);
    expect(csv.status).toBe(200);
    expect(String(csv.body).split('\r\n')[0]).toContain('replied_at');
  });

  it('never messages a contact who opted out after launch, and honours requireOptIn', async () => {
    await importContacts(['9876500011,A,,', '9876500012,B,,', '9876500013,C,,']);
    const contacts = (await env.api('GET', '/api/contacts')).body.items as Array<{ id: number; phone: string }>;
    const b = contacts.find(c => c.phone === '919876500012')!;
    const c = contacts.find(c => c.phone === '919876500013')!;
    await env.api('PATCH', `/api/contacts/${c.id}`, { consent: 'opted_in' });

    const optInOnly = await env.api('POST', '/api/campaigns', {
      name: 'Opt-in only',
      variants: [{ key: 'A', body: 'Members news' }],
      options: { requireOptIn: true, perMinute: 60 },
    });
    const preview = await env.api('POST', '/api/campaigns/audience-preview', {
      audience: { type: 'all' },
      options: { requireOptIn: true },
    });
    expect(preview.body).toMatchObject({ matched: 3, eligible: 1, excluded: { noConsent: 2 } });

    const everyone = await env.api('POST', '/api/campaigns', {
      name: 'Everyone',
      variants: [{ key: 'A', body: 'Hello all' }],
      options: { perMinute: 60, appendOptOut: false },
    });
    await env.api('POST', `/api/campaigns/${everyone.body.id}/launch`, {});
    // B texts STOP before the campaign reaches them.
    await env.webhook('message.received', inbound(b.phone, 'stop'));
    await env.run(40, 1000);

    const everyoneReport = await env.api('GET', `/api/campaigns/${everyone.body.id}/report`);
    expect(everyoneReport.body.campaign.stats).toMatchObject({ sent: 2, skipped: 1 });
    expect(everyoneReport.body.skipReasons[0]).toMatchObject({ reason: 'opted_out', count: 1 });
    expect(env.fake.sent.filter(m => m.chatId === `${b.phone}@c.us` && m.text === 'Hello all')).toHaveLength(0);
    // The STOP confirmation itself was sent (transactional).
    expect(env.fake.sent.some(m => m.chatId === `${b.phone}@c.us` && /unsubscribed/.test(m.text ?? ''))).toBe(true);

    await env.api('POST', `/api/campaigns/${optInOnly.body.id}/launch`, {});
    await env.run(20, 1000);
    const optInReport = await env.api('GET', `/api/campaigns/${optInOnly.body.id}/report`);
    expect(optInReport.body.campaign.stats).toMatchObject({ total: 1, sent: 1 });
  });

  it('holds campaigns during quiet hours and resumes after', async () => {
    await importContacts(['9876500021,A,,']);
    env.clock.set('2026-09-25T16:00:00.000Z'); // 21:30 IST
    const created = await env.api('POST', '/api/campaigns', { name: 'Night', variants: [{ key: 'A', body: 'Hi' }] });
    await env.api('POST', `/api/campaigns/${created.body.id}/launch`, {});
    await env.run(5, 60_000);
    expect(env.fake.sent).toHaveLength(0);
    const waiting = await env.api('GET', `/api/campaigns/${created.body.id}`);
    expect(waiting.body.waitReason).toMatch(/Quiet hours/);
    env.clock.set('2026-09-26T03:31:00.000Z'); // 09:01 IST
    await env.run(1);
    expect(env.fake.sent).toHaveLength(1);
  });

  it('starts scheduled campaigns on time with the audience as of start', async () => {
    await importContacts(['9876500031,A,,']);
    const created = await env.api('POST', '/api/campaigns', { name: 'Later', variants: [{ key: 'A', body: 'Hi' }] });
    const scheduledAt = new Date(env.clock.now().getTime() + 3_600_000).toISOString();
    const launched = await env.api('POST', `/api/campaigns/${created.body.id}/launch`, { scheduledAt });
    expect(launched.body.status).toBe('scheduled');
    await importContacts(['9876500032,B,,']);
    await env.run(3, 60_000);
    expect(env.fake.sent).toHaveLength(0);
    env.clock.advance(3_600_000);
    await env.run(20, 5000);
    expect(env.fake.sent).toHaveLength(2);
  });

  it('splits A/B variants by weight and reports per variant', async () => {
    await importContacts(Array.from({ length: 20 }, (_, i) => `98765001${String(i).padStart(2, '0')},P${i},,`));
    const created = await env.api('POST', '/api/campaigns', {
      name: 'AB',
      variants: [
        { key: 'A', body: 'Variant A', weight: 70 },
        { key: 'B', body: 'Variant B', weight: 30 },
      ],
      options: { perMinute: 60, appendOptOut: false },
    });
    await env.api('POST', `/api/campaigns/${created.body.id}/launch`, {});
    const report = await env.api('GET', `/api/campaigns/${created.body.id}/report`);
    expect(report.body.variants).toEqual([expect.objectContaining({ key: 'A', total: 14 }), expect.objectContaining({ key: 'B', total: 6 })]);
  });

  it('rejects variant splits that do not add up to 100', async () => {
    const res = await env.api('POST', '/api/campaigns', {
      name: 'Bad',
      variants: [
        { key: 'A', body: 'x', weight: 50 },
        { key: 'B', body: 'y', weight: 30 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/100%/);
  });
});

describe('dispatcher safety', () => {
  it('pauses a campaign after consecutive rejected sends', async () => {
    await importContacts(Array.from({ length: 8 }, (_, i) => `98765002${String(i).padStart(2, '0')},P${i},,`));
    const created = await env.api('POST', '/api/campaigns', { name: 'Breaker', variants: [{ key: 'A', body: 'Hi' }], options: { perMinute: 60 } });
    await env.api('POST', `/api/campaigns/${created.body.id}/launch`, {});
    env.fake.failAllSends = { status: 400, body: { message: 'Bad request from engine' } };
    await env.run(60, 1000);
    const campaign = await env.api('GET', `/api/campaigns/${created.body.id}`);
    expect(campaign.body.status).toBe('paused');
    expect(campaign.body.pausedReason).toMatch(/5 failed sends in a row/);
    expect(campaign.body.stats.failed).toBe(5);
    expect(campaign.body.stats.queued).toBe(3);

    env.fake.failAllSends = null;
    await env.api('POST', `/api/campaigns/${created.body.id}/resume`);
    await env.run(40, 1000);
    const done = await env.api('GET', `/api/campaigns/${created.body.id}`);
    expect(done.body.status).toBe('completed');
    expect(done.body.stats.sent).toBe(3);
  });

  it('backs off on OpenWA pacing refusals without failing recipients', async () => {
    await importContacts(['9876500301,A,,', '9876500302,B,,']);
    const created = await env.api('POST', '/api/campaigns', { name: 'Paced', variants: [{ key: 'A', body: 'Hi' }], options: { perMinute: 60 } });
    await env.api('POST', `/api/campaigns/${created.body.id}/launch`, {});
    env.fake.failNextSends.push({ status: 429, body: { code: 'SEND_PACING_LIMITED', retryAfterSeconds: 120, message: 'Daily warm-up cap reached' } });
    await env.run(1);
    expect(env.fake.sent).toHaveLength(0);
    const held = await env.api('GET', `/api/campaigns/${created.body.id}`);
    expect(held.body.stats).toMatchObject({ queued: 2, failed: 0 });
    expect(held.body.waitReason).toMatch(/pacing/);
    await env.run(10, 10_000); // 100s: still held
    expect(env.fake.sent).toHaveLength(0);
    await env.run(10, 10_000);
    expect(env.fake.sent).toHaveLength(2);
  });

  it('marks in-flight sends as unknown after a crash instead of resending', async () => {
    await importContacts(['9876500401,A,,']);
    const created = await env.api('POST', '/api/campaigns', { name: 'Crash', variants: [{ key: 'A', body: 'Hi' }] });
    await env.api('POST', `/api/campaigns/${created.body.id}/launch`, {});
    env.core.db.run("UPDATE campaign_recipients SET status = 'sending' WHERE campaign_id = ?", created.body.id);
    const recovered = env.s.dispatcher.recover();
    expect(recovered.recipients).toBe(1);
    await env.run(5);
    expect(env.fake.sent).toHaveLength(0);
    const campaign = await env.api('GET', `/api/campaigns/${created.body.id}`);
    expect(campaign.body).toMatchObject({ status: 'completed', stats: { unknown: 1 } });
  });

  it('enforces the per-number daily cap across campaigns', async () => {
    env.s.settings.update({ sending: { dailyCapPerSession: 2 } });
    await importContacts(['9876500501,A,,', '9876500502,B,,', '9876500503,C,,']);
    const created = await env.api('POST', '/api/campaigns', { name: 'Capped', variants: [{ key: 'A', body: 'Hi' }], options: { perMinute: 60 } });
    await env.api('POST', `/api/campaigns/${created.body.id}/launch`, {});
    await env.run(30, 1000);
    expect(env.fake.sent).toHaveLength(2);
    const waiting = await env.api('GET', `/api/campaigns/${created.body.id}`);
    expect(waiting.body.waitReason).toMatch(/Daily limit/);
    env.clock.set('2026-09-26T05:00:00.000Z'); // next local day, 10:30 IST
    await env.run(1);
    expect(env.fake.sent).toHaveLength(3);
  });

  it('skips numbers that are not on WhatsApp when validation is on', async () => {
    await importContacts(['9876500601,A,,', '9876500602,B,,']);
    env.fake.notOnWhatsApp.add('919876500602');
    const created = await env.api('POST', '/api/campaigns', {
      name: 'Validated',
      variants: [{ key: 'A', body: 'Hi' }],
      options: { validateNumbers: true, perMinute: 60 },
    });
    await env.api('POST', `/api/campaigns/${created.body.id}/launch`, {});
    await env.run(20, 1000);
    const report = await env.api('GET', `/api/campaigns/${created.body.id}/report`);
    expect(report.body.campaign.stats).toMatchObject({ sent: 1, skipped: 1 });
    const contacts = await env.api('GET', '/api/contacts?waStatus=invalid');
    expect(contacts.body.items.map((c: { phone: string }) => c.phone)).toEqual(['919876500602']);
  });
});
