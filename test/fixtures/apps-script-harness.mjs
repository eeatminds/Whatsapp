// Runs the Google Apps Script from sheet-script.ts against a fake spreadsheet, with UrlFetchApp
// making real (synchronous) HTTP calls. Usage: node apps-script-harness.mjs <script.js> <state.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [scriptPath, statePath] = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const revive = v => (v && typeof v === 'object' && v.$date ? new Date(v.$date) : v);
const sheets = state.sheets.map(s => ({ ...s, values: s.values.map(r => r.map(revive)) }));

const width = s => Math.max(0, ...s.values.map(r => r.length));
function setCell(s, r, c, v) {
  while (s.values.length < r) s.values.push([]);
  const row = s.values[r - 1];
  while (row.length < c) row.push('');
  row[c - 1] = v;
}
const sheetApi = s => ({
  getName: () => s.name,
  getSheetId: () => s.id,
  getDataRange: () => ({ getValues: () => s.values.map(r => Array.from({ length: width(s) }, (_, i) => r[i] ?? '')) }),
  getRange: (r, c) => ({
    setValue: v => setCell(s, r, c, v),
    setValues: vals => vals.forEach((row, i) => row.forEach((v, j) => setCell(s, r + i, c + j, v))),
  }),
});
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
globalThis.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheets: () => sheets.map(sheetApi), getSpreadsheetTimeZone: () => 'UTC' }) };
globalThis.PropertiesService = { getDocumentProperties: () => ({ getProperty: k => state.props[k] ?? null, setProperty: (k, v) => (state.props[k] = v) }) };
globalThis.Utilities = {
  formatDate: (d, _tz, fmt) => {
    const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    return fmt.includes('HH') ? `${date} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` : date;
  },
};
globalThis.UrlFetchApp = {
  fetch: (url, options) => {
    const fetchOnce = "fetch(process.argv[1], { method: 'POST', headers: { 'content-type': 'application/json' }, body: process.argv[2] }).then(async r => process.stdout.write(JSON.stringify({ code: r.status, text: await r.text() })))";
    const out = JSON.parse(String(execFileSync(process.execPath, ['-e', fetchOnce, url, options.payload])));
    state.calls.push(JSON.parse(options.payload));
    return { getResponseCode: () => out.code, getContentText: () => out.text };
  },
};
state.triggers ??= [];
globalThis.ScriptApp = {
  getProjectTriggers: () => state.triggers.map(t => ({ getHandlerFunction: () => t.handler })),
  newTrigger: handler => {
    const trigger = { handler };
    const builder = {
      timeBased: () => builder,
      everyMinutes: n => ((trigger.everyMinutes = n), builder),
      create: () => state.triggers.push(trigger),
    };
    return builder;
  },
};
process.env.TZ = 'UTC';
// The entry point is what the business runs: "setup" once by hand, then "sendNewLeads" every minute.
const entry = state.entry === 'setup' ? 'setup' : 'sendNewLeads';
new Function(`${readFileSync(scriptPath, 'utf8')}\n${entry}();`)();
state.sheets = sheets.map(s => ({ ...s, values: s.values.map(r => r.map(v => (v instanceof Date ? { $date: v.toISOString() } : v))) }));
writeFileSync(statePath, JSON.stringify(state));
