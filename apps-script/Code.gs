/**
 * Rubber Ledger – Google Apps Script backend.
 *
 * Paste this file into Extensions → Apps Script of your "Rubber Business Ledger" Google Sheet.
 * Then run Rubber Ledger → "Set up / repair sheet" from the sheet menu (or run `setup` here once),
 * and deploy as a Web App: Execute as = Me, Who has access = Anyone.
 *
 * Sign-in: the app signs in with Google. Paste your OAuth Client ID below (README → "Google sign-in").
 * Only the Google accounts in Rubber Ledger → "Allowed Google accounts" can use the sheet
 * (by default, the account that owns this script). An access key is kept as a backup.
 */

// Paste the OAuth Client ID from Google Cloud Console here (ends with .apps.googleusercontent.com)
const GOOGLE_CLIENT_ID = 'PASTE-YOUR-CLIENT-ID.apps.googleusercontent.com';
const SESSION_DAYS = 180;   // how long a phone stays signed in
const BOOK_NAME = 'FamilyBusiness';   // the Google Sheet in your Drive: used if it exists, created if not

const TX = 'Transactions', WK = 'Workers', CAT = 'Categories', SUM = 'Summary', SET = 'Settings';

const TX_HEADERS = ['ID', 'Date', 'Month', 'Financial year', 'Type', 'Category', 'Quantity', 'Unit', 'DRC %',
  'Dry rubber kg', 'Rate (₹/unit)', 'Amount (₹)', 'Party / Worker', 'Payment mode', 'Notes', 'Voice text', 'Created at', 'Status', 'Item'];   // new columns go at the end
const TX_KEYS = ['id', 'date', 'month', 'fy', 'type', 'category', 'quantity', 'unit', 'drc',
  'dryKg', 'rate', 'amount', 'party', 'paymentMode', 'notes', 'voiceText', 'createdAt', 'status', 'item'];
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
    .addItem('Allowed Google accounts…', 'setAllowedEmails')
    .addItem('Sign out all phones', 'signOutAll')
    .addItem('Show access key', 'showKey')
    .addItem('Create a new access key', 'resetKey')
    .addToUi();
}

