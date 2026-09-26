import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { OpenWAClient } from '../server/openwa/client.js';
import type { Services } from '../server/services/index.js';
import { Platform } from '../server/platform/platform.js';
import { buildApp } from '../server/app.js';
import { silentLogger, type Core } from '../server/context.js';
import type { AppConfig } from '../server/config.js';
import { signOpenWABody } from '../server/lib/crypto.js';
import { startFakeOpenWA, type FakeOpenWA } from './fake-openwa.js';

export class FakeClock {
  private current: number;
  constructor(iso: string) {
    this.current = new Date(iso).getTime();
  }
  now = (): Date => new Date(this.current);
  advance(ms: number): void {
    this.current += ms;
  }
  set(iso: string): void {
    this.current = new Date(iso).getTime();
  }
}

export interface TestEnv {
  fake: FakeOpenWA;
  clock: FakeClock;
  core: Core;
  s: Services;
  app: FastifyInstance;
  config: AppConfig;
  platform: Platform;
  tenantId: string;
  apiKey: string;
  owner: { email: string; password: string };
  sessionId: string;
  api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }>;
  webhook(event: string, data: Record<string, unknown>, options?: { key?: string; sessionId?: string; secret?: string }): Promise<{ status: number; body: any }>;
  /** Advance the clock and run dispatcher ticks. */
  run(ticks: number, stepMs?: number): Promise<void>;
  close(): Promise<void>;
}

/** 06:00 UTC = 11:30 in Asia/Kolkata: inside business hours. */
export const DAYTIME = '2026-09-25T06:00:00.000Z';

export async function createTestEnv(options: { publicUrl?: string | null; now?: string; starterKit?: boolean } = {}): Promise<TestEnv> {
  const fake = await startFakeOpenWA();
  const session = fake.addSession('main', 'ready');
  const mediaDir = mkdtempSync(join(tmpdir(), 'wa-reach-test-'));
  const config: AppConfig = {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    dataDir: mediaDir,
    dbPath: ':memory:',
    mediaDir,
    openwa: { url: fake.url, apiKey: fake.apiKey, webhookSecret: 'whsec_test_secret_0123456789' },
    webhookUrl: 'http://wa-reach.test/webhooks/openwa',
    publicUrl: options.publicUrl === undefined ? 'https://reach.example.com' : options.publicUrl,
    adminEmail: 'admin@example.com',
    adminPassword: 'correct-horse-battery',
    appSecret: 'test-app-secret-test-app-secret-0123456789',
    apiKey: 'integration-api-key-0123456789',
    cookieSecure: false,
    dispatcherIntervalMs: 1000,
    generated: [],
  };
  const clock = new FakeClock(options.now ?? DAYTIME);
  const platform = new Platform({
    config,
    starterKit: options.starterKit ?? false,
    openwa: new OpenWAClient({ baseUrl: fake.url, apiKey: fake.apiKey }),
    clock: clock.now,
    log: silentLogger,
    random: () => 0.5,
  });
  platform.bootstrapAdmin('admin@example.com', 'platform-admin-password');
  const owner = { email: 'owner@shop.example', password: 'owner-password-123' };
  const { tenant } = platform.createTenant({ name: 'Test Shop', ownerEmail: owner.email, ownerPassword: owner.password, maxNumbers: 5 });
  const runtime = platform.runtime(tenant.id);
  runtime.scope.add(session.id);
  const core: Core = runtime.core;
  const s = runtime.services;
  s.settings.update({ defaultSessionId: session.id });
  const apiKey = platform.rotateApiKey(tenant.id);
  const app = await buildApp(platform, { staticDir: null });

  const api: TestEnv['api'] = async (method, url, body) => {
    const response = await app.inject({
      method: method as 'GET',
      url,
      payload: body === undefined ? undefined : (body as object),
      headers: { 'x-api-key': apiKey },
    });
    let parsed: unknown = response.body;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      // Non-JSON (CSV) bodies are returned as text.
    }
    return { status: response.statusCode, body: parsed as any };
  };

  let keyCounter = 0;
  const webhook: TestEnv['webhook'] = async (event, data, opts = {}) => {
    const envelope = {
      event,
      timestamp: clock.now().toISOString(),
      sessionId: opts.sessionId ?? session.id,
      idempotencyKey: opts.key ?? `key_${++keyCounter}`,
      deliveryId: `dlv_${keyCounter}`,
      data,
    };
    const raw = JSON.stringify(envelope);
    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/openwa/${tenant.id}`,
      payload: raw,
      headers: {
        'content-type': 'application/json',
        'x-openwa-signature': signOpenWABody(raw, opts.secret ?? config.openwa.webhookSecret),
        'x-openwa-idempotency-key': envelope.idempotencyKey,
      },
    });
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };

  const run: TestEnv['run'] = async (ticks, stepMs = 1000) => {
    for (let i = 0; i < ticks; i++) {
      clock.advance(stepMs);
      await s.dispatcher.tick();
    }
  };

  return {
    fake,
    clock,
    core,
    s,
    app,
    config: core.config,
    platform,
    tenantId: tenant.id,
    apiKey,
    owner,
    sessionId: session.id,
    api,
    webhook,
    run,
    close: async () => {
      await s.dispatcher.stop();
      await app.close();
      platform.close();
      await fake.close();
      rmSync(mediaDir, { recursive: true, force: true });
    },
  };
}

/** Inbound text from a phone number, shaped like OpenWA's message.received payload. */
export function inbound(phone: string, body: string, id = `in_${Math.random().toString(36).slice(2)}`) {
  return {
    id,
    from: `${phone}@c.us`,
    to: '919900000001@c.us',
    body,
    type: 'text',
    timestamp: 0,
    isGroup: false,
    kind: 'individual',
    hasMedia: false,
    contact: { pushName: 'Customer' },
  };
}
