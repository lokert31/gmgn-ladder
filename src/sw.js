/*
 * Сервис-воркер: ходит в API GMGN от имени расширения.
 *
 * Зачем вообще: встроить страницу GMGN в чужой сайт не выходит — Cloudflare
 * отвечает 503 на кросс-сайтовый запрос, и разрешение сторонних кук этого не
 * меняет (проверено). Запрос отсюда идёт не как сторонний: куки берутся из
 * основной банки и под партиционирование не попадают.
 *
 * Подписи запросов (device_id, fp_did, client_id, …) не выдумываем — их
 * подсматривает bridge.js на живых страницах gmgn.ai и складывает в storage.
 */

importScripts('log.js');
importScripts('chain.js');
importScripts('watch.js');

const KEY = 'ghoParams';
const BASE = 'https://gmgn.ai';

/*
 * Сети, где умеем читать глубину пула. RPC хранится в chrome.storage, а не в
 * коде: ключ Alchemy — личный, ему не место в файлах расширения.
 */
const NETS = {
  robinhood: {
    poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
    positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  },
};

const QUOTES = {
  robinhood: {
    stable: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',    // USDG
    wrapped: '0x0bd7d308f8e1639fAb988DF18a8011f41eAcaD73',   // WETH
  },
};
// имя NATIVE уже занято в chain.js — importScripts кладёт всё в одну область
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
let ethPrice = { at: 0, usd: 0 };
// Пулы токена и то, в каких из них есть ликвидность. Перебор стоит дорого,
// а меняется он редко — держим четверть часа.
const poolCache = new Map();
const POOLS_TTL = 15 * 60000;
// Фисы позиций: четыре чтения на позицию, поэтому не чаще раза в 3 минуты
// на один и тот же набор — иначе открытый график сам по себе ест узел.
const posFeeCache = new Map();

// Хук пула лаунчпада Robinhood: там ликвидность копится сама из торгов.
const LAUNCHPAD_HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
const isLaunchpad = (hooks) => String(hooks || '').toLowerCase() === LAUNCHPAD_HOOK;
const hooksOf = (pools) => Object.fromEntries((pools || [])
  .map((p) => [String(p.poolId).toLowerCase(), String(p.hooks || '').toLowerCase()]));
// Комиссия и хук пула по его id — для разбора токена.
const metaOf = (pools) => Object.fromEntries((pools || [])
  .map((p) => [String(p.poolId).toLowerCase(), { hooks: String(p.hooks || '').toLowerCase(), fee: Number(p.fee) || 0 }]));
// Хук пулов, которые создаёт Liquidity Ladder под лесенки.
const LADDER_HOOK = '0x00000000000000000000000000000000dead0030';

/*
 * Все запросы к GeckoTerminal — через одну очередь: у него ~30 запросов в
 * минуту на всех. Раньше каждый ждал сам по себе, скринер вдобавок стоял
 * 1.8 с после каждого токена, а параллельные запросы всё равно ловили 429.
 */
const GT_GAP = 2100;
let gtTail = Promise.resolve();
function gtFetch(url) {
  const mine = gtTail;
  gtTail = mine.then(() => new Promise((r) => setTimeout(r, GT_GAP)));
  return mine.then(async () => {
    for (let tries = 0; ; tries++) {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status !== 429 || tries >= 2) return res;
      await new Promise((r) => setTimeout(r, 5000 * (tries + 1)));
    }
  });
}

/** Пулы токена из GeckoTerminal: ликвидность, объём, движение цены. */
const gtCache = new Map();
// Разбор токена просит пулы сразу из двух мест; без этого, пока первый
// запрос в пути, уходил второй такой же.
const gtInflight = new Map();
async function gtPools(chain, addr) {
  const me = String(addr || '').toLowerCase();
  const key = chain + ':' + me;
  const hit = gtCache.get(key);
  if (hit && Date.now() - hit.at < TVL_TTL) return hit.pools;
  if (gtInflight.has(key)) return gtInflight.get(key);
  const job = gtPoolsLoad(chain, me, key).finally(() => gtInflight.delete(key));
  gtInflight.set(key, job);
  return job;
}

async function gtPoolsLoad(chain, me, key) {
  const netId = GT_NET[chain];
  if (!netId) throw new Error('сеть не поддерживается');
  const pools = [];
  for (let page = 1; page <= 2; page++) {
    const res = await gtFetch('https://api.geckoterminal.com/api/v2/networks/' + netId
      + '/tokens/' + me + '/pools?page=' + page);
    if (!res.ok) {
      if (page === 1) throw new Error(res.status === 429 ? 'GeckoTerminal просит подождать минуту' : 'GeckoTerminal ответил ' + res.status);
      break;
    }
    const j = await res.json();
    const data = Array.isArray(j && j.data) ? j.data : [];
    for (const p of data) {
      const a = p.attributes || {};
      const ch = a.price_change_percentage || {};
      const fee = /([0-9.]+)%\s*$/.exec(String(a.name || ''));
      pools.push({ id: String(a.address || '').toLowerCase(), name: a.name || '',
        usd: Number(a.reserve_in_usd) || 0,
        vol24: Number((a.volume_usd || {}).h24) || 0,
        vol1: Number((a.volume_usd || {}).h1) || 0,
        feeName: fee ? Number(fee[1]) / 100 : null,
        h1: Number(ch.h1), h6: Number(ch.h6), h24: Number(ch.h24),
        created: a.pool_created_at ? Math.floor(Date.parse(a.pool_created_at) / 1000) : null });
    }
    if (data.length < 20) break;
  }
  gtCache.set(key, { at: Date.now(), pools });
  return pools;
}

/*
 * Пулы токена без поиска по всей истории цепи.
 *
 * Все пулы по событиям с начала цепи отдаёт только публичный узел, а он
 * общий с ботами и то и дело отвечает 429 — глубина тогда не читалась
 * вовсе. Теперь список пулов берём у GeckoTerminal, а ключ каждого пула
 * (валюты, комиссия, шаг, хук) — одним событием создания в узком окне по
 * его времени. Ключ пула не меняется никогда — помним его навсегда.
 */
