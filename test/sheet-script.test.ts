import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sheetScript } from '../web/src/sheet-script.js';
import { createTestEnv, type TestEnv } from './helpers.js';

type Cell = string | number | { $date: string };
interface SheetState {
  sheets: Array<{ name: string; id: number; values: Cell[][] }>;
  props: Record<string, string>;
  calls: Array<Record<string, unknown>>;
  entry?: 'setup' | 'sendNewLeads';
  triggers?: Array<{ handler: string; everyMinutes?: number }>;
}

let env: TestEnv;
let dir: string;
beforeEach(async () => {
  env = await createTestEnv({ saveUnknownSenders: false });
  dir = mkdtempSync(join(tmpdir(), 'wa-reach-sheet-'));
});
afterEach(async () => {
  await env.close();
  rmSync(dir, { recursive: true, force: true });
});

const HEAD = ['Date', 'text-870', 'phonetext-330', 'text-858', 'phonetext-330-country-code'];
const row = (date: string, name: string, phone: string, pin: string, status?: string): Cell[] => {
  const cells: Cell[] = [{ $date: `${date}T00:00:00.000Z` }, name, Number(phone), Number(pin), 91];
  return status ? [...cells, status] : cells;
};

describe('Google Sheet script', () => {
  it('reads only the chosen tabs, never messages rows that were already there, and can import them quietly', async () => {
    const tag = (await env.api('POST', '/api/tags', { name: 'website-lead' })).body;
    const welcome = (
      await env.api('POST', '/api/sequences', { name: 'Welcome', trigger: { type: 'manual' }, steps: [{ delayMinutes: 0, body: 'Hi {{first_name|there}}!' }] })
    ).body;
    const source = (
      await env.api('POST', '/api/lead-sources', {
        name: 'Naveen Tile Forms',
        kind: 'google_sheet',
        actions: { tagIds: [tag.id], sequenceId: welcome.id, notifyPhone: '+91 99000 55555' },
      })
    ).body;
    await env.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = env.app.server.address() as { port: number };
    const link = source.url.replace('https://reach.example.com', `http://127.0.0.1:${port}`);
    const scriptPath = join(dir, 'script.js');
    writeFileSync(scriptPath, sheetScript(link));
    const statePath = join(dir, 'state.json');

    const state: SheetState = {
      sheets: [
        {
          name: 'Home Above Footer Form',
          id: 101,
          values: [
            [...HEAD, 'WA Status'],
            row('2026-10-21', 'Mohanan', '9496815834', '500081', 'Sent to WA Reach'),
            row('2026-10-27', 'Shreyas', '9273193792', '560043'),
          ],
        },
        { name: 'Pop Up Form', id: 102, values: [HEAD, row('2026-09-17', 'Ravi Shankar', '7358522985', '600616')] },
        { name: 'Subscribe To Newsletter', id: 103, values: [['Date', 'Email'], [{ $date: '2026-10-01T00:00:00.000Z' }, 'reader@example.com']] },
      ],
      props: {},
      calls: [],
    };
    const save = (s: SheetState) => writeFileSync(statePath, JSON.stringify(s));
    const load = () => JSON.parse(readFileSync(statePath, 'utf8')) as SheetState;
    const run = () =>
      new Promise<SheetState>((resolve, reject) =>
        execFile(process.execPath, [join(__dirname, 'fixtures', 'apps-script-harness.mjs'), scriptPath, statePath], (error, _out, stderr) =>
          error ? reject(new Error(stderr || String(error))) : resolve(load()),
        ),
      );
    const statusOf = (s: SheetState, tab: string, r: number) => {
      const sheet = s.sheets.find(x => x.name === tab)!;
      const col = (sheet.values[0] as string[]).indexOf('WA Status');
      return sheet.values[r][col];
    };
    const contacts = () => env.core.db.all<{ phone: string; name: string; attributes: string }>('SELECT phone, name, attributes FROM contacts WHERE saved = 1 ORDER BY id');
    const enrolled = () => env.core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sequence_enrollments')!.n;
    await env.api('PUT', `/api/lead-sources/${source.id}/fields`, { fieldMap: { text_870: 'name' } });

    // Run 1 (the business clicks Run on "setup"): the every-minute check is switched on, the script
    // reports the tabs, and rows already in them are marked; nothing is sent.
    save({ ...state, entry: 'setup' });
    let s = await run();
    expect(s.triggers).toEqual([{ handler: 'sendNewLeads', everyMinutes: 1 }]);
    expect(s.calls).toEqual([{ _wa_reach: 'sync', tabs: ['Home Above Footer Form', 'Pop Up Form', 'Subscribe To Newsletter'] }]);
    // Running setup again doesn't add a second trigger.
    save({ ...s, calls: [] });
    s = await run();
    expect(s.triggers).toHaveLength(1);
    s = { ...s, entry: 'sendNewLeads', calls: [{ _wa_reach: 'sync', tabs: ['Home Above Footer Form', 'Pop Up Form', 'Subscribe To Newsletter'] }] };
    expect(statusOf(s, 'Home Above Footer Form', 1)).toBe('Sent to WA Reach');
    expect(statusOf(s, 'Home Above Footer Form', 2)).toBe('Not sent: was in the sheet before WA Reach');
    expect(statusOf(s, 'Pop Up Form', 1)).toBe('Not sent: was in the sheet before WA Reach');
    expect(contacts()).toEqual([]);
    const detail = (await env.api('GET', `/api/lead-sources/${source.id}`)).body;
    expect(detail.source.sheet).toMatchObject({ mode: 'all', existing: 'skip', tabs: ['Home Above Footer Form', 'Pop Up Form', 'Subscribe To Newsletter'] });
    expect(detail.events).toEqual([]);

    // The business unticks the newsletter tab (new tabs would still be read).
    expect((await env.api('PUT', `/api/lead-sources/${source.id}/sheet`, { mode: 'only', selected: [], existing: 'skip' })).status).toBe(400);
    await env.api('PUT', `/api/lead-sources/${source.id}/sheet`, { mode: 'except', excluded: ['Subscribe To Newsletter'], existing: 'skip' });

    // Run 2: new rows in the chosen tabs are sent once, with their tab; the newsletter tab is left alone.
    s.sheets[0].values.push(row('2026-10-28', 'Anita', '9273100011', '411001'));
    s.sheets[1].values.push(row('2026-10-28', 'Kiran', '9900123456', '560001'));
    s.sheets[2].values.push([{ $date: '2026-10-28T00:00:00.000Z' }, 'new@example.com']);
    s.calls = [];
    save(s);
    s = await run();
    expect(s.calls.map(c => c['text-870'] ?? c._wa_reach)).toEqual(['sync', 'Anita', 'Kiran']);
    expect(s.calls[1]).toMatchObject({ 'Sheet tab': 'Home Above Footer Form', Date: '28 Oct 2026', 'phonetext-330': '9273100011' });
    expect(statusOf(s, 'Home Above Footer Form', 3)).toBe('Sent to WA Reach');
    expect(statusOf(s, 'Pop Up Form', 2)).toBe('Sent to WA Reach');
    expect(statusOf(s, 'Subscribe To Newsletter', 1)).toBe('Not sent: was in the sheet before WA Reach');
    expect(statusOf(s, 'Subscribe To Newsletter', 2) ?? '').toBe('');
    expect(contacts().map(c => [c.name, JSON.parse(c.attributes).sheet_tab])).toEqual([
      ['Anita', 'Home Above Footer Form'],
      ['Kiran', 'Pop Up Form'],
    ]);
    expect(enrolled()).toBe(2);

    const counts = (await env.api('GET', `/api/lead-sources/${source.id}`)).body.source.sheet.leadsByTab;
    expect(counts).toEqual({ 'Home Above Footer Form': 1, 'Pop Up Form': 1 });

    // Run 3: bring in the rows that were already there, quietly (no welcome, no owner ping). Only
    // ticked tabs: new tabs are no longer read automatically.
    await env.api('PUT', `/api/lead-sources/${source.id}/sheet`, { mode: 'only', selected: ['Home Above Footer Form', 'Pop Up Form'], existing: 'import' });
    const outboxBefore = env.core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')!.n;
    s.calls = [];
    save(s);
    s = await run();
    expect(s.calls.map(c => [c['text-870'] ?? c._wa_reach, c._wa_reach])).toEqual([
      ['sync', 'sync'],
      ['Shreyas', 'backfill'],
      ['Ravi Shankar', 'backfill'],
    ]);
    expect(statusOf(s, 'Home Above Footer Form', 2)).toBe('Added to WA Reach (no message sent)');
    expect(contacts().map(c => c.name)).toEqual(['Anita', 'Kiran', 'Shreyas', 'Ravi Shankar']);
    expect(enrolled()).toBe(2);
    expect(env.core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')!.n).toBe(outboxBefore);
    const events = (await env.api('GET', `/api/lead-sources/${source.id}`)).body.events;
    expect(events[0]).toMatchObject({ status: 'added', detail: 'Earlier row from the sheet: added without messages' });
    expect(events.filter((e: { status: string }) => e.status === 'failed')).toEqual([]);

    // Run 4: nothing left to send.
    s.calls = [];
    save(s);
    s = await run();
    expect(s.calls).toHaveLength(1);
  }, 60_000);
});
