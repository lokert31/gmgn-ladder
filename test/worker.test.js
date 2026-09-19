const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');

/** Поднимаем сервис-воркер так же, как это делает Chrome: одна общая область
 *  и importScripts, который кладёт туда же. Именно здесь вылезают ошибки,
 *  которых не видно ни при node --check, ни в тестах разбора DOM. */
function bootWorker() {
  const scope = {
    console,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: {} }) }),
    chrome: {
      storage: { local: { get: async () => ({}), set: () => {} } },
      runtime: { onMessage: { addListener() {} } },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      notifications: { create() {} },
      tabs: {
        query: async () => [],
        // Без скрипта на странице Chrome отвечает сразу, пустым ответом.
        sendMessage(id, msg, cb) { if (cb) cb(); },
        create: async () => ({}),
        // Живость вкладки и её уход — часть жизни сторожа, значит и часть
        // заглушки: без get он считал бы свои вкладки мёртвыми.
        get: (id, cb) => cb({ id }),
        remove: () => Promise.resolve(),
        onRemoved: { addListener() {} },
      },
    },
    URL, URLSearchParams, TextEncoder, TextDecoder, Promise, Date, Math, JSON,
    Number, String, BigInt, Array, Object, Error, Set, Map, RegExp, parseInt, parseFloat,
  };
  // Таймеры настоящие: раздача поручений вкладкам держится на тайм-ауте,
  // а с заглушкой обещание никогда не разрешалось и тест повисал.
  scope.setTimeout = setTimeout;
  scope.clearTimeout = clearTimeout;
  scope.self = scope;
  scope.globalThis = scope;
  vm.createContext(scope);
  scope.importScripts = (file) => {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), scope, { filename: file });
  };
  vm.runInContext(fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8'), scope, { filename: 'sw.js' });
  return scope;
}

test('сервис-воркер поднимается и подключает чтение цепи', () => {
  const scope = bootWorker();
  assert.ok(scope.GHO_CHAIN, 'chain.js не подключился — глубина пула работать не будет');
  for (const fn of ['poolsOfToken', 'readDepth', 'bands', 'decimalsOf', 'ethCall', 'mergeBands']) {
    assert.equal(typeof scope.GHO_CHAIN[fn], 'function', `нет ${fn}`);
  }
});

test('нативная валюта не ломает чтение знаков после запятой', async () => {
  const scope = bootWorker();
  // у нулевого адреса контракта нет: раньше вызов decimals() падал,
  // и вместе с ним отваливалась вся глубина пула
  const d = await scope.GHO_CHAIN.decimalsOf({ rpc: 'http://x' },
    '0x0000000000000000000000000000000000000000');
  assert.equal(d, 18);
});

test('окно поиска тиков задано в тиках, а не в словах битмапа', () => {
  const src = fs.readFileSync(path.join(SRC, 'chain.js'), 'utf8');
  assert.match(src, /SPAN_TICKS\s*=\s*\d+/,
    'окно должно измеряться в тиках: одно слово битмапа при шаге 200 — это пол-диапазона, а при шаге 25 — доли процента');
  assert.match(src, /const signed = \(v\) =>/,
    'знак должен разбираться как int256: ABI расширяет int24 и int128 до полных 256 бит');
});

test('глубина ищет пул в цепи, а не у GMGN', () => {
  const scope = bootWorker();
  const src = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8');
  const body = /async depth\(\{ chain, addr \}\) \{[\s\S]*?\n  \},/.exec(src);
  assert.ok(body, 'не нашёл обработчик глубины');
  assert.ok(!/token_pool_fee_info/.test(body[0]),
    'глубина снова зависит от GMGN — без его подписей она отвалится');
  assert.match(body[0], /candidates/, 'пул должен искаться в цепи');
  for (const fn of ['poolsOfToken', 'candidates', 'rpcBatch']) {
    assert.equal(typeof scope.GHO_CHAIN[fn], 'function', `нет ${fn}`);
  }
});

test('полосы разных пулов складываются на одну шкалу без потери денег', () => {
  const C = require('../src/chain.js');
  const a = [{ lo: 1, hi: 2, usd: 100, current: true }];
  const b = [{ lo: 1.5, hi: 3, usd: 60 }];
  const out = C.mergeBands([a, b]);
  const sum = out.reduce((s, x) => s + x.usd, 0);
  assert.ok(Math.abs(sum - 160) < 0.01, 'деньги при слиянии не должны теряться, вышло ' + sum);
  assert.equal(out.filter((x) => x.current).length, 1, 'текущая цена должна попасть ровно в одну полосу');
  assert.ok(out.every((x) => x.hi > x.lo), 'полосы должны быть непустыми');
});

test('пустой список пулов не роняет слияние', () => {
  const C = require('../src/chain.js');
  assert.deepEqual(C.mergeBands([]), []);
  assert.deepEqual(C.mergeBands([[]]), []);
  assert.deepEqual(C.mergeBands([[{ lo: 0, hi: 0, usd: 5 }]]), []);
});

test('пул лаунчпада отличается от обычного по хуку', () => {
  const plain = '0x0000000000000000000000000000000000000000';
  const hooked = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
  const byHand = (h) => /^0x0+$/.test(String(h || ''));
  assert.equal(byHand(plain), true, 'пул без хука — обычный, ликвидность в нём заводили руками');
  assert.equal(byHand(hooked), false, 'пул с хуком — лаунчпадный, он набирает ликвидность сам');
});

test('сетка глубины держится у цены, а не растягивается на мусорный пул', () => {
  const C = require('../src/chain.js');
  // Один пул стоит на краю тикового пространства и почти ничего не держит.
  // Раньше он растягивал шкалу на десятки порядков, и на экран попадала
  // одна полоса во всю высоту.
  const normal = [
    { lo: 90, hi: 100, usd: 500, current: true },
    { lo: 100, hi: 110, usd: 400 },
  ];
  const junk = [{ lo: 1e-30, hi: 120, usd: 1 }];
  const out = C.mergeBands([normal, junk], 400, 100);
  assert.ok(out.length > 20, 'полос должно быть много, вышло ' + out.length);
  const lo = Math.min(...out.map((b) => b.lo));
  const hi = Math.max(...out.map((b) => b.hi));
  assert.ok(hi / lo <= 26, 'шкала должна держаться в пределах пятикратного окна, вышло ' + (hi / lo));
  const cur = out.find((b) => b.current);
  assert.ok(cur && cur.hi / cur.lo < 1.05, 'полоса у цены должна быть узкой');
});

test('у мусорной котировки считается только сторона токена', () => {
  const C = require('../src/chain.js');
  // Пул в цене 1: ниже цены лежит котировка, выше — сам токен.
  const state = {
    sqrtPriceX96: BigInt(2) ** BigInt(96),
    tick: 0,
    liqNow: 1000000000n,
    ticks: [-100, 0, 100],
    nets: new Map([[-100, 0n], [0, 0n], [100, 0n]]),
    lpFee: 0,
  };
  const full = C.bands(state, 10, 18, 18, true, 1, false);
  const mine = C.bands(state, 10, 18, 18, true, 1, true);

  const sum = (r) => r.bands.reduce((s, b) => s + b.usd, 0);
  assert.ok(sum(full) > sum(mine), 'без котировки сумма должна быть меньше');

  const below = (r) => r.bands.find((b) => b.hi <= 1.0000001);
  assert.ok(below(full).usd > 0, 'ниже цены лежит котировка — она считается целиком');
  assert.ok(below(mine).usd === 0, 'ниже цены своего токена нет, значит и денег нет');

  const above = (r) => r.bands.find((b) => b.lo >= 0.9999999 && b.hi > 1);
  assert.ok(above(mine).usd > 0, 'выше цены лежит сам токен — он считается в обоих случаях');
});

test('пул против доллара попадает в выборку, даже если он не в верхушке по L', () => {
  const src = fs.readFileSync(path.join(SRC, 'chain.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function candidates'), src.indexOf('const SPAN_TICKS'));
  assert.ok(fn.includes('for (const q of want)'),
    'нужен добор по одному пулу на каждую котировку: общий лимит занимали нативные пары');
  assert.ok(fn.includes('keep.concat'),
    'пулы против известной котировки нельзя резать по позиции в списке');
});

test('ответ узла разбирается с понятной ошибкой, а не «Unexpected end of JSON input»', () => {
  const src = fs.readFileSync(path.join(SRC, 'chain.js'), 'utf8');
  assert.ok(/async function postJson/.test(src), 'нет общего разбора ответа');
  assert.ok(src.includes('узел вернул пустой ответ'), 'пустое тело должно называться словами');
  assert.ok(!/await res\.json\(\)/.test(src), 'сырой res.json() роняет разбор на не-JSON');
  assert.ok(/const BATCH = \d+/.test(src), 'пачка вызовов должна быть ограничена по размеру');
});

test('сторож импульса подключается к воркеру', () => {
  const scope = bootWorker();
  assert.ok(scope.GHO_WATCH, 'watch.js не подключился — автосбор работать не будет');
  assert.equal(typeof scope.GHO_WATCH.impulse, 'function');
  assert.equal(scope.GHO_WATCH.WATCH_KEY, 'llWatch', 'ключ настроек должен совпадать с тем, что пишет оверлей');
});

