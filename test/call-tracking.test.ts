import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createTestEnv, type TestEnv } from './helpers.js';
import { sniffAudio } from '../server/services/calls.js';

let env: TestEnv;
beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  await env.close();
});

async function login(email: string, password: string): Promise<string> {
  const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  expect(res.statusCode, `sign in as ${email}`).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0];
}

function as(cookie: string) {
  return async (method: string, url: string, body?: unknown) => {
    const res = await env.app.inject({ method: method as 'GET', url, payload: body as object | undefined, headers: { cookie } });
    let parsed: any = res.body;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      // Audio and other files stay as they are.
    }
    return { status: res.statusCode, body: parsed, headers: res.headers, raw: res.rawPayload };
  };
}

/** Requests from the phone app, signed in with its token. */
function phone(token: string) {
  return async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await env.app.inject({
      method: method as 'GET',
      url: `/device-api${url}`,
      payload: body as never,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
}

const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A isomiso2mp41', 'latin1'), Buffer.alloc(64)]);
const minutesAgo = (n: number) => env.clock.now().getTime() - n * 60_000;

describe('call tracking from team phones', () => {
  it('signs a caller in on their phone, keeps only calls with leads, and takes recordings', async () => {
    const admin = as(await login(env.owner.email, env.owner.password));
    const ram = (await admin('POST', '/api/account/users', { email: 'ram@shop.example', name: 'Ramgopal', role: 'caller' })).body;
    const asha = (await env.api('POST', '/api/contacts', { phone: '+91 98765 00001', name: 'Asha' })).body.contact.id;
    const ravi = (await env.api('POST', '/api/contacts', { phone: '+91 98765 00002', name: 'Ravi' })).body.contact.id;
    await admin('POST', '/api/leads/assign', { ids: [asha], userId: ram.user.id });

    // Signing in on the phone: the WA Reach email and password, never kept on the phone.
    const bad = await env.app.inject({ method: 'POST', url: '/device-api/login', payload: { email: 'ram@shop.example', password: 'wrong-password' } });
    expect(bad.statusCode).toBe(401);
    const admins = await env.app.inject({ method: 'POST', url: '/device-api/login', payload: { email: 'admin@example.com', password: 'platform-admin-password' } });
    expect(admins.statusCode).toBe(403);
    const signIn = await env.app.inject({ method: 'POST', url: '/device-api/login', payload: { email: 'ram@shop.example', password: ram.password, device: 'Samsung Galaxy A15' } });
    expect(signIn.statusCode).toBe(200);
    const session = signIn.json();
    expect(session).toMatchObject({ business: 'Test Shop', user: { name: 'Ramgopal' }, latestVersion: '1.0.0' });
    expect(session.token).toMatch(new RegExp(`^${env.tenantId}\\.[A-Za-z0-9]{40}$`));
    const app = phone(session.token);
    expect((await app('GET', '/status')).body).toMatchObject({ ok: true, business: 'Test Shop' });

    // The phone sends its call log. Only calls with leads are kept; a personal call is dropped.
    const upload = await app('POST', '/calls', {
      device: { appVersion: '1.0.0', recordings: 'allowed' },
      calls: [
        { number: '09876500001', type: 2, startedAt: minutesAgo(30), duration: 192 },
        { number: '+919876500001', type: 3, startedAt: minutesAgo(10), duration: 0 },
        { number: '+919811112222', type: 2, startedAt: minutesAgo(20), duration: 300 },
        { number: '9876500002', type: 2, startedAt: minutesAgo(3 * 24 * 60), duration: 50 },
      ],
    });
    expect(upload.status).toBe(200);
    expect(upload.body).toMatchObject({ stored: 2, ignored: 2 });
    expect(env.core.db.all('SELECT phone FROM calls ORDER BY id')).toEqual([{ phone: '919876500001' }, { phone: '919876500001' }]);
    // It asks for the recording of the answered call only.
    expect(upload.body.recordingsWanted).toEqual([{ id: 1, number: '919876500001', startedAt: minutesAgo(30), duration: 192 }]);
    // Sending the same calls again changes nothing.
    expect((await app('POST', '/calls', { calls: [{ number: '09876500001', type: 2, startedAt: minutesAgo(30), duration: 192 }] })).body.stored).toBe(0);

    // Only audio is accepted as a recording.
    const notAudio = await app('POST', '/recordings/1', Buffer.from('<html>hello</html>'.padEnd(40)), { 'content-type': 'application/octet-stream' });
    expect(notAudio.status).toBe(415);
    expect((await app('POST', '/recordings/1', M4A, { 'content-type': 'audio/mp4' })).status).toBe(200);
    expect((await app('POST', '/calls', { calls: [] })).body.recordingsWanted).toEqual([]);
    // "No recording found" for a call that never needed one changes nothing.
    expect((await app('POST', '/recordings/2/none', {})).status).toBe(200);
    expect((await app('POST', '/recordings/999/none', {})).status).toBe(404);

    // The admin hears it, and sees the lead was called.
    const recording = await admin('GET', '/api/calls/1/recording');
    expect(recording.status).toBe(200);
    expect(recording.headers['content-type']).toBe('audio/mp4');
    expect(Buffer.compare(recording.raw, M4A)).toBe(0);
    const summary = (await admin('GET', `/api/calls/summary?ids=${asha},${ravi}`)).body;
    expect(summary.tracking).toBe(true);
    expect(summary.leads[asha]).toMatchObject({ calls: 2, answered: 1, talkSeconds: 192, last: { direction: 'missed', userId: ram.user.id }, remarkWithoutCall: false });
    expect(summary.leads[ravi]).toMatchObject({ calls: 0, last: null, remarkWithoutCall: false });

    // A remark on a lead nobody called is flagged.
    await env.api('PUT', `/api/contacts/${ravi}/lead`, { stage: 'warm', remark: 'Spoke to him, will visit Sunday' });
    expect((await admin('GET', `/api/calls/summary?ids=${ravi}`)).body.leads[ravi].remarkWithoutCall).toBe(true);
    await admin('POST', '/api/leads/assign', { ids: [ravi], userId: ram.user.id });
    const report = (await admin('GET', '/api/calls/report')).body;
    expect(report.people).toEqual([
      { userId: ram.user.id, calls: 2, outgoing: 1, answered: 1, talkSeconds: 192, leadsCalled: 1, recorded: 1, remarksWithoutCall: 1 },
    ]);
    expect(report.devices).toMatchObject([{ userId: ram.user.id, name: 'Samsung Galaxy A15', appVersion: '1.0.0', recordings: 'allowed' }]);
    expect((await admin('GET', `/api/calls?contactId=${asha}`)).body.items.map((c: any) => [c.direction, c.duration, c.recording])).toEqual([
      ['missed', 0, 'none'],
      ['outgoing', 192, 'saved'],
    ]);

    // The caller sees the calls of their own leads only, and nothing else about calls.
    const caller = as(await login('ram@shop.example', ram.password));
    await admin('POST', '/api/leads/assign', { ids: [ravi], userId: null });
    expect(Object.keys((await caller('GET', `/api/calls/summary?ids=${asha},${ravi}`)).body.leads)).toEqual([String(asha)]);
    expect((await caller('GET', '/api/call-app')).status).toBe(200);
    for (const url of ['/api/calls', '/api/calls/report', '/api/calls/1/recording', '/api/call-devices']) expect((await caller('GET', url)).status, url).toBe(403);
  });

  it('signs the phone out when the password changes, the person is removed, or the admin says so', async () => {
    const admin = as(await login(env.owner.email, env.owner.password));
    const one = (await admin('POST', '/api/account/users', { email: 'one@shop.example', role: 'caller' })).body;
    const connect = async (password: string) =>
      (await env.app.inject({ method: 'POST', url: '/device-api/login', payload: { email: 'one@shop.example', password } })).json().token as string;

    let app = phone(await connect(one.password));
    expect((await app('GET', '/status')).status).toBe(200);
    // The admin sets a new password: the phone must sign in again.
    const next = (await admin('POST', `/api/account/users/${one.user.id}/password`, { password: 'new-password-2026' })).body.password;
    const out = await app('GET', '/status');
    expect(out.status).toBe(401);
    expect(out.body.signedOut).toBe(true);

    // The admin signs a phone out from WA Reach.
    app = phone(await connect(next));
    const devices = (await admin('GET', '/api/call-devices')).body.items;
    expect(devices).toHaveLength(1);
    await admin('DELETE', `/api/call-devices/${devices[0].id}`);
    expect((await app('POST', '/calls', { calls: [] })).status).toBe(401);

    // Signing out from the phone itself (the app sends an empty JSON body).
    app = phone(await connect(next));
    expect((await app('POST', '/logout', {})).status).toBe(200);
    expect((await app('GET', '/status')).status).toBe(401);
    // Removing the person signs out every phone they had.
    app = phone(await connect(next));
    await admin('DELETE', `/api/account/users/${one.user.id}`);
    expect((await app('GET', '/status')).status).toBe(401);
    expect((await admin('GET', '/api/call-devices')).body.items).toEqual([]);
    // A made-up token is refused the same way.
    expect((await phone(`${env.tenantId}.${'x'.repeat(40)}`)('GET', '/status')).status).toBe(401);
  });

  it('deletes recordings after the days the business chose, keeping the call details', async () => {
    const admin = as(await login(env.owner.email, env.owner.password));
    await env.api('POST', '/api/contacts', { phone: '+91 98765 00001', name: 'Asha' });
    const token = (await env.app.inject({ method: 'POST', url: '/device-api/login', payload: { email: env.owner.email, password: env.owner.password } })).json().token;
    const app = phone(token);
    await app('POST', '/calls', { device: { recordings: 'allowed' }, calls: [{ number: '9876500001', type: 1, startedAt: minutesAgo(5), duration: 60 }] });
    await app('POST', '/recordings/1', M4A, { 'content-type': 'audio/mp4' });
    const file = env.core.db.get<{ recording_file: string }>('SELECT recording_file FROM calls')!.recording_file;
    const path = `${env.config.mediaDir.replace(/\/media$/, '')}/call-recordings/${file}`;
    expect(existsSync(path)).toBe(true);

    expect((await env.api('PUT', '/api/settings', { callRecordingDays: 30 })).status).toBe(200);
    env.clock.advance(29 * 86_400_000);
    env.s.calls.prune();
    expect(existsSync(path)).toBe(true);
    env.clock.advance(2 * 86_400_000);
    expect(env.s.calls.prune()).toEqual({ deleted: 1 });
    expect(existsSync(path)).toBe(false);
    expect((await admin('GET', '/api/calls')).body.items).toMatchObject([{ duration: 60, recording: 'deleted' }]);
    expect((await admin('GET', '/api/calls/1/recording')).status).toBe(404);
  });

  it('recognises the audio formats phone dialers record in', () => {
    const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(16)]);
    expect(sniffAudio(M4A)).toEqual({ ext: 'm4a', mime: 'audio/mp4' });
    expect(sniffAudio(pad(Buffer.from('\x00\x00\x00\x18ftyp3gp4', 'latin1')))).toEqual({ ext: '3gp', mime: 'audio/3gpp' });
    expect(sniffAudio(pad(Buffer.from('#!AMR\n', 'latin1')))).toEqual({ ext: 'amr', mime: 'audio/amr' });
    expect(sniffAudio(pad(Buffer.from('OggS', 'latin1')))).toEqual({ ext: 'ogg', mime: 'audio/ogg' });
    expect(sniffAudio(pad(Buffer.from('ID3\x04', 'latin1')))).toEqual({ ext: 'mp3', mime: 'audio/mpeg' });
    expect(sniffAudio(pad(Buffer.from([0xff, 0xf1, 0x50, 0x80])))).toEqual({ ext: 'aac', mime: 'audio/aac' });
    expect(sniffAudio(pad(Buffer.from('RIFF\x00\x00\x00\x00WAVE', 'latin1')))).toEqual({ ext: 'wav', mime: 'audio/wav' });
    expect(sniffAudio(pad(Buffer.from('%PDF-1.7', 'latin1')))).toBeNull();
  });
});
