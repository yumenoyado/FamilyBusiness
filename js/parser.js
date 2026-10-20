/* Rubber Ledger – voice text parser.
 * Turns a spoken sentence such as "sold 40 litre latex DRC 35 at 190 to society"
 * into a structured entry, and recognises voice commands ("save", "delete", ...).
 * Pure functions, no DOM: used by the app and by tests/parser.test.js.
 */
(function (root) {
  'use strict';

  const CATEGORIES = {
    Production: ['Latex', 'Sheet rubber', 'Scrap / ottupal', 'Cup lump'],
    Income: ['Latex sale', 'Sheet sale', 'Scrap sale', 'Subsidy', 'Other income'],
    Expense: ['Tapping wages', 'Weeding/labour', 'Fertilizer', 'Acid & chemicals', 'Rain guarding',
      'Plastic/cups', 'Smoke house fuel', 'Transport', 'Equipment & repairs', 'Land tax',
      'Loan interest', 'Miscellaneous']
  };
  const WAGE_CATEGORIES = ['Tapping wages', 'Weeding/labour'];
  const UNITS = ['litre', 'kg', 'sheets', 'nos', 'days'];
  const PAYMENT_MODES = ['Cash', 'UPI', 'Bank', 'Credit'];

  // ---------- number words ----------
  const SMALL = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19 };
  const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  const SCALES = { hundred: 100, thousand: 1000, lakh: 100000, lakhs: 100000, lac: 100000, lacs: 100000 };

  const isNumWord = w => w in SMALL || w in TENS;
  const isScale = w => w in SCALES;
  const isDigits = w => /^\d+(\.\d+)?$/.test(w);

  // Evaluate one run of number tokens. Colloquial prices such as "one eighty five" (185)
  // or "fourteen fifty" (1450) are two small chunks read as hundreds + rest.
  function evalRun(tokens) {
    const chunks = [];
    let total = 0, current = 0, prev = null, hasScale = false, started = false;
    const flush = () => { if (started) chunks.push({ value: total + current, hasScale }); total = 0; current = 0; hasScale = false; started = false; prev = null; };
    for (const tok of tokens) {
      if (tok === 'and') continue;
      if (isScale(tok)) {
        const s = SCALES[tok];
        if (!started) { current = 1; started = true; }
        if (s === 100) current = (current || 1) * 100;
        else { total += (current || 1) * s; current = 0; }
        hasScale = true; prev = 'scale';
        continue;
      }
      const v = isDigits(tok) ? parseFloat(tok) : (tok in SMALL ? SMALL[tok] : TENS[tok]);
      const kind = isDigits(tok) ? 'digit' : (tok in TENS ? 'tens' : (v < 10 ? 'unit' : 'teen'));
      // decide whether this token continues the current chunk
      const continues = started && (
        (prev === 'tens' && kind === 'unit') ||
        (prev === 'scale' && current % 100 === 0 && kind !== 'digit')
      );
      if (started && !continues) flush();
      current += v; started = true; prev = kind;
    }
    flush();
    if (chunks.length === 2 && !chunks[0].hasScale && !chunks[1].hasScale &&
        chunks[0].value > 0 && chunks[0].value < 100 && chunks[1].value >= 10 && chunks[1].value < 100) {
      return [chunks[0].value * 100 + chunks[1].value];
    }
    return chunks.map(c => c.value);
  }

  function wordsToNumbers(text) {
    const toks = text.split(/\s+/).filter(Boolean);
    const out = [];
    let i = 0;
    while (i < toks.length) {
      const t = toks[i];
      const next = toks[i + 1];
      const startsRun = isNumWord(t) || (t === 'a' && next && isScale(next)) || (isDigits(t) && next && isScale(next));
      if (!startsRun) { out.push(t); i++; continue; }
      const run = [];
      while (i < toks.length) {
        const w = toks[i];
        const n2 = toks[i + 1];
        if (isNumWord(w) || isScale(w)) { run.push(w); i++; continue; }
        if (w === 'a' && n2 && isScale(n2) && run.length === 0) { run.push('one'); i++; continue; }
        if (isDigits(w) && n2 && isScale(n2) && run.length === 0) { run.push(w); i++; continue; }
        if (w === 'and' && run.length && n2 && (isNumWord(n2))) { run.push(w); i++; continue; }
        if (w === 'point' && run.length && n2 && isNumWord(n2)) { run.push('.' + SMALL[n2]); i += 2; continue; }
        break;
      }
      // handle decimal marker produced above (".5")
      let dec = '';
      const plain = [];
      for (const r of run) { if (r.startsWith('.')) dec += r.slice(1); else plain.push(r); }
      const vals = evalRun(plain);
      if (dec && vals.length) vals[vals.length - 1] = parseFloat(vals[vals.length - 1] + '.' + dec);
      out.push(...vals.map(String));
    }
    return out.join(' ');
  }

  function normalize(raw) {
    let t = String(raw || '').toLowerCase();
    t = t.replace(/₹\s*/g, ' rs ');
    t = t.replace(/(\d),(?=\d)/g, '$1');
    t = t.replace(/(\d)\s*%/g, '$1 percent ').replace(/%/g, ' percent ');
    t = t.replace(/\/-/g, ' ');
    t = t.replace(/\brs\.?(?=\s|\d|$)/g, ' rs ');
    t = t.replace(/(\d+(?:\.\d+)?)k\b/g, (m, n) => String(parseFloat(n) * 1000));
    t = t.replace(/(\d)(rs|kg|kgs|l|ltr|litres?|liters?)\b/g, '$1 $2');
    t = t.replace(/[-–—]/g, ' ');
    t = t.replace(/[,;!?]/g, ' ');
    t = t.replace(/\.(?!\d)/g, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    return wordsToNumbers(t);
  }

  // ---------- helpers ----------
  const pad = n => String(n).padStart(2, '0');
  const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const round = (n, p = 2) => (n == null || isNaN(n)) ? null : Math.round(n * Math.pow(10, p)) / Math.pow(10, p);
  const titleCase = s => s.replace(/\b[a-z]/g, c => c.toUpperCase());
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const monthIndex = m => MONTHS.indexOf(m.slice(0, 3));

  function financialYear(dateStr) {
    if (!dateStr) return '';
    const y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7);
    const start = m >= 4 ? y : y - 1;
    return `FY ${start}-${pad((start + 1) % 100)}`;
  }

  function resolveDay(today, day, monthIdx) {
    let y = today.getFullYear();
    let m = monthIdx == null ? today.getMonth() : monthIdx;
    let d = new Date(y, m, day);
    if (d > today) { // a future date most likely means last month / last year
      if (monthIdx == null) d = new Date(y, m - 1, day); else d = new Date(y - 1, m, day);
    }
    return isoDate(d);
  }

  // Extracts a date from text; returns {date, text} with the matched words removed.
  function takeDate(t, today) {
    let m;
    const addDays = n => { const d = new Date(today); d.setDate(d.getDate() + n); return isoDate(d); };
    if ((m = t.match(/\bday before yesterday\b/))) return { date: addDays(-2), text: t.replace(m[0], ' ') };
    if ((m = t.match(/\byesterday\b/))) return { date: addDays(-1), text: t.replace(m[0], ' ') };
    if ((m = t.match(/\btoday\b/))) return { date: addDays(0), text: t.replace(m[0], ' ') };
    if ((m = t.match(new RegExp('\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MONTH_RE + '\\b')))) {
      return { date: resolveDay(today, +m[1], monthIndex(m[2])), text: t.replace(m[0], ' ') };
    }
    if ((m = t.match(new RegExp('\\b(?:on\\s+)?' + MONTH_RE + '\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b')))) {
      return { date: resolveDay(today, +m[2], monthIndex(m[1])), text: t.replace(m[0], ' ') };
    }
    if ((m = t.match(/\bon\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/)) || (m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/))) {
      const day = +m[1];
      if (day >= 1 && day <= 31) return { date: resolveDay(today, day, null), text: t.replace(m[0], ' ') };
    }
    return { date: isoDate(today), text: t };
  }

  const UNIT_RE = /(\d+(?:\.\d+)?)\s*(litres?|liters?|ltrs?|ltr|lt|l|kgs?|kilos?|kilograms?|kg|sheets?|bags?|sacks?|nos|numbers?|pieces?|pcs|days?|packets?|cans?|bottles?|loads?|trips?)\b/;
  function unitOf(u) {
    if (/^l|^lt/.test(u)) return 'litre';
    if (/^k/.test(u)) return 'kg';
    if (/^sheet/.test(u)) return 'sheets';
    if (/^day/.test(u)) return 'days';
    return 'nos';
  }

  const PRODUCT = {
    latex: /\b(latex|paal|pal)\b/,
    sheet: /\b(sheets?|rss|sheet rubber)\b/,
    scrap: /\b(scrap|ottupal|otupal|ottu pal|ottupaal)\b/,
    lump: /\b(cup ?lump|lumps?)\b/
  };
  const SALE_W = /\b(sold|sell|selling|sale|sales|received|receive|income)\b/;
  const EXPENSE_W = /\b(paid|pay|paying|bought|buy|purchased?|spent|spend|expenses?|cost|wages?|salary|advance|bill)\b/;
  const PROD_W = /\b(collected|collect|collection|tapped|produced|production|made|got|harvest(?:ed)?|yield)\b/;
  const EXPENSE_RULES = [
    ['Tapping wages', /\btapp(?:er|ers|ing)\b/],
    ['Rain guarding', /\brain ?guard(?:ing)?\b|\bguarding\b/],
    ['Weeding/labour', /\bweed(?:ing)?\b|\blabou?r(?:er|ers)?\b|\bworkers?\b|\bcoolie\b|\bslashing\b|\bclearing\b/],
    ['Fertilizer', /\bfertili[sz]ers?\b|\bmanure\b|\burea\b|\bpotash\b|\bfactamfos\b|\bdolomite\b|\blime\b|\bcompost\b/],
    ['Acid & chemicals', /\bacid\b|\bformic\b|\bchemicals?\b|\bammonia\b|\bfungicide\b|\bcopper\b|\bbordeaux\b|\bsulph?ur\b|\bspray(?:ing)?\b/],
    ['Plastic/cups', /\bcups?\b|\bplastic\b|\bspouts?\b/],
    ['Smoke house fuel', /\bfire ?wood\b|\bsmoke ?house\b|\bfuel\b|\bwood\b/],
    ['Transport', /\btransport\b|\bauto\b|\blorry\b|\bvehicle\b|\bdiesel\b|\bpetrol\b|\bfreight\b|\bjeep\b|\btaxi\b/],
    ['Equipment & repairs', /\bknife\b|\bknives\b|\broller\b|\bmachine\b|\brepairs?\b|\bequipment\b|\btools?\b|\bsharpen(?:ing)?\b/],
    ['Land tax', /\btax\b/],
    ['Loan interest', /\binterest\b|\bloan\b|\bemi\b/]
  ];

  const isLatexCat = c => c === 'Latex' || c === 'Latex sale';
  const isKgCat = c => ['Sheet rubber', 'Scrap / ottupal', 'Cup lump', 'Sheet sale', 'Scrap sale'].includes(c);

  // Recalculate derived fields. `changed` = the field the user just changed (optional).
  function recompute(e, ctx, changed) {
    const density = (ctx && ctx.density) || 1;
    if (isLatexCat(e.category)) {
      if (!e.unit && e.quantity != null) e.unit = 'kg';   // latex is weighed (wet kg)
      if (e.quantity != null && e.drc != null) {
        e.dryKg = round(e.unit === 'litre' ? e.quantity * density * e.drc / 100 : e.quantity * e.drc / 100);
      } else e.dryKg = null;
    } else if (isKgCat(e.category)) {
      if (!e.unit && e.quantity != null) e.unit = 'kg';
      e.dryKg = e.unit === 'kg' && e.quantity != null ? round(e.quantity) : null;
    } else {
      e.dryKg = null;
    }
    if (e.type !== 'Production') {
      const base = isLatexCat(e.category) ? e.dryKg : e.quantity;
      if (changed !== 'amount' && e.rate != null && base != null && (e.amount == null || ['rate', 'quantity', 'drc', 'unit'].includes(changed))) {
        e.amount = round(base * e.rate, 0);
      } else if (e.amount != null && e.rate == null && base) {
        e.rate = round(e.amount / base);
      }
    }
    e.month = e.date ? e.date.slice(0, 7) : '';
    e.fy = financialYear(e.date);
    e.flags = validate(e);
    return e;
  }

  function validate(e) {
    const f = [];
    if (!e.type) f.push('type');
    if (!e.category || e._guessedCategory) f.push('category');
    if (e.type && e.type !== 'Production' && !(e.amount > 0)) f.push('amount');
    if (e.type === 'Production' && !(e.quantity > 0)) f.push('quantity');
    if (isLatexCat(e.category) && e.drc == null) f.push('drc');
    if (!e.date) f.push('date');
    return f;
  }

  // ---------- main entry parser ----------
  function parse(raw, ctx) {
    ctx = Object.assign({ density: 1, workers: [], today: new Date() }, ctx || {});
    const today = ctx.today instanceof Date ? ctx.today : new Date(ctx.today);
    const e = { type: null, category: null, quantity: null, unit: null, drc: null, dryKg: null, rate: null, amount: null,
      party: '', paymentMode: '', date: null, notes: '', voiceText: String(raw || '').trim() };
    const t0 = normalize(raw);
    let t = t0;

    // worker names (match before anything is removed)
    let worker = null;
    for (const w of ctx.workers || []) {
      if (!w || !w.name || w.active === false || w.active === 'No') continue;
      const re = new RegExp('\\b' + w.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      if (re.test(t)) { worker = w; t = t.replace(re, ' '); break; }
    }

    // date
    const d = takeDate(t, today); e.date = d.date; t = d.text;

    // payment mode
    let m = t.match(/\b(?:by |via |in |through )?(cash|upi|g ?pay|google pay|phone ?pe|paytm|bank transfer|bank|transfer|neft|cheque|check|credit)\b/);
    if (m) {
      const p = m[1];
      e.paymentMode = p === 'cash' ? 'Cash' : /upi|pay|pe|paytm/.test(p) ? 'UPI' : p === 'credit' ? 'Credit' : 'Bank';
      t = t.replace(m[0], ' ');
    }

    // DRC
    m = t.match(/\b(?:drc|d r c|dry rubber content|dry rubber)\s*(?:of |is |at |was )?(\d+(?:\.\d+)?)\s*(?:percent)?/) ||
        t.match(/(\d+(?:\.\d+)?)\s*percent(?:\s*(?:drc|d r c))?/);
    if (m) { e.drc = parseFloat(m[1]); t = t.replace(m[0], ' '); }

    // quantity + unit
    m = t.match(UNIT_RE);
    if (m) { e.quantity = parseFloat(m[1]); e.unit = unitOf(m[2]); t = t.replace(m[0], ' '); }

    // rate
    m = t.match(/\b(?:at|@|rate(?: of)?|price(?: of)?)\s*(?:rs\s*|rupees\s*)?(\d+(?:\.\d+)?)(?:\s*(?:rs|rupees))?(?:\s*(?:per|a|each|for each)\s*(?:kg|kilo|litre|liter|bag|day|sheet|unit|one))?/) ||
        t.match(/(?:rs\s*)?(\d+(?:\.\d+)?)\s*(?:rs|rupees)?\s*(?:each|per\s+(?:kg|kilo|litre|liter|bag|day|sheet|unit|piece)|a\s+(?:kg|kilo|bag|day|litre|liter|sheet))\b/);
    if (m) { e.rate = parseFloat(m[1]); t = t.replace(m[0], ' '); }

    // explicit amount
    m = t.match(/\b(?:for|total|amount|of|rs|rupees)\s*(?:rs\s*|rupees\s*)?(\d+(?:\.\d+)?)/) || t.match(/(\d+(?:\.\d+)?)\s*(?:rs|rupees)\b/);
    if (m) { e.amount = parseFloat(m[1]); t = t.replace(m[0], ' '); }

    // type & category (decided on the full normalised text)
    const has = re => re.test(t0);
    const product = has(PRODUCT.sheet) ? 'sheet' : has(PRODUCT.scrap) ? 'scrap' : has(PRODUCT.lump) ? 'lump' : has(PRODUCT.latex) ? 'latex' : null;
    const expenseRule = EXPENSE_RULES.find(([, re]) => re.test(t0));
    if (has(SALE_W) || has(/\bsubsidy\b/)) {
      e.type = 'Income';
      e.category = has(/\bsubsidy\b/) ? 'Subsidy' : product === 'sheet' ? 'Sheet sale' :
        (product === 'scrap' || product === 'lump') ? 'Scrap sale' : product === 'latex' ? 'Latex sale' : 'Other income';
    } else if (worker || has(EXPENSE_W) || (expenseRule && !product)) {
      e.type = 'Expense';
      if (expenseRule) e.category = expenseRule[0];
      else if (worker) e.category = /tap/i.test(worker.role || '') ? 'Tapping wages' : 'Weeding/labour';
      else { e.category = 'Miscellaneous'; e._guessedCategory = !has(/\bmisc(ellaneous)?\b|\bother\b/); }
    } else if (product || has(PROD_W)) {
      e.type = 'Production';
      e.category = product === 'sheet' ? 'Sheet rubber' : product === 'scrap' ? 'Scrap / ottupal' : product === 'lump' ? 'Cup lump' : 'Latex';
    }

    // leftover bare numbers
    const rest = (t.match(/\b\d+(?:\.\d+)?\b/g) || []).map(parseFloat);
    if (rest.length) {
      if (e.type === 'Production' || (!e.type && product)) {
        if (e.quantity == null) e.quantity = rest[0];
        if (!e.type) { e.type = 'Production'; e.category = e.category || 'Latex'; }
      } else if (e.amount == null) {
        if (e.type === 'Income' && e.quantity == null && rest.length >= 2 && product) {
          e.quantity = rest[0]; e.amount = rest[rest.length - 1];
        } else {
          e.amount = rest[rest.length - 1];
        }
        if (!e.type) { e.type = 'Expense'; e.category = 'Miscellaneous'; e._guessedCategory = true; }
      }
    }

    if (worker) {
      e.party = worker.name;
      if (e.amount == null && e.rate == null && worker.rate) {
        const days = e.unit === 'days' && e.quantity ? e.quantity : 1;
        e.rate = +worker.rate; e.amount = round(days * +worker.rate, 0);
      }
    } else {
      m = t.match(/\b(?:to|from|paid to)\s+(?:the\s+|mr\s+|mrs\s+)?([a-z][a-z' ]*?)(?=\s+(?:at|for|on|by|via|in|rs|and|with|drc|today|yesterday)\b|\s*\d|\s*$)/);
      if (m) {
        const name = m[1].trim().replace(/\b(latex|sheet|sheets|rubber|scrap|kg|litre|liters?|litres?)\b/g, '').trim();
        if (name && name.length > 1 && !/^(day|the|a|an)$/.test(name)) e.party = titleCase(name);
      }
    }
    return recompute(e, ctx);
  }

  // ---------- commands ----------
  const FIELD_ALIASES = { amount: 'amount', total: 'amount', rate: 'rate', price: 'rate', quantity: 'quantity', qty: 'quantity',
    party: 'party', name: 'party', worker: 'party', buyer: 'party', date: 'date', drc: 'drc', category: 'category',
    unit: 'unit', payment: 'paymentMode', mode: 'paymentMode', notes: 'notes', note: 'notes' };

  function parseCommand(raw) {
    const t = normalize(raw).replace(/^(please|okay so|ok so|hey)\s+/, '').trim();
    let m;
    if (/^(delete|cancel|remove|discard|scratch that|wrong|no)(\s+(it|this|that|entry|this entry|that entry))?$/.test(t)) return { cmd: 'delete' };
    if ((m = t.match(/^(?:delete|remove)\s+(?:the\s+)?last(?:\s+(\d+))?(?:\s+(?:entry|entries|one|ones))?$/))) return { cmd: 'deleteLast', n: m[1] ? Math.min(+m[1], 20) : 1 };
    if ((m = t.match(/^(?:delete|clear|remove)\s+(?:the\s+)?(amount|total|rate|price|quantity|qty|party|name|worker|buyer|date|drc|category|unit|payment|mode|notes?)$/))) return { cmd: 'deleteField', field: FIELD_ALIASES[m[1]] };
    if (/^(save|save it|ok|okay|yes|confirm|done|correct|right)$/.test(t)) return { cmd: 'save' };
    if ((m = t.match(/^(?:change|set|make|correct)\s+(?:the\s+)?(amount|total|rate|price|quantity|qty|party|name|worker|buyer|date|drc|category|unit|payment|mode|notes?)\s+(?:to|as|is|=)?\s*(.+)$/))) return { cmd: 'set', field: FIELD_ALIASES[m[1]], value: m[2].trim() };
    if (/^undo$/.test(t)) return { cmd: 'undo' };
    if (/^(stop|close|exit|stop listening)$/.test(t)) return { cmd: 'stop' };
    return null;
  }

  function matchCategory(value, type) {
    const v = normalize(value);
    const lists = type ? [CATEGORIES[type] || []] : Object.values(CATEGORIES);
    for (const list of lists) for (const c of list) if (c.toLowerCase().startsWith(v) || v.includes(c.toLowerCase().split(/[ /&]/)[0])) return c;
    const rule = EXPENSE_RULES.find(([, re]) => re.test(v));
    return rule ? rule[0] : null;
  }

  function typeOfCategory(cat) {
    for (const [type, list] of Object.entries(CATEGORIES)) if (list.includes(cat)) return type;
    return null;
  }

  // Apply a "change X to Y" / "delete X" command to an entry.
  function applyField(e, field, value, ctx) {
    ctx = Object.assign({ density: 1, today: new Date() }, ctx || {});
    const today = ctx.today instanceof Date ? ctx.today : new Date(ctx.today);
    if (value == null || value === '') {
      e[field] = ['party', 'notes', 'paymentMode'].includes(field) ? '' : null;
      if (field === 'category') e.category = null;
    } else if (['amount', 'rate', 'quantity', 'drc'].includes(field)) {
      const n = (normalize(value).match(/\d+(?:\.\d+)?/) || [])[0];
      e[field] = n != null ? parseFloat(n) : null;
    } else if (field === 'date') {
      e.date = takeDate(normalize(value), today).date;
    } else if (field === 'category') {
      const c = matchCategory(value, null);
      if (c) { e.category = c; e.type = typeOfCategory(c); delete e._guessedCategory; }
    } else if (field === 'unit') {
      const m = ('1 ' + normalize(value)).match(UNIT_RE); if (m) e.unit = unitOf(m[2]);
    } else if (field === 'paymentMode') {
      const p = normalize(value);
      e.paymentMode = /cash/.test(p) ? 'Cash' : /upi|pay|pe/.test(p) ? 'UPI' : /credit/.test(p) ? 'Credit' : /bank|transfer|neft|cheque/.test(p) ? 'Bank' : e.paymentMode;
    } else {
      e[field] = titleCase(String(value).trim());
    }
    return recompute(e, ctx, field);
  }

  // While dictating, the spoken word "delete" removes the word before it ("40 kg delete 50 kg" → "40 50 kg").
  // A "delete" with no word before it is kept, so "delete", "delete last 3", "delete amount" still work as commands.
  function applySpokenDeletes(text) {
    const out = [];
    for (const w of String(text || '').split(/\s+/).filter(Boolean)) {
      if (/^delete[.,!?]*$/i.test(w) && out.length && !/^delete[.,!?]*$/i.test(out[out.length - 1])) out.pop();
      else out.push(w);
    }
    return out.join(' ');
  }

  const api = { parse, parseCommand, applySpokenDeletes, applyField, recompute, validate, normalize, wordsToNumbers, financialYear,
    isoDate, CATEGORIES, WAGE_CATEGORIES, UNITS, PAYMENT_MODES, typeOfCategory };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RubberParser = api;
})(typeof self !== 'undefined' ? self : this);
