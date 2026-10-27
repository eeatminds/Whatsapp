import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseLead, phoneWithCountry } from '../server/services/leads.js';
import { createTestEnv, type TestEnv } from './helpers.js';

describe('recognising sheet and form columns', () => {
  it('finds the person in the headers businesses really use', () => {
    const lead = parseLead({ 'Student Name': 'Asha Rao', 'Mob. No.': '98765 43210', 'Email ID': 'asha@example.com', 'Course Name': 'MBA', City: 'Pune' }, 'IN');
    expect(lead).toMatchObject({ phone: '919876543210', name: 'Asha Rao', email: 'asha@example.com', attributes: { course_name: 'MBA', city: 'Pune' } });

    const eMail = parseLead({ Name: 'Ravi', Phone: '9845011122', 'E Mail': 'ravi@example.com' }, 'IN');
    expect(eMail.email).toBe('ravi@example.com');

    // Facebook/Instagram lead exports: ad, campaign and form names are not the person.
    const meta = parseLead(
      { id: 'l:123', ad_name: 'Diwali ad', adset_name: 'Pune 25-40', campaign_name: 'Admissions', form_name: 'MBA form', full_name: 'Meera Iyer', email: 'meera@example.com', phone_number: '+919845022233' },
      'IN',
    );
    expect(meta).toMatchObject({ name: 'Meera Iyer', email: 'meera@example.com', phone: '919845022233' });
    expect(meta.attributes).toMatchObject({ ad_name: 'Diwali ad', campaign_name: 'Admissions' });

    // "Name of the applicant" style questions, and an email under an unusual header.
    const loose = parseLead({ 'Name of the applicant': 'Kunal Shah', 'WhatsApp': '9123456789', 'How can we reach you?': 'kunal@example.com' }, 'IN');
    expect(loose).toMatchObject({ name: 'Kunal Shah', email: 'kunal@example.com', phone: '919123456789' });

    const parts = parseLead({ 'First Name': 'Priya', 'Last Name': 'Nair', Mobile: '9988776655' }, 'IN');
    expect(parts.name).toBe('Priya Nair');
    expect(parts.roles).toMatchObject({ first_name: 'first_name', last_name: 'last_name', mobile: 'phone' });
  });

  it('joins a separate country-code column onto the number', () => {
    expect(parseLead({ Name: 'Sam', 'Country Code': '+1', Phone: '(415) 555-2671' }, 'IN').phone).toBe('14155552671');
    expect(parseLead({ Name: 'Ali', Code: '971', Mobile: '050 123 4567' }, 'IN').phone).toBe('971501234567');
    expect(parseLead({ Name: 'Tom', Country: 'GB', Phone: '07911 123456' }, 'IN').phone).toBe('447911123456');
    // A number that already has the code, and a country column holding a name, both still work.
    expect(phoneWithCountry('919876543210', '+91', 'IN')).toMatchObject({ ok: true, phone: '919876543210' });
    const named = parseLead({ Name: 'Anu', Country: 'India', Phone: '9876543210' }, 'IN');
    expect(named).toMatchObject({ phone: '919876543210', attributes: { country: 'India' } });
  });

  it("follows the business's own column choices", () => {
    const lead = parseLead(
      { 'Parent Name': 'Suresh Kumar', 'Student': 'Arjun', Contact: '9845033344', 'Notes': 'call evening', Source: 'fb' },
      'IN',
      { parent_name: 'name', student: 'custom', source: 'ignore' },
    );
    expect(lead).toMatchObject({ name: 'Suresh Kumar', phone: '919845033344', attributes: { student: 'Arjun', notes: 'call evening' } });
    expect(lead.attributes).not.toHaveProperty('source');
    expect(lead.roles).toMatchObject({ parent_name: 'name', source: 'ignore', contact: 'phone' });
  });
});

