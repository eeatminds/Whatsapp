import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await createTestEnv({ saveUnknownSenders: false });
});
afterEach(async () => {
  await env.close();
});

const post = (url: string, body: object) =>
  env.app.inject({ method: 'POST', url: new URL(url).pathname, payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

async function login(): Promise<string> {
  const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: env.owner.email, password: env.owner.password } });
  return String(res.headers['set-cookie']).split(';')[0];
}

describe('lead tracking', () => {
  it('keeps one lead per number across sources and imports', async () => {
    const sheet = (await env.api('POST', '/api/lead-sources', { name: 'Website sheet', kind: 'google_sheet', actions: {} })).body;
    const wix = (await env.api('POST', '/api/lead-sources', { name: 'Wix form', kind: 'wix', actions: {} })).body;
    await post(sheet.url, { Name: 'Asha', Phone: '98765 43210' });
    const second = await post(wix.url, { name: 'Asha R', phone: '+91 98765-43210' });
    expect(JSON.parse(second.body)).toMatchObject({ duplicate: true });

    // A CSV import doesn't overwrite the first details unless asked to.
    const imported = await env.api('POST', '/api/contacts/import', {
      csv: 'Phone,Name\n9876543210,Imported Name\n9876543210,Again\n9123456789,New Person',
      mapping: { '0': 'phone', '1': 'name' },
    });
    expect(imported.body).toMatchObject({ created: 1, updated: 0, unchanged: 1, skipped: 1 });
    const rows = env.core.db.all<{ phone: string; name: string; lead_source_id: number | null }>('SELECT phone, name, lead_source_id FROM contacts ORDER BY id');
    expect(rows).toEqual([
      { phone: '919876543210', name: 'Asha', lead_source_id: sheet.id },
      { phone: '919123456789', name: 'New Person', lead_source_id: null },
    ]);
  });

  it('tracks stage and a shared remark, and reports by channel', async () => {
    const tag = (await env.api('POST', '/api/tags', { name: 'website-lead' })).body;
    const source = (await env.api('POST', '/api/lead-sources', { name: 'Website sheet', kind: 'google_sheet', actions: {} })).body;
    await post(source.url, { Name: 'Asha', Phone: '9876543210' });
    await post(source.url, { Name: 'Ravi', Phone: '9845011122' });
    await env.api('POST', '/api/contacts', { phone: '9123456789', name: 'Walk-in' });

    // Adding a tag to the source later tags the leads it already brought in.
    await env.api('PATCH', `/api/lead-sources/${source.id}`, { name: 'Website sheet', kind: 'google_sheet', actions: { tagIds: [tag.id] } });
    const tagged = await env.api('GET', `/api/contacts?tagId=${tag.id}`);
    expect(tagged.body.total).toBe(2);

    const list = await env.api('GET', `/api/contacts?channel=src:${source.id}`);
    expect(list.body.items.map((c: { name: string }) => c.name).sort()).toEqual(['Asha', 'Ravi']);
    expect(list.body.items[0]).toMatchObject({ leadStage: 'untouched', leadRemark: null, channel: 'Website sheet' });
    const asha = list.body.items.find((c: { name: string }) => c.name === 'Asha');

    // Team members see who wrote the remark.
    const cookie = await login();
    const res = await env.app.inject({
      method: 'PUT',
      url: `/api/contacts/${asha.id}/lead`,
      payload: { stage: 'warm', remark: 'Called, wants MBA brochure. Call back Friday.' },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ leadStage: 'warm', leadRemark: 'Called, wants MBA brochure. Call back Friday.', leadRemarkBy: env.owner.email });
    expect((await env.api('PUT', `/api/contacts/${asha.id}/lead`, { stage: 'lost' })).status).toBe(400);
    expect((await env.api('PUT', `/api/contacts/${asha.id}/lead`, {})).status).toBe(400);

    const bulk = await env.api('POST', '/api/contacts/bulk', { filter: { q: 'Walk-in' }, action: 'set_stage', stage: 'closed' });
    expect(bulk.body.affected).toBe(1);
    expect((await env.api('GET', '/api/contacts?stage=warm')).body.total).toBe(1);

    const report = (await env.api('GET', '/api/leads/report')).body;
    expect(report.total).toBe(3);
    expect(report.byStage).toEqual({ untouched: 1, warm: 1, cold: 0, closed: 1 });
    expect(report.channels).toEqual([
      { key: `src:${source.id}`, name: 'Website sheet', leads: 2, untouched: 1, warm: 1, cold: 0, closed: 0 },
      { key: 'manual', name: 'Added manually', leads: 1, untouched: 0, warm: 0, cold: 0, closed: 1 },
    ]);
    expect(report.funnel.map((f: { count: number }) => f.count)).toEqual([3, 2, 2, 1]);

    // Date range: nothing was added before today.
    const empty = (await env.api('GET', '/api/leads/report?from=2020-01-01&to=2020-12-31')).body;
    expect(empty.total).toBe(0);
    const today = env.clock.now().toISOString().slice(0, 10);
    expect((await env.api('GET', `/api/leads/report?from=${today}&to=${today}`)).body.total).toBe(3);

    const csv = await env.app.inject({ method: 'GET', url: '/api/contacts/export.csv', headers: { 'x-api-key': env.apiKey } });
    expect(csv.body.split('\n')[0]).toContain('lead_stage,lead_remark,lead_remark_by,channel');
    expect(csv.body).toContain('Called, wants MBA brochure. Call back Friday.');
  });
});
