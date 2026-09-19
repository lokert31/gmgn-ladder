/*
 * Сторож импульса: следит за ценой твоих токенов и, когда та резко идёт
 * вверх, велит странице нажать «собрать фисы».
 *
 * Почему в сервис-воркере, а не на странице: вкладку ты закрываешь, а
 * комиссии капают всё равно. Сторож живёт отдельно от вкладок.
 *
 * Chrome убивает сервис-воркер после половины минуты простоя, поэтому цикл
 * держится двумя опорами сразу: собственным таймером (каждое обращение к
 * сети отодвигает засыпание) и будильником раз в минуту, который поднимает
 * воркер обратно, если Chrome его всё-таки усыпил.
 */

const WATCH_KEY = "llWatch"; // настройки сторожа
const PAIRS_KEY = "llPairs"; // леддеры, которые отдал сам сайт
const ALARM = "gho-watch";
const SITE = "https://liquidityladder.it.com";
// Обратная таблица к той, что в оверлее: сайт отдаёт числовой id сети.
// Имя сети -> её номер: обратное к CHAIN_OF.
const CHAIN_ID = {
  eth: 1,
  bsc: 56,
  base: 8453,
  robinhood: 4663,
  polygon: 137,
  arbitrum: 42161,
};
const CHAIN_OF = {
  1: "eth",
  56: "bsc",
  8453: "base",
  4663: "robinhood",
  137: "polygon",
  42161: "arbitrum",
};

const WATCH_DEFAULTS = {
  on: false, // главный выключатель: это действие с деньгами
  pumpOn: false, // срабатывать на импульсе цены — тоже включать отдельно
  feesOn: false, // собирать по порогу — включать отдельно: это трата газа без спроса
  keepTabs: true, // держать по фоновой вкладке на каждый открытый леддер
  maxTabs: 0, // предел своих вкладок; 0 — по вкладке на каждый токен
  feesSec: 60, // как часто спрашивать размер комиссий у их API
  skip: [], // леддеры, на которых сторож молчит: «сеть:id»
  levels: {}, // ручные уровни тейка: «сеть:адрес» -> [цены]
  pump: {}, // свои условия пампа по токену: «сеть:адрес» -> { pumpPct, windowMin, fadePct }
  pumpPct: 50, // на сколько процентов должна вырасти цена
  windowMin: 5, // за сколько минут
  fadePct: 5, // насколько цене позволено откатиться от пика и всё ещё считаться пампом
  minUsd: 5, // ниже этой суммы фисов не собираем; 0 — собирать любые
  everySec: 5, // как часто спрашиваем цену
  edgeOn: false, // собирать у края диапазона — включать отдельно
  edgePct: 5, // за сколько процентов до границы считать «край»
  edgeHi: false, // автосбор у верхней границы — отдельная галка, по умолчанию выключен
  edgeLo: false, // за нижней — нет: внизу собирать смысла нет
  quietSec: 60, // как часто ходить на страницу, пока повод держится; 0 — каждый опрос
};

// токен -> [{ at, price }], только внутри окна наблюдения
const trail = new Map();
// токен -> что сторож видит прямо сейчас. Без этого «не работает» нечем
// проверить: молчит он потому, что повода нет, или потому, что сломан.
const seen = new Map();
let lastRun = 0;
let lastErr = '';
// Чем кончилась последняя попытка и несколько предыдущих. Одного снимка мало:
// когда сбор срабатывает через раз, нужна картина, а не последний кадр.
let lastAct = null;
const log = [];

function remember(entry) {
  lastAct = entry;
  log.unshift(entry);
  if (log.length > 6) log.pop();
}
const firedAt = new Map();
let ticking = false;

// Последняя цена токена для уровней тейка — переживает сон воркера. Живёт
// в chrome.storage.session: в памяти браузера, до его закрытия. Старше
// PREV_TTL не верим: за это время цена могла сходить куда угодно.
const lastPx = new Map();
const PREV_TTL = 30 * 60000;
const PX_KEY = "ghoLastPx";
let pxLoaded = false;
let pxSavedAt = 0;

function pxStore() {
  return (chrome.storage && chrome.storage.session) || chrome.storage.local;
}

async function loadLastPx() {
  if (pxLoaded) return;
  pxLoaded = true;
  try {
    const v = await pxStore().get(PX_KEY);
    const box = (v && v[PX_KEY]) || {};
    for (const [k, x] of Object.entries(box)) {
      if (x && x.price > 0 && !lastPx.has(k)) lastPx.set(k, x);
    }
  } catch (e) { /* нет — начнём с чистого листа */ }
}

async function saveLastPx() {
  // Пишем не чаще раза в 10 секунд: это память на случай сна, а не журнал.
  if (Date.now() - pxSavedAt < 10000) return;
  pxSavedAt = Date.now();
  try { await pxStore().set({ [PX_KEY]: Object.fromEntries(lastPx) }); }
  catch (e) { /* не записалось — переживём */ }
}

async function watchSettings() {
  try {
    const v = await chrome.storage.local.get(WATCH_KEY);
    return { ...WATCH_DEFAULTS, ...((v && v[WATCH_KEY]) || {}) };
  } catch (e) {
    return { ...WATCH_DEFAULTS };
  }
}

/**
 * За какой из двух валют леддера следить.
 *
 * Раньше брали первую и считали, что вторая — стейбл. Но сайт отдаёт пару в
 * своём порядке: у «RocketFrog/USDG» первым стоит токен, а у «USDG/MARIO» —
 * стейбл. В итоге сторож пытался читать цену USDG в USDG и молчал.
 */
function tokenSide(chain, p) {
  const a = String(p.token0 || "").toLowerCase();
  const b = String(p.token1 || "").toLowerCase();
  const q = QUOTES[chain] || {};
  const quote = new Set(
    [q.stable, q.wrapped, ZERO_ADDR].filter(Boolean).map((x) => x.toLowerCase()),
  );
  const ok = (x) => x && x !== "0x" && x.length === 42;
  if (ok(a) && !quote.has(a)) return a;
  if (ok(b) && !quote.has(b)) return b;
  return ok(a) ? a : ok(b) ? b : "";
}

/**
 * Ключ одного леддера. Сайт даёт ему собственный id — им и пользуемся;
 * без него опознаём по токену и границам, они у леддера свои.
 */
function ladderKey(chain, p) {
  const id = p.group === undefined || p.group === null ? "" : String(p.group);
  return id
    ? chain + ":" + id
    : chain +
        ":" +
        String(p.token0 || "").toLowerCase() +
        ":" +
        p.lo +
        ":" +
        p.hi;
}

async function watchedTokens(skip) {
  const off = new Set(skip || []);
  try {
    const v = await chrome.storage.local.get(PAIRS_KEY);
    const box = v && v[PAIRS_KEY];
    const list = (box && box.pairs) || [];
    const out = new Map();
    for (const p of list) {
      const chain = CHAIN_OF[p.chainId] || "robinhood";
      const addr = tokenSide(chain, p);
      if (!addr) continue;
      const key = chain + ":" + addr;
      // Выключают не токен, а конкретный леддер: у одного токена их бывает
      // несколько, и верх у каждого свой. Клеймить хочется у верха того
      // диапазона, который выбрали, а не у самого внешнего из всех.
      if (off.has(ladderKey(chain, p))) continue;
      const box = out.get(key) || {
        chain,
        addr,
        label: p.symbols || "",
        tops: [],
        lows: [],
      };
      const lo = Number(p.lo);
      const hi = Number(p.hi);
      if (isFinite(hi) && hi > 0 && !box.tops.includes(hi)) box.tops.push(hi);
      if (isFinite(lo) && lo > 0 && !box.lows.includes(lo)) box.lows.push(lo);
      out.set(key, box);
    }
    return [...out.values()];
  } catch (e) {
    return [];
  }
}

/**
 * К леддерам добавляем токены, на которых стоят ручные уровни.
 *
 * Уровень часто ставят на токене, куда ещё не заходил: леддера там нет, а
 * следить надо — иначе тейк молча не сработает.
 */
function withLevels(tokens, levels) {
  const out = [...tokens];
  const seen = new Set(out.map((t) => t.chain + ":" + t.addr));
  for (const key of Object.keys(levels || {})) {
    if (seen.has(key)) continue;
    const [chain, addr] = key.split(":");
    if (!chain || !addr) continue;
    // Позиции по такому токену нет — вкладку под него не заводим: нажимать
    // там нечего. Раньше заводили, и вкладок было больше, чем позиций.
    out.push({ chain, addr, label: addr.slice(0, 10) + "…", tops: [], lows: [], levelsOnly: true });
    seen.add(key);
  }
  return out;
}

/** Выпуск токена — для перевода капитализации в цену. Спрашиваем раз. */
// Выпуск по токену, уже прочитанный: нужен и там, где ждать узла некогда.
const supplyMemo = new Map();

async function supplyFor(chain, addr) {
  const C = self.GHO_CHAIN;
  const net = await netFor(chain);
  if (!net || !C || !C.supplyOf) return 0;
  const v = await C.supplyOf(net, addr).catch(() => 0);
  if (v > 0) supplyMemo.set(chain + ":" + addr, v);
  return v;
}

// Пул, по которому смотрим цену: ищется редко, читается часто.
const pricePool = new Map();
const POOL_TTL = 30 * 60000;

