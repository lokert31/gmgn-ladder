// Тейки закрытых позиций: снимаются сами, но не от первого же пропуска.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootOverlay } = require('./dom');

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const KA = 'robinhood:' + A;
const KB = 'robinhood:' + B;
const ladder = (addr, group) => ({ chainId: 4663, token0: addr, token1: USDG,
  symbols: 'X/USDG', ids: ['1'], lo: 1, hi: 2, group });

test('тейк закрытой позиции снимается, но не сразу', async () => {
  const MIN = 60000;
  const store = {
    llChart: {
      takeLevels: {
        [KA]: [{ v: 5, unit: 'price', act: 'close' }],
        [KB]: [{ v: 7, unit: 'price', act: 'fees' }],
      },
      // По B леддера нет уже 11 минут — пора снимать.
      takeGone: { [KB]: Date.now() - 11 * MIN },
    },
    llPairs: { pairs: [ladder(A, 'g1')], savedAt: Date.now() },
  };
  const w = await bootOverlay(store);
  try {
    // Пришёл свежий список: A на месте, B нет.
    w.poke('llPairs', { pairs: [ladder(A, 'g1')], savedAt: Date.now() });
    let levels = w.store.llChart.takeLevels;
    assert.ok(levels[KA], 'у живой позиции тейк остаётся');
    assert.ok(!levels[KB], 'у позиции, которой нет больше 10 минут, тейк снят');

    // Теперь пропала и A. Первый же пропуск тейк не снимает: сайт бывает
    // отдаёт список с дырой.
    w.poke('llPairs', { pairs: [], savedAt: Date.now() });
    levels = w.store.llChart.takeLevels;
    assert.ok(levels[KA], 'от одного пропуска тейк снимать нельзя');
    assert.ok(w.store.llChart.takeGone[KA], 'но отсчёт пошёл');

    // Позиция вернулась — отсчёт сбрасывается.
    w.poke('llPairs', { pairs: [ladder(A, 'g1')], savedAt: Date.now() });
    assert.ok(!w.store.llChart.takeGone[KA], 'леддер вернулся — отсчёт обнуляется');
    assert.deepEqual(w.errors, []);
  } finally {
    w.close();
  }
});

test('прошедший сбор становится точкой на графике, непрошедший — нет', async () => {
  const store = {
    llChart: { watchOn: true },
    llPairs: { pairs: [{ chainId: 4663, token0: '0x905b79845eaea281e4200f206fe7920dad685dd3',
                         token1: USDG, symbols: 'USDG/DOGSHIT', ids: ['1', '2'],
                         lo: 0.0001, hi: 0.0007, group: 'g1' }], savedAt: Date.now() },
  };
  const w = await bootOverlay(store);
  // jsdom шлёт postMessage с пустым origin — подменяем событие целиком,
  // как его получит страница от перехватчика.
  const send = (data) => w.dom.window.dispatchEvent(new w.dom.window.MessageEvent('message', {
    data: { __llTap: true, ...data }, source: w.dom.window, origin: w.dom.window.location.origin,
  }));
  try {
    send({ type: 'collect-shape', url: '/api/v1/execute/v4/batch-collect-fees', method: 'POST',
           body: '{}', headers: {}, at: Date.now() });
    send({ type: 'collect-done', kind: 'fees', ok: false, at: Date.now() });
    assert.ok(!w.store.llCollects || !Object.keys(w.store.llCollects).length,
      'сбор, который сайт отклонил, точкой не становится');

    send({ type: 'collect-shape', url: '/api/v1/execute/v4/batch-collect-fees', method: 'POST',
           body: '{}', headers: {}, at: Date.now() });
    send({ type: 'collect-done', kind: 'fees', ok: true, at: Date.now() });
    const all = w.store.llCollects || {};
    const list = Object.values(all)[0] || [];
    assert.equal(list.length, 1, 'прошедший сбор обязан запомниться');
    assert.ok(list[0].price > 0, 'точке нужна цена момента сбора');
    assert.equal(list[0].kind, 'fees');
    assert.ok(Math.abs(list[0].at - Date.now() / 1000) < 5, 'время — в секундах, как у графика');
    assert.deepEqual(w.errors, []);
  } finally {
    w.close();
  }
});

