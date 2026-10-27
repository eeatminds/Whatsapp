import { afterEach, describe, expect, it } from 'vitest';
import { createTestEnv, inbound, type TestEnv } from './helpers.js';
import { openDatabase } from '../server/db/database.js';
import { MIGRATIONS } from '../server/db/schema.js';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const count = (sql: string) => env!.core.db.get<{ n: number }>(sql)!.n;

describe('inbound privacy and noise', () => {
  it('shows new people in the Inbox only, until the business adds them', async () => {
    env = await createTestEnv({ saveUnknownSenders: false });
    env!.s.autoReplies.create({ name: 'Any', matchType: 'any', keywords: [], replyBody: 'Thanks!', active: true, priority: 900 });

    // A personal message to the connected number: in the Inbox, not in Contacts, no catch-all reply.
    const stranger = await env!.webhook('message.received', { ...inbound('919812300001', 'hi, this is personal'), contact: { pushName: 'Cousin' } });
    expect(stranger.body.outcome).toBe('inbox_only');
    expect(count('SELECT COUNT(*) AS n FROM outbox')).toBe(0);
    const inbox = await env!.api('GET', '/api/inbox');
    expect(inbox.body.unread).toBe(1);
    expect(inbox.body.items[0]).toMatchObject({ phone: '919812300001', name: 'Cousin', saved: false, lastMessage: 'hi, this is personal' });
    expect((await env!.api('GET', '/api/contacts')).body.total).toBe(0);
    expect((await env!.api('GET', '/api/overview')).body.contacts.total).toBe(0);
    const audience = await env!.api('POST', '/api/campaigns/audience-preview', { audience: { type: 'all' } });
    expect(audience.body.matched).toBe(0);

    // Keyword rules still answer new people (that's what keywords are for).
    env!.s.autoReplies.create({ name: 'Price', matchType: 'contains', keywords: ['price'], replyBody: 'Our prices: …', active: true, priority: 10 });
    const asks = await env!.webhook('message.received', inbound('919812300001', 'price?'));
    expect(asks.body.outcome).toBe('auto_reply');
    expect((await env!.api('GET', '/api/contacts')).body.total).toBe(0);

    // "Add to contacts" from the Inbox.
    const id = inbox.body.items[0].contactId;
    env!.clock.advance(3_600_000);
    const saved = await env!.api('POST', `/api/contacts/${id}/save`, {});
    expect(saved.body).toMatchObject({ saved: true, name: 'Cousin', channel: 'Messaged on WhatsApp', createdAt: env!.clock.now().toISOString() });
    expect((await env!.api('GET', '/api/contacts')).body.total).toBe(1);

    // Known contacts get the catch-all reply as before.
    await env!.api('POST', '/api/contacts', { phone: '+919812300002', name: 'Asha' });
    const known = await env!.webhook('message.received', inbound('919812300002', 'hello'));
    expect(known.body.outcome).toBe('auto_reply');

    // With "save everyone who writes in" on, new people become contacts straight away.
    await env!.api('PUT', '/api/settings', { saveUnknownSenders: true });
    const later = await env!.webhook('message.received', inbound('919812300009', 'hello again'));
    expect(later.body.outcome).toBe('auto_reply');
    expect(count("SELECT COUNT(*) AS n FROM contacts WHERE phone = '919812300009' AND saved = 1")).toBe(1);
  });

  it('turns an Inbox-only person into a contact when they arrive by form, import or a tagging auto-reply', async () => {
    env = await createTestEnv({ saveUnknownSenders: false });
    await env!.webhook('message.received', inbound('919812300011', 'hi'));
    await env!.webhook('message.received', inbound('919812300012', 'hi'));
    await env!.webhook('message.received', inbound('919812300013', 'hello'));
    const optIn = await env!.webhook('message.received', inbound('919812300014', 'START'));
    expect(optIn.body.outcome).toBe('opted_in');

    const source = (await env!.api('POST', '/api/lead-sources', { name: 'Website', kind: 'website', actions: {} })).body;
    const lead = await env!.app.inject({
      method: 'POST',
      url: new URL(source.url).pathname,
      payload: JSON.stringify({ name: 'Form Person', phone: '9812300011' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(lead.body)).toMatchObject({ created: true, duplicate: false });

    const imported = await env!.api('POST', '/api/contacts/import', { csv: 'phone,name\n9812300012,Imported', mapping: { '0': 'phone', '1': 'name' } });
    expect(imported.body).toMatchObject({ created: 1 });

    const tag = (await env!.api('POST', '/api/tags', { name: 'joined' })).body;
    env!.s.autoReplies.create({ name: 'Menu', matchType: 'exact', keywords: ['menu'], replyBody: 'Here is our menu', active: true, actions: { addTagIds: [tag.id] } });
    await env!.webhook('message.received', inbound('919812300013', 'menu'));

    const contacts = (await env!.api('GET', '/api/contacts')).body.items.map((c: { phone: string; name: string; channel: string }) => [c.phone, c.name, c.channel]);
    expect(contacts.sort()).toEqual([
      ['919812300011', 'Form Person', 'Website'],
      ['919812300012', 'Imported', 'CSV import'],
      ['919812300013', 'Customer', 'WhatsApp keyword'],
      ['919812300014', 'Customer', 'Opted in on WhatsApp'],
    ]);
  });

  it('drops WhatsApp system notices that carry no text', async () => {
    env = await createTestEnv();
    await env!.api('POST', '/api/contacts', { phone: '+919812300003', name: 'Ravi' });
    for (const type of ['unknown', 'revoked', 'call', 'e2e_notification']) {
      const res = await env!.webhook('message.received', { ...inbound('919812300003', ''), type });
      expect(res.body.outcome).toBe('ignored');
    }
    const fromStranger = await env!.webhook('message.received', { ...inbound('919812300004', ''), type: 'unknown' });
    expect(fromStranger.body.outcome).toBe('ignored');
    expect(count('SELECT COUNT(*) AS n FROM messages')).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM contacts WHERE phone = '919812300004'")).toBe(0);
    // A photo without a caption is still a real message.
    const photo = await env!.webhook('message.received', { ...inbound('919812300003', ''), type: 'image' });
    expect(photo.body.outcome).toBe('received');
  });

  it('counts unread conversations, not messages', async () => {
    env = await createTestEnv();
    await env!.webhook('message.received', inbound('919812300005', 'one'));
    await env!.webhook('message.received', inbound('919812300005', 'two'));
    await env!.webhook('message.received', inbound('919812300005', 'three'));
    await env!.webhook('message.received', inbound('919812300006', 'hello'));
    const inbox = await env!.api('GET', '/api/inbox');
    expect(inbox.body.unread).toBe(2);
    expect(inbox.body.items.find((c: { phone: string }) => c.phone === '919812300005').unread).toBe(3);
  });

  it('cleans up notices and the contacts created from them on upgrade', () => {
    // Every migration before the clean-up (migration 5).
    const db = openDatabase(':memory:', MIGRATIONS.slice(0, 4));
    const at = '2026-09-27T05:00:00.000Z';
    const contact = (phone: string, source: string) =>
      db.run("INSERT INTO contacts (phone, source, last_inbound_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", phone, source, at, at, at).lastInsertRowid;
    const junk = contact('919800000001', 'inbound');
    const realLead = contact('919800000002', 'inbound');
    const imported = contact('919800000003', 'import');
    const message = (id: number, type: string, body: string | null) =>
      db.run(
        "INSERT INTO messages (contact_id, session_id, chat_id, direction, type, body, status, source_type, created_at) VALUES (?, 's', 'c', 'in', ?, ?, 'received', 'inbound', ?)",
        id,
        type,
        body,
        at,
      );
    message(junk, 'unknown', '');
    message(realLead, 'text', 'Is this available?');
    message(imported, 'unknown', null);

    db.migrate(MIGRATIONS);
    const phones = db.all<{ phone: string; last_inbound_at: string | null }>('SELECT phone, last_inbound_at FROM contacts ORDER BY phone');
    expect(phones).toEqual([
      { phone: '919800000002', last_inbound_at: at },
      { phone: '919800000003', last_inbound_at: null },
    ]);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')!.n).toBe(1);
    db.close();
  });
});
