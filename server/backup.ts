/**
 * Backup helper, run inside the container by deploy/backup.sh:
 *
 *   node dist/server/backup.js snapshot <dir>     consistent copy of every database, media and key file
 *   node dist/server/backup.js record ok|failed [message]
 *
 * Databases are copied with SQLite's VACUUM INTO, which is safe while the app keeps running. The
 * snapshot mirrors the data folder, so restoring is copying it back into the data volume.
 */
import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const dataDir = resolve(process.env.DATA_DIR ?? './data');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === '.backup' || name === 'backups') continue;
    const info = statSync(path);
    if (info.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function snapshot(target: string): void {
  const out = resolve(target);
  mkdirSync(out, { recursive: true });
  let databases = 0;
  let files = 0;
  for (const path of walk(dataDir)) {
    const rel = relative(dataDir, path);
    const dest = join(out, 'data', rel);
    // WAL and journal files are folded into the VACUUM INTO copy.
    if (/\.sqlite-(wal|shm|journal)$/.test(path)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    if (path.endsWith('.sqlite')) {
      const db = new DatabaseSync(path);
      try {
        db.exec('PRAGMA busy_timeout = 10000');
        db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
      } finally {
        db.close();
      }
      databases++;
    } else {
      cpSync(path, dest);
      files++;
    }
  }
  console.log(`Snapshot ready: ${databases} databases, ${files} other files`);
}

function record(status: string, message: string): void {
  const path = join(dataDir, 'platform.sqlite');
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = 'backup'").get() as { value?: string } | undefined;
    const previous = row?.value ? (JSON.parse(row.value) as Record<string, unknown>) : {};
    const now = new Date().toISOString();
    const next = status === 'ok' ? { ...previous, lastRunAt: now, lastOkAt: now, lastError: null, lastFile: message || null } : { ...previous, lastRunAt: now, lastError: message || 'Backup failed' };
    db.prepare("INSERT INTO platform_settings (key, value) VALUES ('backup', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
  } finally {
    db.close();
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'snapshot' && args[0]) snapshot(args[0]);
else if (command === 'record' && (args[0] === 'ok' || args[0] === 'failed')) record(args[0], args.slice(1).join(' ').slice(0, 300));
else {
  console.error('Usage: backup.js snapshot <dir> | record ok|failed [message]');
  process.exit(2);
}
