// Рисование на графике GMGN целиком, на подставном графике и холсте. Раньше
// тесты его не запускали вовсе: ошибка в любой подписи роняла весь ладдер,
// а видно это было только в браузере.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge.js'), 'utf8');
const cut = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
const code = cut('  function timeToX(chart', '  /* ------------------------------------------------------------------ *\n   * 5.')
  + cut('  function drawLevels(g, chart', '  function drawEntryLine');

function draw(L) {
  const calls = [];
  const g = new Proxy({}, {
    get: (o, k) => (k in o ? o[k] : k === 'measureText'
      ? (t) => ({ width: String(t).length * 7 })
      : (...a) => calls.push([k, ...a])),
    set: (o, k, v) => { o[k] = v; return true; },
  });
  const chart = {
    series: { firstValue: () => 1 },
    priceScale: { priceToCoordinate: (v) => 500 - Math.log(v / 800000) * 300 },
    timeScale: {
      points: () => ({ size: () => 100, valueAt: (i) => 1757700000 + i * 60,
                       closestIndexLeft: (t) => Math.floor((t - 1757700000) / 60) }),
      indexToCoordinate: (i) => i * 10,
    },
  };
  const run = new Function('state', code + '\nreturn drawLevels;')({ levels: L, config: {} });
  run(g, chart, 1800, 900, 1e9);
  return calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
}

const FULL = {
  positions: [[0.0005, 0.0007], [0.0007, 0.0009], [0.0009, 0.0012]],
  rungs: [{ lo: 0.0005, hi: 0.0007, value: 500 }, { lo: 0.0007, hi: 0.0009, value: 400 },
          { lo: 0.0009, hi: 0.0012, value: 300 }],
  current: 0.000824, showMine: true, depthThin: true, showBounds: true,
  supply: 1e9, feeTok: 12000, feeQuotes: [{ symbol: 'USDG', amount: 5.5 }],
  unclaimedUsd: 20, claimedUsd: 5, cost: 1300,
  collects: [{ at: 1757700600, price: 0.0008, usd: 12, kind: 'fees' }],
  takes: [{ at: 0.00088, act: 'close', label: '$0.00088' }],
  depth: [{ lo: 0.0006, hi: 0.00065, usd: 300, quote: 300 }], depthPrice: 0.000824,
};

test('весь ладдер рисуется без ошибок и со всеми подписями', () => {
  const texts = draw(FULL).join(' | ');
  for (const want of ['мой сайз', 'мешок', 'саплая', 'в фисах', 'USDG', 'БУ ', 'PnL с фисами', 'закрыть', '$12']) {
    assert.ok(texts.includes(want), 'нет подписи «' + want + '»: ' + texts);
  }
});

test('без цены — не «ниже диапазона», а честное «не прочли»', () => {
  const texts = draw({ ...FULL, current: null, cached: true, cost: undefined }).join(' | ');
  assert.ok(!texts.includes('НИЖЕ'), 'пустая цена — это не ноль: ' + texts);
  assert.ok(texts.includes('не прочли'));
});

test('из памяти и без сумм рисуется без ошибок', () => {
  assert.doesNotThrow(() => draw({ positions: [[1, 2]], rungs: [], current: 1.5, envelope: true, showBounds: true }));
  assert.doesNotThrow(() => draw({ ...FULL, rungs: FULL.rungs.map((r) => ({ ...r, at: 0.0006 })), cached: true }));
  assert.doesNotThrow(() => draw({ ...FULL, feeQuotes: undefined, feeTok: undefined, collects: undefined }));
});

test('мёртвый пул леддера объясняется прямо на графике', () => {
  const texts = draw({ ...FULL, poolDead: true, current: 0.000824 }).join(' | ');
  assert.ok(texts.includes('сделок и фисов нет'), 'надо сказать, почему фисы не капают: ' + texts);
});

test('пул лесенки в потолке: мешка нет, всё в стейбле — как у TWINE', () => {
  // Ступени TWINE из цепи, рынок $0.00208, пул стоит выше всех ступеней.
  const rungs = [[0.000153, 0.000245], [0.000245, 0.00035], [0.00035, 0.0005],
                 [0.0005, 0.000714], [0.000714, 0.00102], [0.00102, 0.001458]]
    .map(([lo, hi]) => ({ lo, hi, lh: 40000 }));
  const texts = draw({ positions: rungs.map((r) => [r.lo, r.hi]), rungs, chain: true,
    current: 0.00208, poolPrice: 0.001458 * 1.001, poolDead: true,
    showMine: true, showBounds: true, supply: 1e9 }).join(' | ');
  assert.ok(!texts.includes('мешок'), 'токена в лесенке нет — мешка быть не должно: ' + texts);
  assert.ok(texts.includes('ВЫШЕ леддера: рынок на +43% выше'), 'подпись по рынку: ' + texts);
  assert.ok(texts.includes('выше $0 (0 ступ.)'), 'выше цены пула ничего не лежит: ' + texts);
  assert.ok(!texts.includes('БУ '), 'пул стоит — безубыток по рынку не рисуем');
});

test('над точкой сбора написано, зачем собирали', () => {
  const texts = draw({ ...FULL, collects: [
    { at: 1757700600, price: 0.0008, usd: 24.8, kind: 'fees', why: 'памп +52%' },
    { at: 1757700660, price: 0.0008, usd: 0.35, kind: 'fees', why: 'руками' },
    { at: 1757700720, price: 0.0008, usd: 47.9, kind: 'fees', why: 'цена у верха диапазона' },
  ] }).join(' | ');
  assert.ok(texts.includes('$24.8 · памп +52%'), texts);
  assert.ok(texts.includes('$0.3 · руками') || texts.includes('$0.4 · руками'), texts);
  assert.ok(texts.includes('$47.9 · у верха'), texts);
});


test('щель между ступенями — не «мёртвый пул»', () => {
  const C = require('../src/chain.js');
  // Тик внутри диапазона, ликвидности у цены нет: цена настоящая.
  const d = { c0: '0xt', c1: '0xu', lo: -352000, hi: -350000, d0: 18, d1: 6, L: '1000000000000',
              poolTick: -351000, poolLiq: '0' };
  const r = C.rungOf(d, '0xt', 1);
  assert.equal(r.pool.dead, false, 'нулевая ликвидность в щели — не повод объявлять пул мёртвым');
  const top = C.rungOf({ ...d, poolTick: 887271 }, '0xt', 1);
  assert.equal(top.pool.dead, true, 'а предельный тик — мёртвый');
});

test('без лесенки на обычной вкладке GMGN рисуется одна глубина пулов', () => {
  const texts = draw({ positions: [], rungs: [], depth: [
    { lo: 0.0007, hi: 0.00075, usd: 5000 }, { lo: 0.0009, hi: 0.00095, usd: 3000 }], depthPrice: 0.000824,
    depthThin: true, sizeOff: true, showBounds: false }).join(' | ');
  assert.ok(/%\s+\$/.test(texts), 'подписи сумм глубины: ' + texts);
  assert.ok(!texts.includes('мой сайз') && !texts.includes('верх леддера'), 'без лесенки — ни сайза, ни границ');
});
