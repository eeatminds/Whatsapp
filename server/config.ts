import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  dataDir: string;
  /** SQLite file, or ':memory:' for tests. */
  dbPath: string;
  mediaDir: string;
  openwa: {
    /** Base URL of the OpenWA gateway, without the /api suffix. */
    url: string;
    apiKey: string;
    /** HMAC secret registered on the OpenWA webhook; every delivery is verified against it. */
    webhookSecret: string;
  };
  /** URL OpenWA posts events to. Inside docker-compose this is the internal service name. */
  webhookUrl: string;
  /** Public base URL of this app. Needed for click-tracked links; null disables tracking. */
  publicUrl: string | null;
  /** First platform admin, created on first boot. */
  adminEmail: string;
  adminPassword: string;
  /** Signs session cookies. */
  appSecret: string;
  /** Optional key for server-to-server use of the REST API (X-API-Key header). */
  apiKey: string | null;
  cookieSecure: boolean;
  dispatcherIntervalMs: number;
  /** Values that were generated on first boot, so the operator can be told where to find them. */
  generated: string[];
}

function readOrCreateSecret(
  dataDir: string,
  file: string,
  envValue: string | undefined,
  bytes: number,
  generated: string[],
  label: string,
): string {
  if (envValue && envValue.trim()) return envValue.trim();
  const path = join(dataDir, file);
  if (existsSync(path)) {
    const stored = readFileSync(path, 'utf8').trim();
    if (stored) return stored;
  }
  const value = randomBytes(bytes).toString('base64url');
  writeFileSync(path, value + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  generated.push(`${label} (saved to ${path})`);
  return value;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const dataDir = resolve(env.DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true });
  const mediaDir = join(dataDir, 'media');
  mkdirSync(mediaDir, { recursive: true });

  const generated: string[] = [];
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid TCP port, got '${env.PORT}'`);
  }

  const openwaUrl = trimSlash(env.OPENWA_URL ?? 'http://localhost:2785');
  const publicUrl = env.PUBLIC_URL ? trimSlash(env.PUBLIC_URL) : null;
  const webhookUrl = env.WEBHOOK_URL
    ? env.WEBHOOK_URL
    : `${publicUrl ?? `http://localhost:${port}`}/webhooks/openwa`;

  const adminPassword = readOrCreateSecret(dataDir, 'admin-password', env.ADMIN_PASSWORD, 12, generated, 'Admin password');
  if (adminPassword.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters');
  }

  const interval = Number(env.DISPATCHER_INTERVAL_MS ?? 1000);

  return {
    nodeEnv,
    host: env.HOST ?? '0.0.0.0',
    port,
    dataDir,
    dbPath: env.DB_PATH ?? join(dataDir, 'wa-reach.sqlite'),
    mediaDir,
    openwa: {
      url: openwaUrl,
      apiKey: env.OPENWA_API_KEY ?? '',
      webhookSecret: readOrCreateSecret(
        dataDir,
        'webhook-secret',
        env.OPENWA_WEBHOOK_SECRET,
        32,
        generated,
        'OpenWA webhook secret',
      ),
    },
    webhookUrl,
    publicUrl,
    adminEmail: (env.ADMIN_EMAIL ?? 'admin@example.com').trim().toLowerCase(),
    adminPassword,
    appSecret: readOrCreateSecret(dataDir, 'app-secret', env.APP_SECRET, 32, generated, 'Cookie signing secret'),
    apiKey: env.APP_API_KEY && env.APP_API_KEY.length >= 16 ? env.APP_API_KEY : null,
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : (publicUrl?.startsWith('https://') ?? false),
    dispatcherIntervalMs: Number.isFinite(interval) && interval >= 100 ? interval : 1000,
    generated,
  };
}
