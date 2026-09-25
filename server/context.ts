import type { Db } from './db/database.js';
import type { AppConfig } from './config.js';
import type { OpenWAApi } from './openwa/client.js';

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
  clock: () => Date;
  log: Logger;
}
