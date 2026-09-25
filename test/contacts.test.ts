import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, inbound, type TestEnv } from './helpers.js';

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  await env.close();
});

describe('contacts', () => {
  it('suggests an import mapping and imports tags, attributes and names', async () => {
    const csv = 'Mobile No;First Name;Last Name;E-mail;City;Tags\n98765 60001;Anil;Kapoor;anil@example.com;Delhi;vip, diwali\n98765 60002;Bina;;;Pune;diwali';
    const preview = await env.api('POST', '/api/contacts/import/preview', { csv });
    expect(preview.body.mapping).toEqual({ '0': 'phone', '1': 'first_name', '2': 'last_name', '3': 'email', '4': 'attr:city', '5': 'tags' });
    expect(preview.body.totalRows).toBe(2);
    const result = await env.api('POST', '/api/contacts/import', { csv, mapping: preview.body.mapping, consent: 'opted_in', consentSource: 'website form 2026' });
    expect(result.body).toMatchObject({ created: 2, skipped: 0 });
    const list = await env.api('GET', '/api/contacts?q=anil');
    expect(list.body.items[0]).toMatchObject({
      phone: '919876560001',
      name: 'Anil Kapoor',
      email: 'anil@example.com',
      attributes: { city: 'Delhi' },
      consent: 'opted_in',
      consentSource: 'website form 2026',
    });
    expect(list.body.items[0].tags.map((t: { name: string }) => t.name)).toEqual(['diwali', 'vip']);

    // Re-import updates in place.
    const again = await env.api('POST', '/api/contacts/import', {
      csv: 'phone,city\n+919876560002,Mumbai',
      mapping: { '0': 'phone', '1': 'attr:city' },
    });
    expect(again.body).toMatchObject({ created: 0, updated: 1 });
  });

  it('filters, bulk-tags, exports and deletes', async () => {
    for (const phone of ['9876570001', '9876570002', '9876570003']) await env.api('POST', '/api/contacts', { phone, name: `N${phone.slice(-1)}` });
    const tag = (await env.api('POST', '/api/tags', { name: 'Q4' })).body;
    const bulk = await env.api('POST', '/api/contacts/bulk', { filter: { q: '7000' }, action: 'add_tags', tagIds: [tag.id] });
    expect(bulk.body.affected).toBe(3);
    const tagged = await env.api('GET', `/api/contacts?tagId=${tag.id}`);
    expect(tagged.body.total).toBe(3);
    const csv = await env.api('GET', `/api/contacts/export.csv?tagId=${tag.id}`);
    expect(String(csv.body).split('\r\n').filter(Boolean)).toHaveLength(4);
    const del = await env.api('POST', '/api/contacts/bulk', { filter: { ids: [tagged.body.items[0].id] }, action: 'delete' });
    expect(del.body.affected).toBe(1);
    expect((await env.api('GET', '/api/contacts')).body.total).toBe(2);
    expect((await env.api('GET', '/api/tags')).body[0]).toMatchObject({ name: 'Q4', count: 2 });
  });

  it('rejects invalid phones and duplicate phone edits', async () => {
    expect((await env.api('POST', '/api/contacts', { phone: 'abc' })).status).toBe(400);
    const a = (await env.api('POST', '/api/contacts', { phone: '9876580001' })).body.contact;
    await env.api('POST', '/api/contacts', { phone: '9876580002' });
    const clash = await env.api('PATCH', `/api/contacts/${a.id}`, { phone: '+91 98765 80002' });
    expect(clash.status).toBe(400);
  });
});