/** Найти и запомнить пул против доллара — по разу на токен в полчаса. */
async function poolFor(chain, addr) {
  const C = self.GHO_CHAIN;
  const net = await netFor(chain);
  if (!net || !C) return null;

  const key = chain + ":" + addr;
  const box = pricePool.get(key);
  if (box && Date.now() - box.at < POOL_TTL) return box.none ? null : box;

  const q = QUOTES[chain] || {};
  const all = await C.candidates(net, addr, 1, null, [q.stable]).catch(
    () => [],
  );
  const stable = String(q.stable || "").toLowerCase();
  const pool = all.find((x) => {
    const other = (
      x.currency0.toLowerCase() === addr ? x.currency1 : x.currency0
    ).toLowerCase();
    return other === stable;
  });
  if (!pool) {
    // Отсутствие пула тоже запоминаем. Иначе у токена, который торгуется
    // только против акции лаунчпада, поиск по логам шёл на каждом опросе —
    // раз в пять секунд, и это самые дорогие запросы из всех.
    pricePool.set(key, { none: true, at: Date.now() });
    return null;
  }

  const [d0, d1] = await Promise.all([
    C.decimalsOf(net, pool.currency0),
    C.decimalsOf(net, pool.currency1),
  ]).catch(() => [18, 18]);
  const fresh = {
    pool,
    d0,
    d1,
    zero: pool.currency0.toLowerCase() === addr,
    net,
    at: Date.now(),
  };
  pricePool.set(key, fresh);
  return fresh;
}

/**
 * Цены всех токенов сразу — одной пачкой.
 *
 * Полный расчёт глубины тут не годится: это сорок обращений к сети на токен.
 * Да и по одному запросу на токен — расточительство: цена лежит в одном
 * слоте, и все слоты забираются одним обращением независимо от того, сколько
 * токенов под наблюдением.
 */
async function pricesOf(tokens, freshMs) {
  const C = self.GHO_CHAIN;
  const out = new Map();

  // Сначала берём то, что уже пришло из их дашборда — это бесплатно. Но в
  // каких единицах сайт пишет цену у пары, где стейбл стоит первым
  // (USDG/DOGGO), мы не знаем наверняка. А уровни тейка заданы в долларах
  // за токен. Поэтому раз в полчаса сверяем цену сайта с ценой из цепи и
  // запоминаем, как её читать: как есть, перевёрнутой или никак.
  const rest = [];
  const check = new Map();          // токен -> цена сайта, которую надо сверить
  const keep = Math.max(15000, Number(freshMs) || 90000);
  for (const t of tokens) {
    const key = t.chain + ":" + t.addr;
    const box = sitePrice.get(key);
    if (!box || Date.now() - box.at > keep || !sanePrice(box.price)) { rest.push(t); continue; }
    const trust = siteTrust.get(key);
    if (trust && Date.now() - trust.at < TRUST_TTL) {
      if (trust.k === 1) { out.set(key, box.price); srcOf.set(key, trust.sure ? "usd" : "site"); continue; }
      if (trust.k === -1) { out.set(key, 1 / box.price); srcOf.set(key, "usd"); continue; }
      rest.push(t);                 // сайту по этому токену не верим
      continue;
    }
    check.set(key, box.price);
    rest.push(t);
  }
  if (!rest.length || !C) return out;

  const boxes = [];
  for (const t of rest) {
    const key = t.chain + ":" + t.addr;
    const box = await poolFor(t.chain, t.addr).catch(() => null);
    if (box && box.net) { boxes.push({ t, box }); continue; }
    // Пула против доллара нет — сверить не с чем. Берём цену сайта как есть,
    // но помечаем её отдельным источником: смешивать её с ценой из цепи
    // нельзя, иначе разница единиц прочитается как пересечение уровня.
    const site = check.get(key) || (() => {
      const b = sitePrice.get(key);
      return b && Date.now() - b.at < 180000 && sanePrice(b.price) ? b.price : 0;
    })();
    if (site) {
      if (check.has(key)) siteTrust.set(key, { k: 1, sure: false, at: Date.now() });
      out.set(key, site);
      srcOf.set(key, "site");
    }
  }
  if (!boxes.length) return out;

  const rpcUrl = boxes[0].box.net.stateRpc || boxes[0].box.net.rpc;
  const sv = boxes[0].box.net.stateView;
  // Вместе с ценой — ликвидность у цены. Пул, в котором её нет, цены не
  // знает: у SWARM такой пул стоял на предельном тике, и его «цена» была
  // 3·10⁵⁰ — это читалось бы как памп на 10⁵⁰% и как пересечение любого
  // тейка, включая закрытие.
  const res = await C.rpcBatch(
    rpcUrl,
    boxes.flatMap(({ box }) => [
      { to: sv, data: C.SEL.slot0 + box.pool.poolId.slice(2) },
      { to: sv, data: C.SEL.liquidity + box.pool.poolId.slice(2) },
    ]),
  ).catch(() => []);

  boxes.forEach(({ t, box }, i) => {
    const raw = res[i * 2];
    const liq = res[i * 2 + 1];
    if (!raw || raw.length < 2 + 64 * 2) return;
    let tick = BigInt("0x" + raw.slice(2 + 64, 2 + 64 * 2));
    if (tick >= 1n << 255n) tick -= 1n << 256n; // int24 приезжает в int256
    if (deadPool(tick, liq)) {
      // Выбрасываем пул из памяти: в следующий раз выберется живой.
      pricePool.delete(t.chain + ":" + t.addr);
      return;
    }
    const px = Math.pow(1.0001, Number(tick)) * Math.pow(10, box.d0 - box.d1);
    const price = box.zero ? px : 1 / px;
    if (!sanePrice(price)) return;
    const key = t.chain + ":" + t.addr;
    out.set(key, price);
    srcOf.set(key, "usd");
    const site = check.get(key);
    if (site) siteTrust.set(key, { k: orient(site, price), sure: true, at: Date.now() });
  });
  return out;
}

// Как читать цену сайта по токену: 1 — как есть, -1 — перевёрнутой,
// 0 — не совпадает ни так, ни так, и тогда только цепь.
const siteTrust = new Map();
const TRUST_TTL = 30 * 60000;
// Откуда пришла последняя цена токена: "usd" — доллары за токен (цепь или
// сверенный сайт), "site" — сайт, который сверить было не с чем.
const srcOf = new Map();

const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
// Блок, до которого сделки пула уже просмотрены: poolId -> номер.
const swapSeen = new Map();

/**
 * Пик и дно цены по всем сделкам в пуле с прошлого замера.
 *
 * Читаем только у токенов, где цене до тейка или верхней границы меньше
 * 20%: логи — самые дорогие вызовы у Alchemy, а вдали от уровней касание
 * всё равно ничего не решает.
 */
async function swingsOf(tokens, prices, S) {
  const out = new Map();
  const C = self.GHO_CHAIN;
  if (!C || !C.rpcMany) return out;
  const want = [];
  for (const t of tokens) {
    const key = t.chain + ":" + t.addr;
    const price = prices.get(key);
    const box = pricePool.get(key);
    if (!price || !box || box.none || !box.net || srcOf.get(key) !== "usd") continue;
    const supply = Number(supplyMemo.get(key)) || 0;
    const marks = ((S.levels || {})[key] || [])
      .map((x) => (x && typeof x === "object" ? x : { v: x, unit: "price" }))
      .map((x) => (x.unit === "mcap" ? (supply > 0 ? Number(x.v) / supply : 0) : Number(x.v)));
    if (S.edgeOn !== false && (t.tops || []).length) marks.push(Math.max(...t.tops));
    if (!marks.some((m) => m > 0 && m >= price * 0.8 && m <= price * 1.2)) continue;
    want.push({ key, box });
  }
  if (!want.length) return out;

  const rpcUrl = want[0].box.net.rpc;
  const head = await C.rpc(rpcUrl, "eth_blockNumber", []).then((h) => parseInt(h, 16)).catch(() => 0);
  if (!head) return out;
  const calls = [];
  const idx = [];
  for (const w of want) {
    const pid = w.box.pool.poolId;
    const last = swapSeen.get(pid);
    swapSeen.set(pid, head);
    if (!last || last >= head) continue;           // первый замер — точка отсчёта
    const from = Math.max(last + 1, head - 3000);  // после долгого сна — не дальше 5 минут
    calls.push({ method: "eth_getLogs", params: [{ address: w.box.net.poolManager,
      topics: [SWAP_TOPIC, pid], fromBlock: "0x" + from.toString(16), toBlock: "0x" + head.toString(16) }] });
    idx.push(w);
  }
  const res = await C.rpcMany(rpcUrl, calls).catch(() => []);
  idx.forEach((w, i) => {
    const logs = Array.isArray(res[i]) ? res[i] : [];
    let hi = 0;
    let lo = Infinity;
    for (const lg of logs) {
      const d = String(lg.data || "");
      if (d.length < 2 + 64 * 5) continue;
      let tick = BigInt("0x" + d.slice(2 + 64 * 4, 2 + 64 * 5));
      if (tick >= 1n << 255n) tick -= 1n << 256n;
      if (Math.abs(Number(tick)) >= 880000) continue;   // сделка в пустоту — не цена рынка
      const px = Math.pow(1.0001, Number(tick)) * Math.pow(10, w.box.d0 - w.box.d1);
      const p = w.box.zero ? px : 1 / px;
      if (!sanePrice(p)) continue;
      if (p > hi) hi = p;
      if (p < lo) lo = p;
    }
    if (hi > 0) out.set(w.key, { hi, lo });
  });
  return out;
}

/**
 * Пул без цены: ликвидности у текущего тика нет, или тик у самого предела.
 * Так бывает, когда покупка прошла сквозь все ступени, а выше никого не
 * было, — цена пула улетает в потолок и стоит там, пока кто-то не продаст.
 */
