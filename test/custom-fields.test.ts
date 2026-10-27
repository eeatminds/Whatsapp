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
const contact = (phone: string) =>
  env.core.db.get<{ name: string | null; attributes: string }>('SELECT name, attributes FROM contacts WHERE phone = ?', phone)!;

describe('custom fields', () => {
  it('handles a website form with coded field names (Contact Form 7)', async () => {
    const source = (await env.api('POST', '/api/lead-sources', { name: 'Website', kind: 'google_sheet', actions: {} })).body;
    await post(source.url, { Date: 'Tue Oct 27 2026 00:00:00 GMT+0530 (India Standard Time)', 'text-870': 'Shreyas', 'text-858': '560043', 'tel-321': '9273193792' });
    expect(contact('919273193792')).toEqual({ name: null, attributes: JSON.stringify({ date: '27 Oct 2026', text_870: 'Shreyas', text_858: '560043' }) });

    // The Columns screen shows an example value per column and that names are missing.
    const detail = (await env.api('GET', `/api/lead-sources/${source.id}`)).body;
    expect(detail.columns).toMatchObject({ leads: 1, missingName: 1, samples: { text_870: 'Shreyas', text_858: '560043', tel_321: '9273193792' } });

    // Choosing "Full name" for the column keeps its example visible (it now lives in the name).
    await env.api('PUT', `/api/lead-sources/${source.id}/fields`, { fieldMap: { text_870: 'name' } });
    const after = (await env.api('GET', `/api/lead-sources/${source.id}`)).body;
    expect(after.columns.samples).toMatchObject({ text_870: 'Shreyas', date: '27 Oct 2026' });
    expect(contact('919273193792').name).toBe('Shreyas');
    await env.api('PUT', `/api/lead-sources/${source.id}/fields`, { fieldMap: {} });

    // "Move into Name" fixes every contact and every future lead.
    await env.core.db.run("UPDATE contacts SET name = NULL, attributes = json_set(attributes, '$.text_870', 'Shreyas') WHERE phone = '919273193792'");
    const moved = await env.api('POST', '/api/contacts/fields/move', { from: 'text_870', to: 'name' });
    expect(moved.body).toEqual({ moved: 1, left: 0 });
    expect(contact('919273193792').name).toBe('Shreyas');
    await post(source.url, { 'text-870': 'Asha', 'text-858': '411001', 'tel-321': '9845011122' });
    expect(contact('919845011122')).toEqual({ name: 'Asha', attributes: JSON.stringify({ text_858: '411001' }) });
  });

  it('renames a field everywhere: contacts, messages, segments, new leads and imports', async () => {
    await env.api('POST', '/api/contacts', { phone: '9845011122', name: 'A', attributes: { 'text-858': '560043' } });
    await env.api('POST', '/api/contacts', { phone: '9845011133', name: 'B', attributes: { text_858: '411001', pincode: 'keep me' } });
    const template = (await env.api('POST', '/api/templates', { name: 'PIN', body: 'Hi {{name}}, delivery to {{text_858}} and {{ Text-858 | your area }}.' })).body;
    const segment = (
      await env.api('POST', '/api/segments', { name: 'Bengaluru', rules: { match: 'all', conditions: [{ field: 'attribute', key: 'text_858', op: 'contains', value: '560' }] } })
    ).body;

    const renamed = await env.api('POST', '/api/contacts/fields/rename', { from: 'text_858', to: 'Pincode' });
    expect(renamed.body).toEqual({ renamed: 2 });
    expect(JSON.parse(contact('919845011122').attributes)).toEqual({ pincode: '560043' });
    expect(JSON.parse(contact('919845011133').attributes)).toEqual({ pincode: 'keep me' });
    expect((await env.api('GET', `/api/templates/${template.id}`)).body.body).toBe('Hi {{name}}, delivery to {{pincode}} and {{pincode|your area}}.');
    const seg = (await env.api('GET', '/api/segments')).body.find((x: { id: number }) => x.id === segment.id);
    expect(seg.rules.conditions[0].key).toBe('pincode');

    // The old name keeps arriving from forms and spreadsheets; it is saved under the new one.
    const source = (await env.api('POST', '/api/lead-sources', { name: 'Website', kind: 'website', actions: {} })).body;
    await post(source.url, { name: 'C', phone: '9845011144', 'text-858': '600001' });
    expect(JSON.parse(contact('919845011144').attributes)).toEqual({ pincode: '600001' });
    await env.api('POST', '/api/contacts/import', { csv: 'phone,text_858\n9845011155,110001', mapping: { '0': 'phone', '1': 'attr:text_858' } });
    expect(JSON.parse(contact('919845011155').attributes)).toEqual({ pincode: '110001' });

    expect((await env.api('POST', '/api/contacts/fields/rename', { from: 'pincode', to: 'Name' })).status).toBe(400);
    const fields = (await env.api('GET', '/api/contacts/fields')).body;
    expect(fields.fields).toEqual([{ key: 'pincode', count: 4, sample: '110001' }]);
    expect(fields.rules).toEqual({ text_858: { target: 'rename', renameTo: 'pincode' } });
  });

  it('tidies sheet dates already saved, and shows an example for every field', async () => {
    await env.api('POST', '/api/contacts', { phone: '9845011122', name: 'A', attributes: { date: 'Tue Oct 27 2026 14:05:00 GMT+0530 (India Standard Time)', city: 'Pune' } });
    expect(env.s.contacts.tidyDateValues((await import('../server/services/leads.js')).tidyValue)).toBe(1);
    expect(JSON.parse(contact('919845011122').attributes)).toEqual({ date: '27 Oct 2026 14:05', city: 'Pune' });
    const fields = (await env.api('GET', '/api/contacts/fields')).body.fields;
    expect(fields).toEqual([
      { key: 'city', count: 1, sample: 'Pune' },
      { key: 'date', count: 1, sample: '27 Oct 2026 14:05' },
    ]);
  });

  it('deletes a field and stops saving it, until the rule is removed', async () => {
    const source = (await env.api('POST', '/api/lead-sources', { name: 'Website', kind: 'website', actions: {} })).body;
    await post(source.url, { name: 'A', phone: '9845011122', date: 'today', city: 'Pune' });
    expect((await env.api('POST', '/api/contacts/fields/delete', { key: 'date' })).body).toEqual({ removed: 1 });
    await post(source.url, { name: 'B', phone: '9845011133', date: 'today', city: 'Delhi' });
    expect(JSON.parse(contact('919845011133').attributes)).toEqual({ city: 'Delhi' });
    await env.api('DELETE', '/api/contacts/fields/rules/date');
    await post(source.url, { name: 'C', phone: '9845011144', date: 'today' });
    expect(JSON.parse(contact('919845011144').attributes)).toEqual({ date: 'today' });
  });
});
