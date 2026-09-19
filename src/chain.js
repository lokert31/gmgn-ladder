/*
 * Чтение глубины пула Uniswap V4 прямо с цепи.
 *
 * Зачем: общую ликвидность токена по уровням цены не отдаёт никто — ни
 * Liquidity Ladder (у него в бандле только операции), ни GMGN (у него одна
 * суммарная цифра). Она лежит в самом пуле, разложенная по тикам.
 *
 * Читаем через StateView — штатный контракт-читалку V4. Прямой extsload из
 * PoolManager не годится: слоты структуры отдаются, а вложенные отображения
 * ticks и tickBitmap пусты при любом смещении (проверено перебором 0..39),
 * раскладка у этой сети своя.
 *
 * Селекторы посчитаны заранее: keccak в сервис-воркере считать нечем.
 */

const SEL = {
  slot0: '0xc815641c',            // getSlot0(bytes32)
  liquidity: '0xfa6793d5',        // getLiquidity(bytes32)
  bitmap: '0x1c7ccb4c',           // getTickBitmap(bytes32,int16)
  tickLiq: '0xcaedab54',          // getTickLiquidity(bytes32,int24)
  poolInfo: '0x7ba03aad',         // getPoolAndPositionInfo(uint256)
  posLiq: '0x1efeed33',           // getPositionLiquidity(uint256)
  posInfo: '0xdacf1d2f',          // getPositionInfo(bytes32,address,int24,int24,bytes32)
  feeInside: '0x53e9c1fb',        // getFeeGrowthInside(bytes32,int24,int24)
};

// Событие создания пула: из него берём шаг тика и обе валюты. Топик посчитан
// заранее — keccak в сервис-воркере считать нечем.
const INIT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const SEL_DECIMALS = '0x313ce567';

const hex = (n, bytes = 32) => {
  let v = BigInt(n);
  if (v < 0n) v += 1n << BigInt(bytes * 8);
  return v.toString(16).padStart(bytes * 2, '0');
};
const word = (data, i) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64));
// ABI расширяет int24 и int128 до полных 256 бит, поэтому и разбирать надо
// как int256. Раньше я брал 24 и 128 — на положительных числах разницы нет,
// а отрицательный тик превращался в 1.15e77, и весь расчёт рассыпался.
const signed = (v) => (v >= 1n << 255n ? v - (1n << 256n) : v);

/*
 * Два узла на разное. Чтение состояния (цена, ликвидность, тики) — это
 * почти все запросы, и их можно отдавать быстрому узлу без счётчика
 * (OrbitFlare). Но события (eth_getLogs) он отдаёт окнами по 10 000 блоков —
 * это 17 минут цепи, — поэтому поиск пулов и сделок остаётся на основном.
 */
const stateUrl = (net) => (net && net.stateRpc) || net.rpc;

async function ethCall(rpc, to, data) {
  const body = await postJson(rpc, { jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{ to, data }, 'latest'] });
  if (body.error) throw new Error(body.error.message || 'eth_call');
  return body.result;
}

/** Пачка вызовов одним запросом: иначе тридцать чтений подряд — это минуты. */
// Сколько вызовов кладём в один запрос. Узел не берёт пачку любого размера:
// у токена с пятью тысячами пулов ответ на всё разом обрывался на середине,
// и разбор падал с «Unexpected end of JSON input».
// 100 — предел и у публичного узла, и у OrbitFlare: на 200 оба отвечают
// «batch size limit exceeded», и вся пачка пропадает.
const BATCH = 100;
const LANES = 4;      // столько пачек держим в полёте одновременно
// Сколько пулов вообще проверяем на ликвидность: у самых бойких токенов их
// тысячи, и чтение всех подряд упирается в ограничения узла.
const MAX_PROBE = 900;

async function rpcBatch(url, calls) {
  const out = new Array(calls.length).fill(null);
  const chunks = [];
  for (let i = 0; i < calls.length; i += BATCH) chunks.push(i);

  let next = 0;
  const lane = async () => {
    while (next < chunks.length) {
      const at = chunks[next++];
      const part = calls.slice(at, at + BATCH);
      const body = await postJson(url, part.map((c, i) => ({
        jsonrpc: '2.0', id: at + i, method: 'eth_call',
        params: [{ to: c.to, data: c.data }, 'latest'],
      })));
      for (const r of Array.isArray(body) ? body : []) {
        if (!r.error && r.id >= 0 && r.id < out.length) out[r.id] = r.result;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LANES, chunks.length) }, lane));
  return out;
}

/**
 * Один POST с разбором ответа. Узел под нагрузкой отдаёт то пустое тело, то
 * страницу об ошибке — без этого наружу вылезало «Unexpected end of JSON
 * input», по которому нельзя понять, что случилось.
 */