function deadPool(tick, liq) {
  const t = Number(tick);
  if (!isFinite(t) || Math.abs(t) >= 880000) return true;
  try { return liq === null || liq === undefined || BigInt(liq) === 0n; }
  catch (e) { return true; }
}

/** Цена, которой не бывает у живого токена, — это поломка, а не рынок. */
function sanePrice(p) {
  return isFinite(p) && p > 1e-15 && p < 1e7;
}

/** Совпадает ли цена сайта с ценой цепи — прямо, перевёрнуто или никак. */
function orient(site, chain) {
  const close = (a, b) => a > 0 && b > 0 && a / b < 3 && b / a < 3;
  if (close(site, chain)) return 1;
  if (close(1 / site, chain)) return -1;
  return 0;
}

/**
 * Идёт ли памп прямо сейчас.
 *
 * Рост меряем от самой низкой цены в окне, а не от первой: импульс мог
 * начаться в середине. Но одного роста мало — важно, что цена ещё наверху.
 * Сходив 100 → 200 → 160, токен всё ещё «плюс 60% от низа», хотя памп уже
 * кончился и мы собирали бы фисы в падение. Поэтому требуем, чтобы цена
 * держалась у пика окна.
 */
function impulse(points, price, pumpPct, fadePct) {
  if (!points.length) return null;
  let low = points[0];
  let high = points[0];
  for (const p of points) {
    if (p.price < low.price) low = p;
    if (p.price > high.price) high = p;
  }
  if (low.price <= 0) return null;

  const grew = ((price - low.price) / low.price) * 100;
  if (grew < pumpPct) return null;

  const peak = Math.max(high.price, price);
  const fade = Math.max(0, Number(fadePct) || 0) / 100;
  if (peak > 0 && price < peak * (1 - fade)) return null; // уже откатились

  return {
    grew,
    from: low.price,
    since: low.at,
    peak,
    text: "памп +" + grew.toFixed(0) + "%",
  };
}

async function watchTick() {
  const S = await watchSettings();
  if (!S.on) {
    trail.clear();
    return;
  }

  const tokens = withLevels(await watchedTokens(S.skip), S.levels);
  lastRun = Date.now();
  if (!tokens.length) {
    lastErr = "следить не за чем: ни одного включённого леддера и ни одного уровня";
    return;
  }

  // Вкладки заводим первым делом. Сбор умеет работать только в своей
  // вкладке, а раньше их открывал шаг ниже — тот, что выполняется лишь
  // когда включён хоть один ценовой повод. При сборе по порогу до него
  // дело не доходило вовсе: своей вкладки не появлялось никогда, и сбор
  // молча упирался в «ни одна вкладка не взялась», пока комиссии росли.
  await restoreTabs();
  await loadLastPx();
  await keepTabs(tokens.filter((t) => !t.levelsOnly), S);
  await regroup();
  await refreshStale();

  await sweepFees(S);

  // Цена нужна только ценовым поводам. Правило «собрать по порогу» её не
  // трогает вовсе — оно спрашивает размер комиссий у самого сайта. Раньше
  // узел опрашивался в любом случае, и это была основная трата запросов.
  const levelsSet = Object.values(S.levels || {}).some(
    (v) => Array.isArray(v) && v.length,
  );
  const needPrice = S.pumpOn !== false || S.edgeOn !== false || levelsSet;
  if (!needPrice) {
    lastErr = "";
    for (const t of tokens) {
      seen.set(t.chain + ":" + t.addr, {
        at: Date.now(), price: 0, note: "цена не нужна: собираю по порогу",
      });
    }
    return;
  }

  // Цена сайта обновляется раз в минуту — для тейков это слишком грубо.
  // Берём её, только если она совсем свежая; иначе читаем пул.
  const prices = await pricesOf(tokens, Math.max(5, Number(S.everySec) || 5) * 2000);
  const swings = await swingsOf(tokens, prices, S);
  // Раньше здесь всегда советовалось «проверь RPC», хотя причина бывала
  // совсем другая, — и выглядело как «расширение потеряло твой узел».
  if (prices.size) lastErr = "";
  else {
    const net = await netFor(tokens[0].chain);
    lastErr = net
      ? "цены не читаются: узел молчит или у токена нет пула против доллара"
      : "не задан RPC сети " + tokens[0].chain + " — впиши его в настройках (⚙)";
  }
  const now = Date.now();

  for (const t of tokens) {
    const key = t.chain + ":" + t.addr;
    const price = prices.get(key) || 0;
    if (!price) {
      seen.set(key, { at: Date.now(), price: 0, note: "цена не читается" });
      continue;
    }

    // Условия пампа бывают свои у каждого токена: у спокойного стейбл-пула
    // «плюс 50% за 5 минут» не случится никогда, у свежего мема — каждый час.
    const own = (S.pump || {})[key] || {};
    const pumpPct = isFinite(own.pumpPct) && own.pumpPct > 0 ? own.pumpPct : S.pumpPct;
    const winMin = isFinite(own.windowMin) && own.windowMin > 0 ? own.windowMin : S.windowMin;
    const fade = isFinite(own.fadePct) ? own.fadePct : S.fadePct;

    // Цены из разных источников в одну ленту не кладём: если сайт пишет
    // цену пары в других единицах, переход между ними выглядит как скачок
    // в сотни раз — и как ложный памп, и как ложное пересечение уровня.
    const src = srcOf.get(key) || "usd";
    let points = (trail.get(key) || []).filter(
      (p) => now - p.at <= winMin * 60000,
    );
    if (points.length && points[points.length - 1].src !== src) points = [];
    // По токену памп можно выключить отдельно: условия остаются, но сбор по
    // импульсу не срабатывает. Остальные поводы работают как работали.
    const hit = S.pumpOn === false || own.off === true
      ? null
      : impulse(points, price, pumpPct, fade);
    // Прошлую цену для уровней берём не из окна пампа, а из отдельной
    // памяти, которая переживает сон воркера. Раньше: воркер уснул ниже
    // уровня, проснулся выше — пересечения «не было», и тейк не срабатывал
    // уже никогда.
    const was = lastPx.get(key);
    const prev = was && was.src === src && now - was.at < PREV_TTL ? was.price : 0;
    points.push({ at: now, price, src });
    trail.set(key, points);
    lastPx.set(key, { price, src, at: now });

    // Ручной уровень: сработал — и повод исчерпан, второй раз по нему не
    // дёргаем, пока цена не уйдёт вниз и не пересечёт его заново.
    const supply = await supplyFor(t.chain, t.addr);
    // Пик и дно между замерами — по всем сделкам в пуле. Цена могла сходить
    // на уровень и вернуться за эти секунды; по двум замерам это не видно.
    const sw = swings.get(key);
    const peak = sw ? Math.max(price, sw.hi) : price;
    const level = atLevel((S.levels || {})[key], prev, peak, supply);

    // Край диапазона — отдельный повод со своей галкой. Раньше отмеченные
    // края ступеней его выключали — и отметка от прошлой лесенки молча
    // глушила сбор у верха новой (так было у BLAST). Теперь галка решает
    // сама, а отмеченные края работают вдобавок к ней.
    const near =
      S.edgeOn === false
        ? null
        : atEdge(t, peak, S.edgePct, {
            hi: S.edgeHi !== false,
            lo: S.edgeLo !== false,
          });
    // Ручной уровень бьёт первым: его задали руками, значит он важнее.
    const why = level || hit || near;
    if (!why) {
      void saveLastPx();
      firedAt.delete(key);
      seen.set(key, { at: Date.now(), price, note: "повода нет" });
      continue;
    }
    seen.set(key, { at: Date.now(), price, note: why.text || "повод есть" });
    void saveLastPx();
    // Пересечение уровня — событие, а не состояние: паузу оно не соблюдает,
    // иначе можно пропустить ровно тот момент, ради которого его ставили.
    if (level) firedAt.delete(key);

    // Цену и границы мы смотрим на каждом опросе — это дёшево, один запрос
    // к узлу на все токены. А вот размер комиссий известен только странице,
    // и чтобы его узнать, она жмёт «Update Fees» и ждёт пересчёта. Цена у
    // границы может стоять часами, поэтому на страницу ходим с этим шагом.
    // Старые настройки хранили минуты — понимаем и их, чтобы шаг не слетел
    // в ноль после обновления расширения.
    const quietMs = isFinite(S.quietSec)
      ? S.quietSec * 1000
      : (Number(S.quietMin) || 0) * 60000;
    const last = firedAt.get(key) || 0;
    if (last && now - last < quietMs) continue;
    const fresh = !last;
    firedAt.set(key, now);
    await onImpulse(t, why, price, S, fresh);
  }
}

/**
 * Цена подошла к границе леддера или вышла за неё.
 *
 * Считаем в процентах от самой границы, а не от ширины диапазона: у широкого
 * леддера «пять процентов ширины» — это ещё далеко от края, а нас волнует
 * близость к тому месту, где комиссия перестаёт капать.
 */
