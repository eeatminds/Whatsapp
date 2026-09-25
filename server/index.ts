import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { OpenWAClient } from './openwa/client.js';
import { Platform } from './platform/platform.js';
import { buildApp } from './app.js';
import type { Logger } from './context.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const openwa = new OpenWAClient({ baseUrl: config.openwa.url, apiKey: config.openwa.apiKey });

  // Share Fastify's structured logger with the services once the app exists.
  const logRef: { current: Logger } = {
    current: { info: console.log, warn: console.warn, error: console.error, debug: () => {} },
  };
  const log: Logger = {
    info: (...a) => logRef.current.info(...(a as [string])),
    warn: (...a) => logRef.current.warn(...(a as [string])),
    error: (...a) => logRef.current.error(...(a as [string])),
    debug: (...a) => logRef.current.debug(...(a as [string])),
  };
  const platform = new Platform({ config, openwa, log });
  platform.bootstrapAdmin(config.adminEmail, config.adminPassword);

  const here = dirname(fileURLToPath(import.meta.url));
  const staticDir = process.env.STATIC_DIR ?? join(here, '..', 'web');
  const app = await buildApp(platform, { staticDir, logger: true });
  logRef.current = app.log as unknown as Logger;

  await app.listen({ host: config.host, port: config.port });

  if (!config.openwa.apiKey) {
    app.log.warn('OPENWA_API_KEY is not set: calls to the OpenWA gateway will be rejected until it is configured.');
  }
  for (const item of config.generated) app.log.warn(`Generated on first boot: ${item}`);
  app.log.info(`Platform admin: ${config.adminEmail}${config.generated.some(item => item.startsWith('Admin password')) ? ` (password in ${join(config.dataDir, 'admin-password')})` : ''}`);
  app.log.info(`OpenWA gateway: ${config.openwa.url} · webhooks: ${config.webhookUrl}/<business>`);
  if (!config.publicUrl) app.log.info('PUBLIC_URL is not set: click tracking is disabled.');

  // Starts a sending engine per paid-up business and re-checks subscriptions every minute.
  platform.start();

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await platform.stop();
    await app.close();
    platform.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