// Узлы с лимитом запросов в секунду: не чаще раза в gap мс. OrbitFlare на
// бесплатном тарифе держит 10 в секунду — берём 9 с запасом. Без этого скан
// топа токенов упирался в 429, и глубина пропадала.
const PACE = [{ test: /orbitflare/i, gap: 110 }];
const paceTail = new Map();
function paced(url) {
  const rule = PACE.find((r) => r.test.test(String(url)));
  if (!rule) return Promise.resolve();
  const prev = paceTail.get(rule) || Promise.resolve();
  const next = prev.then(() => new Promise((r) => setTimeout(r, rule.gap)));
  paceTail.set(rule, next);
  return prev;
}

async function postJson(url, payload) {
  await paced(url);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!text) {
    throw new Error(res.ok ? 'узел вернул пустой ответ' : 'узел ответил ' + res.status);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(res.ok
      ? 'узел вернул не JSON (ответ на ' + text.length + ' байт оборвался)'
      : 'узел ответил ' + res.status);
  }
}

/** Пачка любых вызовов одним запросом — для логов и номера блока. */
async function rpcMany(url, calls) {
  if (!calls.length) return [];
  const body = await postJson(url, calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params })));
  const out = new Array(calls.length).fill(null);
  for (const r of Array.isArray(body) ? body : []) {
    if (!r.error && r.id >= 0 && r.id < out.length) out[r.id] = r.result;
  }
  return out;
}

async function rpc(url, method, params) {
  const body = await postJson(url, { jsonrpc: '2.0', id: 1, method, params });
  if (body.error) throw new Error(body.error.message || method);
  return body.result;
}

/**
 * Параметры пула по его id: шаг тика и валюты лежат в событии Initialize.
 * Иначе их взять неоткуда — StateView отдаёт только состояние, не ключ.
 */
/**
 * Все пулы токена — прямо из логов создания. Так не нужны ни GMGN, ни его
 * подписи запросов: цепь знает про свои пулы сама.
 */
// Ошибку узла глотать нельзя: пустой список неотличим от «у токена нет
// пулов», и расширение уверенно врало, что пулов нет, когда узел просто
// отказал.
async function poolsOfToken(net, token) {
  const topic = '0x' + token.slice(2).toLowerCase().padStart(64, '0');
  const out = [];
  // Токен бывает и первой, и второй валютой пула. Оба запроса независимы,
  // а логи за всю историю — самое медленное место: ждать их по очереди
  // значит удваивать самую дорогую паузу разбора.
  const both = await Promise.all([2, 3].map((pos) => {
    const topics = [INIT_TOPIC, null, null, null];
    topics[pos] = topic;
    return rpc(net.rpc, 'eth_getLogs', [{
      address: net.poolManager, topics, fromBlock: '0x0', toBlock: 'latest',
    }]);
  }));
  for (const logs of both) {
    for (const lg of logs || []) out.push(parseInit(lg));
  }
  return out;
}

/** Событие создания пула → его ключ. */
function parseInit(lg) {
  return {
    poolId: lg.topics[1],
    currency0: '0x' + lg.topics[2].slice(26),
    currency1: '0x' + lg.topics[3].slice(26),
    fee: Number(word(lg.data, 0)),
    tickSpacing: Number(signed(word(lg.data, 1))),
    // Хук отделяет пул лаунчпада от обычных: у лаунчпадного ликвидность
    // копится сама из торгов, в остальные её заводят руками.
    hooks: '0x' + lg.data.slice(2 + 64 * 2 + 24, 2 + 64 * 3),
  };
}

/*
 * Ключ пула по его id — без поиска по всей истории цепи.
 *
 * Все пулы токена по событиям с начала цепи отдаёт только публичный узел,
 * а он общий с ботами и то и дело отвечает 429. Быстрые узлы (OrbitFlare)
 * отдают события окнами по 10 000 блоков. Зато время создания пула знает
 * GeckoTerminal: по нему находим блок и ищем одно событие в узком окне.
 */
let headBox = { at: 0, n: 0, t: 0 };
async function blockInfo(url, n) {
  if (n === 'latest' && Date.now() - headBox.at < 10000) return headBox;
  const b = await rpc(url, 'eth_getBlockByNumber', [n === 'latest' ? 'latest' : '0x' + n.toString(16), false]);
  const out = { n: parseInt(b.number, 16), t: parseInt(b.timestamp, 16), at: Date.now() };
  if (n === 'latest') headBox = out;
  return out;
}

/** Блок на момент времени: оценка по темпу цепи и пара уточнений. */
async function blockAt(net, ts) {
  const url = stateUrl(net);
  const head = await blockInfo(url, 'latest');
  if (ts >= head.t) return head.n;
  let b = Math.max(1, head.n - Math.round((head.t - ts) / 0.1));
  for (let i = 0; i < 4; i++) {
    const x = await blockInfo(url, b);
    const diff = x.t - ts;
    if (Math.abs(diff) <= 20) return b;
    // Блоки на этой цепи идут неровно: темп берём по отрезку до головы.
    const pace = head.n > b ? Math.max(0.01, (head.t - x.t) / (head.n - b)) : 0.1;
    b = Math.min(head.n, Math.max(1, b - Math.round(diff / pace)));
  }
  return b;
}