function atEdge(t, price, pct, sides) {
  const gap = Math.max(0, Number(pct) || 0) / 100;
  const hiOn = !sides || sides.hi !== false;
  const loOn = !sides || sides.lo !== false;
  const tops = (t.tops || []).filter((v) => isFinite(v) && v > 0);
  const lows = (t.lows || []).filter((v) => isFinite(v) && v > 0);

  // Верхов бывает несколько — по одному на леддер и ступень. Автоматический
  // край смотрит только на самый верхний: ниже него позиции ещё работают, и
  // собирать там незачем. Хочешь собирать у промежуточных — отметь их
  // галками, тогда автоматический край для этого токена выключается.
  if (hiOn && tops.length) {
    const top = Math.max(...tops);
    const near = price >= top * (1 - gap) ? top : undefined;
    if (near !== undefined) {
      return {
        edge: "hi",
        bound: near,
        out: price >= near,
        text:
          price >= near
            ? "цена вышла выше диапазона"
            : "цена у верха диапазона",
      };
    }
  }
  // Снизу так же: важен самый нижний край, а не промежуточные.
  if (loOn && lows.length) {
    const bottom = Math.min(...lows);
    const near = price <= bottom * (1 + gap) ? bottom : undefined;
    if (near !== undefined) {
      return {
        edge: "lo",
        bound: near,
        out: price <= near,
        text:
          price <= near ? "цена вышла ниже диапазона" : "цена у низа диапазона",
      };
    }
  }
  return null;
}

/**
 * Ручной тейк: цена пересекла заданный уровень снизу вверх.
 *
 * Именно пересекла, а не «стоит выше»: иначе один раз перешагнув уровень,
 * сторож считал бы повод вечным и дёргал бы сбор до конца дня.
 */
function atLevel(levels, prev, price, supply) {
  if (!prev || !price) return null;

  // Уровень задают либо ценой, либо капитализацией — вторую переводим в цену
  // по числу выпущенных монет. Без него такой уровень просто пропускаем:
  // гадать о цене по мкапу нельзя.
  const list = (levels || [])
    .map((x) =>
      x && typeof x === "object"
        ? { v: Number(x.v), unit: x.unit, act: x.act }
        : { v: Number(x), unit: "price", act: "fees" },
    )
    .map((x) => ({
      ...x,
      at: x.unit === "mcap" ? (supply > 0 ? x.v / supply : 0) : x.v,
    }))
    .filter((x) => isFinite(x.at) && x.at > 0 && prev < x.at && price >= x.at);

  if (!list.length) return null;
  // Из пройденных за шаг берём верхний, а закрытие важнее сбора.
  list.sort((a, b) => (a.act === b.act ? b.at - a.at : a.act === "close" ? -1 : 1));
  const hit = list[0];
  return {
    level: hit.at,
    act: hit.act,
    text:
      (hit.act === "close" ? "закрываю: цена дошла до " : "цена дошла до ") +
      (hit.unit === "mcap" ? "мкапа " + fmtBig(hit.v) : fmtPrice(hit.at)),
  };
}

/** Большое число словами: 140000 -> $140K. */
function fmtBig(v) {
  if (!isFinite(v) || v <= 0) return "?";
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + Math.round(v / 1e3) + "K";
  return "$" + Math.round(v);
}

/** Цена словами: у этих токенов много нулей после запятой. */
function fmtPrice(v) {
  if (!isFinite(v)) return "?";
  if (v >= 1) return "$" + v.toFixed(2);
  if (v >= 0.01) return "$" + v.toFixed(4);
  return "$" + v.toPrecision(3);
}

/**
 * Импульс поймали. Сами транзакции не подписываем и подписывать не можем:
 * жмём ту же кнопку «собрать фисы», что и руками, а подтверждение остаётся
 * в кошельке. Страница перед нажатием сверяет сумму с порогом — точные
 * цифры по комиссиям есть только у неё.
 */
async function onImpulse(t, why, price, S, fresh) {
  const reason =
    why.text || "импульс +" + Number(why.grew || 0).toFixed(0) + "%";
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: "https://liquidityladder.it.com/*" });
  } catch (e) {
    tabs = [];
  }
  const msg = {
    type: "impulse",
    chain: t.chain,
    addr: t.addr,
    label: t.label,
    reason,
    act: why.act || "fees",
    grew: why.grew || 0,
    minUsd: S.minUsd,
    price,
  };

  // Действуем только через открытую вкладку. Открытого API у сайта нет, и
  // повторять его внутренние запросы вслепую — гадание: формат меняется, а
  // ошибки вроде 422 разбирать не по чему. Кнопки на странице надёжнее.

  if (tabs.length) {
    // Поручение отдаём ровно одной вкладке. Если разослать всем, каждая
    // свободная возьмётся за дело — и один и тот же сбор уйдёт в цепь
    // несколько раз. Спрашиваем по очереди, пока кто-нибудь не возьмёт.
    const taken = await handOut(tabs, msg);
    if (taken) {
      recordOutcome(msg, taken.r, "через вкладку");
      maybeReload(taken.tabId, msg, taken.r);
      return;
    }
    // Ни одна не взялась — например, все на глазах у человека. Тогда заводим
    // свою и работаем в ней, а не сдаёмся.
  }

  // Вкладки нет — открываем её сами, в фоне.
  if (!fresh) return;
  await openAndQueue(msg, t.label || t.addr.slice(0, 10), reason);
}

/**
 * Завести свою вкладку и отдать ей поручение, когда она объявится.
 *
 * Сразу слать нечего: страница ещё грузится и позиций на ней нет. Поэтому
 * поручение кладём в очередь, а вкладка сама скажет, что готова (llReady).
 */
async function openAndQueue(msg, name, reason) {
  const key = msg.chain + ":" + String(msg.addr || "").toLowerCase();
  const home = tabOf.get(key);
  if (home && (await tabAlive(home))) {
    // У токена своя вкладка уже есть. Грузится — кладём поручение ей, она
    // заберёт его, когда поднимется. Поднялась, но не взялась — значит
    // занята делом; вторую под тот же токен не открываем, повторим позже.
    if (!readyAt.has(home)) {
      queueFor(home, msg);
      return true;
    }
    return false;
  }
  try {
    const tab = await chrome.tabs
      .create({ url: SITE + "/manage", active: false })
      .catch(() => null);
    if (!tab) throw new Error("вкладка не открылась");
    queueFor(tab.id, msg);
    mine.add(tab.id);
    bornAt.set(tab.id, Date.now());
    // Сразу отводим её этому токену: иначе keepTabs заведёт ему ещё одну.
    if (!tabOf.has(key)) tabOf.set(key, tab.id);
    await putInGroup(tab.id);
    await saveTabs();
    note(name + ": " + reason, "Открыл свою вкладку в фоне — соберу в ней");
    return true;
  } catch (e) {
    note(name + ": " + reason, "Не смог открыть вкладку — открой Liquidity Ladder сам");
    return false;
  }
}


let feesAt = 0;
// Цена из ответа их дашборда: она там уже есть, и это бесплатно. Узел
// спрашиваем только про токены, которых в дашборде нет.
const sitePrice = new Map();

/**
 * Сколько комиссий накопилось — спрашиваем у их же API.
 *
 * Это и есть простое правило, которого не хватало: не ждать пампа и не ждать
 * края диапазона, а собирать, как только набежало больше порога. Заголовок
 * авторизации берём из подсмотренного запроса — на голых куках API отвечает
 * 401.
 */
async function apiFees() {
  // Лучший вариант — повторить тот самый запрос дашборда: в нём и адрес
  // кошелька в параметрах, и авторизация. Без кошелька сайт список не
  // отдаёт, а взять его больше неоткуда.
  let stats = null;
  try {
    const v = await chrome.storage.local.get("llStats");
    stats = v && v.llStats;
  } catch (e) {
    stats = null;
  }
  if (stats && stats.url && stats.headers) {
    try {
      const res = await fetch(new URL(stats.url, SITE).href, {
        headers: { ...stats.headers },
        credentials: "include",
      });
      if (res.ok) {
        const j = await res.json();
        if (j && Array.isArray(j.open_pairs)) { apiWhy = ""; return j.open_pairs; }
        apiWhy = "ответ без списка леддеров";
      } else {
        apiWhy = res.status === 401 || res.status === 403
          ? "доступ протух (" + res.status + ") — войди на сайт и открой Dashboard"
          : "сайт ответил " + res.status;
        if (res.status === 401 || res.status === 403) loginLost("сайт не отдаёт список позиций (" + res.status + ")");
      }
    } catch (e) {
      apiWhy = "запрос не ушёл: " + String(e && e.message);
    }
  }

  let box = null;
  try {
    const v = await chrome.storage.local.get("llCollect");
    box = v && v.llCollect;
  } catch (e) {
    return null;
  }
  if (!box || !box.headers) {
    if (!apiWhy) apiWhy = "зайди на Dashboard — оттуда берётся доступ";
    return null;
  }
  if (!Object.keys(box.headers).some((k) => /^authorization$/i.test(k))) {
    apiWhy = "в подсмотренном запросе нет заголовка авторизации";
    return null;
  }

  // Сайт зовёт свой API относительным адресом, и тогда в запомненном запросе
  // лежит «/api/v1/…» без хоста. Из воркера такой адрес не собрать — берём
  // хост самого сайта.
  let root = SITE;
  try {
    root = new URL(String(box.url || ""), SITE).origin;
  } catch (e) {
    root = SITE;
  }

  try {
    const res = await fetch(root + "/api/v1/pnl/dashboard-stats", {
      headers: { ...box.headers },
      credentials: "include",
    });
    if (!res.ok) {
      apiWhy = res.status === 401 || res.status === 403
        ? "доступ протух (" + res.status + ") — собери фисы руками один раз"
        : "сайт ответил " + res.status;
      return null;
    }
    const j = await res.json();
    if (!j || !Array.isArray(j.open_pairs)) {
      apiWhy = "ответ без списка леддеров";
      return null;
    }
    apiWhy = "";
    return j.open_pairs;
  } catch (e) {
    apiWhy = "запрос не ушёл: " + String(e && e.message);
    return null;
  }
}

