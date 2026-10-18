(function () {
  'use strict';

  const money = new Intl.NumberFormat('uk-UA', { style: 'currency', currency: 'USD' });
  const monthName = new Intl.DateTimeFormat('uk-UA', { month: 'long', year: 'numeric' });
  const monthShort = new Intl.DateTimeFormat('uk-UA', { month: 'short' });
  const $ = (id) => document.getElementById(id);
  const fmt = (cents) => money.format(cents / 100);

  let rows = [];
  let sort = { key: 'date', dir: 1 };
  let openNote = null;

  /* Перевірені розбіжності зберігаються в браузері, щоб не губились після перезавантаження */
  const keyOf = (r) => r.date + '|' + r.investor + '|' + r.product;
  let checks = {};
  try { checks = JSON.parse(localStorage.getItem('payouts-checks') || '{}'); } catch (e) { checks = {}; }
  function saveChecks() { try { localStorage.setItem('payouts-checks', JSON.stringify(checks)); } catch (e) {} }

  /* ---------- Дані ---------- */

  /* Усі суми зберігаємо в центах (цілі числа), щоб не було похибок округлення */
  function toCents(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  }

  function normalize(r) {
    const amount = toCents(r.amount);
    const rate = Number(String(r.rate).replace(',', '.'));
    const expected = Math.round(amount * rate / 1200);
    const paid = toCents(r.paid);
    const status = paid === null ? 'wait' : (paid === expected ? 'ok' : 'bad');
    return {
      date: String(r.date).trim(),
      month: String(r.date).trim().slice(0, 7),
      investor: String(r.investor).trim(),
      product: String(r.product).trim(),
      amount, rate, expected, paid, status
    };
  }

  function validate(r) {
    const errs = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date).trim())) errs.push('дата не у форматі РРРР-ММ-ДД');
    if (!String(r.investor || '').trim()) errs.push('немає інвестора');
    if (!(toCents(r.amount) > 0)) errs.push('сума вкладу не число');
    if (!(Number(String(r.rate).replace(',', '.')) > 0)) errs.push('ставка не число');
    const p = toCents(r.paid);
    if (Number.isNaN(p)) errs.push('виплата не число');
    return errs;
  }

  /* ---------- CSV ---------- */

  const COLUMNS = ['date', 'investor', 'product', 'amount', 'rate', 'paid'];

  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0];
    const delim = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';
    const out = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); out.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); out.push(row); }
    return out.filter((r) => r.some((c) => c.trim() !== ''));
  }

  function importCSV(text) {
    const table = parseCSV(text);
    if (!table.length) return toast('Файл порожній');
    const header = table[0].map((h) => h.trim().toLowerCase());
    const missing = COLUMNS.filter((c) => !header.includes(c));
    if (missing.length) return toast('Не вистачає колонок: ' + missing.join(', ') + '. Подивіться приклад CSV');

    const good = [], bad = [];
    table.slice(1).forEach((cells, i) => {
      const r = {};
      COLUMNS.forEach((c) => { r[c] = cells[header.indexOf(c)] ?? ''; });
      const errs = validate(r);
      if (errs.length) bad.push('рядок ' + (i + 2) + ': ' + errs[0]);
      else good.push(normalize(r));
    });
    if (!good.length) return toast('Не вдалося прочитати жодного рядка. ' + bad.slice(0, 2).join('; '));
    rows = good;
    fillFilters();
    render();
    toast('Завантажено ' + good.length + ' ' + plural(good.length, 'рядок', 'рядки', 'рядків') + (bad.length ? ', пропущено ' + bad.length + ' (' + bad.slice(0, 2).join('; ') + ')' : ''));
  }

  function toCSV(list) {
    const esc = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
    const lines = [COLUMNS.join(',')];
    list.forEach((r) => lines.push([
      r.date, r.investor, r.product, (r.amount / 100).toFixed(2), r.rate,
      r.paid === null ? '' : (r.paid / 100).toFixed(2)
    ].map(esc).join(',')));
    return '﻿' + lines.join('\n');
  }

  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- Фільтри ---------- */

  function fillFilters() {
    const months = [...new Set(rows.map((r) => r.month))].sort();
    const products = [...new Set(rows.map((r) => r.product))].sort();
    $('fMonth').innerHTML = '<option value="">Увесь період</option>' +
      months.map((m) => `<option value="${m}">${cap(monthName.format(new Date(m + '-01')))}</option>`).join('');
    $('fProduct').innerHTML = '<option value="">Усі продукти</option>' +
      products.map((p) => `<option>${escapeHTML(p)}</option>`).join('');
  }

  function filtered(ignoreStatus) {
    const f = Object.fromEntries(new FormData($('filters')));
    const q = (f.q || '').trim().toLowerCase();
    return rows.filter((r) =>
      (!f.month || r.month === f.month) &&
      (!f.product || r.product === f.product) &&
      (ignoreStatus || !f.status || r.status === f.status) &&
      (!q || r.investor.toLowerCase().includes(q)));
  }

  /* ---------- Рендер ---------- */

  function render() {
    renderRecon(filtered(true));
    renderTotals(filtered(true));
    renderChart(filtered(true));
    renderTable(filtered(false));
  }

  function renderRecon(list) {
    const c = { ok: 0, bad: 0, wait: 0 };
    list.forEach((r) => c[r.status]++);
    const done = c.ok + c.bad;
    const months = [...new Set(list.map((r) => r.month))].sort();
    $('periodLabel').textContent = months.length > 1
      ? cap(monthName.format(new Date(months[0] + '-01')) + ' – ' + monthName.format(new Date(months[months.length - 1] + '-01')))
      : months.length ? cap(monthName.format(new Date(months[0] + '-01'))) : '';

    const open = list.filter((r) => r.status === 'bad' && !checks[keyOf(r)]).length;
    let title;
    if (!list.length) title = 'За цими фільтрами виплат немає';
    else if (c.bad === 0) title = `Усі ${done} виплат зійшлися`;
    else title = `<span class="n-ok">${c.ok}</span> з ${done} виплат зійшлися. ` +
      (open ? `Перевірити треба <span class="n-bad">${open}</span>` : 'Усі розбіжності перевірені');
    if (list.length && c.wait) title += `. Ще не виплачено: ${c.wait}`;
    $('reconTitle').innerHTML = title;

    const total = list.length || 1;
    $('reconBar').innerHTML = ['ok', 'bad', 'wait'].filter((k) => c[k]).map((k) => `<span class="${k}" style="flex:${c[k] / total}"></span>`).join('');
    $('reconBar').setAttribute('aria-label', `Зійшлося ${c.ok}, розбіжностей ${c.bad}, очікує ${c.wait}`);

    const issues = list.filter((r) => r.status === 'bad')
      .sort((a, b) => (!!checks[keyOf(a)]) - (!!checks[keyOf(b)]));
    $('issues').innerHTML = issues.length
      ? issues.map((r) => {
          const k = keyOf(r), d = r.paid - r.expected, ch = checks[k];
          const what = `<button type="button" class="issue-link" data-show="${escapeHTML(k)}"><b>${escapeHTML(r.investor)}</b>, ${monthName.format(new Date(r.month + '-01'))}: нараховано ${fmt(r.expected)}, виплачено ${fmt(r.paid)}</button>`;
          const delta = `<span class="delta">${d > 0 ? 'переплата' : 'недоплата'} ${fmt(Math.abs(d))}</span>`;
          if (ch) return `<li class="checked"><span>${what}<small>Перевірено${ch.note ? ': ' + escapeHTML(ch.note) : ''}</small></span><span class="issue-side">${delta}<button type="button" class="mini" data-uncheck="${escapeHTML(k)}">Скасувати</button></span></li>`;
          if (openNote === k) return `<li><span>${what}</span><form class="note-form" data-key="${escapeHTML(k)}"><input name="note" placeholder="Що з'ясували, наприклад: доплатили 12.10" aria-label="Коментар" autocomplete="off"><button class="mini solid">Зберегти</button><button type="button" class="mini" data-cancel>Скасувати</button></form></li>`;
          return `<li><span>${what}</span><span class="issue-side">${delta}<button type="button" class="mini" data-check="${escapeHTML(k)}">Перевірено</button></span></li>`;
        }).join('')
      : (list.length ? '<li class="all-ok">Розбіжностей немає</li>' : '');
    const f = $('issues').querySelector('.note-form input');
    if (f) f.focus();
  }

  function renderTotals(list) {
    const investors = new Map();
    list.forEach((r) => investors.set(r.investor + '|' + r.product, r.amount));
    const invested = [...investors.values()].reduce((a, b) => a + b, 0);
    const done = list.filter((r) => r.status !== 'wait');
    const expected = done.reduce((a, r) => a + r.expected, 0);
    const paid = done.reduce((a, r) => a + r.paid, 0);
    const diff = paid - expected;
    $('tInvested').textContent = fmt(invested);
    $('tExpected').textContent = fmt(expected);
    $('tPaid').textContent = fmt(paid);
    $('tDiff').textContent = (diff > 0 ? '+' : '') + fmt(diff);
    $('tDiff').className = diff !== 0 ? 'neg' : '';
  }

  function renderChart(list) {
    const byMonth = new Map();
    list.forEach((r) => {
      const m = byMonth.get(r.month) || { exp: 0, paid: 0, gap: 0 };
      m.exp += r.expected;
      /* Різницю рахуємо лише по проведених виплатах, очікувані не вважаються недоплатою */
      if (r.paid !== null) { m.paid += r.paid; m.gap += r.paid - r.expected; }
      byMonth.set(r.month, m);
    });
    const months = [...byMonth.keys()].sort();
    if (!months.length) { $('chart').innerHTML = ''; return; }

    const W = 760, H = 240, padL = 8, padB = 28, top = 26;
    const max = Math.max(...months.map((m) => Math.max(byMonth.get(m).exp, byMonth.get(m).paid)));
    const slot = (W - padL * 2) / months.length;
    const bw = Math.min(34, slot * 0.3);
    const y = (v) => H - padB - (v / max) * (H - padB - top);

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Стовпчики нарахованих і виплачених сум по місяцях">`;
    svg += `<line x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}" stroke="var(--line)"/>`;
    months.forEach((m, i) => {
      const d = byMonth.get(m);
      const cx = padL + slot * i + slot / 2;
      svg += `<rect x="${cx - bw - 2}" y="${y(d.exp)}" width="${bw}" height="${H - padB - y(d.exp)}" rx="3" fill="var(--line)"><title>Нараховано ${fmt(d.exp)}</title></rect>`;
      svg += `<rect x="${cx + 2}" y="${y(d.paid)}" width="${bw}" height="${H - padB - y(d.paid)}" rx="3" fill="var(--ok)"><title>Виплачено ${fmt(d.paid)}</title></rect>`;
      svg += `<text class="lbl" x="${cx}" y="${H - 9}" text-anchor="middle">${monthShort.format(new Date(m + '-01'))}</text>`;
      const gap = d.gap;
      if (gap !== 0) svg += `<text class="gap" x="${cx}" y="${Math.min(y(d.exp), y(d.paid)) - 8}" text-anchor="middle">${gap > 0 ? '+' : '−'}${fmt(Math.abs(gap))}</text>`;
    });
    $('chart').innerHTML = svg + '</svg>';
  }

  const STATUS = { ok: 'Зійшлося', bad: 'Розбіжність', wait: 'Очікує' };

  function renderTable(list) {
    const k = sort.key;
    list.sort((a, b) => {
      const av = a[k] ?? -1, bv = b[k] ?? -1;
      return (typeof av === 'string' ? av.localeCompare(bv, 'uk') : av - bv) * sort.dir;
    });
    $('tbody').innerHTML = list.map((r) => `
      <tr class="${r.status === 'bad' && !checks[keyOf(r)] ? 'row-bad' : ''}" data-key="${escapeHTML(keyOf(r))}">
        <td>${r.date.split('-').reverse().join('.')}</td>
        <td>${escapeHTML(r.investor)}</td>
        <td>${escapeHTML(r.product)}</td>
        <td class="num">${fmt(r.amount)}</td>
        <td class="num">${String(r.rate).replace('.', ',')}%</td>
        <td class="num">${fmt(r.expected)}</td>
        <td class="num">${r.paid === null ? '' : fmt(r.paid)}</td>
        <td>${r.status === 'bad' && checks[keyOf(r)] ? '<span class="pill done">Перевірено</span>' : `<span class="pill ${r.status}">${STATUS[r.status]}</span>`}</td>
      </tr>`).join('');
    $('empty').hidden = list.length > 0;
    $('rowCount').textContent = list.length + ' ' + plural(list.length, 'рядок', 'рядки', 'рядків');
    document.querySelectorAll('th').forEach((th) => {
      const b = th.querySelector('button');
      if (b && b.dataset.sort === k) th.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    });
  }

  /* ---------- Утиліти ---------- */

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function escapeHTML(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
  }

  /* ---------- Події ---------- */

  $('filters').addEventListener('input', render);
  $('filters').addEventListener('submit', (e) => e.preventDefault());

  document.querySelector('thead').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sort]');
    if (!b) return;
    sort = { key: b.dataset.sort, dir: sort.key === b.dataset.sort ? -sort.dir : 1 };
    renderTable(filtered(false));
  });

  $('issues').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.check) { openNote = t.dataset.check; render(); }
    else if (t.dataset.uncheck) { delete checks[t.dataset.uncheck]; saveChecks(); render(); }
    else if (t.hasAttribute('data-cancel')) { openNote = null; render(); }
    else if (t.dataset.show) showInTable(t.dataset.show);
  });
  $('issues').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    checks[form.dataset.key] = { note: form.note.value.trim(), at: new Date().toISOString() };
    saveChecks();
    openNote = null;
    render();
    toast('Позначено як перевірене');
  });

  /* Показати рядок розбіжності в таблиці: ставимо фільтр на інвестора й підсвічуємо рядок */
  function showInTable(k) {
    const [date, investor] = k.split('|');
    $('fMonth').value = date.slice(0, 7);
    $('fProduct').value = '';
    $('fStatus').value = '';
    $('fQuery').value = investor;
    render();
    const row = [...document.querySelectorAll('#tbody tr')].find((tr) => tr.dataset.key === k);
    $('tableTitle').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
  }

  $('csvInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then(importCSV);
    e.target.value = '';
  });

  $('sampleBtn').addEventListener('click', () => download('vyplaty-pryklad.csv', toCSV(window.SAMPLE_ROWS.map(normalize))));
  $('exportBtn').addEventListener('click', () => {
    const list = filtered(false);
    download('vyplaty-' + new Date().toISOString().slice(0, 10) + '.csv', toCSV(list));
    toast('Збережено ' + list.length + ' ' + plural(list.length, 'рядок', 'рядки', 'рядків'));
  });

  /* ---------- Старт ---------- */

  rows = window.SAMPLE_ROWS.map(normalize);
  fillFilters();
  render();
})();
