/**
 * Rubber Ledger – Google Apps Script backend.
 *
 * Paste this file into Extensions → Apps Script of your "Rubber Business Ledger" Google Sheet.
 * Then run Rubber Ledger → "Set up / repair sheet" from the sheet menu (or run `setup` here once),
 * and deploy as a Web App: Execute as = Me, Who has access = Anyone.
 * Every request must carry the access key shown by Rubber Ledger → "Show access key".
 */

const TX = 'Transactions', WK = 'Workers', CAT = 'Categories', SUM = 'Summary', SET = 'Settings';

const TX_HEADERS = ['ID', 'Date', 'Month', 'Financial year', 'Type', 'Category', 'Quantity', 'Unit', 'DRC %',
  'Dry rubber kg', 'Rate (₹/unit)', 'Amount (₹)', 'Party / Worker', 'Payment mode', 'Notes', 'Voice text', 'Created at', 'Status'];
const TX_KEYS = ['id', 'date', 'month', 'fy', 'type', 'category', 'quantity', 'unit', 'drc',
  'dryKg', 'rate', 'amount', 'party', 'paymentMode', 'notes', 'voiceText', 'createdAt', 'status'];
const NUMERIC = ['quantity', 'drc', 'dryKg', 'rate', 'amount'];

const WK_HEADERS = ['Worker ID', 'Name', 'Role', 'Wage basis', 'Default rate (₹)', 'Active'];
const WK_KEYS = ['id', 'name', 'role', 'basis', 'rate', 'active'];

const DEFAULT_CATEGORIES = {
  Production: ['Latex', 'Sheet rubber', 'Scrap / ottupal', 'Cup lump'],
  Income: ['Latex sale', 'Sheet sale', 'Scrap sale', 'Subsidy', 'Other income'],
  Expense: ['Tapping wages', 'Weeding/labour', 'Fertilizer', 'Acid & chemicals', 'Rain guarding', 'Plastic/cups',
    'Smoke house fuel', 'Transport', 'Equipment & repairs', 'Land tax', 'Loan interest', 'Miscellaneous']
};

// ---------------------------------------------------------------- menu & setup
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Rubber Ledger')
    .addItem('Set up / repair sheet', 'setup')
    .addItem('Show access key', 'showKey')
    .addItem('Create a new access key', 'resetKey')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());

  const tx = ensureSheet_(ss, TX, TX_HEADERS);
  tx.getRange('A:D').setNumberFormat('@');       // ID, dates, month and FY stay as plain text
  tx.getRange('Q:Q').setNumberFormat('@');
  tx.getRange('G:L').setNumberFormat('#,##0.##');
  tx.setFrozenRows(1);

  const wk = ensureSheet_(ss, WK, WK_HEADERS);
  wk.getRange('A:A').setNumberFormat('@');
  wk.setFrozenRows(1);

  const cat = ensureSheet_(ss, CAT, ['Type', 'Category']);
  if (cat.getLastRow() < 2) {
    const rows = [];
    Object.keys(DEFAULT_CATEGORIES).forEach(t => DEFAULT_CATEGORIES[t].forEach(c => rows.push([t, c])));
    cat.getRange(2, 1, rows.length, 2).setValues(rows);
  }

  const set = ensureSheet_(ss, SET, ['Setting', 'Value']);
  if (set.getLastRow() < 2) {
    set.getRange(2, 1, 4, 2).setValues([
      ['Latex unit', 'kg (wet weight); dry kg = wet kg × DRC %'],
      ['Latex density (kg per litre, only if litres are used)', 1.0],
      ['Financial year starts', 'April'],
      ['Note', 'App settings are kept on the phone (Settings screen). This tab is for reference.']
    ]);
  }

  buildSummary_(ss);
  const key = getKey_();
  const msg = 'Rubber Ledger is set up.\n\nAccess key (paste into the app Settings):\n' + key +
    '\n\nNext: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone) and copy the Web App URL.';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

function showKey() {
  const msg = 'Access key:\n' + getKey_();
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

function resetKey() {
  PropertiesService.getScriptProperties().deleteProperty('ACCESS_KEY');
  const msg = 'New access key (update it in the app Settings):\n' + getKey_();
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

function getKey_() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('ACCESS_KEY');
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 40);
    props.setProperty('ACCESS_KEY', key);
  }
  return key;
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const current = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  if (current.join('|') !== headers.join('|')) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  }
  return sh;
}

function buildSummary_(ss) {
  const sh = ensureSheet_(ss, SUM, ['Monthly income and expense (₹)']);
  sh.clear();
  sh.getRange('A1').setValue('Monthly income and expense (₹)').setFontWeight('bold');
  sh.getRange('A2').setFormula("=IFERROR(QUERY(Transactions!A1:R,\"select C, sum(L) where R = 'Active' and E <> 'Production' and C is not null group by C pivot E order by C desc label C 'Month'\",1),\"No data yet\")");
  sh.getRange('F1').setValue('Financial year income and expense (₹)').setFontWeight('bold');
  sh.getRange('F2').setFormula("=IFERROR(QUERY(Transactions!A1:R,\"select D, sum(L) where R = 'Active' and E <> 'Production' and D is not null group by D pivot E order by D desc label D 'Financial year'\",1),\"No data yet\")");
  sh.getRange('K1').setValue('Dry rubber produced (kg)').setFontWeight('bold');
  sh.getRange('K2').setFormula("=IFERROR(QUERY(Transactions!A1:R,\"select C, sum(J) where R = 'Active' and E = 'Production' and C is not null group by C order by C desc label C 'Month', sum(J) 'Dry kg'\",1),\"No data yet\")");
  sh.getRange('N1').setValue('Wages per worker by financial year (₹)').setFontWeight('bold');
  sh.getRange('N2').setFormula("=IFERROR(QUERY(Transactions!A1:R,\"select M, sum(L) where R = 'Active' and (F = 'Tapping wages' or F = 'Weeding/labour') group by M pivot D label M 'Worker'\",1),\"No data yet\")");
}

