// Меню расширения и единая схема настроек.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

test('настройки сторожа окно и воркер выводят по одной схеме', () => {
  const ov = read('ll/overlay.js');
  const push = ov.slice(ov.indexOf('chrome.storage.local.set({ llWatch: {') + 'chrome.storage.local.set({ llWatch: '.length,
                        ov.indexOf('} });', ov.indexOf('chrome.storage.local.set({ llWatch: {')) + 1);
  const fromOverlay = new Function('S', 'edgeArmed', 'return ' + push + ';');
  const wt = read('watch.js');
  const fn = wt.slice(wt.indexOf('function watchFromChart(S)'), wt.indexOf('try {\n  chrome.storage.onChanged.addListener((ch, area) => {\n    if (area !== "local" || !ch.llChart'));
  const fromWorker = new Function(fn + '\nreturn watchFromChart;')();
  for (const S of [
    {},
    { watchOn: true, edgeHi: true, edgeLo: false, minUsd: 20, everySec: 1, pumpOn: false, feesOn: true, maxTabs: 3,
      takeLevels: { a: [{ v: 1 }] }, tokenPump: { a: { pumpPct: 10 } }, watchSkip: ['x'] },
    { edgeHi: false, edgeLo: true, minUsd: 'мусор', everySec: 0 },
  ]) {
    const a = fromOverlay(S, () => S.edgeHi === true || S.edgeLo === true);
    const b = fromWorker(S);
    assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)), 'схемы разошлись на ' + JSON.stringify(S));
  }
});

test('значения по умолчанию в меню — те же, что у владельцев настроек', () => {
  const menu = read('menu.js');
  const D = new Function('return ' + menu.slice(menu.indexOf('const DEFAULTS = {') + 'const DEFAULTS = '.length,
    menu.indexOf('};', menu.indexOf('const DEFAULTS = {')) + 1))();
  const ov = read('ll/overlay.js');
  const ovD = new Function('return ' + ov.slice(ov.indexOf('const DEFAULTS = {') + 'const DEFAULTS = '.length,
    ov.indexOf('};', ov.indexOf('const DEFAULTS = {')) + 1))();
  for (const [k, v] of Object.entries(D.llChart)) assert.equal(v, ovD[k], 'llChart.' + k);
  const pn = read('panel.js');
  const pnD = new Function('return ' + pn.slice(pn.indexOf('const DEFAULTS = {') + 'const DEFAULTS = '.length,
    pn.indexOf('};', pn.indexOf('const DEFAULTS = {')) + 1))();
  for (const [k, v] of Object.entries(D.ghoConfig)) assert.equal(v, pnD[k], 'ghoConfig.' + k);
  const lp = read('lp.js');
  const st = new Function('return ' + /const st = (\{[^;]+\});/.exec(lp)[1])();
  for (const [k, v] of Object.entries(D.ghoLpCard)) assert.equal(v, st[k], 'ghoLpCard.' + k);
});

test('галка в меню пишет в своё место и не затирает остальное', async () => {
  const html = read('menu.html').replace('<script src="menu.js"></script>', '');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const w = dom.window;
  const store = { llChart: { geom: { x: 1 }, tabs: [1, 2], minUsd: 20, edgeHi: false }, ghoRpc: { robinhood: 'https://a' } };
  w.chrome = {
    runtime: { lastError: null, getManifest: () => ({ version: 'тест' }), sendMessage: (m, cb) => cb && cb({ ok: true }) },
    storage: { local: {
      get: async (k) => (Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, store[x]])) : { [k]: store[k] }),
      set: async (b) => Object.assign(store, JSON.parse(JSON.stringify(b))),
    }, onChanged: { addListener() {} } },
  };
  w.eval(read('menu.js'));
  await new Promise((r) => setTimeout(r, 30));
  const hi = w.document.querySelector('[data-s="llChart.edgeHi"]');
  assert.equal(w.document.querySelector('[data-s="llChart.minUsd"]').value, '20', 'меню показывает то, что стоит');
  hi.checked = true;
  hi.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store.llChart.edgeHi, true);
  assert.equal(store.llChart.edgeOn, true, 'старое общее поле края — в согласии');
  assert.deepEqual(store.llChart.tabs, [1, 2], 'вкладки окна не затёрты');
  assert.equal(store.llChart.minUsd, 20);
  const rpc = w.document.querySelector('[data-s="ghoRpc.robinhoodState"]');
  rpc.value = ' https://robinhood.rpc.orbitflare.com?api_key=X ';
  rpc.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store.ghoRpc.robinhood, 'https://a', 'основной RPC не затёрт');
  assert.equal(store.ghoRpc.robinhoodState, 'https://robinhood.rpc.orbitflare.com?api_key=X');
  w.close();
});
