import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

describe('Inbox: every message from the moment a number is linked', () => {
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

  it('starts from the moment a number is linked: old chats an earlier version copied in are removed', async () => {
    env = await createTestEnv();
    const db = env.core.db;
    const linked = db.get<{ created_at: string }>('SELECT created_at FROM owned_sessions WHERE session_id = ?', env.sessionId)!.created_at;
    // A customer who wrote after the number was linked, and a reply from the phone.
    env.clock.advance(60_000);
    await env.webhook('message.received', inbound('919812300018', 'Hi, is the shop open today?', 'live1'));
    await env.webhook('message.sent', waMessage('919812300018@c.us', 'live2', 'Yes, till 9pm', { fromMe: true, at: env.clock.now().toISOString() }));
    const customer = env.core.db.get<{ id: number }>("SELECT id FROM contacts WHERE phone = '919812300018'")!.id;
    // What the earlier version copied from the phone: messages from before the number was linked,
    // with a downloaded photo, and someone who was only in the Inbox because of them.
    const old = new Date(new Date(linked).getTime() - 30 * 86_400_000).toISOString();
    const stranger = env.s.contacts.forChat('919812300019', '919812300019@c.us', 'Old friend').id;
    env.s.messages.recordCopy({ contactId: stranger, sessionId: env.sessionId, chatId: '919812300019@c.us', direction: 'in', waMessageId: 'old1', type: 'image', body: null, at: old, seen: true });
    env.s.messages.recordCopy({ contactId: customer, sessionId: env.sessionId, chatId: '919812300018@c.us', direction: 'out', waMessageId: 'old2', type: 'text', body: 'last month', at: old, seen: true });
    const photo = db.get<{ id: number }>("SELECT id FROM messages WHERE wa_message_id = 'old1'")!.id;
    const folder = join(dirname(env.config.mediaDir), 'chat-media');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `m${photo}`), 'x');
    db.run("UPDATE messages SET media_file = ? WHERE id = ?", `m${photo}`, photo);
    db.run("INSERT INTO history_syncs (session_id, state, started_at) VALUES (?, 'done', ?)", env.sessionId, linked);

    expect(env.s.chatMedia.removeCopiedHistory()).toEqual({ messages: 2, contacts: 1 });
    expect(db.all<{ wa_message_id: string }>('SELECT wa_message_id FROM messages ORDER BY id').map(r => r.wa_message_id)).toEqual(['live1', 'live2']);
    expect(db.get("SELECT 1 FROM contacts WHERE phone = '919812300019'")).toBeUndefined();
    expect(existsSync(join(folder, `m${photo}`))).toBe(false);
    // Once only.
    expect(env.s.chatMedia.removeCopiedHistory()).toEqual({ messages: 0, contacts: 0 });
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

  it('downloads photos and documents of new messages when a chat is opened, once, and keeps them', async () => {
    env = await createTestEnv();
    const phone = '919812300016';
    const chat = `${phone}@c.us`;
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    const pdf = Buffer.from('%PDF-1.4 price list').toString('base64');
    const live = async (id: string, type: string, body = '') => {
      env!.clock.advance(60_000);
      await env!.webhook('message.received', { ...inbound(phone, body, id), type, timestamp: seconds(env!.clock.now().toISOString()) });
      return waMessage(chat, id, body, { at: env!.clock.now().toISOString(), type });
    };
    // On the phone: a photo far back (more than 100 messages ago), texts, then three files. The
    // gateway kept none of them (too big, or its download failed), so they are read from the phone.
    const phoneChat = [await live('old_photo', 'image')];
    for (let i = 0; i < 120; i++) phoneChat.push(await live(`t${i}`, 'text', `text ${i}`));
    phoneChat.push(await live('photo1', 'image', 'Our counter'), await live('doc1', 'document'), await live('gone1', 'image'));
    env.fake.history.set(chat, phoneChat);
    env.fake.phoneMedia.set('photo1', { mimetype: 'image/png', base64: png });
    env.fake.phoneMedia.set('doc1', { mimetype: 'application/pdf', base64: pdf, filename: 'Price list Oct.pdf' });
    env.fake.phoneMedia.set('old_photo', { mimetype: 'image/png', base64: png });
    const id = (await env.api('GET', '/api/inbox')).body.items[0].contactId;
    const byWa = (wa: string) => env!.core.db.get<{ id: number }>('SELECT id FROM messages WHERE wa_message_id = ?', wa)!.id;
    const before = (await env.api('GET', `/api/inbox/${id}?limit=1000`)).body.messages;
    expect(before.find((m: any) => m.id === byWa('photo1')).file).toMatchObject({ kind: 'image', ready: false, missing: false });

    // Opening the chat downloads its files in one read of the phone (last messages, with files).
    expect((await env.api('POST', `/api/inbox/${id}/media`, {})).body.downloading).toBe(4);
    await env.s.chatMedia.idle();
    expect(env.fake.historyCalls).toEqual([{ chatId: chat, limit: 13, includeMedia: true }]);
    const after = (await env.api('GET', `/api/inbox/${id}?limit=1000`)).body.messages;
    const fileOf = (wa: string) => after.find((m: any) => m.id === byWa(wa)).file;
    expect(fileOf('photo1')).toMatchObject({ ready: true, missing: false, mimetype: 'image/png', size: 16 });
    expect(fileOf('doc1')).toMatchObject({ kind: 'document', ready: true, name: 'Price list Oct.pdf', mimetype: 'application/pdf' });
    // Deleted from the phone, or too far back for WhatsApp to send (more than 100 messages ago).
    expect(fileOf('gone1')).toMatchObject({ ready: false, missing: true });
    expect(fileOf('old_photo')).toMatchObject({ ready: false, missing: true });
    // Reading the phone never adds its other messages to the Inbox.
    expect(env.core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')!.n).toBe(124);

    // Served from this server from now on, without asking the phone again.
    env.fake.historyCalls.length = 0;
    const photo = await env.app.inject({ method: 'GET', url: `/api/inbox/media/${byWa('photo1')}`, headers: { 'x-api-key': env.apiKey } });
    expect(photo.statusCode).toBe(200);
    expect(photo.headers['content-type']).toBe('image/png');
    expect(photo.rawPayload.toString('base64')).toBe(png);
    const doc = await env.app.inject({ method: 'GET', url: `/api/inbox/media/${byWa('doc1')}`, headers: { 'x-api-key': env.apiKey } });
    expect(doc.headers['content-type']).toBe('application/octet-stream');
    expect(doc.headers['content-disposition']).toContain("filename*=UTF-8''Price%20list%20Oct.pdf");
    const download = await env.app.inject({ method: 'GET', url: `/api/inbox/media/${byWa('photo1')}?download=1`, headers: { 'x-api-key': env.apiKey } });
    expect(download.headers['content-disposition']).toMatch(/^attachment/);
    const gone = await env.app.inject({ method: 'GET', url: `/api/inbox/media/${byWa('gone1')}`, headers: { 'x-api-key': env.apiKey } });
    expect(gone.statusCode).toBe(404);
    expect(env.fake.historyCalls).toEqual([]);

    // "Try again" asks the phone once more.
    env.fake.phoneMedia.set('gone1', { mimetype: 'image/png', base64: png });
    const retried = await env.app.inject({ method: 'GET', url: `/api/inbox/media/${byWa('gone1')}?retry=1`, headers: { 'x-api-key': env.apiKey } });
    expect(retried.statusCode).toBe(200);
  });

  it("keeps trying while WhatsApp can't be reached", async () => {
    env = await createTestEnv();
    await env.webhook('message.received', { ...inbound('919812300017', '', 'img_down'), type: 'image', body: '', media: { mimetype: 'image/jpeg', sizeBytes: 52_000 } });
    const id = env.core.db.get<{ id: number }>("SELECT id FROM messages WHERE wa_message_id = 'img_down'")!.id;
    expect(env.s.messages.thread(env.s.messages.byId(id)!.contact_id!).messages[0].file).toMatchObject({ size: 52_000, mimetype: 'image/jpeg' });
    await env.fake.close();
    const res = await env.app.inject({ method: 'GET', url: `/api/inbox/media/${id}`, headers: { 'x-api-key': env.apiKey } });
    expect(res.statusCode).toBe(503);
    expect(env.s.messages.byId(id)!.media_missing).toBe(0);
  });
});