// ---------------------------------------------------------------- web app
function doGet() {
  return out_({ ok: true, app: 'rubber-ledger', message: 'Rubber Ledger backend is running. The app talks to it with POST requests.' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad-request' }); }
  const key = PropertiesService.getScriptProperties().getProperty('ACCESS_KEY');
  if (!key || !req || req.key !== key) return out_({ ok: false, error: 'unauthorized' });
  try {
    switch (req.action) {
      case 'ping': { const s = ss_(); return out_({ ok: true, sheetUrl: s.getUrl(), sheetName: s.getName() }); }
      case 'list': return out_(Object.assign({ ok: true }, listAll_()));
      case 'sync': return out_(Object.assign({ ok: true }, sync_(req.ops || [])));
      default: return out_({ ok: false, error: 'unknown-action' });
    }
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function cellOut_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return v;
}

function readTable_(sh, keys, tz) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, keys.length).getValues();
  return values.filter(r => r[0] !== '').map(r => {
    const o = {};
    keys.forEach((k, i) => { o[k] = cellOut_(r[i], tz); });
    return o;
  });
}

function listAll_() {
  const s = ss_();
  const tz = s.getSpreadsheetTimeZone();
  const entries = readTable_(s.getSheetByName(TX), TX_KEYS, tz).map(o => {
    o.id = String(o.id); o.date = String(o.date);
    NUMERIC.forEach(k => { o[k] = o[k] === '' ? null : Number(o[k]); });
    return o;
  });
  const workers = readTable_(s.getSheetByName(WK), WK_KEYS, tz).map(w => {
    w.id = String(w.id); w.rate = Number(w.rate) || 0; w.active = w.active === 'No' ? 'No' : 'Yes';
    return w;
  });
  const categories = {};
  readTable_(s.getSheetByName(CAT), ['type', 'category'], tz).forEach(c => {
    (categories[c.type] = categories[c.type] || []).push(c.category);
  });
  return { entries: entries, workers: workers, categories: categories, sheetUrl: s.getUrl() };
}

function financialYear_(date) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return 'FY ' + start + '-' + ('0' + ((start + 1) % 100)).slice(-2);
}

function toRow_(e) {
  const date = String(e.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad date for ' + e.id);
  if (['Production', 'Income', 'Expense'].indexOf(e.type) < 0) throw new Error('bad type for ' + e.id);
  const o = Object.assign({}, e, { date: date, month: date.slice(0, 7), fy: financialYear_(date), status: e.status === 'Deleted' ? 'Deleted' : 'Active' });
  return TX_KEYS.map(k => {
    let v = o[k];
    if (NUMERIC.indexOf(k) >= 0) return (v === null || v === undefined || v === '' || isNaN(Number(v))) ? '' : Number(v);
    v = v === null || v === undefined ? '' : String(v);
    return v.charAt(0) === '=' ? "'" + v : v;   // never let text become a formula
  });
}

function sync_(ops) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const s = ss_();
    const tx = s.getSheetByName(TX);
    const wk = s.getSheetByName(WK);
    const ids = indexIds_(tx);
    let applied = 0;
    ops.forEach(op => {
      if (op.op === 'add' || op.op === 'update') {
        const row = toRow_(op.entry);
        const r = ids[op.entry.id];
        if (r) tx.getRange(r, 1, 1, row.length).setValues([row]);
        else { const at = tx.getLastRow() + 1; tx.getRange(at, 1, 1, row.length).setValues([row]); ids[op.entry.id] = at; }
        applied++;
      } else if (op.op === 'delete' || op.op === 'restore') {
        const r = ids[op.id];
        if (r) { tx.getRange(r, TX_KEYS.indexOf('status') + 1).setValue(op.op === 'delete' ? 'Deleted' : 'Active'); applied++; }
      } else if (op.op === 'worker' && op.worker && op.worker.id) {
        const w = op.worker;
        const row = [String(w.id), String(w.name || ''), String(w.role || ''), String(w.basis || ''), Number(w.rate) || 0, w.active === 'No' ? 'No' : 'Yes'];
        const wids = indexIds_(wk);
        const r = wids[w.id];
        if (r) wk.getRange(r, 1, 1, row.length).setValues([row]);
        else wk.getRange(wk.getLastRow() + 1, 1, 1, row.length).setValues([row]);
        applied++;
      }
    });
    return { applied: applied };
  } finally {
    lock.releaseLock();
  }
}

function indexIds_(sh) {
  const map = {};
  const last = sh.getLastRow();
  if (last < 2) return map;
  sh.getRange(2, 1, last - 1, 1).getValues().forEach((r, i) => { if (r[0] !== '') map[String(r[0])] = i + 2; });
  return map;
}
