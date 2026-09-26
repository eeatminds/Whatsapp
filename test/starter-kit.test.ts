import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, inbound, type TestEnv } from './helpers.js';
import { seedStarterKit } from '../server/services/starter-kit.js';

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv({ starterKit: true });
});
afterEach(async () => {
  await env.close();
});

describe('starter kit', () => {
  it('gives every business ready-made templates and switched-off automations, once', async () => {
    const templates = (await env.api('GET', '/api/templates')).body;
    expect(templates.length).toBe(14);
    expect(templates.map((t: { name: string }) => t.name)).toContain('Festival offer');

    const rules = (await env.api('GET', '/api/auto-replies')).body;
    expect(rules.length).toBe(6);
    expect(rules.every((r: { active: boolean }) => !r.active)).toBe(true);

    const sequences = (await env.api('GET', '/api/sequences')).body;
    expect(sequences.length).toBe(3);
    expect(sequences.every((q: { active: boolean }) => !q.active)).toBe(true);

    // Seeding again (e.g. after a restart) adds nothing.
    expect(seedStarterKit(env.core.db, env.s, new Date().toISOString())).toBe(false);
    expect((await env.api('GET', '/api/templates')).body.length).toBe(14);
  });

  it('sends nothing until the owner switches a rule on', async () => {
    const off = await env.webhook('message.received', inbound('919876544441', 'Hi'));
    expect(off.body.outcome).toBe('received');

    const greeting = (await env.api('GET', '/api/auto-replies')).body.find((r: { name: string }) => r.name.startsWith('Greeting menu'));
    expect((await env.api('PATCH', `/api/auto-replies/${greeting.id}`, { ...greeting, active: true })).status).toBe(200);
    const on = await env.webhook('message.received', inbound('919876544442', 'hello'));
    expect(on.body.outcome).toBe('auto_reply');
    await env.run(10, 1000);
    expect(env.fake.sent.at(-1)?.text).toMatch(/^Hi \w+! 👋 Welcome to \*Test Shop\*\.[\s\S]*\*1\* Price list/);
  });
});
