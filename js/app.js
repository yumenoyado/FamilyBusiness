/* Rubber Ledger – app logic */
(function () {
  'use strict';
  const P = window.RubberParser;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = n => (n == null || isNaN(n)) ? '—' : '₹' + Math.round(n).toLocaleString('en-IN');
  const num = (n, d = 1) => (n == null || isNaN(n)) ? '—' : (+n).toLocaleString('en-IN', { maximumFractionDigits: d });
  const today = () => P.isoDate(new Date());
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${+d} ${MONTH_NAMES[+m - 1]} ${y}`; };
  const fmtMonth = ym => { const [y, m] = ym.split('-'); return `${MONTH_NAMES[+m - 1]} ${y}`; };

  // ---------------- state ----------------
  const S = {
    settings: { url: '', key: '', session: '', email: '', density: 1, autosave: 3, readback: false },
    entries: [],     // all entries (incl. Deleted status)
    workers: [],
    queue: [],       // pending ops for the sheet
    sheetUrl: '',
    session: [],     // ids saved in this session (newest first)
    pending: null,   // entry on the confirmation card
    syncing: false,
    lastSyncError: ''
  };
  const persist = () => Promise.all([
    KV.set('entries', S.entries), KV.set('workers', S.workers), KV.set('queue', S.queue),
    KV.set('settings', S.settings), KV.set('sheetUrl', S.sheetUrl)
  ]);
  const active = () => S.entries.filter(e => e.status !== 'Deleted');
  const ctx = () => ({ density: +S.settings.density || 1, workers: S.workers, today: new Date() });
  const pendingIds = () => new Set(S.queue.map(o => (o.entry && o.entry.id) || o.id).filter(Boolean));
  const configured = () => !!(S.settings.url && (S.settings.session || S.settings.key));

  // ---------------- backend ----------------
  // POST to the Apps Script web app. `auth` = { session } or { key }.
  async function post(url, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch(url, {
        method: 'POST', redirect: 'follow', signal: ctl.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body)
      });
      return await res.json();
    } finally { clearTimeout(timer); }
  }
  const authBody = () => S.settings.session ? { session: S.settings.session } : { key: S.settings.key };
  async function call(action, extra) {
    if (!configured()) throw new Error('not-configured');
    const data = await post(S.settings.url, Object.assign({ action }, authBody(), extra || {}));
    if (!data.ok) {
      if (data.error === 'unauthorized' && S.settings.session) {   // session expired or revoked
        S.settings.session = ''; S.settings.email = ''; KV.set('settings', S.settings);
        if (currentView === 'settings') renderAuth();
      }
      throw new Error(data.error || 'server-error');
    }
    return data;
  }

  async function flush() {
    if (!S.queue.length) return true;
    if (!navigator.onLine || !configured()) return false;
    const ops = S.queue.slice(0, 50);
    await call('sync', { ops });
    S.queue = S.queue.slice(ops.length);
    await KV.set('queue', S.queue);
    return S.queue.length ? flush() : true;
  }

  async function sync(pull) {
    if (S.syncing) return;
    if (!configured()) { renderSyncBadge(); return; }
    S.syncing = true; renderSyncBadge();
    try {
      await flush();
      if (pull) {
        const data = await call('list');
        const keep = pendingIds();
        const local = new Map(S.entries.filter(e => keep.has(e.id)).map(e => [e.id, e]));
        S.entries = data.entries.map(e => local.get(e.id) || cleanEntry(e));
        local.forEach((e, id) => { if (!S.entries.find(x => x.id === id)) S.entries.push(e); });
        if (!S.queue.some(o => o.op === 'worker')) S.workers = data.workers || [];
        S.sheetUrl = data.sheetUrl || S.sheetUrl;
        await persist();
      }
      S.lastSyncError = '';
    } catch (err) {
      S.lastSyncError = err.message === 'not-configured' ? '' : (err.name === 'AbortError' ? 'timeout' : err.message);
    } finally {
      S.syncing = false; renderSyncBadge(); refreshViews();
      // entries saved while this sync was running go out now
      if (S.queue.length && !S.lastSyncError && navigator.onLine) setTimeout(() => sync(false), 300);
    }
  }

  function cleanEntry(e) {
    const n = v => (v === '' || v == null || isNaN(+v)) ? null : +v;
    return {
      id: String(e.id), date: String(e.date || ''), month: e.month || String(e.date || '').slice(0, 7), fy: e.fy || P.financialYear(e.date),
      type: e.type || '', category: e.category || '', quantity: n(e.quantity), unit: e.unit || '', drc: n(e.drc), dryKg: n(e.dryKg),
      rate: n(e.rate), amount: n(e.amount), party: e.party || '', paymentMode: e.paymentMode || '', notes: e.notes || '',
      voiceText: e.voiceText || '', createdAt: e.createdAt || '', status: e.status || 'Active'
    };
  }

  function queueOp(op) { S.queue.push(op); persist(); renderSyncBadge(); sync(false); }

  // ---------------- entry operations ----------------
  function saveNew(e) {
    const entry = cleanEntry(Object.assign({}, e, { id: e.id || uuid(), createdAt: new Date().toISOString(), status: 'Active' }));
    S.entries.push(entry);
    queueOp({ op: 'add', entry });
    return entry;
  }
  function updateEntry(e) {
    const entry = cleanEntry(e);
    const i = S.entries.findIndex(x => x.id === entry.id);
    if (i >= 0) S.entries[i] = entry; else S.entries.push(entry);
    queueOp({ op: 'update', entry });
    return entry;
  }
  function setStatus(ids, status) {
    ids.forEach(id => {
      const e = S.entries.find(x => x.id === id);
      if (e) { e.status = status; queueOp({ op: status === 'Deleted' ? 'delete' : 'restore', id }); }
    });
    refreshViews();
  }
  function deleteWithUndo(ids, label) {
    if (!ids.length) { toast('Nothing to delete'); return; }
    setStatus(ids, 'Deleted');
    S.session = S.session.filter(id => !ids.includes(id));
    renderSession();
    toast(label || `Deleted ${ids.length} entr${ids.length > 1 ? 'ies' : 'y'}`, () => { setStatus(ids, 'Active'); ids.forEach(id => S.session.unshift(id)); renderSession(); });
  }
  function lastSavedIds(n) {
    const ids = S.session.filter(id => { const e = S.entries.find(x => x.id === id); return e && e.status !== 'Deleted'; });
    if (ids.length >= n) return ids.slice(0, n);
    const more = active().filter(e => !ids.includes(e.id)).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return ids.concat(more.slice(0, n - ids.length).map(e => e.id));
  }

  // ---------------- toast ----------------
  let toastTimer = null;
  function toast(msg, undo) {
    const t = $('#toast');
    $('#toastMsg').textContent = msg;
    const btn = $('#toastAction');
    btn.hidden = !undo;
    btn.onclick = () => { t.hidden = true; clearTimeout(toastTimer); undo && undo(); };
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, undo ? 10000 : 3000);
  }

  // ---------------- voice ----------------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  const UA = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const otherIOSBrowser = iOS && /CriOS|FxiOS|EdgiOS|OPiOS/.test(UA);
  let lastVoiceError = '';
  let rec = null, listening = false, lastInputWasVoice = false, watchdog = null;

  // Plain-language reason + fix when the in-app mic cannot work here.
  function voiceProblem(err) {
    if (otherIOSBrowser) return 'On iPhone the app\'s mic only works in Safari. Open this page in Safari.';
    if (standalone && iOS && (!err || err === 'not-allowed' || err === 'service-not-allowed' || err === 'timeout')) return 'iPhone blocks the app\'s mic when it is opened as a Home Screen web app. Open the page in Safari instead (see Settings).';
    if (!SR) return 'This browser has no speech recognition. On iPhone, open the page in Safari.';
    if (!err) return '';
    if (err === 'not-allowed') return 'Microphone access is blocked. Allow it: iPhone Settings → Apps → Safari → Microphone → Allow, then tap the mic again.';
    if (err === 'service-not-allowed') return 'Speech recognition is turned off. Turn on Settings → General → Keyboard → Enable Dictation (and Siri), then tap the mic again.';
    if (err === 'network') return 'Speech recognition needs an internet connection. Try again when you have signal.';
    if (err === 'audio-capture') return 'No microphone was found, or another app is using it.';
    if (err === 'timeout') return 'The microphone did not start. Close other apps using the mic and tap again.';
    return 'Voice error: ' + err + '. Tap the mic to try again.';
  }

  function setMic(on, status) {
    listening = on;
    $('#micBtn').classList.toggle('listening', on);
    $('#dictForm').classList.toggle('recording', on);
    $('#micStatus').textContent = status || (on ? 'Listening… speak, then tap Go' :
      ($('#dictInput').value.trim() ? 'Tap Go to use this text, or the mic to keep talking' :
        (S.pending ? 'Tap Save or Delete, or tap the mic and say "save" / "delete" then Go' : 'Tap the mic and speak, then tap Go')));
  }

  // Voice recording runs until Go is pressed. The browser may end a listening session on its own
  // (after a pause, or on iPhone after ~60 s); we quietly start a new one and keep the text.
  let recording = false, baseText = '', emptyRestarts = 0;
  const joinText = (a, b) => [a, b].map(x => (x || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');

  function startListening() {
    if (!SR || otherIOSBrowser) { lastVoiceError = 'unsupported'; setMic(false, voiceProblem('')); renderVoiceSupport(); return; }
    stopListening();
    if (S.pending) pauseCountdown();
    recording = true; emptyRestarts = 0; lastVoiceError = '';
    baseText = $('#dictInput').value.replace(/\s+/g, ' ').trim();
    beginSession(true);
  }

  function beginSession(first) {
    let sessionText = '', heard = false, started = false;
    try {
      rec = new SR();
      rec.lang = 'en-IN'; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
      const thisRec = rec;
      const markStarted = () => { if (!started) { started = true; clearTimeout(watchdog); } };
      rec.onstart = markStarted;
      rec.onaudiostart = markStarted;
      if (first) {   // iOS can hang silently: if the mic never starts, stop and say so
        clearTimeout(watchdog);
        watchdog = setTimeout(() => { if (!started && rec === thisRec) { try { thisRec.abort(); } catch (e) { /* ignore */ } rec = null; recording = false; lastVoiceError = 'timeout'; setMic(false, voiceProblem('timeout')); renderVoiceSupport(); } }, 6000);
      }
      rec.onresult = ev => {
        markStarted(); heard = true; emptyRestarts = 0;
        // each finished phrase (a pause) is followed by a space so words never run together
        const parts = [];
        let lastFinal = true;
        for (let i = 0; i < ev.results.length; i++) { parts.push(ev.results[i][0].transcript.trim()); lastFinal = ev.results[i].isFinal; }
        sessionText = parts.filter(Boolean).join(' ');
        const shown = joinText(baseText, sessionText);
        $('#dictInput').value = shown + (lastFinal && shown ? ' ' : '');
        if (S.pending) pauseCountdown();
      };
      rec.onerror = ev => {
        markStarted();
        if (ev.error === 'aborted' || ev.error === 'no-speech') return;   // a pause: the session restarts in onend
        lastVoiceError = ev.error;
        recording = false;
        setMic(false, voiceProblem(ev.error));
        renderVoiceSupport();
      };
      rec.onend = () => {
        markStarted();
        if (rec === thisRec) rec = null;
        if (!recording) return;   // stopped by Go or the mic button: leave the box as it is
        baseText = joinText(baseText, sessionText);
        $('#dictInput').value = baseText ? baseText + ' ' : '';   // pause = space before the next words
        emptyRestarts = heard ? 0 : emptyRestarts + 1;
        if (emptyRestarts > 8) { recording = false; setMic(false, baseText ? 'Paused. Tap Go to use this text, or the mic to keep talking' : 'Didn\'t hear anything. Tap the mic to try again'); return; }
        setTimeout(() => { if (recording && !rec) beginSession(false); }, 150);
      };
      rec.start();
      if (first) setMic(true);
    } catch (err) {
      clearTimeout(watchdog);
      rec = null; recording = false;
      setMic(false, first ? voiceProblem(err && err.name === 'NotAllowedError' ? 'not-allowed' : 'start-failed') : 'Paused. Tap Go to use this text, or the mic to keep talking');
    }
  }
  function stopListening() { recording = false; clearTimeout(watchdog); if (rec) { const r = rec; rec = null; try { r.abort(); } catch (e) { /* ignore */ } } if (listening) setMic(false); }
  function speak(text) {
    if (!S.settings.readback || !window.speechSynthesis) return;
    try { const u = new SpeechSynthesisUtterance(text); u.lang = 'en-IN'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) { /* ignore */ }
  }

  function handleUtterance(text) {
    $('#transcript').textContent = text;
    const c = P.parseCommand(text);
    if (S.pending) {
      if (!c) { showCard(P.parse(text, ctx())); return; }
      switch (c.cmd) {
        case 'save': commitPending(); return;
        case 'delete': case 'undo': discardPending(); return;
        case 'deleteField': stopCountdown(); P.applyField(S.pending, c.field, '', ctx()); renderCard(); listenForCommand(); return;
        case 'set': stopCountdown(); P.applyField(S.pending, c.field, c.value, ctx()); renderCard(); listenForCommand(); return;
        case 'deleteLast': discardPending(); deleteWithUndo(lastSavedIds(c.n)); return;
        case 'stop': stopListening(); resumeCountdown(); return;
      }
      return;
    }
    if (!c) { showCard(P.parse(text, ctx())); return; }
    switch (c.cmd) {
      case 'delete': deleteWithUndo(lastSavedIds(1), 'Deleted the last entry'); break;
      case 'deleteLast': deleteWithUndo(lastSavedIds(c.n)); break;
      case 'undo': toast('Tap Undo on the message that appears after a save or delete'); break;
      case 'stop': stopListening(); break;
      default: toast('Say an entry first, e.g. "sold 50 kg sheet at 190"');
    }
  }

  // ---------------- confirmation card ----------------
  let cdTimer = null, cdEnd = 0, cdLeft = 0, countdownPaused = false;
  function showCard(entry) {
    stopCountdown();
    S.pending = entry;
    renderCard();
    const secs = +S.settings.autosave || 0;
    if (entry.flags.length === 0 && secs > 0) startCountdown(secs * 1000);
    speak(spokenSummary(entry));
    listenForCommand();
  }
  function listenForCommand() { /* voice now waits for Go, so nothing starts listening on its own */ }
  function startCountdown(ms) {
    cdLeft = ms; countdownPaused = false; runCountdown();
  }
  function runCountdown() {
    clearTimeout(cdTimer);
    cdEnd = Date.now() + cdLeft;
    const bar = $('#cdBar');
    if (bar) { bar.style.transition = 'none'; bar.style.transform = `scaleX(${cdLeft / ((+S.settings.autosave || 3) * 1000)})`; void bar.offsetWidth; bar.style.transition = `transform ${cdLeft}ms linear`; bar.style.transform = 'scaleX(0)'; }
    cdTimer = setTimeout(() => { cdTimer = null; commitPending(); }, cdLeft);
  }
  function pauseCountdown() {
    if (!cdTimer) return;
    clearTimeout(cdTimer); cdTimer = null; countdownPaused = true;
    cdLeft = Math.max(800, cdEnd - Date.now());
    const bar = $('#cdBar');
    if (bar) { const now = getComputedStyle(bar).transform; bar.style.transition = 'none'; bar.style.transform = now; }
  }
  function resumeCountdown() { if (countdownPaused && S.pending && S.pending.flags.length === 0) { countdownPaused = false; runCountdown(); } }
  function stopCountdown() { clearTimeout(cdTimer); cdTimer = null; countdownPaused = false; const w = $('#cdWrap'); if (w) w.hidden = true; }

  function commitPending() {
    if (!S.pending) return;
    stopCountdown(); stopListening();
    const e = S.pending; S.pending = null;
    delete e._guessedCategory; delete e.flags;
    const saved = saveNew(e);
    S.session.unshift(saved.id);
    renderCard(); renderSession(); refreshViews();
    $('#transcript').textContent = '';
    setMic(false, 'Saved. Tap the mic for the next entry');
    toast(`Saved: ${saved.category} ${saved.amount != null ? inr(saved.amount) : ''}`, () => deleteWithUndo([saved.id], 'Entry removed'));
  }
  function discardPending() {
    stopCountdown(); stopListening();
    S.pending = null; renderCard();
    $('#transcript').textContent = '';
    setMic(false, 'Discarded. Tap the mic to speak again');
  }

  function describeQty(e) {
    if (e.quantity == null) return '';
    let s = `${num(e.quantity, 2)} ${e.unit || ''}`.trim();
    if (e.drc != null) s += ` · DRC ${num(e.drc)}%`;
    if (e.dryKg != null && (e.drc != null || e.unit !== 'kg')) s += ` · ${num(e.dryKg)} kg dry`;
    return s;
  }
  function spokenSummary(e) {
    const parts = [e.category || e.type || 'Entry'];
    if (e.quantity != null) parts.push(`${e.quantity} ${e.unit || ''}`);
    if (e.amount != null) parts.push(`${Math.round(e.amount)} rupees`);
    if (e.party) parts.push(e.party);
    return parts.join(', ');
  }

  function renderCard() {
    const host = $('#cardHost');
    const e = S.pending;
    if (!e) { host.innerHTML = ''; return; }
    const fl = new Set(e.flags || []);
    const row = (label, val, key) => `<dt>${label}</dt><dd>${fl.has(key) ? `<span class="flag">${esc(val || 'missing')}</span>` : esc(val)}</dd>`;
    const isLatex = e.category === 'Latex' || e.category === 'Latex sale';
    let rows = row('Date', fmtDate(e.date), 'date') + row('Category', e.category || '?', 'category');
    if (e.quantity != null || fl.has('quantity')) rows += row('Quantity', e.quantity != null ? `${num(e.quantity, 2)} ${e.unit || ''}` : '', 'quantity');
    if (isLatex || e.drc != null) rows += row('DRC', e.drc != null ? `${num(e.drc)}%` : '', 'drc');
    if (e.dryKg != null && (isLatex || e.type === 'Production')) rows += row('Dry rubber', `${num(e.dryKg)} kg`, 'dryKg');
    if (e.rate != null) rows += row('Rate', `₹${num(e.rate, 2)}${isLatex ? ' / kg dry' : e.unit ? ' / ' + e.unit : ''}`, 'rate');
    if (e.party) rows += row(P.WAGE_CATEGORIES.includes(e.category) ? 'Worker' : 'Party', e.party, 'party');
    if (e.paymentMode) rows += row('Payment', e.paymentMode, 'paymentMode');
    const amount = e.type === 'Production' ? '' :
      `<div class="big-amount ${e.type === 'Income' ? 'pos' : 'neg'}">${fl.has('amount') ? '<span class="flag">amount missing</span>' : inr(e.amount)}</div>`;
    const auto = +S.settings.autosave || 0;
    host.innerHTML = `
      <div class="entry-card" aria-live="polite">
        <div class="head"><span class="badge ${esc(e.type)}">${esc(e.type || 'Type?')}</span><span class="cat">${esc(e.category || 'Not understood')}</span></div>
        ${amount}
        <dl class="fields">${rows}</dl>
        ${fl.size ? `<p class="card-note">Check the highlighted fields: say "change amount to …" or tap Edit.</p>` :
          auto ? `<div class="countdown" id="cdWrap"><i id="cdBar"></i></div>` : ''}
        <div class="row">
          <button type="button" class="btn primary" id="cSave">Save</button>
          <button type="button" class="btn" id="cEdit">Edit</button>
          <button type="button" class="btn danger" id="cDel">Delete</button>
        </div>
        <p class="hint">Heard: "${esc(e.voiceText)}"</p>
      </div>`;
    $('#cSave').onclick = () => { lastInputWasVoice = false; commitPending(); };
    $('#cDel').onclick = () => discardPending();
    $('#cEdit').onclick = () => { stopCountdown(); stopListening(); openEditor(S.pending, true); };
  }

  function renderSession() {
    const list = $('#sessionList');
    const items = S.session.map(id => S.entries.find(e => e.id === id)).filter(Boolean);
    list.innerHTML = items.length ? items.map(entryLi).join('') : '<li class="empty">Nothing yet</li>';
  }

  // ---------------- lists ----------------
  function entryLi(e) {
    const unsynced = pendingIds().has(e.id) ? '<span class="unsynced">not synced</span>' : '';
    const amt = e.type === 'Production' ? `${num(e.dryKg != null ? e.dryKg : e.quantity)} kg` : inr(e.amount);
    const detail = [describeQty(e), e.party, e.paymentMode].filter(Boolean).join(' · ');
    return `<li data-id="${esc(e.id)}" class="${e.status === 'Deleted' ? 'deleted' : ''}">
      <span class="dot ${esc(e.type)}"></span>
      <div class="main"><div class="t1">${esc(e.category)} ${unsynced}</div><div class="t2">${esc(detail || fmtDate(e.date))}</div></div>
      <div class="amt ${e.type === 'Income' ? 'pos' : e.type === 'Expense' ? 'neg' : ''}">${amt}</div></li>`;
  }

  function sumBy(list, pred, field) { return list.filter(pred).reduce((s, e) => s + (+e[field] || 0), 0); }
  function totals(list) {
    const income = sumBy(list, e => e.type === 'Income', 'amount');
    const expense = sumBy(list, e => e.type === 'Expense', 'amount');
    const dry = sumBy(list, e => e.type === 'Production', 'dryKg');
    const dens = +S.settings.density || 1;
    const latexKg = list.filter(e => e.type === 'Production' && e.category === 'Latex')
      .reduce((s, e) => s + (+e.quantity || 0) * (e.unit === 'litre' ? dens : 1), 0);
    return { income, expense, profit: income - expense, dry, latexKg };
  }
  const kpi = (label, value, cls, note) => `<div class="kpi"><div class="label">${label}</div><div class="value ${cls || ''}">${value}</div>${note ? `<div class="note">${note}</div>` : ''}</div>`;

  function renderHome() {
    const t = today(), m = t.slice(0, 7), fy = P.financialYear(t);
    const a = active();
    const block = list => { const x = totals(list); return kpi('Income', inr(x.income), 'pos') + kpi('Expense', inr(x.expense), 'neg') +
      kpi('Profit', inr(x.profit), x.profit >= 0 ? 'pos' : 'neg') + kpi('Dry rubber', `${num(x.dry)} kg`, '', `${num(x.latexKg)} kg latex (wet)`); };
    $('#monthTitle').textContent = fmtMonth(m);
    $('#monthKpis').innerHTML = block(a.filter(e => e.month === m));
    $('#fyTitle').textContent = `${fy} (April–March)`;
    $('#fyKpis').innerHTML = block(a.filter(e => e.fy === fy));
    const recent = a.slice().sort((x, y) => (y.createdAt || y.date).localeCompare(x.createdAt || x.date)).slice(0, 6);
    $('#recentList').innerHTML = recent.length ? recent.map(entryLi).join('') : '<li class="empty">No entries yet — tap "Speak an entry"</li>';
  }

  function fillCategoryOptions(sel, type, current, allLabel) {
    const types = type ? [type] : Object.keys(P.CATEGORIES);
    let html = allLabel ? `<option value="">${allLabel}</option>` : '';
    types.forEach(t => { html += P.CATEGORIES[t].map(c => `<option${c === current ? ' selected' : ''}>${esc(c)}</option>`).join(''); });
    if (current && !types.some(t => P.CATEGORIES[t].includes(current))) html += `<option selected>${esc(current)}</option>`;
    sel.innerHTML = html;
  }

  function renderEntries() {
    const m = $('#fMonth').value, ty = $('#fType').value, cat = $('#fCat').value;
    const list = active().filter(e => (!m || e.month === m) && (!ty || e.type === ty) && (!cat || e.category === cat))
      .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
    const t = totals(list);
    $('#filterSum').textContent = `${list.length} entries · Income ${inr(t.income)} · Expense ${inr(t.expense)} · ${num(t.dry)} kg dry`;
    let html = '', last = '';
    list.forEach(e => { if (e.date !== last) { html += `<li class="date-head">${fmtDate(e.date)}</li>`; last = e.date; } html += entryLi(e); });
    $('#entryList').innerHTML = html || '<li class="empty">No entries for this filter</li>';
  }

  // ---------------- editor ----------------
  let edEntry = null, edIsPending = false, edAmountAuto = true;
  function openEditor(entry, isPending) {
    edIsPending = !!isPending;
    edEntry = entry ? Object.assign({}, entry) : { id: null, date: today(), type: 'Expense', category: 'Miscellaneous', quantity: null, unit: '', drc: null, dryKg: null, rate: null, amount: null, party: '', paymentMode: '', notes: '', voiceText: '' };
    $('#edTitle').textContent = isPending ? 'Check entry' : entry ? 'Edit entry' : 'New entry';
    $('#eDate').value = edEntry.date || today();
    $('#eType').value = edEntry.type || 'Expense';
    fillCategoryOptions($('#eCat'), $('#eType').value, edEntry.category);
    $('#eQty').value = edEntry.quantity ?? '';
    $('#eUnit').value = edEntry.unit || '';
    $('#eDrc').value = edEntry.drc ?? '';
    $('#eRate').value = edEntry.rate ?? '';
    $('#eAmount').value = edEntry.amount ?? '';
    $('#eParty').value = edEntry.party || '';
    $('#ePay').value = edEntry.paymentMode || '';
    $('#eNotes').value = edEntry.notes || '';
    $('#eVoice').textContent = edEntry.voiceText ? `Voice: "${edEntry.voiceText}"` : '';
    $('#eDelete').hidden = !entry || isPending;
    const isLatex = edEntry.category === 'Latex' || edEntry.category === 'Latex sale';
    const base = isLatex ? edEntry.dryKg : edEntry.quantity;
    // amount is "automatic" if it is empty or was calculated from rate × quantity
    edAmountAuto = edEntry.amount == null || (edEntry.rate != null && base != null && Math.round(base * edEntry.rate) === Math.round(edEntry.amount));
    editorRecalc(null);
    $('#editor').showModal();
  }
  function readEditor() {
    const n = id => { const v = $(id).value; return v === '' ? null : +v; };
    return Object.assign({}, edEntry, {
      date: $('#eDate').value, type: $('#eType').value, category: $('#eCat').value, quantity: n('#eQty'), unit: $('#eUnit').value,
      drc: n('#eDrc'), rate: n('#eRate'), amount: n('#eAmount'), party: $('#eParty').value.trim(), paymentMode: $('#ePay').value, notes: $('#eNotes').value.trim()
    });
  }
  function editorRecalc(changed) {
    const e = readEditor();
    if (changed && changed !== 'amount' && edAmountAuto) e.amount = null;
    P.recompute(e, ctx(), changed);
    $('#eDry').value = e.dryKg ?? '';
    if (edAmountAuto && e.amount != null && changed !== 'amount') $('#eAmount').value = e.amount;
    const isLatex = e.category === 'Latex' || e.category === 'Latex sale';
    $('#eRateLabel').firstChild.textContent = isLatex ? 'Rate (₹/kg dry)' : 'Rate (₹/unit)';
    ['#eAmount', '#eQty', '#eDrc', '#eCat'].forEach(s => $(s).classList.remove('flag'));
    (e.flags || []).forEach(f => { const m = { amount: '#eAmount', quantity: '#eQty', drc: '#eDrc', category: '#eCat' }[f]; if (m) $(m).classList.add('flag'); });
    return e;
  }
  function wireEditor() {
    $('#eType').addEventListener('change', () => { fillCategoryOptions($('#eCat'), $('#eType').value, null); editorRecalc('category'); });
    $('#eCat').addEventListener('change', () => { delete edEntry._guessedCategory; editorRecalc('category'); });
    [['#eQty', 'quantity'], ['#eUnit', 'unit'], ['#eDrc', 'drc'], ['#eRate', 'rate']].forEach(([s, f]) => $(s).addEventListener('input', () => editorRecalc(f)));
    $('#eAmount').addEventListener('input', () => { edAmountAuto = $('#eAmount').value === ''; editorRecalc('amount'); });
    $('#eParty').addEventListener('change', () => {
      const w = S.workers.find(x => x.name.toLowerCase() === $('#eParty').value.trim().toLowerCase());
      if (w && $('#eType').value === 'Expense' && $('#eRate').value === '' && $('#eAmount').value === '') { $('#eRate').value = w.rate; $('#eQty').value = $('#eQty').value || 1; $('#eUnit').value = $('#eUnit').value || 'days'; editorRecalc('rate'); }
    });
    $('#eCancel').onclick = () => { $('#editor').close(); if (edIsPending) { renderCard(); } };
    $('#eSave').onclick = () => {
      if (!$('#eDate').value) { $('#eDate').focus(); return; }
      const e = editorRecalc(null);
      delete e._guessedCategory; delete e.flags;
      $('#editor').close();
      if (edIsPending) { S.pending = e; S.pending.flags = []; commitPending(); }
      else if (e.id) { updateEntry(e); toast('Entry updated'); refreshViews(); }
      else { const saved = saveNew(e); toast('Entry added', () => deleteWithUndo([saved.id], 'Entry removed')); refreshViews(); }
    };
    $('#eDelete').onclick = () => { const id = edEntry.id; $('#editor').close(); deleteWithUndo([id], 'Entry deleted'); };
  }

  // ---------------- reports ----------------
  let charts = [];
  let period = 'month';
  const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function fyOf(ym) { return P.financialYear(ym + '-01'); }
  function fyMonths(fy) { const y = +fy.slice(3, 7); const out = []; for (let i = 0; i < 12; i++) { const m = (3 + i) % 12; const yy = y + (i >= 9 ? 1 : 0); out.push(`${yy}-${String(m + 1).padStart(2, '0')}`); } return out; }
  function prevFY(fy) { const y = +fy.slice(3, 7) - 1; return `FY ${y}-${String((y + 1) % 100).padStart(2, '0')}`; }

  function groupSum(list, keyFn, field) {
    const m = new Map();
    list.forEach(e => { const k = keyFn(e); if (k) m.set(k, (m.get(k) || 0) + (+e[field] || 0)); });
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }
  function priceStats(list) {
    const lat = list.filter(e => e.category === 'Latex sale'), sh = list.filter(e => e.category === 'Sheet sale');
    const avg = l => { const kg = sumBy(l, () => true, 'dryKg'); return kg ? sumBy(l, () => true, 'amount') / kg : null; };
    return { latex: avg(lat), sheet: avg(sh) };
  }
  const pct = (a, b) => (b ? ((a - b) / Math.abs(b)) * 100 : null);
  const arrow = p => p == null ? '' : `${p >= 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(0)}%`;

  function kpiBlock(list, compare, compareLabel) {
    const t = totals(list), c = compare && compare.length ? totals(compare) : null;
    const ps = priceStats(list);
    const costKg = t.dry ? t.expense / t.dry : null;
    return `<div class="card"><div class="kpis">
      ${kpi('Income', inr(t.income), 'pos', c ? `${arrow(pct(t.income, c.income))} vs ${compareLabel}` : '')}
      ${kpi('Expense', inr(t.expense), 'neg', c ? `${arrow(pct(t.expense, c.expense))} vs ${compareLabel}` : '')}
      ${kpi('Profit', inr(t.profit), t.profit >= 0 ? 'pos' : 'neg', c ? `${compareLabel}: ${inr(c.profit)}` : '')}
      ${kpi('Dry rubber produced', `${num(t.dry)} kg`, '', `${num(t.latexKg)} kg latex (wet)`)}
      ${kpi('Avg latex price', ps.latex ? `₹${num(ps.latex)}` : '—', '', 'per kg dry rubber')}
      ${kpi('Avg sheet price', ps.sheet ? `₹${num(ps.sheet)}` : '—', '', 'per kg')}
      ${kpi('Cost per kg', costKg ? `₹${num(costKg)}` : '—', '', 'expense ÷ dry kg')}
    </div></div>`;
  }
  function wagesTable(list) {
    const rows = groupSum(list.filter(e => e.type === 'Expense' && P.WAGE_CATEGORIES.includes(e.category)), e => e.party || '(no name)', 'amount');
    if (!rows.length) return '';
    const total = rows.reduce((s, r) => s + r[1], 0);
    return `<div class="card"><h2>Wages per worker</h2><table class="data"><thead><tr><th>Worker</th><th>Payments</th><th>Total</th></tr></thead><tbody>
      ${rows.map(([n, v]) => `<tr><td>${esc(n)}</td><td>${list.filter(e => P.WAGE_CATEGORIES.includes(e.category) && (e.party || '(no name)') === n).length}</td><td>${inr(v)}</td></tr>`).join('')}
      <tr><th>Total</th><th></th><th>${inr(total)}</th></tr></tbody></table></div>`;
  }
  function chartCard(id, title, tall) { return `<div class="card"><h2>${title}</h2><div class="chart-box ${tall ? 'tall' : ''}"><canvas id="${id}"></canvas></div></div>`; }

  function renderReports() {
    charts.forEach(c => c.destroy()); charts = [];
    const a = active();
    const body = $('#reportBody');
    // FY options
    const fys = new Set(a.map(e => e.fy).filter(Boolean)); fys.add(P.financialYear(today()));
    const fySel = $('#rFY'); const curFY = fySel.value || P.financialYear(today());
    fySel.innerHTML = Array.from(fys).sort().reverse().map(f => `<option${f === curFY ? ' selected' : ''}>${f}</option>`).join('');
    $('#rMonth').hidden = period !== 'month'; fySel.hidden = period !== 'fy';

    let html = '';
    if (period === 'month') {
      const m = $('#rMonth').value || today().slice(0, 7);
      const list = a.filter(e => e.month === m);
      const lyM = `${+m.slice(0, 4) - 1}${m.slice(4)}`;
      html += kpiBlock(list, a.filter(e => e.month === lyM), fmtMonth(lyM));
      if (!list.length) { body.innerHTML = html + '<p class="muted">No entries in this month.</p>'; return; }
      html += chartCard('cExpCat', 'Expense by category') + chartCard('cDaily', 'Daily production (kg dry rubber)') + wagesTable(list);
      body.innerHTML = html;
      if (!window.Chart) return chartsMissing();
      expenseChart('cExpCat', list);
      const days = new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate();
      const labels = Array.from({ length: days }, (_, i) => String(i + 1));
      const byDay = cat => labels.map(d => sumBy(list, e => e.type === 'Production' && e.category === cat && +e.date.slice(8) === +d, 'dryKg'));
      const ds = [['Latex', cssVar('--prod')], ['Sheet rubber', cssVar('--brand')], ['Scrap / ottupal', cssVar('--muted')]]
        .map(([cat, color]) => ({ label: cat, data: byDay(cat), backgroundColor: color, stack: 's' })).filter(d => d.data.some(v => v));
      charts.push(new Chart($('#cDaily'), { type: 'bar', data: { labels, datasets: ds }, options: baseOpts({ stacked: true, legend: ds.length > 1 }) }));
    } else {
      const fy = fySel.value || curFY;
      const list = a.filter(e => e.fy === fy);
      const pfy = prevFY(fy);
      const prev = a.filter(e => e.fy === pfy);
      html += kpiBlock(list, prev, pfy);
      if (!list.length) { body.innerHTML = html + '<p class="muted">No entries in this financial year.</p>'; return; }
      html += chartCard('cMonthly', 'Income, expense and profit by month', true) + chartCard('cProd', 'Dry rubber produced by month (kg)') + chartCard('cExpCatY', 'Expense by category');
      const t = totals(list), p = totals(prev);
      const row = (label, x, y, f) => `<tr><td>${label}</td><td>${f(x)}</td><td>${f(y)}</td><td>${arrow(pct(x, y))}</td></tr>`;
      html += `<div class="card"><h2>${fy} vs ${pfy}</h2><table class="data"><thead><tr><th></th><th>${fy.slice(3)}</th><th>${pfy.slice(3)}</th><th>Change</th></tr></thead><tbody>
        ${row('Income', t.income, p.income, inr)}${row('Expense', t.expense, p.expense, inr)}${row('Profit', t.profit, p.profit, inr)}
        ${row('Dry rubber kg', t.dry, p.dry, v => num(v))}${row('Cost per kg', t.dry ? t.expense / t.dry : null, p.dry ? p.expense / p.dry : null, v => v == null ? '—' : '₹' + num(v))}
        </tbody></table></div>` + wagesTable(list);
      body.innerHTML = html;
      if (!window.Chart) return chartsMissing();
      const months = fyMonths(fy), labels = months.map(m => MONTH_NAMES[+m.slice(5) - 1]);
      const inc = months.map(m => sumBy(list, e => e.month === m && e.type === 'Income', 'amount'));
      const exp = months.map(m => sumBy(list, e => e.month === m && e.type === 'Expense', 'amount'));
      charts.push(new Chart($('#cMonthly'), {
        data: { labels, datasets: [
          { type: 'bar', label: 'Income', data: inc, backgroundColor: cssVar('--income') },
          { type: 'bar', label: 'Expense', data: exp, backgroundColor: cssVar('--expense') },
          { type: 'line', label: 'Profit', data: inc.map((v, i) => v - exp[i]), borderColor: cssVar('--prod'), backgroundColor: cssVar('--prod'), tension: .25, pointRadius: 3 }
        ] }, options: baseOpts({ legend: true, money: true })
      }));
      charts.push(new Chart($('#cProd'), { type: 'bar', data: { labels, datasets: [{ label: 'kg dry', data: months.map(m => sumBy(list, e => e.month === m && e.type === 'Production', 'dryKg')), backgroundColor: cssVar('--prod') }] }, options: baseOpts({}) }));
      expenseChart('cExpCatY', list);
    }
  }
  function chartsMissing() { $$('.chart-box').forEach(b => { b.innerHTML = '<p class="muted">Charts need an internet connection the first time.</p>'; b.style.height = 'auto'; }); }
  function expenseChart(id, list) {
    const rows = groupSum(list.filter(e => e.type === 'Expense'), e => e.category, 'amount');
    const box = $('#' + id).parentElement; box.style.height = Math.max(120, rows.length * 34 + 40) + 'px';
    charts.push(new Chart($('#' + id), { type: 'bar', data: { labels: rows.map(r => r[0]), datasets: [{ label: '₹', data: rows.map(r => r[1]), backgroundColor: cssVar('--expense') }] },
      options: Object.assign(baseOpts({ money: true }), { indexAxis: 'y' }) }));
  }
  function baseOpts({ stacked, legend, money }) {
    const ink = cssVar('--muted'), grid = cssVar('--line');
    const tick = { color: ink, font: { size: 11 } };
    const fmt = v => money ? (Math.abs(v) >= 1000 ? '₹' + (v / 1000).toLocaleString('en-IN', { maximumFractionDigits: 1 }) + 'k' : '₹' + v) : v;
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: !!legend, labels: { color: ink, boxWidth: 12 } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${money ? inr(c.parsed.x !== undefined && c.chart.options.indexAxis === 'y' ? c.parsed.x : c.parsed.y) : num(c.parsed.y)}` } } },
      scales: { x: { stacked: !!stacked, ticks: Object.assign({}, tick, { callback: function (v) { return this.chart.options.indexAxis === 'y' ? fmt(v) : this.getLabelForValue(v); } }), grid: { display: false } },
        y: { stacked: !!stacked, ticks: Object.assign({}, tick, { callback: function (v) { return this.chart.options.indexAxis === 'y' ? this.getLabelForValue(v) : fmt(v); } }), grid: { color: grid } } }
    };
  }

  // ---------------- settings & workers ----------------
  function renderSettings() {
    $('#sUrl').value = S.settings.url; $('#sKey').value = S.settings.key;
    renderAuth();
    $('#sDensity').value = S.settings.density; $('#sAuto').value = S.settings.autosave; $('#sReadback').checked = !!S.settings.readback;
    const link = $('#sheetLink'); link.hidden = !S.sheetUrl; if (S.sheetUrl) link.href = S.sheetUrl;
    renderWorkers(); renderVoiceSupport();
  }
  // ---------------- Google sign-in ----------------
  let gisLoaded = null, gisClientId = '';
  const cfgCache = {};   // Web App URL -> OAuth client id ('' when not set up)
  function loadGis() {
    if (!gisLoaded) gisLoaded = new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
      sc.onload = resolve; sc.onerror = () => { gisLoaded = null; reject(new Error('gis-load')); };
      document.head.appendChild(sc);
    });
    return gisLoaded;
  }
  function authStatus(html) { $('#authStatus').innerHTML = html; }
  function renderAuth() {
    const signedIn = !!S.settings.session;
    $('#signOutBtn').hidden = !signedIn;
    $('#gBtn').hidden = signedIn;
    if (signedIn) { authStatus(`Signed in with Google as <b>${esc(S.settings.email)}</b>.`); return; }
    if (S.settings.key && S.settings.url) authStatus('Connected with the access key. You can also sign in with Google:');
    setupGoogle();
  }
  async function setupGoogle() {
    const url = ($('#sUrl').value || S.settings.url || '').trim();
    if (!url) { authStatus('Enter the Web App URL above, tap <b>Save settings</b>, then sign in with Google.'); return; }
    if (!navigator.onLine) { authStatus('Google sign-in needs an internet connection.'); return; }
    try {
      if (!(url in cfgCache)) {
        const r = await post(url, { action: 'config' });
        if (!r.ok || r.app !== 'rubber-ledger') { authStatus('That URL is not the Rubber Ledger web app. Check the Web App URL.'); return; }
        cfgCache[url] = r.clientId || '';
      }
      const cfg = { clientId: cfgCache[url] };
      if (!cfg.clientId) { authStatus('Google sign-in is not set up in the script yet: add your OAuth Client ID to <b>Code.gs</b> (see README). Meanwhile you can use an access key.'); return; }
      await loadGis();
      if (gisClientId !== cfg.clientId) {
        google.accounts.id.initialize({ client_id: cfg.clientId, callback: onGoogleCredential, ux_mode: 'popup', auto_select: false, cancel_on_tap_outside: true });
        gisClientId = cfg.clientId;
      }
      const box = $('#gBtn'); box.innerHTML = '';
      google.accounts.id.renderButton(box, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', width: 260 });
      if (!S.settings.key) authStatus('Sign in with the Google account that is allowed to use your sheet.');
    } catch (err) {
      authStatus(err.message === 'gis-load' ? 'Could not load Google sign-in. Check the connection and open Settings again.' : 'Could not reach the Web App URL. Check it and try again.');
    }
  }
  async function onGoogleCredential(resp) {
    const url = ($('#sUrl').value || S.settings.url || '').trim();
    authStatus('Signing in…');
    try {
      const r = await post(url, { action: 'login', idToken: resp.credential });
      if (!r.ok) {
        const msg = {
          'not-allowed': `<b>${esc(r.email || 'This account')}</b> is not allowed for this sheet. Add it in the sheet: Rubber Ledger → Allowed Google accounts.`,
          'google-not-configured': 'Google sign-in is not set up in the script yet (OAuth Client ID missing in Code.gs).',
          'invalid-token': 'Google sign-in could not be verified. Please try again.'
        }[r.error] || ('Sign-in failed: ' + esc(r.error || 'unknown error'));
        authStatus(msg); return;
      }
      S.settings.url = url; S.settings.session = r.session; S.settings.email = r.email;
      await persist();
      toast(`Signed in as ${r.email}`);
      S.lastSyncError = '';
      renderAuth(); renderSyncBadge(); sync(true);
    } catch (err) {
      authStatus('Could not reach the Web App URL. Check it and try again.');
    }
  }
  async function signOut() {
    try { if (S.settings.session) await post(S.settings.url, { action: 'logout', session: S.settings.session }); } catch (e) { /* offline: forget locally */ }
    S.settings.session = ''; S.settings.email = '';
    await persist();
    try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (e) { /* ignore */ }
    toast('Signed out'); renderAuth(); renderSyncBadge();
  }

  function renderVoiceSupport() {
    const mode = standalone ? 'Home Screen web app' : otherIOSBrowser ? 'a browser other than Safari' : iOS ? 'Safari' : 'this browser';
    const blocked = !SR || otherIOSBrowser || ['not-allowed', 'service-not-allowed', 'unsupported', 'timeout'].includes(lastVoiceError);
    const problem = blocked ? voiceProblem(lastVoiceError === 'unsupported' ? '' : lastVoiceError) :
      (standalone && iOS ? 'If the mic does not respond here, open the page in Safari.' : 'The mic button should work here.');
    $('#voiceSupport').innerHTML = `Voice: running in <b>${mode}</b>. ${esc(problem)}` +
      (standalone && iOS ? '<br>To open in Safari from the Home Screen: delete this icon, open the link in Safari, tap Share → Add to Home Screen and switch <b>Open as Web App</b> off.' : '');
  }
  function renderWorkers() {
    const list = $('#workerList');
    list.innerHTML = S.workers.length ? S.workers.map(w => `<li class="${w.active === 'No' ? 'inactive' : ''}">
      <div><b>${esc(w.name)}</b><div class="hint">${esc(w.role)} · ${esc(w.basis)} · ${inr(+w.rate)}${w.active === 'No' ? ' · inactive' : ''}</div></div>
      <button type="button" class="btn" data-wid="${esc(w.id)}">Edit</button></li>`).join('') : '<li class="hint">No workers yet. Add tappers and labourers so wages are tracked per person.</li>';
    $('#workerNames').innerHTML = S.workers.map(w => `<option value="${esc(w.name)}">`).join('');
  }
  function editWorker(w) {
    $('#wId').value = w ? w.id : ''; $('#wName').value = w ? w.name : ''; $('#wRole').value = w ? w.role : 'Tapper';
    $('#wBasis').value = w ? w.basis : 'Per day'; $('#wRate').value = w ? w.rate : ''; $('#wActive').value = w ? w.active : 'Yes';
    $('#wSave').textContent = w ? 'Save worker' : 'Add worker'; $('#wCancel').hidden = !w;
  }

  function exportCSV() {
    const cols = [['ID', 'id'], ['Date', 'date'], ['Month', 'month'], ['Financial year', 'fy'], ['Type', 'type'], ['Category', 'category'],
      ['Quantity', 'quantity'], ['Unit', 'unit'], ['DRC %', 'drc'], ['Dry rubber kg', 'dryKg'], ['Rate', 'rate'], ['Amount', 'amount'],
      ['Party / Worker', 'party'], ['Payment mode', 'paymentMode'], ['Notes', 'notes'], ['Voice text', 'voiceText'], ['Created at', 'createdAt'], ['Status', 'status']];
    const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const rows = active().sort((a, b) => a.date.localeCompare(b.date)).map(e => cols.map(([, k]) => q(e[k])).join(','));
    const blob = new Blob(['﻿' + cols.map(c => c[0]).join(',') + '\n' + rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `rubber-ledger-${today()}.csv`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------------- chrome ----------------
  function renderSyncBadge() {
    const b = $('#syncBadge');
    b.classList.remove('pending', 'error');
    if (!configured()) { b.textContent = S.settings.url ? 'Signed out' : 'Not connected'; b.classList.add('error'); }
    else if (S.syncing) { b.textContent = 'Syncing…'; }
    else if (S.lastSyncError) { b.textContent = S.queue.length ? `${S.queue.length} not synced` : 'Sync error'; b.classList.add('error'); b.title = S.lastSyncError; }
    else if (S.queue.length) { b.textContent = `${S.queue.length} not synced`; b.classList.add('pending'); }
    else { b.textContent = 'Synced'; }
    renderBanner();
  }
  function renderBanner() {
    const bn = $('#banner');
    let msg = '';
    if (!S.settings.url) msg = 'Connect your Google Sheet in <button type="button" data-go="settings">Settings</button> to save entries to Drive. Entries are kept on this phone until then.';
    else if (!configured()) msg = 'Sign in with Google in <button type="button" data-go="settings">Settings</button> to sync. Entries are kept on this phone until then.';
    else if (S.lastSyncError === 'unauthorized') msg = 'The access key was rejected. Check it in <button type="button" data-go="settings">Settings</button>.';
    else if (otherIOSBrowser || !SR) msg = esc(voiceProblem('')) + ' <button type="button" data-go="settings">How to fix</button>';
    bn.innerHTML = msg; bn.hidden = !msg;
  }

  let currentView = 'home';
  function show(view) {
    currentView = view;
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
    $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    if (view !== 'voice') stopListening();
    if (view === 'settings') renderSettings();
    refreshViews();
    window.scrollTo(0, 0);
  }
  function refreshViews() {
    if (currentView === 'home') renderHome();
    if (currentView === 'entries') renderEntries();
    if (currentView === 'reports') renderReports();
    if (currentView === 'settings') renderWorkers();
    if (currentView === 'voice') renderSession();
  }

  // ---------------- wiring ----------------
  function wire() {
    $$('.tabbar button').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
    document.addEventListener('click', ev => {
      const go = ev.target.closest('[data-go]'); if (go) show(go.dataset.go);
      const li = ev.target.closest('.entry-list li[data-id]');
      if (li) { const e = S.entries.find(x => x.id === li.dataset.id); if (e && e.status !== 'Deleted') openEditor(e, false); }
      const wb = ev.target.closest('[data-wid]'); if (wb) editWorker(S.workers.find(w => w.id === wb.dataset.wid));
    });
    $('#homeMic').addEventListener('click', () => { show('voice'); startListening(); });
    $('#micBtn').addEventListener('click', () => { if (recording || listening) { stopListening(); if (S.pending && !$('#dictInput').value.trim()) resumeCountdown(); } else startListening(); });
    $('#dictForm').addEventListener('submit', ev => {
      ev.preventDefault();
      const wasVoice = recording || listening;
      stopListening();
      const v = $('#dictInput').value.trim();
      if (!v) { setMic(false); return; }
      $('#dictInput').value = ''; baseText = ''; lastInputWasVoice = wasVoice;
      handleUtterance(v);
    });
    $('#dictInput').addEventListener('input', () => { if (S.pending) pauseCountdown(); });
    $('#syncBadge').addEventListener('click', () => sync(true));
    $('#syncBtn').addEventListener('click', async () => { await sync(true); toast(S.lastSyncError ? 'Sync failed: ' + S.lastSyncError : 'Synced with Google Sheet'); });
    $('#csvBtn').addEventListener('click', exportCSV);
    $('#addBtn').addEventListener('click', () => openEditor(null, false));
    ['#fMonth', '#fType'].forEach(s => $(s).addEventListener('change', () => { if (s === '#fType') fillCategoryOptions($('#fCat'), $('#fType').value, '', 'All categories'); renderEntries(); }));
    $('#fCat').addEventListener('change', renderEntries);
    $$('.seg-btn').forEach(b => b.addEventListener('click', () => { period = b.dataset.period; $$('.seg-btn').forEach(x => x.classList.toggle('active', x === b)); renderReports(); }));
    $('#rMonth').addEventListener('change', renderReports);
    $('#rFY').addEventListener('change', renderReports);

    $('#settingsForm').addEventListener('submit', async ev => {
      ev.preventDefault();
      const newUrl = $('#sUrl').value.trim();
      if (newUrl !== S.settings.url) { S.settings.session = ''; S.settings.email = ''; }   // a different sheet needs a new sign-in
      S.settings.url = newUrl; S.settings.key = $('#sKey').value.trim();
      S.settings.density = +$('#sDensity').value || 1; S.settings.autosave = Math.max(0, +$('#sAuto').value || 0);
      S.settings.readback = $('#sReadback').checked;
      await persist(); toast('Settings saved'); renderAuth(); renderSyncBadge(); sync(true);
    });
    $('#signOutBtn').addEventListener('click', signOut);
    $('#testBtn').addEventListener('click', async () => {
      const st = $('#connStatus');
      const url = $('#sUrl').value.trim();
      const body = S.settings.session && url === S.settings.url ? { session: S.settings.session } : { key: $('#sKey').value.trim() };
      st.textContent = 'Testing…';
      try {
        const d = await post(url, Object.assign({ action: 'ping' }, body));
        if (!d.ok) throw new Error(d.error || 'server-error');
        st.textContent = `Connected to "${d.sheetName}"${d.email ? ' as ' + d.email : ''}.`; S.sheetUrl = d.sheetUrl;
        const link = $('#sheetLink'); link.hidden = false; link.href = d.sheetUrl;
      } catch (err) {
        st.textContent = 'Not connected: ' + (err.message === 'unauthorized' ? (body.session ? 'sign-in expired, sign in again' : 'sign in with Google first (or enter a valid access key)') : err.name === 'AbortError' ? 'timed out' : err.message);
      }
    });
    $('#workerForm').addEventListener('submit', ev => {
      ev.preventDefault();
      const w = { id: $('#wId').value || 'W' + Date.now().toString(36).toUpperCase(), name: $('#wName').value.trim(), role: $('#wRole').value,
        basis: $('#wBasis').value, rate: +$('#wRate').value || 0, active: $('#wActive').value };
      if (!w.name) return;
      const i = S.workers.findIndex(x => x.id === w.id);
      if (i >= 0) S.workers[i] = w; else S.workers.push(w);
      queueOp({ op: 'worker', worker: w });
      editWorker(null); renderWorkers(); toast('Worker saved');
    });
    $('#wCancel').addEventListener('click', () => editWorker(null));
    wireEditor();

    window.addEventListener('online', () => sync(true));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(true); else stopListening(); });
  }

  async function init() {
    S.settings = Object.assign(S.settings, await KV.get('settings', {}));
    S.entries = await KV.get('entries', []);
    S.workers = await KV.get('workers', []);
    S.queue = await KV.get('queue', []);
    S.sheetUrl = await KV.get('sheetUrl', '');
    const m = today().slice(0, 7);
    $('#fMonth').value = m; $('#rMonth').value = m;
    fillCategoryOptions($('#fCat'), '', '', 'All categories');
    wire(); renderSyncBadge(); renderVoiceSupport(); show('home');
    sync(true);
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
    window.addEventListener('load', () => { if (currentView === 'reports') renderReports(); });
  }

  // test hook
  window.__rubber = { S, handleUtterance, commitPending, sync, show };
  init();
})();
