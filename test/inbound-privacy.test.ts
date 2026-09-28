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
  it('ignores people who are not contacts unless the business opts in', async () => {
    env = await createTestEnv({ saveUnknownSenders: false });
    env!.s.autoReplies.create({ name: 'Any', matchType: 'any', keywords: [], replyBody: 'Thanks!', active: true });

    const stranger = await env!.webhook('message.received', inbound('919812300001', 'hi, this is personal'));
    expect(stranger.body.outcome).toBe('unknown_sender');
    expect(count("SELECT COUNT(*) AS n FROM contacts WHERE phone = '919812300001'")).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM messages')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM outbox')).toBe(0);

    await env!.api('POST', '/api/contacts', { phone: '+919812300002', name: 'Asha' });
    const known = await env!.webhook('message.received', inbound('919812300002', 'Price?'));
    expect(known.body.outcome).toBe('auto_reply');

    await env!.api('PUT', '/api/settings', { saveUnknownSenders: true });
    const later = await env!.webhook('message.received', inbound('919812300001', 'hello again'));
    expect(later.body.outcome).toBe('auto_reply');
    expect(count("SELECT COUNT(*) AS n FROM contacts WHERE phone = '919812300001'")).toBe(1);
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