async function poolKeyById(net, poolId, createdTs) {
  const url = stateUrl(net);
  const b = await blockAt(net, createdTs);
  for (const [from, to] of [[b - 5000, b + 4999], [b - 15000, b - 5001], [b + 5000, b + 14999]]) {
    const logs = await rpc(url, 'eth_getLogs', [{ address: net.poolManager, topics: [INIT_TOPIC, poolId],
      fromBlock: '0x' + Math.max(0, from).toString(16), toBlock: '0x' + Math.max(0, to).toString(16) }]);
    if (Array.isArray(logs) && logs.length) return parseInit(logs[0]);
  }
  return null;
}

/**
 * Самый весомый пул токена. Сравнивать пулы по «сырой» ликвидности нельзя:
 * величина L зависит от котировочной валюты и её знаков после запятой, и
 * пул на $180 легко перевешивает пул на $50 000. Поэтому берём несколько
 * кандидатов с наибольшим L и сравниваем их уже по деньгам.
 */
async function candidates(net, token, take = 3, known, prefer) {
  const pools = known || await poolsOfToken(net, token);
  if (!pools.length) return [];

  // У токена бывают тысячи пулов, и читать ликвидность у всех — десятки
  // запросов. Но резать список по позиции нельзя: у бойкого токена пул
  // против доллара оказывается одним из первых, а хвост забит парами со
  // случайными мемкоинами. Поэтому пулы против известной котировки берём
  // все, а до предела добираем свежими — логи идут по блокам.
  const me = String(token).toLowerCase();
  const otherOf = (p) => (p.currency0.toLowerCase() === me ? p.currency1 : p.currency0).toLowerCase();
  const want = new Set((prefer || []).map((x) => String(x).toLowerCase()));
  const keep = want.size ? pools.filter((p) => want.has(otherOf(p))) : [];
  const rest = want.size ? pools.filter((p) => !want.has(otherOf(p))) : pools;
  const room = Math.max(0, MAX_PROBE - keep.length);
  const probe = keep.concat(rest.length > room ? rest.slice(-room) : rest);

  const liq = await rpcBatch(stateUrl(net), probe.map((p) => ({
    to: net.stateView, data: SEL.liquidity + p.poolId.slice(2),
  })));
  const live = probe
    .map((p, i) => ({ ...p, liquidity: liq[i] ? BigInt(liq[i]) : 0n }))
    .filter((p) => p.liquidity > 0n)
    .sort((a, b) => (b.liquidity > a.liquidity ? 1 : -1));

  const out = live.slice(0, take);
  // Пул против доллара нужен всегда: от него берётся цена токена, а по
  // «сырой» величине L он в верхушку не попадает — она зависит от котировки
  // и её знаков после запятой.
  // По одному пулу на каждую нужную котировку, а не N штук на всех: иначе
  // обе вакансии занимали нативные пары, и до долларовой очередь не доходила.
  for (const q of want) {
    if (out.some((p) => otherOf(p) === q)) continue;
    const hit = live.find((p) => otherOf(p) === q);
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * Курс нативной валюты в долларах. Считаем через обёрнутую (WETH) против
 * стейбла: в этой сети нативная и WETH — разные адреса, и пулов «нулевой
 * адрес против стейбла» почти нет, а WETH/стейбл — самый глубокий пул сети.
 */
// known — уже найденные пулы WETH. Искать их по логам всей цепи больше
// нельзя: у WETH за десять тысяч пулов, и узел отвечает «logs matched by
// query exceeds limit of 10000» — курс ETH выходил нулём, и глубина
// ломалась у всех токенов в паре с ETH.
async function nativeUsd(net, wrapped, stable, known) {
  const w = wrapped.toLowerCase();
  const st = stable.toLowerCase();
  const pools = (known && known.length ? known : await poolsOfToken(net, wrapped)).filter((p) => {
    const a = p.currency0.toLowerCase();
    const b = p.currency1.toLowerCase();
    return (a === w && b === st) || (a === st && b === w);
  });
  if (!pools.length) return 0;

  const liq = await rpcBatch(stateUrl(net), pools.map((p) => ({
    to: net.stateView, data: SEL.liquidity + p.poolId.slice(2),
  })));
  let best = null;
  pools.forEach((p, i) => {
    const v = liq[i] ? BigInt(liq[i]) : 0n;
    if (v > 0n && (!best || v > best.v)) best = { p, v };
  });
  if (!best) return 0;

  const s0 = await ethCall(stateUrl(net), net.stateView, SEL.slot0 + best.p.poolId.slice(2));
  const sqrtP = Number(word(s0, 0)) / 2 ** 96;
  const [d0, d1] = await Promise.all([
    decimalsOf(net, best.p.currency0),
    decimalsOf(net, best.p.currency1),
  ]);
  const px = sqrtP * sqrtP * Math.pow(10, d0 - d1);   // currency1 за currency0
  return best.p.currency0.toLowerCase() === w ? px : 1 / px;
}

async function poolMeta(net, poolId) {
  const logs = await rpc(net.rpc, 'eth_getLogs', [{
    address: net.poolManager,
    topics: [INIT_TOPIC, poolId],
    fromBlock: '0x0',
    toBlock: 'latest',
  }]);
  if (!logs || !logs.length) throw new Error('пул не найден');
  const lg = logs[0];
  const currency0 = '0x' + lg.topics[2].slice(26);
  const currency1 = '0x' + lg.topics[3].slice(26);
  const fee = Number(word(lg.data, 0));
  const tickSpacing = Number(signed(word(lg.data, 1)));
  return { currency0, currency1, fee, tickSpacing };
}

const NATIVE = '0x0000000000000000000000000000000000000000';

/** У нативной валюты (в V4 это нулевой адрес) контракта нет — спрашивать не у кого. */
// Знаки после запятой и символ у токена не меняются никогда, а спрашивают
// их на каждый пул заново — в одном разборе это десятки одинаковых запросов.
const decCache = new Map();
const symCache = new Map();

async function decimalsOf(net, token) {
  if (!token || token.toLowerCase() === NATIVE) return 18;
  const key = net.rpc + '|' + token.toLowerCase();
  if (decCache.has(key)) return decCache.get(key);
  const p = ethCall(stateUrl(net), token, SEL_DECIMALS)
    .then((out) => Number(BigInt(out)))
    .catch((e) => { decCache.delete(key); throw e; });
  decCache.set(key, p);          // кладём обещание: параллельные запросы не задвоятся
  return p;
}

// Насколько далеко от текущей цены смотрим: 16000 тиков — это примерно
// впятеро вверх и впятеро вниз. Считать в тиках, а не в словах битмапа,
// обязательно: при шаге 200 одно слово — это уже пол-диапазона, а при шаге 25
// — доли процента, и окно получалось то огромным, то бесполезным.
const SPAN_TICKS = 16000;

async function readDepth(net, poolId, tickSpacing) {
  const pid = poolId.startsWith('0x') ? poolId.slice(2) : poolId;
  const sv = net.stateView;

  // Два чтения подряд — это два обхода сети на каждый пул. Забираем разом.
  const [s0, liqRaw] = await rpcBatch(stateUrl(net), [
    { to: sv, data: SEL.slot0 + pid },
    { to: sv, data: SEL.liquidity + pid },
  ]);
  const sqrtPriceX96 = word(s0, 0);
  const tick = Number(signed(word(s0, 1)));
  const lpFee = Number(word(s0, 3));
  const liqNow = liqRaw ? BigInt(liqRaw) : 0n;

  const loTick = tick - SPAN_TICKS;
  const hiTick = tick + SPAN_TICKS;
  const loWord = Math.floor(loTick / tickSpacing) >> 8;
  const hiWord = Math.floor(hiTick / tickSpacing) >> 8;
  const wordList = [];
  for (let w = loWord; w <= hiWord && wordList.length < 48; w++) wordList.push(w);
  const maps = await rpcBatch(stateUrl(net), wordList.map((w) => ({
    to: sv, data: SEL.bitmap + pid + hex(w),
  })));
  const ticks = [];
  wordList.forEach((w, idx) => {
    const bits = maps[idx] ? BigInt(maps[idx]) : 0n;
    if (!bits) return;
    for (let i = 0; i < 256; i++) {
      if ((bits >> BigInt(i)) & 1n) ticks.push(((w << 8) + i) * tickSpacing);
    }
  });
  // Границы окна — опорные точки. Без них пул с ликвидностью «на весь
  // диапазон» выглядел пустым: его инициализированные тики стоят на краях
  // тикового пространства, далеко за окном, и внутри не находилось ничего.
  const edgeLo = Math.floor(loTick / tickSpacing) * tickSpacing;
  const edgeHi = Math.ceil(hiTick / tickSpacing) * tickSpacing;

  const points = new Set(ticks);
  points.add(edgeLo);
  points.add(edgeHi);

  // Дробим слишком широкие промежутки: пул с равномерной ликвидностью иначе
  // даёт одну полосу во весь экран — формально верно, а глазу пусто.
  const STEP = Math.max(tickSpacing, Math.round(SPAN_TICKS / 8));
  const sorted = [...points].sort((a, b) => a - b);
  for (let i = 0; i + 1 < sorted.length; i++) {
    for (let t = sorted[i] + STEP; t < sorted[i + 1]; t += STEP) {
      points.add(Math.round(t / tickSpacing) * tickSpacing);
    }
  }

  const all = [...points].sort((a, b) => a - b);

  // Опорные точки не инициализированы, у них net нулевой — и это верно:
  // ликвидность через них не меняется.
  const nets = new Map();
  const res = await rpcBatch(stateUrl(net), all.map((t) => ({
    to: sv, data: SEL.tickLiq + pid + hex(t),
  })));
  all.forEach((t, i) => {
    nets.set(t, res[i] ? signed(word(res[i], 1)) : 0n);
  });

  return { sqrtPriceX96, tick, lpFee, liqNow, ticks: all, nets };
}

/** Активная ликвидность в каждой полосе между соседними тиками. */
function bands(state, tickSpacing, dec0, dec1, tokenIsZero, quoteUsd, tokenOnly) {
  const { sqrtPriceX96, tick, liqNow, ticks, nets } = state;
  const active = new Map();

  let L = liqNow;
  for (const t of ticks.filter((x) => x > tick)) { active.set(t, L); L += nets.get(t); }
  L = liqNow;
  for (const t of ticks.filter((x) => x <= tick).reverse()) { active.set(t, L); L -= nets.get(t); }

  // Смотрим на токен, который открыт: вторая валюта — котировка, её и
  // считаем долларом. Гадать по символам не нужно, токен нам известен.
  const stable1 = tokenIsZero;
  const stable0 = !tokenIsZero;
  const sq = (t) => Math.pow(1.0001, t / 2);
  const px = (t) => Math.pow(1.0001, t) * Math.pow(10, dec0 - dec1);
  const sp = Number(sqrtPriceX96) / 2 ** 96;

  const out = [];
  for (let i = 0; i + 1 < ticks.length; i++) {
    const a = ticks[i];
    const b = ticks[i + 1];
    const Lb = Number(active.get(a) || 0n);
    if (Lb <= 0) continue;

    const pa = sq(a);
    const pb = sq(b);
    let amt0 = 0;
    let amt1 = 0;
    if (sp <= pa) amt0 = Lb * (1 / pa - 1 / pb);
    else if (sp >= pb) amt1 = Lb * (pb - pa);
    else { amt0 = Lb * (1 / sp - 1 / pb); amt1 = Lb * (sp - pa); }

    const a0 = amt0 / 10 ** dec0;
    const a1 = amt1 / 10 ** dec1;
    // считаем в котировочной валюте, а в доллары переводим её курсом
    const mine = stable1 ? a0 * px(tick) : a1 / px(tick);   // сторона токена
    const theirs = stable1 ? a1 : a0;                        // сторона котировки
    // У пула с мусорной котировкой реальна только сторона токена: вторую он
    // оценивает сам собой, и складывать её значит верить пулу на слово.
    const quote = tokenOnly ? mine : mine + theirs;
    const usd = quoteUsd ? quote * quoteUsd : null;

    // Цену полосы тоже переводим в доллары: иначе пул, котируемый в ETH,
    // рисуется в сотню раз ниже своего места на долларовом графике.
    const k = quoteUsd || 1;
    const lo = (stable1 ? px(a) : 1 / px(b)) * k;
    const hi = (stable1 ? px(b) : 1 / px(a)) * k;
    out.push({ lo, hi, quote, usd, current: a <= tick && tick < b });
  }
  return {
    bands: out,
    price: (stable1 ? px(tick) : 1 / px(tick)) * (quoteUsd || 1),
    usdPrice: !!quoteUsd,
    lpFee: state.lpFee,
  };
}


const SEL_SYMBOL = '0x95d89b41';
const SEL_SUPPLY = '0x18160ddd';
const supCache = new Map();

/**
 * Сколько монет выпущено. Нужно, чтобы переводить капитализацию в цену:
 * уровни удобнее ставить в мкапе, а сравнивать приходится с ценой.
 */
async function supplyOf(net, token) {
  const key = net.rpc + '|' + String(token).toLowerCase();
  if (supCache.has(key)) return supCache.get(key);
  const p = (async () => {
    const [raw, dec] = await Promise.all([
      ethCall(stateUrl(net), token, SEL_SUPPLY),
      decimalsOf(net, token),
    ]);
    const v = Number(BigInt(raw)) / Math.pow(10, dec);
    return isFinite(v) && v > 0 ? v : 0;
  })().catch(() => { supCache.delete(key); return 0; });
  supCache.set(key, p);
  return p;
}

/** Символ токена. Нужен, чтобы подписать, против чего котируется пул. */
async function symbolOf(net, addr) {
  if (String(addr).toLowerCase() === '0x0000000000000000000000000000000000000000') return 'ETH';
  const key = net.rpc + '|' + String(addr).toLowerCase();
  if (symCache.has(key)) return symCache.get(key);
  const out = await readSymbol(net, addr);
  symCache.set(key, out);
  return out;
}

async function readSymbol(net, addr) {
  try {
    const out = await ethCall(stateUrl(net), addr, SEL_SYMBOL);
    if (!out || out === '0x') return '';
    const body = out.slice(2);
    // строка бывает в двух видах: динамическая (смещение+длина) и bytes32
    if (body.length >= 128 && Number(BigInt('0x' + body.slice(0, 64))) === 32) {
      const len = Number(BigInt('0x' + body.slice(64, 128)));
      return hexToText(body.slice(128, 128 + len * 2));
    }
    return hexToText(body.slice(0, 64)).replace(/\u0000+$/, '');
  } catch (e) {
    return '';
  }
}

function hexToText(h) {
  let s = '';
  for (let i = 0; i + 1 < h.length; i += 2) {
    const c = parseInt(h.slice(i, i + 2), 16);
    if (c) s += String.fromCharCode(c);
  }
  return s;
}

/** Цена токена в котировке этого пула — по одному слоту, без чтения тиков. */
async function priceIn(net, pool, token) {
  const s0 = await ethCall(stateUrl(net), net.stateView, SEL.slot0 + pool.poolId.slice(2));
  const tick = Number(signed(word(s0, 1)));
  const [d0, d1] = await Promise.all([
    decimalsOf(net, pool.currency0), decimalsOf(net, pool.currency1),
  ]);
  const px = Math.pow(1.0001, tick) * Math.pow(10, d0 - d1);
  return pool.currency0.toLowerCase() === String(token).toLowerCase() ? px : 1 / px;
}

/**
 * Цена токена в долларах — из его самого глубокого пула против стейбла.
 *
 * Это опорная точка для всего остального: зная её, курс любой котировки
 * выводится из самого пула, и справочник курсов не нужен. Без этого пулы
 * против экзотики (на Robinhood Chain токены парятся с акциями вроде SPCX)
 * оценить было нечем, и в них терялась основная масса ликвидности.
 */
async function tokenUsd(net, token, stable, pools) {
  const st = String(stable || '').toLowerCase();
  const me = String(token).toLowerCase();
  const list = (pools || await candidates(net, token, 12)).filter((p) => {
    const other = (p.currency0.toLowerCase() === me ? p.currency1 : p.currency0).toLowerCase();
    return other === st;
  });
  if (!list.length) return 0;
  return priceIn(net, list[0], token);
}

/**
 * Полосы всех пулов на одной шкале цены.
 *
 * У каждого пула своя сетка тиков, поэтому складывать полосы попарно нельзя:
 * раскладываем деньги каждой полосы по общей логарифмической сетке
 * пропорционально перекрытию.
 */

const pairCache = new Map();

/**
 * Можно ли верить цене, которую пул назначает своей котировке.
 *
 * Курс котировки мы выводим из самого пула, и это работает, пока вторая
 * монета чего-то стоит. У бойкого токена бывают десятки спам-пулов с
 * мусорными монетами: такой пул «оценивает» сам себя, и итог раздувается на
 * порядки. Признак настоящей котировки — собственный живой пул против
 * доллара. Спрашиваем сразу обе валюты в одном фильтре: перебирать все пулы
 * монеты нельзя, у ходовых их тысячи и ответ весит мегабайты.
 */
async function pricedInStable(net, quote, stable) {
  const q = String(quote).toLowerCase();
  const st = String(stable || '').toLowerCase();
  if (!st || q === st || q === NATIVE) return true;

  const key = net.rpc + '|' + q;
  if (pairCache.has(key)) return pairCache.get(key);
  const topic = (a) => '0x' + a.slice(2).padStart(64, '0');
  const ask = (a, b) => rpc(net.rpc, 'eth_getLogs', [{
    address: net.poolManager, fromBlock: '0x0', toBlock: 'latest',
    topics: [INIT_TOPIC, null, topic(a), topic(b)],
  }]).catch(() => []);

  const p = (async () => {
    const both = await Promise.all([ask(q, st), ask(st, q)]);
    const ids = [].concat(...both).map((lg) => lg.topics[1]);
    if (!ids.length) return false;
    const liq = await rpcBatch(stateUrl(net), ids.map((id) => ({
      to: net.stateView, data: SEL.liquidity + id.slice(2),
    })));
    return liq.some((x) => x && BigInt(x) > 0n);
  })().catch(() => false);
  pairCache.set(key, p);
  return p;
}

function mergeBands(lists, bins = 400, price = 0, span = 5) {
  const all = [].concat(...lists).filter((b) => b && b.lo > 0 && b.hi > b.lo);
  if (!all.length) return [];

  // Сетку привязываем к текущей цене, а не к объединению всех диапазонов.
  // Достаточно одного мусорного пула, стоящего на краю тикового пространства,
  // чтобы диапазон растянулся в десятки порядков — тогда все 240 делений
  // размазываются по нему, и на экран попадает одна полоса во всю высоту.
  const cur = price > 0 ? price : (() => {
    const c = all.find((x) => x.current);
    return c ? Math.sqrt(c.lo * c.hi) : 0;
  })();
  let lo = Math.min(...all.map((b) => b.lo));
  let hi = Math.max(...all.map((b) => b.hi));
  if (cur > 0) {
    lo = Math.max(lo, cur / span);
    hi = Math.min(hi, cur * span);
  }
  if (!(hi > lo)) return [];

  const a = Math.log(lo);
  const b = Math.log(hi);
  const step = (b - a) / bins;
  const grid = new Array(bins).fill(0);
  for (const band of all) {
    const x0 = Math.log(band.lo);
    const x1 = Math.log(band.hi);
    const money = band.usd || 0;
    const width = x1 - x0;
    // Полоса, вылезающая за окно, отдаёт только ту часть денег, что попала
    // внутрь: ликвидность, растянутая на десять порядков, у цены почти
    // ничего не держит, и приписывать ей всю сумму нельзя.
    const from = Math.max(0, Math.floor((x0 - a) / step));
    const to = Math.min(bins - 1, Math.ceil((x1 - a) / step));
    for (let i = from; i <= to; i++) {
      const gLo = a + i * step;
      const gHi = gLo + step;
      const over = Math.min(x1, gHi) - Math.max(x0, gLo);
      if (over > 0) grid[i] += money * (width > 0 ? over / width : 1);
    }
  }
  return grid.map((usd, i) => {
    const gLo = Math.exp(a + i * step);
    const gHi = Math.exp(a + (i + 1) * step);
    return { lo: gLo, hi: gHi, usd, quote: usd, current: cur >= gLo && cur < gHi };
  }).filter((x) => x.usd > 0);
}

/*
 * keccak-256. Нужен ровно для одного: id пула в V4 — это хэш его ключа, а
 * позиция знает только ключ. Библиотеки в воркере нет, поэтому своя
 * реализация на BigInt: хэшей нужно по одному на пул, скорость не важна.
 */
const KRC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n,
  0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
  0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800An, 0x800000008000000An,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
              [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const M64 = (1n << 64n) - 1n;

function keccakF(st) {
  const rot = (v, n) => (n ? ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64 : v);
  for (let r = 0; r < 24; r++) {
    const C = [0, 1, 2, 3, 4].map((x) => st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20]);
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rot(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) st[y + x] ^= D;
    }
    const B = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rot(st[x + 5 * y], KROT[x][y]);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        st[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M64 & B[((x + 2) % 5) + 5 * y]);
      }
    }
    st[0] ^= KRC[r];
  }
}

