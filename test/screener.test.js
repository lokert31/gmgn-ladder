// Страница-скринер целиком: топ → разбор по токену → таблица.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('скринер разбирает топ, рисует строки и прячет падающие', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'screener.html'), 'utf8')
    .replace('<script src="screener.js"></script>', '');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const w = dom.window;
  const scan = {
    '0xaaa': { ok: true, yield1: 0.012, fees1: 500, fees24: 9000, near: 40000, tvlPeople: 120000, tvlLaunchpad: 70000,
               vol1: 20000, vol24: 400000, h1: 2, h6: 5, h24: 30, risk: 'спокойно',
               best: [{ name: 'AAA / USDG 4%', kind: 'people', fees24: 8000 }] },
    '0xbbb': { ok: true, yield1: 0.2, fees1: 900, fees24: 20000, near: 4500, tvlPeople: 60000, tvlLaunchpad: 50000,
               vol1: 30000, vol24: 900000, h1: -10, h6: -60, h24: -70, risk: 'падает', best: [] },
  };
  w.chrome = { runtime: { lastError: null, sendMessage(msg, cb) {
    setTimeout(() => {
      if (msg.type === 'lpTop') cb({ ok: true, tokens: [{ addr: '0xaaa', symbol: 'AAA', vol24: 1 }, { addr: '0xbbb', symbol: 'BBB', vol24: 1 }] });
      else if (msg.type === 'lpHistory') cb({ ok: true, hist: { 'robinhood:0xaaa': [{ t: Date.now() - 24 * 3600000, people: 100000 }] } });
      else if (msg.type === 'lpScan') cb(scan[msg.addr]);
      else cb(null);
    }, 1);
  } } };
  // Паузы между токенами в тесте не нужны.
  const realSetTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms) => realSetTimeout(fn, ms > 100 ? 0 : ms);
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'screener.js'), 'utf8'));
  w.document.getElementById('go').click();
  for (let i = 0; i < 50 && !/готово/.test(w.document.getElementById('status').textContent); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const rows = [...w.document.querySelectorAll('#rows tr')].map((tr) => tr.textContent);
  assert.equal(rows.length, 1, '«падает» по умолчанию скрыт');
  assert.ok(rows[0].includes('AAA') && rows[0].includes('1.20%'), rows[0]);
  assert.ok(rows[0].includes('+$20.0K'), 'рост «залили люди» за сутки по истории: ' + rows[0]);
  w.document.getElementById('hideFall').click();
  assert.equal(w.document.querySelectorAll('#rows tr').length, 2, 'снял галку — падающий виден');
  assert.ok(w.document.getElementById('sum').textContent.includes('Разобрано 2'));
  dom.window.close();
});

test('скринер разбирает по три токена сразу и без пауз между ними', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'screener.html'), 'utf8')
    .replace('<script src="screener.js"></script>', '');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const w = dom.window;
  const tokens = Array.from({ length: 7 }, (_, i) => ({ addr: '0x' + String(i).repeat(40), symbol: 'T' + i, vol24: 1 }));
  let inFlight = 0;
  let peak = 0;
  w.chrome = { runtime: { lastError: null, sendMessage(msg, cb) {
    if (msg.type === 'lpTop') return setTimeout(() => cb({ ok: true, stocks: 2, tokens }), 1);
    if (msg.type === 'lpHistory') return setTimeout(() => cb({ ok: true, hist: {} }), 1);
    if (msg.type === 'lpScan') {
      inFlight++; peak = Math.max(peak, inFlight);
      return setTimeout(() => { inFlight--; cb({ ok: true, yield1: 0.01, near: 1000, risk: 'спокойно', best: [] }); }, 40);
    }
    cb(null);
  } } };
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'screener.js'), 'utf8'));
  const t0 = Date.now();
  w.document.getElementById('go').click();
  try {
    for (let i = 0; i < 200 && !/готово/.test(w.document.getElementById('status').textContent); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const status = w.document.getElementById('status').textContent;
    assert.match(status, /готово: 7 токенов/, status);
    assert.match(status, /акций убрано 2/, 'сколько акций выкинуто из топа — видно в строке статуса');
    assert.equal(peak, 3, 'в работе ровно три токена сразу');
    assert.ok(Date.now() - t0 < 1500, 'без паузы 1.8 с после каждого токена: ' + (Date.now() - t0) + ' мс');
  } finally {
    w.close();
  }
});
