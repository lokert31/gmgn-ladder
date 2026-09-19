const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./dom');

test('окно поднимается и перерисовывается без ошибок', async () => {
  const { dom, parse } = load('manage.html');
  // Вкладка и открытое окно обязательны: при пустом списке отрисовка выходит
  // раньше и до половины кода просто не доходит.
  const store = {
    llChart: {
      open: true,
      tabs: [{ chain: 'robinhood', addr: '0x905b79845eaea281e4200f206fe7920dad685dd3',
               label: 'USDG/DOGSHIT' }],
      watchOn: true,
      geom: { x: 40, y: 40, w: 700, h: 500 },
    },
    llPairs: { pairs: [{ chainId: 4663, token0: '0x905b79845eaea281e4200f206fe7920dad685dd3',
                         token1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
                         symbols: 'USDG/DOGSHIT', ids: ['1', '2'], lo: 0.0001, hi: 0.0007,
                         group: 'g1' }] },
  };
  const errors = [];
  global.chrome = {
    runtime: {
      id: 'test',
      lastError: null,
      onMessage: { addListener() {} },
      sendMessage(msg, cb) { if (cb) cb({ ok: true, tokens: [], lastRun: Date.now(), api: false }); },
    },
    storage: { local: {
      // Расширение читает хранилище и промисом, и колбэком — поддерживаем оба,
      // иначе половина чтений просто не завершится и подъём зависнет.
      get(k, cb) {
        const out = typeof k === 'string' ? { [k]: store[k] } : store;
        if (typeof cb === 'function') { cb(out); return undefined; }
        return Promise.resolve(out);
      },
      set: (box) => Object.assign(store, box),
      remove() {},
    } },
  };
  // Разметку окно строит через браузерные классы — отдаём их из jsdom,
  // иначе подъём падает на первом же обращении.
  for (const name of ['MutationObserver', 'HTMLInputElement', 'HTMLElement',
                      'Event', 'CustomEvent', 'MouseEvent', 'Node', 'NodeFilter',
                      'getComputedStyle', 'requestAnimationFrame']) {
    if (dom.window[name] !== undefined) global[name] = dom.window[name];
  }
  dom.window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));

  // Окно заводит вечные таймеры — иначе тест не закончится никогда.
  const timers = [];
  const realInterval = global.setInterval;
  global.setInterval = (fn, ms) => { const id = realInterval(fn, ms); timers.push(id); return id; };
  try {
    await parse.__boot();
    assert.ok(document.getElementById('llc-host'), 'окно не построилось');
    const root = document.getElementById('llc-host').shadowRoot;
    assert.ok(root.querySelector('.tab'), 'вкладка не отрисовалась — значит отрисовка не дошла до конца');
    assert.ok(root.querySelector('.menu .state'), 'состояние сторожа не построилось');

    // Пропущенный узел не ломает сборку: querySelector вернёт null, и всё
    // молча перестаёт работать. На этих граблях мы стояли трижды.
    const fs = require('node:fs');
    const path = require('node:path');
    const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
    const start = code.indexOf('    ui = {');
    assert.ok(start > 0, 'не нашёлся список узлов интерфейса');
    const block = code.slice(start, code.indexOf('\n    };', start));
    const sels = [...block.matchAll(/root\.querySelector(All)?\('([^']+)'\)/g)];
    assert.ok(sels.length > 20, 'узлов подозрительно мало: ' + sels.length);
    const missing = sels
      .filter((m) => (m[1] ? root.querySelectorAll(m[2]).length : !!root.querySelector(m[2])) === (m[1] ? 0 : false))
      .map((m) => m[2]);
    assert.deepEqual(missing, [], 'в разметке нет узлов: ' + missing.join(', '));
    assert.deepEqual(errors, [], 'при подъёме окна были ошибки: ' + errors.join(' | '));
  } finally {
    for (const id of timers) clearInterval(id);
    global.setInterval = realInterval;
    dom.window.close();
  }
});
