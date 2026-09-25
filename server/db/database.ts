import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.js';

export type SqlParam = string | number | bigint | boolean | null | undefined | Date | Uint8Array;

function bind(value: SqlParam): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Thin synchronous wrapper around node:sqlite. Synchronous access is a feature here: the whole app
 * runs in one process, and a send claim ("queued" -> "sending") can never interleave with another.
 */
export class Db {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = NORMAL');
    }
  }

  private statement(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
    const result = this.statement(sql).run(...params.map(bind));
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.statement(sql).get(...params.map(bind)) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.statement(sql).all(...params.map(bind)) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Run fn in a transaction. Nested calls use savepoints, so helpers can compose freely. */
  tx<T>(fn: () => T): T {
    const depth = this.txDepth;
    const savepoint = `sp_${depth}`;
    this.raw.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      this.raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.txDepth--;
      this.raw.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }

  migrate(): void {
    const row = this.get<{ user_version: number }>('PRAGMA user_version');
    const current = row?.user_version ?? 0;
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[version]);
        this.raw.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }
}

export function openDatabase(path: string): Db {
  const db = new Db(path);
  db.migrate();
  return db;
}

export function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