test('имена в watch.js не спорят с sw.js и chain.js', () => {
  const top = (file) => {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    const names = new Set();
    for (const m of src.matchAll(/^(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/gm)) {
      names.add(m[1]);
    }
    return names;
  };
  // importScripts кладёт всё в одну область: совпадение имени с const — это
  // «Identifier has already been declared» и воркер не стартует вовсе.
  const watch = top('watch.js');
  for (const other of ['sw.js', 'chain.js']) {
    for (const n of top(other)) {
      assert.ok(!watch.has(n), 'имя ' + n + ' объявлено и в watch.js, и в ' + other);
    }
  }
});

test('импульс считается от самой низкой цены в окне, а не от первой', () => {
  const C = require('../src/chain.js');   // подгружаем, чтобы путь был живой
  assert.ok(C);
  const scope = bootWorker();
  const { impulse } = scope.GHO_WATCH;

  // Цена сначала падала, потом выросла вдвое от низа: это импульс,
  // хотя относительно начала окна рост всего 20%.
  const points = [{ at: 1, price: 100 }, { at: 2, price: 60 }, { at: 3, price: 70 }];
  const hit = impulse(points, 120, 50);
  assert.ok(hit, 'рост вдвое от низа окна должен считаться импульсом');
  assert.equal(Math.round(hit.grew), 100);
  assert.equal(hit.from, 60, 'считать надо от низа, а не от первой точки');

  assert.equal(impulse(points, 80, 50), null, 'рост на треть импульсом не считается');
  assert.equal(impulse([], 100, 50), null, 'без истории импульса нет');
});

test('сторож спрашивает цену дёшево и одной пачкой на все токены', () => {
  const src = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function pricesOf'), src.indexOf('function impulse'));
  assert.ok(!fn.includes('HANDLERS.depth'),
    'полный расчёт глубины — это десятки обращений к сети, а цену спрашивают каждые несколько секунд');
  assert.ok(fn.includes('C.rpcBatch'),
    'все токены должны читаться одним обращением, иначе цена опроса растёт с их числом');
  assert.ok(src.includes('POOL_TTL'), 'пул надо запоминать, а не искать заново на каждый опрос');
  assert.ok(/tick >= 1n << 255n/.test(fn), 'тик приезжает знаковым в 256 битах, иначе цена улетит');
});

test('уведомление шлётся по факту сбора, а не на каждой проверке', () => {
  const scope = bootWorker();
  const shown = [];
  scope.chrome.notifications = { create: (id, box) => shown.push(box) };
  const HANDLERS = vm.runInContext('HANDLERS', scope);

  assert.equal(typeof HANDLERS.collected, 'function', 'воркеру нечем принять отчёт страницы');
  HANDLERS.collected({ label: 'FROG/USDG', usd: 42 });
  assert.equal(shown.length, 1, 'после сбора уведомление обязано прийти');
  assert.match(shown[0].message, /42/, 'в уведомлении должна быть собранная сумма');

  HANDLERS.collected({ label: 'FROG/USDG', why: 'позиций на странице нет' });
  assert.equal(shown.length, 2);
  assert.match(shown[1].message, /позиций на странице нет/);
});

test('пока памп идёт, окно не обнуляется', () => {
  const src = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');
  assert.ok(!/trail\.set\(key, \[\{ at: now, price \}\]\);\s*\/\/ окно начинается заново/.test(src),
    'обнуление окна гасило импульс после первой же проверки');
  assert.ok(/firedAt\.delete\(key\)/.test(src),
    'кончился памп — отметку надо снимать, иначе следующий не посчитается новым');
  assert.ok(/const fresh = !last/.test(src),
    'начало пампа и его продолжение надо различать: уведомлять стоит один раз');
});

test('край диапазона считается от самой границы, а не от ширины леддера', () => {
  const scope = bootWorker();
  const { atEdge } = scope.GHO_WATCH;
  const t = { tops: [200], lows: [100] };

  assert.equal(atEdge(t, 150, 5), null, 'середина диапазона краем не является');
  assert.ok(atEdge(t, 191, 5), 'за 5% до верхней границы — уже край');
  assert.equal(atEdge(t, 189, 5), null, 'а за 6% — ещё нет');
  assert.ok(atEdge(t, 104, 5), 'снизу так же');

  const out = atEdge(t, 210, 5);
  assert.ok(out && out.out === true, 'выход за границу должен отмечаться отдельно');
  assert.match(out.text, /выше диапазона/);

  assert.equal(atEdge({ tops: [], lows: [] }, 150, 5), null, 'без границ края нет');
  assert.ok(atEdge(t, 200, 0), 'нулевой запас — край ровно на границе');

  // Несколько леддеров — несколько верхов. Автоматический край смотрит
  // только на самый верхний: ниже него позиции ещё работают.
  const many = { tops: [200, 400], lows: [] };
  assert.equal(atEdge(many, 195, 5), null, 'у промежуточного верха срабатывать не должен');
  assert.equal(atEdge(many, 250, 5), null, 'и между верхами тоже');
  const top = atEdge(many, 390, 5);
  assert.ok(top, 'дошли до самого верхнего — сработал');
  assert.equal(top.bound, 400);
  const beyond = atEdge(many, 420, 5);
  assert.equal(beyond.out, true, 'выход за самый верхний отмечается отдельно');
});

test('выключенный токен сторож пропускает', async () => {
  const scope = bootWorker();
  const A = '0x' + 'a'.repeat(40);
  const B = '0x' + 'b'.repeat(40);
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  scope.chrome.storage.local.get = async () => ({
    llPairs: { pairs: [
      { chainId: 4663, token0: A, token1: USDG, symbols: 'AAA/USDG', lo: 1, hi: 2, group: 'g1' },
      { chainId: 4663, token0: A, token1: USDG, symbols: 'AAA/USDG', lo: 3, hi: 4, group: 'g2' },
      // пара, где стейбл стоит первым: следить надо всё равно за токеном
      { chainId: 4663, token0: USDG, token1: B, symbols: 'USDG/BBB', lo: 1, hi: 2, group: 'g3' },
    ] },
  });
  const watchedTokens = vm.runInContext('watchedTokens', scope);

  const all = await watchedTokens([]);
  assert.equal(all.length, 2, 'два токена, хотя леддеров три');
  const aaa = all.find((x) => x.addr === A);
  // Массивы приезжают из контекста воркера, поэтому сравниваем содержимое:
  // строгое сравнение цепляется за прототип из чужого realm.
  assert.deepEqual([...aaa.tops], [2, 4], 'у токена столько верхов, сколько у него леддеров');

  // Выключают леддер, а не токен: у токена остаётся второй диапазон.
  const half = await watchedTokens(['robinhood:g1']);
  assert.equal(half.length, 2, 'токен никуда не делся');
  assert.deepEqual([...half.find((x) => x.addr === A).tops], [4],
    'верх выключенного леддера учитываться не должен');

  const one = await watchedTokens(['robinhood:g1', 'robinhood:g2']);
  assert.equal(one.length, 1, 'выключены оба леддера токена — токена в списке нет');
  assert.equal(one[0].addr, B, 'у пары «USDG/BBB» следить надо за BBB, а не за стейблом');
});

test('фисы собираются пока памп идёт, а не после отката', () => {
  const scope = bootWorker();
  const { impulse } = scope.GHO_WATCH;
  // Токен сходил 100 → 60 → 200. Относительно низа окна он и на 160 всё ещё
  // «плюс 167%», но памп кончился, и собирать в падение мы не хотим.
  const points = [{ at: 1, price: 100 }, { at: 2, price: 60 }, { at: 3, price: 200 }];

  assert.equal(impulse(points, 160, 50, 5), null, 'откат на 20% от пика — памп кончился');
  assert.ok(impulse(points, 195, 50, 5), 'у самого пика — собираем');
  assert.ok(impulse(points, 240, 50, 5), 'новый максимум — тем более собираем');
  assert.equal(impulse(points, 199, 50, 0), null, 'нулевой допуск — только на самом пике');
  assert.ok(impulse(points, 160, 50, 50), 'широкий допуск пропускает и откат');

  const hit = impulse(points, 240, 50, 5);
  assert.equal(Math.round(hit.grew), 300, 'рост считается от низа окна');
  assert.match(hit.text, /памп \+300%/, 'причина должна называться словами');
});

test('край выбирается: можно следить только за верхним или только за нижним', () => {
  const scope = bootWorker();
  const { atEdge } = scope.GHO_WATCH;
  const t = { tops: [200], lows: [100] };

  assert.ok(atEdge(t, 195, 5, { hi: true, lo: true }), 'оба края — верх ловится');
  assert.ok(atEdge(t, 102, 5, { hi: true, lo: true }), 'оба края — низ ловится');

  assert.ok(atEdge(t, 195, 5, { hi: true, lo: false }), 'только верх — верх ловится');
  assert.equal(atEdge(t, 102, 5, { hi: true, lo: false }), null, 'только верх — низ игнорируем');

  assert.equal(atEdge(t, 195, 5, { hi: false, lo: true }), null, 'только низ — верх игнорируем');
  assert.ok(atEdge(t, 102, 5, { hi: false, lo: true }), 'только низ — низ ловится');

  assert.equal(atEdge(t, 195, 5, { hi: false, lo: false }), null, 'сняты оба — не срабатывает нигде');
  assert.ok(atEdge(t, 195, 5), 'без указания сторон работают обе');
});

test('ручной уровень срабатывает на пересечении снизу вверх, а не на «стоим выше»', () => {
  const scope = bootWorker();
  const { atLevel } = scope.GHO_WATCH;

  assert.ok(atLevel([100], 95, 105), 'перешагнули уровень — сработало');
  assert.equal(atLevel([100], 105, 110), null,
    'уже стоим выше — второй раз дёргать нельзя, иначе повод вечный');
  assert.equal(atLevel([100], 95, 99), null, 'не дошли — молчим');
  assert.equal(atLevel([100], 110, 95), null, 'падение уровнем тейка не считается');
  assert.ok(atLevel([100], 90, 95) === null && atLevel([100], 90, 101),
    'после возврата под уровень он снова заряжен');

  // Несколько уровней за один шаг — берём верхний из пройденных.
  const hit = atLevel([100, 120, 140], 95, 130);
  assert.equal(hit.level, 120, 'перепрыгнули два — сработал верхний из них');

  assert.equal(atLevel([], 95, 105), null, 'без уровней нечему срабатывать');
  assert.equal(atLevel([100], 0, 105), null, 'без прошлой цены сравнивать не с чем');
});

test('у токена могут быть свои условия пампа, остальное берётся из общих', () => {
  const src = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');
  const tick = src.slice(src.indexOf('async function watchTick'), src.indexOf('function atEdge'));
  assert.ok(tick.includes('(S.pump || {})[key]'), 'условия по токену не читаются');
  assert.ok(/own\.pumpPct > 0 \? own\.pumpPct : S\.pumpPct/.test(tick),
    'незаданное поле должно падать на общее значение');
  assert.ok(tick.includes('winMin * 60000'),
    'окно наблюдения тоже должно быть своим, иначе точки копятся не за тот срок');
  assert.ok(!/const windowMs/.test(src), 'общее окно больше не используется');
});

test('шаг похода на страницу задаётся в секундах, старая настройка в минутах понимается', () => {
  const src = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');
  assert.ok(/quietSec: 60/.test(src), 'по умолчанию минута, но в секундах');
  assert.ok(src.includes('S.quietSec * 1000'), 'шаг должен считаться в секундах');
  assert.ok(/Number\(S\.quietMin\) \|\| 0\) \* 60000/.test(src),
    'старое значение в минутах должно пониматься, иначе шаг слетит в ноль');

  // само правило: 10 секунд — это 10000 мс, а не 600000
  const quietMs = (S) => (isFinite(S.quietSec) ? S.quietSec * 1000 : (Number(S.quietMin) || 0) * 60000);
  assert.equal(quietMs({ quietSec: 10 }), 10000);
  assert.equal(quietMs({ quietSec: 0 }), 0, 'ноль — ходить на каждом опросе');
  assert.equal(quietMs({ quietMin: 1 }), 60000, 'старая минута остаётся минутой');
});

test('все настройки сторожа доезжают от меню до воркера', () => {
  // Забытая настройка не ломает сборку и молча не работает — ловим сверкой.
  const ov = fs.readFileSync(path.join(SRC, 'll', 'overlay.js'), 'utf8');
  const wt = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');
  const push = ov.slice(ov.indexOf('function pushWatch'), ov.indexOf('function save()'));
  const sent = new Set([...push.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));
  const box = wt.slice(wt.indexOf('const WATCH_DEFAULTS'), wt.indexOf('// токен ->'));
  const want = new Set([...box.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));

  const missing = [...want].filter((k) => !sent.has(k));
  assert.deepEqual(missing, [], 'меню не шлёт воркеру: ' + missing.join(', '));
  const extra = [...sent].filter((k) => !want.has(k));
  assert.deepEqual(extra, [], 'воркер не знает про: ' + extra.join(', '));
});

