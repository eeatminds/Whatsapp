import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  await env.close();
});

async function adminCookie(): Promise<string> {
  const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.com', password: 'platform-admin-password' } });
  return String(res.headers['set-cookie']).split(';')[0];
}

const as = async (cookie: string, method: string, url: string, payload?: unknown) => {
  const res = await env.app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

const alertsTo = (chatId: string) => env.fake.sent.filter(m => m.chatId === chatId).map(m => m.text ?? '');

describe('health alerts', () => {
  it('lists problems for the admin only and alerts on WhatsApp once they last 10 minutes', async () => {
    const admin = await adminCookie();
    const dropped = env.fake.addSession(`${env.platform.runtime(env.tenantId).scope.namePrefix}Branch`, 'disconnected');
    env.platform.runtime(env.tenantId).scope.add(dropped.id);

    // Owners never see platform health.
    const ownerRes = await env.api('GET', '/api/admin/health');
    expect(ownerRes.status).toBe(403);

    const report = await as(admin, 'GET', '/api/admin/health');
    expect(report.status).toBe(200);
    const keys = report.body.issues.map((i: { key: string }) => i.key);
    expect(keys).toContain(`number:${env.tenantId}:${dropped.id}`);
    expect(keys).toContain('backup:none');
    expect(keys).not.toContain(`number:${env.tenantId}:${env.sessionId}`);

    // Without an alert number the test alert explains what's missing.
    expect((await as(admin, 'POST', '/api/admin/health/test-alert')).status).toBe(400);
    expect((await as(admin, 'PUT', '/api/admin/settings', { alertPhone: 'not a phone', alertTenantId: env.tenantId })).status).toBe(400);
    expect((await as(admin, 'PUT', '/api/admin/settings', { alertPhone: '+91 99000 11111', alertTenantId: env.tenantId })).status).toBe(200);
    expect((await as(admin, 'POST', '/api/admin/health/test-alert')).status).toBe(200);
    await env.run(3, 2000);
    expect(alertsTo('919900011111@c.us')[0]).toContain('test alert');

    // First sighting: no alert yet (a quick reconnect shouldn't page anyone).
    await env.platform.health.check();
    await env.run(3, 2000);
    expect(alertsTo('919900011111@c.us')).toHaveLength(1);

    env.clock.advance(11 * 60_000);
    await env.platform.health.check();
    await env.run(3, 2000);
    const alert = alertsTo('919900011111@c.us')[1];
    expect(alert).toContain('Test Shop: WhatsApp number “Branch” is disconnected');
    expect(alert).toContain('https://reach.example.com/admin');

    // Still broken: not repeated.
    env.clock.advance(5 * 60_000);
    await env.platform.health.check();
    await env.run(3, 2000);
    expect(alertsTo('919900011111@c.us')).toHaveLength(2);

    // Fixed: one "resolved" message.
    dropped.status = 'ready';
    await env.platform.health.check();
    await env.run(3, 2000);
    const resolved = alertsTo('919900011111@c.us')[2];
    expect(resolved).toContain('resolved');
    expect(resolved).toContain('Branch');
  });

  it('reports failed and stale backups', async () => {
    const admin = await adminCookie();
    const setBackup = (value: object) =>
      env.platform.db.run("INSERT INTO platform_settings (key, value) VALUES ('backup', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(value));
    const now = env.clock.now().getTime();
    const iso = (ms: number) => new Date(ms).toISOString();

    setBackup({ lastRunAt: iso(now - 3_600_000), lastOkAt: iso(now - 3_600_000), lastError: null, lastFile: 'wa-reach-x.tar.gz' });
    let issues = (await as(admin, 'GET', '/api/admin/health')).body.issues.map((i: { key: string }) => i.key);
    expect(issues).not.toContain('backup:stale');
    expect(issues).not.toContain('backup:none');

    setBackup({ lastRunAt: iso(now - 60_000), lastOkAt: iso(now - 3_600_000), lastError: 'rclone: token expired', lastFile: null });
    const report = await as(admin, 'GET', '/api/admin/health');
    expect(report.body.issues.find((i: { key: string }) => i.key === 'backup:stale')?.detail).toBe('rclone: token expired');
    expect(report.body.backup.lastError).toBe('rclone: token expired');

    setBackup({ lastRunAt: iso(now - 48 * 3_600_000), lastOkAt: iso(now - 48 * 3_600_000), lastError: null, lastFile: 'old' });
    issues = (await as(admin, 'GET', '/api/admin/health')).body.issues.map((i: { key: string }) => i.key);
    expect(issues).toContain('backup:stale');
  });
});
