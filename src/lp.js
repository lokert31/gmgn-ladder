/*
 * Карточка «LP» на GMGN: стоит ли лить и куда.
 *
 * Открыл токен — карточка спросила воркер: пулы (GeckoTerminal), чьи они
 * (цепь), сколько ликвидности людей у цены (цепь). Главная цифра —
 * доходность у цены за последний час; рядом риск по движению цены: высокие
 * фисы на падающем токене не спасают (BLAST: +5% фисами, −70% ценой).
 *
 * Три галки: «авторазбор» (считать сразу при открытии токена или только по
 * ⟳), «на графике» (глубина всех пулов токена полосами прямо на графике
 * GMGN) и «в списках» (метка «пулы · оборот» у токенов в трендах).
 * Карточку можно тащить за шапку — место запоминается.
 */
(() => {
  'use strict';
  if (window.top !== window) return;               // во фрейме на Liquidity Ladder места нет
  if (window.__GHO_LP__) return;
  window.__GHO_LP__ = true;

  const KEY = 'ghoLpCard';
  const st = { collapsed: false, lists: false, auto: true, chart: true, pos: null };

  /** Токен из адреса; перед адресом бывает рефкод: /robinhood/token/LbosYDck_0x… */
  function tokenFromPath(path) {
    const m = String(path || '').match(/^\/([a-z0-9_-]+)\/token\/([^/?#]+)/);
    if (!m) return null;
    let seg = m[2];
    try { seg = decodeURIComponent(seg); } catch (e) { /* как есть */ }
    const evm = /0x[0-9a-fA-F]{40}/.exec(seg);
    return evm ? { chain: m[1], addr: evm[0].toLowerCase() } : null;
  }

  const money = (v) => {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const a = Math.abs(v);
    return (v < 0 ? '−' : '') + '$' + (a >= 1e6 ? (a / 1e6).toFixed(2) + 'M'
      : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(0));
  };
  const pct = (v, digits = 0) => (isFinite(v) ? (v > 0 ? '+' : '') + Number(v).toFixed(digits) + '%' : '—');
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const send = (msg, cb) => {
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; if (cb) cb(r); }); }
    catch (e) { if (cb) cb(null); }
  };
  const saveState = () => { try { chrome.storage.local.set({ [KEY]: { ...st } }); } catch (e) { /* контекст ушёл */ } };

  let root = null;
  let current = '';

  /* --------------------------- карточка --------------------------- */
  function build() {
    root = document.createElement('div');
    root.id = 'gho-lp';
    // Блок живёт внутри плашки «Топ-холдеры», а не поверх страницы: любая
    // отдельная плавающая карточка на GMGN на что-нибудь да наезжала.
    root.style.cssText = 'position:static;color:#e6edf3;border-bottom:1px solid #262b38;'
      + 'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;';
    root.innerHTML = '<div data-r="head" '
      + 'style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid #2b3240;user-select:none">'
      + '<b style="color:#34d399">LP</b><span data-r="title" style="flex:1;color:#9aa4b2">пулы</span>'
      + '<span data-r="top" title="Топ токенов по доходности для LP — отдельной вкладкой" style="cursor:pointer;color:#60a5fa">топ ↗</span>'
      + '<span data-r="again" title="Пересчитать" style="cursor:pointer;color:#9aa4b2">⟳</span>'
      + '<span data-r="fold" title="Свернуть" style="cursor:pointer;color:#9aa4b2">–</span></div>'
      + '<div data-r="opts" style="display:flex;gap:10px;padding:6px 10px;border-bottom:1px solid #2b3240;color:#9aa4b2">'
      + opt('auto', 'авторазбор', 'Считать сразу при открытии токена. Выключено — только по ⟳')
      + opt('chart', 'на графике', 'Глубина всех пулов токена полосами прямо на графике GMGN')
      + opt('lists', 'в списках', 'Метки у токенов в списках GMGN: ликвидность пулов и оборот за сутки')
      + '</div><div data-r="body" style="padding:8px 10px;white-space:pre-wrap;overflow-y:auto;max-height:38vh"></div>';
    place();

    for (const k of ['auto', 'chart', 'lists']) {
      const box = root.querySelector('[data-r="' + k + '"]');
      box.checked = !!st[k];
      box.addEventListener('change', () => {
        st[k] = box.checked;
        saveState();
        if (k === 'lists' && !st.lists) {
          for (const b of document.querySelectorAll('.gho-lp-tag')) b.remove();
          for (const el of document.querySelectorAll('[data-gho-lp]')) delete el.dataset.ghoLp;
        }
        if (k === 'chart') { if (st.chart) chartNow(true); else chartOff(); }
        if (k === 'auto' && st.auto) { current = ''; scan(false); }
      });
    }
    const head = root.querySelector('[data-r="head"]');
    root.querySelector('[data-r="fold"]').addEventListener('click', (e) => {
      e.stopPropagation(); st.collapsed = !st.collapsed; apply(); saveState();
    });
    root.querySelector('[data-r="again"]').addEventListener('click', (e) => {
      e.stopPropagation(); current = ''; scan(true); chartNow(true);
    });
    root.querySelector('[data-r="top"]').addEventListener('click', (e) => {
      e.stopPropagation(); send({ type: 'openScreener' });
    });
    void head;
    root.addEventListener('keydown', (e) => e.stopPropagation());

  }

  function opt(k, label, title) {
    return '<label title="' + title + '" style="display:flex;align-items:center;gap:3px;cursor:pointer">'
      + '<input data-r="' + k + '" type="checkbox" style="margin:0">' + label + '</label>';
  }

  /**
   * Где блок: внутри плашки «Топ-холдеры», сразу под её шапкой. Шапка и
   * этот блок видны и тогда, когда список холдеров свёрнут. Плашки нет —
   * блок не показываем вовсе: всё то же самое есть в меню расширения.
   */
  function place() {
    if (!root) return;
    const hold = document.getElementById('gho-panel');
    if (!hold) { if (root.parentElement) root.remove(); return; }
    const head = hold.querySelector('.gho-head');
    const want = head ? head.nextSibling : hold.firstChild;
    if (root.parentElement !== hold || (head && root.previousSibling !== head)) hold.insertBefore(root, want);
  }

  function apply() {
    if (!root) return;
    root.querySelector('[data-r="body"]').style.display = st.collapsed ? 'none' : '';
    root.querySelector('[data-r="opts"]').style.display = st.collapsed ? 'none' : 'flex';
    root.querySelector('[data-r="fold"]').textContent = st.collapsed ? '+' : '–';
  }

  function show(html, title) {
    if (!root) build();
    root.style.display = '';
    root.querySelector('[data-r="body"]').innerHTML = html;
    if (title) root.querySelector('[data-r="title"]').textContent = title;
    apply();
    place();
  }

  const line = (label, value, color) => '<div style="display:flex;justify-content:space-between;gap:8px">'
    + '<span style="color:#9aa4b2">' + label + '</span><span style="color:' + (color || '#e6edf3') + '">' + value + '</span></div>';

  function render(r) {
    if (!r || !r.ok) {
      show('<span style="color:#f87171">' + esc((r && r.error) || 'воркер не ответил') + '</span>');
      return;
    }
    const y = r.yield1;
    const yColor = y === null || r.thin ? '#9aa4b2' : y >= 0.005 ? '#34d399' : y >= 0.001 ? '#fbbf24' : '#9aa4b2';
    const riskColor = { 'падает': '#f87171', 'штормит': '#fbbf24', 'улетел': '#fbbf24', 'спокойно': '#34d399' }[r.risk] || '#e6edf3';
    let html = '';
    html += line('доходность у цены за час', y === null ? 'нет глубины' : r.thin ? 'у цены пусто' : (y * 100).toFixed(2) + '%', yColor);
    html += line('фисы людям: час · сутки', money(r.fees1) + ' · ' + money(r.fees24));
    html += line('ликвидность людей у цены ±10%', r.near === null ? esc(r.nearError || 'нужен RPC в ⚙') : money(r.near));
    html += line('объём: час · сутки', money(r.vol1) + ' · ' + money(r.vol24));
    html += '<div style="height:6px"></div>';
    html += line('пулов', r.pools + ' · люди ' + r.peoplePools + (r.ladderPools ? ' (лесенки LL ' + r.ladderPools + ')' : '')
      + ' · лаунчпад ' + r.launchpadPools);
    html += line('залили люди', money(r.tvlPeople));
    html += line('в пуле лаунчпада', money(r.tvlLaunchpad));
    html += '<div style="height:6px"></div>';
    html += line('цена 1ч · 6ч · 24ч', pct(r.h1) + ' · ' + pct(r.h6) + ' · ' + pct(r.h24));
    html += line('риск', r.risk, riskColor);
    if (Array.isArray(r.best) && r.best.length) {
      html += '<div style="margin-top:6px;color:#9aa4b2">куда лить (фисы за сутки):</div>';
      for (const b of r.best) {
        html += '<div style="display:flex;justify-content:space-between;gap:6px"><span>' + esc(b.name.replace(/^[^/]+\/\s*/, ''))
          + (b.kind === 'ladder' ? ' <span style="color:#9aa4b2">LL</span>' : '') + '</span>'
          + '<span>' + money(b.fees24) + ' · ' + (b.ratio * 100).toFixed(1) + '% TVL</span></div>';
      }
    }
    if (!r.sure) html += '<div style="margin-top:6px;color:#fbbf24">чей пул, не проверено: цепь не ответила</div>';
    html += '<div style="margin-top:6px;color:#6b7280">GeckoTerminal + цепь</div>';
    show(html);
  }

  function scan(force) {
    const t = tokenFromPath(location.pathname);
    if (!t) {
      // Не страница токена — оставляем шапку с галками: с неё включаются
      // метки в списках и открывается топ.
      if (!root) build();
      root.style.display = '';
      root.querySelector('[data-r="body"]').innerHTML = '<span style="color:#9aa4b2">открой токен — будет разбор пулов</span>';
      root.querySelector('[data-r="title"]').textContent = 'пулы';
      apply();
      current = '';
      chartOff();
      return;
    }
    const key = t.chain + ':' + t.addr;
    if (!force && key === current) return;
    current = key;
    chartNow(true);
    if (!force && !st.auto) {
      show('<span style="color:#9aa4b2">авторазбор выключен — жми ⟳</span>', t.addr.slice(0, 6) + '…' + t.addr.slice(-4));
      return;
    }
    show('<span style="color:#9aa4b2">считаю пулы…</span>', t.addr.slice(0, 6) + '…' + t.addr.slice(-4));
    send({ type: 'lpScan', chain: t.chain, addr: t.addr }, (r) => {
      if (current !== key) return;                   // пока считали, открыли другой токен
      render(r);
    });
  }

  /* --------------------------- пулы на графике --------------------------- */
  // Глубина всех пулов токена — тем же рисованием, что и в окне на Liquidity
  // Ladder: полосы ликвидности по уровням цены и накопленные суммы от цены.
  let chartKey = '';
  let chartAt = 0;
  const toPage = (levels) => window.postMessage({ __gho: true, dir: 'to-page', type: 'levels', levels }, location.origin);

  function chartOff() {
    if (!chartKey) return;
    chartKey = '';
    toPage(null);
  }

  // Вкладку открыло окно Liquidity Ladder — туда уже приходит лесенка оттуда,
  // и наша глубина перебивала бы её. Своё окно (другая вкладка GMGN) не в счёт.
  const ladderHost = (() => {
    try { return !!window.opener && window.opener.location.origin !== location.origin; }
    catch (e) { return !!window.opener; }
  })();

  function chartNow(force) {
    const t = tokenFromPath(location.pathname);
    if (ladderHost) return;
    if (!st.chart || !t) { chartOff(); return; }
    const key = t.chain + ':' + t.addr;
    if (!force && key === chartKey && Date.now() - chartAt < 90000) return;
    // Другой токен — старые пулы с графика убираем сразу, не дожидаясь
    // новых: иначе пару секунд на чужом графике висела бы чужая глубина.
    if (key !== chartKey) toPage(null);
    chartKey = key;
    chartAt = Date.now();
    send({ type: 'depth', chain: t.chain, addr: t.addr }, (d) => {
      if (chartKey !== key || !st.chart) return;
      if (!d || !d.ok || !Array.isArray(d.bands) || !d.bands.length) { toPage(null); return; }
      toPage({ positions: [], rungs: [], depth: d.bands, depthPrice: d.price, depthThin: true,
               sizeOff: true, showBounds: false, current: d.price });
    });
  }

  /* --------------------------- метки в списках --------------------------- */
  // Оборот за сутки ÷ ликвидность пулов — сколько раз за сутки ликвидность
  // «прокручивается»: чем больше, тем больше фисов на доллар в пулах.
  const tags = new Map();                // адрес → { reserve, vol24 } | { wait } | { failed }
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0; };

  function rowOf(a) {
    // Строка списка — ближайший широкий предок: по ней не ставим вторую
    // метку, если у строки несколько ссылок на тот же токен.
    let n = a;
    for (let i = 0; i < 6 && n.parentElement; i++) {
      n = n.parentElement;
      if (n.offsetWidth > 260) return n;
    }
    return a.parentElement || a;
  }

  function tag(a, addr, v) {
    const row = rowOf(a);
    if (row.dataset.ghoLp === addr) return;
    row.dataset.ghoLp = addr;
    const turn = v.reserve > 0 ? v.vol24 / v.reserve : 0;
    const color = turn >= 20 ? '#34d399' : turn >= 5 ? '#fbbf24' : '#9aa4b2';
    const b = document.createElement('span');
    b.className = 'gho-lp-tag';
    b.textContent = 'пулы ' + money(v.reserve) + (turn ? ' · об ×' + (turn >= 10 ? turn.toFixed(0) : turn.toFixed(1)) : '');
    b.title = 'Ликвидность пулов ' + money(v.reserve) + ', оборот за сутки ' + money(v.vol24) + ' (GeckoTerminal).\n'
      + (turn ? 'Ликвидность прокручивается ×' + turn.toFixed(1) + ' за сутки: чем больше, тем больше фисов на доллар в пулах.\n' : '')
      + 'Полный разбор — открой токен: там карточка LP.';
    b.style.cssText = 'display:inline-block;margin-left:5px;padding:0 4px;border-radius:4px;background:rgba(52,211,153,.10);'
      + 'color:' + color + ';font:600 10px/16px ui-monospace,Menlo,monospace;vertical-align:middle;white-space:nowrap;';
    a.appendChild(b);
  }

  let listBusy = false;
  function listScan() {
    if (!st.lists || listBusy) return;
    const found = [];
    for (const a of document.querySelectorAll('a[href*="/token/"]')) {
      if (!inView(a)) continue;
      let t = null;
      try { t = tokenFromPath(new URL(a.href, location.origin).pathname); } catch (e) { t = null; }
      if (!t || t.chain !== 'robinhood') continue;
      const v = tags.get(t.addr);
      if (v && v.reserve !== undefined) tag(a, t.addr, v);
      else if (!v || (v.failed && Date.now() - v.failed > 60000)) found.push(t.addr);
    }
    const ask = [...new Set(found)].slice(0, 30);
    if (!ask.length) return;
    listBusy = true;
    for (const a of ask) tags.set(a, { wait: true });
    send({ type: 'lpMulti', chain: 'robinhood', addrs: ask }, (r) => {
      listBusy = false;
      const got = (r && r.tokens) || {};
      // Не отдали — повторим через минуту, а не сразу: иначе при сбое
      // GeckoTerminal метки долбили бы его без паузы.
      for (const a of ask) tags.set(a, got[a] ? got[a] : { failed: Date.now() });
      if (Object.keys(got).length) listScan();
    });
  }

  /* --------------------------- старт --------------------------- */
  try {
    chrome.storage.local.get(KEY, (v) => {
      Object.assign(st, (v && v[KEY]) || {});
      scan(false);
      if (root) for (const k of ['auto', 'chart', 'lists']) root.querySelector('[data-r="' + k + '"]').checked = !!st[k];
    });
  } catch (e) { scan(false); }
  // Меню расширения меняет те же галки — применяем сразу.
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch[KEY] || !ch[KEY].newValue) return;
      const was = { ...st };
      Object.assign(st, ch[KEY].newValue);
      if (root) for (const k of ['auto', 'chart', 'lists']) root.querySelector('[data-r="' + k + '"]').checked = !!st[k];
      apply();
      if (was.chart !== st.chart) { if (st.chart) chartNow(true); else chartOff(); }
      if (was.lists && !st.lists) for (const b of document.querySelectorAll('.gho-lp-tag')) b.remove();
    });
  } catch (e) { /* контекст расширения перезагрузили */ }
  // GMGN — одностраничник: адрес меняется без перезагрузки.
  setInterval(() => { scan(false); chartNow(false); place(); }, 1000);
  setInterval(listScan, 1500);
})();
