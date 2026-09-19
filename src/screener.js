/*
 * Скринер пулов: топ токенов сети по обороту, разобранный для LP.
 *
 * Разбирает по одному токену за раз: у GeckoTerminal лимит ~30 запросов в
 * минуту, а у OrbitFlare — 10 в секунду. Строки появляются по мере разбора,
 * ждать весь топ не нужно.
 */
(() => {
  'use strict';
  const CHAIN = 'robinhood';
  const $ = (id) => document.getElementById(id);
  const ask = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); }); }
    catch (e) { res(null); }
  });

  const money = (v) => {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const a = Math.abs(v);
    return (v < 0 ? '−' : '') + '$' + (a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(0));
  };
  const pct = (v, d = 0) => (isFinite(v) ? (v > 0 ? '+' : '') + Number(v).toFixed(d) + '%' : '—');
  const cls = (v) => (!isFinite(v) ? 'd' : v < 0 ? 'r' : 'g');
  const age = (ms) => {
    if (!ms) return '';
    const h = (Date.now() - ms) / 3600000;
    return h < 1 ? Math.round(h * 60) + 'м' : h < 48 ? Math.round(h) + 'ч' : Math.round(h / 24) + 'д';
  };
  const RISK = { 'падает': 3, 'штормит': 2, 'улетел': 2, 'спокойно': 0, 'нет данных': 1 };

  let rows = [];
  let hist = {};
  let sortKey = 'yield1';
  let sortDir = -1;
  let busy = false;

  /** Сколько людям было залито сутки назад (±3 часа) — по накопленной истории. */
  function dayAgo(addr) {
    const list = hist[CHAIN + ':' + addr] || [];
    const want = Date.now() - 24 * 3600000;
    let best = null;
    for (const p of list) {
      if (Math.abs(p.t - want) > 3 * 3600000) continue;
      if (!best || Math.abs(p.t - want) < Math.abs(best.t - want)) best = p;
    }
    return best;
  }

  function render() {
    const hideFall = $('hideFall').checked;
    const minNear = Number($('minNear').value) || 0;
    const list = rows.filter((r) => r.ok && (!hideFall || r.risk !== 'падает')
      && (r.near === null || r.near >= minNear));
    const val = (r) => (sortKey === 'best' ? (r.best && r.best[0] ? r.best[0].fees24 : 0)
      : sortKey === 'symbol' ? r.symbol : r[sortKey]);
    list.sort((a, b) => {
      const x = val(a); const y = val(b);
      if (typeof x === 'string') return sortDir * String(x).localeCompare(String(y));
      return sortDir * ((isFinite(x) ? x : -Infinity) - (isFinite(y) ? y : -Infinity));
    });
    const tb = $('rows');
    tb.textContent = '';
    for (const r of list) {
      const tr = document.createElement('tr');
      const prev = dayAgo(r.addr);
      const grow = prev ? r.tvlPeople - prev.people : null;
      const yc = r.yield1 === null || r.thin ? 'd' : r.yield1 >= 0.005 ? 'g' : r.yield1 >= 0.001 ? 'y' : 'd';
      const rc = { 'падает': 'r', 'штормит': 'y', 'улетел': 'y', 'спокойно': 'g' }[r.risk] || 'd';
      const best = r.best && r.best[0];
      tr.innerHTML = ''
        // Хвост адреса: одноимённых копий много (два BLAST, два TWINE).
        + '<td><a target="_blank" href="https://gmgn.ai/robinhood/token/' + r.addr + '">' + esc(r.symbol || r.addr.slice(0, 8)) + '</a>'
          + ' <span class="d">…' + r.addr.slice(-4) + ' · ' + age(r.created) + '</span></td>'
        + '<td class="' + yc + '">' + (r.yield1 === null ? '—' : r.thin ? 'пусто' : (r.yield1 * 100).toFixed(2) + '%') + '</td>'
        + '<td><div class="two">' + money(r.fees1) + '<small>' + money(r.fees24) + '</small></div></td>'
        + '<td>' + money(r.near) + '</td>'
        + '<td><div class="two">' + money(r.tvlPeople) + '<small class="' + (grow === null ? 'd' : grow >= 0 ? 'g' : 'r') + '">'
          + (grow === null ? 'истории нет' : (grow >= 0 ? '+' : '') + money(grow)) + '</small></div></td>'
        + '<td class="d">' + money(r.tvlLaunchpad) + '</td>'
        + '<td><div class="two">' + money(r.vol1) + '<small>' + money(r.vol24) + '</small></div></td>'
        + '<td><span class="' + cls(r.h1) + '">' + pct(r.h1) + '</span> · <span class="' + cls(r.h6) + '">' + pct(r.h6)
          + '</span> · <span class="' + cls(r.h24) + '">' + pct(r.h24) + '</span></td>'
        + '<td class="' + rc + '">' + esc(r.risk || '') + '</td>'
        + '<td>' + (best ? esc(best.name.replace(/^[^/]+\/\s*/, '')) + (best.kind === 'ladder' ? ' <span class="d">LL</span>' : '')
          + ' <span class="d">' + money(best.fees24) + '/сут</span>' : '—') + '</td>';
      tb.appendChild(tr);
    }
    summary();
  }

  function summary() {
    const done = rows.filter((r) => r.ok);
    if (!done.length) { $('sum').textContent = ''; return; }
    const people = done.reduce((a, r) => a + (r.tvlPeople || 0), 0);
    const near = done.reduce((a, r) => a + (r.near || 0), 0);
    const fees1 = done.reduce((a, r) => a + (r.fees1 || 0), 0);
    let then = 0; let nowBoth = 0; let n = 0;
    for (const r of done) {
      const p = dayAgo(r.addr);
      if (p) { then += p.people; nowBoth += r.tvlPeople || 0; n++; }
    }
    $('sum').innerHTML = 'Разобрано <b>' + done.length + '</b> токенов · люди залили <b>' + money(people) + '</b>'
      + ' · у цены <b>' + money(near) + '</b> · фисы людям за час <b>' + money(fees1) + '</b>'
      + (n ? ' · у ' + n + ' токенов с историей за сутки: ' + money(then) + ' → <b>' + money(nowBoth) + '</b> ('
        + pct((nowBoth / then - 1) * 100) + ')' : ' · динамика появится, когда скринер наберёт историю');
  }

  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function go() {
    if (busy) return;
    busy = true;
    $('go').disabled = true;
    const want = Number($('count').value) || 40;
    $('status').textContent = 'беру топ токенов…';
    const top = await ask({ type: 'lpTop', chain: CHAIN, pages: Math.ceil(want / 8) });
    if (!top || !top.ok) {
      $('status').textContent = 'топ не получен: ' + ((top && top.error) || 'воркер не ответил');
      busy = false; $('go').disabled = false;
      return;
    }
    const h = await ask({ type: 'lpHistory' });
    hist = (h && h.hist) || {};
    const tokens = top.tokens.slice(0, want);
    const stocks = top.stocks ? ' · акций убрано ' + top.stocks : '';
    rows = [];
    // Три токена в работе сразу: пока один ждёт очередь GeckoTerminal (она
    // общая, в воркере), другие читают глубину из цепи. Раньше — по одному
    // и с паузой 1.8 с после каждого.
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < tokens.length) {
        const t = tokens[next++];
        const r = await ask({ type: 'lpScan', chain: CHAIN, addr: t.addr });
        rows.push({ ...(r || { ok: false }), addr: t.addr, symbol: t.symbol, created: t.created,
                    riskRank: r && r.ok ? RISK[r.risk] : 9 });
        done++;
        $('status').textContent = 'разобрано ' + done + ' из ' + tokens.length + stocks;
        render();
      }
    };
    $('status').textContent = 'разбираю ' + tokens.length + ' токенов' + stocks + '…';
    await Promise.all([worker(), worker(), worker()]);
    const failed = rows.filter((r) => !r.ok).length;
    $('status').textContent = 'готово: ' + rows.length + ' токенов' + stocks + (failed ? ', не разобралось ' + failed : '')
      + ' · ' + new Date().toLocaleTimeString().slice(0, 5);
    busy = false;
    $('go').disabled = false;
  }

  document.querySelector('thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-k]');
    if (!th) return;
    const k = th.dataset.k;
    if (k === sortKey) sortDir = -sortDir; else { sortKey = k; sortDir = k === 'symbol' ? 1 : -1; }
    for (const x of document.querySelectorAll('th')) {
      x.classList.toggle('on', x.dataset.k === sortKey);
      x.textContent = x.textContent.replace(/ [▾▴]$/, '') + (x.dataset.k === sortKey ? (sortDir < 0 ? ' ▾' : ' ▴') : '');
    }
    render();
  });
  $('go').addEventListener('click', go);
  $('hideFall').addEventListener('change', render);
  $('minNear').addEventListener('change', render);
})();
