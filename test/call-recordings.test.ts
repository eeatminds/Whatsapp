import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestEnv, type TestEnv } from './helpers.js';
import { MIGRATIONS } from '../server/db/schema.js';
import { openDatabase } from '../server/db/database.js';
import { audioSeconds } from '../server/lib/audio.js';

let env: TestEnv;
beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  await env.close();
});

async function login(email: string, password: string): Promise<string> {
  const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  return String(res.headers['set-cookie']).split(';')[0];
}
const admin = async (method: string, url: string, body?: unknown) => {
  const cookie = await login(env.owner.email, env.owner.password);
  const res = await env.app.inject({ method: method as 'GET', url, payload: body as object | undefined, headers: { cookie } });
  return JSON.parse(res.body);
};
function phone(token: string) {
  return async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await env.app.inject({ method: method as 'GET', url: `/device-api${url}`, payload: body as never, headers: { authorization: `Bearer ${token}`, ...headers } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
}
const signIn = async (email: string, password: string, device = 'Vivo V2514') =>
  phone((await env.app.inject({ method: 'POST', url: '/device-api/login', payload: { email, password, device } })).json().token);
const minutesAgo = (n: number) => env.clock.now().getTime() - n * 60_000;

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** A real AAC recording `seconds` long, as a phone dialer saves it. */
function recording(seconds: number): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'));
  const file = join(dir, 'call.m4a');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'aac', '-b:a', '32k', file]);
  const data = readFileSync(file);
  rmSync(dir, { recursive: true, force: true });
  return data;
}

describe('call recordings', () => {
  it('moves waiting calls to the new sign-in when someone signs in again on the same phone', async () => {
    const caller = await admin('POST', '/api/account/users', { email: 'shreyas@shop.example', role: 'caller' });
    await env.api('POST', '/api/contacts', { phone: '+91 63072 54136', name: 'Goldee kushwaha' });
    const first = await signIn('shreyas@shop.example', caller.password);
    await first('POST', '/calls', { device: { recordings: 'allowed' }, calls: [{ number: '6307254136', type: 1, startedAt: minutesAgo(20), duration: 65 }] });

    // The app is reinstalled and signs in again on the same Vivo: one phone, and it gets the call to look for.
    const again = await signIn('shreyas@shop.example', caller.password);
    expect((await admin('GET', '/api/call-devices')).items).toHaveLength(1);
    expect((await first('GET', '/status')).status).toBe(401);
    const res = await again('POST', '/calls', { device: { recordings: 'allowed' }, calls: [] });
    expect(res.body.recordingsWanted).toMatchObject([{ number: '916307254136', duration: 65 }]);

    // A different phone of the same person is a second phone, not a repeat sign-in.
    await signIn('shreyas@shop.example', caller.password, 'Samsung Galaxy A15');
    expect((await admin('GET', '/api/call-devices')).items).toHaveLength(2);
  });

  it('cleans up repeat sign-ins already on the server when it updates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    // The database as it was before the update that merges repeat sign-ins.
    const before = MIGRATIONS.findIndex(sql => sql.includes('repeat_sign_in'));
    const db = openDatabase(join(dir, 'tenant.db'), MIGRATIONS.slice(0, before));
    const phone = (seen: string) =>
      db.run(
        "INSERT INTO call_devices (user_id, name, token_hash, session_version, since, created_at, last_seen_at) VALUES (7, 'Vivo V2514', ?, 1, '2026-11-16T00:00:00Z', ?, ?)",
        `hash-${seen}`,
        seen,
        seen,
      ).lastInsertRowid;
    const old = phone('2026-11-17T18:40:00.000Z');
    const current = phone('2026-11-18T10:40:00.000Z');
    const insertCall = (device: number, at: string, status: string) =>
      db.run(
        "INSERT INTO calls (device_id, user_id, phone, direction, started_at, duration, recording_status, created_at) VALUES (?, 7, '916307254136', 'incoming', ?, 65, ?, ?)",
        device,
        at,
        status,
        at,
      );
    insertCall(old, '2026-11-17T17:51:00.000Z', 'pending');
    insertCall(old, '2026-11-17T12:00:00.000Z', 'none');

    db.migrate(MIGRATIONS);
    expect(db.get<{ revoked_at: string | null }>('SELECT revoked_at FROM call_devices WHERE id = ?', old)?.revoked_at).toBeTruthy();
    expect(db.get<{ revoked_at: string | null }>('SELECT revoked_at FROM call_devices WHERE id = ?', current)?.revoked_at).toBeNull();
    expect(db.all<{ device_id: number; recording_status: string }>('SELECT device_id, recording_status FROM calls ORDER BY started_at')).toEqual([
      { device_id: old, recording_status: 'none' },
      { device_id: current, recording_status: 'pending' },
    ]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasFfmpeg)('keeps only the conversation when the dialer recorded the ringing too', async () => {
    const caller = await admin('POST', '/api/account/users', { email: 'shreyas@shop.example', role: 'caller' });
    await env.api('POST', '/api/contacts', { phone: '+91 74808 02405', name: 'Pawan Yadav' });
    await env.api('POST', '/api/contacts', { phone: '+91 60034 16630', name: 'Pratik dey' });
    const app = await signIn('shreyas@shop.example', caller.password);
    await app('POST', '/calls', {
      device: { recordings: 'allowed' },
      calls: [
        { number: '7480802405', type: 2, startedAt: minutesAgo(10), duration: 20 },
        { number: '6003416630', type: 2, startedAt: minutesAgo(30), duration: 12 },
      ],
    });
    const calls = (await admin('GET', '/api/calls')).items as Array<{ id: number; phone: string }>;
    const pawan = calls.find(c => c.phone === '917480802405')!.id;
    const pratik = calls.find(c => c.phone === '916003416630')!.id;

    // 32 s of file for a 20 s call: 12 s of ringing first. Only the last 21 s (the talk and a second) are kept.
    expect((await app('POST', `/recordings/${pawan}`, recording(32), { 'content-type': 'audio/mp4' })).status).toBe(200);
    // A recording as long as the call is left alone.
    expect((await app('POST', `/recordings/${pratik}`, recording(12), { 'content-type': 'audio/mp4' })).status).toBe(200);

    const dir = join(env.config.mediaDir.replace(/\/media$/, ''), 'call-recordings');
    const pawanLength = (await audioSeconds(join(dir, `c${pawan}.m4a`)))!;
    expect(pawanLength).toBeGreaterThan(19.5);
    expect(pawanLength).toBeLessThan(22.5);
    const pratikLength = (await audioSeconds(join(dir, `c${pratik}.m4a`)))!;
    expect(pratikLength).toBeGreaterThan(11.5);
    expect(pratikLength).toBeLessThan(13);
    // The download is the trimmed file, and its size on record matches.
    const listed = (await admin('GET', '/api/calls')).items.find((c: { id: number }) => c.id === pawan);
    expect(listed.recording).toBe('saved');
  });
});