function setup() {
  const props = PropertiesService.getScriptProperties();
  const ss = ss_();   // finds or creates the FamilyBusiness sheet and prepares its tabs

  if (!props.getProperty('ALLOWED_EMAILS')) props.setProperty('ALLOWED_EMAILS', ownerEmail_());
  const key = getKey_();
  const msg = 'Rubber Ledger is set up.\n\nSheet: ' + ss.getName() + '\n' + ss.getUrl() + '\n\nGoogle accounts allowed to sign in: ' + allowedEmails_().join(', ') +
    (clientIdOk_() ? '' : '\n\nGoogle sign-in is not ready yet: paste your OAuth Client ID into GOOGLE_CLIENT_ID at the top of Code.gs.') +
    '\n\nBackup access key (only needed if you do not use Google sign-in):\n' + key +
    '\n\nNext: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone) and copy the Web App URL.';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

// Make sure the sheet has every tab and header the app needs. Safe to run on an existing sheet: rows are kept.
function prepareBook_(ss) {
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
  const first = ss.getSheets()[0];   // a newly created sheet starts with an empty "Sheet1": drop it
  if (ss.getSheets().length > 1 && first.getName() === 'Sheet1' && first.getLastRow() === 0) ss.deleteSheet(first);
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

function setAllowedEmails() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Allowed Google accounts',
    'Email addresses that may sign in to the app, separated by commas.\nCurrent: ' + allowedEmails_().join(', '),
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const list = res.getResponseText().split(',').map(x => x.trim().toLowerCase()).filter(x => /@/.test(x));
  if (!list.length) { ui.alert('No valid email address entered; nothing changed.'); return; }
  PropertiesService.getScriptProperties().setProperty('ALLOWED_EMAILS', list.join(','));
  ui.alert('Allowed Google accounts: ' + list.join(', '));
}

function signOutAll() {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).filter(k => k.indexOf('S_') === 0).forEach(k => props.deleteProperty(k));
  const msg = 'All phones are signed out. Sign in again from the app Settings.';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

function ownerEmail_() {
  try { return (Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) { return ''; }
}

function allowedEmails_() {
  const v = PropertiesService.getScriptProperties().getProperty('ALLOWED_EMAILS') || ownerEmail_();
  return v.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

function clientIdOk_() {
  return /\.apps\.googleusercontent\.com$/.test(GOOGLE_CLIENT_ID) && GOOGLE_CLIENT_ID.indexOf('PASTE-') !== 0;
}

// Verify a Google ID token and, if the account is allowed, open a long-lived session for this phone.
function login_(idToken) {
  if (!clientIdOk_()) return { ok: false, error: 'google-not-configured' };
  if (!idToken) return { ok: false, error: 'invalid-token' };
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { ok: false, error: 'invalid-token' };
  const p = JSON.parse(res.getContentText());
  const issOk = p.iss === 'accounts.google.com' || p.iss === 'https://accounts.google.com';
  const verified = p.email_verified === true || p.email_verified === 'true';
  if (p.aud !== GOOGLE_CLIENT_ID || !issOk || !verified || Number(p.exp) * 1000 < Date.now()) return { ok: false, error: 'invalid-token' };
  const email = String(p.email || '').toLowerCase();
  if (allowedEmails_().indexOf(email) < 0) return { ok: false, error: 'not-allowed', email: email };
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const all = props.getProperties();
  Object.keys(all).filter(k => k.indexOf('S_') === 0).forEach(k => {   // tidy expired sessions
    try { if (JSON.parse(all[k]).exp < now) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
  const session = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  props.setProperty('S_' + session, JSON.stringify({ email: email, exp: now + SESSION_DAYS * 864e5 }));
  return { ok: true, session: session, email: email, name: p.name || '' };
}

// Who is calling? A signed-in session, or the backup access key.
function auth_(req) {
  const props = PropertiesService.getScriptProperties();
  if (req.session) {
    const raw = props.getProperty('S_' + req.session);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s.exp < Date.now() || allowedEmails_().indexOf(s.email) < 0) { props.deleteProperty('S_' + req.session); return null; }
    return { email: s.email };
  }
  const key = props.getProperty('ACCESS_KEY');
  if (key && req.key === key) return { email: '' };
  return null;
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
  if (!req) return out_({ ok: false, error: 'bad-request' });
  try {
    if (req.action === 'config') return out_({ ok: true, app: 'rubber-ledger', clientId: clientIdOk_() ? GOOGLE_CLIENT_ID : '' });
    if (req.action === 'login') return out_(login_(req.idToken));
    const who = auth_(req);
    if (!who) return out_({ ok: false, error: 'unauthorized' });
    switch (req.action) {
      case 'ping': { const s = ss_(); return out_({ ok: true, sheetUrl: s.getUrl(), sheetName: s.getName(), email: who.email }); }
      case 'logout': { if (req.session) PropertiesService.getScriptProperties().deleteProperty('S_' + req.session); return out_({ ok: true }); }
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

// The FamilyBusiness sheet in the owner's Drive. If it exists it is used (new entries are appended);
// if not, it is created with all tabs. Its ID is remembered; renaming or binning it makes the app look again.
function ss_() {
  const props = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  const id = props.getProperty('SPREADSHEET_ID');
  if (id && cache.get('BOOK_OK') === id) return SpreadsheetApp.openById(id);
  if (id) {
    try {
      const f = DriveApp.getFileById(id);
      if (!f.isTrashed() && f.getName() === BOOK_NAME) { cache.put('BOOK_OK', id, 600); return SpreadsheetApp.openById(id); }
    } catch (e) { /* deleted or no access: look again */ }
  }
  let ss = null;
  const files = DriveApp.getFilesByName(BOOK_NAME);
  while (files.hasNext()) {
    const f = files.next();
    if (!f.isTrashed() && f.getMimeType() === MimeType.GOOGLE_SHEETS) { ss = SpreadsheetApp.openById(f.getId()); break; }
  }
  if (!ss) ss = SpreadsheetApp.create(BOOK_NAME);
  prepareBook_(ss);
  props.setProperty('SPREADSHEET_ID', ss.getId());
  cache.put('BOOK_OK', ss.getId(), 600);
  return ss;
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