describe('lead source columns', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await createTestEnv({ saveUnknownSenders: false });
  });
  afterEach(async () => {
    await env.close();
  });
  const post = (url: string, body: object) =>
    env.app.inject({ method: 'POST', url: new URL(url).pathname, payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

  it('shows the columns received, fixes earlier leads, and fills blanks on repeats', async () => {
    const source = (await env.api('POST', '/api/lead-sources', { name: 'Admissions sheet', kind: 'google_sheet', actions: {} })).body;
    await post(source.url, { 'Guardian Name': 'Suresh', Phone: '9845011122', 'Mail': 'suresh@example.com', Course: 'BBA' });
    let contact = env.core.db.get<{ name: string | null; email: string | null; attributes: string }>("SELECT name, email, attributes FROM contacts WHERE phone = '919845011122'")!;
    expect(contact.name).toBeNull();
    expect(JSON.parse(contact.attributes)).toMatchObject({ guardian_name: 'Suresh', course: 'BBA' });

    const detail = (await env.api('GET', `/api/lead-sources/${source.id}`)).body.source;
    expect(detail.fieldsSeen).toEqual([
      { key: 'guardian_name', as: 'custom', sample: 'Suresh' },
      { key: 'phone', as: 'phone', sample: '9845011122' },
      { key: 'mail', as: 'email', sample: 'suresh@example.com' },
      { key: 'course', as: 'custom', sample: 'BBA' },
    ]);

    // The business says "Guardian Name" is the name: the lead already received is fixed too.
    const saved = await env.api('PUT', `/api/lead-sources/${source.id}/fields`, { fieldMap: { guardian_name: 'name' } });
    expect(saved.status).toBe(200);
    expect(saved.body.fixed).toBe(1);
    contact = env.core.db.get("SELECT name, email, attributes FROM contacts WHERE phone = '919845011122'")!;
    expect(contact).toMatchObject({ name: 'Suresh', email: 'suresh@example.com' });
    expect(JSON.parse(contact.attributes)).toEqual({ course: 'BBA' });
    expect((await env.api('PUT', `/api/lead-sources/${source.id}/fields`, { fieldMap: { a: 'phone', b: 'phone' } })).status).toBe(400);
    expect((await env.api('PUT', `/api/lead-sources/${source.id}/fields`, { fieldMap: { 'Bad Key': 'name' } })).status).toBe(400);

    // A repeat of a number saved with only the phone fills in what's missing, nothing else.
    await env.api('POST', '/api/contacts', { phone: '9123456789' });
    const again = await post(source.url, { 'Guardian Name': 'Kavya', Phone: '+91 91234 56789', Email: 'kavya@example.com', City: 'Pune' });
    expect(JSON.parse(again.body)).toMatchObject({ duplicate: true });
    expect(env.core.db.get("SELECT name, email, attributes FROM contacts WHERE phone = '919123456789'")).toEqual({
      name: 'Kavya',
      email: 'kavya@example.com',
      attributes: JSON.stringify({ city: 'Pune' }),
    });
    const events = (await env.api('GET', `/api/lead-sources/${source.id}`)).body.events;
    expect(events[0].detail).toMatch(/kept the first details, filled in name, email, 1 custom field$/);
    const third = await post(source.url, { 'Guardian Name': 'Someone Else', Phone: '9123456789' });
    expect(JSON.parse(third.body)).toMatchObject({ duplicate: true });
    expect(env.core.db.get<{ name: string }>("SELECT name FROM contacts WHERE phone = '919123456789'")!.name).toBe('Kavya');
  });
});

describe('custom field filter', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await createTestEnv({ saveUnknownSenders: false });
  });
  afterEach(async () => {
    await env.close();
  });

  it('finds contacts by any custom field', async () => {
    await env.api('POST', '/api/contacts', { phone: '9845011122', name: 'A', attributes: { course: 'MBA Finance', city: 'Pune' } });
    await env.api('POST', '/api/contacts', { phone: '9845011133', name: 'B', attributes: { course: 'BBA' } });
    await env.api('POST', '/api/contacts', { phone: '9845011144', name: 'C' });
    const names = async (q: string) => (await env.api('GET', `/api/contacts?${q}`)).body.items.map((c: { name: string }) => c.name).sort();
    expect(await names('field=course')).toEqual(['A', 'B']);
    expect(await names('field=course&fieldValue=mba')).toEqual(['A']);
    expect(await names('field=city&fieldValue=pu')).toEqual(['A']);
    expect(await names('field=course&fieldValue=%25')).toEqual([]);
    expect((await env.api('GET', "/api/contacts?field=x')--")).status).toBe(400);
  });
});
