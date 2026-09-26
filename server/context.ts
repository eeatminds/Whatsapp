import type { Db } from './db/database.js';
import type { AppConfig } from './config.js';
import type { OpenWAApi } from './openwa/client.js';
import type { MetaApi } from './meta/client.js';

export interface Logger {
  info(msg: string | object, ...args: unknown[]): void;
  warn(msg: string | object, ...args: unknown[]): void;
  error(msg: string | object, ...args: unknown[]): void;
  debug(msg: string | object, ...args: unknown[]): void;
}

export const consoleLogger: Logger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  debug: () => {},
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

export interface Core {
  db: Db;
  config: AppConfig;
  openwa: OpenWAApi;
  /** Meta's official Cloud API, for numbers a business connects with its own Meta app. */
  meta: MetaApi;
  clock: () => Date;
  log: Logger;
}
