import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { OpenWAClient } from './openwa/client.js';
import { createServices } from './services/index.js';
import { buildApp } from './app.js';
import type { Core, Logger } from './context.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
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
  const core: Core = { db, config, openwa, clock: () => new Date(), log };
  const services = createServices(core);

  const here = dirname(fileURLToPath(import.meta.url));
  const staticDir = process.env.STATIC_DIR ?? join(here, '..', 'web');
  const app = await buildApp(core, services, { staticDir, logger: true });
  logRef.current = app.log as unknown as Logger;

  services.dispatcher.recover();
  await app.listen({ host: config.host, port: config.port });

  if (!config.openwa.apiKey) {
    app.log.warn('OPENWA_API_KEY is not set: calls to the OpenWA gateway will be rejected until it is configured.');
  }
  for (const item of config.generated) app.log.warn(`Generated on first boot: ${item}`);
  if (config.generated.some(item => item.startsWith('Admin password'))) {
    app.log.warn(`Sign in with the admin password stored in ${join(config.dataDir, 'admin-password')} (or set ADMIN_PASSWORD).`);
  }
  app.log.info(`OpenWA gateway: ${config.openwa.url} · webhook URL registered on sessions: ${config.webhookUrl}`);
  if (!config.publicUrl) app.log.info('PUBLIC_URL is not set: click tracking is disabled.');

  // Register our webhook on every session as soon as the gateway answers.
  void services.sessions
    .syncWebhooks()
    .then(results => {
      for (const r of results) app.log.info(`Webhook for session ${r.name}: ${r.result}`);
    })
    .catch(error => app.log.warn(`OpenWA not reachable yet (${String(error)}); webhooks will sync once it is.`));

  services.dispatcher.start();

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await services.dispatcher.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
