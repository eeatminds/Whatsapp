import { afterEach, describe, expect, it } from 'vitest';
import { createTestEnv, inbound, type TestEnv } from './helpers.js';
import { defaultSettings } from '../server/services/settings.js';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const tagsOf = (contact: { tags: Array<{ name: string }> }) => contact.tags.map(t => t.name).sort();

describe('Indian / International numbers', () => {
  it('is on for every business by default', () => {
    expect(defaultSettings({}).countryTags).toBe(true);
  });

  it('tags every new number and filters local from international', async () => {
    env = await createTestEnv({ countryTags: true });
    const ravi = await env.api('POST', '/api/contacts', { phone: '+91 98123 00021', name: 'Ravi' });
    const john = await env.api('POST', '/api/contacts', { phone: '+44 7400 123456', name: 'John' });
    const sara = await env.api('POST', '/api/contacts', { phone: '+971 50 123 4567', name: 'Sara', tagIds: [] });
    expect(tagsOf(ravi.body.contact)).toEqual(['Indian']);
    expect(ravi.body.contact.country).toBe('IN');
    expect(tagsOf(john.body.contact)).toEqual(['International']);
    expect(john.body.contact.country).toBe('GB');
    expect(sara.body.contact.country).toBe('AE');

    // Imports, leads and people who message in are tagged too.
    const csv = 'phone,name\n+91 98123 00022,Meena\n+1 415 555 2671,Alex\n';
    expect((await env.api('POST', '/api/contacts/import', { csv, mapping: { 0: 'phone', 1: 'name' } })).status).toBe(200);
    await env.webhook('message.received', inbound('919812300023', 'hello'));
    await env.webhook('message.received', inbound('6591234567', 'hi from Singapore'));

    const indian = await env.api('GET', '/api/contacts?origin=local');
    expect(indian.body.items.map((c: any) => c.name ?? c.phone).sort()).toEqual(['Customer', 'Meena', 'Ravi']);
    const international = await env.api('GET', '/api/contacts?origin=international');
    expect(international.body.items.map((c: any) => c.name).sort()).toEqual(['Alex', 'Customer', 'John', 'Sara']);
    expect(international.body.items.every((c: any) => tagsOf(c).includes('International'))).toBe(true);

    // Changing a number moves it to the right group.
    const moved = await env.api('PATCH', `/api/contacts/${john.body.contact.id}`, { phone: '+91 98123 00024' });
    expect(tagsOf(moved.body)).toEqual(['Indian']);

    // A renamed tag keeps being used for new numbers.
    const indianTag = (await env.api('GET', '/api/tags')).body.find((t: any) => t.name === 'Indian');
    await env.api('PATCH', `/api/tags/${indianTag.id}`, { name: 'India' });
    const priya = await env.api('POST', '/api/contacts', { phone: '+91 98123 00025', name: 'Priya' });
    expect(tagsOf(priya.body.contact)).toEqual(['India']);
  });

  it('tags existing numbers when turned on, and not when off', async () => {
    env = await createTestEnv({ countryTags: false });
    const ravi = await env.api('POST', '/api/contacts', { phone: '+91 98123 00031', name: 'Ravi' });
    const john = await env.api('POST', '/api/contacts', { phone: '+44 7400 123457', name: 'John' });
    expect(tagsOf(ravi.body.contact)).toEqual([]);
    // The filter works with tags off: it uses the number itself.
    expect((await env.api('GET', '/api/contacts?origin=international')).body.total).toBe(1);

    await env.api('PUT', '/api/settings', { countryTags: true });
    expect(tagsOf((await env.api('GET', `/api/contacts/${ravi.body.contact.id}`)).body.contact)).toEqual(['Indian']);
    expect(tagsOf((await env.api('GET', `/api/contacts/${john.body.contact.id}`)).body.contact)).toEqual(['International']);
  });

  it('works out the country of numbers added before this version', async () => {
    env = await createTestEnv({ countryTags: true });
    const id = env.core.db.run(
      "INSERT INTO contacts (phone, name, created_at, updated_at) VALUES ('919812300041', 'Old lead', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).lastInsertRowid;
    expect(env.s.contacts.assignCountries()).toBe(1);
    expect(tagsOf(env.s.contacts.get(id))).toEqual(['Indian']);
    // Tagging doesn't start automations on old numbers.
    expect(env.core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')!.n).toBe(0);
  });
});