describe('segments', () => {
  it('evaluates attribute, tag and engagement rules, including campaign retargeting', async () => {
    const vip = (await env.api('POST', '/api/tags', { name: 'vip' })).body;
    await env.api('POST', '/api/contacts', { phone: '9876590001', name: 'A', attributes: { city: 'Pune', spend: '5000' }, tagIds: [vip.id] });
    await env.api('POST', '/api/contacts', { phone: '9876590002', name: 'B', attributes: { city: 'pune', spend: '800' } });
    await env.api('POST', '/api/contacts', { phone: '9876590003', name: 'C', attributes: { city: 'Delhi' } });

    const pune = await env.api('POST', '/api/segments/preview', {
      rules: { match: 'all', conditions: [{ field: 'attribute', key: 'city', op: 'equals', value: 'PUNE' }] },
    });
    expect(pune.body.count).toBe(2);
    const bigSpenders = await env.api('POST', '/api/segments/preview', {
      rules: { conditions: [{ field: 'attribute', key: 'spend', op: 'gt', value: '1000' }] },
    });
    expect(bigSpenders.body.count).toBe(1);
    const anyOf = await env.api('POST', '/api/segments/preview', {
      rules: {
        match: 'any',
        conditions: [
          { field: 'tag', op: 'has', value: vip.id },
          { field: 'attribute', key: 'city', op: 'equals', value: 'delhi' },
        ],
      },
    });
    expect(anyOf.body.count).toBe(2);

    // Send a campaign, get one reply, then target the non-responders.
    const campaign = await env.api('POST', '/api/campaigns', { name: 'First touch', variants: [{ key: 'A', body: 'Hi' }], options: { perMinute: 60 } });
    await env.api('POST', `/api/campaigns/${campaign.body.id}/launch`, {});
    await env.run(30, 1000);
    await env.webhook('message.received', inbound('919876590001', 'yes please'));
    const segment = await env.api('POST', '/api/segments', {
      name: 'No reply to first touch',
      rules: { conditions: [{ field: 'campaign', op: 'not_replied', value: campaign.body.id }] },
    });
    expect(segment.status).toBe(201);
    const listed = await env.api('GET', '/api/segments');
    expect(listed.body[0]).toMatchObject({ name: 'No reply to first touch', count: 2 });
    const followUp = await env.api('POST', '/api/campaigns/audience-preview', { audience: { type: 'segment', segmentId: segment.body.id } });
    expect(followUp.body.eligible).toBe(2);
  });
});

describe('WhatsApp numbers', () => {
  it('creates a session in OpenWA, registers the signed webhook and starts it', async () => {
    const created = await env.api('POST', '/api/sessions', { name: 'sales-line' });
    expect(created.status).toBe(200);
    const hook = env.fake.webhooks.find(w => w.sessionId === created.body.id)!;
    expect(hook).toMatchObject({ url: env.config.webhookUrl, secret: env.config.openwa.webhookSecret });
    expect(hook.events).toEqual(expect.arrayContaining(['message.received', 'message.ack', 'message.failed', 'session.status']));
    const qr = await env.api('GET', `/api/sessions/${created.body.id}/qr`);
    expect(qr.body.qrCode).toMatch(/^data:image\/[a-z+]+;base64,/);

    // Re-sync updates rather than duplicates.
    const sync = await env.api('POST', '/api/system/sync-webhooks');
    expect(sync.body.results.map((r: { result: string }) => r.result)).toEqual(['updated', 'updated']);
    expect(env.fake.webhooks).toHaveLength(2);

    const duplicate = await env.api('POST', '/api/sessions', { name: 'sales-line' });
    expect(duplicate.status).toBe(409);
    const badName = await env.api('POST', '/api/sessions', { name: 'no spaces allowed' });
    expect(badName.status).toBe(400);
  });

  it('reports an unreachable gateway clearly', async () => {
    await env.fake.close();
    env.s.sessions.invalidate();
    const sessions = await env.api('GET', '/api/sessions');
    expect(sessions.body.gateway).toMatchObject({ reachable: false });
    expect(sessions.body.gateway.lastError).toMatch(/unreachable/);
  });
});

describe('settings', () => {
  it('validates and persists settings', async () => {
    const bad = await env.api('PUT', '/api/settings', { timezone: 'Mars/Olympus' });
    expect(bad.status).toBe(400);
    const ok = await env.api('PUT', '/api/settings', { quietHours: { enabled: false, start: '22:00', end: '08:00' }, compliance: { optOutKeywords: ['stop', 'band karo'] } });
    expect(ok.body.quietHours).toEqual({ enabled: false, start: '22:00', end: '08:00' });
    expect(ok.body.compliance.optOutKeywords).toEqual(['STOP', 'BAND KARO']);
    const stop = await env.webhook('message.received', inbound('919876599999', 'Band karo'));
    expect(stop.body.outcome).toBe('opted_out');
  });
});