// Почему последний запрос к их API не удался — чтобы не гадать.
let apiWhy = "";

/**
 * Переписать список леддеров тем, что сейчас на самом деле открыто.
 * Раскладка — та же, что делает перехватчик на странице.
 */
async function savePairs(open) {
  const box = open
    .map((p) => ({
      token0: String(p.token0 || "").toLowerCase(),
      token1: String(p.token1 || "").toLowerCase(),
      symbols: [p.token0_symbol, p.token1_symbol].filter(Boolean).join("/"),
      chainId: p.chainId || p.chain_id,
      ids: Array.isArray(p.token_ids) ? p.token_ids.map(String) : [],
      positions: p.n_positions,
      lo: p.price_lower,
      hi: p.price_upper,
      current: p.current_price,
      unclaimed: p.unclaimed_fees_usd,
      claimed: typeof p.claimed_fees_usd === "number" ? p.claimed_fees_usd : null,
      pnl: p.unrealized_pnl_usd,
      apr: p.daily_apr,
      group: p.ladder_group_id,
    }))
    .filter((p) => p.ids.length);
  try {
    await chrome.storage.local.set({ [PAIRS_KEY]: { pairs: box, savedAt: Date.now() } });
  } catch (e) {
    /* хранилище недоступно — переживём до следующего раза */
  }
}

/**
 * Собрать всё, что переросло порог. Ходим по леддерам, а не по токенам:
 * комиссии капают в каждом своём.
 */
/**
 * Свежий список леддеров с сайта — раз в минуту, при любых настройках.
 *
 * Раньше список обновлялся только сбором по порогу, а он у многих выключен:
 * новая позиция не появлялась у сторожа и на графике, пока не зайдёшь на
 * Dashboard. Это один запрос к сайту в минуту, узел он не трогает.
 */
let pairsBox = { at: 0, pairs: null };
async function refreshPairs(maxAge) {
  if (pairsBox.pairs && Date.now() - pairsBox.at < (maxAge || 60000)) return pairsBox.pairs;
  const pairs = await apiFees();
  if (!pairs) return null;
  pairsBox = { at: Date.now(), pairs };
  await savePairs(pairs);
  for (const p of pairs) {
    const chain = CHAIN_OF[p.chainId] || CHAIN_OF[p.chain_id] || "robinhood";
    const side = tokenSide(chain, { token0: p.token0, token1: p.token1 });
    const px = Number(p.current_price);
    // Цена из того же ответа — бесплатно. Безумную отбросит pricesOf.
    if (side && isFinite(px) && px > 0) sitePrice.set(chain + ":" + side, { price: px, at: Date.now() });
  }
  return pairs;
}

async function sweepFees(S) {
  if (S.feesOn === false) return;
  const gap = Math.max(10, Number(S.feesSec) || 60) * 1000;
  if (Date.now() - feesAt < gap) return;
  feesAt = Date.now();

  const pairs = await refreshPairs(15000);
  if (!pairs) {
    lastErr = "комиссии не спросить: " + (apiWhy || "причина неизвестна");
    return;
  }

  const need = Math.max(0, Number(S.minUsd) || 0);
  const off = new Set(S.skip || []);
  // Страница собирает сразу все позиции токена, а леддеров у токена бывает
  // несколько. Без этой отметки второй леддер того же токена запускал второй
  // сбор следом за первым — пока сайт не успел пересчитать, лишний газ.
  const done = new Set();
  for (const p of pairs) {
    const chain = CHAIN_OF[p.chainId] || CHAIN_OF[p.chain_id] || "robinhood";
    // Заодно забираем цену: она в этом же ответе, платить за неё узлу не надо.
    const side = tokenSide(chain, { token0: p.token0, token1: p.token1 });
    const px = Number(p.current_price);
    if (side && isFinite(px) && px > 0) {
      sitePrice.set(chain + ":" + side, { price: px, at: Date.now() });
    }
    const key = ladderKey(chain, { group: p.ladder_group_id, token0: p.token0,
                                   lo: p.price_lower, hi: p.price_upper });
    if (off.has(key)) continue;
    const have = Number(p.unclaimed_fees_usd) || 0;
    if (have < need || have <= 0) continue;

    const ids = (p.token_ids || []).map(String);
    if (!ids.length) continue;
    const addr = tokenSide(chain, { token0: p.token0, token1: p.token1 });
    if (!addr || done.has(chain + ":" + addr)) continue;
    done.add(chain + ":" + addr);
    const label = [p.token0_symbol, p.token1_symbol].filter(Boolean).join("/");
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: SITE + "/*" });
    } catch (e) {
      tabs = [];
    }
    const name = label || addr.slice(0, 10);
    const why = "накопилось " + Math.round(have) + "$";
    const msg = {
      type: "impulse", chain, addr, label, reason: why,
      act: "fees", minUsd: need, price: Number(p.current_price) || 0,
    };
    const taken = await handOut(tabs, msg);
    if (taken) {
      recordOutcome(msg, taken.r, "через вкладку", have);
      maybeReload(taken.tabId, msg, taken.r);
      lastErr = "";
      continue;
    }
    // Своей вкладки нет или все заняты человеком. Заводим свою и отдаём
    // поручение ей, как это делает ценовой повод: сдаваться здесь нельзя,
    // иначе комиссии копятся, а в истории висит одно и то же «не взялась».
    const opened = await openAndQueue(msg, name, why);
    // Открытая вкладка — это ещё не собранные комиссии, а только начатое
    // дело. Записываем его отдельным состоянием: выдать ожидание за успех
    // значит соврать в той самой истории, ради которой она и заведена.
    remember({ at: Date.now(), what: name, how: "своя вкладка",
               ok: false, wait: opened, usd: have,
               why: opened ? "открыл вкладку, соберу в ней"
                           : "вкладка не открылась" });
    lastErr = opened ? "" : "не смог открыть вкладку для сбора";
    return;                         // одна вкладка за проход, не рой
  }
}


/**
 * Поручения для вкладок, которые мы открыли сами. Страница объявляется, как
 * только расширение на ней поднялось, — тогда и отдаём.
 */
const pending = new Map();

/**
 * Свои вкладки держим в отдельной группе: так они не мешаются среди твоих и
 * сразу видно, чьи они. Группа своя на всё время работы воркера.
 */
let groupId = 0;

const GROUP_TITLE = "сторож фисов";

/** Вкладка — промисом: у chrome.tabs.get в старых сборках только колбэк. */
function tabInfo(tabId) {
  return new Promise((res) => {
    try { chrome.tabs.get(tabId, (t) => { void chrome.runtime.lastError; res(t || null); }); }
    catch (e) { res(null); }
  });
}

/**
 * Положить свою вкладку в группу «сторож фисов».
 *
 * Группу ищем по названию в окне вкладки, а не по запомненному номеру:
 * после перезапуска Chrome номера у групп другие, и по старому номеру
 * вкладка не группировалась — оставалась болтаться рядом с группой.
 */
async function putInGroup(tabId) {
  if (!chrome.tabs.group) return;
  const tab = await tabInfo(tabId);
  let target = 0;
  try {
    if (tab && chrome.tabGroups && chrome.tabGroups.query) {
      const found = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId });
      if (found && found.length) target = found[0].id;
    }
  } catch (e) { target = 0; }
  try {
    groupId = await chrome.tabs.group(target ? { tabIds: [tabId], groupId: target } : { tabIds: [tabId] });
  } catch (e) {
    // Группа исчезла между поиском и вызовом — заводим новую.
    try { groupId = await chrome.tabs.group({ tabIds: [tabId] }); }
    catch (e2) { groupId = 0; return; }        // группировать нельзя — вкладка и так в фоне
  }
  try {
    if (chrome.tabGroups && chrome.tabGroups.update) {
      await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "yellow", collapsed: true });
    }
  } catch (e) { /* подписать не вышло — группа всё равно есть */ }
}

/**
 * Свои вкладки, простоявшие долго, — перезагрузить.
 *
 * Сайт обновляет сессию, и в вкладке, открытой часами, действия начинают
 * падать с «Session refreshed. Please retry.» — лечилось только ручным
 * обновлением. Раз в 40 минут перезагружаем свою вкладку, когда она без
 * дела и на неё никто не смотрит. Не поднимется после этого — её
 * переоткроет проверка мёртвых вкладок.
 */