const KEYS_KEY = 'ghoPoolKeys';
let poolKeys = null;
async function loadKeys() {
  if (poolKeys) return poolKeys;
  try { const v = await chrome.storage.local.get(KEYS_KEY); poolKeys = (v && v[KEYS_KEY]) || {}; }
  catch (e) { poolKeys = {}; }
  return poolKeys;
}

async function discoverPools(chain, addr, net) {
  const pools = await gtPools(chain, addr);
  const keys = await loadKeys();
  // V4-пул у GeckoTerminal записан своим id (32 байта); остальные — не наши.
  const v4 = pools.filter((p) => /^0x[0-9a-f]{64}$/.test(p.id))
    .sort((a, b) => (b.usd + b.vol24) - (a.usd + a.vol24)).slice(0, 16);
  // Ключи незнакомых пулов ищем по четыре сразу: по одному на токен с
  // шестнадцатью пулами уходили десятки секунд.
  let added = false;
  const miss = v4.filter((p) => !keys[p.id] && p.created);
  for (let i = 0; i < miss.length; i += 4) {
    await Promise.all(miss.slice(i, i + 4).map(async (p) => {
      const k = await self.GHO_CHAIN.poolKeyById(net, p.id, p.created).catch(() => null);
      if (k) { keys[p.id] = k; added = true; }
    }));
  }
  const out = v4.map((p) => keys[p.id]).filter(Boolean);
  if (added) { try { await chrome.storage.local.set({ [KEYS_KEY]: keys }); } catch (e) { /* переживём */ } }
  return out;
}

/** Чей пул и какая у него комиссия — из цепи; список пулов держим в памяти. */
async function poolMetaOf(chain, addr) {
  const key = chain + ':' + String(addr || '').toLowerCase();
  const box = poolCache.get(key);
  if (box && box.meta) return box.meta;
  const net = await netFor(chain);
  if (!net) return null;
  const known = await discoverPools(chain, addr, net).catch(() => null)
    || await self.GHO_CHAIN.poolsOfToken(net, addr).catch(() => null);
  if (!known || !known.length) return null;
  const meta = metaOf(known);
  poolCache.set(key, { ...(box || {}), at: box ? box.at : 0, hooks: hooksOf(known), meta, totalPools: known.length });
  return meta;
}

// Вся ликвидность токена по пулам — из GeckoTerminal: он считает пулы
// целиком, а мы из цепи видим только окно ±5 раз вокруг цены. Бесплатно,
// узел не тратится; держим десять минут.
const tvlCache = new Map();
const TVL_TTL = 10 * 60000;
const GT_NET = { robinhood: 'robinhood', eth: 'eth', bsc: 'bsc', base: 'base',
                 polygon: 'polygon_pos', arbitrum: 'arbitrum' };
const POS_FEES_TTL = 3 * 60000;
const COVER = 0.97;     // какую долю денег обязаны покрыть выбранные пулы
const KEEP_MIN = 3;     // и не меньше стольких пулов, что бы там ни вышло

/** Оставить пулы, в которых лежит почти всё: остальные — шум по цене вызовов. */
function pickHeavy(pools, weights) {
  const sorted = [...pools].sort(
    (a, b) => (weights[b.poolId] || 0) - (weights[a.poolId] || 0),
  );
  const total = sorted.reduce((s2, p) => s2 + (weights[p.poolId] || 0), 0);
  if (total <= 0) return pools;
  const out = [];
  let got = 0;
  for (const p of sorted) {
    out.push(p);
    got += weights[p.poolId] || 0;
    if (out.length >= KEEP_MIN && got >= total * COVER) break;
  }
  return out;
}

/** Курс котировочной валюты. Стейбл — единица, нативная — из её же пула со
 *  стейблом в этой же цепи. GMGN для этого больше не нужен. */
async function quoteUsd(net, chain, addr) {
  if (String(addr || '').toLowerCase() !== ZERO_ADDR) return 1;
  if (Date.now() - ethPrice.at < 300000 && ethPrice.usd) return ethPrice.usd;
  const q = QUOTES[chain];
  if (!q) return 0;
  // Пулы WETH — как у любого токена: список у GeckoTerminal, ключ из цепи.
  // Не вышло — старый путь по логам, а совсем не вышло — последний удачный
  // курс за час: ETH за это время на проценты, а не в ноль.
  let usd = 0;
  try {
    const known = await discoverPools(chain, q.wrapped, net).catch(() => null);
    usd = await self.GHO_CHAIN.nativeUsd(net, q.wrapped, q.stable, known);
  } catch (e) { /* ниже — запасной путь */ }
  if (!usd) usd = await self.GHO_CHAIN.nativeUsd(net, q.wrapped, q.stable).catch(() => 0);
  if (usd) {
    ethPrice = { at: Date.now(), usd };
    return usd;
  }
  return Date.now() - ethPrice.at < 3600000 ? ethPrice.usd : 0;
}

async function netFor(chain) {
  const box = NETS[chain];
  if (!box) return null;
  const v = await chrome.storage.local.get('ghoRpc');
  const all = (v && v.ghoRpc) || {};
  const rpc = all[chain] || null;
  // Второй узел — только для чтения состояния (см. stateUrl в chain.js).
  const stateRpc = all[chain + 'State'] || null;
  return rpc ? { ...box, rpc, stateRpc } : null;
}

async function readParams() {
  try {
    const v = await chrome.storage.local.get(KEY);
    const box = v && v[KEY];
    return box && box.params ? box : null;
  } catch (e) {
    return null;
  }
}

