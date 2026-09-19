// Карточка LP на GMGN: переключатель «в списках» и метки у токенов.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('включил «в списках» — у каждой строки одна метка с пулами и оборотом', async () => {
  const A = '0x' + 'a'.repeat(40);
  const B = '0x' + 'b'.repeat(40);
  // Список как на GMGN: в строке две ссылки на токен (иконка и название), у одной — рефкод.
  const row = (addr, sym) => `<div class="row"><a href="/robinhood/token/${addr}"><img></a>`
    + `<a href="/robinhood/token/Ref123_${addr}">${sym}</a></div>`;
  const dom = new JSDOM(`<body>${row(A, 'AAA')}${row(B, 'BBB')}<div id="gho-panel"><div class="gho-head">Топ-холдеры</div><div class="gho-body"></div></div></body>`,
    { url: 'https://gmgn.ai/trend?chain=robinhood', runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w.HTMLElement.prototype, 'offsetWidth', { get() { return this.classList.contains('row') ? 600 : 50; } });
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 10, bottom: 30, width: 100, height: 20 });
  const store = { ghoLpCard: { lists: true } };
  let multi = 0;
  w.chrome = {
    runtime: { lastError: null, sendMessage(msg, cb) {
      if (msg.type === 'lpMulti') {
        multi++;
        setTimeout(() => cb({ ok: true, tokens: {
          [A]: { reserve: 100000, vol24: 3000000 }, [B]: { reserve: 50000, vol24: 100000 } } }), 1);
      } else if (cb) cb(null);
    } },
    storage: { local: { get: (k, cb) => cb({ [k]: store[k] }), set: (b) => Object.assign(store, b) } },
  };
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'lp.js'), 'utf8'));
  try {
  await new Promise((r) => setTimeout(r, 3500));
  const tags = [...w.document.querySelectorAll('.gho-lp-tag')].map((x) => x.textContent);
  assert.equal(tags.length, 2, 'по одной метке на строку, хоть ссылок в строке две: ' + JSON.stringify(tags));
  assert.ok(tags.some((t) => t.includes('$100.0K') && t.includes('×30')), 'оборот ×30 для AAA: ' + tags);
  assert.equal(multi, 1, 'обе строки — одним запросом');
  const lp = w.document.getElementById('gho-lp');
  assert.ok(lp, 'шапка с переключателями на месте');
  assert.equal(lp.parentElement.id, 'gho-panel', 'блок LP — внутри плашки холдеров, а не поверх страницы');
  assert.ok(lp.previousElementSibling.classList.contains('gho-head'), 'сразу под шапкой плашки — виден и при свёрнутом списке');
  } finally {
    w.close();
  }
});

test('на странице токена: пулы уходят на график, авторазбор выключается галкой', async () => {
  const A = '0x' + 'c'.repeat(40);
  const dom = new JSDOM('<body><div id=\"gho-panel\"><div class=\"gho-head\">Топ-холдеры</div><div class=\"gho-body\"></div></div></body>', { url: 'https://gmgn.ai/robinhood/token/Ref9_' + A, runScripts: 'outside-only' });
  const w = dom.window;
  const store = { ghoLpCard: { auto: false, chart: true, lists: false } };
  const asked = [];
  const posted = [];
  w.addEventListener('message', (e) => { if (e.data && e.data.__gho) posted.push(e.data); });
  w.chrome = {
    runtime: { lastError: null, sendMessage(msg, cb) {
      asked.push(msg.type);
      if (msg.type === 'depth') setTimeout(() => cb({ ok: true, price: 0.001, bands: [{ lo: 0.0009, hi: 0.0011, usd: 5000 }] }), 1);
      else if (cb) setTimeout(() => cb({ ok: false, error: 'нет' }), 1);
    } },
    storage: { local: { get: (k, cb) => cb({ [k]: store[k] }), set: (b) => Object.assign(store, b) } },
  };
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'lp.js'), 'utf8'));
  try {
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!asked.includes('lpScan'), 'авторазбор выключен — сам не считает');
  assert.ok(w.document.getElementById('gho-lp').textContent.includes('жми ⟳'));
  const lv = posted.find((m) => m.type === 'levels' && m.levels);
  assert.ok(lv, 'глубина пулов должна уйти на график');
  assert.equal(lv.levels.depth.length, 1);
  assert.equal(lv.levels.positions.length, 0, 'без лесенки — только пулы');
  // Галка «на графике» выключает рисование.
  const box = w.document.querySelector('[data-r="chart"]');
  box.checked = false; box.dispatchEvent(new w.Event('change'));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(posted.some((m) => m.type === 'levels' && m.levels === null), 'выключил — график очищается');
  } finally {
    w.close();                    // иначе таймеры карточки держат процесс
  }
});