const RELOAD_EVERY = 40 * 60000;
const reloadedAt = new Map();
async function refreshStale() {
  const now = Date.now();
  for (const id of [...mine]) {
    if (busy.has(id) || pending.has(id)) continue;
    if (!reloadedAt.has(id)) { reloadedAt.set(id, bornAt.get(id) || now); continue; }
    if (now - reloadedAt.get(id) < RELOAD_EVERY) continue;
    const t = await tabInfo(id);
    if (!t || t.active) continue;             // смотрят на неё — не дёргаем
    reloadedAt.set(id, now);
    bornAt.set(id, now);
    readyAt.delete(id);                       // до объявления поручения копятся
    try {
      const r = chrome.tabs.reload(id);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (e) { /* закрылась */ }
  }
}

/** Свои вкладки, отбившиеся от группы, — обратно в неё. */
let regroupAt = 0;
async function regroup() {
  if (Date.now() - regroupAt < 30000) return;
  regroupAt = Date.now();
  for (const id of [...mine]) {
    const t = await tabInfo(id);
    // -1 — «без группы» у Chrome.
    if (t && (t.groupId === -1 || t.groupId === undefined)) await putInGroup(id);
  }
}

// Какая своя вкладка какому токену отведена: «сеть:адрес» -> id вкладки.
const tabOf = new Map();
// С какого момента токен виден в списке и с какого пропал: вкладки дёргаем
// не сразу, иначе при частых открытиях и закрытиях они мелькают.
const seenSince = new Map();
const goneSince = new Map();

/**
 * Держим по фоновой вкладке на каждый открытый леддер.
 *
 * Позиция появилась — завели вкладку, закрылась — закрыли. Тогда сбору
 * всегда есть где сработать, и подменять твою вкладку не приходится вовсе.
 */
async function keepTabs(tokens, S, force) {
  if (S.keepTabs === false && !force) return;

  // Позиции открывают и закрывают часто, поэтому не дёргаем вкладки сразу:
  // иначе они будут мелькать на каждое действие. Ждём, пока токен побудет
  // в своём состоянии.
  const OPEN_AFTER = 30000;      // столько токен должен быть открыт
  const CLOSE_AFTER = 3 * 60000; // и столько — пропавшим
  const now = Date.now();
  const live = new Set(tokens.map((t) => t.chain + ":" + t.addr));

  for (const t of tokens) {
    const key = t.chain + ":" + t.addr;
    if (!seenSince.has(key)) seenSince.set(key, now);
    goneSince.delete(key);
  }
  for (const key of [...tabOf.keys()]) {
    if (live.has(key)) continue;
    if (!goneSince.has(key)) goneSince.set(key, now);
  }
  for (const key of [...seenSince.keys()]) if (!live.has(key)) seenSince.delete(key);

  // Закрываем вкладки токенов, которых давно нет.
  for (const [key, id] of [...tabOf.entries()]) {
    if (live.has(key)) continue;
    if (now - (goneSince.get(key) || now) < CLOSE_AFTER) continue;
    tabOf.delete(key);
    goneSince.delete(key);
    mine.delete(id);
    await saveTabs();
    try {
      const r = chrome.tabs.remove(id);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (e) { /* уже закрыта */ }
  }

  // Мёртвые вкладки. Вкладку могли закрыть руками, а страница могла и не
  // подняться вовсе — сайт увёл на вход, или вкладка выгружена из памяти.
  // И то и другое раньше оставалось незамеченным: id висел в списке, токен
  // считался прикрытым, а поручения уходили в пустоту.
  const DEAD_AFTER = 90000;      // столько ждём объявления страницы
  for (const [key, id] of [...tabOf.entries()]) {
    const gone = !(await tabAlive(id));
    const mute = !gone && !readyAt.has(id)
      && now - (bornAt.get(id) || now) > DEAD_AFTER;
    if (!gone && !mute) continue;
    forgetTab(id);
    if (mute) {
      tabTrouble = "вкладка не поднялась (сайт мог увести на вход) — переоткрываю";
      try {
        const r = chrome.tabs.remove(id);
        if (r && typeof r.catch === "function") r.catch(() => {});
      } catch (e) { /* уже нет */ }
    }
    // seenSince у токена остаётся прежним, поэтому вкладка заведётся снова
    // тем же проходом ниже, без лишней паузы.
    void key;
  }

  // Лишние свои вкладки: не отведены ни одному токену, поручения в них нет
  // и дела тоже. Это хвосты разовых сборов и вкладки прошлых версий — раньше
  // они висели, пока их не закроешь руками.
  const assigned = new Set(tabOf.values());
  for (const id of [...mine]) {
    if (assigned.has(id) || pending.has(id) || busy.has(id)) continue;
    if (now - (bornAt.get(id) || now) < 2 * 60000) continue;
    forgetTab(id);
    try {
      const r = chrome.tabs.remove(id);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (e) { /* уже закрыта */ }
  }

  // И заводим недостающие. Предел ставит человек; без него — по вкладке на
  // каждый токен, но не больше аварийного потолка: если где-то ошибка и
  // вкладки не узнаются, они не должны плодиться без конца.
  const cap = tabCap(S);
  let short = 0;
  for (const t of tokens) {
    const key = t.chain + ":" + t.addr;
    if (tabOf.has(key)) continue;
    if (tabOf.size >= cap) { short++; continue; }
    if (!force && now - (seenSince.get(key) || now) < OPEN_AFTER) continue;
    let tab = null;
    try {
      tab = await chrome.tabs
        .create({ url: SITE + "/manage", active: false })
        .catch(() => null);
    } catch (e) { tab = null; }
    if (!tab) {
      // Браузер отказал — чаще всего окон нет вовсе (все свёрнуты в другой
      // профиль) либо вкладок уже слишком много. Молчать об этом нельзя.
      tabTrouble = "Chrome не дал открыть вкладку — открой Liquidity Ladder сам";
      break;
    }
    tabOf.set(key, tab.id);
    mine.add(tab.id);
    bornAt.set(tab.id, Date.now());
    await putInGroup(tab.id);
    await saveTabs();
  }
  if (short) {
    tabTrouble = cap >= HARD_CAP
      ? "токенов больше " + HARD_CAP + " — на лишние вкладок не хватит"
      : "вкладок не хватает на все токены (предел " + cap
        + ") — поставь 0 в «не больше … вкладок»";
  } else if (/^(вкладок не хватает|токенов больше)/.test(tabTrouble)) {
    tabTrouble = "";
  }
}

const HARD_CAP = 40;

/** Сколько своих вкладок можно держать. 0 в настройках — без предела. */
function tabCap(S) {
  const want = Number(S.maxTabs) || 0;
  return want > 0 ? Math.min(want, HARD_CAP) : HARD_CAP;
}

/** Жива ли вкладка. chrome.tabs.get на закрытой отвечает ошибкой. */
async function tabAlive(id) {
  return new Promise((res) => {
    try {
      chrome.tabs.get(id, (t) => { void chrome.runtime.lastError; res(!!t); });
    } catch (e) { res(false); }
  });
}

/**
 * Что сейчас со вкладками сторожа — для пульта в настройках.
 *
 * Человеку важно видеть не «включено/выключено», а простое: на каждый ли
 * леддер есть живая вкладка, и если нет — почему.
 */
async function tabsReport() {
  await restoreTabs();
  const S = await watchSettings();
  const tokens = withLevels(await watchedTokens(S.skip), S.levels);
  const rows = [];
  for (const t of tokens) {
    if (t.levelsOnly) continue;
    const key = t.chain + ":" + t.addr;
    const id = tabOf.get(key) || 0;
    const alive = id ? await tabAlive(id) : false;
    rows.push({
      key,
      label: t.label || t.addr.slice(0, 10),
      tabId: alive ? id : 0,
      state: !alive ? "нет" : readyAt.has(id) ? "готова" : "грузится",
    });
  }
  const assigned = new Set(tabOf.values());
  return {
    rows,
    extra: [...mine].filter((id) => !assigned.has(id)).length,
    cap: Number(S.maxTabs) > 0 ? tabCap(S) : 0,
    on: S.keepTabs !== false,
    trouble: tabTrouble,
  };
}

/** Открыть недостающие вкладки прямо сейчас — кнопкой, без выдержки. */
async function openTabsNow() {
  await restoreTabs();
  const S = await watchSettings();
  const tokens = withLevels(await watchedTokens(S.skip), S.levels);
  const withPos = tokens.filter((t) => !t.levelsOnly);
  if (!withPos.length) return { ok: false, error: "нет ни одного включённого леддера" };
  tabTrouble = "";
  await keepTabs(withPos, S, true);
  return { ok: !tabTrouble, error: tabTrouble, ...(await tabsReport()) };
}

/** Закрыть все свои вкладки. Чужие не трогаем никогда. */
async function closeTabsNow() {
  await restoreTabs();
  const ids = [...mine];
  for (const id of ids) {
    forgetTab(id);
    try {
      const r = chrome.tabs.remove(id);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (e) { /* уже закрыта */ }
  }
  tabTrouble = "";
  return { ok: true, closed: ids.length };
}

// Вкладки, открытые сторожем: их же и закрываем, когда дело сделано.
const mine = new Set();
// Вкладки, которые прямо сейчас выполняют поручение: такие не закрываем.
const busy = new Set();

/*
 * Воркер в MV3 засыпает через полминуты без дела, и всё, что лежит в
 * памяти, пропадает. Раньше вместе с ним пропадал и список своих вкладок:
 * после пробуждения сторож переставал узнавать собственные вкладки —
 * сбор в них не уходил («ни одна вкладка не взялась»), а keepTabs заводил
 * поверх новые, пока не упирался в предел. Поэтому список переживает сон
 * в хранилище, а при пробуждении сверяется с живыми вкладками.
 */
const TABS_KEY = "ghoTabs";
let restored = false;

// id вкладки -> когда она объявилась (llReady). Вкладка без отметки либо
// ещё грузится, либо на ней не поднялось расширение — например, сайт увёл
// на вход. Отличать эти случаи нужно: во втором вкладка бесполезна и её
// надо переоткрыть, а не ждать вечно.
const readyAt = new Map();
const bornAt = new Map();
// Что именно не получилось с вкладками — показываем человеку словами.
let tabTrouble = "";

function markReady(tabId) {
  if (tabId === undefined || tabId === null) return;
  readyAt.set(tabId, Date.now());
  if (mine.has(tabId)) tabTrouble = "";
}

/** Вкладка исчезла — из своих списков её надо убрать, иначе сторож будет
 *  отдавать поручения в пустоту и считать, что токен прикрыт. */
function forgetTab(tabId) {
  if (tabId === undefined || tabId === null) return;
  let had = mine.delete(tabId);
  readyAt.delete(tabId);
  reloadedAt.delete(tabId);
  bornAt.delete(tabId);
  pending.delete(tabId);
  for (const [key, id] of [...tabOf.entries()]) {
    if (id === tabId) { tabOf.delete(key); had = true; }
  }
  if (had) void saveTabs();
  return had;
}

async function saveTabs() {
  try {
    await chrome.storage.local.set({
      [TABS_KEY]: { mine: [...mine], tabOf: [...tabOf.entries()], groupId },
    });
  } catch (e) { /* не сохранилось — переживём, просто заведём заново */ }
}

/**
 * Вкладки прошлых версий: они жили только в памяти воркера и после его сна
 * становились ничьими — висели в группе «сторож фисов», и их никто не
 * закрывал. Узнаём их по группе и сайту и берём обратно в свои: лишние
 * закроются сами.
 */
async function adoptOrphans(alive) {
  try {
    if (!chrome.tabGroups || !chrome.tabGroups.query) return;
    const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
    for (const g of groups || []) {
      const tabs = await chrome.tabs.query({ groupId: g.id });
      for (const t of tabs || []) {
        if (!String(t.url || "").startsWith(SITE)) continue;
        if (mine.has(t.id)) continue;
        mine.add(t.id);
        bornAt.set(t.id, Date.now());
        if (alive) alive.add(t.id);
      }
      if (!groupId) groupId = g.id;
    }
  } catch (e) { /* групп нет — усыновлять некого */ }
}

async function restoreTabs() {
  if (restored) return;
  restored = true;
  let box = null;
  try {
    const got = await chrome.storage.local.get(TABS_KEY);
    box = got && got[TABS_KEY];
  } catch (e) { box = null; }
  if (!box) { await adoptOrphans(null); await saveTabs(); return; }

  // Проверяем каждую: пока воркер спал, человек мог их закрыть сам.
  const alive = new Set();
  for (const id of box.mine || []) {
    const tab = await new Promise((res) => {
      try { chrome.tabs.get(id, (t) => { void chrome.runtime.lastError; res(t || null); }); }
      catch (e) { res(null); }
    });
    if (tab) { alive.add(id); mine.add(id); }
  }
  for (const [key, id] of box.tabOf || []) if (alive.has(id)) tabOf.set(key, id);
  if (box.groupId && alive.size) groupId = box.groupId;
  await adoptOrphans(alive);

  // Кто из них ещё и отвечает. Живая вкладка — не то же самое, что рабочая:
  // страница могла уйти на вход, а расширение на ней — не подняться.
  for (const id of alive) {
    bornAt.set(id, Date.now());
    const up = await new Promise((res) => {
      try {
        chrome.tabs.sendMessage(id, { type: "ping" }, (r) => {
          void chrome.runtime.lastError;
          res(!!(r && r.alive));
        });
      } catch (e) { res(false); }
    });
    if (up) markReady(id);
    else {
      // Не отвечает — чаще всего расширение обновили, и скрипт в этой вкладке
      // остался от старой версии. Ждать 90 секунд до «мёртвой вкладки»
      // незачем: своя вкладка, обновляем сразу.
      reloadedAt.set(id, Date.now());
      try {
        const r = chrome.tabs.reload(id);
        if (r && typeof r.catch === "function") r.catch(() => {});
      } catch (e) { /* закрылась */ }
    }
  }
  await saveTabs();
}

function closeMine(tabId) {
  if (tabId === undefined || !mine.has(tabId)) return;
  // Вкладку, отведённую токену, держим открытой: она ещё пригодится.
  for (const id of tabOf.values()) if (id === tabId) return;
  mine.delete(tabId);
  void saveTabs();
  // Небольшая пауза: пусть сайт успеет отправить транзакцию.
  setTimeout(() => {
    try {
      const r = chrome.tabs.remove(tabId);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (e) { /* уже закрыта */ }
  }, 15000);
}

/**
 * Поставить поручение в очередь вкладки, которая ещё грузится.
 *
 * Раньше место было одно, и второе поручение затирало первое: закрытие по
 * тейку, пока вкладка грузилась, заменялось сбором фисов — и не случалось
 * вовсе, а пересечение уровня к тому времени было уже истрачено. Теперь
 * очередь: одинаковые (то же действие по тому же токену) не дублируем,
 * закрытие ставим первым.
 */
function queueFor(tabId, msg) {
  const list = (pending.get(tabId) || []).filter((x) => !(x.msg.addr === msg.addr
    && (x.msg.act || "fees") === (msg.act || "fees")));
  list.push({ msg, at: Date.now() });
  list.sort((a, b) => (a.msg.act === "close" ? 0 : 1) - (b.msg.act === "close" ? 0 : 1));
  pending.set(tabId, list);
}

function flushPending(tabId) {
  const list = pending.get(tabId);
  if (!list || !list.length) return false;
  pending.delete(tabId);
  const fresh = list.filter((x) => Date.now() - x.at <= 120000);   // протухшие не шлём
  if (!fresh.length) return false;
  // По одному: следующее — только когда страница ответила на предыдущее.
  // Два нажатия сразу на одной странице перебивали бы друг друга.
  const next = (i) => {
    if (i >= fresh.length) return;
    const box = fresh[i];
    try {
      chrome.tabs.sendMessage(tabId, { ...box.msg, own: true }, (r) => {
        void chrome.runtime.lastError;
        recordOutcome(box.msg, r || { handled: false }, "своя вкладка");
        // Сессия устарела — вкладка перезагрузится, остальное пойдёт после.
        if (maybeReload(tabId, box.msg, r)) {
          for (const rest of fresh.slice(i + 1)) queueFor(tabId, rest.msg);
          return;
        }
        next(i + 1);
      });
    } catch (e) { /* вкладка закрылась прямо сейчас */ }
  };
  next(0);
  return true;
}

/**
 * Раздать поручение вкладкам по одной, пока кто-нибудь не возьмётся.
 *
 * Вкладка отвечает «взял» только если правда может действовать: у неё
 * открыт нужный токен и человек в ней сейчас не работает.
 */
async function handOut(tabs, msg) {
  // Работаем только в своих вкладках. Вкладки, которые человек открыл сам, —
  // его: там нельзя ни подменять содержимое, ни нажимать. Не нашлось своей —
  // заведём новую, это дешевле любого сюрприза.
  // Сперва — вкладка, отведённая этому токену: у неё он, скорее всего, уже
  // открыт, и перезагружать Manage не придётся.
  const home = tabOf.get(msg.chain + ":" + String(msg.addr || "").toLowerCase());
  const own = tabs.filter((tab) => mine.has(tab.id))
    .sort((a, b) => (a.id === home ? -1 : b.id === home ? 1 : 0));
  for (const tab of own) {
    busy.add(tab.id);
    const r = await new Promise((res) => {
      let done = false;
      let timer = 0;
      const finish = (v) => { if (!done) { done = true; clearTimeout(timer); res(v); } };
      // Сбор с проверкой занимает до минуты: отметить позиции, нажать,
      // дважды пересчитать фисы. Раньше ждали 20 секунд и считали молчание
      // отказом — и отдавали тот же сбор следующей вкладке, то есть второй
      // раз. Молчание — это «занята делом», а не «не могу».
      timer = setTimeout(() => finish({ handled: true, did: "unknown",
                                        why: "вкладка не ответила за 2 минуты" }), 120000);
      try {
        chrome.tabs.sendMessage(tab.id, { ...msg, own: true }, (r) => {
          // Нет скрипта на странице — ответ приходит сразу с ошибкой.
          void chrome.runtime.lastError;
          finish(r || { handled: false });
        });
      } catch (e) {
        finish({ handled: false });
      }
    });
    busy.delete(tab.id);
    if (r && r.handled) return { tabId: tab.id, r };
  }
  return null;
}

/**
 * Записать в историю, чем кончилось поручение, — словами страницы.
 *
 * Раньше писалось одно «вкладка взялась», и под ним пряталось всё сразу:
 * собрала, нажала без подтверждения, ждёт порога. Отсюда и «непонятно как».
 */
const DID_TEXT = {
  collected: "собрал — фисы ушли",
  closed: "закрыл позиции",
  sent: "нажал Collect, но пересчёт не показал, что фисы ушли",
  wait: "фисов на странице меньше порога — жду",
  dry: "проверка",
  unknown: "вкладка занята и не ответила",
  reload: "сайт обновил сессию — перезагрузил вкладку, повторю",
  login: "на сайте слетел вход — войди в Liquidity Ladder",
  fail: "не вышло",
};

/**
 * Страница ответила «сайт обновил сессию»: действие не прошло, и в этой
 * странице уже не пройдёт. Свою вкладку перезагружаем и ставим то же
 * поручение в её очередь — оно уйдёт, когда страница объявится. Не больше
 * двух раз на одно поручение, чтобы не крутиться по кругу.
 */
function maybeReload(tabId, msg, r) {
  if (!r || r.did !== "reload" || !mine.has(tabId)) return false;
  const tries = (Number(msg.tries) || 0) + 1;
  if (tries > 2) return false;
  queueFor(tabId, { ...msg, tries });
  readyAt.delete(tabId);
  bornAt.set(tabId, Date.now());
  reloadedAt.set(tabId, Date.now());
  try {
    const p = chrome.tabs.reload(tabId);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) { /* вкладка закрылась */ }
  return true;
}

/**
 * Слетел вход на сайте — сторож без него бессилен: ни список позиций не
 * обновить, ни нажать. Об этом надо сказать уведомлением, но не на каждой
 * проверке: раз в полчаса хватит.
 */
let loginNoteAt = 0;
function loginLost(why) {
  tabTrouble = "слетел вход на Liquidity Ladder — войди, без этого сторож не соберёт";
  if (Date.now() - loginNoteAt < 30 * 60000) return;
  loginNoteAt = Date.now();
  note("Liquidity Ladder: слетел вход", (why ? why + ". " : "")
    + "Сторож не может собирать фисы и закрывать позиции, пока ты не войдёшь на сайт.");
}

function recordOutcome(msg, r, how, usd) {
  if (r && r.did === "login") loginLost("вкладка сторожа показывает страницу входа");
  const did = (r && r.did) || (r && r.handled ? "unknown" : "refused");
  const text = DID_TEXT[did] || "ни одна вкладка не взялась";
  remember({
    at: Date.now(),
    what: msg.label || String(msg.addr || "").slice(0, 10),
    how,
    did,
    ok: did === "collected" || did === "closed",
    usd: (r && isFinite(r.usd) && r.usd !== null ? r.usd : usd) || 0,
    reason: msg.reason,
    why: text + (r && r.why && did !== "wait" ? ": " + r.why : ""),
  });
  return did;
}

/**
 * Отправить сообщение вкладке.
 *
 * Без колбэка chrome.tabs.sendMessage возвращает промис, и его отказ мимо
 * try/catch летит в лог расширения как «Receiving end does not exist». А
 * вкладка без нашего скрипта — обычное дело: страница ещё грузится или это
 * вообще не наш раздел сайта. С колбэком ошибка уходит в lastError.
 */
function tell(tabId, msg) {
  try {
    chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
  } catch (e) {
    /* вкладка закрылась прямо сейчас */
  }
}

/** Уведомление Chrome. Показываем только по делу, а не на каждой проверке. */
function note(title, message) {
  try {
    const made = chrome.notifications.create("gho-" + Date.now(), {
      type: "basic",
      iconUrl: "icons/128.png",
      title,
      message,
    });
    // Тоже промис: без иконки или с запретом на уведомления он отказывает,
    // и отказ мимо try/catch уходит в ошибки расширения.
    if (made && typeof made.catch === "function") made.catch(() => {});
  } catch (e) {
    /* уведомления запрещены — не повод падать */
  }
}

/** Цикл, который сам себя продлевает: каждое обращение к сети отодвигает сон. */
// Ждущий таймер следующей проверки. Пока он есть, будильник новую цепочку
// не заводит: иначе каждую минуту добавлялась ещё одна, и проверки шли
// в несколько потоков — с кратной платой за каждый запрос к узлу.
let nextTimer = 0;

async function loop() {
  if (ticking || nextTimer) return;
  ticking = true;
  let next = 0;
  try {
    const S = await watchSettings();
    // Список леддеров обновляем и при выключенном стороже: по нему живут
    // график и вкладки, а новые позиции открывают часто.
    await refreshPairs(60000).catch(() => null);
    // Выключен — просто выходим. Раньше этот выход пропускал снятие флага
    // ниже, и после выключения цикл не запускался больше никогда: включаешь
    // сторожа обратно — тишина, пока Chrome сам не перезапустит воркер.
    if (!S.on) return;
    await watchTick();
    // Не число в настройке давало setTimeout(NaN) — то есть ноль, и цикл
    // долбил узел без паузы.
    next = Math.max(5, Number(S.everySec) || 5) * 1000;
  } catch (e) {
    /* упало — подберёт будильник */
  } finally {
    ticking = false;
  }
  if (next) nextTimer = setTimeout(() => { nextTimer = 0; loop(); }, next);
}

// Будильник поднимает воркер раз в минуту, но ждать его при первом запуске
// незачем — начинаем сразу.
loop();

try {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === ALARM) loop();
  });
} catch (e) {
  /* нет разрешения — сторож просто не работает */
}

/**
 * Сухой прогон боевого пути: доступ, свежий список леддеров, что бы собралось.
 * Ничего не собирает — только докладывает.
 */
async function dryRun(minUsd) {
  const out = { access: false, age: null, pairs: [], need: Math.max(0, Number(minUsd) || 0) };
  let canCollect = false;
  try {
    const v = await chrome.storage.local.get(["llCollect", "llStats"]);
    const col = v && v.llCollect;
    const st = v && v.llStats;
    canCollect = !!(col && col.body && col.headers);
    out.access = !!(st && st.url && st.headers);
    out.canCollect = canCollect;
    const at = (st && st.at) || (col && col.at);
    if (at) out.age = Date.now() - at;
  } catch (e) {
    return { ...out, error: "хранилище недоступно" };
  }
  if (!out.access && !canCollect) {
    return { ...out, error: "зайди на Dashboard — оттуда берётся доступ к их API" };
  }

  const open = await apiFees();
  if (!open) return { ...out, error: "их API не ответил: " + (apiWhy || "причина неизвестна") };

  await savePairs(open);
  const off = new Set();
  try {
    const v = await chrome.storage.local.get(WATCH_KEY);
    for (const k of ((v && v[WATCH_KEY] && v[WATCH_KEY].skip) || [])) off.add(k);
  } catch (e) { /* без списка выключенных — покажем всё */ }

  for (const p of open) {
    const chain = CHAIN_OF[p.chainId] || CHAIN_OF[p.chain_id] || "robinhood";
    const key = ladderKey(chain, { group: p.ladder_group_id, token0: p.token0,
                                   lo: p.price_lower, hi: p.price_upper });
    const have = Number(p.unclaimed_fees_usd) || 0;
    out.pairs.push({
      label: [p.token0_symbol, p.token1_symbol].filter(Boolean).join("/"),
      usd: have,
      ids: (p.token_ids || []).length,
      off: off.has(key),
      would: !off.has(key) && have >= out.need && have > 0,
    });
  }
  return out;
}

/** Что сторож видит прямо сейчас — для показа в настройках. */
function watchStatus() {
  return {
    lastRun,
    lastAct,
    log: log.slice(0, 6),
    error: lastErr,
    trouble: tabTrouble,
    tabs: tabOf.size,
    tokens: [...seen.entries()].map(([key, v]) => ({ key, ...v })),
  };
}

/*
 * Настройки сторожа из общих настроек окна (llChart). Раньше их выводило
 * только окно на Liquidity Ladder (pushWatch) — и правка из меню расширения
 * не доходила бы до сторожа, пока окно не откроют. Теперь выводит и сам
 * воркер, по той же схеме; тест держит обе схемы одинаковыми.
 */
function watchFromChart(S) {
  const edgeArmed = S.edgeHi === true || S.edgeLo === true;
  return {
    on: S.watchOn === true,
    pumpOn: S.pumpOn !== false,
    feesOn: S.feesOn !== false,
    feesSec: Math.max(10, Number(S.feesSec) || 60),
    keepTabs: S.keepTabs !== false,
    maxTabs: Math.max(0, Number(S.maxTabs) || 0),
    pumpPct: Number(S.pumpPct) || 50,
    windowMin: Number(S.windowMin) || 5,
    minUsd: Math.max(0, Number(S.minUsd) || 0),
    quietSec: Math.max(0, Number(S.quietSec) || 0),
    everySec: Math.max(1, Number(S.everySec) || 5),
    edgeOn: edgeArmed,
    edgePct: Math.max(0, Number(S.edgePct) || 0),
    fadePct: Math.max(0, Number(S.fadePct) || 0),
    edgeHi: S.edgeHi === true,
    edgeLo: S.edgeLo === true,
    skip: Array.isArray(S.watchSkip) ? S.watchSkip : [],
    levels: S.takeLevels && typeof S.takeLevels === "object" ? S.takeLevels : {},
    pump: S.tokenPump && typeof S.tokenPump === "object" ? S.tokenPump : {},
  };
}

try {
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || !ch.llChart || !ch.llChart.newValue) return;
    try { chrome.storage.local.set({ [WATCH_KEY]: watchFromChart(ch.llChart.newValue) }); }
    catch (e) { /* хранилище недоступно */ }
  });
} catch (e) { /* нет хранилища — сторож читает то, что есть */ }

/** Вкладка сторожа сообщила, чем кончился повторный вход на сайт. */
function reloginReport(ok, step) {
  if (ok) {
    if (/^слетел вход/.test(tabTrouble)) tabTrouble = "";
    remember({ at: Date.now(), what: "вход на сайт", how: "своя вкладка", ok: true, did: "collected",
               why: "сессия истекла — вошёл заново сам" });
    return;
  }
  if (step === "reload") return;              // обновила страницу — ждём, чем кончится вход
  loginLost("вкладка сторожа не смогла войти заново — войди руками");
}

self.GHO_WATCH = {
  watchFromChart,
  isMine: (id) => mine.has(id),
  reloginReport,
  WATCH_KEY,
  WATCH_DEFAULTS,
  impulse,
  atEdge,
  atLevel,
  ladderKey,
  tokenSide,
  watchStatus,
  dryRun,
  flushPending,
  markReady,
  forgetTab,
  tabsReport,
  openTabsNow,
  closeTabsNow,
  closeMine,
  keepTabs,
  apiFees,
  apiWhyOf: () => apiWhy,
  savePairs,
  sweepFees,
  withLevels,
  watchTick,
  loop,
  note,
};
