/*
 * GMGN Holder Entries — боковая панель (isolated world).
 *
 * Держит UI и настройки (chrome.storage), а всю работу с чартом и API
 * делегирует bridge.js через postMessage: только у него есть доступ
 * к приватным объектам TradingView.
 */
(() => {
  'use strict';

  if (window.__GHO_PANEL__) return;
  window.__GHO_PANEL__ = true;

  /* ------------------------------------------------------------------ *
   * Метка нулевого пула
   *
   * На Robinhood Chain пул с нулевой комиссией заводит лаунчпад, и у него
   * всегда стоит хук. Признак различающий: у токенов, вышедших не через
   * лаунчпад, такого пула нет вовсе. Такие токены часто бандл, но их качают,
   * поэтому метка нужна и в списках, и на самом токене.
   * ------------------------------------------------------------------ */
  // Перед адресом бывает рефкод: /robinhood/token/LbosYDck_0x462d…
  const TOKEN_RE = /^\/([a-z0-9_-]+)\/token\/(?:[A-Za-z0-9]+_)?(0x[0-9a-fA-F]{40})/;
  const zeroSeen = new Map();          // адрес -> ответ или «спрашиваем»
  let zeroQueue = [];
  let zeroBusy = 0;

  function zeroAsk(chain, addr, done) {
    const key = chain + ':' + addr;
    const hit = zeroSeen.get(key);
    if (hit && hit !== 'wait') { done(hit); return; }
    if (hit === 'wait') return;
    zeroSeen.set(key, 'wait');
    zeroQueue.push({ chain, addr, key, done });
    zeroPump();
  }

  function zeroPump() {
    // По три запроса разом: у бойкого токена чтение логов весит мегабайты,
    // а в списке их полсотни — иначе положим и узел, и вкладку.
    while (zeroBusy < 3 && zeroQueue.length) {
      const job = zeroQueue.shift();
      zeroBusy += 1;
      try {
        chrome.runtime.sendMessage(
          { type: 'zeroPool', chain: job.chain, addr: job.addr },
          (r) => {
            zeroBusy -= 1;
            void chrome.runtime.lastError;
            const box = r && r.ok ? r : { has: false, unknown: true };
            zeroSeen.set(job.key, box);
            try { job.done(box); } catch (e) { /* узел мог уйти */ }
            zeroPump();
          },
        );
      } catch (e) {
        zeroBusy -= 1;
        zeroSeen.delete(job.key);
      }
    }
  }

  function zeroBadge(el, box) {
    // Лаунчпадный нулевой пул есть у каждого токена с лаунчпада — метить им
    // всё подряд бессмысленно. Метим только то, что редко и что-то значит:
    // нулевой пул, заведённый руками.
    if (!box || !(Number(box.bare) > 0) || el.dataset.ghoZero === '1') return;
    el.dataset.ghoZero = '1';

    // Нулевой пул лаунчпада — обычная механика запуска. Нулевой пул,
    // заведённый руками, — другое дело: комиссии в нём нет вовсе, и это
    // удобно для прокрутки объёма и бандла. Разные метки, разные цвета.
    const bare = Number(box.bare) || 0;
    const b = document.createElement('span');
    b.textContent = '0% ⚠';
    b.title = 'У токена ' + bare + ' пул(ов) с нулевой комиссией, заведённых руками.\n'
      + 'Комиссии в них нет вовсе — так удобно крутить объём и держать бандл.\n'
      + (box.hooked ? 'Отдельно есть ' + box.hooked + ' пул лаунчпада — это обычная механика.\n' : '')
      + 'Живых нулевых пулов: ' + (box.live || 0) + ' из ' + (box.pools || '?') + ' пулов токена.';
    b.style.cssText = 'display:inline-block;margin-left:5px;padding:0 4px;border-radius:4px;'
      + 'background:rgba(248,113,113,.18);color:#f87171;'
      + 'font:600 10px/16px ui-monospace,Menlo,monospace;vertical-align:middle;';
    el.appendChild(b);
  }

  /** Виден ли элемент на экране: спрашивать про то, чего не видно, незачем. */
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight && r.width > 0;
  };

  function zeroScan() {
    // сам токен страницы
    const here = TOKEN_RE.exec(location.pathname);
    if (here) {
      const head = document.querySelector('h1, [class*="symbol" i]');
      if (head && head.dataset.ghoZero !== '1') {
        zeroAsk(here[1], here[2].toLowerCase(), (box) => zeroBadge(head, box));
      }
    }
    // ссылки в списках
    for (const a of document.querySelectorAll('a[href*="/token/"]')) {
      if (a.dataset.ghoZero === '1' || !inView(a)) continue;
      let m = null;
      try { m = TOKEN_RE.exec(new URL(a.href, location.origin).pathname); } catch (e) { m = null; }
      if (!m) continue;
      zeroAsk(m[1], m[2].toLowerCase(), (box) => zeroBadge(a, box));
    }
  }

  // Панель живёт и внутри фрейма — это оверлей GMGN на Liquidity Ladder.
  // Там места мало и правый край обрезан кропом, поэтому уезжаем влево
  // и стартуем свёрнутыми: главное во фрейме — линии на графике.
  const INFRAME = window.top !== window.self;

  const DEFAULTS = {
    enabled: true,
    minPercent: 0,
    maxPercent: 2,
    limit: 100, // потолок внутреннего API GMGN
    fullWidthLines: false,
    onlyHolding: true,
    autoRefresh: true,
    frameHolders: true,   // линии входа холдеров внутри оверлея на Liquidity Ladder
    refreshSec: 6,
    collapsed: false,
  };

  let config = { ...DEFAULTS };
  let snapshot = { holders: [], ctx: null, loading: false, error: null, tokenInfo: null };
  let els = null;
  const selected = new Set();   // переживает перерисовку при автообновлении

  /* --------------------------- утилиты --------------------------- */
  const shortAddr = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');

  function fmtUsd(v) {
    if (!isFinite(v)) return '—';
    const n = Math.abs(v);
    if (n >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
    if (n >= 1) return `$${v.toFixed(2)}`;
    if (n > 0) return `$${v.toPrecision(3)}`;
    return '—';
  }

  function fmtAgo(ts) {
    if (!ts) return '—';
    const sec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (sec < 3600) return `${Math.floor(sec / 60)}м`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}ч`;
    return `${Math.floor(sec / 86400)}д`;
  }

  function colorForPercent(pct) {
    const t = Math.max(0, Math.min(1, pct / 2));
    const r = Math.round(80 + t * 175);
    const g = Math.round(190 - t * 130);
    const b = Math.round(255 - t * 200);
    return `rgb(${r},${g},${b})`;
  }

  /* --------------------------- мост --------------------------- */
  function send(type, extra = {}) {
    window.postMessage({ __gho: true, dir: 'to-page', type, ...extra }, location.origin);
  }

  // Уровни леддера приходят из оверлея на Liquidity Ladder: он в родительском
  // окне и до bridge.js достучаться сам не может — ретранслируем.
  // Liquidity Ladder шлёт сюда уровни леддера — либо из родительского фрейма,
  // либо из окна-открывателя, если график вынесен отдельным окном браузера.
  // Второй путь основной: встроенную страницу Cloudflare не отдаёт.
  const HOST_ORIGIN = 'https://liquidityladder.it.com';
  // Хозяин — окно Liquidity Ladder: оно встроило нас фреймом или открыло
  // вкладкой. Вкладку GMGN часто открывает другая вкладка GMGN — тогда
  // opener — это gmgn.ai, и отправка ему с адресом Liquidity Ladder сыпала
  // в Chrome ошибками «target origin does not match». Своё окно узнаём по
  // тому, что его адрес читается: чужой origin браузер прочитать не даёт.
  const foreign = (w) => {
    try { return w.location.origin !== location.origin; } catch (e) { return true; }
  };
  const hosts = () => [
    window.parent !== window ? window.parent : null,
    window.opener || null,
  ].filter((w) => w && foreign(w));

  if (hosts().length) {
    // Хозяин не может узнать, доехали ли мы до gmgn.ai: origin ему не виден.
    // Объявляемся сами — до этого он уровни не шлёт.
    const announce = () => {
      for (const w of hosts()) {
        try { w.postMessage({ __ghoLL: true, type: 'ready' }, HOST_ORIGIN); } catch (e) { /* закрыли */ }
      }
    };
    announce();
    setTimeout(announce, 600);
    setTimeout(announce, 1800);
    setTimeout(announce, 4000);

    window.addEventListener('message', (e) => {
      if (e.origin !== HOST_ORIGIN) return;
      if (!hosts().includes(e.source)) return;
      const d = e.data;
      if (!d || d.__ghoLL !== true) return;
      if (d.type === 'levels') { send('levels', { levels: d.levels || null }); return; }
      if (d.type === 'ui') {
        // хозяин просит убрать боковую панель со списком холдеров
        const root = document.getElementById('gho-panel');
        if (root) root.style.display = d.showPanel === false ? 'none' : '';
        // и, отдельно, сами линии входа на свечах
        if (typeof d.holders === 'boolean' && config.enabled !== d.holders) {
          config.enabled = d.holders;
          send('config', { config });
        }
      }
    });
  }

  const storage = (() => {
    try { return (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null; }
    catch { return null; }
  })();

  function pushConfig() {
    send('config', { config });
    if (storage) {
      try { storage.set({ ghoConfig: config }); } catch { /* настройки не критичны */ }
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__gho !== true || d.dir !== 'from-page') return;

    // Подписи запросов GMGN: складываем, чтобы сервис-воркер мог ходить в API
    // сам, когда страницу не удаётся встроить во фрейм на другом сайте.
    if (d.type === 'params') {
      try {
        chrome.storage.local.set({ ghoParams: { params: d.params, savedAt: Date.now() } });
      } catch (e) { /* контекст расширения перезагрузили */ }
      return;
    }

    if (d.type !== 'state') return;

    // Числа из шапки GMGN передаём наверх, окну на Liquidity Ladder: оно
    // сложит их со своей ликвидностью и покажет отдачу пула.
    if (d.head) {
      for (const w of hosts()) {
        try {
          w.postMessage({ __ghoLL: true, type: 'head', head: d.head }, HOST_ORIGIN);
        } catch (e) { /* окно закрыли */ }
      }
    }

    snapshot = {
      holders: d.holders || [],
      ctx: d.ctx,
      loading: d.loading,
      error: d.error,
      tokenInfo: d.tokenInfo,
      outOfHistory: d.outOfHistory || 0,
      lastUpdate: d.lastUpdate || 0,
    };
    renderList();
  });

  /* --------------------------- разметка --------------------------- */
  function build() {
    const root = document.createElement('div');
    root.id = 'gho-panel';
    root.className = [
      (config.collapsed || INFRAME) ? 'gho-collapsed' : '',
      INFRAME ? 'gho-inframe' : '',
    ].filter(Boolean).join(' ');
    root.innerHTML = `
      <div class="gho-head">
        <span class="gho-dot"></span>
        <span class="gho-title">Топ-холдеры</span>
        <span class="gho-count" data-role="count"></span>
        <button class="gho-icon" data-role="refresh" title="Обновить">⟳</button>
        <button class="gho-icon" data-role="toggle" title="Свернуть">–</button>
      </div>
      <div class="gho-body">
        <div class="gho-controls">
          <label class="gho-switch">
            <input type="checkbox" data-role="enabled">
            <span>Метки на графике</span>
          </label>
          <label class="gho-switch">
            <input type="checkbox" data-role="fullwidth">
            <span>Линии через весь график</span>
          </label>
          <label class="gho-switch">
            <input type="checkbox" data-role="autorefresh">
            <span>Автообновление, сек</span>
            <input type="number" min="3" max="120" step="1" data-role="refreshsec" class="gho-num">
          </label>
          <label class="gho-switch">
            <input type="checkbox" data-role="onlyholding">
            <span>Только те, кто ещё держит</span>
          </label>
          <div class="gho-range">
            <span>Доля supply</span>
            <input type="number" step="0.05" min="0" data-role="minp">
            <span>–</span>
            <input type="number" step="0.05" min="0" data-role="maxp">
            <span>%</span>
          </div>
        </div>
        <div class="gho-status" data-role="status"></div>
        <div class="gho-list" data-role="list"></div>
      </div>`;
    document.body.appendChild(root);

    const q = (role) => root.querySelector(`[data-role="${role}"]`);
    els = {
      root,
      list: q('list'),
      status: q('status'),
      count: q('count'),
      enabled: q('enabled'),
      fullwidth: q('fullwidth'),
      autorefresh: q('autorefresh'),
      refreshsec: q('refreshsec'),
      onlyholding: q('onlyholding'),
      minp: q('minp'),
      maxp: q('maxp'),
    };

    els.enabled.checked = config.enabled;
    els.fullwidth.checked = config.fullWidthLines;
    els.autorefresh.checked = config.autoRefresh;
    els.refreshsec.value = config.refreshSec;
    els.onlyholding.checked = config.onlyHolding;
    els.minp.value = config.minPercent;
    els.maxp.value = config.maxPercent;

    q('toggle').addEventListener('click', () => {
      // во фрейме сворачивание локальное: не тащим его на вкладки gmgn.ai
      if (INFRAME) { root.classList.toggle('gho-collapsed'); return; }
      config.collapsed = !config.collapsed;
      root.classList.toggle('gho-collapsed', config.collapsed);
      pushConfig();
    });

    q('refresh').addEventListener('click', () => send('refresh'));

    els.enabled.addEventListener('change', () => {
      config.enabled = els.enabled.checked;
      pushConfig();
    });
    els.fullwidth.addEventListener('change', () => {
      config.fullWidthLines = els.fullwidth.checked;
      pushConfig();
    });
    els.autorefresh.addEventListener('change', () => {
      config.autoRefresh = els.autorefresh.checked;
      pushConfig();
    });
    els.refreshsec.addEventListener('change', () => {
      const v = parseInt(els.refreshsec.value, 10);
      config.refreshSec = isFinite(v) ? Math.max(3, Math.min(120, v)) : 6;
      els.refreshsec.value = config.refreshSec;
      pushConfig();
    });
    els.onlyholding.addEventListener('change', () => {
      config.onlyHolding = els.onlyholding.checked;
      pushConfig();
      renderList();
    });

    const onRange = () => {
      const min = parseFloat(els.minp.value);
      const max = parseFloat(els.maxp.value);
      config.minPercent = isFinite(min) ? min : 0;
      config.maxPercent = isFinite(max) ? max : 2;
      pushConfig();
      renderList();
    };
    els.minp.addEventListener('change', onRange);
    els.maxp.addEventListener('change', onRange);

    // Чарт GMGN ловит горячие клавиши — не отдаём ему ввод из наших полей
    root.addEventListener('keydown', (e) => e.stopPropagation());
  }

  /* --------------------------- список --------------------------- */
  function visibleHolders() {
    return snapshot.holders.filter((h) => {
      // Вышедших показываем недолго даже в режиме "только холдящие":
      // иначе продажа выглядит как молчаливое исчезновение строки
      if (h.exited) return true;
      if (h.percent < config.minPercent || h.percent > config.maxPercent) return false;
      if (config.onlyHolding && h.balance <= 0) return false;
      return true;
    });
  }

  function moveBadge(h) {
    if (!h.changed) return '';
    const d = Number(h.deltaPct) || 0;
    if (h.changed === 'exited') return '<span class="gho-move gho-exit">✕ вышел</span>';
    if (h.changed === 'new') return '<span class="gho-move gho-new">новый</span>';
    if (h.changed === 'sold') return `<span class="gho-move gho-sold">▼ ${d.toFixed(1)}%</span>`;
    if (h.changed === 'bought') return `<span class="gho-move gho-bought">▲ +${d.toFixed(1)}%</span>`;
    return '';
  }

  function renderList() {
    if (!els) return;

    const rows = visibleHolders();
    els.count.textContent = rows.length ? `${rows.length}` : '';

    if (snapshot.error) {
      els.status.className = 'gho-status gho-err';
      els.status.textContent = `Ошибка: ${snapshot.error}`;
    } else if (snapshot.loading && !rows.length) {
      els.status.className = 'gho-status';
      els.status.textContent = 'Загрузка…';
    } else if (!snapshot.ctx) {
      els.status.className = 'gho-status';
      els.status.textContent = 'Откройте страницу токена.';
    } else if (!rows.length) {
      els.status.className = 'gho-status';
      els.status.textContent = 'Никто не попал в заданный диапазон.';
    } else if (snapshot.outOfHistory > 0) {
      // Типичная ситуация на 1s/30s: чарт держит минуты истории, а входы старше
      els.status.className = 'gho-status gho-warnline';
      els.status.textContent =
        `${snapshot.outOfHistory} входов левее загруженной истории — ` +
        'увеличьте таймфрейм, чтобы встали по свечам.';
    } else {
      const when = snapshot.lastUpdate
        ? new Date(snapshot.lastUpdate).toLocaleTimeString()
        : '—';
      els.status.className = 'gho-status gho-hint';
      els.status.textContent = config.autoRefresh
        ? `Обновлено ${when} · каждые ${config.refreshSec} с`
        : `Обновлено ${when} · автообновление выключено`;
    }

    // Перерисовываем только содержимое, чтобы не терять скролл при поллинге
    const scrollTop = els.list.scrollTop;
    els.list.textContent = '';
    const frag = document.createDocumentFragment();

    rows.forEach((h, i) => {
      const row = document.createElement('div');
      row.className = 'gho-row';
      if (h.changed) row.classList.add(`gho-fx-${h.changed}`);
      if (selected.has(h.address)) row.classList.add('gho-sel');
      row.dataset.address = h.address;

      const pnl = h.unrealizedProfit;
      const pnlCls = pnl >= 0 ? 'gho-up' : 'gho-down';
      const noEntry = !h.entryAt || !h.avgCost;

      row.innerHTML = `
        <div class="gho-rank">${i + 1}</div>
        <div class="gho-main">
          <div class="gho-line1">
            <span class="gho-addr">${shortAddr(h.address)}</span>
            ${h.tag ? `<span class="gho-tag">${h.tag}</span>` : ''}
            ${h.isSuspicious ? '<span class="gho-tag gho-warn">susp</span>' : ''}
            ${moveBadge(h)}
          </div>
          <div class="gho-line2">
            вход ${noEntry ? '<span class="gho-dim">нет данных</span>'
              : `${fmtUsd(h.avgCost)}${h.entryIsDerived ? '<span class="gho-dim"> расч.</span>' : ''}
                 <span class="gho-dim">· ${fmtAgo(h.entryAt)} назад</span>`}
          </div>
        </div>
        <div class="gho-right">
          <div class="gho-pct" style="color:${colorForPercent(h.percent)}">${h.percent.toFixed(2)}%</div>
          <div class="gho-pnl ${pnlCls}">${fmtUsd(pnl)}</div>
        </div>`;

      row.addEventListener('click', () => {
        if (selected.has(h.address)) selected.delete(h.address);
        else selected.add(h.address);
        row.classList.toggle('gho-sel');
        send('select', { address: h.address });
      });
      row.addEventListener('mouseenter', () => send('hover', { address: h.address }));
      row.addEventListener('mouseleave', () => send('hover', { address: null }));

      frag.appendChild(row);
    });

    els.list.appendChild(frag);
    els.list.scrollTop = scrollTop;
  }

  /* --------------------------- старт --------------------------- */
  function start() {
    build();
    renderList();
    send('hello');
    send('config', { config });

    // Метки нулевого пула: при прокрутке и переходах список меняется, поэтому
    // просматриваем не разово, а понемногу. Спрашиваем только про то, что
    // видно на экране, и каждый ответ держим сутки.
    let pending = null;
    const later = () => {
      clearTimeout(pending);
      pending = setTimeout(zeroScan, 400);
    };
    zeroScan();
    addEventListener('scroll', later, { passive: true });
    new MutationObserver(later).observe(document.documentElement,
      { childList: true, subtree: true });
  }

  if (storage) {
    // Меню расширения меняет те же настройки — применяем сразу, без перезагрузки.
    try {
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local' || !ch.ghoConfig || !ch.ghoConfig.newValue) return;
        config = { ...DEFAULTS, ...ch.ghoConfig.newValue };
        if (els) {
          els.enabled.checked = config.enabled;
          els.fullwidth.checked = config.fullWidthLines;
          els.onlyholding.checked = config.onlyHolding;
          els.root.classList.toggle('gho-collapsed', !!config.collapsed || INFRAME);
        }
        send('config', { config });
      });
    } catch (e) { /* контекст расширения перезагрузили */ }
    storage.get('ghoConfig', (res) => {
      if (res && res.ghoConfig) config = { ...DEFAULTS, ...res.ghoConfig };
      start();
    });
  } else {
    start();
  }
})();