/** keccak-256 от шестнадцатеричной строки байтов, ответ — 0x…. */
function keccakHex(hexData) {
  const h = String(hexData).replace(/^0x/, '');
  const len = h.length / 2;
  const rate = 136;
  const total = len + (rate - (len % rate));
  const msg = new Uint8Array(total);
  for (let i = 0; i < len; i++) msg[i] = parseInt(h.substr(i * 2, 2), 16);
  msg[len] ^= 0x01;
  msg[total - 1] ^= 0x80;
  const st = new Array(25).fill(0n);
  for (let off = 0; off < total; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let v = 0n;
      for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(msg[off + i * 8 + b]);
      st[i] ^= v;
    }
    keccakF(st);
  }
  let out = '0x';
  for (let i = 0; i < 4; i++) {
    for (let b = 0; b < 8; b++) out += ((st[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Несобранные фисы позиций — в штуках каждой валюты.
 *
 * Сайт отдаёт их одной суммой в долларах, а сколько там токена и сколько
 * стейбла — нет. Считаем как сам пул: ликвидность позиции × прирост
 * «комиссии на единицу ликвидности» внутри её диапазона с прошлого сбора.
 *
 * Ответ: { [валюта]: штук } по всем позициям вместе, плюс число позиций.
 */
async function positionFees(net, ids) {
  const list = [...new Set((ids || []).map(String))].filter((x) => /^\d+$/.test(x));
  if (!list.length || !net.positionManager || !net.stateView) return { sums: {}, positions: 0 };
  const pm = net.positionManager;

  const first = await rpcBatch(stateUrl(net), list.flatMap((id) => [
    { to: pm, data: SEL.poolInfo + hex(id) },
    { to: pm, data: SEL.posLiq + hex(id) },
  ]));

  const pos = [];
  list.forEach((id, i) => {
    const info = first[i * 2];
    const liq = first[i * 2 + 1];
    if (!info || info.length < 2 + 64 * 6 || !liq) return;
    const L = BigInt(liq);
    if (L === 0n) return;                       // пустая позиция — фисов нет
    const key = info.slice(2, 2 + 64 * 5);      // ключ пула ровно в том виде, что хэшируется
    const packed = word(info, 5);
    const i24 = (v) => { const x = Number(v & 0xffffffn); return x >= 0x800000 ? x - 0x1000000 : x; };
    pos.push({
      id,
      L,
      c0: '0x' + key.slice(24, 64),
      c1: '0x' + key.slice(64 + 24, 128),
      poolId: keccakHex(key),
      lo: i24(packed >> 8n),
      hi: i24(packed >> 32n),
    });
  });
  if (!pos.length) return { sums: {}, positions: 0 };

  const owner = hex(BigInt(pm));
  // Заодно — цена и ликвидность у цены в самих пулах леддера: только они
  // говорят, что сейчас лежит в ступенях. Сайт пишет «в диапазоне» и тогда,
  // когда пул давно улетел в потолок и всё продано.
  const pools = [...new Set(pos.map((p) => p.poolId))];
  const second = await rpcBatch(stateUrl(net), pos.flatMap((p) => [
    { to: net.stateView,
      data: SEL.posInfo + p.poolId.slice(2) + owner + hex(p.lo) + hex(p.hi) + hex(p.id) },
    { to: net.stateView, data: SEL.feeInside + p.poolId.slice(2) + hex(p.lo) + hex(p.hi) },
  ]).concat(pools.flatMap((id) => [
    { to: net.stateView, data: SEL.slot0 + id.slice(2) },
    { to: net.stateView, data: SEL.liquidity + id.slice(2) },
  ])));
  const poolState = {};
  pools.forEach((id, i) => {
    const s0 = second[pos.length * 2 + i * 2];
    const lq = second[pos.length * 2 + i * 2 + 1];
    if (!s0 || s0.length < 2 + 64 * 2) return;
    poolState[id] = { tick: Number(signed(word(s0, 1))), liq: lq ? BigInt(lq).toString() : '0' };
  });

  const Q128 = 1n << 128n;
  const M256 = (1n << 256n) - 1n;
  const raw = {};
  pos.forEach((p, i) => {
    const mine = second[i * 2];
    const now = second[i * 2 + 1];
    if (!mine || !now || mine.length < 2 + 64 * 3 || now.length < 2 + 64 * 2) return;
    // Прирост считается по модулю 2^256: счётчик в пуле может перевалить.
    const d0 = (word(now, 0) - word(mine, 1)) & M256;
    const d1 = (word(now, 1) - word(mine, 2)) & M256;
    const f0 = (p.L * d0) / Q128;
    const f1 = (p.L * d1) / Q128;
    raw[p.c0] = (raw[p.c0] || 0n) + f0;
    raw[p.c1] = (raw[p.c1] || 0n) + f1;
  });

  const sums = {};
  const decs = {};
  for (const addr of new Set(pos.flatMap((p) => [p.c0, p.c1]))) {
    decs[addr] = await decimalsOf(net, addr).catch(() => 18);
  }
  for (const [addr, v] of Object.entries(raw)) {
    sums[addr.toLowerCase()] = Number(v) / Math.pow(10, decs[addr] ?? 18);
  }
  // Сами позиции тоже отдаём: из тиков и ликвидности график построит
  // ступени без всякой страницы — точно и при любой цене.
  const details = pos.map((p) => ({ id: p.id, L: p.L.toString(), c0: p.c0.toLowerCase(),
    c1: p.c1.toLowerCase(), lo: p.lo, hi: p.hi, d0: decs[p.c0] ?? 18, d1: decs[p.c1] ?? 18,
    poolTick: poolState[p.poolId] ? poolState[p.poolId].tick : null,
    poolLiq: poolState[p.poolId] ? poolState[p.poolId].liq : null }));
  return { sums, positions: pos.length, details };
}

/**
 * Ступень позиции в долларах за токен — из тиков и ликвидности.
 *
 * Цена в пуле — это цена currency0 в currency1. Если наш токен стоит вторым,
 * её надо перевернуть, а границы поменять местами. Ликвидность приводим к
 * «человеческим» единицам: L / 10^((d0+d1)/2) — с ней формулы Uniswap
 * работают прямо в ценах токена, какими их видно на графике. quoteUsd —
 * сколько долларов стоит единица котировки (стейбл — 1, эфир — его курс).
 */
function rungOf(d, token, quoteUsd) {
  const tok = String(token).toLowerCase();
  const first = d.c0 === tok;
  if (!first && d.c1 !== tok) return null;
  const k = Number(quoteUsd);
  if (!(k > 0)) return null;
  const scale = Math.pow(10, d.d0 - d.d1);
  const pA = Math.pow(1.0001, d.lo) * scale;
  const pB = Math.pow(1.0001, d.hi) * scale;
  const lo = (first ? pA : 1 / pB) * k;
  const hi = (first ? pB : 1 / pA) * k;
  const lh = (Number(d.L) / Math.pow(10, (d.d0 + d.d1) / 2)) * Math.sqrt(k);
  if (!(lo > 0) || !(hi > lo) || !(lh > 0) || !isFinite(lh)) return null;
  // Где сейчас цена в пуле этой ступени. Пул на предельном тике или без
  // ликвидности у цены — «мёртвый»: говорим только, с какой он стороны.
  let pool = null;
  if (d.poolTick !== null && d.poolTick !== undefined) {
    const t = Number(d.poolTick);
    // Только предельный тик. Нулевая ликвидность у цены бывает и в щели
    // между ступенями — это не «пул улетел», цена там настоящая.
    const dead = Math.abs(t) >= 880000;
    const pp = Math.pow(1.0001, t) * scale;
    const price = (first ? pp : 1 / pp) * k;
    pool = { dead, price: isFinite(price) && price > 0 ? price : null };
  }
  return { lo, hi, lh, id: d.id, pool };
}

const api = { SEL, keccakHex, positionFees, rungOf, rpcMany, stateUrl, poolKeyById, blockAt, ethCall, rpc, rpcBatch, poolsOfToken, candidates, nativeUsd, poolMeta,
              decimalsOf, readDepth, bands, hex, symbolOf, priceIn, tokenUsd, mergeBands, supplyOf,
              pricedInStable };
if (typeof self !== 'undefined') self.GHO_CHAIN = api;
if (typeof module !== 'undefined') module.exports = api;
