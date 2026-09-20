/*
 * Общее меню расширения — все настройки в одном месте.
 *
 * Пишет в те же ключи хранилища, что окно на Liquidity Ladder (llChart),
 * карточка LP (ghoLpCard), плашка холдеров (ghoConfig) и поле RPC (ghoRpc).
 * Каждый из них слушает хранилище и применяет изменения сразу; настройки
 * сторожа воркер выводит из llChart сам.
 */
(() => {
  'use strict';
  // Значения по умолчанию — те же, что у владельцев этих ключей; тест держит
  // их одинаковыми, иначе меню показывало бы не то, что есть на самом деле.
  const DEFAULTS = {
    llChart: { watchOn: false, edgeHi: false, edgeLo: false, edgePct: 5, pumpOn: false, pumpPct: 50,
               windowMin: 5, feesOn: false, minUsd: 5, everySec: 5, keepTabs: true, maxTabs: 0,
               mine: true, bounds: true, depthOn: true, sizeOn: true, holders: true, autoLoad: true },
    ghoLpCard: { auto: true, chart: true, lists: false },
    ghoConfig: { enabled: true, collapsed: false, onlyHolding: true },
    ghoRpc: { robinhood: '', robinhoodState: '' },
  };
  const KEYS = Object.keys(DEFAULTS);
  const ask = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); }); }
    catch (e) { res(null); }
  });
  // Открыто отдельной вкладкой (страница настроек), а не всплывающим окном.
  if (innerWidth > 480) document.body.classList.add('tab');

  let store = {};
  const val = (area, key) => {
    const box = store[area] || {};
    return box[key] !== undefined ? box[key] : DEFAULTS[area][key];
  };

  function fill() {
    for (const el of document.querySelectorAll('[data-s]')) {
      const [area, key] = el.dataset.s.split('.');
      const v = val(area, key);
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v === undefined || v === null ? '' : v;
    }
  }

  // Пишем поверх свежего значения из хранилища, а не из памяти меню:
  // окно на Liquidity Ladder могло поменять тот же объект, пока меню открыто.
  async function write(area, key, value) {
    const cur = await chrome.storage.local.get(area);
    const next = { ...((cur && cur[area]) || {}), [key]: value };
    // Галки края: окно ведёт ещё и старое общее поле — держим его в согласии.
    if (area === 'llChart' && (key === 'edgeHi' || key === 'edgeLo')) {
      next.edgeOn = next.edgeHi === true || next.edgeLo === true;
    }
    await chrome.storage.local.set({ [area]: next });
    store[area] = next;
  }

  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-s]');
    if (!el) return;
    const [area, key] = el.dataset.s.split('.');
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number') { v = Number(el.value); if (!isFinite(v)) return; }
    else v = String(el.value || '').trim();
    write(area, key, v);
  });

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const r = await ask({ type: b.dataset.a });
    if (b.dataset.a !== 'openScreener') state(r && r.ok === false ? r.error : null);
  });

  async function state(extra) {
    const r = await ask({ type: 'watchState' });
    const el = document.getElementById('state');
    if (!r || !r.ok) { el.textContent = 'сторож не отвечает'; el.className = 'warn'; return; }
    const ago = r.lastRun ? Math.round((Date.now() - r.lastRun) / 1000) : null;
    const lines = [ago === null ? 'ещё ни разу не проверял' : 'последняя проверка ' + ago + ' с назад'];
    if (r.error) lines.push(r.error);
    if (r.trouble) lines.push(r.trouble);
    if (extra) lines.push(extra);
    el.textContent = lines.join('\n');
    el.className = r.error || r.trouble ? 'warn' : '';
  }

  (async () => {
    try { store = await chrome.storage.local.get(KEYS); } catch (e) { store = {}; }
    fill();
    try { document.querySelector('[data-k="ver"]').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) { /* нет */ }
    state();
  })();
  // Что поменялось в другом месте (окно, карточка) — сразу видно и тут.
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      let hit = false;
      for (const k of KEYS) if (ch[k]) { store[k] = ch[k].newValue || {}; hit = true; }
      if (hit) fill();
    });
  } catch (e) { /* нет хранилища */ }
})();

/* ---------- журнал ----------
 *
 * Ошибка в фоновой вкладке сторожа или в сервис-воркере иначе не видна
 * никому. Показываем последние записи, даём скопировать их одной кнопкой.
 */
(function () {
  const LOG = window.GHO_LOG;
  const box = document.getElementById('log');
  const level = document.getElementById('loglevel');
  const count = document.getElementById('logcount');
  if (!LOG || !box || !level) return;
  const RANK = { error: 3, warn: 2, info: 1 };

  async function show() {
    const all = await LOG.read();
    const min = level.value === 'error' ? 3 : level.value === 'warn' ? 2 : 1;
    const list = all.filter((r) => (RANK[r.level] || 1) >= min).slice(-200);
    count.textContent = list.length + ' из ' + all.length;
    box.textContent = list.length ? LOG.text(list.slice().reverse()) : 'пусто';
  }

  level.addEventListener('change', show);
  document.getElementById('logcopy').addEventListener('click', async () => {
    const all = await LOG.read();
    try {
      await navigator.clipboard.writeText(LOG.text(all));
      count.textContent = 'скопировано';
    } catch (e) {
      count.textContent = 'не скопировалось: ' + (e && e.message);
    }
  });
  document.getElementById('logclear').addEventListener('click', async () => {
    await LOG.clear();
    show();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LOG.KEY]) show();
  });
  show();
})();

/* ---------- обновление ----------
 *
 * Распакованное расширение Chrome не обновляет сам: человек живёт со старой
 * версией и не знает об этом. Воркер раз в шесть часов спрашивает GitHub,
 * а тут показываем ответ и даём две кнопки — скачать и перезапустить.
 */
(function () {
  const box = document.getElementById('upd');
  const when = document.getElementById('updwhen');
  if (!box || !when) return;
  const ask = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); }); }
    catch (e) { res(null); }
  });

  const ago = (at) => {
    if (!at) return 'ещё не проверял';
    const m = Math.round((Date.now() - at) / 60000);
    if (m < 1) return 'проверил только что';
    if (m < 60) return 'проверил ' + m + ' мин назад';
    return 'проверил ' + Math.round(m / 60) + ' ч назад';
  };

  let url = '';
  function show(r) {
    if (!r || !r.ok) { when.textContent = 'воркер не отвечает'; return; }
    url = r.url || r.page || '';
    box.classList.toggle('on', !!r.fresh);
    if (r.fresh) {
      document.getElementById('updver').textContent = r.ver;
      document.getElementById('updnotes').textContent = r.notes || '';
    }
    when.textContent = (r.err ? r.err + ' · ' : '')
      + (r.fresh ? 'у тебя ' + r.have : 'стоит последняя, ' + r.have) + ' · ' + ago(r.at);
  }

  document.getElementById('updcheck').addEventListener('click', async () => {
    when.textContent = 'спрашиваю GitHub…';
    show(await ask({ type: 'updCheck' }));
  });
  document.getElementById('updget').addEventListener('click', () => {
    if (url) window.open(url, '_blank');
  });
  document.getElementById('updapply').addEventListener('click', async () => {
    when.textContent = 'перезапускаю…';
    await ask({ type: 'updApply' });
  });

  (async () => show(await ask({ type: 'updState' })))();
})();
