import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await createTestEnv({ saveUnknownSenders: false });
});
afterEach(async () => {
  await env.close();
});

async function makeSource(extra: Record<string, unknown> = {}) {
  const tag = await env.api('POST', '/api/tags', { name: 'website-lead' });
  const sequence = await env.api('POST', '/api/sequences', {
    name: 'Welcome',
    trigger: { type: 'manual' },
    options: { respectQuietHours: false, appendOptOut: false },
    steps: [{ delayMinutes: 0, body: 'Hi {{first_name|there}}, thanks for asking about {{course|our courses}}!' }],
  });
  const source = await env.api('POST', '/api/lead-sources', {
    name: 'Website enquiry',
    kind: 'website',
    actions: { tagIds: [tag.body.id], sequenceId: sequence.body.id, markOptedIn: true, notifyPhone: '+91 99000 55555' },
    ...extra,
  });
  expect(source.status).toBe(201);
  return source.body;
}

const post = (url: string, payload: string, type = 'application/json') =>
  env.app.inject({ method: 'POST', url: new URL(url).pathname, payload, headers: { 'content-type': type } });

describe('lead sources', () => {
  it('turns a submitted lead into a contact, starts the welcome series and notifies the owner', async () => {
    const source = await makeSource();
    expect(source.url).toMatch(new RegExp(`^https://reach\\.example\\.com/hooks/leads/${env.tenantId}/[A-Za-z0-9]{32}$`));

    const res = await post(source.url, JSON.stringify({ Name: 'Asha Rao', 'WhatsApp Number': '98765 43210', Email: 'asha@example.com', Course: 'MBA', token: 'x' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, created: true });

    const contact = env.core.db.get<{ id: number; name: string; email: string; attributes: string; consent: string; source: string }>(
      "SELECT * FROM contacts WHERE phone = '919876543210'",
    )!;
    expect(contact).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com', consent: 'opted_in', source: 'lead-form' });
    expect(JSON.parse(contact.attributes)).toEqual({ course: 'MBA' });

    await env.run(5, 2000);
    const texts = env.fake.sent.map(m => ({ to: m.chatId, text: m.text }));
    expect(texts).toContainEqual({ to: '919876543210@c.us', text: 'Hi Asha, thanks for asking about MBA!' });
    const note = texts.find(t => t.to === '919900055555@c.us');
    expect(note?.text).toContain('New lead from *Website enquiry*');
    expect(note?.text).toContain('Asha Rao');

    // The same number again is a duplicate: the first details stay, no second welcome or note.
    const sentBefore = env.fake.sent.length;
    const again = await post(source.url, JSON.stringify({ name: 'Someone Else', phone: '+919876543210', email: 'other@example.com' }));
    expect(JSON.parse(again.body)).toMatchObject({ ok: true, created: false, duplicate: true });
    await env.run(5, 2000);
    expect(env.fake.sent.length).toBe(sentBefore);
    expect(env.core.db.get("SELECT name, email FROM contacts WHERE phone = '919876543210'")).toEqual({ name: 'Asha Rao', email: 'asha@example.com' });
    expect(env.core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM contacts WHERE phone = '919876543210'")!.n).toBe(1);
    const detail = await env.api('GET', `/api/lead-sources/${source.id}`);
    expect(detail.body.source).toMatchObject({ received: 2, failed: 0 });
    expect(detail.body.events.map((e: { status: string }) => e.status)).toEqual(['duplicate', 'added']);
    expect(detail.body.events[0].detail).toMatch(/^Already a lead since \d{4}-\d{2}-\d{2}/);
  });

  it('accepts plain HTML forms and form-builder payloads', async () => {
    const source = await makeSource({ thankYouUrl: 'https://college.example/thanks' });
    const html = await post(source.url, 'name=Ravi+Kumar&phone=%2B91+98450+11122&city=Pune', 'application/x-www-form-urlencoded');
    expect(html.statusCode).toBe(303);
    expect(html.headers.location).toBe('https://college.example/thanks');

    const builder = await post(
      source.url,
      JSON.stringify({ data: { submissions: [{ label: 'First name', value: 'Meera' }, { label: 'Last name', value: 'Iyer' }, { label: 'Phone', value: '09845022233' }] } }),
    );
    expect(builder.statusCode).toBe(200);
    expect(env.core.db.get<{ name: string }>("SELECT name FROM contacts WHERE phone = '919845022233'")!.name).toBe('Meera Iyer');

    const preflight = await env.app.inject({ method: 'OPTIONS', url: new URL(source.url).pathname });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
  });

  it('explains leads it cannot add, and refuses wrong or reset links', async () => {
    const source = await makeSource();
    const noPhone = await post(source.url, JSON.stringify({ name: 'No Number', city: 'Delhi' }));
    expect(noPhone.statusCode).toBe(422);
    expect(JSON.parse(noPhone.body).error).toMatch(/No valid phone number found. Fields received: name, city/);

    const wrong = await post(source.url.slice(0, -4) + 'AAAA', JSON.stringify({ phone: '9876543210' }));
    expect(wrong.statusCode).toBe(404);
    const otherBusiness = await post(source.url.replace(env.tenantId, 'zzzzzz'), JSON.stringify({ phone: '9876543210' }));
    expect(otherBusiness.statusCode).toBe(404);

    const reset = await env.api('POST', `/api/lead-sources/${source.id}/reset-link`, {});
    expect(reset.body.url).not.toBe(source.url);
    expect((await post(source.url, JSON.stringify({ phone: '9876543210' }))).statusCode).toBe(404);

    await env.api('PATCH', `/api/lead-sources/${source.id}`, { name: 'Website enquiry', kind: 'website', active: false, actions: { tagIds: [] } });
    expect((await post(reset.body.url, JSON.stringify({ phone: '9876543210' }))).statusCode).toBe(403);
  });
});