test('токена нет на странице — график берёт ступени из памяти, а не пустеет', async () => {
  // На странице Manage загружен DOGSHIT, а график открыт по другому токену.
  const OTHER = '0x' + 'c'.repeat(40);
  const store = {
    llChart: { open: true, watchOn: true, geom: { x: 40, y: 40, w: 700, h: 500 },
               tabs: [{ chain: 'robinhood', addr: '0x' + 'C'.repeat(40), label: 'SWARM' }] },
    llPairs: { pairs: [ladder(OTHER, 'g9')], savedAt: Date.now() },
    llRungs: { ['robinhood/' + OTHER]: { savedAt: Date.now() - 3600000,
      rungs: [{ lo: 1, hi: 2, value: 100, filled: true, at: 1.5 }] } },
  };
  const w = await bootOverlay(store);
  try {
    const root = w.dom.window.document.getElementById('llc-host').shadowRoot;
    root.querySelector('.tab').dispatchEvent(new w.dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const L = w.parse.__lastLevels();
    assert.ok(L, 'посылка на график обязана быть, даже когда токена нет на странице');
    assert.equal(L.cached, true, 'ступени — из памяти');
    assert.equal(L.rungs[0].at, 1.5, 'с ценой, при которой сняты суммы');
    assert.deepEqual(w.errors, []);
  } finally {
    w.close();
  }
});

test('карточка с улетевшей ценой пула не выбрасывает леддер', () => {
  const { load } = require('./dom');
  const { dom, parse } = load('manage.html');
  const box = dom.window.document.createElement('div');
  // Ровно как на Dashboard у TWINE: края нормальные, в середине 3.4·10³⁸.
  box.innerHTML = '<div><span>0.0001533085</span><span>340 256 786 833 063 530 000 000 000 000 000 000 000</span><span>0.0014577359</span></div>';
  const h = parse.harvest(box);
  assert.equal(h.trips.length, 1, 'края леддера обязаны остаться');
  assert.ok(Math.abs(h.trips[0][0] - 0.0001533085) < 1e-12);
  assert.ok(Number.isNaN(h.trips[0][1]), 'середина — нечитаемая цена, а не число');
  dom.window.close();
});

test('точка сбора пишет фисы из панели, а не с карточки бэкенда', async () => {
  const store = {
    llChart: { watchOn: true },
    llPairs: { pairs: [{ chainId: 4663, token0: '0x905b79845eaea281e4200f206fe7920dad685dd3',
                         token1: USDG, symbols: 'USDG/DOGSHIT', ids: ['1', '2'],
                         lo: 0.0001, hi: 0.0007, group: 'g1' }], savedAt: Date.now() },
  };
  const w = await bootOverlay(store);
  const doc = w.dom.window.document;
  // Панель «Fees & PnL» после «Update Fees»: на карточке фикстуры $16.24,
  // а свежее число — $44.40. Как было у TWINE: $0.35 на карточке, $44 в панели.
  const panel = doc.createElement('div');
  panel.innerHTML = '<div><span>Unclaimed fees:</span><span>$44.40</span></div>'
    + '<div><span>Claimed:</span><span>$24.02</span></div>'
    + '<div><span>Net PnL:</span><span>$30.82</span></div>';
  doc.body.appendChild(panel);
  const send = (data) => w.dom.window.dispatchEvent(new w.dom.window.MessageEvent('message', {
    data: { __llTap: true, ...data }, source: w.dom.window, origin: w.dom.window.location.origin,
  }));
  try {
    send({ type: 'collect-shape', url: '/api/v1/execute/v4/batch-collect-fees', method: 'POST',
           body: '{}', headers: {}, at: Date.now() });
    send({ type: 'collect-done', kind: 'fees', ok: true, at: Date.now() });
    const list = Object.values(w.store.llCollects || {})[0] || [];
    assert.equal(list.length, 1);
    assert.equal(list[0].usd, 44.4, 'на точке должно быть свежее число из панели, а не с карточки');
  } finally {
    w.close();
  }
});

test('слетел вход на сайте — сторож не жмёт вслепую и говорит об этом', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function onImpulse'), src.indexOf('async function loadToken'));
  assert.ok(fn.indexOf('msg.own !== true') < fn.indexOf('loggedIn() === false'),
    'сначала — своя ли вкладка, потом — есть ли вход');
  assert.ok(fn.indexOf('loggedIn() === false') < fn.indexOf('loadToken('), 'вход проверяется до любых действий');
  assert.ok(fn.includes("did: 'login'"));
  const re = eval(/const RE_LOGOUT = ([^;]+);/.exec(src)[1]);
  assert.ok(re.test('Log out'), 'признак входа — «Log out» в меню сайта, как на живой странице');
  const wt = fs.readFileSync(path.join(__dirname, '..', 'src', 'watch.js'), 'utf8');
  assert.ok(wt.includes('if (r && r.did === "login") loginLost('), 'сторож должен прислать уведомление');
});

