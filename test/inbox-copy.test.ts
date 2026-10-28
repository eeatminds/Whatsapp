import { afterEach, describe, expect, it } from 'vitest';
import { createTestEnv, inbound, type TestEnv } from './helpers.js';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const count = (sql: string, ...params: Array<string | number>) => env!.core.db.get<{ n: number }>(sql, ...params)!.n;
const seconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
/** Lets the short wait before a phone reply marks a chat read pass. */
const settle = () => new Promise(resolve => setTimeout(resolve, 80));

/** A message as the gateway reports it in chat history or a message.sent webhook. */
function waMessage(chat: string, id: string, body: string, options: { fromMe?: boolean; at: string; type?: string; extra?: Record<string, unknown> }) {
  return {
    id,
    from: options.fromMe ? '919900000001@c.us' : chat,
    to: options.fromMe ? chat : '919900000001@c.us',
    chatId: chat,
    body,
    type: options.type ?? 'text',
    timestamp: seconds(options.at),
    fromMe: !!options.fromMe,
    isGroup: chat.endsWith('@g.us'),
    kind: chat.endsWith('@g.us') ? 'group' : 'individual',
    ...(options.fromMe ? {} : { contact: { pushName: 'Asha' } }),
    ...options.extra,
  };
}

describe('Inbox: a copy of WhatsApp', () => {
  it('keeps messages typed on the phone, without adding contacts or triggering automations', async () => {
    env = await createTestEnv({ saveUnknownSenders: false });
    env.s.autoReplies.create({ name: 'Any', matchType: 'any', keywords: [], replyBody: 'Thanks!', active: true, priority: 900 });

    const sent = await env.webhook('message.sent', waMessage('919812300009@c.us', 'true_919812300009@c.us_PHONE1', 'See you at 5', { fromMe: true, at: env.clock.now().toISOString() }));
    expect(sent.body.outcome).toBe('sent_from_phone');
    const inbox = await env.api('GET', '/api/inbox');
    expect(inbox.body.items[0]).toMatchObject({ phone: '919812300009', saved: false, lastMessage: 'See you at 5', lastDirection: 'out', unread: 0 });
    const thread = await env.api('GET', `/api/inbox/${inbox.body.items[0].contactId}`);
    expect(thread.body.messages).toMatchObject([{ direction: 'out', sourceType: 'phone', body: 'See you at 5', status: 'sent' }]);
    expect((await env.api('GET', '/api/contacts')).body.total).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM outbox')).toBe(0);

    // The same echo again (webhook retry with a new key) is not a second message.
    const again = await env.webhook('message.sent', waMessage('919812300009@c.us', 'true_919812300009@c.us_PHONE1', 'See you at 5', { fromMe: true, at: env.clock.now().toISOString() }));
    expect(again.body.outcome).toBe('duplicate_message');

    // Groups and status posts stay out.
    expect((await env.webhook('message.sent', waMessage('1203630@g.us', 'g1', 'group hello', { fromMe: true, at: env.clock.now().toISOString() }))).body.outcome).toBe('ignored');
    expect((await env.webhook('message.sent', { ...waMessage('status@broadcast', 's1', 'my status', { fromMe: true, at: env.clock.now().toISOString() }), kind: 'status' })).body.outcome).toBe('ignored');
    expect(count('SELECT COUNT(*) AS n FROM messages')).toBe(1);
  });

  it('answering on the phone reads the chat; replies sent from WA Reach are recorded once', async () => {
    env = await createTestEnv();
    await env.webhook('message.received', inbound('919812300010', 'Is it in stock?'));
    const id = (await env.api('GET', '/api/inbox')).body.items[0].contactId;
    expect((await env.api('GET', '/api/inbox')).body.unread).toBe(1);

    await env.webhook('message.sent', waMessage('919812300010@c.us', 'true_919812300010@c.us_PHONE2', 'Yes!', { fromMe: true, at: env.clock.now().toISOString() }));
    await settle();
    expect((await env.api('GET', '/api/inbox')).body.unread).toBe(0);

    // A reply from WA Reach, then WhatsApp's echo of it: one message, labelled as WA Reach's.
    const reply = await env.api('POST', `/api/inbox/${id}/send`, { text: 'It ships today' });
    const echo = waMessage('919812300010@c.us', reply.body.messageId, 'It ships today', { fromMe: true, at: env.clock.now().toISOString() });
    expect((await env.webhook('message.sent', echo)).body.outcome).toBe('duplicate_message');
    const thread = (await env.api('GET', `/api/inbox/${id}`)).body.messages;
    expect(thread.map((m: any) => [m.direction, m.sourceType, m.body])).toEqual([
      ['in', 'inbound', 'Is it in stock?'],
      ['out', 'phone', 'Yes!'],
      ['out', 'manual', 'It ships today'],
    ]);

    // When the echo wins the race, the send still ends up labelled (and counted) as a campaign/reply.
    const nextId = `true_919812300010@c.us_3EB0${String(env.fake.sent.length + 1).padStart(6, '0')}`;
    await env.webhook('message.sent', waMessage('919812300010@c.us', nextId, 'Thanks for asking', { fromMe: true, at: env.clock.now().toISOString() }));
    const second = await env.api('POST', `/api/inbox/${id}/send`, { text: 'Thanks for asking' });
    expect(second.body.messageId).toBe(nextId);
    const row = env.core.db.get<{ source_type: string; n: number }>('SELECT source_type, COUNT(*) AS n FROM messages WHERE wa_message_id = ?', nextId)!;
    expect(row).toMatchObject({ source_type: 'manual', n: 1 });
  });

  it("an echo of a campaign message never marks the customer's unread reply as read", async () => {
    env = await createTestEnv();
    env.clock.advance(60_000);
    await env.webhook('message.received', inbound('919812300015', 'What is the price?'));
    const id = (await env.api('GET', '/api/inbox')).body.items[0].contactId;
    // WhatsApp's echo of a campaign send arrives before WA Reach has recorded the send.
    env.clock.advance(60_000);
    const echo = waMessage('919812300015@c.us', 'true_919812300015@c.us_CAMPAIGN1', 'Diwali offer!', { fromMe: true, at: env.clock.now().toISOString() });
    expect((await env.webhook('message.sent', echo)).body.outcome).toBe('sent_from_phone');
    env.s.messages.recordOutbound({ contactId: id, sessionId: env.sessionId, chatId: '919812300015@c.us', waMessageId: echo.id, body: 'Diwali offer!', sourceType: 'campaign' });
    await settle();
    expect((await env.api('GET', '/api/inbox')).body.unread).toBe(1);
    expect(env.core.db.get<{ source_type: string }>('SELECT source_type FROM messages WHERE wa_message_id = ?', echo.id)!.source_type).toBe('campaign');
  });

  it('copies the chats already on the phone once, oldest to newest, with unread counts as on the phone', async () => {
    env = await createTestEnv({ saveUnknownSenders: false });
    env.s.autoReplies.create({ name: 'Any', matchType: 'any', keywords: [], replyBody: 'Thanks!', active: true, priority: 900 });
    const known = await env.api('POST', '/api/contacts', { phone: '+91 98123 00012', name: 'Ravi (customer)' });
    const asha = '919812300011@c.us';
    const ravi = '919812300012@c.us';
    env.fake.chats.set(env.sessionId, [
      { id: ravi, name: 'Ravi', kind: 'individual', unreadCount: 0, timestamp: seconds('2026-09-24T10:00:00Z') },
      { id: asha, name: 'Asha Sharma', kind: 'individual', unreadCount: 1, timestamp: seconds('2026-09-20T10:00:00Z') },
      { id: '1203630@g.us', name: 'Family', isGroup: true, kind: 'group' },
      { id: 'status@broadcast', name: 'Status', kind: 'status' },
    ]);
    env.fake.history.set(asha, [
      waMessage(asha, 'a1', 'Hello, do you deliver?', { at: '2026-09-20T09:00:00Z' }),
      waMessage(asha, 'a2', 'Yes, everywhere in Pune', { fromMe: true, at: '2026-09-20T09:05:00Z' }),
      waMessage(asha, 'a3', '', { at: '2026-09-20T09:06:00Z', type: 'unknown' }),
      waMessage(asha, 'a4', '', { at: '2026-09-20T09:07:00Z', type: 'image' }),
      waMessage(asha, 'a5', 'ZmFrZS1tYXAtcGljdHVyZQ'.repeat(20), {
        at: '2026-09-20T10:00:00Z',
        type: 'location',
        extra: { location: { latitude: 18.52, longitude: 73.85, description: 'Shop', address: 'FC Road' } },
      }),
    ]);
    env.fake.history.set(ravi, [waMessage(ravi, 'r1', 'Order received?', { at: '2026-09-24T10:00:00Z' })]);
    env.fake.history.set('1203630@g.us', [waMessage('1203630@g.us', 'g1', 'family stuff', { at: '2026-09-24T11:00:00Z' })]);

    await env.run(1);
    await env.s.history.idle();

    const status = await env.api('GET', '/api/inbox/sync');
    expect(status.body.numbers[0].sync).toMatchObject({ state: 'done', chatsTotal: 2, chatsDone: 2, messages: 5 });
    const inbox = await env.api('GET', '/api/inbox');
    expect(inbox.body.items.map((c: any) => [c.name, c.saved, c.unread, c.lastMessage])).toEqual([
      ['Ravi (customer)', true, 0, 'Order received?'],
      ['Asha Sharma', false, 1, 'Shop, FC Road\nhttps://maps.google.com/?q=18.52,73.85'],
    ]);
    // Only the last unread message is unread, as on the phone; copying triggers nothing.
    expect(inbox.body.unread).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM outbox')).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE body = 'family stuff'")).toBe(0);
    expect((await env.api('GET', '/api/contacts')).body.total).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM messages WHERE contact_id = ?', known.body.contact.id)).toBe(1);

    const ashaId = inbox.body.items[1].contactId;
    const thread = (await env.api('GET', `/api/inbox/${ashaId}`)).body;
    expect(thread.messages.map((m: any) => [m.direction, m.type, m.sourceType])).toEqual([
      ['in', 'text', 'inbound'],
      ['out', 'text', 'phone'],
      ['in', 'image', 'inbound'],
      ['in', 'location', 'inbound'],
    ]);
    expect(thread.messages[2].file).toMatchObject({ kind: 'image' });
    expect(thread).toMatchObject({ hasOlder: false, canReadPhone: true });

    // Live messages after the copy sort after it; later ticks don't copy again.
    await env.webhook('message.received', { ...inbound('919812300011', 'Can I order now?'), timestamp: seconds(env.clock.now().toISOString()) });
    env.fake.history.set(asha, [waMessage(asha, 'a9', 'not copied twice', { at: '2026-09-20T08:00:00Z' })]);
    await env.run(2);
    await env.s.history.idle();
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE wa_message_id = 'a9'")).toBe(0);
    expect((await env.api('GET', '/api/inbox')).body.items[0]).toMatchObject({ name: 'Asha Sharma', lastMessage: 'Can I order now?' });

    // "Sync chats from WhatsApp" copies again; messages already there are skipped.
    const again = await env.api('POST', '/api/inbox/sync', {});
    expect(again.status).toBe(200);
    await env.s.history.idle();
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE wa_message_id = 'a9'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE wa_message_id = 'a1'")).toBe(1);
  });

  it('loads earlier messages of a chat from the phone', async () => {
    env = await createTestEnv();
    const chat = '919812300013@c.us';
    env.fake.chats.set(env.sessionId, [{ id: chat, name: 'Meera', kind: 'individual' }]);
    const start = new Date('2026-06-01T00:00:00Z').getTime();
    env.fake.history.set(
      chat,
      Array.from({ length: 250 }, (_, i) => waMessage(chat, `m${i}`, `message ${i}`, { fromMe: i % 2 === 1, at: new Date(start + i * 60_000).toISOString() })),
    );
    await env.run(1);
    await env.s.history.idle();
    const id = (await env.api('GET', '/api/inbox')).body.items[0].contactId;
    expect(count('SELECT COUNT(*) AS n FROM messages WHERE contact_id = ?', id)).toBe(100);

    const first = await env.api('GET', `/api/inbox/${id}?limit=60`);
    expect(first.body.messages).toHaveLength(60);
    expect(first.body.messages[59].body).toBe('message 249');
    expect(first.body.hasOlder).toBe(true);

    const earlier = await env.api('POST', `/api/inbox/${id}/earlier`, {});
    expect(earlier.body).toEqual({ added: 150, more: false });
    const all = await env.api('GET', `/api/inbox/${id}?limit=1000`);
    expect(all.body.messages).toHaveLength(250);
    expect(all.body.messages[0].body).toBe('message 0');
    expect(all.body.hasOlder).toBe(false);
  });

  it('shows photos and files from WhatsApp safely', async () => {
    env = await createTestEnv();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    env.fake.media.set('img1', { mimetype: 'image/png', base64: png });
    env.fake.media.set('doc1', { mimetype: 'text/html', base64: Buffer.from('<script>alert(1)</script>').toString('base64') });
    await env.webhook('message.received', { ...inbound('919812300014', '', 'img1'), type: 'image', body: 'Our shop front', media: { mimetype: 'image/png' } });
    await env.webhook('message.received', { ...inbound('919812300014', '', 'doc1'), type: 'document', body: '', media: { mimetype: 'text/html', filename: 'price "list".html' } });
    await env.webhook('message.received', { ...inbound('919812300014', '', 'voice1'), type: 'voice', body: '' });
    await env.webhook('message.received', inbound('919812300014', 'plain text', 'text1'));
    const id = (await env.api('GET', '/api/inbox')).body.items[0].contactId;
    const messages = (await env.api('GET', `/api/inbox/${id}`)).body.messages;
    expect(messages.map((m: any) => m.file?.kind ?? null)).toEqual(['image', 'document', 'audio', null]);
    expect(messages[0]).toMatchObject({ body: 'Our shop front', file: { mimetype: 'image/png' } });

    const image = await env.app.inject({ method: 'GET', url: `/api/inbox/media/${messages[0].id}`, headers: { 'x-api-key': env.apiKey } });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['content-disposition']).toMatch(/^inline/);
    expect(image.headers['content-security-policy']).toContain('sandbox');
    expect(image.rawPayload.toString('base64')).toBe(png);

    // Anything that is not a plain picture, video or audio is a download, never shown in the page.
    const doc = await env.app.inject({ method: 'GET', url: `/api/inbox/media/${messages[1].id}`, headers: { 'x-api-key': env.apiKey } });
    expect(doc.headers['content-type']).toBe('application/octet-stream');
    expect(doc.headers['content-disposition']).toMatch(/^attachment; filename="price _list_.html"/);
    expect(doc.headers['x-content-type-options']).toBe('nosniff');

    expect((await env.app.inject({ method: 'GET', url: `/api/inbox/media/${messages[2].id}`, headers: { 'x-api-key': env.apiKey } })).statusCode).toBe(404);
    expect((await env.app.inject({ method: 'GET', url: `/api/inbox/media/${messages[3].id}`, headers: { 'x-api-key': env.apiKey } })).statusCode).toBe(404);
    // Not signed in: no files.
    expect((await env.app.inject({ method: 'GET', url: `/api/inbox/media/${messages[0].id}` })).statusCode).toBe(401);
  });
});
