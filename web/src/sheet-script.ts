/**
 * The Google Apps Script a business pastes into its sheet (Extensions → Apps Script), run every
 * minute by a time trigger. Each run it asks WA Reach which tabs to read (and reports the tabs it
 * has), then sends each new row of those tabs once and writes the result in a "WA Status" column.
 *
 * The first time a tab is read, rows already in it are marked "Not sent" instead of messaging every
 * old lead at once. If the business chooses to bring those in, they are sent as quiet imports
 * (added as contacts, no welcome message).
 *
 * Rows that failed only because the link or the server had a problem are tried again. Rows an older
 * script marked that way before this one first read the tab count as "already there", so pasting this
 * over an old script with a broken link never messages a whole sheet of old leads.
 */
export function sheetScript(url: string): string {
  return `// WA Reach: sends new rows from this Google Sheet to your WhatsApp automation.
// After pasting: click Save, then Run (with "setup" chosen next to it) and allow access.
// Then choose which tabs are read in WA Reach (your lead source → Sheet tabs); this code stays the same.
// Row 1 of each tab must be the column names, with a phone number column.
const WA_REACH_LINK = '${url}';
const STATUS_COLUMN = 'WA Status';
const NOT_SENT = 'Not sent: was in the sheet before WA Reach';
const MAX_PER_RUN = 100;
// Statuses that mean "WA Reach never got this row" (link or server trouble), from any version of this script.
const TRY_AGAIN = /^(Will retry|Error \\d{3}$|Error: (Unknown lead link|This lead link is switched off|Too many leads))/;

// Run once: checks the sheet every minute from now on, and shows your tabs in WA Reach right away.
// If the link is wrong it stops with a message saying what to do.
function setup() {
  run_(true);
  const running = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'sendNewLeads');
  if (!running) ScriptApp.newTrigger('sendNewLeads').timeBased().everyMinutes(1).create();
}

function sendNewLeads() {
  run_(false);
}

function run_(byHand) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = book.getSheets();
  const sync = callWaReach_({ _wa_reach: 'sync', tabs: sheets.map(s => s.getName()) });
  if (!checkLink_(sync, byHand)) return;
  const config = JSON.parse(sync.text);
  const props = PropertiesService.getDocumentProperties();
  let budget = MAX_PER_RUN;
  for (const sheet of sheets) {
    if (budget > 0 && config.tabs.indexOf(sheet.getName()) >= 0) budget = sendTab_(book, sheet, config, props, budget);
  }
}

function sendTab_(book, sheet, config, props, budget) {
  const rows = sheet.getDataRange().getValues();
  const head = (rows[0] || []).map(h => String(h).trim());
  if (!head.some(h => h)) return budget;
  let statusCol = head.indexOf(STATUS_COLUMN);
  if (statusCol < 0) {
    statusCol = head.length;
    sheet.getRange(1, statusCol + 1).setValue(STATUS_COLUMN);
  }
  const hasData = row => row.some((v, c) => c !== statusCol && v !== '' && v !== null);

  // The first time this tab is read, rows already in it are not new leads: mark them, don't send.
  const seenKey = 'wa-reach-seen-' + sheet.getSheetId();
  if (!props.getProperty(seenKey)) {
    const marks = [];
    for (let i = 1; i < rows.length; i++) {
      const old = String(rows[i][statusCol] || '');
      const mark = old && !TRY_AGAIN.test(old) ? rows[i][statusCol] : hasData(rows[i]) ? NOT_SENT : '';
      rows[i][statusCol] = mark;
      marks.push([mark]);
    }
    if (marks.length) sheet.getRange(2, statusCol + 1, marks.length, 1).setValues(marks);
    props.setProperty(seenKey, new Date().toISOString());
  }

  const zone = book.getSpreadsheetTimeZone();
  for (let i = 1; i < rows.length && budget > 0; i++) {
    const row = rows[i];
    const status = String(row[statusCol] || '');
    const earlier = status === NOT_SENT;
    if (!hasData(row) || (status && !(earlier && config.existing === 'import') && !TRY_AGAIN.test(status))) continue;
    const lead = { 'Sheet tab': sheet.getName() };
    head.forEach((h, c) => {
      const v = row[c];
      if (!h || c === statusCol || v === '' || v === null) return;
      lead[h] = v instanceof Date ? Utilities.formatDate(v, zone, v.getHours() || v.getMinutes() ? 'd MMM yyyy HH:mm' : 'd MMM yyyy') : String(v);
    });
    if (earlier) lead._wa_reach = 'backfill';
    const res = callWaReach_(lead);
    budget--;
    // Too many at once, or the link stopped working: leave the rest for the next minute.
    if (res.code === 429 || res.code === 403 || res.code === 404) return 0;
    let text = earlier ? 'Added to WA Reach (no message sent)' : 'Sent to WA Reach';
    if (res.ok) {
      try { if (JSON.parse(res.text).duplicate) text = 'Duplicate (number already a lead)'; } catch (e) {}
    } else if (res.code >= 500) {
      text = 'Will retry: WA Reach did not answer (' + res.code + ')';
    } else {
      try { text = 'Error: ' + JSON.parse(res.text).error; } catch (e) { text = 'Error: WA Reach answered ' + res.code; }
    }
    sheet.getRange(i + 1, statusCol + 1).setValue(text);
  }
  return budget;
}

// A link WA Reach doesn't know stops here with a clear message (Google also emails the owner when a
// timed run fails). A switched-off link or a server hiccup just waits for the next minute.
function checkLink_(res, byHand) {
  if (res.ok) return true;
  let error = '';
  try { error = JSON.parse(res.text).error || ''; } catch (e) {}
  if (res.code === 404 && /Unknown lead link/.test(error)) {
    throw new Error('WA Reach does not recognise the link in this script (it was reset, or the lead source was deleted). ' +
      'In WA Reach open Lead sources, choose this sheet, click "Copy script", paste it here over everything, Save, and run setup again.');
  }
  if (byHand) throw new Error('WA Reach could not be reached (' + res.code + (error ? ': ' + error : '') + '). Try Run again in a minute.');
  return false;
}

function callWaReach_(body) {
  const res = UrlFetchApp.fetch(WA_REACH_LINK, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  return { ok: code < 300, code: code, text: res.getContentText() };
}
`;
}