test('когда вкладки нет, сторож открывает её и держит поручение до готовности', () => {
  const src = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');
  assert.ok(/chrome\.tabs\s*\.create\(/.test(src), 'вкладка должна открываться самой');
  assert.ok(src.includes('putInGroup(tab.id)'),
    'свои вкладки надо держать в отдельной группе, чтобы не мешались');
  assert.ok(src.includes('active: false'), 'открывать надо в фоне, не воруя фокус');
  assert.ok(/queueFor\(tab\.id, msg\)/.test(src),
    'сразу слать нечего: страница ещё грузится, поручение надо придержать');
  assert.ok(src.includes('Date.now() - x.at <= 120000'),
    'протухшее поручение выполнять нельзя — цена уже другая');
  assert.ok(src.includes('mine.add(tab.id)') && src.includes('chrome.tabs.remove'),
    'свою вкладку надо за собой закрыть');

  const sw = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8');
  assert.ok(/llReady\(msg, sender\)/.test(sw), 'страница должна уметь объявиться');
  assert.ok(sw.includes('fn(msg, sender)'), 'без sender не понять, какая вкладка объявилась');

  const ov = fs.readFileSync(path.join(SRC, 'll', 'overlay.js'), 'utf8');
  assert.ok(ov.includes("type: 'llReady'"), 'страница не объявляется — поручение не доедет');
  const load = ov.slice(ov.indexOf('async function loadToken'), ov.indexOf('async function loadToken') + 900);
  assert.ok(load.includes('for (let i = 0; i < 40; i++)'),
    'в свежей вкладке разметки ещё нет, её надо дождаться');
});

test('после нажатия жмётся подтверждение, но не что попало', () => {
  const src = fs.readFileSync(path.join(SRC, 'll', 'overlay.js'), 'utf8');
  assert.ok(/function confirmIfAsked/.test(src), 'подтверждение не жмётся');
  const re = /RE_CONFIRM = ([^\n]+)/.exec(src);
  assert.ok(re, 'нет списка допустимых подтверждений');
  const rx = eval(re[1].replace(/;$/, ''));
  for (const ok of ['Confirm', 'Proceed', 'Продолжить', 'Подтвердить']) {
    assert.ok(rx.test(ok), 'должно жаться: ' + ok);
  }
  for (const no of ['Cancel', 'Отмена', 'Close', 'Back', 'Reject']) {
    assert.ok(!rx.test(no), 'жать нельзя: ' + no);
  }
});



test('нажатия идут только через вкладку, а не через их API', () => {
  // Открытого API у сайта нет. Повторять внутренние запросы вслепую —
  // гадание: формат меняется, а ошибки вроде 422 разбирать не по чему.
  const src = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');
  const tick = src.slice(src.indexOf('async function onImpulse'), src.indexOf('async function handOut'));
  assert.ok(!tick.includes('apiCollect('), 'повод обязан идти во вкладку, а не в API');
  const sweep = src.slice(src.indexOf('async function sweepFees'), src.indexOf('async function idsOf'));
  assert.ok(!sweep.includes('apiCollect('), 'сбор по порогу — тоже через вкладку');
  assert.ok(sweep.includes('handOut(tabs'), 'поручение должно уходить вкладке');
  // Раньше сбор по порогу без своей вкладки просто сдавался. Это и был тот
  // случай, когда комиссии копились, а сторож молчал.
  assert.ok(sweep.includes('openAndQueue('), 'без своей вкладки её надо завести, а не сдаться');
});


test('по одному порогу поручение уходит вкладке', async () => {
  const scope = bootWorker();
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const A = '0x' + 'a'.repeat(40);
  scope.chrome.storage.local.get = async () => ({ llStats: {
    url: '/api/v1/pnl/dashboard-stats?wallet=0xw', headers: { Authorization: 'x' }, at: Date.now(),
  } });
  scope.chrome.storage.local.set = async () => {};
  scope.fetch = async () => ({ ok: true, status: 200, json: async () => ({ open_pairs: [
    { chainId: 4663, token0: A, token1: USDG, token0_symbol: 'AAA', token1_symbol: 'USDG',
      token_ids: ['11', '12'], unclaimed_fees_usd: 12.5, ladder_group_id: 'g1' },
    { chainId: 4663, token0: A, token1: USDG, token0_symbol: 'BBB', token1_symbol: 'USDG',
      token_ids: ['13'], unclaimed_fees_usd: 1.2, ladder_group_id: 'g2' },
  ] }) });

  const sent = [];
  scope.chrome.tabs.query = async () => [{ id: 5 }];
  scope.chrome.tabs.sendMessage = (id, msg, cb) => { sent.push(msg); if (cb) cb({ handled: true }); };
  vm.runInContext('mine.add(5)', scope);   // вкладка наша: чужие не годятся

  const sweepFees = vm.runInContext('sweepFees', scope);
  await sweepFees({ feesOn: true, feesSec: 10, minUsd: 5, skip: [] });

  assert.equal(sent.length, 1, 'поручение только по тому леддеру, что перерос порог');
  assert.equal(sent[0].act, 'fees');
  assert.equal(String(sent[0].addr).toLowerCase(), A, 'и по нужному токену');
});

test('порог и выключенные леддеры соблюдаются, сбор не идёт вхолостую', async () => {
  const scope = bootWorker();
  const A = '0x' + 'a'.repeat(40);
  scope.chrome.storage.local.get = async () => ({ llCollect: {
    url: 'https://x/api/v1/execute/v4/batch-collect-fees', method: 'POST',
    headers: { authorization: 'x' }, body: JSON.stringify({ token_ids: [1] }), at: Date.now(),
  } });
  let posts = 0;
  scope.fetch = async (url) => {
    if (String(url).includes('dashboard-stats')) {
      return { ok: true, status: 200, json: async () => ({ open_pairs: [
        { chainId: 4663, token0: A, token_ids: ['11'], unclaimed_fees_usd: 3,
          ladder_group_id: 'g1' },
        { chainId: 4663, token0: A, token_ids: ['12'], unclaimed_fees_usd: 50,
          ladder_group_id: 'g2' },
      ] }) };
    }
    posts += 1;
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const sweepFees = vm.runInContext('sweepFees', scope);

  await sweepFees({ feesOn: true, feesSec: 10, minUsd: 5, skip: ['robinhood:g2'] });
  assert.equal(posts, 0, 'ниже порога — не трогаем, выключенный леддер — тоже');

  await sweepFees({ feesOn: false, feesSec: 10, minUsd: 0, skip: [] });
  assert.equal(posts, 0, 'выключенное правило не должно ничего собирать');
});

test('сообщения вкладкам не роняют промисы в лог расширения', () => {
  const src = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');
  // Без колбэка отказ улетает мимо try/catch и виден в ошибках расширения
  // как «Receiving end does not exist». Вкладка без нашего скрипта — обычное
  // дело, так что это не исключение, а норма.
  const all = (src.match(/chrome\.tabs\.sendMessage\(/g) || []).length;
  const safe = (src.match(/chrome\.tabs\.sendMessage\([^;]*?lastError/g) || []).length;
  assert.equal(all, safe, 'есть отправка во вкладку без колбэка: ' + (all - safe) + ' шт.');

  assert.ok(/chrome\.tabs\s*\.create\([\s\S]{0,160}\)\s*\.catch\(/.test(src),
    'открытие вкладки тоже возвращает промис');
  assert.ok(src.includes('if (made && typeof made.catch'), 'уведомление тоже');
  assert.ok(/typeof r\.catch === "function"/.test(src), 'закрытие вкладки тоже');
});

test('цена берётся из ответа сайта, а не покупается у узла', async () => {
  const scope = bootWorker();
  const A = '0x' + 'a'.repeat(40);
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  scope.chrome.storage.local.get = async () => ({
    ghoRpc: { robinhood: 'https://node.example/rpc' },
    llCollect: {
      url: 'https://x/api/v1/execute/v4/batch-collect-fees', method: 'POST',
      headers: { authorization: 'x' }, body: JSON.stringify({ token_ids: [1] }), at: Date.now(),
    },
  });
  let chainCalls = 0;
  scope.fetch = async (url) => {
    if (String(url).includes('dashboard-stats')) {
      return { ok: true, status: 200, json: async () => ({ open_pairs: [
        { chainId: 4663, token0: A, token1: USDG, token_ids: ['1'],
          unclaimed_fees_usd: 0, current_price: 0.00042, ladder_group_id: 'g1' },
      ] }) };
    }
    chainCalls += 1;
    return { ok: true, status: 200, text: async () => '{}' };
  };

  const sweepFees = vm.runInContext('sweepFees', scope);
  const pricesOf = vm.runInContext('pricesOf', scope);

  await sweepFees({ feesOn: true, feesSec: 10, minUsd: 5, skip: [] });
  // Первый раз цену сайта сверяем с цепью: в каких единицах сайт пишет
  // перевёрнутые пары, заранее неизвестно, а тейки заданы в долларах.
  const got = await pricesOf([{ chain: 'robinhood', addr: A }], 90000);
  assert.equal(got.get('robinhood:' + A), 0.00042, 'цена должна прийти из ответа сайта');

  // А дальше полчаса — только сайт, узлу не платим.
  const before = chainCalls;
  for (let i = 0; i < 5; i++) await pricesOf([{ chain: 'robinhood', addr: A }], 90000);
  assert.equal(chainCalls, before, 'после сверки за такую цену узлу платить не нужно');

  // Токена, которого в дашборде нет, там взять неоткуда — идём к узлу.
  const other = '0x' + 'c'.repeat(40);
  await pricesOf([{ chain: 'robinhood', addr: other }], 90000);
  assert.ok(chainCalls > 0, 'токен без леддера должен читаться из цепи');
});

test('глубина читается только у пулов, где лежат деньги', () => {
  const scope = bootWorker();
  const pickHeavy = vm.runInContext('pickHeavy', scope);
  const pools = [{ poolId: 'a' }, { poolId: 'b' }, { poolId: 'c' }, { poolId: 'd' }, { poolId: 'e' }];

  // 97% денег в двух пулах — остальные читать незачем, но минимум три берём
  const w = { a: 700, b: 280, c: 10, d: 6, e: 4 };
  // Массив приезжает из контекста воркера — сравниваем содержимое.
  const got = [...pickHeavy(pools, w)].map((p) => p.poolId);
  assert.deepEqual(got, ['a', 'b', 'c'], 'должны остаться весомые, вышло ' + got.join(','));

  // деньги размазаны ровно — обрезать нечего
  const even = { a: 200, b: 200, c: 200, d: 200, e: 200 };
  assert.equal(pickHeavy(pools, even).length, 5, 'при ровном распределении режем ничего');

  // весов нет — берём всё, а не пустоту
  assert.equal(pickHeavy(pools, {}).length, 5, 'без весов отбирать нельзя');
});

test('список пулов токена не перечитывается на каждый пересчёт', () => {
  const src = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8');
  assert.ok(/POOLS_TTL = 15 \* 60000/.test(src), 'нет срока жизни у списка пулов');
  assert.ok(src.includes('poolCache.get(ckey)'), 'список пулов не кэшируется');
  const depth = src.slice(src.indexOf('async depth('), src.indexOf('async depth(') + 2200);
  assert.ok(depth.includes('Date.now() - box.at > POOLS_TTL'),
    'перебор всех пулов должен идти только по истечении срока, а не каждый раз');
  assert.ok(depth.includes('pickHeavy(box.all, box.weights)'),
    'на повторных пересчётах читать надо только весомые пулы');
});

test('сторож доводит дело до поручения странице', async () => {
  const scope = bootWorker();
  const RF = '0x' + '3'.repeat(40);
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const KEY = 'robinhood:' + RF;

  const store = {
    ghoRpc: { robinhood: 'https://node.example/rpc' },
    llPairs: { pairs: [{ chainId: 4663, token0: RF, token1: USDG, symbols: 'RF/USDG',
                         ids: ['1', '2'], lo: 0.001, hi: 0.003, group: 'g1' }] },
    llWatch: { on: true, feesOn: false, pumpOn: false, edgeOn: false,
               minUsd: 0, quietSec: 0, skip: [],
               levels: { [KEY]: [{ v: 0.002, unit: 'price', act: 'fees' }] } },
  };
  scope.chrome.storage.local.get = async (k) => (typeof k === 'string' ? { [k]: store[k] } : store);

  const sent = [];
  scope.chrome.tabs.query = async () => [{ id: 7 }];
  scope.chrome.tabs.sendMessage = (id, msg, cb) => { sent.push(msg); if (cb) cb({ handled: true, did: 'collected' }); };
  vm.runInContext('mine.add(7)', scope);

  // Цену подменяем: ведём её через уровень снизу вверх.
  let price = 0;
  vm.runInContext('pricesOf = async (tokens) => new Map(tokens.map((t) => '
    + '[t.chain + ":" + t.addr, globalThis.__price]));', scope);
  const watchTick = vm.runInContext('watchTick', scope);

  for (const p of [0.0015, 0.0019]) { scope.__price = p; await watchTick(); }
  assert.equal(sent.length, 0, 'ниже уровня срабатывать нечему');

  scope.__price = 0.0021;            // пересекли снизу вверх
  await watchTick();
  assert.equal(sent.length, 1, 'пересечение уровня обязано дать поручение странице');
  assert.equal(sent[0].type, 'impulse');
  assert.equal(String(sent[0].addr).toLowerCase(), RF);
  assert.match(sent[0].reason, /цена дошла до/);

  scope.__price = 0.0025;            // уже выше — второй раз не дёргаем
  await watchTick();
  assert.equal(sent.length, 1, 'повторно по тому же уровню дёргать нельзя');
});

test('сторож докладывает, чем кончилась попытка собрать', async () => {
  const scope = bootWorker();
  const A = '0x' + 'a'.repeat(40);
  scope.chrome.storage.local.get = async () => ({ llStats: {
    url: '/api/v1/pnl/dashboard-stats?wallet=0xw', headers: { Authorization: 'x' }, at: Date.now(),
  } });
  scope.chrome.storage.local.set = async () => {};
  scope.fetch = async () => ({ ok: true, status: 200, json: async () => ({ open_pairs: [
    { chainId: 4663, token0: A, token_ids: ['11'], unclaimed_fees_usd: 40,
      token0_symbol: 'AAA', token1_symbol: 'USDG', ladder_group_id: 'g1' },
  ] }) });

  let answer = { handled: true, did: 'collected', usd: 40 };
  scope.chrome.tabs.query = async () => [{ id: 5 }];
  scope.chrome.tabs.sendMessage = (id, msg, cb) => { if (cb) cb(answer); };
  vm.runInContext('mine.add(5)', scope);

  const sweepFees = vm.runInContext('sweepFees', scope);
  const watchStatus = vm.runInContext('watchStatus', scope);

  await sweepFees({ feesOn: true, feesSec: 10, minUsd: 5, skip: [] });
  const good = watchStatus().lastAct;
  assert.ok(good, 'после попытки должен остаться след');
  assert.equal(good.ok, true);
  assert.equal(good.how, 'через вкладку');
  assert.equal(good.usd, 40, 'сумма должна быть в отчёте');
  assert.equal(good.did, 'collected');

  // Страница взялась, но фисов у неё меньше порога — это НЕ сбор. Раньше
  // именно тут в истории появлялось «✓ собрал $134».
  answer = { handled: true, did: 'wait', usd: 3 };
  vm.runInContext('feesAt = 0;', scope);
  await sweepFees({ feesOn: true, feesSec: 10, minUsd: 5, skip: [] });
  assert.equal(watchStatus().lastAct.ok, false, 'ожидание порога — не успех');
  assert.equal(watchStatus().lastAct.did, 'wait');

  // Нажала, но пересчёт не показал, что фисы ушли, — тоже не «собрал».
  answer = { handled: true, did: 'sent', usd: 40 };
  vm.runInContext('feesAt = 0;', scope);
  await sweepFees({ feesOn: true, feesSec: 10, minUsd: 5, skip: [] });
  assert.equal(watchStatus().lastAct.ok, false, 'неподтверждённый сбор — не успех');

  // вкладка отказалась — это тоже обязано быть видно
  answer = { handled: false };
  vm.runInContext('feesAt = 0;', scope);
  await sweepFees({ feesOn: true, feesSec: 10, minUsd: 5, skip: [] });
  assert.equal(watchStatus().lastAct.ok, false, 'отказ нельзя выдавать за успех');
});

test('список леддеров обновляется сам, закрытые не остаются навсегда', async () => {
  const scope = bootWorker();
  const A = '0x' + 'a'.repeat(40);
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const store = { llPairs: { pairs: [
    { token0: '0x' + 'f'.repeat(40), symbols: 'СТАРЫЙ/USDG', ids: ['1'], group: 'old' },
  ] } };
  scope.chrome.storage.local.get = async (k) => (typeof k === 'string' ? { [k]: store[k] } : store);
  scope.chrome.storage.local.set = async (box) => Object.assign(store, box);

  const savePairs = vm.runInContext('savePairs', scope);
  await savePairs([
    { chainId: 4663, token0: A, token1: USDG, token0_symbol: 'AAA', token1_symbol: 'USDG',
      token_ids: ['11', '12'], price_lower: 1, price_upper: 2, ladder_group_id: 'g1' },
    // без позиций — такой леддер в список не нужен
    { chainId: 4663, token0: A, token_ids: [], ladder_group_id: 'g2' },
  ]);

  const now = store.llPairs.pairs;
  assert.equal(now.length, 1, 'остаётся только то, что реально открыто');
  assert.equal(now[0].symbols, 'AAA/USDG');
  assert.deepEqual([...now[0].ids], ['11', '12']);
  assert.ok(!now.some((p) => p.group === 'old'), 'закрытый леддер обязан исчезнуть');
});

test('проверка автосбора честно докладывает и ничего не собирает', async () => {
  const scope = bootWorker();
  const A = '0x' + 'a'.repeat(40);
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const store = { llWatch: { skip: ['robinhood:g3'] } };
  let posts = 0;
  scope.chrome.storage.local.set = async (b) => Object.assign(store, b);
  scope.fetch = async (url) => {
    if (String(url).includes('dashboard-stats')) {
      return { ok: true, status: 200, json: async () => ({ open_pairs: [
        { chainId: 4663, token0: A, token1: USDG, token0_symbol: 'AAA', token1_symbol: 'USDG',
          token_ids: ['1'], unclaimed_fees_usd: 46.21, ladder_group_id: 'g1' },
        { chainId: 4663, token0: A, token1: USDG, token0_symbol: 'BBB', token1_symbol: 'USDG',
          token_ids: ['2'], unclaimed_fees_usd: 0.3, ladder_group_id: 'g2' },
        { chainId: 4663, token0: A, token1: USDG, token0_symbol: 'CCC', token1_symbol: 'USDG',
          token_ids: ['3'], unclaimed_fees_usd: 99, ladder_group_id: 'g3' },
      ] }) };
    }
    posts += 1;
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const dryRun = vm.runInContext('dryRun', scope);

  // без подсмотренного запроса — честный отказ, а не молчание
  store.llCollect = undefined;
  scope.chrome.storage.local.get = async (k) => (typeof k === 'string' ? { [k]: store[k] } : store);
  const nope = await dryRun(5);
  assert.equal(nope.access, false);
  assert.match(nope.error, /Dashboard/, 'доступ берётся с дашборда — так и надо сказать');

  // Доступ к списку даёт запомненный запрос дашборда, а сбор — запомненный
  // запрос сбора. Это разные вещи, и проверка обязана различать их.
  store.llStats = { url: '/api/v1/pnl/dashboard-stats?wallet=0xabc',
                    headers: { Authorization: 'x' }, at: Date.now() };
  store.llCollect = { url: 'https://x/api/v1/execute/v4/batch-collect-fees',
                      headers: { authorization: 'x' }, body: '{"token_ids":[1]}', at: Date.now() };
  const out = await dryRun(5);
  assert.equal(out.access, true, 'доступ к списку должен определиться');
  assert.equal(out.canCollect, true, 'и возможность собрать — тоже');
  assert.equal(out.pairs.length, 3);
  assert.equal(out.pairs.find((p) => p.label === 'AAA/USDG').would, true, '$46 выше порога');
  assert.equal(out.pairs.find((p) => p.label === 'BBB/USDG').would, false, '$0.3 ниже порога');
  assert.equal(out.pairs.find((p) => p.label === 'CCC/USDG').off, true, 'выключенный леддер помечен');
  assert.equal(out.pairs.find((p) => p.label === 'CCC/USDG').would, false, 'и собираться не должен');
  assert.equal(posts, 0, 'проверка не имеет права ничего собрать');
  assert.ok(store.llPairs, 'заодно обновляет список леддеров');
});

test('причина отказа API называется словами, а не «мог протухнуть»', async () => {
  const scope = bootWorker();
  const base = { url: '/api/v1/execute/v4/batch-collect-fees', method: 'POST',
                 body: '{"token_ids":[1]}', at: Date.now() };
  const apiFees = vm.runInContext('apiFees', scope);
  const why = () => vm.runInContext('apiWhy', scope);

  scope.chrome.storage.local.get = async () => ({ llCollect: { ...base, headers: {} } });
  assert.equal(await apiFees(), null);
  assert.match(why(), /нет заголовка авторизации/, 'без авторизации так и надо сказать');

  scope.chrome.storage.local.get = async () => ({
    llCollect: { ...base, headers: { authorization: 'x' } } });
  scope.fetch = async () => ({ ok: false, status: 401, text: async () => '' });
  assert.equal(await apiFees(), null);
  assert.match(why(), /протух \(401\)/, 'протухший доступ надо назвать точно');

  scope.fetch = async () => ({ ok: false, status: 500, text: async () => '' });
  await apiFees();
  assert.match(why(), /500/, 'код ошибки должен попадать в отчёт');

  scope.fetch = async () => { throw new Error('сеть недоступна'); };
  await apiFees();
  assert.match(why(), /запрос не ушёл/, 'сетевую ошибку тоже надо назвать');
});

test('относительный адрес запроса не ломает обращение из воркера', async () => {
  const scope = bootWorker();
  let asked = '';
  scope.chrome.storage.local.get = async () => ({ llCollect: {
    // сайт зовёт свой API относительным адресом — хоста в запросе нет
    url: '/api/v1/execute/v4/batch-collect-fees', method: 'POST',
    headers: { authorization: 'x' }, body: '{"token_ids":[1]}', at: Date.now(),
  } });
  scope.fetch = async (u) => {
    asked = String(u);
    return { ok: true, status: 200, json: async () => ({ open_pairs: [] }) };
  };
  const apiFees = vm.runInContext('apiFees', scope);
  await apiFees();
  assert.equal(asked, 'https://liquidityladder.it.com/api/v1/pnl/dashboard-stats',
    'адрес должен достраиваться до полного, иначе запрос не соберётся');
});

test('список берётся повтором того же запроса дашборда — с кошельком в адресе', async () => {
  const scope = bootWorker();
  let asked = '';
  scope.chrome.storage.local.get = async () => ({ llStats: {
    // ровно то, что шлёт сайт: адрес с кошельком и заголовок авторизации
    url: '/api/v1/pnl/dashboard-stats?wallet=0x1111111111111111111111111111111111111111',
    headers: { Authorization: 'Bearer …', 'Content-Type': 'application/json' },
    at: Date.now(),
  } });
  scope.fetch = async (u, init) => {
    asked = String(u);
    assert.ok(init.headers.Authorization, 'авторизацию терять нельзя');
    return { ok: true, status: 200, json: async () => ({ open_pairs: [] }) };
  };
  const apiFees = vm.runInContext('apiFees', scope);
  const got = await apiFees();

  assert.ok(Array.isArray(got), 'список должен прийти');
  assert.match(asked, /wallet=0x1111/, 'без кошелька в адресе сайт список не отдаёт');
  assert.match(asked, /^https:\/\/liquidityladder\.it\.com\//, 'адрес достраивается до полного');
});

test('ключ токена всегда в нижнем регистре', () => {
  // GMGN отдаёт адрес в ссылках в смешанном регистре, а сайт и цепь — в
  // нижнем. Без приведения один токен получал два ключа, и кэши расходились:
  // ступени лежали под одним, а искали их под другим.
  const src = fs.readFileSync(path.join(SRC, 'll', 'overlay.js'), 'utf8');
  const m = /const keyOf = \(t\) => ([^;]+);/.exec(src);
  assert.ok(m, 'keyOf не нашёлся');
  assert.ok(m[1].includes('toLowerCase'), 'ключ строится без нижнего регистра: ' + m[1]);

  const bad = [];
  for (const line of src.split('\n')) {
    if (!/chain \+ ['"][:/]['"] \+ /.test(line)) continue;
    if (line.includes('toLowerCase') || line.includes('const keyOf')) continue;
    // «low» — уже приведённый адрес, он объявлен строкой выше
    if (/\+ low\b/.test(line)) continue;
    bad.push(line.trim().slice(0, 60));
  }
  assert.deepEqual(bad, [], 'ключ строится без нижнего регистра: ' + bad.join(' | '));
});

test('каждое сообщение странице и воркеру кто-то принимает', () => {
  const ov = fs.readFileSync(path.join(SRC, 'll', 'overlay.js'), 'utf8');
  const sw = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8');
  const wt = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');

  // страница -> воркер
  const sent = new Set([...ov.matchAll(/sendMessage\(\s*\{\s*type:\s*'(\w+)'/g)].map((m) => m[1]));
  const handlers = new Set(
    [...sw.matchAll(/^\s{2}(?:async\s+)?(\w+)\(/gm)].map((m) => m[1]),
  );
  const lost = [...sent].filter((t) => !handlers.has(t));
  assert.deepEqual(lost, [], 'воркер не принимает: ' + lost.join(', '));

  // и наоборот: обработчик без отправителя — мёртвый код
  // Запрашивать обработчик может не только оверлей, но и панель на GMGN.
  const pn = fs.readFileSync(path.join(SRC, 'panel.js'), 'utf8');
  const lp = fs.readFileSync(path.join(SRC, 'lp.js'), 'utf8');   // карточка LP на GMGN
  const sc = fs.readFileSync(path.join(SRC, 'screener.js'), 'utf8');   // страница-скринер
  const asked = (name) => ov.includes("'" + name + "'")
    || pn.includes("'" + name + "'")
    || lp.includes("'" + name + "'")
    || sc.includes("'" + name + "'")
    || wt.includes('"' + name + '"');
  const dead = [...handlers].filter((h) => !asked(h));
  assert.deepEqual(dead, [], 'обработчики никто не зовёт: ' + dead.join(', '));

  // воркер -> страница
  const toPage = new Set([...wt.matchAll(/type:\s*"(\w+)"/g)].map((m) => m[1]))
    .difference ? null : [...new Set([...wt.matchAll(/type:\s*"(\w+)"/g)].map((m) => m[1]))];
  for (const t of toPage) {
    if (t === 'basic') continue;                 // это тип уведомления Chrome
    assert.ok(
      ov.includes("msg.type === '" + t + "'") || ov.includes("msg.type !== '" + t + "'"),
      'страница не слушает: ' + t,
    );
  }
});





test('нулевой пул распознаётся и ответ кэшируется', async () => {
  const scope = bootWorker();
  const T = '0x' + 'b'.repeat(40);
  const store = { ghoRpc: { robinhood: 'https://node/rpc' } };
  scope.chrome.storage.local.get = async (k) => (typeof k === 'string' ? { [k]: store[k] } : store);
  scope.chrome.storage.local.set = async (b) => Object.assign(store, b);

  let logsAsked = 0;
  scope.GHO_CHAIN = {
    SEL: { liquidity: '0x' },
    poolsOfToken: async () => {
      logsAsked += 1;
      return [
        { poolId: '0x01', fee: 0, hooks: '0x1111', currency0: T, currency1: '0xu' },
        { poolId: '0x02', fee: 5000, hooks: '0x' + '0'.repeat(40), currency0: T, currency1: '0xu' },
      ];
    },
    rpcBatch: async () => ['0x64'],       // в нулевом пуле есть ликвидность
  };
  const HANDLERS = vm.runInContext('HANDLERS', scope);

  const r = await HANDLERS.zeroPool({ chain: 'robinhood', addr: T });
  assert.equal(r.ok, true);
  assert.equal(r.has, true, 'пул с нулевой комиссией должен найтись');
  assert.equal(r.live, 1, 'и он живой');
  assert.equal(r.hooked, 0, 'хук в примере не лаунчпадный');
  assert.equal(r.bare, 1, 'значит пул заведён руками — это и есть подозрительный случай');

  // второй раз лезть в цепь незачем: в списке таких токенов десятки
  const again = await HANDLERS.zeroPool({ chain: 'robinhood', addr: T });
  assert.equal(again.has, true);
  assert.equal(logsAsked, 1, 'ответ обязан браться из кэша');
});

test('пул лаунчпада и пул, заведённый руками, различаются', async () => {
  const scope = bootWorker();
  const T = '0x' + 'c'.repeat(40);
  const LAUNCHPAD = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
  const store = { ghoRpc: { robinhood: 'https://node/rpc' } };
  scope.chrome.storage.local.get = async (k) => (typeof k === 'string' ? { [k]: store[k] } : store);
  scope.chrome.storage.local.set = async (b) => Object.assign(store, b);
  scope.GHO_CHAIN = {
    SEL: { liquidity: '0x' },
    poolsOfToken: async () => [
      { poolId: '0x01', fee: 0, hooks: LAUNCHPAD, currency0: T, currency1: '0xu' },
      { poolId: '0x02', fee: 0, hooks: '0x' + '0'.repeat(40), currency0: T, currency1: '0xu' },
      { poolId: '0x03', fee: 5000, hooks: '0x' + '0'.repeat(40), currency0: T, currency1: '0xu' },
    ],
    rpcBatch: async () => ['0x64', '0x0'],
  };
  const HANDLERS = vm.runInContext('HANDLERS', scope);
  const r = await HANDLERS.zeroPool({ chain: 'robinhood', addr: T });

  assert.equal(r.hooked, 1, 'один пул лаунчпадный');
  assert.equal(r.bare, 1, 'и один заведён руками — вот он и подозрителен');
  assert.equal(r.live, 1, 'живой из них только первый');
});

test('нажатия идут только через вкладку, а не через их API', () => {
  // Открытого API у сайта нет. Повторять его внутренние запросы вслепую —
  // гадание: формат меняется, а ошибки вроде 422 разбирать не по чему.
  const src = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');
  assert.ok(!/function apiCollect/.test(src), 'сбор через API должен быть убран целиком');
  assert.ok(!/apiCollect\(/.test(src), 'и ни одного вызова не остаться');

  const sweep = src.slice(src.indexOf('async function sweepFees'), src.indexOf('function closeMine'));
  assert.ok(sweep.includes('handOut(tabs'), 'сбор по порогу должен поручаться вкладке');
  // Раньше сбор по порогу без своей вкладки просто сдавался. Это и был тот
  // случай, когда комиссии копились, а сторож молчал.
  assert.ok(sweep.includes('openAndQueue('), 'без своей вкладки её надо завести, а не сдаться');

  const imp = src.slice(src.indexOf('async function onImpulse'), src.indexOf('async function apiFees'));
  assert.ok(imp.includes('handOut(tabs, msg)'), 'повод тоже идёт во вкладку');

  // а чтение списка и сумм по-прежнему без вкладки — оно ничего не нажимает
  assert.ok(/async function apiFees/.test(src), 'читать список можно и без вкладки');
});

test('не взялась ни одна вкладка — сторож открывает свою', () => {
  const src = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function onImpulse'), src.indexOf('function putInGroup'));
  // Раньше при отказе всех вкладок сторож просто сдавался и писал «открой сам».
  assert.ok(/if \(taken\) \{\s*recordOutcome\(/.test(fn), 'взялась — на этом и всё');
  assert.ok(!fn.includes('Ни одна вкладка не смогла'),
    'сдаваться нельзя: надо завести свою вкладку и сделать там');
  assert.ok(fn.indexOf('if (taken) {') < fn.indexOf('.create({ url: SITE'),
    'своя вкладка открывается только после отказа остальных');

  const grp = src.slice(src.indexOf('async function putInGroup'), src.indexOf('// Вкладки, открытые сторожем'));
  assert.ok(grp.includes('tabGroups.update'), 'группу надо подписать, иначе непонятно, чья она');
  assert.ok(grp.includes('collapsed: true'), 'и свернуть, чтобы не занимала место');
  assert.ok(grp.includes('groupId = 0;'), 'если группировать нельзя — работаем без группы');
});

test('автосбор у верха не глушится отмеченными краями — у него своя галка', () => {
  // Раньше отмеченный край выключал автоматический: отметка от прошлой
  // лесенки BLAST (верх 0.00282) молча глушила сбор у верха новой (0.00385).
  const src = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');
  const tick = src.slice(src.indexOf('async function watchTick'), src.indexOf('function atEdge'));
  assert.ok(!/S\.edgeOn === false \|\| picked/.test(tick), 'отметки не должны выключать край');
  assert.ok(/S\.edgeOn === false\s*\?\s*null/.test(tick), 'край решает только своя галка');
});

test('вкладки не мелькают при частых открытиях и закрытиях позиций', () => {
  const src = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function keepTabs'), src.indexOf('// Вкладки, открытые сторожем'));
  assert.ok(/OPEN_AFTER = 30000/.test(fn), 'вкладку заводим не мгновенно');
  assert.ok(/CLOSE_AFTER = 3 \* 60000/.test(fn), 'и закрываем не мгновенно');
  assert.ok(fn.includes("now - (seenSince.get(key) || now) < OPEN_AFTER) continue"),
    'токен должен побыть открытым, прежде чем заводить вкладку');
  assert.ok(fn.includes("now - (goneSince.get(key) || now) < CLOSE_AFTER) continue"),
    'и пропавшим, прежде чем закрывать');
  assert.ok(fn.includes('tabOf.size >= cap'), 'число своих вкладок должно быть ограничено');

  // отведённую токену вкладку после дела не закрываем — она ещё нужна
  const close = src.slice(src.indexOf('function closeMine'), src.indexOf('function flushPending'));
  assert.ok(close.includes('for (const id of tabOf.values()) if (id === tabId) return;'),
    'иначе вкладка закроется сразу после сбора и заведётся заново');
});

test('поручение уходит только в свои вкладки', () => {
  const src = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function handOut'), src.indexOf('function tell'));
  assert.ok(fn.includes('tabs.filter((tab) => mine.has(tab.id))'),
    'вкладки человека не должны попадать в раздачу вовсе');
  assert.ok(fn.includes('{ ...msg, own: true }'), 'страница должна знать, что вкладка наша');

  const ov = fs.readFileSync(path.join(SRC, 'll', 'overlay.js'), 'utf8');
  const imp = ov.slice(ov.indexOf('async function onImpulse'), ov.indexOf('async function onImpulse') + 500);
  assert.ok(imp.includes("msg.own !== true && !msg.dry"),
    'чужая вкладка обязана отказываться сразу, до всякой проверки токена');
});

test('сторож помнит несколько последних действий, а не одно', () => {
  const scope = bootWorker();
  const remember = vm.runInContext('remember', scope);
  const watchStatus = vm.runInContext('watchStatus', scope);

  for (let i = 1; i <= 8; i++) remember({ at: i, what: 'т' + i, ok: i % 2 === 0 });
  const st = watchStatus();

  assert.equal(st.log.length, 6, 'история не должна расти без конца');
  assert.equal(st.log[0].what, 'т8', 'свежее — первым');
  assert.equal(st.lastAct.what, 'т8', 'последнее действие тоже на месте');
  assert.ok(!st.log.some((x) => x.what === 'т1'), 'старое выпадает');
});

test('вкладок столько, сколько токенов, а не шесть', async () => {
  const scope = bootWorker();
  let made = 0;
  scope.chrome.tabs.create = async () => ({ id: 100 + made++ });
  scope.chrome.storage.local.set = async () => {};
  const keepTabs = vm.runInContext('keepTabs', scope);

  const tokens = Array.from({ length: 9 }, (_, i) => ({
    chain: 'robinhood', addr: '0x' + String(i).repeat(40), label: 'T' + i,
  }));
  await keepTabs(tokens, { keepTabs: true, maxTabs: 0 }, true);
  assert.equal(made, 9, '0 в настройках — по вкладке на каждый токен');

  // А заданный руками предел соблюдается.
  const scope2 = bootWorker();
  let made2 = 0;
  scope2.chrome.tabs.create = async () => ({ id: 200 + made2++ });
  scope2.chrome.storage.local.set = async () => {};
  await vm.runInContext('keepTabs', scope2)(tokens, { keepTabs: true, maxTabs: 3 }, true);
  assert.equal(made2, 3);
  assert.match(vm.runInContext('tabTrouble', scope2), /предел 3/, 'нехватку надо назвать');
});

test('аварийный потолок вкладок есть даже без предела', () => {
  const scope = bootWorker();
  const tabCap = vm.runInContext('tabCap', scope);
  assert.equal(tabCap({ maxTabs: 0 }), 40);
  assert.equal(tabCap({ maxTabs: 500 }), 40, 'ошибка в узнавании вкладок не должна плодить их без конца');
  assert.equal(tabCap({ maxTabs: 4 }), 4);
});


test('перевёрнутая цена сайта узнаётся и разворачивается', () => {
  const scope = bootWorker();
  const orient = vm.runInContext('orient', scope);
  assert.equal(orient(0.00042, 0.00040), 1, 'совпадает — читаем как есть');
  assert.equal(orient(1 / 0.00042, 0.00042), -1, 'USDG за токен — разворачиваем');
  assert.equal(orient(5, 0.00042), 0, 'не совпадает никак — сайту не верим');
});

test('разные источники цены не дают ложного пересечения уровня', async () => {
  const scope = bootWorker();
  const A = '0x' + 'a'.repeat(40);
  const key = 'robinhood:' + A;
  // Уровень на закрытие по 0.005. Прошлая цена — 0.001 из цепи, новая —
  // 200 от сайта, которую сверить было не с чем. Это не рост в 200 000
  // раз, а разные единицы, и закрывать тут нечего.
  vm.runInContext(`lastPx.set(${JSON.stringify(key)}, { price: 0.001, src: 'usd', at: Date.now() })`, scope);
  vm.runInContext(`srcOf.set(${JSON.stringify(key)}, 'site')`, scope);
  vm.runInContext(`sitePrice.set(${JSON.stringify(key)}, { price: 200, at: Date.now() })`, scope);
  vm.runInContext(`siteTrust.set(${JSON.stringify(key)}, { k: 1, sure: false, at: Date.now() })`, scope);

  const fired = [];
  scope.onImpulse = async (t, why) => { fired.push(why); };
  vm.runInContext('onImpulse = (...a) => globalThis.onImpulse(...a)', scope);
  scope.chrome.storage.local.get = async () => ({
    llWatch: { on: true, pumpOn: false, edgeOn: false,
               levels: { [key]: [{ v: 0.005, unit: 'price', act: 'close' }] } },
    llPairs: { pairs: [{ chainId: 4663, token0: A, token1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
                         ids: ['1'], lo: 1, hi: 2, group: 'g' }] },
  });
  scope.chrome.storage.local.set = async () => {};
  await vm.runInContext('watchTick', scope)();
  assert.equal(fired.length, 0, 'смена источника не должна закрывать позиции');
});

test('прошлая цена переживает сон воркера, и тейк не пропадает', async () => {
  const scope = bootWorker();
  const A = '0x' + 'a'.repeat(40);
  const key = 'robinhood:' + A;
  const store = { ghoLastPx: { [key]: { price: 0.004, src: 'usd', at: Date.now() - 60000 } } };
  scope.chrome.storage.session = {
    get: async (k) => ({ [k]: store[k] }),
    set: async (box) => Object.assign(store, box),
  };
  await vm.runInContext('loadLastPx', scope)();
  const was = vm.runInContext(`lastPx.get(${JSON.stringify(key)})`, scope);
  assert.equal(was.price, 0.004, 'после пробуждения прошлая цена должна быть на месте');

  const atLevel = vm.runInContext('atLevel', scope);
  const hit = atLevel([{ v: 0.005, unit: 'price', act: 'close' }], was.price, 0.006, 0);
  assert.ok(hit && hit.act === 'close', 'пересечение сквозь сон должно засчитаться');
});

test('два леддера одного токена — один сбор, а не два', async () => {
  const scope = bootWorker();
  const A = '0x' + 'a'.repeat(40);
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  scope.chrome.storage.local.get = async () => ({ llStats: {
    url: '/api/v1/pnl/dashboard-stats?wallet=0xw', headers: { Authorization: 'x' }, at: Date.now(),
  } });
  scope.chrome.storage.local.set = async () => {};
  scope.fetch = async () => ({ ok: true, status: 200, json: async () => ({ open_pairs: [
    { chainId: 4663, token0: A, token1: USDG, token_ids: ['1'], unclaimed_fees_usd: 30, ladder_group_id: 'g1' },
    { chainId: 4663, token0: A, token1: USDG, token_ids: ['2'], unclaimed_fees_usd: 20, ladder_group_id: 'g2' },
  ] }) });
  const sent = [];
  scope.chrome.tabs.query = async () => [{ id: 5 }];
  scope.chrome.tabs.sendMessage = (id, msg, cb) => { sent.push(msg); if (cb) cb({ handled: true, did: 'collected' }); };
  vm.runInContext('mine.add(5)', scope);

  await vm.runInContext('sweepFees', scope)({ feesOn: true, feesSec: 10, minUsd: 5, skip: [] });
  assert.equal(sent.length, 1, 'страница собирает весь токен разом — второй сбор лишний');
});

test('выключенный и снова включённый сторож оживает', async () => {
  const scope = bootWorker();
  let on = false;
  let ticks = 0;
  scope.chrome.storage.local.get = async () => ({ llWatch: { on, everySec: 'abc' } });
  vm.runInContext('watchTick = async () => { globalThis.__ticks = (globalThis.__ticks || 0) + 1; }', scope);
  const loop = vm.runInContext('loop', scope);
  // Воркер при загрузке сам запускает цикл — дожидаемся, пока тот отработает.
  await new Promise((r) => setTimeout(r, 20));

  await loop();                                   // выключен — ничего
  assert.equal(vm.runInContext('ticking', scope), false, 'флаг прохода обязан сниматься и при выключенном');
  on = true;
  await loop();                                   // включили — должен пройти
  ticks = scope.__ticks || 0;
  assert.equal(ticks, 1, 'после включения цикл обязан пойти');
  // Следующий проход назначен с нормальной паузой, а не setTimeout(NaN).
  vm.runInContext('ticking = true', scope);       // гасим продолжение, чтобы тест не крутился
});

test('вкладок не больше, чем токенов с позициями', async () => {
  const scope = bootWorker();
  let made = 0;
  const removed = [];
  scope.chrome.tabs.create = async () => ({ id: 300 + made++ });
  scope.chrome.tabs.remove = (id) => { removed.push(id); return Promise.resolve(); };
  scope.chrome.storage.local.set = async () => {};
  const A = '0x' + 'a'.repeat(40);
  const B = '0x' + 'b'.repeat(40);

  // У A позиция, у B только тейк — вкладка нужна одна.
  const withLevels = vm.runInContext('withLevels', scope);
  const tokens = withLevels([{ chain: 'robinhood', addr: A, label: 'A', tops: [2], lows: [1] }],
                            { ['robinhood:' + B]: [{ v: 5 }] });
  await vm.runInContext('keepTabs', scope)(tokens.filter((t) => !t.levelsOnly),
                                            { keepTabs: true, maxTabs: 0 }, true);
  assert.equal(made, 1, 'токену с одним тейком вкладка не положена');

  // Поручение по A при занятой вкладке A не открывает вторую под тот же токен.
  vm.runInContext('readyAt.set(300, Date.now())', scope);
  const opened = await vm.runInContext('openAndQueue', scope)(
    { chain: 'robinhood', addr: A, type: 'impulse' }, 'A', 'тест');
  assert.equal(made, 1, 'вторая вкладка под тот же токен — лишняя');
  assert.equal(opened, false);

  // Ничейная своя вкладка (хвост прошлой версии) закрывается сама.
  vm.runInContext('mine.add(999); bornAt.set(999, Date.now() - 5 * 60000)', scope);
  await vm.runInContext('keepTabs', scope)(tokens.filter((t) => !t.levelsOnly),
                                            { keepTabs: true, maxTabs: 0 });
  assert.ok(removed.includes(999), 'лишняя своя вкладка должна закрыться');
  assert.ok(!removed.includes(300), 'вкладку живой позиции не трогаем');
});

test('мёртвый пул (как у SWARM) цены не даёт и тейков не дёргает', async () => {
  const scope = bootWorker();
  const deadPool = vm.runInContext('deadPool', scope);
  // Ровно то, что было в цепи у пула 0x0ec2…: тик 887271, ликвидности 0.
  assert.equal(deadPool(887271n, '0x0'), true, 'тик у предела — цены нет');
  assert.equal(deadPool(-350000n, '0x0'), true, 'ликвидности у цены нет — цены нет');
  assert.equal(deadPool(-350000n, '0x10'), false, 'живой пул');

  const sanePrice = vm.runInContext('sanePrice', scope);
  assert.equal(sanePrice(3.4022276455660783e+50), false, 'цена сайта по SWARM — поломка, не рынок');
  assert.equal(sanePrice(0.000823), true);

  // Цена сайта 3.4·10⁵⁰, сверить не с чем — в ход идти не должна.
  const A = '0x' + 'a'.repeat(40);
  const key = 'robinhood:' + A;
  vm.runInContext(`sitePrice.set(${JSON.stringify(key)}, { price: 3.4e50, at: Date.now() })`, scope);
  vm.runInContext(`siteTrust.set(${JSON.stringify(key)}, { k: 1, sure: false, at: Date.now() })`, scope);
  const got = await vm.runInContext('pricesOf', scope)([{ chain: 'robinhood', addr: A }], 90000);
  assert.ok(!got.get(key), 'безумная цена сайта не должна становиться ценой токена');
});

test('касание уровня между двумя замерами засчитывается по сделкам пула', async () => {
  const scope = bootWorker();
  const A = '0x' + 'a'.repeat(40);
  const key = 'robinhood:' + A;
  const PID = '0x' + '1'.repeat(64);
  // Пул уже выбран: токен — currency0, у обоих 18 знаков.
  vm.runInContext(`pricePool.set(${JSON.stringify(key)}, { pool: { poolId: '${PID}' }, d0: 18, d1: 18, zero: true,
    net: { rpc: 'https://node', poolManager: '0xpm' }, at: Date.now() })`, scope);
  vm.runInContext(`srcOf.set(${JSON.stringify(key)}, 'usd')`, scope);
  const tickFor = (p) => Math.round(Math.log(p) / Math.log(1.0001));
  const word = (n) => (BigInt.asUintN(256, BigInt(n))).toString(16).padStart(64, '0');
  const swapData = (p) => '0x' + word(0) + word(0) + word(0) + word(0) + word(tickFor(p)) + word(0);
  let head = 1000;
  vm.runInContext('GHO_CHAIN.rpc = async () => "0x" + globalThis.__head.toString(16)', scope);
  vm.runInContext(`GHO_CHAIN.rpcMany = async (url, calls) => calls.map(() => [
    { data: '${swapData(1.2)}' }, { data: '${swapData(0.9)}' },
    { data: '0x' + '0'.repeat(256) + (887271n).toString(16).padStart(64, '0') + '0'.repeat(64) } ])`, scope);
  scope.__head = head;
  const swingsOf = vm.runInContext('swingsOf', scope);
  const S = { edgeOn: false, levels: { [key]: [{ v: 1.1, unit: 'price', act: 'close' }] } };
  const tok = [{ chain: 'robinhood', addr: A, tops: [] }];
  const prices = new Map([[key, 1.0]]);

  const first = await swingsOf(tok, prices, S);
  assert.equal(first.size, 0, 'первый замер — только точка отсчёта');
  scope.__head = head + 50;
  const got = await swingsOf(tok, prices, S);
  const sw = got.get(key);
  assert.ok(sw, 'сделки между замерами должны читаться');
  assert.ok(Math.abs(sw.hi - 1.2) < 1e-3, 'пик — 1.2, хоть сейчас цена 1.0; вышло ' + sw.hi);
  assert.ok(sw.hi < 1e6, 'сделка в пустоту (предельный тик) пиком не считается');

  // И это пересечение уровня 1.1, которого по двум замерам (1.0 → 1.0) не видно.
  const atLevel = vm.runInContext('atLevel', scope);
  assert.equal(atLevel(S.levels[key], 1.0, 1.0, 0), null);
  assert.ok(atLevel(S.levels[key], 1.0, Math.max(1.0, sw.hi), 0), 'по пику уровень пересечён');

  // Вдали от уровней логи не читаем — это самые дорогие вызовы.
  const far = await swingsOf(tok, new Map([[key, 0.5]]), S);
  assert.equal(far.size, 0);
});

test('вкладка кладётся в группу по названию, а не по старому номеру', async () => {
  const scope = bootWorker();
  const grouped = [];
  // Старый номер группы из прошлого запуска Chrome — такой группы уже нет.
  vm.runInContext('groupId = 777', scope);
  scope.chrome.tabs.get = (id, cb) => cb({ id, windowId: 1, groupId: -1 });
  scope.chrome.tabGroups = {
    query: async (q) => (q.title === 'сторож фисов' && q.windowId === 1 ? [{ id: 42 }] : []),
    update: async () => ({}),
  };
  scope.chrome.tabs.group = async (o) => {
    if (o.groupId && o.groupId !== 42) throw new Error('No group with id');
    grouped.push(o);
    return o.groupId || 99;
  };
  await vm.runInContext('putInGroup', scope)(5);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].groupId, 42, 'вкладка обязана попасть в существующую группу «сторож фисов»');

  // Отбившуюся свою вкладку сторож возвращает в группу сам.
  vm.runInContext('mine.add(6); regroupAt = 0;', scope);
  await vm.runInContext('regroup', scope)();
  assert.ok(grouped.some((o) => o.tabIds[0] === 6 && o.groupId === 42), 'вкладка вне группы возвращается');
});


test('одна цепочка проверок: будильник не заводит вторую, пока первая ждёт', async () => {
  const scope = bootWorker();
  await new Promise((r) => setTimeout(r, 20));
  scope.chrome.storage.local.get = async () => ({ llWatch: { on: true, everySec: 5 } });
  vm.runInContext('watchTick = async () => { globalThis.__ticks = (globalThis.__ticks || 0) + 1; }', scope);
  vm.runInContext('ticking = false; if (nextTimer) { clearTimeout(nextTimer); nextTimer = 0; }', scope);
  const loop = vm.runInContext('loop', scope);
  await loop();                       // первая цепочка: прошла и ждёт 5 секунд
  await loop();                       // «будильник» во время ожидания
  await loop();
  assert.equal(scope.__ticks, 1, 'пока ждёт таймер, новых проверок быть не должно');
  vm.runInContext('clearTimeout(nextTimer); nextTimer = 0;', scope);
});

test('поручения в грузящуюся вкладку копятся, а не затирают друг друга', () => {
  const scope = bootWorker();
  const queueFor = vm.runInContext('queueFor', scope);
  queueFor(9, { addr: 'a', act: 'close', reason: 'тейк' });
  queueFor(9, { addr: 'a', act: 'fees', reason: 'порог' });
  queueFor(9, { addr: 'a', act: 'fees', reason: 'порог ещё раз' });
  const list = vm.runInContext('pending.get(9)', scope);
  assert.equal(list.length, 2, 'закрытие не должно пропасть из-за сбора; одинаковые не дублируются');
  assert.equal(list[0].msg.act, 'close', 'закрытие — первым');

  const sent = [];
  scope.chrome.tabs.sendMessage = (id, msg, cb) => { sent.push(msg.act); if (cb) cb({ handled: true, did: 'closed' }); };
  vm.runInContext('flushPending', scope)(9);
  assert.deepEqual(sent, ['close', 'fees'], 'по одному, закрытие первым');
});

test('своя вкладка, простоявшая 40 минут, перезагружается; чужие и занятые — нет', async () => {
  const scope = bootWorker();
  const reloaded = [];
  scope.chrome.tabs.reload = (id) => { reloaded.push(id); return Promise.resolve(); };
  scope.chrome.tabs.get = (id, cb) => cb({ id, active: id === 3 });
  vm.runInContext(`
    mine.add(1); mine.add(2); mine.add(3); mine.add(4);
    const old = Date.now() - 41 * 60000;
    reloadedAt.set(1, old); reloadedAt.set(2, Date.now()); reloadedAt.set(3, old); reloadedAt.set(4, old);
    busy.add(4);
  `, scope);
  await vm.runInContext('refreshStale', scope)();
  assert.deepEqual(reloaded, [1], 'только своя, давно не обновлённая, без дела и не на глазах');
  assert.equal(vm.runInContext('readyAt.has(1)', scope), false, 'после перезагрузки ждём, пока страница объявится');
});

test('«сайт обновил сессию» — своя вкладка перезагружается, поручение повторяется, не больше двух раз', () => {
  const scope = bootWorker();
  const reloaded = [];
  scope.chrome.tabs.reload = (id) => { reloaded.push(id); return Promise.resolve(); };
  vm.runInContext('mine.add(7); readyAt.set(7, Date.now());', scope);
  const maybeReload = vm.runInContext('maybeReload', scope);
  const msg = { addr: 'a', act: 'fees', reason: 'памп +60%' };

  assert.equal(maybeReload(7, msg, { handled: true, did: 'reload' }), true);
  assert.deepEqual(reloaded, [7], 'вкладку надо обновить');
  const q = vm.runInContext('pending.get(7)', scope);
  assert.equal(q.length, 1, 'то же поручение ждёт в очереди');
  assert.equal(q[0].msg.tries, 1);
  assert.equal(vm.runInContext('readyAt.has(7)', scope), false, 'шлём, только когда страница поднимется');

  // Третий раз подряд — хватит, иначе можно крутиться бесконечно.
  assert.equal(maybeReload(7, { ...msg, tries: 2 }, { did: 'reload' }), false);
  // Чужую вкладку не трогаем никогда.
  assert.equal(maybeReload(99, msg, { did: 'reload' }), false);
  assert.deepEqual(reloaded, [7]);
});

test('после перезапуска сторож сразу обновляет свои вкладки, которые не отвечают', async () => {
  const scope = bootWorker();
  const reloaded = [];
  scope.chrome.tabs.reload = (id) => { reloaded.push(id); return Promise.resolve(); };
  scope.chrome.tabs.get = (id, cb) => cb({ id });
  // Вкладка 11 отвечает на перекличку, 12 — нет (скрипт от старой версии).
  scope.chrome.tabs.sendMessage = (id, msg, cb) => { if (cb) cb(id === 11 ? { alive: true } : undefined); };
  scope.chrome.storage.local.get = async () => ({ ghoTabs: { mine: [11, 12], tabOf: [] } });
  scope.chrome.storage.local.set = async () => {};
  vm.runInContext('restored = false', scope);
  await vm.runInContext('restoreTabs', scope)();
  assert.deepEqual(reloaded, [12], 'молчащую свою вкладку — обновить сразу, отвечающую не трогать');
  assert.equal(vm.runInContext('readyAt.has(11)', scope), true);
});

test('«залили люди / лаунчпад»: пулы лесенок — это люди, лаунчпад — только по его хуку', async () => {
  const scope = bootWorker();
  const T = '0x724a163f0081fa1771590dda9b55edde2c5b823a';
  const LP = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
  // Три пула как у BLAST: главный USDG (лесенки, хук Liquidity Ladder),
  // пул лаунчпада и пул без хука.
  vm.runInContext(`poolCache.set('robinhood:${T}', { at: Date.now(), all: [], totalPools: 3, hooks: {
    '0xaaa': '0x00000000000000000000000000000000dead0030',
    '0xbbb': '${LP}',
    '0xccc': '0x0000000000000000000000000000000000000000' } })`, scope);
  scope.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [
    { attributes: { address: '0xaaa', name: 'BLAST / USDG 4.89%', reserve_in_usd: '185888' } },
    { attributes: { address: '0xbbb', name: 'BLAST / WETH', reserve_in_usd: '91073' } },
    { attributes: { address: '0xccc', name: 'BLAST / WETH 0.9%', reserve_in_usd: '32623' } },
  ] }) });
  const r = await vm.runInContext('HANDLERS', scope).tvl({ chain: 'robinhood', addr: T });
  assert.equal(r.ok, true);
  assert.equal(r.launchpad, 91073, 'лаунчпад — только пул с его хуком');
  assert.equal(r.people, 185888 + 32623, 'пул лесенок с хуком Liquidity Ladder — это люди');
  assert.equal(r.total, 309584);

  // В расчёте глубины — то же правило.
  const src = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8');
  assert.ok(src.includes('const byHand = !isLaunchpad(x.pool.hooks)'), 'руками — всё, что не лаунчпад');
});


test('разбор токена для LP: доходность по токену, риск по цене, пулы по хукам', async () => {
  const scope = bootWorker();
  const T = '0x724a163f0081fa1771590dda9b55edde2c5b823a';
  const LP = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
  vm.runInContext(`poolCache.set('robinhood:${T}', { at: Date.now(), all: [], totalPools: 3,
    hooks: {}, meta: {
      '0xaaa': { hooks: '0x0000000000000000000000000000000000000000', fee: 48900 },
      '0xbbb': { hooks: '${LP}', fee: 0 },
      '0xccc': { hooks: '0x00000000000000000000000000000000dead0030', fee: 48900 },
      '0xddd': { hooks: '0x1234567890123456789012345678901234567890', fee: 0x800000 } } })`, scope);
  scope.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [
    { attributes: { address: '0xaaa', name: 'BLAST / USDG 4.89%', reserve_in_usd: '185888',
                    volume_usd: { h24: '1799390', h1: '60000' }, price_change_percentage: { h1: '-2', h6: '-25', h24: '-60' } } },
    { attributes: { address: '0xbbb', name: 'BLAST / WETH', reserve_in_usd: '91073', volume_usd: { h24: '6087090' } } },
    { attributes: { address: '0xccc', name: 'BLAST / USDG 4.89%', reserve_in_usd: '6158', volume_usd: { h24: '7099' } } },
    // Динамическая комиссия: в ключе флаг 0x800000, в названии процента нет.
    { attributes: { address: '0xddd', name: 'BLAST / USDG', reserve_in_usd: '14000', volume_usd: { h24: '900000' } } },
  ] }) });
  // Глубина: у цены 0.001 людям стоит $20 000 в ±10%.
  vm.runInContext(`HANDLERS.depth = async () => ({ ok: true, price: 0.001,
    bandsAdded: [{ lo: 0.00095, hi: 0.00105, usd: 20000 }, { lo: 0.002, hi: 0.003, usd: 99999 }] })`, scope);
  const r = await vm.runInContext('HANDLERS', scope).lpScan({ chain: 'robinhood', addr: T });
  assert.equal(r.ok, true);
  assert.equal(r.launchpadPools, 1);
  assert.equal(r.ladderPools, 1, 'пул с хуком лесенок Liquidity Ladder узнаётся');
  const fees = 1799390 * 0.0489 + 7099 * 0.0489;
  assert.ok(Math.abs(r.fees24 - fees) < 1,
    'фисы людям — объём × комиссия, без лаунчпада (0%) и без пула с неизвестной динамической комиссией');
  assert.ok(Math.abs(r.near - 20000) < 1, 'у цены — только ±10%, дальние ступени фисов не получают');
  assert.ok(Math.abs(r.yield1 - 60000 * 0.0489 / 20000) < 1e-9,
    'доходность — по последнему часу: и фисы, и ликвидность одного времени');
  assert.equal(r.risk, 'падает', '−60% за сутки — это не «спокойно», как бы ни были высоки фисы');
  assert.equal(r.best[0].name, 'BLAST / USDG 4.89%');
});

test('метки в списках: ликвидность и оборот по 30 токенов за запрос, с памятью', async () => {
  const scope = bootWorker();
  const A = '0x' + 'a'.repeat(40);
  const B = '0x' + 'b'.repeat(40);
  let calls = 0;
  let asked = '';
  scope.fetch = async (url) => {
    calls++;
    asked = String(url);
    return { ok: true, status: 200, json: async () => ({ data: [
      { attributes: { address: A, total_reserve_in_usd: '92589.39', volume_usd: { h24: '9285418' }, fdv_usd: '735307' } },
    ] }) };
  };
  const H = vm.runInContext('HANDLERS', scope);
  const r = await H.lpMulti({ chain: 'robinhood', addrs: [A, B, A.toUpperCase().replace('0X', '0x')] });
  assert.equal(calls, 1, 'один запрос на пачку');
  assert.ok(asked.includes('/tokens/multi/'), asked);
  assert.ok(Math.abs(r.tokens[A].reserve - 92589.39) < 0.01);
  assert.equal(r.tokens[A].vol24, 9285418);
  await H.lpMulti({ chain: 'robinhood', addrs: [A] });
  assert.equal(calls, 1, 'повтор за 5 минут — из памяти');

  const lp = fs.readFileSync(path.join(SRC, 'lp.js'), 'utf8');
  assert.ok(lp.includes('v.failed && Date.now() - v.failed > 60000'), 'при сбое — пауза, а не цикл запросов');
});

// ABI-строка, как её отдаёт name(): смещение, длина, байты с добивкой.
function abiStr(s) {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  const pad = hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, '0');
  return '0x' + (32).toString(16).padStart(64, '0') + (hex.length / 2).toString(16).padStart(64, '0') + pad;
}

test('скринер не берёт токенизированные акции Robinhood в топ', async () => {
  const scope = bootWorker();
  const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
  const MEME = '0x' + 'e'.repeat(40);
  const store = { ghoRpc: { robinhood: 'https://node/rpc' } };
  scope.chrome.storage.local.get = async (k) => (typeof k === 'string' ? { [k]: store[k] } : store);
  scope.chrome.storage.local.set = async (b) => Object.assign(store, b);
  const pool = (base, quote, name, vol) => ({ attributes: { name, volume_usd: { h24: vol } },
    relationships: { base_token: { data: { id: 'robinhood_' + base } }, quote_token: { data: { id: 'robinhood_' + quote } } } });
  scope.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [
    pool(NVDA, '0x5fc5360d0400a0fd4f2af552add042d716f1d168', 'NVDA / USDG 0.05%', 48e6),
    pool(MEME, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', 'MEME / WETH 1%', 5e5),
  ] }) });
  let named = 0;
  scope.GHO_CHAIN.rpcBatch = async (url, calls) => { named += calls.length;
    return calls.map((c) => abiStr(c.to === NVDA ? 'NVIDIA • Robinhood Token' : 'Meme Coin')); };
  const HANDLERS = vm.runInContext('HANDLERS', scope);
  const r = await HANDLERS.lpTop({ chain: 'robinhood', pages: 1 });
  assert.equal(r.ok, true);
  // массив из области воркера — сравниваем строкой, а не deepEqual (другой Array.prototype)
  assert.equal(r.tokens.map((t) => t.addr).join(','), MEME, 'NVDA — акция, в скринере ей не место');
  assert.equal(r.stocks, 1);
  await HANDLERS.lpTop({ chain: 'robinhood', pages: 1 });
  assert.equal(named, 2, 'имя токена не меняется — второй раз из памяти, без узла');
});

test('пулы токена не запрашиваются у GeckoTerminal дважды, когда их просят сразу', async () => {
  const scope = bootWorker();
  let calls = 0;
  scope.fetch = async () => { calls++; await new Promise((r) => setTimeout(r, 20));
    return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
  const gtPools = vm.runInContext('gtPools', scope);
  const A = '0x' + 'a'.repeat(40);
  await Promise.all([gtPools('robinhood', A), gtPools('robinhood', A)]);
  assert.equal(calls, 1, 'второй запрос должен дождаться первого, а не уходить следом');
});

test('запросы к GeckoTerminal идут через одну очередь с интервалом', async () => {
  const scope = bootWorker();
  const at = [];
  scope.fetch = async () => { at.push(Date.now()); return { ok: true, status: 200 }; };
  const gtFetch = vm.runInContext('gtFetch', scope);
  await Promise.all([gtFetch('https://api.geckoterminal.com/a'), gtFetch('https://api.geckoterminal.com/b')]);
  assert.equal(at.length, 2);
  assert.ok(at[1] - at[0] >= 2000, 'лимит ~30 в минуту — второй запрос не раньше чем через 2 с: ' + (at[1] - at[0]));
});

test('курс ETH не ищет пулы WETH по логам всей цепи и не падает в ноль', async () => {
  const src = fs.readFileSync(path.join(SRC, 'chain.js'), 'utf8');
  assert.match(src, /async function nativeUsd\(net, wrapped, stable, known\)/,
    'у WETH больше 10 000 пулов — узел не отдаёт их логами; нужен готовый список');
  assert.match(src, /known && known\.length \? known : await poolsOfToken/);

  const scope = bootWorker();
  scope.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  const seen = [];
  scope.GHO_CHAIN.nativeUsd = async (net, w, s, known) => { seen.push(known === undefined ? 'логи' : 'список'); return 0; };
  const quoteUsd = vm.runInContext('quoteUsd', scope);
  const ZERO = '0x0000000000000000000000000000000000000000';
  vm.runInContext('ethPrice = { at: Date.now() - 20 * 60000, usd: 2400 }', scope);
  assert.equal(await quoteUsd({}, 'robinhood', ZERO), 2400, 'узел не ответил — берём последний курс, а не ноль');
  assert.deepEqual([...seen], ['список', 'логи'], 'сначала пулы из списка, потом старый путь');
  vm.runInContext('ethPrice = { at: Date.now() - 2 * 3600000, usd: 2400 }', scope);
  assert.equal(await quoteUsd({}, 'robinhood', ZERO), 0, 'курсу старше часа не верим');
});