test('отметка края от прошлой лесенки снимается сама', async () => {
  const KB = 'robinhood:0x724a163f0081fa1771590dda9b55edde2c5b823a';
  const store = {
    llChart: {
      watchOn: true,
      takeLevels: { [KB]: [
        { v: 0.002538, unit: 'price', act: 'fees', from: 0.00282 },   // верх прошлой лесенки
        { v: 0.0035, unit: 'price', act: 'fees', from: 0.0038467781 }, // верх нынешней
        { v: 0.003, unit: 'price', act: 'close', from: null },         // вписан руками
      ] },
    },
    // Ступени нынешней лесенки BLAST, верх 0.0038468 — как в хранилище.
    llRungs: { ['robinhood/0x724a163f0081fa1771590dda9b55edde2c5b823a']: { savedAt: Date.now(),
      rungs: [{ lo: 0.0026, hi: 0.0038467781, value: 100 }, { lo: 0.00178, hi: 0.0026, value: 100 }] } },
    llPairs: { pairs: [{ chainId: 4663, token0: USDG, token1: '0x724a163f0081fa1771590dda9b55edde2c5b823a',
      symbols: 'USDG/BLAST', ids: ['1'], lo: 0.00078, hi: 0.00385, group: 'b' }], savedAt: Date.now() },
  };
  const w = await bootOverlay(store);
  try {
    w.poke('llPairs', { ...store.llPairs, savedAt: Date.now() });
    const left = w.store.llChart.takeLevels[KB];
    assert.equal(left.length, 2, 'старая отметка ушла, нынешняя и вписанная руками — остались');
    assert.ok(!left.some((x) => x.from === 0.00282));
    assert.ok(left.some((x) => x.from === null), 'вписанный руками уровень не трогаем никогда');
  } finally {
    w.close();
  }
});

test('памп можно выключить у отдельного токена: настройка доезжает до сторожа', async () => {
  const T = '0x905b79845eaea281e4200f206fe7920dad685dd3';
  const KEY = 'robinhood:' + T;
  const store = {
    // Без открытой вкладки окно не рисует настройки вовсе.
    llChart: { watchOn: true, pumpOn: true, open: true, menu: true,
               tabs: [{ chain: 'robinhood', addr: T, label: 'AAA/USDG' }] },
    llPairs: { pairs: [{ chainId: 4663, token0: T, token1: USDG, symbols: 'AAA/USDG',
                         ids: ['1'], lo: 0.0001, hi: 0.0007, group: 'g1' }], savedAt: Date.now() },
  };
  const w = await bootOverlay(store);
  try {
    // Панель живёт в теневом дереве — снаружи её не видно.
    const root = w.dom.window.document.getElementById('llc-host').shadowRoot;
    const sel = root.querySelector('.menu .pumptok');
    const off = root.querySelector('.menu [data-a="pumpoff"]');
    assert.ok(sel && off, 'в настройках нет кнопки «не собирать на пампе»');
    sel.value = KEY;
    off.click();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.store.llChart.tokenPump[KEY].off, true, 'запрет не сохранился');
    assert.equal(w.store.llWatch.pump[KEY].off, true, 'сторож о запрете не узнал');
    const chip = [...root.querySelectorAll('.menu .pumps .chip')].map((c) => c.textContent).join('|');
    assert.match(chip, /памп выкл/, 'в списке не видно, что памп выключен: ' + chip);

    // Снимаем запрет тем же переключателем на чипе.
    root.querySelector('.menu .pumps .chip .pumpoff').click();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!(w.store.llChart.tokenPump[KEY] || {}).off, 'запрет не снялся');
    assert.deepEqual(w.errors, []);
  } finally {
    w.close();
  }
});

test('выключатель пампа по токену виден сразу, а не спрятан в «Тонкой настройке»', async () => {
  const T = '0x905b79845eaea281e4200f206fe7920dad685dd3';
  const store = {
    llChart: { watchOn: true, pumpOn: true, open: true, menu: true,
               tabs: [{ chain: 'robinhood', addr: T, label: 'AAA/USDG' }] },
    llPairs: { pairs: [{ chainId: 4663, token0: T, token1: USDG, symbols: 'AAA/USDG',
                         ids: ['1'], lo: 0.0001, hi: 0.0007, group: 'g1' }], savedAt: Date.now() },
  };
  const w = await bootOverlay(store);
  try {
    const root = w.dom.window.document.getElementById('llc-host').shadowRoot;
    const btn = root.querySelector('[data-a="pumpoff"]');
    const more = root.querySelector('.menu .more');
    assert.ok(btn, 'кнопки «не собирать на пампе» нет вовсе');
    assert.ok(more && !more.contains(btn),
      'кнопка спрятана в свёрнутой «Тонкой настройке» — там её не находят');
    const pumpOn = root.querySelector('.menu [data-c="pumpOn"]');
    assert.ok(pumpOn && (pumpOn.compareDocumentPosition(btn) & 4),
      'блок по токенам должен идти после общей галки «Собирать на импульсе цены»');
    assert.deepEqual(w.errors, []);
  } finally {
    w.close();
  }
});
