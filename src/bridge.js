/*
 * GMGN Holder Entries — page-world bridge.
 *
 * Живёт в MAIN world, потому что всё интересное — приватные объекты чарта
 * (window.chartWidgetCollection внутри blob-iframe) — недоступно из isolated world.
 *
 * Отвечает за три вещи:
 *   1. подсматривает anti-bot параметры запросов GMGN (device_id, fp_did, ...);
 *   2. тянет топ-трейдеров и инфо токена через тот же внутренний API, что и сайт;
 *   3. рисует маркеры входа поверх канваса TradingView.
 *
 * Разметка чарта — приватный API TV (v32 Trading Terminal), поэтому каждое
 * обращение к нему обёрнуто и деградирует в "оверлея нет", а не в упавшую страницу.
 */
(() => {
  'use strict';

  if (window.__GHO_BRIDGE__) return;
  window.__GHO_BRIDGE__ = true;

  // Во фрейме (оверлей на Liquidity Ladder) опрашиваем API реже, чем в обычной
  // вкладке: встроенная страница, долбящая чужой домен каждые шесть секунд,
  // выглядит для бот-защиты как скрейпинг. Раз в 20 секунд для линий входа
  // более чем достаточно — точки входа не меняются каждую секунду.
  const INFRAME = window.top !== window.self;
  const FRAME_MIN_SEC = 20;

  const OVERLAY_ID = 'gho-overlay-canvas';
  const TOOLTIP_ID = 'gho-overlay-tooltip';

  /* ------------------------------------------------------------------ *
   * 0. Ссылки на нетронутые originals — сайт оборачивает fetch и свой,
   *    поэтому свои запросы шлём через оригинал, чтобы не попасть в
   *    собственный сниффер и не ловить чужие интерцепторы.
   * ------------------------------------------------------------------ */
  const origFetch = window.fetch.bind(window);

  /* ------------------------------------------------------------------ *
   * 1. Сниффер параметров запроса
   * ------------------------------------------------------------------ */
  const PARAM_KEYS = [
    'device_id', 'tab_id', 'fp_did', 'client_id', 'from_app',
    'app_ver', 'tz_name', 'tz_offset', 'app_lang', 'os',
  ];

  let apiParams = null;

  function sniffUrl(raw) {
    if (!raw) return;
    let u;
    try { u = new URL(raw, location.origin); } catch { return; }
    if (u.host !== location.host) return;
    if (!u.searchParams.has('device_id')) return;

    const found = {};
    for (const k of PARAM_KEYS) {
      const v = u.searchParams.get(k);
      if (v !== null) found[k] = v;
    }
    if (JSON.stringify(found) === JSON.stringify(apiParams)) return;
    apiParams = found;
    // отдаём наверх: сервис-воркер ходит в API этими же подписями, когда
    // страницу GMGN во фрейм встроить не удаётся
    try { post({ type: 'params', params: found }); } catch (e) { /* панель ещё не слушает */ }
  }

  const prevFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      sniffUrl(typeof input === 'string' ? input : input && input.url);
    } catch { /* сниффер никогда не должен ломать запрос сайта */ }
    return prevFetch.apply(this, arguments);
  };

  const origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { sniffUrl(url); } catch { /* см. выше */ }
    return origXhrOpen.apply(this, arguments);
  };

  function waitForParams(timeoutMs = 15000) {
    if (apiParams) return Promise.resolve(apiParams);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = setInterval(() => {
        if (apiParams) { clearInterval(tick); resolve(apiParams); }
        else if (Date.now() - started > timeoutMs) {
          clearInterval(tick);
          reject(new Error('не удалось перехватить параметры запросов GMGN'));
        }
      }, 200);
    });
  }

  /* ------------------------------------------------------------------ *
   * 2. Слой данных
   * ------------------------------------------------------------------ */
  async function api(path, extra = {}) {
    const params = await waitForParams();
    const qs = new URLSearchParams({ ...params, ...extra });
    const res = await origFetch(`${location.origin}${path}?${qs}`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    const body = await res.json();
    if (body.code !== 0) {
      throw new Error(`${path} → code ${body.code} ${body.msg || body.message || ''}`);
    }
    return body.data;
  }

  /** Достаёт chain/token из адреса вида /bsc/token/0xabc… или /sol/token/<mint>. */
  function ctxFromLocation() {
    return ctxFromPath(location.pathname);
  }

  /**
   * GMGN открывает токен и по ссылке с рефкодом: /robinhood/token/LbosYDck_0x462d…
   * Раньше разбор обрывался на подчёркивании, и в запрос уходил рефкод вместо
   * адреса — сервер отвечал 400, холдеры не грузились.
   */
  function ctxFromPath(path) {
    const m = String(path || '').match(/^\/([a-z0-9_-]+)\/token\/([^/?#]+)/);
    if (!m) return null;
    let seg = m[2];
    try { seg = decodeURIComponent(seg); } catch (e) { /* как есть */ }
    const evm = /0x[0-9a-fA-F]{40}/.exec(seg);
    if (evm) return { chain: m[1], token: evm[0] };
    const sol = seg.split('_').reverse().find((p) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p));
    return sol ? { chain: m[1], token: sol } : null;
  }

  async function fetchTokenInfo(ctx) {
    return api(`/api/v1/token_info/${ctx.chain}/${ctx.token}`);
  }

  /**
   * Топ-трейдеры.
   *
   * Пагинация недоступна: поле data.next приходит (base64 "offset|address"),
   * но ни один из параметров (cursor/next/page_token/from/offset) сервером
   * не принимается — вторая страница всегда повторяет первую. limit больше
   * 100 сервер трактует как невалидный и молча отдаёт 20 записей, поэтому
   * жёстко ограничиваем сотней и сортируем уже у себя.
   */
  const MAX_LIMIT = 100;

  async function fetchHolders(ctx, wanted = MAX_LIMIT) {
    const limit = Math.max(1, Math.min(MAX_LIMIT, wanted));
    const data = await api(`/vas/api/v1/token_traders/${ctx.chain}/${ctx.token}`, {
      limit: String(limit),
      orderby: 'profit',
      direction: 'desc',
    });
    return (data && data.list) || [];
  }

  /* ------------------------------------------------------------------ *
   * 3. Нормализация
   * ------------------------------------------------------------------ */

  /**
   * amount_percentage приходит долей (0.0184 = 1.84%), но у части чейнов
   * встречается и уже готовый процент. Больше 1 доля быть не может,
   * поэтому значения >1 трактуем как проценты.
   */
  function toPercent(raw) {
    const v = Number(raw);
    if (!isFinite(v) || v <= 0) return 0;
    return v > 1 ? v : v * 100;
  }

  function normalizeHolders(list, supply = 0) {
    return list.map((h) => {
      const balance = Number(h.balance) || 0;
      const totalCost = Number(h.total_cost) || 0;
      const bought = Number(h.history_bought_cost) || 0;
      const accuAmount = Number(h.accu_amount) || 0;

      // avg_cost бывает null (вход трансфером, а не покупкой) — тогда
      // восстанавливаем среднюю по накопленной стоимости.
      let avgCost = Number(h.avg_cost);
      if (!isFinite(avgCost) || avgCost <= 0) {
        const cost = totalCost || bought;
        avgCost = accuAmount > 0 && cost > 0 ? cost / accuAmount : 0;
      }

      // На старых крупных токенах GMGN отдаёт amount_percentage нулём,
      // но balance и supply известны — считаем долю сами.
      let percent = toPercent(h.amount_percentage);
      if (percent <= 0 && supply > 0 && balance > 0) percent = (balance / supply) * 100;

      return {
        address: h.address,
        percent,
        balance,
        usdValue: Number(h.usd_value) || 0,
        avgCost: avgCost > 0 ? avgCost : null,
        entryAt: Number(h.start_holding_at) || null,
        exitAt: Number(h.end_holding_at) || null,
        lastActive: Number(h.last_active_timestamp) || null,
        profit: Number(h.profit) || 0,
        unrealizedProfit: Number(h.unrealized_profit) || 0,
        realizedProfit: Number(h.realized_profit) || 0,
        tag: h.wallet_tag_v2 || '',
        tags: Array.isArray(h.tags) ? h.tags : [],
        makerTags: Array.isArray(h.maker_token_tags) ? h.maker_token_tags : [],
        name: h.name || h.twitter_username || '',
        transferIn: !!h.transfer_in,
        isSuspicious: !!h.is_suspicious,
        // вход трансфером — цена входа условна, помечаем чтобы не вводить в заблуждение
        entryIsDerived: !(Number(h.avg_cost) > 0),
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * 4. Доступ к внутренностям TradingView
   * ------------------------------------------------------------------ */
  function getChart() {
    const frame = document.querySelector('iframe[id^="tradingview_"]');
    if (!frame) return null;

    let win;
    try { win = frame.contentWindow; } catch { return null; }
    if (!win || !win.chartWidgetCollection) return null;

    try {
      const holder = win.chartWidgetCollection.activeChartWidget;
      const widget = typeof holder?.value === 'function' ? holder.value() : holder;
      if (!widget || (widget.hasModel && !widget.hasModel())) return null;

      const model = widget.model();
      const series = model.mainSeries();
      const pane = widget.paneWidgets()[0];
      const canvas = pane && pane.canvasElement();
      if (!canvas) return null;

      return {
        frame, win, widget, model, series, pane, canvas,
        timeScale: model.timeScale(),
        priceScale: series.priceScale(),
      };
    } catch {
      return null;
    }
  }

  /** Чарт GMGN умеет показывать и цену, и капитализацию — тикер это выдаёт. */
  function chartIsMarketCap(chart) {
    try {
      const ticker = chart.series.symbolInfo()?.ticker || '';
      return /\/MCAP$/i.test(ticker);
    } catch {
      return false;
    }
  }

  /**
   * Время входа -> X.
   *
   * На мелких таймфреймах чарт держит куда меньше истории, чем возраст входа
   * (на 1s это считанные минуты), и closestIndexLeft для более раннего времени
   * возвращает null. Такие входы не выбрасываем: возвращаем крайний бар с
   * пометкой clamp, чтобы отрисовать их приглушённо у края, а не потерять.
   */
  function timeToX(chart, unixSeconds) {
    try {
      const points = chart.timeScale.points();
      const size = points.size();
      if (!size) return null;

      const firstTime = points.valueAt(0);
      const lastTime = points.valueAt(size - 1);

      if (unixSeconds < firstTime) {
        const x = chart.timeScale.indexToCoordinate(0);
        return isFinite(x) ? { x, clamp: 'left' } : null;
      }

      const idx = points.closestIndexLeft(unixSeconds);
      if (idx === null || idx === undefined) return null;

      const x = chart.timeScale.indexToCoordinate(idx);
      if (!isFinite(x)) return null;
      return { x, clamp: unixSeconds > lastTime ? 'right' : null };
    } catch {
      return null;
    }
  }

  function priceToY(chart, value) {
    try {
      const firstValue = chart.series.firstValue();
      if (firstValue === null || firstValue === undefined) return null;
      const y = chart.priceScale.priceToCoordinate(value, firstValue);
      return isFinite(y) ? y : null;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * 5. Оверлей
   * ------------------------------------------------------------------ */
  const state = {
    ctx: null,          // {chain, token}
    tokenInfo: null,
    holders: [],
    visible: [],        // то, что реально нарисовано (с координатами)
    selected: new Set(),
    hovered: null,
    config: {
      enabled: true,
      minPercent: 0,
      maxPercent: 2,
      limit: MAX_LIMIT,
      fullWidthLines: false,  // тянуть линию через весь график, а не от входа
      onlyHolding: true,
      autoRefresh: true,
      refreshSec: 6,
      frameHolders: true,    // линии холдеров внутри оверлея на Liquidity Ladder
    },
    loading: false,
    error: null,
    outOfHistory: 0,   // входов левее загруженной истории чарта
    lastUpdate: 0,
    levels: null,      // диапазон леддера с Liquidity Ladder, если он прислан
  };

  function supplyMultiplier(chart) {
    if (!chartIsMarketCap(chart)) return 1;
    const info = state.tokenInfo;
    const supply = Number(info?.circulating_supply) || Number(info?.total_supply) || 0;
    return supply > 0 ? supply : 1;
  }

  function colorForPercent(pct) {
    // 0% → холодный синий, 2%+ → тревожный красный
    const t = Math.max(0, Math.min(1, pct / 2));
    const r = Math.round(80 + t * 175);
    const g = Math.round(190 - t * 130);
    const b = Math.round(255 - t * 200);
    return `rgb(${r},${g},${b})`;
  }

  function ensureOverlay(chart) {
    const doc = chart.win.document;
    const parent = chart.canvas.parentElement || doc.body;

    let canvas = doc.getElementById(OVERLAY_ID);
    if (!canvas || canvas.parentElement !== parent) {
      canvas?.remove();
      canvas = doc.createElement('canvas');
      canvas.id = OVERLAY_ID;
      canvas.style.cssText =
        'position:absolute;left:0;top:0;pointer-events:none;z-index:40;';
      parent.appendChild(canvas);
    }

    let tooltip = doc.getElementById(TOOLTIP_ID);
    if (!tooltip || tooltip.parentElement !== parent) {
      tooltip?.remove();
      tooltip = doc.createElement('div');
      tooltip.id = TOOLTIP_ID;
      tooltip.style.cssText =
        'position:absolute;pointer-events:none;z-index:41;display:none;' +
        'background:rgba(16,18,24,.96);color:#e8eaed;border:1px solid #2b3040;' +
        'border-radius:6px;padding:6px 8px;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;' +
        'white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.5);';
      parent.appendChild(tooltip);
    }

    return { canvas, tooltip };
  }

  function syncOverlaySize(chart, canvas) {
    const base = chart.canvas;
    const w = base.clientWidth || base.width;
    const h = base.clientHeight || base.height;
    const dpr = chart.win.devicePixelRatio || 1;

    if (canvas.style.left !== base.offsetLeft + 'px') canvas.style.left = base.offsetLeft + 'px';
    if (canvas.style.top !== base.offsetTop + 'px') canvas.style.top = base.offsetTop + 'px';
    if (canvas.style.width !== w + 'px') canvas.style.width = w + 'px';
    if (canvas.style.height !== h + 'px') canvas.style.height = h + 'px';

    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;

    return { w, h, dpr };
  }

  /**
   * Уровни леддера с Liquidity Ladder: границы ступеней, общий диапазон и
   * подсветка той ступени, внутри которой сейчас цена. Приходят из оверлея
   * на самом сайте, здесь только рисуются.
   */
  function drawLevels(g, chart, w, h, mult) {
    const L = state.levels;
    if (!L) return;
    // Лесенки может и не быть: на обычной вкладке GMGN рисуем одну глубину
    // пулов токена — «видеть пулы на графике».
    const hasLadder = Array.isArray(L.positions) && L.positions.length > 0;
    if (!hasLadder && !(Array.isArray(L.depth) && L.depth.length)) return;

    // Пустая цена — это «не знаем», а не ноль: Number(null) даёт 0, и
    // выходило «цена НИЖЕ диапазона» у токена, цену которого не прочли.
    const cur = Number(L.current) > 0 ? Number(L.current) : NaN;
    // Цена в пуле лесенки — по ней считается, что лежит в ступенях. Рынок
    // может быть в другом месте: пул без сделок стоит, пока его не догонят.
    const at = Number(L.poolPrice) > 0 ? Number(L.poolPrice) : cur;
    const yOf = (price) => priceToY(chart, price * mult);
    const inView = (y) => y !== null && y > -60 && y < h + 60;
    const clip = (a, b) => {
      const y1 = yOf(b);
      const y2 = yOf(a);
      if (y1 === null || y2 === null) return null;
      const top = Math.max(0, Math.min(y1, y2));
      const bottom = Math.min(h, Math.max(y1, y2));
      return bottom > top ? [top, bottom] : null;
    };

    /* ---- глубина всего пула: сколько денег стоит на каждом уровне цены ---- */
    let depthW = 0;
    if (Array.isArray(L.depth) && L.depth.length) {
      const val = (b) => b.usd || b.quote || 0;
      const maxUsd = Math.max(...L.depth.map(val));
      if (maxUsd > 0) {
        // Пятая часть ширины графика под глубину — это стена поверх свечей.
        const maxW = Math.max(60, Math.min(150, w * 0.13));
        depthW = maxW;
        g.save();

        // Тонкими штрихами глубина читается лучше залитых полос: под ней
        // видно свечи, и соседние уровни не сливаются в сплошное пятно.
        const thin = L.depthThin !== false;
        for (const b of L.depth) {
          const v = val(b);
          const box = v ? clip(b.lo, b.hi) : null;
          if (!box) continue;
          const bw = Math.max(2, (v / maxUsd) * maxW);
          // Тонкие — да, бледные — нет: сквозь них всё равно видно свечи,
          // а разглядывать приходится именно их.
          g.fillStyle = b.current ? '#60a5fa' : 'rgba(96, 165, 250, .92)';
          if (thin) {
            // Штрих в пиксель: у цены чуть толще, чтобы её было видно.
            const mid = Math.round((box[0] + box[1]) / 2);
            const th = b.current ? 3 : 2;
            g.fillRect(0, mid, bw, Math.min(th, Math.max(1, box[1] - box[0])));
          } else {
            g.fillRect(0, box[0], bw, Math.max(1, box[1] - box[0] - 1));
          }
        }

        g.fillStyle = 'rgba(96, 165, 250, .7)';
        g.fillRect(0, 0, 1, h);

        // Подписи. Ликвидность обычно размазана ровно — на каждом уровне
        // лежит примерно одинаково, и подпись «$97» у каждой полосы ничего
        // не объясняет. Пишем накопленную сумму от цены: сколько всего
        // стоит между текущей ценой и этим уровнем. Это и есть ответ на
        // вопрос «сколько там лежит».
        g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        const cash = (v) => (v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M'
          : v >= 1000 ? '$' + (v / 1000).toFixed(1) + 'K'
            : '$' + Math.round(v));

        const price = Number(L.depthPrice) || 0;
        if (price > 0) {
          const marks = [];
          // Мелкие отметки нужны на приближённом графике, крупные — на общем
          for (const pc of [2, 5, 10, 25, 50, 100]) {
            for (const dir of [-1, 1]) {
              const level = price * (1 + (dir * pc) / 100);
              const lo = Math.min(price, level);
              const hi = Math.max(price, level);
              const sum = L.depth
                .filter((x) => x.hi > lo && x.lo < hi)
                .reduce((acc, x) => acc + val(x), 0);
              if (sum <= 0) continue;
              const box = clip(level * 0.995, level * 1.005);
              if (!box) continue;
              marks.push({ y: (box[0] + box[1]) / 2, sum,
                           text: (dir < 0 ? '−' : '+') + pc + '%  ' + cash(sum) });
            }
          }
          const taken = [];
          for (const m of marks.sort((x, y) => y.sum - x.sum)) {
            if (taken.some((t) => Math.abs(t - m.y) < 13)) continue;
            taken.push(m.y);
            const tw = g.measureText(m.text).width;
            g.fillStyle = 'rgba(11, 14, 19, .85)';
            g.fillRect(maxW + 5, m.y - 7, tw + 6, 13);
            g.fillStyle = 'rgba(191, 219, 254, .95)';
            g.fillText(m.text, maxW + 8, m.y + 3);
            g.fillStyle = 'rgba(96, 165, 250, .5)';
            g.fillRect(0, Math.round(m.y), maxW + 4, 1);
          }
        }
        g.restore();
      }
    }

    /* ---- свои ступени леддера, если попросили ---- */
    const allLo = hasLadder ? Math.min(...L.positions.map((r) => r[0])) : NaN;
    const allHi = hasLadder ? Math.max(...L.positions.map((r) => r[1])) : NaN;
    if (hasLadder && L.showMine && !L.envelope) {
      const rungs = Array.isArray(L.rungs) ? L.rungs : [];
      g.save();
      for (const r of rungs) {
        const box = clip(r.lo, r.hi);
        if (!box) continue;
        // Сторону у ступеней из цепи сайт не называет — она видна по цене:
        // выше цены лежит токен (продажа), ниже — стейбл (покупка).
        const side = (r.side || (isFinite(at) ? (r.lo >= at ? 'ask' : r.hi <= at ? 'bid' : 'both') : '')).toLowerCase();
        g.fillStyle = side === 'bid' ? 'rgba(74, 222, 128, .11)'
          : side === 'ask' ? 'rgba(251, 191, 36, .12)'
          : 'rgba(148, 163, 184, .10)';
        // Заливки достаточно: пунктир на каждой границе спорил с линиями
        // входа холдеров и с границами леддера — на графике получалась сетка.
        g.fillRect(0, box[0], w, Math.max(1, box[1] - box[0] - 1));
      }

      // ступень, внутри которой сейчас цена — только рамка, без заливки:
      // заливка означает сторону позиции, мешать два смысла нельзя
      const live = L.positions.find((r) => isFinite(at) && at >= r[0] && at <= r[1]);
      const liveBox = live && clip(live[0], live[1]);
      if (liveBox) {
        g.strokeStyle = 'rgba(255, 255, 255, .45)';
        g.lineWidth = 1;
        g.strokeRect(0.5, liveBox[0] + 0.5, w - 1, liveBox[1] - liveBox[0] - 1);
      }
      g.restore();
    }

    // Внешние границы леддера рисуем всегда, даже когда ступени неизвестны:
    // именно за ними позиция перестаёт собирать комиссию. Раньше при одних
    // границах (без ступеней) не рисовалось вообще ничего — и леддер,
    // из которого цена ушла вверх, с графика просто пропадал.
    if (hasLadder && L.showBounds !== false) {
      g.save();
      const lo = allLo;
      const hi = allHi;
      const outside = isFinite(at) && (at < lo || at > hi);
      const edge = outside ? 'rgba(248, 113, 113, .95)' : 'rgba(251, 191, 36, .9)';
      if (L.envelope) {
        // Ступеней не знаем — хотя бы тень всего диапазона.
        const band = clip(lo, hi);
        if (band) {
          g.fillStyle = 'rgba(148, 163, 184, .07)';
          g.fillRect(0, band[0], w, band[1] - band[0]);
        }
      }
      g.strokeStyle = edge;
      g.lineWidth = 1.5;
      g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      for (const price of [lo, hi]) {
        const y = yOf(price);
        if (!inView(y)) continue;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(w, y);
        g.stroke();

        // Край «на взводе» — тот, у которого сторож соберёт фисы. Подписываем
        // прямо здесь: иначе непонятно, где именно это случится.
        const arm = L.arm && (price === hi ? L.arm.hi : L.arm.lo);
        const text = (price === hi ? 'верх леддера ' : 'низ леддера ') + fmtLevel(price) + (arm ? '  ⏱ сбор' : '');
        const tw = g.measureText(text).width;
        const bx = w - tw - 12;
        const by = price === hi ? y + 3 : y - 15;
        g.fillStyle = 'rgba(16, 18, 24, .85)';
        g.fillRect(bx - 4, by, tw + 8, 14);
        g.fillStyle = edge;
        g.fillText(text, bx, by + 11);

        // Полоса, внутри которой сторож уже считает, что мы у края.
        if (arm && L.arm.pct > 0) {
          const near = price === hi ? price * (1 - L.arm.pct / 100)
            : price * (1 + L.arm.pct / 100);
          const band = clip(Math.min(price, near), Math.max(price, near));
          if (band) {
            g.save();
            g.fillStyle = outside ? 'rgba(248, 113, 113, .10)' : 'rgba(251, 191, 36, .10)';
            g.fillRect(0, band[0], w, band[1] - band[0]);
            g.restore();
          }
        }
      }
      g.restore();
    }

    // Подписи рисуются по очереди и раньше ложились друг на друга: коробка
    // «мой сайз» накрывала линию мешка целиком. Ведём список занятых мест и
    // передаём его каждому рисовальщику.
    const taken = [];
    drawCollects(g, chart, L, yOf, inView);
    drawTakes(g, L, w, h, yOf, inView, taken);
    drawSize(g, L, w, h, yOf, at, depthW, taken);
    drawMine(g, L, w, h, yOf, inView, at, depthW, taken);
    // Пул лесенки стоит — её состав заморожен, и БУ по рынку ничего не значит.
    if (!L.poolDead) drawBreakEven(g, L, w, h, yOf, inView, cur, depthW, taken);
    drawNote(g, L, w, h);
  }

  /**
   * Выбрать для подписи свободное место.
   *
   * Даём несколько вариантов по убыванию желаемости и берём первый, который
   * ни с чем не пересекается. Не нашлось — рисуем на первом: лучше наложение,
   * чем исчезнувшая подпись.
   */
  function place(taken, boxes) {
    const free = (b) => !taken.some((o) => b.x < o.x + o.w && o.x < b.x + b.w
      && b.y < o.y + o.h && o.y < b.y + b.h);
    for (const b of boxes) {
      if (free(b)) { taken.push(b); return b; }
    }
    taken.push(boxes[0]);
    return boxes[0];
  }

  /**
   * Что лежит в ступени при текущей цене — по формулам Uniswap.
   *
   * Сайт даёт сумму ступени в долларах по текущей цене. Из неё и границ
   * восстанавливаем ликвидность L, а из L — сколько там токена, сколько
   * котировки и сколько выручит токен, если цена пройдёт ступень насквозь.
   * Раньше делили сумму на середину ступени, а сумма-то по текущей цене:
   * у ступеней высоко над рынком мешок занижался в разы.
   */
  function rungSplit(r, cur) {
    const V = Number(r.value);
    const lo = Number(r.lo);
    const hi = Number(r.hi);
    if (!(lo > 0) || !(hi > lo) || !(cur > 0)) return null;
    const sa = Math.sqrt(lo);
    const sb = Math.sqrt(hi);
    let L;
    if (Number(r.lh) > 0) {
      // Ступень из цепи: ликвидность известна точно, суммы не нужны.
      L = Number(r.lh);
    } else {
      if (!(V > 0)) return null;
      // Ликвидность восстанавливаем по той цене, при которой сайт показал
      // сумму: у ступеней из памяти она старая, и делить старую сумму на
      // нынешнюю цену — ошибка. Дальше считаем уже при текущей.
      const ref = Number(r.at) > 0 ? Number(r.at) : cur;
      const sr = Math.sqrt(Math.min(Math.max(ref, lo), hi));
      L = V / ((1 / sr - 1 / sb) * ref + (sr - sa));
    }
    if (!isFinite(L) || L <= 0) return null;
    const sp = Math.sqrt(Math.min(Math.max(cur, lo), hi));
    const xPerL = 1 / sp - 1 / sb;      // токена на единицу ликвидности
    const yPerL = sp - sa;              // котировки на единицу ликвидности
    const tokens = L * xPerL;
    return {
      L, sa, sb, lo, hi,
      tokens,
      quote: L * yPerL,                 // долларов ниже цены
      tokenUsd: tokens * cur,           // долларов выше цены, по рынку
      proceeds: L * (sb - sp),          // выручка, если цена дойдёт до верха
    };
  }

  /** Стоимость ступени в долларах при цене p — по той же ликвидности. */
  function rungWorthAt(part, p) {
    const sp = Math.sqrt(Math.min(Math.max(p, part.lo), part.hi));
    return part.L * (1 / sp - 1 / part.sb) * p + part.L * (sp - part.sa);
  }

  const STABLE = /^(usdg|usdc|usdt|dai|usde|pyusd)$/i;

  /**
   * Безубыток всей сумки: при какой цене ступени + фисы + уже собранное
   * вернут вложенное.
   *
   * Вложенное приходит со страницы (стоимость ступеней минус PnL сайта).
   * Фисы в токене дорожают вместе с ценой, в стейбле — нет, собранные уже
   * лежат в долларах. Стоимость сумки с ценой только растёт, поэтому точку
   * ищем делением пополам по логарифму цены.
   */
  function breakEven(L, cur) {
    if (!(cur > 0)) return null;
    const parts = (Array.isArray(L.rungs) ? L.rungs : [])
      .filter((r) => r.filled !== false)
      .map((r) => rungSplit(r, cur))
      .filter(Boolean);
    if (!parts.length) return null;
    // Вложенное выводим из PnL сайта: он = стоимость ступеней + несобранные
    // + собранные фисы − вложенное. Прямо заданное вложенное (L.cost) — для
    // проверок и на будущее.
    const worthNow = parts.reduce((a, x) => a + x.tokenUsd + x.quote, 0);
    const cost = Number(L.cost) > 0 ? Number(L.cost)
      : isFinite(Number(L.pnlSite)) && L.pnlSite !== null && L.pnlSite !== undefined
        ? worthNow + (Number(L.unclaimedUsd) || 0) + (Number(L.claimedUsd) || 0) - Number(L.pnlSite)
        : NaN;
    if (!(cost > 0)) return null;

    let feeTok = Number(L.feeTok) || 0;
    const quotes = Array.isArray(L.feeQuotes) ? L.feeQuotes : [];
    let stable = quotes.filter((q) => STABLE.test(q.symbol || ''))
      .reduce((a, q) => a + (Number(q.amount) || 0), 0);
    const unclaimed = Number(L.unclaimedUsd);
    // Сколько всего несобрано — верим сайту: он пересчитывает после каждого
    // сбора. Из цепи берём только долю токена и стейбла — она решает, как
    // фисы дорожают с ценой. Раньше цепные цифры, прочитанные до сбора,
    // шли в счёт целиком — и уже собранные $113 считались второй раз
    // (TWINE: «PnL с фисами +$36» при PnL сайта −$77).
    const chainUsd = feeTok * cur + stable;
    if (isFinite(unclaimed) && chainUsd > 0) {
      const k = unclaimed / chainUsd;
      feeTok *= k;
      stable *= k;
    }
    let flat;
    if (quotes.length || feeTok) {
      const other = isFinite(unclaimed) ? Math.max(0, unclaimed - feeTok * cur - stable) : 0;
      flat = stable + other;
    } else {
      flat = isFinite(unclaimed) ? unclaimed : 0;
    }
    const claimed = Number(L.claimedUsd) || 0;

    const f = (p) => parts.reduce((a, x) => a + rungWorthAt(x, p), 0) + feeTok * p + flat + claimed - cost;
    const pnl = f(cur);
    let lo = cur;
    let hi = cur;
    if (pnl >= 0) {
      for (let i = 0; i < 40 && f(lo) >= 0; i++) lo /= 2;
      if (f(lo) >= 0) return { pnl, price: null, safe: true };
    } else {
      for (let i = 0; i < 40 && f(hi) < 0; i++) hi *= 2;
      if (f(hi) < 0) return { pnl, price: null, never: true, best: f(hi) };
    }
    for (let i = 0; i < 80; i++) {
      const mid = Math.sqrt(lo * hi);
      if (f(mid) >= 0) hi = mid; else lo = mid;
    }
    return { pnl, price: hi };
  }

  /** Доля выпуска словами: 1.2% / 0.05% / <0.01%. */
  function shareText(n, supply) {
    const share = supply > 0 && n > 0 ? (n / supply) * 100 : 0;
    if (!share) return '';
    return share >= 10 ? share.toFixed(0) + '%'
      : share >= 1 ? share.toFixed(1) + '%'
        : share >= 0.01 ? share.toFixed(2) + '%' : '<0.01%';
  }

  const fmtPx = (v) => (v >= 1 ? '$' + v.toFixed(2)
    : v >= 0.01 ? '$' + v.toFixed(4) : '$' + v.toPrecision(3));
  // PnL со знаком и до доллара: «+$1 204», «−$42».
  const fmtPnl = (v) => (v < 0 ? '−' : '+') + '$' + Math.abs(Math.round(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  /**
   * Сколько токенов у меня лежит и по какой цене.
   *
   * В ступенях выше цены лежит сам токен — он ждёт продажи. Ниже цены лежит
   * котировка, токена там нет. Считаем токены по ступеням выше и рисуем
   * линию на средней цене, взвешенной по деньгам: это уровень, на котором
   * твой мешок в среднем и уйдёт.
   */
  function drawMine(g, L, w, h, yOf, inView, cur, depthW, taken) {
    if (L.sizeOff) return;
    const rungs = Array.isArray(L.rungs) ? L.rungs : [];
    if (!isFinite(cur) || !rungs.length) return;

    let proceeds = 0;
    let tokens = 0;
    for (const r of rungs) {
      if (r.filled === false) continue;
      const part = rungSplit(r, cur);
      if (!part || !(part.tokens > 0)) continue;
      tokens += part.tokens;
      proceeds += part.proceeds;
    }
    if (!(tokens > 0) || !(proceeds > 0)) return;

    // Средняя цена продажи мешка: выручка на весь путь вверх через ступени,
    // делённая на число токенов.
    const avg = proceeds / tokens;
    const y = yOf(avg);
    if (!inView(y)) return;

    const nice = (v) => (v >= 1e9 ? (v / 1e9).toFixed(2) + 'B'
      : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M'
        : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : Math.round(v));
    const price = avg >= 1 ? '$' + avg.toFixed(2)
      : avg >= 0.01 ? '$' + avg.toFixed(4) : '$' + avg.toPrecision(3);
    // Это не цена входа: токен лежит в ступенях выше рынка и ждёт продажи.
    // Подпись обязана говорить именно это, иначе её читают как «средняя
    // покупка» и удивляются, почему она выше цены при плюсовом PnL.
    // Доля выпуска: в штуках «мешок 4.2M» ни о чём не говорит — у одного
    // токена это половина всего выпуска, у другого крошка.
    const supply = Number(L.supply) || 0;
    const pct = shareText(tokens, supply);
    const text = 'мешок ' + nice(tokens) + (pct ? ' · ' + pct + ' саплая' : '')
      + ' · уйдёт по ~' + price;
    // Вторая строка — фисы в штуках: сколько там самого токена (и какая это
    // доля выпуска) и сколько котировки. Сайт показывает только доллары.
    const feeTok = Number(L.feeTok) || 0;
    const quotes = Array.isArray(L.feeQuotes) ? L.feeQuotes : [];
    const bits = [];
    if (feeTok > 0) {
      const fp = shareText(feeTok, supply);
      bits.push(nice(feeTok) + ' ток.' + (fp ? ' (' + fp + ')' : ''));
    }
    for (const q of quotes) {
      const a = Number(q.amount) || 0;
      if (a <= 0) continue;
      bits.push((a >= 100 ? Math.round(a) : a.toFixed(2)) + ' ' + (q.symbol || '?'));
    }
    const text2 = bits.length ? 'в фисах ' + bits.join(' + ') : '';

    g.save();
    g.strokeStyle = '#a78bfa';
    g.lineWidth = 2;
    g.setLineDash([]);
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();

    g.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const tw = Math.max(g.measureText(text).width, text2 ? g.measureText(text2).width : 0) + 12;
    const bh = text2 ? 28 : 14;
    const near = Math.min(depthW + 10, Math.max(8, w - tw - 8));
    const far = Math.max(8, w - tw - 8);
    // Линия тянется во всю ширину, поэтому подпись сперва отодвигаем вбок и
    // только потом под линию: так она остаётся при своей линии.
    const box = place(taken || [], [
      { x: near, y: y - bh - 2, w: tw, h: bh },
      { x: far, y: y - bh - 2, w: tw, h: bh },
      { x: near, y: y + 3, w: tw, h: bh },
      { x: far, y: y + 3, w: tw, h: bh },
    ]);
    g.fillStyle = 'rgba(11, 14, 19, .9)';
    g.fillRect(box.x, box.y, box.w, box.h);
    if (text2) {
      g.fillStyle = 'rgba(203, 213, 225, .95)';
      g.fillText(text2, box.x + 6, box.y + 25);
    }
    g.fillStyle = '#a78bfa';
    g.fillText(text, box.x + 6, box.y + 11);
    g.restore();
  }

  /**
   * Где собирали фисы: точка в момент сбора на цене того момента. Зелёная —
   * сбор фисов, красная — закрытие. Рядом сумма, сколько было собрано.
   */
  /** Причина сбора коротко — чтобы влезла над точкой. */
  function shortWhy(w) {
    const t = String(w || '');
    if (!t) return '';
    if (/руками/.test(t)) return 'руками';
    const pump = /памп \+?(\d+)%/.exec(t);
    if (pump) return 'памп +' + pump[1] + '%';
    if (/накопилось/.test(t)) return 'порог';
    if (/закрываю/.test(t)) return 'тейк-закрытие';
    if (/дошла до/.test(t)) return 'тейк';
    if (/верх|выше диапазона/.test(t)) return 'у верха';
    if (/низ|ниже диапазона/.test(t)) return 'у низа';
    return t.slice(0, 14);
  }

  function drawCollects(g, chart, L, yOf, inView) {
    const list = Array.isArray(L.collects) ? L.collects : [];
    if (!list.length) return;
    g.save();
    g.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (const c of list) {
      const pos = timeToX(chart, Number(c.at));
      // За краем загруженной истории точку не рисуем: прижатая к краю,
      // она показывала бы не то время.
      if (!pos || pos.clamp) continue;
      const y = yOf(Number(c.price));
      if (y === null || !inView(y)) continue;
      const color = c.kind === 'close' ? '#f87171' : '#34d399';
      g.beginPath();
      g.arc(pos.x, y, 4.5, 0, Math.PI * 2);
      g.fillStyle = color;
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(11, 14, 19, .95)';
      g.stroke();
      const why = shortWhy(c.why);
      if (Number(c.usd) > 0 || why) {
        const t = (Number(c.usd) > 0 ? '$' + (c.usd >= 100 ? Math.round(c.usd) : Number(c.usd).toFixed(1)) : '$0')
          + (why ? ' · ' + why : '');
        const tw = g.measureText(t).width;
        g.fillStyle = 'rgba(11, 14, 19, .85)';
        g.fillRect(pos.x - tw / 2 - 3, y - 20, tw + 6, 12);
        g.fillStyle = color;
        g.fillText(t, pos.x - tw / 2, y - 11);
      }
    }
    g.restore();
  }

  /**
   * Линия безубытка всей сумки. Если она за краем графика — пишем её цену
   * у края, чтобы было видно, куда идти.
   */
  function drawBreakEven(g, L, w, h, yOf, inView, cur, depthW, taken) {
    if (L.sizeOff || !isFinite(cur)) return;
    const be = breakEven(L, cur);
    if (!be) return;

    let text;
    if (be.price) {
      const move = (be.price / cur - 1) * 100;
      text = 'БУ ' + fmtPx(be.price) + ' · '
        + (move >= 0 ? 'до него +' + move.toFixed(move >= 10 ? 0 : 1) + '%'
          : 'запас ' + move.toFixed(Math.abs(move) >= 10 ? 0 : 1) + '%')
        + ' · PnL с фисами ' + fmtPnl(be.pnl);
    } else if (be.never) {
      text = 'БУ недостижим: даже на верху ступеней ' + fmtPnl(be.best)
        + ' · PnL с фисами ' + fmtPnl(be.pnl);
    } else {
      text = 'в плюсе при любой цене · PnL с фисами ' + fmtPnl(be.pnl);
    }

    let y = be.price ? yOf(be.price) : NaN;
    const shown = be.price && inView(y);
    // Линия за краем — подпись прижимаем к краю со стрелкой в её сторону.
    if (!shown) {
      const upward = be.price ? be.price > cur : false;
      y = upward ? 22 : h - 30;
      if (be.price) text = (upward ? '↑ ' : '↓ ') + text;
    }

    g.save();
    const color = be.pnl >= 0 ? '#34d399' : '#fbbf24';
    if (shown) {
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
      g.setLineDash([]);
    }
    g.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const tw = g.measureText(text).width + 12;
    const x0 = Math.min(depthW + 10, Math.max(8, w - tw - 8));
    const box = place(taken || [], [
      { x: x0, y: y - 16, w: tw, h: 14 },
      { x: Math.max(8, w - tw - 8), y: y - 16, w: tw, h: 14 },
      { x: x0, y: y + 3, w: tw, h: 14 },
    ]);
    g.fillStyle = 'rgba(11, 14, 19, .92)';
    g.fillRect(box.x, box.y, box.w, box.h);
    g.fillStyle = color;
    g.fillText(text, box.x + 6, box.y + 11);
    g.restore();
  }

  /**
   * Уровни тейка. Зелёный — собрать комиссии, красный — закрыть позиции:
   * разные последствия, и путать их на графике нельзя.
   */
  function drawTakes(g, L, w, h, yOf, inView, taken) {
    if (!Array.isArray(L.takes) || !L.takes.length) return;
    g.save();
    g.setLineDash([7, 4]);
    g.lineWidth = 1.5;
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (const t of L.takes) {
      const y = yOf(t.at);
      if (!inView(y)) continue;
      const color = t.act === 'close' ? 'rgba(248, 113, 113, .95)' : 'rgba(52, 211, 153, .95)';
      g.strokeStyle = color;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();

      const text = (t.act === 'close' ? 'закрыть ' : 'тейк ') + t.label;
      const tw = g.measureText(text).width + 10;
      const box = place(taken || [], [
        { x: 10, y: y - 15, w: tw, h: 14 },
        { x: 10, y: y + 2, w: tw, h: 14 },
        { x: 10 + tw + 6, y: y - 15, w: tw, h: 14 },
      ]);
      g.setLineDash([]);
      g.fillStyle = 'rgba(11, 14, 19, .88)';
      g.fillRect(box.x, box.y, box.w, box.h);
      g.fillStyle = color;
      g.fillText(text, box.x + 5, box.y + 11);
      g.setLineDash([7, 4]);
    }
    g.restore();
  }

  /**
   * Сколько своих денег стоит в диапазоне. Разбивка по текущей цене не
   * украшение: ступени ниже держат котировку и ждут покупки, ступени выше
   * держат токен и ждут продажи, и это разные вещи.
   */
  function drawSize(g, L, w, h, yOf, cur, depthW, taken) {
    if (L.sizeOff) return;
    const rungs = Array.isArray(L.rungs) ? L.rungs : [];
    const live = rungs
      .filter((r) => r.filled !== false && ((typeof r.value === 'number' && r.value > 0) || Number(r.lh) > 0))
      .sort((x, y) => x.lo - y.lo);
    if (!live.length) return;

    // Сумму берём по нынешней цене: у ступеней из памяти сайт показывал её
    // при старой, и «мой сайз» застывал на ней.
    const worth = (r) => {
      const part = isFinite(cur) ? rungSplit(r, cur) : null;
      return part ? part.tokenUsd + part.quote : (Number(r.value) || 0);
    };
    const total = live.reduce((s2, r) => s2 + worth(r), 0);

    // Ступень, внутри которой стоит цена, делится: её нижняя часть держит
    // котировку, верхняя — токен. Делим по формулам пула, а не пропорцией
    // по ширине: доллары внутри ступени лежат неравномерно.
    let below = 0;
    for (const r of live) {
      const part = isFinite(cur) ? rungSplit(r, cur) : null;
      below += part ? part.quote : (isFinite(cur) && r.hi <= cur ? (Number(r.value) || 0) : 0);
    }
    const above = total - below;

    // До доллара, без «K»: округление скрывает как раз то, ради чего смотрят.
    const cash = (v) => '$' + Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

    const under = live.filter((r) => isFinite(cur) && r.hi <= cur).length;
    const over = live.filter((r) => isFinite(cur) && r.lo >= cur).length;
    const atIdx = live.findIndex((r) => isFinite(cur) && cur > r.lo && cur < r.hi);

    const lo = live[0].lo;
    const hi = live[live.length - 1].hi;
    // Где стоим внутри диапазона — в процентах и в самой цене.
    const span = Math.log(hi) - Math.log(lo);
    const at = span > 0 && isFinite(cur)
      ? Math.round(((Math.log(cur) - Math.log(lo)) / span) * 100) : null;

    // На сколько рынок ушёл за край. cur здесь — цена пула лесенки; рынок
    // берём из L.current, он и есть «где торгуется токен».
    const mkGap = () => {
      const mk = Number(L.current);
      if (!(mk > 0)) return '';
      if (mk > hi) return ': рынок на +' + ((mk / hi - 1) * 100).toFixed(0) + '% выше';
      if (mk < lo) return ': рынок на ' + ((1 - mk / lo) * 100).toFixed(0) + '% ниже';
      return ': пул стоит, а рынок внутри леддера';
    };

    const lines = [
      // Ступени могли прийти из памяти, а не с открытой страницы: тогда они
      // запросто не совпадут с тем, что видно в таблице позиций.
      ['600 12px', '#fbbf24', 'мой сайз ' + cash(total) + '   ' + live.length + ' ступ.'
        + (L.fromCache ? '  · из памяти' : '')],
      ['11px', 'rgba(203, 213, 225, .95)',
        'ниже ' + cash(below) + ' (' + under + ' ступ.)   выше ' + cash(above)
        + ' (' + over + ' ступ.)'],
      ['11px', 'rgba(148, 163, 184, .9)',
        atIdx >= 0
          ? 'цена в ступени ' + (atIdx + 1) + ' из ' + live.length
            + (at === null ? '' : ', ' + at + '% диапазона снизу')
          : !isFinite(cur) ? 'цену ещё не прочли — суммы по памяти'
            : cur < lo ? 'НИЖЕ леддера' + mkGap() + ' — всё в токене, фисы не капают'
              : cur > hi ? 'ВЫШЕ леддера' + mkGap() + ' — всё продано в стейбл, фисы не капают'
                : 'цена между ступенями'],
    ];

    let y = (yOf(lo) + yOf(hi)) / 2;
    if (!isFinite(y)) return;
    const boxH = 12 + lines.length * 15;
    y = Math.max(boxH / 2 + 4, Math.min(h - boxH / 2 - 4, y));

    g.save();
    let bw = 0;
    for (const [font, , text] of lines) {
      g.font = font + ' ui-monospace, SFMono-Regular, Menlo, monospace';
      bw = Math.max(bw, g.measureText(text).width);
    }
    bw += 16;
    const x = Math.min(depthW + 10, Math.max(8, w - bw - 8));
    // Коробка сайза самая большая: если она куда-то не влезает, двигаем её,
    // а не мелкие подписи — их сдвиг заметнее.
    const box = place(taken || [], [
      { x, y: y - boxH / 2, w: bw, h: boxH },
      { x, y: Math.max(4, y - boxH / 2 - boxH - 8), w: bw, h: boxH },
      { x, y: Math.min(h - boxH - 4, y + boxH / 2 + 8), w: bw, h: boxH },
    ]);
    const top = box.y;

    g.fillStyle = 'rgba(11, 14, 19, .92)';
    g.fillRect(x, top, bw, boxH);
    g.fillStyle = atIdx >= 0 ? 'rgba(251, 191, 36, .9)' : 'rgba(248, 113, 113, .9)';
    g.fillRect(x, top, 2, boxH);

    let ty = top + 18;
    for (const [font, color, text] of lines) {
      g.font = font + ' ui-monospace, SFMono-Regular, Menlo, monospace';
      g.fillStyle = color;
      g.fillText(text, x + 9, ty);
      ty += 15;
    }
    g.restore();
  }

  /** Подпись о состоянии глубины: молчать нельзя, иначе непонятно, чего ждать. */
  function drawNote(g, L, w, h) {
    // Пул леддера без ликвидности у цены — важнее любой заметки о глубине:
    // это объяснение, почему фисы не капают.
    const dead = L.poolDead
      ? ['rgba(248,113,113,.95)', 'пул твоего леддера пуст у цены: цена в нём улетела в потолок — сделок и фисов нет']
      : null;
    if (L.depthOff && !dead) return;
    const note = dead || (L.depthError ? ['rgba(248,113,113,.95)', 'глубина пула: ' + L.depthError]
      : L.needRpc ? ['rgba(148,163,184,.95)', 'глубина пула: укажи RPC сети в настройках (⚙)']
      : L.depthWait ? ['rgba(148,163,184,.8)', 'глубина пула: читаю цепь…']
      : null);
    if (note) {
      g.save();
      g.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      const tw = g.measureText(note[1]).width;
      g.fillStyle = 'rgba(13, 17, 23, .88)';
      g.fillRect(8, h - 26, tw + 14, 18);
      g.fillStyle = note[0];
      g.fillText(note[1], 15, h - 13);
      g.restore();
    }
  }

  function fmtLevel(v) {
    if (!isFinite(v)) return '—';
    if (v >= 1) return v.toFixed(4);
    return v.toPrecision(3);
  }

  /**
   * Линия входа: горизонталь на уровне средней цены, от момента покупки
   * вправо (или через весь график, если так настроено). Толщина — по доле
   * supply, чтобы кит читался с одного взгляда.
   */
  function drawEntryLine(g, item, width, isSelected, isHovered) {
    const { x, y, holder, clamp, exitX } = item;
    const color = colorForPercent(holder.percent);
    const active = isSelected || isHovered;

    const x1 = state.config.fullWidthLines ? 0 : x;
    const x2 = exitX !== null && exitX !== undefined ? exitX : width;

    g.save();
    g.strokeStyle = color;
    g.globalAlpha = clamp ? 0.35 : (active ? 1 : 0.7);
    g.lineWidth = active ? 2 : Math.max(1, Math.min(3, 0.8 + holder.percent));

    if (!active) g.setLineDash(holder.exited ? [2, 3] : [6, 4]);
    g.beginPath();
    g.moveTo(Math.min(x1, x2), y);
    g.lineTo(Math.max(x1, x2), y);
    g.stroke();
    g.setLineDash([]);

    // Засечка в самой точке входа — где именно он зашёл
    g.globalAlpha = clamp ? 0.5 : 1;
    g.lineWidth = active ? 3 : 2;
    g.beginPath();
    g.moveTo(x, y - 5);
    g.lineTo(x, y + 5);
    g.stroke();

    if (active || holder.percent >= 0.5) {
      const label = `${holder.percent.toFixed(2)}%`;
      g.globalAlpha = 1;
      g.font = '600 10px ui-monospace,SFMono-Regular,Menlo,monospace';
      const tw = g.measureText(label).width;
      const lx = Math.min(x + 6, width - tw - 10);

      g.fillStyle = 'rgba(12,14,20,.85)';
      g.fillRect(lx - 2, y - 14, tw + 6, 13);
      g.fillStyle = color;
      g.fillText(label, lx + 1, y - 4);
    }

    g.restore();
  }

  function render() {
    const chart = getChart();
    if (!chart) return;

    const { canvas, tooltip } = ensureOverlay(chart);
    const { w, h, dpr } = syncOverlaySize(chart, canvas);
    const g = canvas.getContext('2d');

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const mult = supplyMultiplier(chart);
    drawLevels(g, chart, w, h, mult);

    state.visible = [];
    if (!state.config.enabled || !state.holders.length) {
      tooltip.style.display = 'none';
      return;
    }

    const cfg = state.config;

    const items = [];
    let outOfHistory = 0;

    for (const holder of state.holders) {
      if (holder.percent < cfg.minPercent || holder.percent > cfg.maxPercent) continue;
      if (cfg.onlyHolding && holder.balance <= 0 && !holder.exited) continue;
      if (!holder.entryAt || !holder.avgCost) continue;

      const pos = timeToX(chart, holder.entryAt);
      const y = priceToY(chart, holder.avgCost * mult);
      if (!pos || y === null) continue;

      // Вход раньше загруженной истории — прижимаем к левому краю пане
      const x = pos.clamp === 'left' ? Math.max(2, pos.x) : pos.x;
      if (pos.clamp === 'left') outOfHistory += 1;

      if (y < -40 || y > h + 40) continue;
      if (x > w + 40) continue;

      // Вышедшие обрываем на моменте выхода, остальные тянем до правого края
      let exitX = null;
      if (holder.balance <= 0 && holder.exitAt) {
        const ep = timeToX(chart, holder.exitAt);
        if (ep) exitX = ep.x;
      }

      items.push({ x, y, holder, clamp: pos.clamp, exitX });
    }

    if (outOfHistory !== state.outOfHistory) {
      state.outOfHistory = outOfHistory;
      pushState();
    }

    // Крупные рисуются последними, чтобы не тонуть под мелочью
    items.sort((a, b) => a.holder.percent - b.holder.percent);
    state.visible = items;

    for (const item of items) {
      drawEntryLine(
        g,
        item,
        w,
        state.selected.has(item.holder.address),
        state.hovered === item.holder.address,
      );
    }
  }

  /* ------------------------------------------------------------------ *
   * 6. Перерисовка
   *
   * TV не даёт стабильного публичного события на зум/скролл, поэтому вместо
   * подписки на приватные сигналы сравниваем дешёвый снимок состояния в rAF.
   * Это переживает смену внутренних имён между версиями библиотеки.
   * ------------------------------------------------------------------ */
  let lastSnapshot = '';
  let rafId = null;

  function snapshot(chart) {
    try {
      const vis = chart.timeScale.visibleBarsStrictRange();
      const range = chart.priceScale.priceRange && chart.priceScale.priceRange();
      return [
        chart.timeScale.barSpacing().toFixed(3),
        vis ? `${vis._firstBar}:${vis._lastBar}` : '-',
        range ? `${range.minValue()}:${range.maxValue()}` : '-',
        chart.canvas.clientWidth,
        chart.canvas.clientHeight,
        chart.series.firstValue(),
        state.holders.length,
        state.selected.size,
        state.hovered || '',
        state.config.enabled ? 1 : 0,
        state.config.minPercent,
        state.config.maxPercent,
        state.config.fullWidthLines ? 1 : 0,
        state.config.onlyHolding ? 1 : 0,
        state.lastUpdate,
      ].join('|');
    } catch {
      return 'err';
    }
  }

  /*
   * Сравнение снимка состояния чарта — не бесплатное: оно лезет в приватные
   * объекты TradingView. Делать это 60 раз в секунду незачем, глазу хватает
   * и двадцати. В фоновой вкладке не делаем вовсе.
   */
  const CHECK_MS = 50;
  let lastCheck = 0;

  function loop() {
    rafId = requestAnimationFrame(loop);
    if (document.hidden) return;

    const now = performance.now();
    if (now - lastCheck < CHECK_MS) return;
    lastCheck = now;

    const chart = getChart();
    if (!chart) return;

    const snap = snapshot(chart);
    if (snap !== lastSnapshot) {
      lastSnapshot = snap;
      render();
    }
  }

  /* ------------------------------------------------------------------ *
   * 7. Наведение на маркер
   * ------------------------------------------------------------------ */
  function shortAddr(a) {
    return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '';
  }

  function fmtUsd(v) {
    const n = Math.abs(v);
    if (n >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
    if (n >= 1) return `$${v.toFixed(2)}`;
    return `$${v.toPrecision(3)}`;
  }

  let hoverBound = null;

  function bindHover(chart) {
    if (hoverBound === chart.canvas) return;
    hoverBound = chart.canvas;

    const { tooltip } = ensureOverlay(chart);

    chart.canvas.addEventListener('mousemove', (e) => {
      if (!state.config.enabled || !state.visible.length) return;
      const rect = chart.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Попадание по линии: рядом по вертикали и в пределах её отрезка
      let best = null;
      let bestDist = 5;
      for (const item of state.visible) {
        const x1 = state.config.fullWidthLines ? 0 : item.x;
        const x2 = item.exitX !== null && item.exitX !== undefined
          ? item.exitX
          : chart.canvas.clientWidth;
        if (mx < Math.min(x1, x2) - 3 || mx > Math.max(x1, x2) + 3) continue;

        const d = Math.abs(item.y - my);
        if (d < bestDist) { bestDist = d; best = item; }
      }

      const nextHover = best ? best.holder.address : null;
      if (nextHover !== state.hovered) state.hovered = nextHover;

      if (!best) { tooltip.style.display = 'none'; return; }

      const hd = best.holder;
      const when = hd.entryAt ? new Date(hd.entryAt * 1000).toLocaleString() : '—';
      const pnl = hd.unrealizedProfit;
      const pnlColor = pnl >= 0 ? '#4ade80' : '#f87171';

      const moveLabel = hd.changed === 'sold' ? ' ▼ продал'
        : hd.changed === 'bought' ? ' ▲ докупил'
        : hd.changed === 'exited' ? ' ✕ вышел'
        : '';

      tooltip.innerHTML =
        `<div style="color:${colorForPercent(hd.percent)};font-weight:600">` +
        `${hd.percent.toFixed(2)}% supply${moveLabel}</div>` +
        `<div style="opacity:.75">${shortAddr(hd.address)}${hd.tag ? ' · ' + hd.tag : ''}</div>` +
        `<div>вход: ${fmtUsd(hd.avgCost)}${hd.entryIsDerived ? ' <span style="opacity:.6">(расч.)</span>' : ''}</div>` +
        `<div style="opacity:.75">${when}</div>` +
        `<div>держит: ${fmtUsd(hd.usdValue)}</div>` +
        `<div style="color:${pnlColor}">unrealized: ${fmtUsd(pnl)}</div>`;

      tooltip.style.display = 'block';
      const ox = chart.canvas.offsetLeft;
      const oy = chart.canvas.offsetTop;
      tooltip.style.left = Math.min(mx + ox + 14, chart.canvas.clientWidth + ox - 190) + 'px';
      tooltip.style.top = Math.max(oy + 4, my + oy - 70) + 'px';
    });

    chart.canvas.addEventListener('mouseleave', () => {
      state.hovered = null;
      tooltip.style.display = 'none';
    });
  }

  /* ------------------------------------------------------------------ *
   * 8. Загрузка данных и общение с панелью
   * ------------------------------------------------------------------ */
  function post(payload) {
    window.postMessage({ __gho: true, dir: 'from-page', ...payload }, location.origin);
  }

  /**
   * Числа из шапки GMGN: ликвидность и суточный объём. Они там уже посчитаны,
   * а нам нужны, чтобы показать отдачу пула — сколько он возвращает за сутки
   * относительно вложенного. Свою ликвидность считаем сами по цепи, у GMGN
   * берём только объём: его из цепи пришлось бы собирать по логам свопов.
   */
  function headStats() {
    const money = /^[$\s]*[\d][\d\s.,]*[KMB]?$/;
    const leaves = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length || el.offsetParent === null) continue;
      const t = (el.textContent || '').trim();
      if (t) leaves.push(t);
    }
    // Подпись и значение стоят рядом, но порядок у колонок разный: значение
    // бывает и после подписи, и до неё. Смотрим в обе стороны.
    const near = (labels) => {
      for (let i = 0; i < leaves.length; i++) {
        if (!labels.some((l) => leaves[i] === l)) continue;
        for (const k of [i + 1, i - 1, i + 2]) {
          if (k >= 0 && k < leaves.length && money.test(leaves[k])) return leaves[k];
        }
      }
      return null;
    };
    const out = {
      volume24: near(['24h Объём', '24h Volume', '24ч Объём']),
      liquidity: near(['Ликвидность', 'Liquidity']),
    };
    return out.volume24 || out.liquidity ? out : null;
  }

  function pushState() {
    post({
      type: 'state',
      ctx: state.ctx,
      tokenInfo: state.tokenInfo
        ? { symbol: state.tokenInfo.symbol, supply: Number(state.tokenInfo.circulating_supply) || 0 }
        : null,
      holders: state.holders,
      config: state.config,
      loading: state.loading,
      error: state.error,
      outOfHistory: state.outOfHistory,
      lastUpdate: state.lastUpdate,
      head: headStats(),
    });
  }

  const CHANGE_TTL_MS = 12000;   // сколько держим пометку "продал/докупил"
  const EXITED_TTL_MS = 20000;   // сколько показываем полностью вышедших

  /**
   * Сравнивает свежую выдачу с предыдущей и проставляет пометки движения.
   * Полностью вышедших (пропали из выдачи или обнулили баланс) не выбрасываем
   * сразу, а держим EXITED_TTL_MS — иначе продажа выглядит просто как исчезновение
   * строки, и понять, что произошло, нельзя.
   */
  function mergeHolders(prev, next) {
    const now = Date.now();
    const prevMap = new Map(prev.map((h) => [h.address, h]));
    const nextMap = new Map(next.map((h) => [h.address, h]));

    for (const h of next) {
      const before = prevMap.get(h.address);

      if (!before) {
        // "новый" помечаем только если это не первая загрузка
        h.changed = prev.length ? 'new' : null;
        h.changedAt = now;
        h.deltaPct = 0;
        continue;
      }

      const was = before.balance;
      const isNow = h.balance;

      if (was > 0 && isNow <= 0) {
        h.changed = 'exited';
        h.changedAt = now;
        h.deltaPct = -100;
      } else if (was > 0 && isNow < was * 0.999) {
        h.changed = 'sold';
        h.changedAt = now;
        h.deltaPct = (isNow / was - 1) * 100;
      } else if (was > 0 && isNow > was * 1.001) {
        h.changed = 'bought';
        h.changedAt = now;
        h.deltaPct = (isNow / was - 1) * 100;
      } else {
        // движения нет — донашиваем прошлую пометку, пока не истечёт
        const fresh = before.changedAt && now - before.changedAt < CHANGE_TTL_MS;
        h.changed = fresh ? before.changed : null;
        h.changedAt = before.changedAt;
        h.deltaPct = fresh ? before.deltaPct : 0;
      }
    }

    // Те, кто исчез из выдачи целиком
    const merged = next.slice();
    for (const before of prev) {
      if (nextMap.has(before.address)) continue;
      if (before.balance <= 0 && before.changedAt && now - before.changedAt > EXITED_TTL_MS) continue;

      merged.push({
        ...before,
        balance: 0,
        percent: 0,
        exited: true,
        changed: 'exited',
        changedAt: before.changed === 'exited' ? before.changedAt : now,
        deltaPct: -100,
      });
    }

    return merged.filter((h) => {
      if (!h.exited) return true;
      return h.changedAt && now - h.changedAt < EXITED_TTL_MS;
    });
  }

  async function load(force = false, silent = false) {
    if (INFRAME && !state.config.frameHolders) {
      state.ctx = ctxFromLocation();
      state.holders = [];
      pushState();
      return;
    }
    const ctx = ctxFromLocation();
    if (!ctx) {
      state.ctx = null;
      state.holders = [];
      state.tokenInfo = null;
      pushState();
      return;
    }

    const same = state.ctx && state.ctx.chain === ctx.chain && state.ctx.token === ctx.token;
    if (same && !force && state.holders.length) return;

    state.ctx = ctx;
    if (!silent) {
      state.loading = true;
      state.error = null;
    }
    if (!same) { state.holders = []; state.selected.clear(); }
    if (!silent) pushState();

    try {
      const needInfo = !same || !state.tokenInfo;
      const [info, raw] = await Promise.all([
        needInfo ? fetchTokenInfo(ctx).catch(() => null) : Promise.resolve(state.tokenInfo),
        fetchHolders(ctx, state.config.limit),
      ]);

      state.tokenInfo = info;
      const supply = Number(info?.circulating_supply) || Number(info?.total_supply) || 0;
      const fresh = normalizeHolders(raw, supply)
        .sort((a, b) => b.percent - a.percent)
        .slice(0, state.config.limit);

      state.holders = mergeHolders(same ? state.holders : [], fresh);
      state.lastUpdate = Date.now();
      state.error = null;
    } catch (err) {
      // На тихом обновлении не рушим уже показанные данные из-за одного сбоя
      if (!silent) {
        state.error = String(err.message || err);
        state.holders = [];
      }
    } finally {
      state.loading = false;
      lastSnapshot = '';
      pushState();
    }
  }

  /* ------------------------------------------------------------------ *
   * 8b. Автообновление
   *
   * Поллинг, а не WebSocket: формат сокета GMGN недокументирован и меняется,
   * а обычный опрос того же эндпоинта переживает редизайн сайта.
   * ------------------------------------------------------------------ */
  let pollTimer = null;

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (INFRAME && !state.config.frameHolders) return;
    if (!state.config.autoRefresh) return;

    let sec = Math.max(3, Math.min(120, Number(state.config.refreshSec) || 6));
    if (INFRAME) sec = Math.max(FRAME_MIN_SEC, sec);
    pollTimer = setTimeout(async () => {
      // В фоновой вкладке не дёргаем API впустую
      if (!document.hidden && state.ctx && !state.loading) {
        await load(true, true);
      }
      schedulePoll();
    }, sec * 1000);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.config.autoRefresh && state.ctx) load(true, true);
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__gho !== true || d.dir !== 'to-page') return;

    switch (d.type) {
      case 'hello':
        pushState();
        load();
        break;
      case 'refresh':
        load(true);
        break;
      case 'config':
        Object.assign(state.config, d.config || {});
        lastSnapshot = '';
        schedulePoll();
        pushState();
        break;
      case 'select': {
        const addr = d.address;
        if (!addr) state.selected.clear();
        else if (state.selected.has(addr)) state.selected.delete(addr);
        else state.selected.add(addr);
        lastSnapshot = '';
        break;
      }
      case 'hover':
        state.hovered = d.address || null;
        lastSnapshot = '';
        break;
      case 'levels':
        state.levels = d.levels || null;
        lastSnapshot = '';
        break;
    }
  });

  /* ------------------------------------------------------------------ *
   * 9. Старт + реакция на SPA-навигацию
   * ------------------------------------------------------------------ */
  let lastPath = location.pathname + location.search;

  setInterval(() => {
    const now = location.pathname + location.search;
    if (now !== lastPath) {
      lastPath = now;
      load();
    }
    const chart = getChart();
    if (chart) bindHover(chart);
  }, 700);

  loop();
  load();
  schedulePoll();
  pushState();
})();