async function call(path, extra = {}) {
  const box = await readParams();
  if (!box) return { ok: false, error: 'no-params' };

  const qs = new URLSearchParams({ ...box.params, ...extra });
  let res;
  try {
    res = await fetch(`${BASE}${path}?${qs}`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
  } catch (e) {
    return { ok: false, error: 'network', message: String(e && e.message) };
  }

  if (!res.ok) return { ok: false, status: res.status, ageMin: Math.round((Date.now() - box.savedAt) / 60000) };

  const body = await res.json().catch(() => null);
  if (!body) return { ok: false, status: res.status, error: 'not-json' };
  if (body.code !== 0) return { ok: false, status: res.status, code: body.code, message: body.msg || body.message };
  return { ok: true, status: res.status, data: body.data };
}

// Токенизированная акция SpaceX — котировка пулов лаунчпада, а не токен.
const SPCX_TOKEN = '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea';

/*
 * Токенизированные акции Robinhood (NVDA, SPCX…) — не мемкоины, лить в них
 * LP ради фисов незачем, а скринер ставил NVDA в топ по обороту. Отличаем
 * по имени: у всех акций оно кончается на «• Robinhood Token». Имя токена
 * не меняется — ответ помним навсегда.
 */
const STOCKS_KEY = 'ghoStocks';
const SEL_NAME = '0x06fdde03';
function abiString(hex) {
  if (!hex || hex.length < 130) return null;
  try {
    const b = hex.slice(2);
    const len = parseInt(b.slice(64, 128), 16);
    const bytes = (b.slice(128, 128 + len * 2).match(/../g) || []).map((h) => parseInt(h, 16));
    return new TextDecoder().decode(Uint8Array.from(bytes));
  } catch (e) {
    return null;
  }
}
const isStockName = (name) => /robinhood token\s*$/i.test(String(name || ''));
async function stockFlags(chain, addrs) {
  let known = {};
  try { const v = await chrome.storage.local.get(STOCKS_KEY); known = (v && v[STOCKS_KEY]) || {}; } catch (e) { /* пусто */ }
  const miss = addrs.filter((a) => !(a in known));
  const net = miss.length ? await netFor(chain) : null;
  if (net) {
    const C = self.GHO_CHAIN;
    const res = await C.rpcBatch(C.stateUrl(net), miss.map((a) => ({ to: a, data: SEL_NAME }))).catch(() => []);
    miss.forEach((a, i) => { const n = abiString(res[i]); if (n !== null) known[a] = isStockName(n); });
    try { await chrome.storage.local.set({ [STOCKS_KEY]: known }); } catch (e) { /* переживём */ }
  }
  return known;
}

/*
 * История: сколько залили люди и сколько стоит у цены — по каждому токену,
 * с каждым разбором, но не чаще раза в полчаса. Ярослав заметил, что на
 * пампах ликвидности в токенах с каждым днём больше; снимок этого не
 * покажет, а ряд за несколько дней — покажет.
 */
const multiCache = new Map();
const HIST_KEY = 'ghoLpHist';
let histBox = null;
async function loadHist() {
  if (histBox) return histBox;
  try { const v = await chrome.storage.local.get(HIST_KEY); histBox = (v && v[HIST_KEY]) || {}; }
  catch (e) { histBox = {}; }
  return histBox;
}
async function rememberLp(chain, addr, r) {
  const hist = await loadHist();
  const key = chain + ':' + String(addr).toLowerCase();
  const list = hist[key] || [];
  const last = list[list.length - 1];
  if (last && Date.now() - last.t < 30 * 60000) return;
  list.push({ t: Date.now(), people: Math.round(r.tvlPeople || 0), near: r.near === null ? null : Math.round(r.near),
              vol24: Math.round(r.vol24 || 0), fees1: Math.round(r.fees1 || 0) });
  hist[key] = list.slice(-500);
  try { await chrome.storage.local.set({ [HIST_KEY]: hist }); } catch (e) { /* переживём */ }
}

/* Разбор токена для LP: см. комментарий у HANDLERS.lpScan. */
async function lpScanNow(chain, addr) {
  try {
    const [pools, meta] = await Promise.all([gtPools(chain, addr), poolMetaOf(chain, addr)]);
    if (!pools.length) return { ok: false, error: 'пулов у токена не нашлось' };
    const rows = pools.map((p) => {
      const m = meta && meta[p.id];
      const kind = !m ? 'unknown' : isLaunchpad(m.hooks) ? 'launchpad'
        : m.hooks === LADDER_HOOK ? 'ladder' : 'people';
      // 0x800000 в поле комиссии — флаг «комиссию назначает хук», а не
      // 839%. Тогда берём её из названия пула; нет там — фисы не считаем,
      // а не выдумываем (у TWINE такой пул давал «$111K в сутки»).
      const dynamic = !!m && m.fee >= 0x800000;
      const fee = m && !dynamic ? m.fee / 1e6 : (p.feeName || 0);
      return { ...p, kind, fee, dynamic, fees24: p.vol24 * fee, fees1: p.vol1 * fee };
    });
    const people = rows.filter((r) => r.kind !== 'launchpad');
    const sum = (list, f) => list.reduce((a, r) => a + (f(r) || 0), 0);
    // Движение цены — у самого оборотного пула, где оно вообще известно.
    const main = [...rows].filter((r) => isFinite(r.h24) || isFinite(r.h6) || isFinite(r.h1))
      .sort((a, b) => b.vol24 - a.vol24)[0];

    // Ликвидность людей у цены — из цепи. Нет RPC — считаем без неё.
    let near = null;
    let price = null;
    let nearError = null;
    const d = await HANDLERS.depth({ chain, addr }).catch((e) => ({ ok: false, error: String(e && e.message) }));
    if (!d || !d.ok) nearError = (d && d.error) || 'глубина не прочиталась';
    if (d && d.ok && Array.isArray(d.bandsAdded) && Number(d.price) > 0) {
      price = Number(d.price);
      const lo = price * 0.9;
      const hi = price * 1.1;
      near = d.bandsAdded.reduce((a, b) => {
        const over = Math.min(hi, b.hi) - Math.max(lo, b.lo);
        return over > 0 && b.hi > b.lo ? a + (b.usd || 0) * (over / (b.hi - b.lo)) : a;
      }, 0);
    }
    const fees24 = sum(people, (r) => r.fees24);
    // Доходность — по последнему часу: и фисы, и ликвидность у цены одного
    // времени. Суточные фисы на нынешнюю ликвидность врут: у BLAST цена
    // за 6 часов упала на 84%, ликвидность осталась на старых ценах, и
    // выходило «3172% в сутки».
    const fees1 = sum(people, (r) => r.fees1);
    const yield1 = near && near > 0 ? fees1 / near : null;
    // Меньше $500 у цены — доля одного LP огромна, и процент ничего не значит.
    const thin = near !== null && near < 500;

    // Риск — по движению цены главного пула.
    const h1 = main ? main.h1 : NaN;
    const h6 = main ? main.h6 : NaN;
    const h24 = main ? main.h24 : NaN;
    // Нет данных — так и говорим: «спокойно» по пустому месту хуже, чем ничего.
    const risk = !main ? 'нет данных'
      : (h24 <= -30 || h6 <= -20) ? 'падает'
        : (Math.abs(h1) >= 15 || Math.abs(h6) >= 40) ? 'штормит'
          : (h24 >= 100) ? 'улетел' : 'спокойно';

    // Лучшие пулы людей: фисы за сутки на доллар ликвидности пула.
    const best = people.filter((r) => r.vol24 >= 1000 && r.usd >= 500 && r.fee > 0)
      .map((r) => ({ name: r.name, kind: r.kind, fee: r.fee, dynamic: r.dynamic, usd: r.usd, vol24: r.vol24,
                     fees24: r.fees24, ratio: r.fees24 / r.usd }))
      .sort((a, b) => b.fees24 - a.fees24).slice(0, 4);

    return { ok: true, pools: rows.length,
      peoplePools: people.length, launchpadPools: rows.length - people.length,
      ladderPools: rows.filter((r) => r.kind === 'ladder').length,
      tvlPeople: sum(people, (r) => r.usd), tvlLaunchpad: sum(rows.filter((r) => r.kind === 'launchpad'), (r) => r.usd),
      vol24: sum(rows, (r) => r.vol24), vol1: sum(rows, (r) => r.vol1), fees24, fees1,
      near, nearError, yield1, thin, price,
      h1, h6, h24, risk, best, sure: !!meta };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
}

const LOG = self.GHO_LOG ? self.GHO_LOG.use('sw').catchAll().at('sw') : null;
const logErr = (msg, data) => { if (LOG) LOG.err(msg, data); };

const HANDLERS = {
  /**
   * Глубина пула: сколько всего ликвидности стоит на каждом уровне цены.
   * Это ликвидность всего пула, а не наши позиции.
   *
   * poolId берём у GMGN (он отдаёт его как адрес пула, bytes32), шаг тика и
   * валюты — из события Initialize, само состояние — из StateView.
   */
  async depth({ chain, addr }) {
    const net = await netFor(chain);
    if (!net) return { ok: false, error: 'нет RPC для сети ' + chain };

    const C = self.GHO_CHAIN;
    try {
      // Пул ищем прямо в цепи по логам создания. Раньше poolId брался у GMGN,
      // и без его подписей запросов вся глубина отваливалась — а цепь про свои
      // пулы знает сама.
      const q = QUOTES[chain] || {};
      const me = String(addr).toLowerCase();
      const other = (p) => (p.currency0.toLowerCase() === me ? p.currency1 : p.currency0);

      // Набор пулов токена почти не меняется, а перебор «в каком из них есть
      // ликвидность» — это сотня с лишним вызовов и половина всего счёта за
      // глубину. Держим список в памяти и обновляем изредка.
      const ckey = chain + ':' + me;
      let box = poolCache.get(ckey);
      if (!box || Date.now() - box.at > POOLS_TTL) {
        let known = await discoverPools(chain, addr, net).catch(() => null);
        if (!known || !known.length) known = await C.poolsOfToken(net, addr);
        const all = await C.candidates(net, addr, 10, known, [q.stable, ZERO_ADDR]);
        box = { all, totalPools: known.length, at: Date.now(), hooks: hooksOf(known), meta: metaOf(known) };
        poolCache.set(ckey, box);
      }
      // Из десятка пулов деньги обычно лежат в двух-трёх, а чтение тиков —
      // это полторы сотни вызовов. После первого полного прохода запоминаем,
      // кто чего стоит, и дальше читаем только тех, кто покрывает почти всё.
      const totalPools = box.totalPools;
      const all = box.weights ? pickHeavy(box.all, box.weights) : box.all;
      if (!all.length) return { ok: false, error: 'у токена нет пула V4 с ликвидностью' };

      // Состояние всех пулов забираем разом: они друг от друга не зависят,
      // а по очереди это был десяток обходов сети на каждый пул.
      const states = (await Promise.all(all.map(async (pool) => {
        try {
          const [d0, d1] = await Promise.all([
            C.decimalsOf(net, pool.currency0),
            C.decimalsOf(net, pool.currency1),
          ]);
          const state = await C.readDepth(net, pool.poolId, pool.tickSpacing);
          const tokenIsZero = pool.currency0.toLowerCase() === me;
          const px = Math.pow(1.0001, state.tick) * Math.pow(10, d0 - d1);
          return { pool, state, d0, d1, tokenIsZero, perToken: tokenIsZero ? px : 1 / px };
        } catch (e) {
          return null;
        }
      }))).filter((x) => x && x.perToken > 0 && isFinite(x.perToken));
      if (!states.length) return { ok: false, error: 'не удалось прочитать пулы токена' };

      // Опорная точка — цена самого токена в долларах. Берём её из тика
      // стейблового пула, который уже прочитан: отдельный запрос за ценой
      // тут не нужен. От неё выводится курс любой котировки, поэтому
      // справочник курсов не требуется — раньше пулы против экзотики
      // выбрасывались фильтром, а на Robinhood Chain именно в них лежит
      // основная масса денег (токены лаунчпада парятся с акциями вроде SPCX).
      const stable = String(q.stable || '').toLowerCase();
      const onStable = states.find((x) => other(x.pool).toLowerCase() === stable);
      let usdOfToken = onStable ? onStable.perToken : 0;
      if (!usdOfToken) {
        const nat = states.find((x) => other(x.pool).toLowerCase() === ZERO_ADDR);
        const rate = nat ? await quoteUsd(net, chain, ZERO_ADDR) : 0;
        if (nat && rate) usdOfToken = nat.perToken * rate;
      }
      if (!usdOfToken) {
        return { ok: false, error: 'нечем оценить токен: нет пула против доллара' };
      }

      // Котировкам, у которых нет своего живого пула против доллара, верить
      // нельзя: такой пул назначает цену сам себе. У них считаем только
      // сторону токена. Проверяем по разу на котировку, ответы кэшируются.
      // Проверок делаем считанное число: у токена, которого наспамили в
      // тысячи пар, их набегает два десятка, и разбор растягивается на
      // полминуты. Непроверенное считаем недоверенным — это занижает итог,
      // а не завышает, и такая ошибка честнее.
      const CHECKS = 6;
      const weight = new Map();
      for (const x of states) {
        const qa = other(x.pool).toLowerCase();
        const w = Number(x.pool.liquidity || 0n);
        if (!weight.has(qa) || w > weight.get(qa)) weight.set(qa, w);
      }
      const quotes = [...weight.keys()].sort((a, b) => weight.get(b) - weight.get(a));
      const trust = new Map();
      await Promise.all(quotes.slice(0, CHECKS).map(async (qa) => {
        trust.set(qa, await C.pricedInStable(net, qa, q.stable).catch(() => false));
      }));

      const lists = [];
      const added = [];
      const parts = [];
      let best = null;
      let shaky = 0;
      for (const x of states) {
        // Курс котировки выводим из тика самого пула: цена токена в долларах
        // известна, значит известна и цена того, за что его тут меняют.
        const rate = usdOfToken / x.perToken;
        if (!isFinite(rate) || rate <= 0) continue;
        const qa = other(x.pool).toLowerCase();
        const solid = trust.get(qa) !== false;
        if (!solid) shaky += 1;
        const out = C.bands(x.state, x.pool.tickSpacing, x.d0, x.d1, x.tokenIsZero, rate, !solid);
        const sum = out.bands.reduce((s2, b) => s2 + (b.usd || 0), 0);
        if (!out.bands.length || !isFinite(sum)) continue;
        // Пул лаунчпада узнаём по хуку: там ликвидность копится сама из
        // торгов, и складывать её с заведённой руками нельзя — на Robinhood
        // Chain она перевешивает всё остальное раз в пять.
        // Руками — всё, что не лаунчпад. Раньше «руками» считались только
        // пулы совсем без хука, а лесенки Liquidity Ladder создают пулы со
        // своим хуком (…dead0030) — и главный USDG-пул BLAST на $186K шёл
        // в «прочее».
        const byHand = !isLaunchpad(x.pool.hooks);
        lists.push(out.bands);
        if (byHand) added.push(out.bands);
        parts.push({ quote: qa, poolId: x.pool.poolId, fee: (x.pool.fee >= 0x800000 ? null : x.pool.fee / 10000),
                     usd: sum, byHand, solid });
        if (!best || sum > best.usd) best = { usd: sum, pool: x.pool, out };
      }
      if (!best) return { ok: false, error: 'в пуле нет ликвидности рядом с ценой' };

      // Сетка помельче: на крупной полосы выходят толстыми и залепляют свечи.
      const GRID = 400;
      // Запоминаем, кто сколько весит: следующий пересчёт обойдётся дешевле.
      if (!box.weights) {
        box.weights = {};
        for (const x of parts) box.weights[x.poolId] = x.usd;
      }

      const bands = C.mergeBands(lists, GRID, usdOfToken);
      const bandsAdded = C.mergeBands(added, GRID, usdOfToken);
      // Сводим по котировке, а не по пулам: восемь строк «USDG» ничего не
      // говорят, а «USDG $8103» отвечает на вопрос, где лежат деньги.
      const byQuote = new Map();
      for (const part of parts) {
        const box = byQuote.get(part.quote) || { quote: part.quote, usd: 0, pools: 0 };
        box.usd += part.usd;
        box.pools += 1;
        byQuote.set(part.quote, box);
      }
      const groups = [...byQuote.values()].sort((a, b) => b.usd - a.usd);

      // Разбивка по пулам, куда ликвидность завели руками: её он и просил
      // видеть отдельно от общей.
      const hand = parts.filter((x) => x.byHand).sort((a, b) => b.usd - a.usd);
      const perPool = hand.slice(0, 6);

      // Подписываем только то, что покажем: символ — это лишний вызов RPC.
      const symbols = new Map();
      const label = async (q) => {
        if (!symbols.has(q)) symbols.set(q, await C.symbolOf(net, q).catch(() => ''));
        return symbols.get(q);
      };
      const named = [...groups.slice(0, 3), ...perPool];
      await Promise.all(named.map(async (x) => { x.symbol = await label(x.quote); }));
      return { ok: true,
               poolId: best.pool.poolId,
               fee: (best.pool.fee >= 0x800000 ? null : best.pool.fee / 10000),
               pools: totalPools,
               counted: parts.length,
               shaky,
               parts: groups.slice(0, 5),
               perPool,
               addedPools: hand.length,
               addedUsd: hand.reduce((s2, x) => s2 + x.usd, 0),
               bands: bands.length ? bands : best.out.bands,
               bandsAdded,
               price: usdOfToken,
               usdPrice: true,
               lpFee: best.out.lpFee };
    } catch (e) {
      return { ok: false, error: 'цепь: ' + String(e && e.message) };
    }
  },

  // Диагностика: доходит ли вообще запрос до GMGN в обход фрейма
  async probe({ chain, addr }) {
    const box = await readParams();
    const out = { params: !!box, ageMin: box ? Math.round((Date.now() - box.savedAt) / 60000) : null };
    try {
      const page = await fetch(`${BASE}/${chain}/token/${addr}`, { credentials: 'include' });
      out.page = page.status;
    } catch (e) {
      out.page = 'network-error';
    }
    const candles = await call(`/api/v1/token_mcap_candles/${chain}/${addr}`, {
      resolution: '1m', limit: '10',
    });
    out.candles = candles.ok ? 'ok' : (candles.status || candles.error);
    out.bars = candles.ok && Array.isArray(candles.data && candles.data.list)
      ? candles.data.list.length
      : (candles.ok ? Object.keys(candles.data || {}).join(',').slice(0, 60) : null);

    const net = await netFor(chain);
    out.rpc = net ? 'задан' : 'НЕ ЗАДАН';
    if (net) {
      const d = await HANDLERS.depth({ chain, addr });
      out.depth = d.ok ? `${d.bands.length} полос` : d.error;
    }
    return out;
  },


  // Ликвидность пулов токена: сколько денег стоит в самом пуле, а не у нас
  poolFee({ chain, addr }) {
    return call(`/api/v1/token_pool_fee_info/${chain}/${addr}`);
  },



  /**
   * Есть ли у токена пул с нулевой комиссией.
   *
   * На Robinhood Chain такой пул заводит лаунчпад, и у него всегда стоит
   * хук. Признак различающий: у токенов, вышедших не через лаунчпад, его
   * нет вовсе. Ответ меняется редко, поэтому держим сутки.
   */
  async zeroPool({ chain, addr }) {
    const key = 'zero:' + chain + ':' + String(addr).toLowerCase();
    try {
      const v = await chrome.storage.local.get('llZero');
      const box = (v && v.llZero) || {};
      const hit = box[key];
      if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return { ok: true, ...hit };
    } catch (e) { /* без кэша просто спросим заново */ }

    const net = await netFor(chain);
    if (!net) return { ok: false, error: 'нет RPC для сети ' + chain };
    try {
      const C = self.GHO_CHAIN;
      const pools = await C.poolsOfToken(net, addr);
      const zero = pools.filter((p) => Number(p.fee) === 0);
      let live = 0;
      if (zero.length) {
        const liq = await C.rpcBatch(net.stateRpc || net.rpc, zero.map((p) => ({
          to: net.stateView, data: C.SEL.liquidity + p.poolId.slice(2),
        })));
        live = zero.filter((x, i) => liq[i] && BigInt(liq[i]) > 0n).length;
      }
      // Пул лаунчпада узнаём по его хуку. Нулевой пул без хука — другое
      // дело: такой заводят руками, и комиссии в нём нет вовсе, что удобно
      // для прокрутки объёма и бандла. Смешивать их нельзя.
      const LAUNCHPAD = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
      const hooked = zero.filter(
        (p) => String(p.hooks || '').toLowerCase() === LAUNCHPAD,
      ).length;
      const bare = zero.length - hooked;
      const out = { has: zero.length > 0, live, hooked, bare,
                    pools: pools.length, at: Date.now() };

      try {
        const v = await chrome.storage.local.get('llZero');
        const box = (v && v.llZero) || {};
        box[key] = out;
        await chrome.storage.local.set({ llZero: box });
      } catch (e) { /* не записалось — переживём */ }
      return { ok: true, ...out };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  },

  // Символ токена: у вкладок, открытых с GMGN, подписи взяться неоткуда,
  // и в списках вместо названия торчал адрес.
  async symbol({ chain, addr }) {
    const net = await netFor(chain);
    if (!net) return { ok: false, error: 'нет RPC для сети ' + chain };
    try {
      const sym = await self.GHO_CHAIN.symbolOf(net, addr);
      return sym ? { ok: true, symbol: sym } : { ok: false, error: 'символ не прочитался' };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  },

  // Несобранные фисы позиций — в штуках токена и каждой котировки. Сайт
  // даёт только общую сумму в долларах, а для безубытка и подписи на
  // графике нужно знать, сколько там самого токена и сколько стейбла.
  async posFees({ chain, ids, token, fresh }) {
    const net = await netFor(chain);
    if (!net) return { ok: false, error: 'нет RPC для сети ' + chain };
    const list = [...new Set((ids || []).map(String))].sort();
    if (!list.length) return { ok: false, error: 'нет позиций' };
    const key = chain + '|' + list.join(',');
    const hit = posFeeCache.get(key);
    // После сбора — только свежее: иначе в «фисах» висит уже собранное.
    if (!fresh && hit && Date.now() - hit.at < POS_FEES_TTL) return hit.out;
    try {
      const r = await self.GHO_CHAIN.positionFees(net, list);
      const tok = String(token || '').toLowerCase();
      const quotes = [];
      for (const [addr, amount] of Object.entries(r.sums)) {
        if (addr === tok || !(amount > 0)) continue;
        const symbol = await self.GHO_CHAIN.symbolOf(net, addr).catch(() => addr.slice(0, 8));
        quotes.push({ addr, amount, symbol });
      }
      // Ступени из цепи — по ним график рисует леддер, даже когда токена нет
      // на странице и когда цена пула улетела. Котировку переводим в
      // доллары: стейбл — единица, эфир — по курсу, прочее не рисуем.
      const rungs = [];
      for (const d of r.details || []) {
        const quote = d.c0 === tok ? d.c1 : d.c0;
        const sym = await self.GHO_CHAIN.symbolOf(net, quote).catch(() => '');
        const q = QUOTES[chain] || {};
        const isEth = quote === ZERO_ADDR || quote === String(q.wrapped || '').toLowerCase();
        const k = /^(usdg|usdc|usdt|dai|usde|pyusd)$/i.test(sym) ? 1
          : isEth ? await quoteUsd(net, chain, ZERO_ADDR) : 0;
        const rung = self.GHO_CHAIN.rungOf(d, tok, k);
        if (rung) rungs.push(rung);
      }
      // Состояние пула леддера — по первой ступени (леддер живёт в одном пуле).
      const withPool = rungs.find((x) => x.pool);
      const out = { ok: true, token: r.sums[tok] || 0, quotes, positions: r.positions, rungs,
                    pool: withPool ? withPool.pool : null };
      posFeeCache.set(key, { at: Date.now(), out });
      return out;
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  },

  /*
   * Разбор токена для LP: куда и стоит ли лить.
   *
   * Доходность считаем по ТОКЕНУ, а не по пулу: на BLAST фисы на доллар в
   * твоём пуле, главном USDG и ETH вышли почти одинаковыми — пулы одного
   * токена выравнивает арбитраж. Поэтому: фисы всех пулов людей за сутки ÷
   * ликвидность людей у цены (±10%) — ту, что эти фисы и получает. Рядом —
   * движение цены: на BLAST фисы дали +5%, а падение −70% съело всё.
   */
  async lpScan({ chain, addr }) {
    const r = await lpScanNow(chain, addr);
    if (r.ok) await rememberLp(chain, addr, r);
    return r;
  },

  /*
   * Топ токенов сети по обороту — для скринера. Берём топ пулов у
   * GeckoTerminal и собираем из них токены, отсеивая котировки: пары
   * «USDG / WETH» и «SPCX / USDG» — это не то, куда ищут, где лить.
   */
  async lpTop({ chain, pages }) {
    const netId = GT_NET[chain];
    if (!netId) return { ok: false, error: 'сеть не поддерживается' };
    const q = QUOTES[chain] || {};
    const skip = new Set([q.stable, q.wrapped, ZERO_ADDR, SPCX_TOKEN].filter(Boolean).map((x) => x.toLowerCase()));
    const byToken = new Map();
    try {
      for (let page = 1; page <= Math.min(10, Number(pages) || 5); page++) {
        const res = await gtFetch('https://api.geckoterminal.com/api/v2/networks/' + netId
          + '/pools?sort=h24_volume_usd_desc&page=' + page);
        if (!res.ok) break;
        const j = await res.json();
        for (const p of (j && j.data) || []) {
          const a = p.attributes || {};
          const idOf = (rel) => String((((p.relationships || {})[rel] || {}).data || {}).id || '').split('_').pop().toLowerCase();
          const base = idOf('base_token');
          const quote = idOf('quote_token');
          const [bn, qn] = String(a.name || '').split(' / ');
          const pick = !skip.has(base) ? [base, bn] : !skip.has(quote) ? [quote, (qn || '').split(' ')[0]] : null;
          if (!pick || !/^0x[0-9a-f]{40}$/.test(pick[0])) continue;
          const box = byToken.get(pick[0]) || { addr: pick[0], symbol: pick[1] || '', vol24: 0, created: null };
          box.vol24 += Number((a.volume_usd || {}).h24) || 0;
          const c = a.pool_created_at ? Date.parse(a.pool_created_at) : null;
          if (c && (!box.created || c < box.created)) box.created = c;
          byToken.set(pick[0], box);
        }
      }
    } catch (e) {
      if (!byToken.size) return { ok: false, error: String(e && e.message) };
    }
    const flags = await stockFlags(chain, [...byToken.keys()]).catch(() => ({}));
    const stocks = [...byToken.keys()].filter((a) => flags[a]);
    for (const a of stocks) byToken.delete(a);
    return { ok: true, stocks: stocks.length, tokens: [...byToken.values()].sort((a, b) => b.vol24 - a.vol24) };
  },

  /*
   * Лёгкие цифры для меток в списках GMGN: ликвидность пулов и оборот за
   * сутки — сразу по 30 токенам одним запросом GeckoTerminal. Полный разбор
   * на каждую строку списка не вытянуть по его лимиту (30 запросов в минуту).
   */
  async lpMulti({ chain, addrs }) {
    const netId = GT_NET[chain];
    if (!netId) return { ok: false, error: 'сеть не поддерживается' };
    const want = [...new Set((addrs || []).map((a) => String(a).toLowerCase()))]
      .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
    const out = {};
    const miss = [];
    for (const a of want) {
      const hit = multiCache.get(chain + ':' + a);
      if (hit && Date.now() - hit.at < 5 * 60000) out[a] = hit.v; else miss.push(a);
    }
    for (let i = 0; i < miss.length; i += 30) {
      const part = miss.slice(i, i + 30);
      const res = await gtFetch('https://api.geckoterminal.com/api/v2/networks/' + netId + '/tokens/multi/'
        + part.join(',')).catch(() => null);
      if (!res || !res.ok) continue;
      const j = await res.json().catch(() => null);
      for (const t of (j && j.data) || []) {
        const a = t.attributes || {};
        const addr = String(a.address || '').toLowerCase();
        const v = { reserve: Number(a.total_reserve_in_usd) || 0, vol24: Number((a.volume_usd || {}).h24) || 0,
                    mcap: Number(a.market_cap_usd) || Number(a.fdv_usd) || 0 };
        multiCache.set(chain + ':' + addr, { at: Date.now(), v });
        out[addr] = v;
      }
    }
    return { ok: true, tokens: out };
  },

  // История ликвидности людей по токенам — копится с каждым разбором.
  async lpHistory() {
    return { ok: true, hist: await loadHist() };
  },

  // Открыть скринер отдельной вкладкой.
  async openScreener() {
    try { await chrome.tabs.create({ url: chrome.runtime.getURL('src/screener.html') }); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e && e.message) }; }
  },

  // Сколько ликвидности в токен залили люди и сколько лежит в пуле
  // лаунчпада — по всем пулам целиком.
  async tvl({ chain, addr }) {
    const me = String(addr || '').toLowerCase();
    const key = chain + ':' + me;
    const hit = tvlCache.get(key);
    if (hit && Date.now() - hit.at < TVL_TTL) return hit.out;
    const netId = GT_NET[chain];
    if (!netId) return { ok: false, error: 'сеть не поддерживается' };
    try {
      const pools = [];
      for (let page = 1; page <= 2; page++) {
        const res = await gtFetch('https://api.geckoterminal.com/api/v2/networks/' + netId
          + '/tokens/' + me + '/pools?page=' + page);
        if (!res.ok) { if (page === 1) return { ok: false, error: 'GeckoTerminal ответил ' + res.status }; break; }
        const j = await res.json();
        const data = Array.isArray(j && j.data) ? j.data : [];
        for (const p of data) {
          const a = p.attributes || {};
          pools.push({ id: String(a.address || '').toLowerCase(), name: a.name || '',
                       usd: Number(a.reserve_in_usd) || 0 });
        }
        if (data.length < 20) break;
      }
      // Чей пул — по хуку из цепи. Список пулов берём из памяти расчёта
      // глубины, нет его — читаем (это один раз на четверть часа).
      let hooks = null;
      const box = poolCache.get(key);
      if (box && box.hooks) hooks = box.hooks;
      else {
        const net = await netFor(chain);
        if (net) hooks = hooksOf(await self.GHO_CHAIN.poolsOfToken(net, addr).catch(() => []));
      }
      let people = 0;
      let launch = 0;
      const top = [];
      for (const p of pools) {
        const lp = hooks && hooks[p.id] !== undefined && isLaunchpad(hooks[p.id]);
        if (lp) launch += p.usd; else people += p.usd;
        top.push({ name: p.name, usd: p.usd, launchpad: lp });
      }
      top.sort((a, b) => b.usd - a.usd);
      const out = { ok: true, people, launchpad: launch, total: people + launch,
                    pools: pools.length, top: top.slice(0, 6), sure: !!hooks };
      tvlCache.set(key, { at: Date.now(), out });
      return out;
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  },

  // Выпуск токена: страница переводит по нему уровни из мкапа в цену.
  async supply({ chain, addr }) {
    const net = await netFor(chain);
    if (!net) return { ok: false, error: 'нет RPC для сети ' + chain };
    try {
      const v = await self.GHO_CHAIN.supplyOf(net, addr);
      return v ? { ok: true, supply: v } : { ok: false, error: 'не прочитался выпуск' };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  },

  // Страница поднялась и готова принимать поручения.
  llReady(msg, sender) {
    const id = sender && sender.tab && sender.tab.id;
    if (id === undefined) return { ok: true, pending: false };
    try { self.GHO_WATCH.markReady(id); } catch (e) { /* воркер только встал */ }
    let had = false;
    try { had = self.GHO_WATCH.flushPending(id); } catch (e) { had = false; }
    // Своя ли это вкладка: только в своих страница сама обновляется и
    // заново входит на сайт, когда сессия истекла. Твои не трогаются.
    let own = false;
    try { own = self.GHO_WATCH.isMine(id); } catch (e) { own = false; }
    return { ok: true, pending: had, mine: own };
  },

  // Вкладка сторожа сама входила заново после истёкшей сессии.
  relogin({ ok, step }) {
    try { self.GHO_WATCH.reloginReport(!!ok, step); } catch (e) { /* воркер только встал */ }
    return { ok: true };
  },

  // Пульт вкладок в настройках: показать, открыть недостающие, закрыть свои.
  async tabsState() {
    try { return { ok: true, ...(await self.GHO_WATCH.tabsReport()) }; }
    catch (e) { return { ok: false, error: String(e && e.message) }; }
  },

  async tabsOpen() {
    try { return await self.GHO_WATCH.openTabsNow(); }
    catch (e) { return { ok: false, error: String(e && e.message) }; }
  },

  async tabsClose() {
    try { return await self.GHO_WATCH.closeTabsNow(); }
    catch (e) { return { ok: false, error: String(e && e.message) }; }
  },

  // Сухой прогон автосбора: проверить доступ и показать, что собралось бы.
  async dryRun({ minUsd }) {
    try { return { ok: true, ...(await self.GHO_WATCH.dryRun(minUsd)) }; }
    catch (e) { return { ok: false, error: String(e && e.message) }; }
  },

  // Что сторож видит прямо сейчас: настройки это показывают.
  async watchState() {
    try {
      let api = false;
      try {
        const v = await chrome.storage.local.get('llCollect');
        api = !!(v && v.llCollect && v.llCollect.body);
      } catch (e) { api = false; }
      return { ok: true, api, ...self.GHO_WATCH.watchStatus() };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  },

  // Страница отчиталась, чем кончился импульс. Уведомление шлём отсюда:
  // на самой проверке показывать нечего, а вот про сбор знать надо.
  collected({ label, usd, why }, sender) {
    // Вкладку открывал сторож — закрываем её, дело сделано.
    try { self.GHO_WATCH.closeMine(sender && sender.tab && sender.tab.id); }
    catch (e) { /* нечего закрывать */ }
    const who = label || 'токен';
    if (why) note('Импульс ' + who, why);
    else note('Собираю фисы: ' + who, usd ? 'накопилось $' + Math.round(usd) : 'нажал Collect');
    return { ok: true };
  },
};

chrome.tabs.onRemoved.addListener((tabId) => {
  try { self.GHO_WATCH.forgetTab(tabId); } catch (e) { /* воркер ещё не поднялся */ }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fn = msg && HANDLERS[msg.type];
  if (!fn) return false;
  Promise.resolve(fn(msg, sender))
    .then(reply)
    .catch((e) => {
      // Без журнала такая ошибка видна только в консоли воркера, а туда
      // никто не смотрит: наружу уходит просто «не получилось».
      logErr('обработчик ' + msg.type + ' упал', e);
      reply({ ok: false, error: 'threw', message: String(e && e.message) });
    });
  return true;   // ответ придёт асинхронно
});
