// Liquidity Ladder -> GMGN chart overlay.
// Плавающее окно с графиком GMGN поверх liquidityladder.it.com.
// Токен и чейн берём из ссылок на GMGN, которые сайт рисует сам у каждого леддера.
(() => {
  'use strict';

  // Защита от повторного внедрения. Без неё на кнопки вешалось по два
  // обработчика, клик переключал состояние дважды — и меню не закрывалось.
  if (window.__LLC_OVERLAY__) return;
  window.__LLC_OVERLAY__ = true;

  // Журнал: пишем сюда всё, из-за чего дело не сделалось. Без него ошибку во
  // вкладке сторожа никто не видит — она фоновая. Нет журнала (старый
  // манифест или тесты) — работаем молча, но не падаем.
  const NOLOG = { info() {}, warn() {}, err() {} };
  const LOG = (typeof window !== 'undefined' && window.GHO_LOG)
    ? window.GHO_LOG.use('overlay').catchAll().at('overlay') : NOLOG;

  const KEY = 'llChart';
  const PKEY = 'llPairs';     // леддеры, как их отдаёт сам сайт
  const RKEY = 'llRungs';     // ступени по токенам: таблица позиций видна не всегда
  // Перед адресом бывает рефкод: /robinhood/token/LbosYDck_0x462d…
  const LINK_RE = /^https:\/\/gmgn\.ai\/([a-z0-9_-]+)\/token\/(?:[A-Za-z0-9]+_)?(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})/;
  const MAX_TABS = 6;      // сколько вкладок держим в шапке
  const KEEP_ALIVE = 2;    // сколько iframe оставляем загруженными (остальные выгружаем)
  const CLIMB = 12;        // на сколько уровней вверх от клика ищем карточку пула

  const DEFAULTS = {
    open: false,
    min: false,
    menu: false,     // раскрыты ли настройки
    more: false,     // раскрыта ли техническая мелочь внутри них
    follow: true,     // переключать график по клику на пул/леддер
    intercept: true,  // клик по иконке GMGN у леддера открывает оверлей, а не вкладку
    crop: true,       // прятать шапку и правую панель GMGN
    panel: true,      // боковой список холдеров внутри окна
    dodge: true,      // прятать окно по клику мимо него
    mine: true,       // ступени леддера заливкой
    mineSet: false,   // трогал ли пользователь эту галку сам
    bounds: true,     // внешние границы леддера
    depthOn: true,    // синие полосы глубины пула
    addedOnly: false, // только та ликвидность, что завели руками (без пула лаунчпада)
    autoLoad: true,   // подтягивать все леддеры того токена, который открыли сами
    calmed: false,    // выключали ли уже принудительно то, что лезло на страницу
    sizeOn: true,     // подпись «мой сайз» на графике
    watchOn: false,   // главный выключатель сторожа: это действие с деньгами
    pumpOn: false,    // включать отдельно
    feesOn: false,    // включать отдельно: это трата газа без спроса
    feesSec: 60,      // как часто спрашивать размер комиссий
    keepTabs: true,   // держать по фоновой вкладке на каждый открытый леддер
    maxTabs: 0,       // предел своих вкладок; 0 — по вкладке на каждый токен
    tabsFree: false,  // снимали ли уже старый предел в 6 вкладок
    pumpPct: 50,      // на сколько вырастет цена
    windowMin: 5,     // за сколько минут
    minUsd: 5,        // ниже этой суммы фисы не собираем; 0 — собирать любые
    retryTimes: 3,    // сколько раз пробовать, если транзакция не прошла
    slipStep: 0,      // на сколько поднимать проскальзывание на повторе, %; 0 — не трогать
    quietSec: 60,     // как часто ходить на страницу, пока повод держится, секунд
    everySec: 5,      // как часто спрашиваем цену
    edgeOn: false,    // включать отдельно
    edgePct: 5,       // за сколько процентов до границы считать «край»
    fadePct: 5,       // насколько цене позволено откатиться от пика
    edgeShift: -10,   // на сколько процентов сместить уровень от края ступени
    edgeAct: 'fees',  // что делать на крае: собрать фисы или закрыть позиции
    edgeHi: false,    // автосбор у верхней границы — своя галка, выключен
    edgeSplit: false, // перенесли ли старую общую галку «у края» на две отдельные
    edgeLo: false,    // за нижней — нет: внизу собирать смысла нет
    watchSkip: [],    // леддеры, на которых сторож молчит: «сеть:id»
    takeLevels: {},   // ручные уровни тейка: «сеть:адрес» -> [цены]
    takeGone: {},     // с какого момента у токена с тейком нет леддера: «сеть:адрес» -> время
    tokenPump: {},    // свои условия пампа по токену: «сеть:адрес» -> {pumpPct,windowMin,fadePct}
    depthThin: true,  // глубина тонкими штрихами, а не залитыми полосами
    nearPct: 25,      // что считать «у цены»: сколько процентов в обе стороны
    depthSec: 90,     // как часто пересчитывать глубину пула
    holders: true,    // линии входа топ-холдеров внутри окна
    zoom: 0.6,
    geom: null,
    tabs: [],
    active: null,
  };

  let S = { ...DEFAULTS };
  let ui = null;              // { host, root, ...узлы }
  let lui = null;             // ярлык, которым окно поднимается обратно
  let pairs = [];             // все леддеры пользователя из ответа сайта
  let rungCache = {};         // токен -> последние известные ступени
  // Запомненные ступени нужны, когда таблицы позиций не видно. Но вечными им
  // быть нельзя: закрыл пул — и он продолжал висеть на графике, пока не
  // откроешь Manage заново.
  const RUNGS_TTL = 15 * 60000;
  let ownClickUntil = 0;      // окно, в котором клики порождены нами самими
  // Пока мы сами жмём кнопки, сайт перерисовывает панель «Fees & PnL», и в
  // середине этого числа в ней неполные. Читать их нельзя: в шапку попадает
  // чужой PnL, а через секунду он сам собой чинится.
  let actingUntil = 0;
  const acting = () => Date.now() < actingUntil;
  const actNow = (ms) => { actingUntil = Math.max(actingUntil, Date.now() + (ms || 20000)); };

  /**
   * Нажать элемент сайта от имени расширения. Такой клик приходит и в наш
   * собственный обработчик «клик мимо окна» — и окно пряталось само, стоило
   * нажать «обновить фисы». Помечаем время, чтобы отличать свои клики.
   */
  function tap(el) {
    ownClickUntil = Date.now() + 2500;
    el.click();
  }
  const frames = new Map();   // key -> { wrap, iframe, used }
  let useTick = 0;

  // Адрес обязан приводиться к нижнему регистру: GMGN отдаёт его в ссылках
  // в смешанном регистре, а сайт и цепь — в нижнем. Без этого один и тот же
  // токен получал два разных ключа, и кэши расходились: ступени лежали под
  // одним, а искали их под другим.
  const keyOf = (t) => t.chain + '/' + String(t.addr).toLowerCase();
  const short = (a) => (a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a);
  const urlOf = (t) => `https://gmgn.ai/${t.chain}/token/${t.addr}`;

  // ---------- storage ----------

  /**
   * Твои леддеры для настроек сторожа.
   *
   * Выключают именно леддер, а не токен: по одному токену их бывает
   * несколько, верх у каждого свой, и клеймить хочется у верха выбранного,
   * а не у самого внешнего из всех.
   */
  // Котировочные валюты: за ними следить незачем, они и есть мерило цены.
  // Список обязан совпадать с тем, что в сервис-воркере, — на это есть тест.
  const QUOTE_ADDRS = {
    robinhood: ['0x5fc5360d0400a0fd4f2af552add042d716f1d168',
                '0x0bd7d308f8e1639fab988df18a8011f41eacad73'],
  };

  /**
   * За какой из двух валют леддера следить. Сайт отдаёт пару в своём
   * порядке: у «RocketFrog/USDG» первым стоит токен, а у «USDG/MARIO» —
   * стейбл. Брать всегда первую нельзя.
   */
  function tokenSide(chain, p) {
    const a = String(p.token0 || '').toLowerCase();
    const b = String(p.token1 || '').toLowerCase();
    const quote = new Set([...(QUOTE_ADDRS[chain] || []),
                           '0x0000000000000000000000000000000000000000']);
    const ok = (x) => x && x !== '0x' && x.length === 42;
    if (ok(a) && !quote.has(a)) return a;
    if (ok(b) && !quote.has(b)) return b;
    return ok(a) ? a : ok(b) ? b : '';
  }

  function ladders() {
    const out = [];
    const seen = new Set();
    for (const p of pairs) {
      const chain = CHAIN_NAME[p.chainId] || 'robinhood';
      const addr = tokenSide(chain, p);
      if (!addr) continue;
      const id = p.group === undefined || p.group === null ? '' : String(p.group);
      const low = String(addr).toLowerCase();
      const key = id ? chain + ':' + id : chain + ':' + low + ':' + p.lo + ':' + p.hi;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, token: chain + ':' + low,
                 label: p.symbols || addr.slice(0, 10) + '…',
                 lo: Number(p.lo), hi: Number(p.hi) });
    }
    return out;
  }

  /** Ключи токенов, за которыми реально следим: нужны для счёта расхода. */
  function watchKeys() {
    const skip = new Set(S.watchSkip || []);
    return [...new Set(ladders().filter((l) => !skip.has(l.key)).map((l) => l.token))];
  }

  /**
   * Закрыл позицию — настройка по этому токену больше ни к чему.
   *
   * Чистим только когда список леддеров непустой: пока сайт его не отдал,
   * пустота означает «ещё не знаем», а не «позиций нет», и вычистить по ней
   * значило бы молча включить сторожа везде.
   */
  /**
   * Тейки закрытых позиций.
   *
   * Токен пропал из списка леддеров — позиций по нему нет, и тейку
   * срабатывать не на чем, а в списке и на графике он висит. Снимаем не
   * сразу: сайт бывает отдаёт список с пропуском, а тейк иногда ставят до
   * того, как открыть позицию. Десять минут без леддера — уровни уходят.
   */
  const TAKE_GRACE = 10 * 60000;

  /** Верхи ступеней токена, какие известны: из цепи или со страницы. */
  function rungTops(key) {
    const chainBox = posFeesCache[key];
    const list = chainBox && Array.isArray(chainBox.rungs) && chainBox.rungs.length
      ? chainBox.rungs
      : (rungCache[key.replace(':', '/')] || {}).rungs || [];
    return list.map((r) => Number(r.hi)).filter((v) => v > 0);
  }

  /**
   * Отметки краёв от прошлых лесенок. Лесенку пересоздали — у ступеней
   * другие верхи, а отметка осталась и срабатывала на пустом месте. Снимаем
   * отметку, если ступени с таким верхом больше нет (сверяем с точностью
   * до 0.5%). Ступени не известны — не трогаем: нечем сверить.
   */
  function pruneStaleEdges(box) {
    let changed = false;
    const next = { ...box };
    for (const [key, list] of Object.entries(box)) {
      const tops = rungTops(key);
      if (!tops.length) continue;
      const keep = list.filter((raw) => {
        const L = asLevel(raw);
        if (L.from === null || !(L.from > 0)) return true;          // вписан руками
        return tops.some((hi) => Math.abs(hi - L.from) / hi < 0.005);
      });
      if (keep.length !== list.length) {
        changed = true;
        if (keep.length) next[key] = keep; else delete next[key];
      }
    }
    return changed ? next : null;
  }

  function pruneTakes() {
    const stale = pruneStaleEdges(S.takeLevels || {});
    if (stale) {
      S.takeLevels = stale;
      takesChanged();
      impulseNote('сняты отметки краёв от прошлых лесенок');
    }
    const box = S.takeLevels || {};
    const live = new Set(ladders().map((l) => l.token));
    const was = S.takeGone || {};
    const gone = {};
    const cut = [];
    const now = Date.now();
    for (const k of Object.keys(box)) {
      if (live.has(k)) continue;                 // леддер есть — всё в порядке
      const since = was[k] || now;
      if (now - since >= TAKE_GRACE) cut.push(k);
      else gone[k] = since;
    }
    const moved = JSON.stringify(gone) !== JSON.stringify(was);
    S.takeGone = gone;
    if (!cut.length) { if (moved) save(); return; }
    const next = { ...box };
    for (const k of cut) delete next[k];
    S.takeLevels = next;
    takesChanged();
    impulseNote('позиции закрыты — снял тейки: '
      + cut.map((k) => k.split(':')[1].slice(0, 8)).join(', '));
  }

  function pruneWatch() {
    pruneTakes();
    if (!pairs.length || !Array.isArray(S.watchSkip) || !S.watchSkip.length) return;
    const live = new Set(ladders().map((l) => l.key));
    const kept = S.watchSkip.filter((k) => live.has(k));
    if (kept.length === S.watchSkip.length) return;
    S.watchSkip = kept;
    save();
    pushWatch();
  }

  /**
   * Список токенов со своей галкой у каждого: сторож нужен не везде.
   *
   * Перерисовываем только когда меняется сам набор. Узлы, которые
   * пересоздаются на каждом проходе, невозможно нажать: нажатие и отпускание
   * попадают в разные элементы — на этих граблях мы уже стояли с кнопками.
   */
  function showTokens() {
    if (!ui || !ui.toks) return;
    const list = ladders();
    const sign = list.map((x) => x.key + '@' + x.hi).join('|');

    if (ui.toks.dataset.sign !== sign) {
      ui.toks.dataset.sign = sign;
      ui.toks.textContent = '';
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'none';
        empty.textContent = 'леддеров пока не видно — зайди на Dashboard';
        ui.toks.append(empty);
      }
      for (const x of list) {
        const label = document.createElement('label');
        label.title = 'Следить за этим леддером: собирать фисы, когда цена дойдёт '
          + 'до верха его диапазона (' + fmtPrice(x.hi) + ')';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.w = x.key;
        const name = document.createElement('span');
        name.textContent = ' ' + x.label;
        const top = document.createElement('span');
        top.className = 'top';
        top.textContent = 'верх ' + fmtPrice(x.hi);
        label.append(box, name, top);
        ui.toks.append(label);
      }
    }
    const skip = new Set(S.watchSkip || []);
    for (const box of ui.toks.querySelectorAll('input[data-w]')) {
      box.checked = !skip.has(box.dataset.w);
    }
  }

  /**
   * Разбор того, что ты вставил в поле уровня.
   *
   * GMGN пишет мелкие цены подстрочником: «0.0₄4523» значит четыре нуля
   * после запятой и потом цифры. Скопировать такое и руками пересчитать в
   * 0.00004523 — гарантированная опечатка, поэтому понимаем оба вида.
   * Капитализацию удобно писать как «140k» или «1.2m».
   */
  const SUBS = { '₀': 0, '₁': 1, '₂': 2, '₃': 3, '₄': 4, '₅': 5, '₆': 6, '₇': 7, '₈': 8, '₉': 9 };

  function parseAmount(text) {
    let t = String(text || '').trim().replace(/\s+/g, '').replace(/,/g, '.').replace(/^\$/, '');
    if (!t) return null;

    // подстрочные нули: 0.0₄4523 и вариант с обычной цифрой — 0.0(4)4523
    const sub = /^0\.0([₀-₉]+|\((\d+)\))(\d+)$/.exec(t);
    if (sub) {
      const zeros = sub[2] !== undefined
        ? Number(sub[2])
        : Number([...sub[1]].map((c) => SUBS[c]).join(''));
      if (!isFinite(zeros)) return null;
      // Подстрочник — это сколько раз повторяется сам ноль, а не сколько их
      // сверх показанного: «0.0₄4523» читается как 0.00004523.
      const v = Number('0.' + '0'.repeat(zeros) + sub[3]);
      return isFinite(v) && v > 0 ? v : null;
    }

    const mult = /([kkкmmмbb])$/i.exec(t);
    let scale = 1;
    if (mult) {
      const c = mult[1].toLowerCase();
      scale = c === 'k' || c === 'к' ? 1e3 : c === 'm' || c === 'м' ? 1e6 : 1e9;
      t = t.slice(0, -1);
    }
    const v = Number(t) * scale;
    return isFinite(v) && v > 0 ? v : null;
  }

  /** Поставить ручной уровень по выбранному токену. */
  function addLevel() {
    if (!ui || !ui.lvltok || !ui.lvlval) return;
    const key = ui.lvltok.value;
    const v = parseAmount(ui.lvlval.value);
    if (!key || !v) { if (ui.lvlval) ui.lvlval.value = ''; return; }
    const unit = ui.lvlunit && ui.lvlunit.value === 'mcap' ? 'mcap' : 'price';
    const act = ui.lvlact && ui.lvlact.value === 'close' ? 'close' : 'fees';

    const box = { ...(S.takeLevels || {}) };
    const list = [...(box[key] || [])].map(asLevel);
    if (!list.some((x) => x.v === v && x.unit === unit && x.act === act)) {
      list.push({ v, unit, act });
    }
    box[key] = list.sort((a, b) => a.v - b.v);
    S.takeLevels = box;
    ui.lvlval.value = '';
    takesChanged();
  }

  /**
   * Прогон вхолостую: то же самое, что делает сторож, но без нажатия.
   * Иначе проверить настройку можно только дождавшись настоящего повода.
   */
  /**
   * Проверка боевого пути автосбора: доступ к их API, свежий список леддеров
   * и что собралось бы прямо сейчас. Ничего не собирает.
   */
  function checkCollect() {
    if (!ui || !ui.state) return;
    ui.state.className = 'note state';
    ui.state.textContent = 'проверяю автосбор…';
    // Версию показываем прямо тут: половина «не работает» — это незагруженная
    // сборка, и выяснять это по тексту сообщений никуда не годится.
    const ver = (() => {
      try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; }
    })();
    try {
      chrome.runtime.sendMessage({ type: 'dryRun', minUsd: S.minUsd }, (r) => {
        if (chrome.runtime.lastError || !r) {
          ui.state.className = 'note state bad';
          ui.state.textContent = 'воркер не ответил — перезагрузи расширение';
          return;
        }
        const money2 = (v) => '$' + (v >= 100 ? Math.round(v) : v.toFixed(2));
        const lines = ['расширение ' + ver];
        if (!r.ok || r.error) {
          lines.push('✗ ' + (r.error || 'не вышло'));
        } else {
          const hrs = r.age === null ? null : Math.round(r.age / 3600000);
          lines.push('✓ доступ к API есть'
            + (r.canCollect ? '' : ', но сам сбор ещё не подсмотрен — собери фисы руками раз')
            + (hrs === null ? '' : ' (подсмотрен ' + (hrs < 1 ? 'меньше часа' : hrs + ' ч') + ' назад)'));
          lines.push('леддеров: ' + r.pairs.length + ', порог ' + money2(r.need));
          for (const p of r.pairs) {
            lines.push('  ' + (p.label || '?') + ' ' + money2(p.usd) + ' — '
              + (p.off ? 'выключен' : p.would ? 'СОБЕРЁТСЯ' : 'ждёт порога'));
          }
          if (!r.pairs.some((p) => p.would)) {
            lines.push('сейчас собирать нечего — это не поломка');
          }
        }
        ui.state.className = 'note state' + (r.error ? ' bad' : '');
        ui.state.textContent = lines.join('\n');
        // Обычное обновление состояния идёт каждые 4 секунды и затирало
        // отчёт почти сразу. Держим его на виду полминуты.
        stateAt = Date.now() + 30000;
        ui.state.dataset.hold = String(Date.now() + 30000);
      });
    } catch (e) {
      ui.state.textContent = 'контекст расширения перезагрузился — обнови страницу';
    }
  }

  function testFire() {
    if (!ui || !ui.lvltok) return;
    const key = ui.lvltok.value;
    if (!key) return;
    const [chain, addr] = key.split(':');
    onImpulse({ chain, addr, label: ui.lvltok.selectedOptions[0]
      ? ui.lvltok.selectedOptions[0].textContent : '',
      reason: 'проверка', minUsd: Number(S.minUsd) || 0, dry: true });
  }

  /** Старые уровни лежали просто числами — подтягиваем их к новому виду. */
  function asLevel(x) {
    if (x && typeof x === 'object') {
      return { v: Number(x.v), unit: x.unit === 'mcap' ? 'mcap' : 'price',
               act: x.act === 'close' ? 'close' : 'fees',
               // откуда взялся: край ступени или вписан руками
               from: x.from === undefined ? null : Number(x.from) };
    }
    return { v: Number(x), unit: 'price', act: 'fees', from: null };
  }

  /**
   * Отметить или снять сразу все края выбранного токена. Отмечать по одному
   * шесть ступеней на каждом из леддеров — мучение.
   */
  function allEdges(on) {
    if (!ui || !ui.lvltok) return;
    const key = ui.lvltok.value;
    const [chain, addr] = (key || '').split(':');
    const box2 = chain && addr
      ? rungCache[chain + '/' + String(addr).toLowerCase()]
      : null;
    const rungs = (box2 && Array.isArray(box2.rungs) ? box2.rungs : [])
      .filter((r) => isFinite(r.hi) && r.hi > 0);
    if (!rungs.length) return;

    const box = { ...(S.takeLevels || {}) };
    let list = [...(box[key] || [])].map(asLevel);
    if (on) {
      const act = S.edgeAct === 'close' ? 'close' : 'fees';
      for (const r of rungs) {
        if (list.some((x) => x.from === r.hi)) continue;
        list.push({ v: edgePrice(r.hi), unit: 'price', act, from: r.hi });
      }
    } else {
      // Снимаем только края: вписанные руками уровни трогать нельзя.
      list = list.filter((x) => x.from === null);
    }
    if (list.length) box[key] = list.sort((a, b) => a.v - b.v);
    else delete box[key];
    S.takeLevels = box;
    takesChanged();
  }

  /** Цена уровня для края ступени с учётом смещения. */
  function edgePrice(hi) {
    const shift = Number(S.edgeShift) || 0;
    const v = hi * (1 + shift / 100);
    return isFinite(v) && v > 0 ? v : hi;
  }

  /**
   * Уровни изменились: сохранить, отдать сторожу и перерисовать график.
   *
   * Последнего шага раньше не было: снятый уровень исчезал из списка, а
   * линия на графике оставалась до ближайшего изменения страницы — и это
   * читалось как «тейк не отменяется».
   */
  function takesChanged() {
    save();
    pushWatch();
    showLevels();
    showEdges();
    domDirty = true;
    pushLevels();
  }

  function dropLevel(key, v, unit, act, from) {
    const box = { ...(S.takeLevels || {}) };
    // Сверяем и происхождение: у края ступени и вписанного руками уровня
    // цена может совпасть, и тогда крестик снимал не тот.
    box[key] = (box[key] || []).map(asLevel).filter((x) => !(
      x.v === v && x.unit === unit && x.act === act
      && (from === undefined || x.from === from)
    ));
    if (!box[key].length) delete box[key];
    S.takeLevels = box;
    takesChanged();
  }

  /** Задать токену свои условия пампа. Пустые поля берутся из общих. */
  function addPump() {
    if (!ui || !ui.pumptok) return;
    const key = ui.pumptok.value;
    if (!key) return;
    const own = {};
    for (const box of ui.pumpin) {
      const v = Number(box.value);
      if (isFinite(v) && box.value !== '') own[box.dataset.p] = v;
      box.value = '';
    }
    if (!Object.keys(own).length) return;
    S.tokenPump = { ...(S.tokenPump || {}), [key]: own };
    save(); pushWatch(); showPumps();
  }

  /**
   * Не собирать на пампе по этому токену. Условия при этом не трогаем: снял
   * запрет — снова действуют его собственные или общие. Остальные поводы
   * (порог, уровни, край леддера) работают как работали.
   */
  function togglePumpOff(key, off) {
    if (!key) return;
    const box = { ...(S.tokenPump || {}) };
    const own = { ...(box[key] || {}) };
    if (off) own.off = true; else delete own.off;
    if (Object.keys(own).length) box[key] = own; else delete box[key];
    S.tokenPump = box;
    save(); pushWatch(); showPumps();
  }

  function dropPump(key) {
    const box = { ...(S.tokenPump || {}) };
    delete box[key];
    S.tokenPump = box;
    save(); pushWatch(); showPumps();
  }

  /** Что задано по токенам — чипами, как и уровни. */
  function showPumps() {
    if (!ui || !ui.pumps) return;
    const toks = tokenChoices();
    fillTokens(ui.pumptok, toks);

    const box = S.tokenPump || {};
    const names = new Map(toks);
    ui.pumps.textContent = '';
    const keys = Object.keys(box);
    if (!keys.length) {
      const empty = document.createElement('span');
      empty.className = 'none';
      empty.textContent = 'у всех общие условия';
      ui.pumps.append(empty);
      return;
    }
    for (const key of keys) {
      const own = box[key] || {};
      const chip = document.createElement('span');
      chip.className = 'chip';
      const parts = [];
      if (own.off) parts.push('памп выкл');
      if (own.pumpPct !== undefined) parts.push('+' + own.pumpPct + '%');
      if (own.windowMin !== undefined) parts.push(own.windowMin + ' мин');
      if (own.fadePct !== undefined) parts.push('откат ' + own.fadePct + '%');
      chip.append(document.createTextNode(
        (names.get(key) || key.split(':')[1].slice(0, 8)) + ' ' + parts.join(' · ')));
      const sw = document.createElement('b');
      sw.className = 'pumpoff';
      sw.textContent = own.off ? '⏻' : '⦸';
      sw.title = own.off ? 'Снова собирать на пампе по этому токену'
        : 'Не собирать на пампе по этому токену';
      sw.addEventListener('click', () => togglePumpOff(key, !own.off));
      chip.append(sw);
      const x = document.createElement('b');
      x.textContent = '×';
      x.title = 'Вернуть общие условия';
      x.addEventListener('click', () => dropPump(key));
      chip.append(x);
      ui.pumps.append(chip);
    }
  }

  /** Список токенов в выпадающем поле — перезаполняем только при изменениях. */
  function fillTokens(node, toks) {
    if (!node) return;
    const sign = toks.map(([k, v]) => k + v).join('|');
    if (node.dataset.sign === sign) return;
    node.dataset.sign = sign;
    node.textContent = '';
    for (const [key, label] of toks) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = label;
      node.append(opt);
    }
  }

  /**
   * Верхние края ступеней выбранного токена.
   *
   * Цена прошла верх ступени — та целиком вышла из диапазона и комиссию
   * больше не собирает. Отметить такой край значит поставить на него обычный
   * уровень: дальше работает та же механика, и он так же виден на графике.
   */
  function showEdges() {
    if (!ui || !ui.edges || !ui.lvltok) return;
    const key = ui.lvltok.value;
    const [chain, addr] = (key || '').split(':');
    const box = chain && addr
      ? rungCache[chain + '/' + String(addr).toLowerCase()]
      : null;
    const rungs = (box && Array.isArray(box.rungs) ? box.rungs : [])
      .filter((r) => isFinite(r.hi) && r.hi > 0)
      .sort((a, b) => b.hi - a.hi);

    const sign = key + '|' + (Number(S.edgeShift) || 0) + '|' + (S.edgeAct || '')
      + '|' + rungs.map((r) => r.hi).join(',');
    if (ui.edges.dataset.sign !== sign) {
      ui.edges.dataset.sign = sign;
      ui.edges.textContent = '';
      if (!rungs.length) {
        const empty = document.createElement('div');
        empty.className = 'none';
        empty.textContent = 'ступени неизвестны — открой Manage по этому токену';
        ui.edges.append(empty);
      }
      for (const r of rungs) {
        const label = document.createElement('label');
        const at = edgePrice(r.hi);
        label.title = (S.edgeAct === 'close' ? 'Закрыть позиции' : 'Собрать фисы')
          + ', когда цена дойдёт до ' + fmtPrice(at)
          + (at === r.hi ? '' : ' (край ' + fmtPrice(r.hi) + ')');
        const box2 = document.createElement('input');
        box2.type = 'checkbox';
        box2.dataset.e = String(r.hi);
        const name = document.createElement('span');
        name.textContent = ' верх ' + fmtPrice(r.hi)
          + (at === r.hi ? '' : ' → ' + fmtPrice(at));
        const side = document.createElement('span');
        side.className = 'side';
        side.textContent = r.side || '';
        label.append(box2, name, side);
        ui.edges.append(label);
      }
    }

    const set = new Set(((S.takeLevels || {})[key] || []).map(asLevel)
      .filter((x) => x.from !== null).map((x) => x.from));
    for (const el of ui.edges.querySelectorAll('input[data-e]')) {
      el.checked = set.has(Number(el.dataset.e));
    }
  }

  /** Уровни и выбор токена под ними. */
  /**
   * Токены для выбора: твои леддеры плюс тот, что сейчас открыт в окне.
   *
   * Одних леддеров мало: уровень часто хочется поставить на токене, куда
   * ещё не заходил — леддера там нет, а тейк уже нужен.
   */
  function tokenChoices() {
    const map = new Map(ladders().map((l) => [l.token, l.label]));
    // Все вкладки окна, а не только текущая: токен часто открываешь заранее,
    // а уровень ставишь потом, уже глядя на другой график.
    for (const t of [...S.tabs, active(), pageToken()]) {
      if (!t || !t.addr) continue;
      const key = t.chain + ':' + String(t.addr).toLowerCase();
      askSymbol(t);
      if (!map.has(key)) map.set(key, t.label || symCache[key] || short(t.addr));
    }
    // Токены, на которых уже стоят уровни, из списка пропадать не должны.
    for (const key of Object.keys(S.takeLevels || {})) {
      if (!map.has(key)) map.set(key, key.split(':')[1].slice(0, 10) + '…');
    }
    return [...map.entries()];
  }

  // За каким токеном поле следовало в прошлый раз. Нужно, чтобы оно шло за
  // открытым графиком, но не перебивало ручной выбор.
  let lvlFollows = null;

  function showLevels() {
    if (!ui || !ui.lvls) return;
    const toks = tokenChoices();

    fillTokens(ui.lvltok, toks);

    // Поле должно показывать тот токен, чей график открыт. Иначе уровень
    // ставится не туда: смотришь MONEY, а лимитка уходит на DOGGO.
    const t = active();
    const want = t ? t.chain + ':' + String(t.addr).toLowerCase() : null;
    if (want && want !== lvlFollows && toks.some(([k]) => k === want)) {
      lvlFollows = want;
      ui.lvltok.value = want;
      if (ui.pumptok) ui.pumptok.value = want;
    }
    if (!ui.lvltok.value && toks.length) ui.lvltok.value = toks[0][0];

    const box = S.takeLevels || {};
    const names = new Map(toks);
    ui.lvls.textContent = '';
    let any = false;
    for (const [key, list] of Object.entries(box)) {
      for (const raw of list) {
        const L = asLevel(raw);
        any = true;
        const chip = document.createElement('span');
        chip.className = 'chip' + (L.act === 'close' ? ' close' : '');
        chip.title = L.act === 'close'
          ? 'Дошли до уровня — закрыть позиции целиком'
          : 'Дошли до уровня — собрать комиссии';
        chip.append(document.createTextNode(
          (names.get(key) || key.split(':')[1].slice(0, 8)) + ' '
          + (L.unit === 'mcap' ? 'мкап ' + fmtBig(L.v) : fmtPrice(L.v))
          + (L.act === 'close' ? ' · закрыть' : '')));
        const x = document.createElement('b');
        x.textContent = '×';
        x.title = 'Убрать уровень';
        x.addEventListener('click', () => dropLevel(key, L.v, L.unit, L.act, L.from));
        chip.append(x);
        ui.lvls.append(chip);
      }
    }
    if (!any) {
      const empty = document.createElement('span');
      empty.className = 'none';
      empty.textContent = 'уровней нет';
      ui.lvls.append(empty);
    }
  }

  /**
   * Уровни тейка по этому токену — в ценах, чтобы график мог их нарисовать.
   * Мкап переводим по числу выпущенных монет; пока оно неизвестно, такой
   * уровень не рисуем, а не гадаем.
   */
  function takesFor(t) {
    if (!t || S.watchOn !== true) return null;
    const key = t.chain + ':' + String(t.addr).toLowerCase();
    const list = (S.takeLevels || {})[key];
    if (!Array.isArray(list) || !list.length) return null;
    const supply = Number(supplyCache[key]) || 0;
    const out = [];
    for (const raw of list) {
      const L = asLevel(raw);
      const at = L.unit === 'mcap' ? (supply > 0 ? L.v / supply : 0) : L.v;
      if (!isFinite(at) || at <= 0) continue;
      out.push({ at, act: L.act,
                 label: L.unit === 'mcap' ? fmtBig(L.v) : fmtPrice(at) });
    }
    return out.length ? out : null;
  }

  /**
   * Символ токена из цепи. У вкладок, открытых с GMGN, подписи взяться
   * неоткуда — в списках вместо названия торчал адрес. Спрашиваем один раз
   * и запоминаем в самой вкладке, чтобы пережило перезагрузку страницы.
   */
  const symCache = {};
  function askSymbol(t) {
    if (!t || !t.addr || t.label) return;
    const key = t.chain + ':' + String(t.addr).toLowerCase();
    if (symCache[key] !== undefined) return;
    symCache[key] = '';
    try {
      chrome.runtime.sendMessage({ type: 'symbol', chain: t.chain, addr: t.addr }, (r) => {
        if (chrome.runtime.lastError || !r || !r.ok || !r.symbol) return;
        symCache[key] = r.symbol;
        let touched = false;
        for (const tab of S.tabs) {
          if (tab.label) continue;
          if (tab.chain + ':' + String(tab.addr).toLowerCase() !== key) continue;
          tab.label = r.symbol;
          touched = true;
        }
        if (touched) save();
        render();
      });
    } catch (e) { /* контекст расширения перезагрузили */ }
  }

  /** Выпуск токена: нужен, чтобы нарисовать уровни, заданные в мкапе. */
  const supplyCache = {};
  const supplyAskedAt = {};
  function askSupply(t) {
    if (!t) return;
    const key = t.chain + ':' + String(t.addr).toLowerCase();
    if (supplyCache[key] > 0) return;
    // Неудачный запрос раньше оставлял ноль навсегда. Теперь повторяем, но
    // не чаще раза в минуту: узел мог просто моргнуть.
    if (Date.now() - (supplyAskedAt[key] || 0) < 60000) return;
    supplyAskedAt[key] = Date.now();
    supplyCache[key] = 0;
    try {
      chrome.runtime.sendMessage({ type: 'supply', chain: t.chain, addr: t.addr }, (r) => {
        if (chrome.runtime.lastError || !r || !r.ok) return;
        supplyCache[key] = r.supply || 0;
        domDirty = true;
        pushLevels();
      });
    } catch (e) { /* контекст расширения перезагрузили */ }
  }

  /**
   * Фисы позиций в штуках: сколько там токена и сколько стейбла. Сайт
   * показывает только сумму в долларах, а для подписи «в фисах N токенов
   * + $X стейбла» и для безубытка нужно именно это. Читается из цепи,
   * поэтому не чаще раза в 3 минуты на токен.
   */
  const posFeesCache = {};
  function askPosFees(t) {
    if (!t) return;
    const key = t.chain + ':' + String(t.addr).toLowerCase();
    const box = posFeesCache[key];
    if (box && Date.now() - box.at < 3 * 60000) return;
    const ids = mergeIds(idSetsFor(t));
    if (!ids.length) return;
    const fresh = !!(box && box.stale);
    posFeesCache[key] = { ...(box || {}), at: Date.now(), stale: false };
    try {
      chrome.runtime.sendMessage({ type: 'posFees', chain: t.chain, ids, token: t.addr, fresh }, (r) => {
        if (chrome.runtime.lastError || !r || !r.ok) return;
        posFeesCache[key] = { at: Date.now(), token: r.token, quotes: r.quotes || [],
                              rungs: Array.isArray(r.rungs) ? r.rungs : [], pool: r.pool || null };
        domDirty = true;
        pushLevels();
      });
    } catch (e) { /* контекст расширения перезагрузили */ }
  }

  /*
   * Точки сборов на графике. Каждый прошедший сбор (и твой руками, и
   * сторожа) запоминаем: когда, по какой цене и сколько фисов было. Живёт
   * в хранилище, общем для вкладок, по 300 последних на токен.
   */
  const CKEY = 'llCollects';
  let collects = {};
  let collectSnap = null;
  // Почему идёт сбор, если его начал сторож. Пусто — значит, нажали руками.
  let collectWhy = '';

  /**
   * Фисы и PnL токена — из одного источника для всех: шапки, точек сборов и
   * безубытка. Панель «Fees & PnL» — свежие числа после «Update Fees», но
   * она одна на страницу и относится к токену, загруженному в Manage.
   * Карточка дашборда — число с бэкенда сайта, и оно врёт: у TWINE там
   * было $0.35 при $44 в панели. Поэтому панель — всегда первой.
   */
  function feeNumbers(t) {
    if (!t) return null;
    const onPage = pageToken();
    const same = !!(onPage && String(onPage.addr).toLowerCase() === String(t.addr).toLowerCase()
      && onPage.chain === t.chain);
    const sum = same ? readSummary() : null;
    if (sum && (sum.unclaimed || sum.pnl)) {
      const num = (x) => (x ? moneyOf(x) : null);
      return { unclaimed: num(sum.unclaimed), claimed: num(sum.claimed), pnl: num(sum.pnl), from: 'panel' };
    }
    const f = readFees(t);
    const p = readPnl(t);
    if (!f && !p) return null;
    return { unclaimed: f ? f.unclaimed : null, claimed: f ? f.claimed : null,
             pnl: p ? p.usd : null, from: 'card' };
  }

  function snapCollect() {
    const t = pageToken() || active();
    if (!t) return null;
    const lv = readLevels(t);
    const price = lv && Number(lv.current) > 0 ? Number(lv.current) : 0;
    const nums = feeNumbers(t);
    const usd = nums ? nums.unclaimed : null;
    return { key: t.chain + ':' + String(t.addr).toLowerCase(), price, usd, at: Date.now(),
             why: collectWhy || 'руками' };
  }

  function noteCollect(kind, at) {
    const snap = collectSnap;
    collectSnap = null;
    // Снимок старше двух минут — это уже не про этот сбор.
    if (!snap || !snap.price || Date.now() - snap.at > 120000) return;
    const list = [...(collects[snap.key] || [])];
    list.push({ at: Math.round((at || Date.now()) / 1000), price: snap.price,
                usd: snap.usd, kind: kind === 'close' ? 'close' : 'fees', why: snap.why });
    collects = { ...collects, [snap.key]: list.slice(-300) };
    // Фисы в штуках, прочитанные до сбора, теперь врут: они уже в «собрано».
    // Помечаем устаревшими — следующий запрос пойдёт в цепь мимо памяти.
    if (posFeesCache[snap.key]) posFeesCache[snap.key] = { ...posFeesCache[snap.key], at: 0, stale: true, token: 0, quotes: [] };
    try { chrome.storage.local.set({ [CKEY]: collects }); } catch (e) { /* контекст ушёл */ }
    domDirty = true;
    pushLevels();
  }

  /**
   * Границы из списка сайта могут прийти перевёрнутыми — у пар, где стейбл
   * стоит первым (USDG/SWARM), сайт волен писать цену стейбла в токене.
   * Сверяем с ценой из цепи: если прямо границы от неё в тысячах раз, а
   * перевёрнутые — рядом, переворачиваем.
   */
  function orientEnvelope(levels) {
    const cur = Number(levels.current);
    if (!(cur > 0) || !Array.isArray(levels.positions)) return;
    const far = (lo, hi) => hi < cur / 1000 || lo > cur * 1000;
    const all = levels.positions;
    if (!all.length || !all.every(([lo, hi]) => far(lo, hi))) return;
    const flip = all.map(([lo, hi]) => [1 / hi, 1 / lo]);
    if (flip.some(([lo, hi]) => !far(lo, hi))) levels.positions = flip;
  }

  // Ликвидность токена по всем пулам — «залили люди / лаунчпад».
  const tvlBox = {};
  function askTvl(t) {
    const key = t.chain + ':' + String(t.addr).toLowerCase();
    const box = tvlBox[key];
    if (!box || Date.now() - box.at > 10 * 60000) {
      tvlBox[key] = { ...(box || {}), at: Date.now() };
      try {
        chrome.runtime.sendMessage({ type: 'tvl', chain: t.chain, addr: t.addr }, (r) => {
          if (chrome.runtime.lastError || !r) return;
          tvlBox[key] = { at: Date.now(), data: r };
          domDirty = true;
          pushLevels();
        });
      } catch (e) { /* контекст расширения перезагрузили */ }
    }
    return box ? box.data : null;
  }

  /** Большое число словами: 140000 -> 140K. */
  function fmtBig(v) {
    if (!isFinite(v) || v <= 0) return '—';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
    return '$' + Math.round(v);
  }

  /** Цена словами: у этих токенов много нулей после запятой. */
  function fmtPrice(v) {
    if (!isFinite(v) || v <= 0) return '—';
    if (v >= 1) return '$' + v.toFixed(2);
    if (v >= 0.01) return '$' + v.toFixed(4);
    return '$' + v.toPrecision(3);
  }

  /**
   * Во что обходится слежка. Считаем честно: все токены читаются одной
   * пачкой, поэтому обращений к узлу столько же, сколько опросов, а вот
   * вызовов внутри них — по числу токенов.
   */
  /**
   * Живое состояние сторожа. Без него «не работает» нечем проверить: молчит
   * он потому, что повода нет, или потому, что вообще не запустился.
   */
  let stateAt = 0;
  function showState() {
    if (!ui || !ui.state) return;
    // Пока держится отчёт проверки, обычное состояние его не перебивает.
    if (Number(ui.state.dataset.hold || 0) > Date.now()) return;
    if (S.watchOn !== true) {
      ui.state.className = 'note state';
      ui.state.textContent = 'сторож выключен — ничего не жмётся';
      return;
    }
    // Прямым текстом, что заряжено: автосбор тратит газ без спроса, и человек
    // должен видеть это, не разбираясь в галках.
    const armed = [];
    if (S.feesOn !== false) armed.push('по порогу $' + (Number(S.minUsd) || 0));
    if (S.pumpOn !== false) armed.push('на пампе');
    if (S.edgeHi === true) armed.push('у верха');
    if (S.edgeLo === true) armed.push('у низа');
    const lvl = Object.values(S.takeLevels || {}).reduce((n, v) => n + (v || []).length, 0);
    if (lvl) armed.push(lvl + ' ручн. уровн.');
    ui.state.dataset.armed = armed.length ? 'СОБИРАЕТ САМ: ' + armed.join(', ') : 'поводов нет — ничего не соберёт';
    if (Date.now() - stateAt < 3000) return;
    stateAt = Date.now();
    try {
      chrome.runtime.sendMessage({ type: 'watchState' }, (r) => {
        if (chrome.runtime.lastError || !ui || !ui.state) return;
        if (!r || !r.ok) {
          ui.state.className = 'note state bad';
          ui.state.textContent = 'сторож не отвечает — перезагрузи расширение';
          return;
        }
        const ago = r.lastRun ? Math.round((Date.now() - r.lastRun) / 1000) : null;
        const names = new Map(tokenChoices());
        const lines = [ui.state.dataset.armed || '', ago === null
          ? 'ещё ни разу не проверял'
          : 'последняя проверка ' + ago + ' с назад'];
        if (r.api === false) {
          lines.push('сбор через API ещё не подсмотрен — собери фисы руками один раз');
        }
        if (r.error) lines.push(r.error);
        // Показываем несколько последних действий, а не одно: когда сбор
        // срабатывает через раз, по одному снимку этого не понять.
        const acts = Array.isArray(r.log) && r.log.length
          ? r.log
          : (r.lastAct ? [r.lastAct] : []);
        if (!acts.length) lines.push('сбора ещё не было');
        // Значок — по тому, что реально случилось, а не по «взялась ли
        // вкладка»: собрала, нажала без подтверждения, ждёт порога.
        const ICON = { collected: '✓', closed: '✓', sent: '?', wait: '⏳', dry: '·',
                       unknown: '?', fail: '✗', refused: '✗' };
        for (const a of acts.slice(0, 4)) {
          const mins = Math.round((Date.now() - a.at) / 60000);
          const icon = ICON[a.did] || (a.wait ? '⏳' : a.ok ? '✓' : '✗');
          lines.push(icon + ' ' + a.what
            + (a.usd ? ' $' + Math.round(a.usd) : '')
            + ' — ' + (a.why || (a.ok ? 'собрал' : 'не вышло'))
            + ' (' + a.how + ', ' + (mins < 1 ? 'только что' : mins + ' мин назад') + ')');
        }
        for (const x of (r.tokens || []).slice(0, 6)) {
          lines.push('  ' + (names.get(x.key) || x.key.split(':')[1].slice(0, 8))
            + ' ' + (x.price ? fmtPrice(x.price) : '—') + ' · ' + (x.note || ''));
        }
        ui.state.className = 'note state' + (r.error || (ago !== null && ago > 90) ? ' bad' : '');
        ui.state.textContent = lines.join('\n');
      });
    } catch (e) { /* контекст расширения перезагрузили */ }
  }

  /**
   * Пульт вкладок. Сбор умеет нажимать только в своей вкладке, поэтому
   * «почему не собралось» почти всегда упирается в них: вкладку закрыли,
   * сайт увёл на вход, предел вкладок кончился. Раньше всё это было
   * невидимым, и оставалось гадать.
   */
  let tabsAt = 0;
  function showTabs(force) {
    if (!ui || !ui.tabsBox) return;
    if (!force && Date.now() - tabsAt < 3000) return;
    tabsAt = Date.now();
    try {
      chrome.runtime.sendMessage({ type: 'tabsState' }, (r) => {
        if (chrome.runtime.lastError || !ui || !ui.tabsBox) return;
        if (!r || !r.ok) {
          ui.tabsBox.className = 'note tabsbox bad';
          ui.tabsBox.textContent = 'вкладки: сторож не отвечает';
          return;
        }
        const rows = r.rows || [];
        const live = rows.filter((x) => x.tabId).length;
        const lines = [];
        if (!r.on) lines.push('свои вкладки выключены — сбор будет искать уже открытые');
        lines.push('вкладки сторожа: ' + live + ' из ' + rows.length
          + (r.cap ? ' (предел ' + r.cap + ')' : ''));
        for (const x of rows.slice(0, 8)) {
          lines.push('  ' + (x.state === 'готова' ? '✓ ' : x.state === 'грузится' ? '· ' : '✗ ')
            + x.label + ' — ' + x.state);
        }
        if (r.trouble) lines.push(r.trouble);
        ui.tabsBox.className = 'note tabsbox'
          + (r.trouble || (rows.length && live < rows.length) ? ' bad' : '');
        ui.tabsBox.textContent = lines.join('\n');
      });
    } catch (e) { /* контекст расширения перезагрузили */ }
  }

  function tabsDo(what) {
    if (!ui || !ui.tabsBox) return;
    ui.tabsBox.className = 'note tabsbox';
    ui.tabsBox.textContent = what === 'tabsOpen' ? 'открываю…' : 'закрываю свои…';
    try {
      chrome.runtime.sendMessage({ type: what }, (r) => {
        if (chrome.runtime.lastError) return;
        if (r && r.ok === false && r.error) {
          ui.tabsBox.className = 'note tabsbox bad';
          ui.tabsBox.textContent = r.error;
          return;
        }
        showTabs(true);
      });
    } catch (e) { /* контекст расширения перезагрузили */ }
  }

  /** Край включён, если отмечена хоть одна из двух галок. Общей больше нет. */
  function edgeArmed() {
    return S.edgeHi === true || S.edgeLo === true;
  }

  function showCost() {
    if (!ui || !ui.cost) return;
    const levelsSet = Object.values(S.takeLevels || {}).some((v) => Array.isArray(v) && v.length);
    const needPrice = S.pumpOn !== false || edgeArmed() || levelsSet;
    if (!needPrice) {
      ui.cost.textContent = 'цена не спрашивается — собираю по порогу, узел не тратится';
      ui.cost.title = 'Ценовые поводы выключены: импульс, край диапазона и ручные уровни. '
        + 'Размер комиссий берётся у самого сайта, запросов к узлу нет.';
      return;
    }
    const every = Math.max(1, Number(S.everySec) || 5);
    // Считаем только те токены, за которыми реально следим: выключенные
    // запросов не создают, и показывать их в расходе — врать.
    const n = watchKeys().length;
    if (!n) {
      ui.cost.textContent = 'ни одного токена не выбрано — сторож молчит';
      ui.cost.title = '';
      return;
    }
    const perDay = Math.round(86400 / every);
    const calls = perDay * n;
    const nice = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + ' млн' : Math.round(v / 1000) + ' тыс.');
    ui.cost.textContent = 'токенов ' + n + ' · ' + nice(perDay) + ' обращений в сутки, '
      + nice(calls) + ' вызовов';
    ui.cost.title = 'Одно обращение к узлу за опрос, сколько бы токенов ни было: '
      + 'они читаются одной пачкой. Внутри обращения — по одному вызову на токен.';
  }

  /** Сторож живёт в сервис-воркере и читает свои настройки из хранилища. */
  function pushWatch() {
    try {
      chrome.storage.local.set({ llWatch: {
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
        edgeOn: edgeArmed(),
        edgePct: Math.max(0, Number(S.edgePct) || 0),
        fadePct: Math.max(0, Number(S.fadePct) || 0),
        edgeHi: S.edgeHi === true,
        edgeLo: S.edgeLo === true,
        skip: Array.isArray(S.watchSkip) ? S.watchSkip : [],
        levels: S.takeLevels && typeof S.takeLevels === 'object' ? S.takeLevels : {},
        pump: S.tokenPump && typeof S.tokenPump === 'object' ? S.tokenPump : {},
      } });
    } catch (e) { /* контекст расширения перезагрузили */ }
  }

  function save() {
    // Список ведётся здесь же и явно: класть в хранилище всё S нельзя — там
    // живут и разобранные ступени, и кэши. Раньше это был длинный разворот
    // с тройными повторами ключей, править его вслепую было нельзя.
    const KEEP = [
      'open', 'min', 'menu', 'more', 'follow', 'intercept', 'crop', 'panel',
      'dodge', 'mine', 'mineSet', 'bounds', 'depthOn', 'addedOnly',
      'autoLoad', 'calmed', 'tabsFree', 'sizeOn', 'watchOn', 'pumpOn', 'feesOn',
      'feesSec', 'keepTabs', 'maxTabs', 'pumpPct', 'windowMin', 'minUsd',
      'quietSec', 'everySec', 'edgeOn', 'edgePct', 'fadePct', 'edgeShift',
      'edgeAct', 'edgeHi', 'edgeLo', 'edgeSplit', 'watchSkip', 'takeLevels', 'takeGone', 'tokenPump',
      'retryTimes', 'slipStep',
      'depthThin', 'nearPct', 'depthSec', 'holders', 'zoom', 'geom', 'tabs',
      'active',
    ];
    const box = {};
    for (const k of KEEP) box[k] = S[k];
    try {
      chrome.storage.local.set({ [KEY]: box });
    } catch (e) { /* контекст расширения перезагрузили */ }
  }

  function load() {
    return loadKey(KEY);
  }

  function loadKey(key) {
    return new Promise((res) => {
      try {
        chrome.storage.local.get(key, (v) => res((v && v[key]) || {}));
      } catch (e) { res({}); }
    });
  }

  /**
   * Забыть запомненные ступени токена и перечитать страницу несколько раз
   * подряд: сайт обновляет таблицу не мгновенно.
   */
  function forgetRungs(t) {
    if (!t) return;
    const k = keyOf(t);
    if (rungCache[k]) {
      delete rungCache[k];
      try { chrome.storage.local.set({ [RKEY]: rungCache }); } catch (e) { /* контекст ушёл */ }
    }
    // Перечитываем с растущим шагом: сайт обновляет таблицу не мгновенно, но
    // десять полных разборов подряд — это заметная нагрузка на страницу.
    let n = 0;
    const again = () => {
      domDirty = true;
      pushLevels();
      if (++n < 6) setTimeout(again, 800 * Math.pow(1.6, n));
    };
    setTimeout(again, 700);
  }

  // ---------- разбор страницы ----------

  // Скрытые ссылки на странице есть всегда: на /manage в DOM висит ещё и
  // невидимая панель леддеров с дашборда. Берём только то, что реально видно.
  const anchors = () => visAnchors();

  function parseLink(a) {
    const href = a.getAttribute('href') || '';
    const m = LINK_RE.exec(href);
    if (!m) return null;
    return { chain: m[1], addr: m[2].toLowerCase(), label: labelFor(a) || short(m[2]) };
  }

  // Имя пары берём только из соседнего листового заголовка (USDG/DOGSHIT),
  // и только из его собственного текста. Раньше регексп шарил по textContent
  // предков и притаскивал мусор вроде «address/tokensLoad».
  const PAIR_RE = /^[A-Za-z0-9$._]{1,14}\s*\/\s*[A-Za-z0-9$._]{1,14}$/;

  function labelFor(a) {
    let node = a.parentElement;
    for (let i = 0; i < 3 && node; i++) {
      for (const el of node.children) {
        if (el === a || el.children.length) continue;
        const txt = (el.textContent || '').trim().replace(/\s+/g, '');
        if (PAIR_RE.test(txt)) return txt;
      }
      node = node.parentElement;
    }
    return null;
  }

  function scan() {
    for (const a of anchors()) {
      const t = parseLink(a);
      if (t) bind(a, t);
    }
  }

  // Ищем токен «того пула, по которому кликнули»: поднимаемся от места клика
  // вверх, пока в поддереве ровно один токен GMGN. Как только их стало больше —
  // значит вышли за пределы карточки в общий список, и угадывать нечего.
  function tokenNear(el) {
    let node = el;
    for (let i = 0; i < CLIMB && node && node !== document.documentElement; i++) {
      if (node.matches && node.matches('a[href^="https://gmgn.ai/"]')) {
        const t = parseLink(node);
        if (t) return t;
      }
      if (node.querySelectorAll) {
        const toks = [];
        for (const a of node.querySelectorAll('a[href^="https://gmgn.ai/"]')) {
          if (a.offsetParent === null) continue;
          const t = parseLink(a);
          if (t && !toks.some((x) => keyOf(x) === keyOf(t))) toks.push(t);
        }
        if (toks.length === 1) return toks[0];
        if (toks.length > 1) return null;
      }
      node = node.parentElement;
    }
    return null;
  }

  function bind(a, t) {
    if (a.dataset.llcBound === '1') {
      a.dataset.llcToken = keyOf(t);
      return;
    }
    a.dataset.llcBound = '1';
    a.dataset.llcToken = keyOf(t);
    a.title = 'GMGN: клик — график поверх сайта, Ctrl/⌘+клик — новая вкладка';
    a.addEventListener('click', (e) => {
      if (!S.intercept || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = parseLink(a) || t;
      openWith(cur, true);
    }, true);
  }

  // ---------- уровни леддера ----------
  //
  // Сайт печатает диапазоны текстом: на дашборде тройка «lo · текущая · hi»
  // под карточкой, в Manage — строка «$lo – $hi» на каждую ступень плюс та же
  // тройка в Range Progress. Читаем именно это: никакого API дёргать не надо,
  // а вёрстка может меняться как угодно, пока числа стоят рядом.

  const NUM = '[0-9]+(?:[.,][0-9]+)?';
  const RE_RANGE = new RegExp('^\\$?(' + NUM + ')\\s*[\\-\\u2010-\\u2015]\\s*\\$?(' + NUM + ')$');
  const RE_NUM = new RegExp('^' + NUM + '$');
  /**
   * Число из текста сайта. Он мешает две записи на одной странице: цены
   * пишет по-английски («0.001776»), а деньги по-русски и с пробелом между
   * тысячами («$1 515,07»). Прежний разбор менял только первую запятую и на
   * таких суммах давал NaN — позиция на полторы тысячи просто пропадала с
   * графика, а сайз считался неполным.
   */
  const toNum = (t) => {
    const raw = String(t).replace(/[\s\u00a0\u202f]/g, '');
    const lastDot = raw.lastIndexOf('.');
    const lastComma = raw.lastIndexOf(',');
    const dec = Math.max(lastDot, lastComma);
    if (dec < 0) return parseFloat(raw);
    // Разделитель дробной части — последний из встреченных, всё до него
    // служит только для группировки разрядов.
    return parseFloat(raw.slice(0, dec).replace(/[.,]/g, '') + '.' + raw.slice(dec + 1));
  };
  // целые числа в этих же местах — это слиппедж и диапазоны ID, не цены
  const isPrice = (v) => isFinite(v) && String(v).includes('.');

  function harvest(root) {
    const ranges = [];
    const trips = [];
    for (const el of root.querySelectorAll('*')) {
      if (!el.children.length) {
        const m = RE_RANGE.exec((el.textContent || '').trim());
        if (m) {
          const a = toNum(m[1]);
          const b = toNum(m[2]);
          if (isPrice(a) && isPrice(b)) ranges.push([Math.min(a, b), Math.max(a, b)]);
        }
        continue;
      }
      const kids = [...el.children];
      if (kids.length !== 3) continue;
      if (!kids.every((c) => !c.children.length && RE_NUM.test((c.textContent || '').trim()))) continue;
      const v = kids.map((c) => toNum(c.textContent.trim()));
      if (v.every(isPrice)) trips.push(v);
    }
    // Середина тройки — цена в пуле. Когда пул улетает в потолок, сайт
    // печатает там «340 256 786 833 063 530 000 000…» — это не число по
    // нашим правилам, и раньше тройка выбрасывалась целиком, а с ней и весь
    // леддер с графика. Края берём, середину помечаем как нечитаемую.
    for (const el of root.querySelectorAll('*')) {
      const kids = [...el.children];
      if (kids.length !== 3 || kids.some((c) => c.children.length)) continue;
      const t = kids.map((c) => (c.textContent || '').trim());
      if (!RE_NUM.test(t[0]) || !RE_NUM.test(t[2])) continue;
      if (RE_NUM.test(t[1]) && isPrice(toNum(t[1]))) continue;      // обычная, уже взята
      if (!/^[0-9][0-9\s\u00a0\u202f.,]{6,}…?$/.test(t[1])) continue;
      const a = toNum(t[0]);
      const b = toNum(t[2]);
      if (isPrice(a) && isPrice(b)) trips.push([a, NaN, b]);
    }
    return { ranges, trips };
  }

  /**
   * Строка позиции целиком: диапазон, вложенная сумма и статус. Нужна, чтобы
   * отличить ступень с ликвидностью от пустой — на графике они красятся
   * по-разному. Сумму ищем, поднимаясь от диапазона вверх до первой строки,
   * где рядом есть денежное значение.
   */
  // Пробел между тысячами — тоже часть суммы: «$1 515,07».
  const RE_MONEY = /^\$([0-9][0-9.,\s\u00a0\u202f]*)$/;
  const RE_STATUS = /^(active|closed|empty|pending|inactive)$/i;
  const RE_SIDE = /^(ask|bid|both)$/i;

  function rowsIn(root) {
    const rows = [];
    for (const el of root.querySelectorAll('*')) {
      if (el.children.length) continue;
      const m = RE_RANGE.exec((el.textContent || '').trim());
      if (!m) continue;
      const a = toNum(m[1]);
      const b = toNum(m[2]);
      if (!isPrice(a) || !isPrice(b)) continue;

      let value = null;
      let status = null;
      let side = null;
      let node = el;
      for (let i = 0; i < 5 && node.parentElement; i++) {
        node = node.parentElement;
        const leaves = [...node.querySelectorAll('*')]
          .filter((x) => !x.children.length)
          .map((x) => (x.textContent || '').trim());
        // «$0.000477» из самого диапазона тоже похоже на сумму — отсекаем
        // всё, что совпадает с границами ступени, иначе пустая позиция
        // считалась залитой и наоборот.
        const money = leaves
          .map((t) => RE_MONEY.exec(t))
          .filter(Boolean)
          .map((m) => toNum(m[1]))
          .filter((v) => v !== a && v !== b);
        if (!money.length) continue;
        value = money[0];
        status = leaves.find((t) => RE_STATUS.test(t)) || null;
        side = (leaves.find((t) => RE_SIDE.test(t)) || '').toLowerCase() || null;
        break;
      }
      rows.push({ lo: Math.min(a, b), hi: Math.max(a, b), value, status, side });
    }
    return rows;
  }

  // ступень считается залитой, пока не доказано обратное: пустой её делает
  // либо нулевая сумма, либо явный статус
  const isFilled = (r) => {
    if (r.status && /^(closed|empty|inactive)$/i.test(r.status)) return false;
    if (r.value === null) return true;
    return r.value > 0;
  };

  // Закрытую позицию на графике держать нельзя — её больше нет
  const isGone = (r) => !!(r.status && /^(closed|empty|inactive)$/i.test(r.status))
    || r.value === 0;

  /**
   * Есть ли в поддереве хоть одно число, похожее на цену. Выходим на первом
   * же попадании: раньше здесь собирался полный урожай на каждом уровне
   * подъёма, то есть страница обходилась по many раз подряд.
   */
  function hasPrices(root) {
    const all = root.querySelectorAll('*');
    if (all.length > 2500) return false;      // поднялись слишком высоко
    for (const el of all) {
      if (el.children.length === 0) {
        const m = RE_RANGE.exec((el.textContent || '').trim());
        if (m && isPrice(toNum(m[1])) && isPrice(toNum(m[2]))) return true;
        continue;
      }
      if (el.children.length !== 3) continue;
      const kids = [...el.children];
      if (!kids.every((c) => !c.children.length && RE_NUM.test((c.textContent || '').trim()))) continue;
      if (kids.every((c) => isPrice(toNum(c.textContent.trim())))) return true;
    }
    return false;
  }

  // Карточка леддера или блок позиций — ближайший предок, где уже есть цифры
  function scopeOf(a) {
    let node = a;
    for (let i = 0; i < 8 && node.parentElement; i++) {
      node = node.parentElement;
      if (hasPrices(node)) return node;
    }
    return null;
  }

  // Области страницы, относящиеся к этому токену. Для уровней берём только
  // видимые: на /manage в DOM висит ещё и скрытая панель леддеров с дашборда.
  // Для фисов скрытая панель, наоборот, единственный источник — в Manage
  // сумм по комиссиям на экране нет.
  // Разбор области — дорогой: scopeOf поднимается вверх и на каждом уровне
  // просматривает всё поддерево. Раньше это делалось заново для уровней,
  // комиссий и PnL — три полных обхода страницы каждые три секунды, отсюда
  // и подтормаживание. Держим результат на секунду.
  let scopeCache = { key: null, at: 0, scopes: null };
  let domDirty = true;        // страница менялась с прошлого разбора

  /*
   * Кеш на один проход. Каждое чтение offsetParent заставляет браузер
   * пересчитать раскладку, а полных выборок по документу за тик набиралось
   * с десяток — отсюда и подтормаживание. Собираем всё один раз.
   */
  let tick = null;

  function openTick() {
    tick = { at: Date.now(), anchors: null, clickables: null, inputs: null };
  }

  const tickFresh = () => tick && Date.now() - tick.at < 300;

  const shown = (el) => el.offsetParent !== null;

  function visAnchors() {
    if (!tickFresh()) openTick();
    if (!tick.anchors) {
      tick.anchors = [...document.querySelectorAll('a[href^="https://gmgn.ai/"]')].filter(shown);
    }
    return tick.anchors;
  }

  function clickables() {
    if (!tickFresh()) openTick();
    if (!tick.clickables) {
      tick.clickables = [...document.querySelectorAll('button, a, [role="button"]')].filter(shown);
    }
    return tick.clickables;
  }

  function visInputs() {
    if (!tickFresh()) openTick();
    if (!tick.inputs) {
      tick.inputs = [...document.querySelectorAll('input')]
        .filter((el) => shown(el) && el.type !== 'checkbox' && el.type !== 'radio');
    }
    return tick.inputs;
  }
  let lastLevels = null;      // что отдали в прошлый раз

  function scopesFor(t, visibleOnly) {
    const key = keyOf(t) + (visibleOnly ? ':v' : ':a');
    const now = Date.now();
    if (scopeCache.key === key && now - scopeCache.at < 1000) return scopeCache.scopes;
    const scopes = computeScopes(t, visibleOnly);
    scopeCache = { key, at: now, scopes };
    return scopes;
  }

  function computeScopes(t, visibleOnly) {
    const k = keyOf(t);
    const list = visibleOnly
      ? anchors()
      : [...document.querySelectorAll('a[href^="https://gmgn.ai/"]')];
    const scopes = [];
    for (const a of list) {
      const p = parseLink(a);
      if (!p || keyOf(p) !== k) continue;
      const sc = scopeOf(a);
      if (sc && !scopes.includes(sc)) scopes.push(sc);
    }
    return scopes;
  }

  /**
   * Токена нет на открытой странице — например, в Manage загружен другой.
   * Раньше график тогда был пустым, хотя ступени лежали в памяти. Берём их
   * оттуда, а нет в памяти — внешние границы леддеров из списка сайта.
   * Текущую цену досыпает pushLevels из цепи.
   */
  const OFFPAGE_TTL = 24 * 3600000;

  /** Ступени из цепи по номерам позиций: точные и не зависят от страницы. */
  function chainRungs(t) {
    const box = posFeesCache[t.chain + ':' + String(t.addr).toLowerCase()];
    const list = box && Array.isArray(box.rungs) ? box.rungs : [];
    return list.length ? list.map((r) => ({ ...r })).sort((a, b) => a.lo - b.lo) : null;
  }

  function offPage(t) {
    const alive = pairsFor(t);
    // Позиции по токену закрыты — старые ступени из памяти не воскрешаем.
    if (pairs.length && !alive.length) return null;
    const fromChain = chainRungs(t);
    if (fromChain) {
      return { positions: fromChain.map((r) => [r.lo, r.hi]), rungs: fromChain,
               current: null, pair: t.label, chain: true };
    }
    const cached = rungCache[keyOf(t)];
    if (cached && Array.isArray(cached.rungs) && cached.rungs.length
        && Date.now() - (cached.savedAt || 0) <= OFFPAGE_TTL) {
      return { positions: cached.rungs.map((r) => [r.lo, r.hi]), rungs: cached.rungs,
               current: null, pair: t.label, cached: true };
    }
    const env = alive.map((p) => [Number(p.lo), Number(p.hi)])
      .filter(([a, b]) => a > 0 && b > a);
    if (!env.length) return null;
    return { positions: env, rungs: [], current: null, pair: t.label,
             envelope: true, fromPairs: true };
  }

  function readLevels(t) {
    const scopes = scopesFor(t, true);
    if (!scopes.length) return offPage(t);

    const ranges = [];
    const trips = [];
    const rows = [];
    for (const sc of scopes) {
      const h = harvest(sc);
      ranges.push(...h.ranges);
      trips.push(...h.trips);
      rows.push(...rowsIn(sc));
    }

    // текущая цена — средний столбец Range Progress, он один на весь блок
    const mids = trips.map((v) => v[1])
      .filter((v) => isPrice(v) && v < 1e7).sort((a, b) => a - b);
    const current = mids.length ? mids[Math.floor(mids.length / 2)] : null;
    // Середина есть, но нечитаемая или безумная — пул улетел в потолок.
    const wild = trips.length > 0 && !mids.length;

    // в Manage ступени заданы явно, на дашборде есть только внешние границы
    let positions = ranges;
    if (!positions.length) positions = trips.map((v) => [Math.min(v[0], v[2]), Math.max(v[0], v[2])]);
    positions = [...new Map(positions.map((r) => [r[0] + '_' + r[1], r])).values()]
      .sort((a, b) => a[0] - b[0]);

    // Без цены леддер не выбрасываем: цену досыплет pushLevels из цепи.
    if (!positions.length) return null;

    // Ступени со статусом. Одинаковые диапазоны из разных леддеров на одном
    // токене схлопываем, оставляя залитую версию: если ликвидность есть хотя
    // бы в одном, ступень залита.
    const byKey = new Map();
    for (const r of rows.filter((x) => !isGone(x))) {
      const k = r.lo + '_' + r.hi;
      const prev = byKey.get(k);
      if (!prev || (!isFilled(prev) && isFilled(r))) byKey.set(k, r);
    }
    // Ступени, которых больше нет в таблице, отбрасываем целиком: иначе
    // закрытый пул продолжал висеть на графике.
    const live = rows.length
      ? positions.filter(([lo, hi]) => byKey.has(lo + '_' + hi))
      : positions;
    const rungs = live.map(([lo, hi]) => {
      const r = byKey.get(lo + '_' + hi);
      return {
        lo, hi,
        side: r ? r.side : null,
        filled: r ? isFilled(r) : true,
        value: r ? r.value : null,
      };
    });

    const k = keyOf(t);

    if (rows.length) {
      // Таблица позиций на экране — запоминаем ступени: смотреть график
      // другого токена, не потеряв его разбивку, надо уметь.
      // Вместе с суммами — цена, при которой они сняты: по ней график
      // восстановит ликвидность ступени и пересчитает суммы при любой цене.
      rungCache[k] = { rungs: rungs.map((r) => ({ ...r, at: current })), savedAt: Date.now() };
      try { chrome.storage.local.set({ [RKEY]: rungCache }); } catch (e) { /* контекст ушёл */ }
      return { positions: live, rungs, current, pair: t.label, poolDead: wild || undefined };
    }

    const fromChain = chainRungs(t);
    if (fromChain) {
      return { positions: fromChain.map((r) => [r.lo, r.hi]), rungs: fromChain,
               current, pair: t.label, chain: true, poolDead: wild || undefined };
    }

    const cached = rungCache[k];
    if (cached && Date.now() - (cached.savedAt || 0) > RUNGS_TTL) {
      delete rungCache[k];
      try { chrome.storage.local.set({ [RKEY]: rungCache }); } catch (e) { /* контекст ушёл */ }
    }
    if (cached && Date.now() - (cached.savedAt || 0) <= RUNGS_TTL
        && Array.isArray(cached.rungs) && cached.rungs.length) {
      return {
        positions: cached.rungs.map((r) => [r.lo, r.hi]),
        rungs: cached.rungs,
        current,
        pair: t.label,
        cached: true,
      };
    }

    // Ступеней не знаем вовсе — только внешние границы. Заливать такое нельзя:
    // получается одна плита во весь диапазон, из которой ничего не понять.
    return { positions, rungs, current, pair: t.label, envelope: true };
  }

  // Сайт печатает «$16.24 / Unclaimed» двумя соседними строчками — значение
  // стоит прямо над подписью. Читаем именно эту пару, а не позицию в вёрстке.
  function feesIn(root) {
    const out = { unclaimed: null, claimed: null };
    for (const el of root.querySelectorAll('*')) {
      if (el.children.length) continue;
      const label = (el.textContent || '').trim().toLowerCase();
      if (label !== 'unclaimed' && label !== 'claimed') continue;
      const prev = el.previousElementSibling;
      if (!prev) continue;
      const m = /^\$([0-9]+(?:[.,][0-9]+)?)$/.exec((prev.textContent || '').trim());
      if (!m) continue;
      out[label] = toNum(m[1]);
    }
    return out.unclaimed === null && out.claimed === null ? null : out;
  }

  /* ---------- сводка из панели «Fees & PnL» ----------
   *
   * Это самые честные числа по леддеру, которым ты сейчас управляешь: сайт
   * печатает их парами «подпись:» → значение. Появляются только после
   * «Update Fees», поэтому оно и вынесено кнопкой.
   */
  const SUMMARY_KEYS = {
    'total value': 'value',
    'unclaimed fees': 'unclaimed',
    claimed: 'claimed',
    'net pnl': 'pnl',
    dpr: 'dpr',
    age: 'age',
    price: 'price',
  };

  function summaryIn(root) {
    const leaves = [...root.querySelectorAll('*')]
      .filter((e) => !e.children.length && (e.textContent || '').trim());
    const out = {};
    for (let i = 0; i < leaves.length - 1; i++) {
      const m = /^(.+):$/.exec(leaves[i].textContent.trim());
      if (!m) continue;
      const key = SUMMARY_KEYS[m[1].trim().toLowerCase()];
      if (!key || out[key] !== undefined) continue;
      out[key] = leaves[i + 1].textContent.trim();
    }
    return Object.keys(out).length ? out : null;
  }

  // Первое число со знаком: «$-52.89 (-10.6%)» -> -52.89
  function moneyOf(text) {
    // Пробел между тысячами — часть числа, обрывать разбор на нём нельзя.
    const m = /(-?)\$?(-?)([0-9][0-9.,\s\u00a0\u202f]*[0-9]|[0-9])/.exec(String(text || ''));
    if (!m) return null;
    const v = toNum(m[3]);
    return m[1] === '-' || m[2] === '-' ? -v : v;
  }

  function readSummary() {
    return summaryIn(document.body);
  }

  // Открытый PnL: в карточке это «-$48.34» и сразу под ним «-9.7%»
  function pnlIn(root) {
    for (const el of root.querySelectorAll('*')) {
      if (el.children.length) continue;
      const m = /^([-+]?)\$([0-9][0-9.,]*)$/.exec((el.textContent || '').trim());
      if (!m) continue;
      const next = el.nextElementSibling;
      if (!next || next.children.length) continue;
      const p = /^([-+]?[0-9][0-9.,]*)%$/.exec((next.textContent || '').trim());
      if (!p) continue;
      return { usd: (m[1] === '-' ? -1 : 1) * toNum(m[2]), pct: toNum(p[1]) };
    }
    return null;
  }

  function readPnl(t) {
    let scopes = scopesFor(t, true).filter((sc) => pnlIn(sc));
    if (!scopes.length) scopes = scopesFor(t, false).filter((sc) => pnlIn(sc));
    if (!scopes.length) return null;
    let usd = 0;
    for (const sc of scopes) usd += pnlIn(sc).usd;
    return { usd, ladders: scopes.length };
  }

  function readFees(t) {
    let scopes = scopesFor(t, true).filter((sc) => feesIn(sc));
    if (!scopes.length) scopes = scopesFor(t, false).filter((sc) => feesIn(sc));
    if (!scopes.length) return null;

    let unclaimed = 0;
    let claimed = 0;
    for (const sc of scopes) {
      const v = feesIn(sc);
      unclaimed += v.unclaimed || 0;
      claimed += v.claimed || 0;
    }
    return { unclaimed, claimed, ladders: scopes.length };
  }

  const money = (v) => '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2));

  let loginSeen = { at: 0, v: null };
  function showNumbers(t) {
    if (!ui || !ui.fees) return;
    // Пока идёт наше нажатие — оставляем прошлые числа: свежие в этот момент
    // неполные, и в шапке мелькает чужой PnL.
    if (acting()) return;

    // Без входа на сайте сторож бессилен — это важнее любых чисел в шапке.
    if (Date.now() - loginSeen.at > 5000) loginSeen = { at: Date.now(), v: loggedIn(), expired: !!expiredBanner() };
    if (loginSeen.expired && !ownTab) {
      ui.fees.hidden = false;
      ui.fees.textContent = 'сессия истекла — обнови страницу и нажми Log in';
      ui.fees.title = 'Сайт завершил сессию. Вкладки сторожа входят заново сами, эту — обнови ты.';
      return;
    }
    if (loginSeen.v === false) {
      ui.fees.hidden = false;
      ui.fees.textContent = 'нет входа на сайте — войди, иначе сторож не соберёт';
      ui.fees.title = 'Liquidity Ladder разлогинил. Без входа не видно позиций и не нажать сбор.';
      return;
    }

    // Панель «Fees & PnL» на странице одна и принадлежит тому леддеру, что
    // сейчас загружен в Manage. Если в окне открыт другой токен, её числа
    // относятся не к нему — и в шапку шёл чужой PnL. Берём её только когда
    // страница и окно смотрят на один токен.
    const onPage = pageToken();
    const same = !!(t && onPage
      && String(onPage.addr).toLowerCase() === String(t.addr).toLowerCase()
      && onPage.chain === t.chain);
    const sum = same ? readSummary() : null;

    // комиссии
    let text = null;
    let hint = '';
    if (sum && sum.unclaimed) {
      const u = moneyOf(sum.unclaimed);
      text = 'несобрано ' + (u === null ? sum.unclaimed : money(u));
      hint = 'Из панели «Fees & PnL» этого леддера'
        + (sum.claimed ? '\nСобрано: ' + sum.claimed : '')
        + (sum.value ? '\nВ позициях: ' + sum.value : '')
        + (sum.age ? '\nВозраст: ' + sum.age : '');
    } else {
      const f = t && readFees(t);
      if (f) {
        text = 'несобрано ' + money(f.unclaimed);
        hint = 'Собрано за всё время: ' + money(f.claimed)
          + (f.ladders > 1 ? '\nСумма по ' + f.ladders + ' леддерам на этом токене' : '')
          + '\nЧисла с карточки дашборда. Нажми «обновить фисы» — будут точные.';
      }
    }
    ui.fees.hidden = text === null;
    if (text !== null) { ui.fees.textContent = text; ui.fees.title = hint; }

    // PnL
    let usd = null;
    let ptitle = '';
    if (sum && sum.pnl) {
      usd = moneyOf(sum.pnl);
      ptitle = 'Net PnL из панели «Fees & PnL»: ' + sum.pnl;
    } else {
      const p = t && readPnl(t);
      if (p) {
        usd = p.usd;
        ptitle = 'Незакрытый PnL по открытым позициям'
          + (p.ladders > 1 ? '\nСумма по ' + p.ladders + ' леддерам на этом токене' : '');
      }
    }
    ui.pnl.hidden = usd === null;
    if (usd !== null) {
      ui.pnl.className = 'pnl' + (usd < 0 ? ' minus' : '');
      ui.pnl.textContent = 'PnL ' + (usd < 0 ? '-' : '') + money(Math.abs(usd));
      ui.pnl.title = ptitle;
    }

  }

  /* ---------- два леддера на одном токене ----------
   *
   * Объединять их сайт не умеет: приходится руками копировать Token IDs из
   * одного пула и дописывать в другой. Запоминаем наборы ID, которые ты сам
   * открывал, и потом подставляем объединение одной кнопкой. Это чтение и
   * загрузка позиций, никаких подписей.
   */

  /**
   * Поле «Token IDs (comma-separated)». Подпись лежит не в ближайшем div, а
   * уровнем-двумя выше — из-за этого поле не находилось вовсе, и кнопка
   * «все позиции» не появлялась никогда.
   */
  function idsInput() {
    const inputs = visInputs();

    for (const el of inputs) {
      let node = el;
      for (let i = 0; i < 4 && node.parentElement; i++) {
        node = node.parentElement;
        if (/token\s*ids/i.test(node.textContent || '')) return el;
      }
    }
    // запасной путь: поле, где уже лежит список номеров через запятую
    return inputs.find((el) => (String(el.value).match(/\d{3,}/g) || []).length >= 2) || null;
  }

  const loadButton = () => clickables()
    .find((b) => /^load positions$/i.test((b.textContent || '').trim()));

  // Token ID — целое число без ведущих нулей. Без этой проверки в список
  // попадали обломки цен: «0.002386», разбитое по не-цифрам, даёт «0» и
  // «002386», и поле заполнялось мусором.
  const VALID_ID = /^[1-9][0-9]{3,11}$/;

  function parseIds(text) {
    return [...new Set(String(text || '').split(/[^0-9]+/))].filter((v) => VALID_ID.test(v));
  }

  function mergeIds(sets) {
    const all = [];
    for (const ids of sets) {
      for (const raw of ids) {
        const id = String(raw);
        if (VALID_ID.test(id) && !all.includes(id)) all.push(id);
      }
    }
    return all.sort((a, b) => Number(a) - Number(b));
  }

  // Все наборы Token IDs по этому токену. Первым делом — то, что сайт сам
  // отдал в dashboard-stats: там перечислены все леддеры пользователя, и
  // открывать каждый пул руками не нужно.
  const CHAIN_ID = { eth: 1, bsc: 56, base: 8453, robinhood: 4663, polygon: 137, arbitrum: 42161 };
  // Обратная таблица: сайт отдаёт числовой id сети, а сторожу нужно имя.
  const CHAIN_NAME = Object.fromEntries(Object.entries(CHAIN_ID).map(([k, v]) => [v, k]));

  function pairsFor(t) {
    const want = CHAIN_ID[t.chain];
    return pairs.filter((p) => {
      // сеть обязана совпадать: один и тот же стейбл встречается в разных
      // парах, и без этой проверки в объединение лезли чужие леддеры
      if (want && p.chainId && p.chainId !== want) return false;
      // Регистр не сравниваем: сайт пишет адреса строчными, GMGN — как
      // придётся. Из-за этого токен с GMGN «не имел позиций».
      const a = String(t.addr).toLowerCase();
      return String(p.token0).toLowerCase() === a || String(p.token1).toLowerCase() === a;
    });
  }

  // Только то, что отдал сам сайт. Прежний запасной путь — запоминать ID из
  // поля Manage — складывал в хранилище мусор, когда поле определялось
  // неверно, и этот мусор потом лез в объединение.
  function idSetsFor(t) {
    return pairsFor(t).map((p) => p.ids);
  }

  function mergeAction(t) {
    const input = idsInput();
    const load = loadButton();
    if (!input || !load) return null;

    const sets = idSetsFor(t);
    if (!sets.length) {
      return {
        label: 'все позиции',
        disabled: true,
        hint: pairs.length
          ? 'Этого токена нет в списке твоих леддеров.\n'
            + 'Если леддер только что создан — зайди на Dashboard и обнови его, '
            + 'список приходит оттуда.'
          : 'Расширение ещё не видело список твоих леддеров.\n'
            + 'Зайди один раз на Dashboard — сайт отдаст его сам, и кнопка оживёт.',
        run: () => {},
      };
    }
    if (sets.length < 2) {
      // Раньше кнопка просто не появлялась, и было непонятно, есть она вообще
      // или нет. Теперь видна всегда и объясняет, чего ей не хватает.
      return {
        label: 'все позиции',
        disabled: true,
        hint: 'По этому токену у тебя один леддер — объединять нечего.\n'
          + 'Список берётся из данных самого сайта; если он пуст, зайди '
          + 'один раз на Dashboard, чтобы он обновился.',
        run: () => {},
      };
    }

    const all = mergeIds(sets);
    const now = parseIds(input.value);
    if (now.length >= all.length) {
      return {
        label: 'все позиции (' + all.length + ')',
        disabled: true,
        hint: 'Все известные позиции по этому токену уже загружены',
        run: () => {},
      };
    }

    const mine = pairsFor(t);
    const what = mine.length
      ? mine.map((p) => p.symbols + ' — ' + p.ids.length + ' поз., ' + p.lo + '…' + p.hi).join('\n')
      : '';

    return {
      label: 'все позиции (' + all.length + ')',
      hint: 'Загрузить в Manage все ' + all.length + ' позиций из ' + sets.length
        + ' леддеров:\n' + what
        + '\nID берутся из данных самого сайта, открывать пулы руками не нужно.',
      run: () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, all.join(', '));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => tap(load), 80);
      },
    };
  }

  // Кнопки, которые есть у самого сайта для этого леддера. Ничего не выдумываем
  // и никуда не жмём вслепую: находим его же контролы и нажимаем их по клику.
  /**
   * Дождаться, пока на странице появится нужное. Свежая вкладка сторожа
   * дорисовывает шапку позиций уже после того, как токен опознан, и разовая
   * проверка «есть ли Update Fees» проваливалась — сбор вставал на ровном
   * месте с «панели Fees & PnL нет».
   */
  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    for (;;) {
      openTick();                       // сбросить кэш кнопок: страница менялась
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await wait(400);
    }
  }

  const findBtn = (re) => clickables()
    .find((b) => re.test((b.textContent || '').replace(/\s+/g, ' ').trim()));

  /**
   * Лист с таким текстом. Полный обход document.querySelectorAll('*') с
   * проверкой offsetParent у каждого узла заставляет браузер пересчитывать
   * раскладку тысячи раз подряд; обход текстовых узлов делает ту же работу
   * на порядок дешевле и трогает раскладку только у кандидата.
   */
  function leafWithText(re, visibleOnly) {
    const body = document.body;
    if (!body) return null;
    const NF = (typeof NodeFilter !== 'undefined' && NodeFilter)
      || (window && window.NodeFilter);
    const walk = document.createTreeWalker(body, NF ? NF.SHOW_TEXT : 4);
    let seen = null;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!(n.nodeValue || '').trim()) continue;
      const el = n.parentElement;
      if (!el || el === seen || el.children.length) continue;
      seen = el;
      if (!re.test((el.textContent || '').trim())) continue;
      if (visibleOnly && el.offsetParent === null) continue;
      return el;
    }
    return null;
  }

  // Панель «Fees & PnL» открыта, если на экране появилась её сводка
  const feesPanelOpen = () => !!leafWithText(/^unclaimed fees:?$/i);

  const RE_UPDATE = /^(update|refresh)\s+fees$/i;
  const RE_PANEL = /^fees\s*&\s*pnl$/i;

  /**
   * «Update Fees» живёт внутри панели «Fees & PnL» и снаружи её просто нет.
   * Поэтому кнопка делает всю цепочку: открыть панель, дождаться кнопки,
   * нажать. Обе операции — чтение, ничего не подписывается.
   */
  function feesAction() {
    if (!findBtn(RE_UPDATE) && !findBtn(RE_PANEL)) return null;
    return {
      label: 'обновить фисы',
      hint: 'Открыть «Fees & PnL» и нажать «Update Fees» — цифры приедут сюда, в шапку',
      run: async (btnEl) => {
        if (btnEl && btnEl.dataset.busy) return;      // одно нажатие, а не десять
        const say = (t) => { if (btnEl) { btnEl.textContent = t; btnEl.classList.add('off'); } };
        const done = (t) => {
          if (!btnEl) return;
          btnEl.textContent = t;
          setTimeout(() => {
            delete btnEl.dataset.busy;
            btnEl.classList.remove('off');
            btnEl.textContent = btnEl.dataset.label || 'обновить фисы';
          }, 2000);
        };
        if (btnEl) btnEl.dataset.busy = '1';
        actNow(30000);

        say('открываю…');
        if (!feesPanelOpen()) {
          const panel = findBtn(RE_PANEL);
          if (!panel) { done('панели нет'); return; }
          tap(panel);
          for (let i = 0; i < 25 && !findBtn(RE_UPDATE); i++) await wait(200);
        }

        const upd = findBtn(RE_UPDATE);
        if (!upd) { done('нет Update Fees'); return; }

        say('считаю…');
        tap(upd);

        // ждём, пока в панели появятся числа — вот тогда и правда готово
        for (let i = 0; i < 40; i++) {
          await wait(300);
          if (readSummary()) {
            // Сайт только что перерисовал таблицу позиций — самый момент
            // перечитать ступени и глубину, иначе на графике старое.
            actingUntil = 0;
            refreshLiquidity();
            forgetRungs(pageToken() || active());
            done('готово');
            return;
          }
        }
        refreshLiquidity();
        forgetRungs(pageToken() || active());
        done('не дождался');
      },
    };
  }

  /**
   * Всегда одни и те же четыре кнопки в одном и том же порядке. Недоступная
   * гасится, но остаётся на месте: раньше набор менялся, кнопки прыгали, и
   * попасть по нужной в маленьком окне было невозможно.
   */
  const BR = String.fromCharCode(10);
  const OFF = (label, hint) => ({ label, hint, disabled: true, run: () => {} });

  const RE_SELECT_ALL = /^select all$/i;
  const RE_COLLECT_ALL = /^collect\s*\(\d+\)$/i;
  const RE_CLOSE_ALL = /^close\s*\(\d+\)$/i;
  // Подтверждение, которое сайт показывает после нажатия: предупреждение о
  // проскальзывании и тому подобное. Список намеренно короткий — жать всё
  // подряд в модальном окне нельзя, там бывает и «отменить».
  const RE_CONFIRM = /^(confirm|proceed|continue|accept|подтвердить|продолжить|да,?\s*продолжить)$/i;

  // Сколько позиций сейчас выделено — по числу в общей кнопке «Collect (N)».
  // Это единственный надёжный признак: сам квадратик выделения нарисован
  // своей разметкой, настоящего input[type=checkbox] у него нет.
  function selectedCount() {
    const btn = findBtn(RE_COLLECT_ALL);
    if (!btn) return 0;
    const m = /\((\d+)\)/.exec(btn.textContent || '');
    return m ? Number(m[1]) : 0;
  }

  /**
   * Кандидаты на роль «отметить все». Первым делом — обычная кнопка с таким
   * текстом: у неё внутри иконка, поэтому листом дерева она не является, и
   * прежний поиск «лист с текстом Select all» не находил её никогда.
   */
  function selectAllTargets() {
    const out = [];
    const btn = findBtn(RE_SELECT_ALL);
    if (btn) out.push(btn);

    const label = leafWithText(/^select all$/i, true);
    if (label) {
      const box = label.closest('label') || label.parentElement;
      out.push(
        box && box.querySelector('input[type="checkbox"]'),
        box && box.querySelector('[role="checkbox"], [aria-checked]'),
        label.previousElementSibling,
        box,
      );
    }
    return out.filter((el) => el && el.offsetParent !== null);
  }

  /**
   * Запасной путь: отмечать позиции по одной. Строка — это предок кнопки
   * «Collect»; в ней ищем самый левый кликабельный элемент. После каждого
   * нажатия сверяем счётчик и откатываем промах, чтобы не оставить страницу
   * в наполовину выделенном виде.
   */
  async function selectRows() {
    const rows = [];
    for (const el of clickables()) {
      if (!/^collect$/i.test((el.textContent || '').trim())) continue;
      let node = el;
      for (let i = 0; i < 5 && node.parentElement; i++) {
        node = node.parentElement;
        if (node.getBoundingClientRect().width > 300) break;
      }
      if (node && !rows.includes(node)) rows.push(node);
    }
    if (!rows.length) return false;

    for (const row of rows) {
      const spots = [...row.querySelectorAll('button, [role="checkbox"], input[type="checkbox"], svg')]
        .filter((e) => e.offsetParent !== null && !/collect|close|add/i.test(e.textContent || ''))
        .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
      for (const spot of spots.slice(0, 2)) {
        const was = selectedCount();
        tap(spot);
        await wait(300);
        if (selectedCount() > was) break;
        tap(spot);
        await wait(150);
      }
    }
    return selectedCount() > 0;
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Нажимаем кандидатов по очереди и после каждого проверяем, изменилось ли
   * число в «Collect (N)». Промахнулись — снимаем и пробуем следующего, чтобы
   * не оставить страницу в наполовину выделенном виде.
   */
  /** Сколько позиций на странице: у каждой строки своя кнопка «Collect». */
  function rowCount() {
    return clickables().filter((el) => /^collect$/i.test((el.textContent || '').trim())).length;
  }

  /**
   * Отметить все позиции. Возвращает true, только когда отмечены все.
   *
   * Раньше хватало «отмечена хоть одна»: осталась с прошлого раза одна из
   * пяти — и Close (1) закрывал одну, а не выход целиком. Сверяем счётчик
   * общей кнопки с числом строк.
   */
  async function ensureSelection() {
    const total = rowCount();
    const full = () => (total ? selectedCount() >= total : selectedCount() > 0);
    if (full()) return true;
    for (const el of selectAllTargets()) {
      // «Отметить все» при частичном выделении может сперва снять его —
      // тогда второе нажатие отмечает всё. Проверяем после каждого.
      tap(el);
      await wait(450);
      if (full()) return true;
      tap(el);
      await wait(450);
      if (full()) return true;
    }
    // Кнопка не поддалась — отмечаем позиции по одной
    await selectRows();
    return full();
  }

  /**
   * Сбор комиссий: пересчитать фисы, отметить все позиции, нажать общую
   * кнопку «Collect (N)». Именно общую — тыкать в каждую строку по очереди
   * нельзя, промах строкой означает чужую позицию.
   *
   * Транзакцию подтверждаешь в кошельке: расширение до подписи не доходит.
   */
  function collectAction() {
    const bulk = findBtn(RE_COLLECT_ALL);
    const anyCollect = clickables().some(
      (el) => /^collect$/i.test((el.textContent || '').trim()),
    );
    if (!bulk && !anyCollect) {
      return OFF('собрать фисы', 'Позиций на странице нет — открой список в Manage');
    }

    return {
      label: 'собрать фисы',
      hint: 'Пересчитать комиссии, отметить все позиции и нажать общую кнопку '
        + '«Collect (N)».' + BR + 'На встроенном кошельке сайт подпишет сам; '
        + 'на внешнем подтверждение придёт в кошелёк.',
      run: async (btnEl) => {
        if (btnEl && btnEl.dataset.busy) return;
        const say = (t) => { if (btnEl) { btnEl.textContent = t; btnEl.classList.add('off'); } };
        const done = (t) => {
          if (!btnEl) return;
          btnEl.textContent = t;
          setTimeout(() => {
            delete btnEl.dataset.busy;
            btnEl.classList.remove('off');
            btnEl.textContent = btnEl.dataset.label || 'собрать фисы';
          }, 3000);
        };
        if (btnEl) btnEl.dataset.busy = '1';
        actNow(45000);

        // Пошаговый отчёт: когда сбор не срабатывает, надо видеть, на чём
        // именно он встал, а не гадать по слову «не работает».
        const step = (t, extra) => {
          say(t);
          impulseNote('сбор: ' + t);
          try { console.log('[LLC] сбор фисов:', t, extra === undefined ? '' : extra); }
          catch (e) { /* консоли может не быть */ }
        };
        const fail = (t, extra) => {
          done(t);
          impulseNote('сбор не прошёл: ' + t);
          try { console.warn('[LLC] сбор фисов встал:', t, extra === undefined ? '' : extra); }
          catch (e) { /* см. выше */ }
        };

        step('считаю фисы…');
        const fees = await waitFor(feesAction, 8000);
        // Панели так и нет — собираем без пересчёта: порог уже проверили до
        // нажатия, а вставать из-за неё значило оставлять фисы несобранными.
        // Подтвердить, что фисы ушли, тогда нечем — выйдет «нажал».
        if (fees) await fees.run(null);
        else step('панели Fees & PnL нет — собираю без пересчёта');
        const sum0 = fees ? readSummary() : null;
        const before = sum0 ? moneyOf(sum0.unclaimed) : null;

        step('отмечаю позиции…', 'выделено сейчас: ' + selectedCount());
        const ok = await ensureSelection();
        if (!ok) {
          fail('не смог отметить позиции',
               'кандидатов на «Select all»: ' + selectAllTargets().length);
          return { ok: false, why: 'не смог отметить позиции' };
        }

        const n = selectedCount();
        const btn = findBtn(RE_COLLECT_ALL);
        if (!btn) {
          fail('кнопки «Collect (N)» нет', 'выделено: ' + n);
          return { ok: false, why: 'кнопки «Collect (N)» нет' };
        }
        step('жму Collect (' + n + ')');
        const seen = new Set(retryBanners());
        const bad = new Set(failNotes());
        tap(btn);
        if (await confirmIfAsked()) step('подтвердил');
        const note = await newFailNote(bad, 6000);
        if (note) {
          LOG.warn('сбор: транзакция не прошла', { why: note, token: (pageToken() || {}).addr });
          step('транзакция не прошла: ' + note);
        }
        if (await newRetryBanner(seen)) {
          // Страница живёт со старой сессией — повтор здесь же не лечит,
          // помогает только обновление. Вкладку сторожа обновит сторож и
          // повторит сбор; свою вкладку человек обновит сам.
          actingUntil = 0;
          fail('сайт обновил сессию — обнови страницу');
          return { ok: false, reload: true, why: 'сайт обновил сессию' };
        }

        // Нажать — ещё не значит собрать: транзакция может не пройти, а сайт
        // может показать ошибку. Пересчитываем фисы и смотрим, ушли ли они.
        // Без этого в истории стояло «собрал», даже когда ничего не ушло.
        let after = null;
        // Меньше доллара подтвердить нечем: «стало меньше 30%» от 80 центов
        // неотличимо от округления. Такой сбор — «нажал», а не «собрал».
        if (before !== null && before >= 1) {
          step('проверяю, что фисы ушли…');
          for (let i = 0; i < 3; i++) {
            await wait(6000);
            const f2 = feesAction();
            if (f2) await f2.run(null);
            const sum = readSummary();
            after = sum ? moneyOf(sum.unclaimed) : null;
            if (after !== null && after < before * 0.3) break;
          }
        }
        // Дело сделано — отпускаем заморозку и перечитываем числа заново.
        actingUntil = 0;
        refreshLiquidity(pageToken() || active());
        forgetRungs(pageToken() || active());
        const gone = before !== null && before >= 1 && after !== null && after < before * 0.3;
        done(gone ? 'собрал' : 'нажал');
        return { ok: true, confirmed: gone, before, after };
      },
    };
  }

  /**
   * Сайт после нажатия иногда показывает подтверждение — про проскальзывание
   * или про необратимость. Ждём его недолго и жмём, иначе действие повисает
   * на полпути и выглядит как «не сработало».
   */
  /*
   * «Session refreshed. Please retry.» — сайт через какое-то время обновляет
   * сессию, и первое нажатие после этого не проходит. В вкладке, открытой
   * часами, так падал каждый автосбор, и собирать приходилось руками.
   * Ловим именно НОВОЕ такое сообщение — появившееся после нашего нажатия,
   * а не висящее с прошлого раза, — и жмём ещё раз.
   */
  const RE_RETRY = /session (refreshed|expired)|please retry|try again/i;

  /*
   * Свап не всегда проходит с первого раза: не хватило газа, цена ушла за
   * проскальзывание, узел ответил не сразу. Такое лечится повтором — поэтому
   * неудачу распознаём по тексту на странице и пробуем ещё раз.
   */
  const RE_SWAPFAIL = /slippage|insufficient|not enough|too little|failed|revert|underpriced|replacement|nonce|timeout|expired deadline|rejected|error/i;

  function failNotes() {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length || el.offsetParent === null) continue;
      const text = (el.textContent || '').trim();
      if (text.length > 200 || !RE_SWAPFAIL.test(text)) continue;
      out.push(el);
    }
    return out;
  }

  /** Появилась ли новая жалоба на неудачу после нажатия. */
  async function newFailNote(before, ms = 8000) {
    for (let i = 0; i < Math.ceil(ms / 400); i++) {
      await wait(400);
      const hit = failNotes().find((el) => !before.has(el));
      if (hit) return (hit.textContent || '').trim().slice(0, 120);
    }
    return null;
  }

  /** Поле «Slippage» на странице: на повторе его можно поднять. */
  function slipInput() {
    for (const el of visInputs()) {
      let node = el;
      for (let i = 0; i < 4 && node.parentElement; i++) {
        node = node.parentElement;
        if (/slippage/i.test(node.textContent || '')) return el;
      }
    }
    return null;
  }

  function bumpSlippage(step) {
    const el = slipInput();
    if (!el || !(step > 0)) return null;
    const was = Number(el.value);
    if (!isFinite(was)) return null;
    const next = Math.min(50, was + step);
    if (next === was) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(next));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { was, next };
  }

  /**
   * Повторить попытку, пока не выйдет. Останавливаемся сразу, если дело
   * сделано или нужна перезагрузка страницы: её повтором не вылечишь.
   * Каждая попытка попадает в журнал — по нему потом видно, на чём встало.
   */
  const RETRY_GAP = [5000, 12000, 25000];
  async function tryTimes(label, attempt) {
    const times = Math.max(1, Math.min(5, Number(S.retryTimes) || 1));
    let res = { ok: false, why: 'не пробовали' };
    for (let i = 1; i <= times; i++) {
      res = (await attempt(i)) || { ok: false, why: 'без ответа' };
      if (res.ok || res.reload) {
        if (i > 1) LOG.info(label + ': вышло с ' + i + '-й попытки', { why: res.why });
        return { ...res, tries: i };
      }
      LOG.warn(label + ': попытка ' + i + ' из ' + times + ' не прошла', { why: res.why });
      if (i >= times) break;
      const bumped = bumpSlippage(Number(S.slipStep) || 0);
      if (bumped) LOG.info(label + ': поднял проскальзывание', bumped);
      const gap = RETRY_GAP[Math.min(i - 1, RETRY_GAP.length - 1)];
      // Пауза перед повтором — самое длинное молчание страницы. Говорим о
      // ней вслух, иначе сторож сочтёт вкладку заснувшей и перезагрузит её
      // ровно посреди повторного свапа.
      beat(label + ': жду ' + Math.round(gap / 1000) + ' с перед повтором ' + (i + 1));
      await wait(gap);
    }
    LOG.err(label + ': не вышло за ' + times + ' попыток', { why: res.why });
    return { ...res, tries: times };
  }

  function retryBanners() {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length || el.offsetParent === null) continue;
      if (RE_RETRY.test(el.textContent || '')) out.push(el);
    }
    return out;
  }

  async function newRetryBanner(before) {
    for (let i = 0; i < 10; i++) {
      await wait(300);
      if (retryBanners().some((el) => !before.has(el))) return true;
    }
    return false;
  }

  async function confirmIfAsked() {
    for (let i = 0; i < 20; i++) {
      await wait(300);
      const btn = clickables().find(
        (el) => RE_CONFIRM.test((el.textContent || '').replace(/\s+/g, ' ').trim()),
      );
      if (btn) { tap(btn); return true; }
    }
    return false;
  }

  /**
   * Закрыть позиции целиком: отметить все и нажать общую «Close (N)».
   *
   * Именно общую. Тыкать в «Close» отдельной строки нельзя: промах строкой
   * закроет чужую позицию, а это необратимо.
   */
  function closeAction() {
    const bulk = findBtn(RE_CLOSE_ALL);
    const any = clickables().some((el) => /^close$/i.test((el.textContent || '').trim()));
    if (!bulk && !any) return null;
    return {
      label: 'закрыть позиции',
      hint: 'Отметить все позиции и нажать общую кнопку «Close (N)».' + BR
        + 'Это выход из позиции целиком, а не сбор комиссий.',
      run: async () => {
        actNow(180000);
        const res = await tryTimes('закрытие позиций', async () => {
          const ok = await ensureSelection();
          if (!ok) return { ok: false, why: 'не смог отметить все позиции' };
          const btn = findBtn(RE_CLOSE_ALL);
          if (!btn) return { ok: false, why: 'кнопки «Close (N)» нет' };
          const before = rowCount();
          const seen = new Set(retryBanners());
          const bad = new Set(failNotes());
          tap(btn);
          await confirmIfAsked();
          if (await newRetryBanner(seen)) {
            // Закрытие не прошло: страница со старой сессией. Нужна перезагрузка.
            return { ok: false, reload: true, why: 'сайт обновил сессию' };
          }
          // Свап мог не пройти: газ, проскальзывание, отказ узла. Это
          // повторяемо — возвращаем причину, и попытка будет ещё одна.
          const note = await newFailNote(bad, 6000);
          if (note) return { ok: false, why: 'свап не прошёл: ' + note };
          // Нажали — ещё не закрыли. Ждём, пока позиции уйдут со страницы:
          // по этому ответу снимаются тейки, и снять их при непрошедшей
          // транзакции значит оставить позиции без защиты.
          for (let i = 0; i < 30; i++) {
            await wait(2000);
            const left = rowCount();
            if (left < before || (!findBtn(RE_CLOSE_ALL) && left === 0)) return { ok: true };
          }
          return { ok: false, why: 'нажал Close, но позиции не ушли за минуту' };
        });
        actingUntil = 0;
        forgetRungs(pageToken() || active());
        return res;
      },
    };
  }

  function siteActions(t) {
    return [
      feesAction() || OFF('обновить фисы', 'Панели «Fees & PnL» на этой странице нет — открой список позиций в Manage'),
      mergeAction(t) || OFF('все позиции', 'Поле Token IDs есть только в Manage'),
      collectAction(),
    ];
  }

  /**
   * Та же кнопка, но встроенная в сам сайт рядом с «Load Positions»: график
   * может быть закрыт, а позиции подтянуть нужно всё равно.
   */
  // Токен текущей страницы, независимо от того, открыт ли график
  function pageToken() {
    const found = [];
    for (const a of anchors()) {
      const t = parseLink(a);
      if (t && !found.some((x) => keyOf(x) === keyOf(t))) found.push(t);
    }
    return found.length === 1 ? found[0] : null;
  }

  // Токены, по которым уже дозагрузили: без этого при отказе сайта попытка
  // повторялась бы каждый проход разбора.
  const autoDone = new Set();
  // Токен, который человек открыл сам, и когда это было.
  let intent = null;
  const INTENT_TTL = 60000;
  // Когда человек последний раз сам трогал страницу. Подменять под ним
  // содержимое Manage — худшее, что можно сделать: он смотрит одно, а через
  // секунду там другое.
  let humanAt = 0;

  /**
   * Открыл Manage — остальные позиции по этому токену подтягиваются сами.
   * Список ID известен из ответа самого сайта, ждать нажатия кнопки незачем.
   * Повторно не срабатывает: как только всё загружено, действие гаснет.
   */
  function autoMerge() {
    if (S.autoLoad === false) return;
    // Только тот токен, по которому человек кликнул сам, и только пока
    // намерение свежее. Раньше подгрузка смотрела, что лежит на странице, —
    // и на переходе успевала увидеть прошлый токен, а потом загружала его
    // обратно, отменяя переход.
    if (!intent || Date.now() - intent.at > INTENT_TTL) return;
    const t = intent.t;

    // И только когда сайт уже показывает именно его: иначе мы вмешиваемся
    // в незаконченный переход.
    const now = pageToken();
    if (!now || keyOf(now) !== keyOf(t)) return;

    const k = keyOf(t);
    if (autoDone.has(k)) { intent = null; return; }
    const input = idsInput();
    // Пока в поле стоит курсор, туда лезть нельзя: человек правит его сам.
    if (input && document.activeElement === input) return;
    const act = mergeAction(t);
    if (!act || act.disabled) return;
    autoDone.add(k);
    intent = null;
    act.run(null);
  }

  /**
   * Сторож поймал импульс и просит собрать комиссии.
   *
   * Жмём ровно ту же кнопку «собрать фисы», что и рукой. На встроенном
   * кошельке сайт подписывает на своей стороне, так что подтверждать нечего
   * и сбор случается сразу.
   * Порог сверяем здесь: точные цифры по комиссиям есть только у страницы.
   */
  // Возвращает true, если вкладка взялась за дело: сторож раздаёт поручение
  // по одной вкладке и по этому ответу решает, идти ли к следующей.
  /**
   * Есть ли вход на сайте. Залогиненная страница показывает в меню «Log out»;
   * без входа там кнопка входа. Не нашли ни того, ни другого — не знаем
   * (null): страница ещё грузится, мешать ей не будем.
   */
  /*
   * Сессия на сайте истекает, и страница показывает красную плашку. Помогает
   * одно: обновить страницу и нажать вход — данные для входа браузер
   * подставляет сам. Во вкладке сторожа делаем это сами; в твоей — только
   * говорим. Не чаще раза в 5 минут на каждый шаг, чтобы не зациклиться.
   */
  let ownTab = false;
  const RE_EXPIRED = /session (has )?expired|session refreshed|please (log|sign) ?in again|сесси[яи] истекл/i;
  function expiredBanner() {
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length || el.offsetParent === null) continue;
      if (RE_EXPIRED.test(el.textContent || '')) return el;
    }
    return null;
  }
  const HEAL_GAP = 5 * 60000;
  const healAt = (k) => { try { return Number(sessionStorage.getItem(k) || 0); } catch (e) { return 0; } };
  const healMark = (k) => { try { sessionStorage.setItem(k, String(Date.now())); } catch (e) { /* нет */ } };
  let healing = false;
  async function selfHeal() {
    if (!ownTab || healing || acting()) return;
    // Вошли заново и заходили на Dashboard за свежим доступом — назад в Manage.
    try {
      if (sessionStorage.getItem('ghoBackToManage') && /\/dashboard/.test(location.pathname) && loggedIn() === true) {
        sessionStorage.removeItem('ghoBackToManage');
        setTimeout(() => { location.href = location.origin + '/manage'; }, 8000);
        return;
      }
    } catch (e) { /* нет sessionStorage */ }
    const expired = expiredBanner();
    const logged = loggedIn();
    if (expired && Date.now() - healAt('ghoReloadAt') > HEAL_GAP) {
      healMark('ghoReloadAt');
      tell({ type: 'relogin', ok: false, step: 'reload' });
      location.reload();
      return;
    }
    if (logged !== false || Date.now() - healAt('ghoLoginAt') < HEAL_GAP) return;
    const btn = clickables().find((el) => RE_LOGIN.test((el.textContent || '').replace(/\s+/g, ' ').trim()));
    if (!btn) return;
    healing = true;
    healMark('ghoLoginAt');
    tap(btn);
    await confirmIfAsked();
    for (let i = 0; i < 20 && loggedIn() !== true; i++) await wait(1000);
    healing = false;
    const ok = loggedIn() === true;
    tell({ type: 'relogin', ok, step: 'login' });
    // Доступ к списку позиций сторож берёт из запроса Dashboard — зайдём
    // за ним и вернёмся в Manage.
    if (ok) {
      try { sessionStorage.setItem('ghoBackToManage', '1'); } catch (e) { /* нет */ }
      location.href = location.origin + '/dashboard';
    }
  }

  const RE_LOGOUT = /^log ?out$|^выйти$/i;
  const RE_LOGIN = /^(log ?in|sign ?in|connect( wallet)?|войти)$/i;
  function loggedIn() {
    let login = false;
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length || el.offsetParent === null) continue;
      const t = (el.textContent || '').trim();
      if (RE_LOGOUT.test(t)) return true;
      if (RE_LOGIN.test(t)) login = true;
    }
    return login ? false : null;
  }

  async function onImpulse(msg) {
    if (!msg || S.watchOn === false) return false;
    // Вкладку, которую человек открыл сам, не трогаем вовсе: ни подменять
    // содержимое, ни нажимать в ней. Сторож заведёт свою.
    if (msg.own !== true && !msg.dry) return false;
    // Без входа на сайте в Manage нет ни поля позиций, ни кнопок — любое
    // поручение кончится ничем. Говорим это прямо, а не «не знаю позиций».
    if (loggedIn() === false) {
      impulseNote((msg.reason || 'повод') + ': на сайте нет входа — войди в Liquidity Ladder');
      return { handled: true, did: 'login', why: 'на сайте слетел вход' };
    }
    const want = String(msg.addr).toLowerCase();
    // Без этой записи по журналу не отличить «страница не получила поручение»
    // от «получила и встала»: раньше там был один сторож и ни слова страницы.
    beat('принял поручение');
    LOG.info('поручение принято', {
      token: want, reason: msg.reason || '', act: msg.act || 'fees',
    });

    // Повод пришёл по одному токену, а в Manage открыт другой — раньше такое
    // сообщение просто терялось, и уровень «не срабатывал». Загружаем нужные
    // позиции сами: их ID известны из данных сайта.
    let t = pageToken();
    if (!t || t.addr.toLowerCase() !== want) {
      impulseNote((msg.reason || 'повод') + ' — открываю позиции по токену');
      t = await loadToken(msg.chain, want);
      if (!t) {
        const seenNow = document.visibilityState === 'visible';
        const busy = seenNow || Date.now() - humanAt < HUMAN_QUIET;
        // Номера позиций загрузились, а сайт пишет «No V4 positions found» —
        // список леддеров устарел: лесенку пересоздали, у неё новые номера.
        const stale = !busy && /no v4 positions found/i.test(document.body.innerText || '');
        const why = busy ? 'вкладка открыта у тебя на экране — не подменяю её'
          : stale ? 'по старым номерам позиций пусто — лесенку пересоздали, открой Dashboard, чтобы список обновился'
            : 'открой Manage по этому токену — расширение не знает его позиций';
        impulseNote((msg.reason || 'повод') + ': ' + why);
        tell({ type: 'collected', label: msg.label, why: (msg.reason || 'повод') + ': ' + why });
        return busy ? false : { handled: true, did: 'fail', why };
      }
    }

    if (msg.act === 'close' && !msg.dry) {
      const close = closeAction();
      if (!close) {
        impulseNote((msg.reason || 'уровень') + ': кнопки Close на странице нет');
        tell({ type: 'collected', label: msg.label,
               why: (msg.reason || 'уровень') + ': кнопки Close нет — открой Manage' });
        return false;
      }
      impulseNote((msg.reason || 'уровень') + ' — закрываю позиции');
      const res = (await close.run()) || {};
      const done = !!res.ok;
      // Закрылись — значит позиций по этому токену больше нет, и остальные
      // уровни по нему держать незачем: срабатывать им уже не на чем. Не
      // подтвердилось — уровни оставляем: лишнее срабатывание безвредно
      // (закрывать будет нечего), а снятая защита — нет.
      if (done) {
        clearTakes(msg.chain, msg.addr, 'позиции закрыты');
        forgetRungs({ chain: msg.chain, addr: msg.addr });
      }
      // Сообщаем после дела, а не до: по этому сообщению воркер закрывает
      // свою вкладку, и раньше она могла закрыться посреди транзакции.
      tell({ type: 'collected', label: msg.label,
             why: msg.reason + (done ? ' — закрыл позиции' : ' — закрыть не вышло') });
      if (res.reload) return { handled: true, did: 'reload', why: res.why };
      return done
        ? { handled: true, did: 'closed' }
        : { handled: true, did: 'fail', why: res.why || 'закрыть не вышло' };
    }

    const act = collectAction();
    if (!act || act.disabled) {
      impulseNote('импульс: позиций на странице нет');
      tell({ type: 'collected', label: msg.label,
             why: (msg.reason || 'импульс') + ': позиций на странице нет — открой Manage' });
      return false;
    }

    // Сначала пересчитать комиссии, иначе сверяем порог со вчерашним числом.
    const fees = await waitFor(feesAction, 8000);
    if (fees) await fees.run(null);

    const sum = readSummary();
    let have = sum ? moneyOf(sum.unclaimed) : null;
    // Панель не прочиталась — берём карточку. Её число с бэкенда сайта и
    // обычно отстаёт в меньшую сторону, так что порог по ней не соврёт.
    if (have === null) {
      const f = readFees(t);
      if (f && f.unclaimed !== null && f.unclaimed !== undefined) have = f.unclaimed;
    }
    const need = Number(msg.minUsd) || 0;
    // Не знаем, сколько фисов, — не собираем. Раньше «не знаю» пропускало
    // проверку порога целиком: у TWINE ушли сборы на $0 и $0.35 при пороге
    // $20, газ дороже самих фисов.
    if (have === null && !msg.dry) {
      impulseNote((msg.reason || 'повод') + ': не видно, сколько фисов — не собираю');
      return { handled: true, did: 'wait', why: 'не видно сумму фисов на странице' };
    }
    if (have !== null && have < need) {
      // Не дозрело — молча ждём следующей проверки. Уведомлять тут нечем:
      // за один памп таких проверок будет десяток.
      impulseNote((msg.reason || 'импульс') + ', фисов ' + money(have)
        + ' из ' + money(need) + ' — жду');
      // Взялись и разобрались: до порога не дозрело, другой вкладке делать
      // нечего. Но это не сбор — так и говорим, иначе в истории «собрал».
      return { handled: true, did: 'wait', usd: have,
               why: 'на странице ' + money(have) + ' из ' + money(need) };
    }
    if (msg.dry) {
      impulseNote('проверка прошла: собрал бы '
        + (have === null ? 'фисы' : money(have)) + ' (порог ' + money(need) + ')');
      return { handled: true, did: 'dry', usd: have };
    }
    impulseNote((msg.reason || 'импульс') + ' — собираю '
      + (have === null ? 'фисы' : money(have)));
    // Причина уйдёт в точку сбора на графике: по ней видно, кто и зачем собрал.
    collectWhy = msg.reason || 'сторож';
    const res = await act.run(null).catch(() => null) || {};
    collectWhy = '';
    if (res.reload) return { handled: true, did: 'reload', usd: have, why: res.why };
    const did = !res.ok ? 'fail' : res.confirmed ? 'collected' : 'sent';
    if (did !== 'fail') tell({ type: 'collected', label: msg.label, usd: have, reason: msg.reason });
    else tell({ type: 'collected', label: msg.label, why: (msg.reason || 'сбор') + ': ' + res.why });
    return { handled: true, did, usd: have, why: res.why };
  }

  /**
   * Загрузить в Manage позиции нужного токена и дождаться, пока страница их
   * покажет. ID берём из данных самого сайта — открывать пулы руками не надо.
   */
  const HUMAN_QUIET = 5 * 60000;   // столько считаем, что человек ещё за страницей

  async function loadToken(chain, addr) {
    // Видимую вкладку не подменяем никогда. Человек может смотреть в неё и
    // не кликать — по времени это неотличимо от заброшенной, а подмена
    // содержимого прямо на глазах хуже всего. Пусть этим займётся фоновая.
    if (document.visibilityState === 'visible') return null;
    // И даже фоновую не трогаем сразу после его работы в ней.
    if (Date.now() - humanAt < HUMAN_QUIET) return null;
    // Вкладку мог открыть сторож секунду назад — разметки ещё нет. Ждём её,
    // иначе загрузка отваливается сразу же и выглядит как «не сработало».
    let input = null;
    let load = null;
    for (let i = 0; i < 40; i++) {
      input = idsInput();
      load = loadButton();
      if (input && load) break;
      await wait(300);
    }
    if (!input || !load) return null;

    const t = { chain, addr, label: '' };
    const ids = mergeIds(idSetsFor(t));
    if (!ids.length) return null;

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ids.join(', '));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    tap(load);

    // Ждём, пока на странице появится именно этот токен: раньше можно было
    // нажать «собрать» по ещё не сменившемуся списку.
    for (let i = 0; i < 40; i++) {
      await wait(300);
      const now = pageToken();
      if (now && now.addr.toLowerCase() === addr) return now;
    }
    return null;
  }

  /** Убрать все уровни по токену: после закрытия им не по чему срабатывать. */
  function clearTakes(chain, addr, why) {
    const key = chain + ':' + String(addr).toLowerCase();
    const box = { ...(S.takeLevels || {}) };
    if (!box[key]) return;
    const n = box[key].length;
    delete box[key];
    S.takeLevels = box;
    takesChanged();
    impulseNote(why + ' — снял уровней: ' + n);
  }

  /** Сказать воркеру, чем кончилось: уведомление шлёт он. */
  function tell(msg) {
    try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); }
    catch (e) { /* контекст расширения перезагрузили */ }
  }

  /**
   * Плашка «вышла новая версия».
   *
   * Расширение стоит распакованным, и Chrome его не обновляет: без такой
   * плашки человек просто живёт со старой версией. Номер приносит воркер,
   * он же ходит на GitHub; тут только показываем и открываем страницу
   * релиза по клику.
   */
  function showUpd(box) {
    if (!ui || !ui.upd) return;
    let have = '';
    try { have = chrome.runtime.getManifest().version; } catch (e) { have = ''; }
    const ver = box && box.ver;
    const fresh = !!(ver && have && cmpVer(ver, have) > 0);
    ui.upd.hidden = !fresh;
    if (!fresh) return;
    ui.upd.textContent = 'вышла версия ' + ver + ' ↗';
    ui.upd.title = 'У тебя ' + have + '. Нажми — откроется страница релиза;'
      + BR + 'дальше: распаковать архив поверх своей папки и нажать'
      + BR + '«перезапустить» в настройках расширения (значок ⚙ в Chrome).';
    ui.upd.dataset.url = (box && (box.url || box.page)) || '';
  }

  /** «3.31.0» против «3.4.1»: сравниваем числами, а не строками. */
  function cmpVer(a, b) {
    const x = String(a || '').split(/[^\d]+/).filter((v) => v !== '');
    const y = String(b || '').split(/[^\d]+/).filter((v) => v !== '');
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (Number(x[i]) || 0) - (Number(y[i]) || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  /**
   * Признак жизни для сторожа: на каком шаге страница прямо сейчас.
   *
   * Без него сторож видит только «взялась и молчит» и не может отличить
   * долгий сбор от замороженной Chrome вкладки. Раньше вкладка, которую
   * усыпили, съедала повод за поводом сутками, и фисы так и висели.
   */
  function beat(step) {
    try {
      chrome.runtime.sendMessage({ type: 'llStep', step: String(step || '') },
                                 () => void chrome.runtime.lastError);
    } catch (e) { /* контекст расширения перезагрузили */ }
  }

  /** Короткая строка в шапке: почему окно вдруг само что-то нажало. */
  function impulseNote(text) {
    beat(text);
    if (!ui || !ui.depthAll) return;
    ui.depthAll.hidden = false;
    ui.depthAll.textContent = text;
    ui.depthAll.title = 'Сообщение сторожа импульса. Настройки — в ⚙.';
    setTimeout(() => { domDirty = true; pushLevels(); }, 12000);
  }

  function siteButton(t) {
    const load = loadButton();
    const old = document.getElementById('llc-merge');
    if (!load || !t) { if (old) old.remove(); return; }

    const act = mergeAction(t);
    if (!act) { if (old) old.remove(); return; }

    let btn = old;
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'llc-merge';
      btn.type = 'button';
      load.parentElement.insertBefore(btn, load.nextSibling);
    }
    btn.style.cssText =
      'margin-left:8px;padding:6px 12px;border:0;border-radius:8px;'
      + 'font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
      + (act.disabled
        ? 'background:#21262d;color:#6e7681;cursor:default;'
        : 'background:#1f6feb;color:#fff;cursor:pointer;');
    btn.textContent = act.label;
    btn.title = act.hint;
    btn.onclick = act.disabled ? null : () => act.run(btn);
  }

  /**
   * Кнопки пересобираются только когда меняется их набор. Раньше они
   * создавались заново каждые три секунды — и если пересоздание попадало
   * между нажатием и отпусканием мыши, клик не случался вовсе: узел, на
   * котором нажали, уже удалён.
   */
  function showActions(t) {
    if (!ui || !ui.acts) return;

    const list = t ? siteActions(t) : [];
    ui.acts.hidden = !list.length;
    if (!list.length) return;

    // узлы создаются один раз, дальше только правим надписи
    if (ui.acts.children.length !== list.length) {
      ui.acts.textContent = '';
      for (let i = 0; i < list.length; i++) {
        const b = document.createElement('button');
        b.className = 'btn act';
        b.addEventListener('click', () => { if (b.__run) b.__run(b); });
        ui.acts.appendChild(b);
      }
    }

    const nodes = [...ui.acts.children];
    list.forEach((a, i) => {
      const b = nodes[i];
      b.dataset.label = a.label;
      if (b.textContent !== a.label && !b.dataset.busy) b.textContent = a.label;
      b.title = a.hint;
      b.classList.toggle('off', !!a.disabled);
      b.__run = a.disabled ? null : a.run;
    });
  }

  /*
   * Ликвидность самого пула. Сайт её не отдаёт — берём у GMGN запросом из
   * сервис-воркера: он ходит от имени расширения, а не как сторонний, и
   * поэтому не упирается в бот-защиту. Обновляем нечасто, цифра медленная.
   */
  const liqCache = new Map();   // токен -> { pools, at }

  function showLiquidity(t) {
    if (!ui || !ui.liq) return;
    if (!t) { ui.liq.hidden = true; return; }

    const k = keyOf(t);
    const box = liqCache.get(k);
    const fresh = box && Date.now() - box.at < 60000;

    if (!fresh) {
      liqCache.set(k, { pools: box ? box.pools : null, at: Date.now() });
      try {
        chrome.runtime.sendMessage({ type: 'poolFee', chain: t.chain, addr: t.addr }, (r) => {
          if (chrome.runtime.lastError || !r || !r.ok) return;
          const pools = (r.data && r.data.list) || [];
          liqCache.set(k, { pools, at: Date.now() });
          if (active() && keyOf(active()) === k) paintLiquidity(pools);
        });
      } catch (e) { /* расширение перезагрузили */ }
    }

    if (box && box.pools) paintLiquidity(box.pools);
  }

  /**
   * Какие полосы показывать. Пул лаунчпада набирает ликвидность сам из
   * торгов и перевешивает остальные в разы, поэтому его можно отключить —
   * тогда видно только то, что в токен завели руками.
   */
  function pickBands(d) {
    if (!d) return null;
    if (S.addedOnly) {
      return Array.isArray(d.bandsAdded) && d.bandsAdded.length ? d.bandsAdded : null;
    }
    return Array.isArray(d.bands) && d.bands.length ? d.bands : null;
  }

  /** Состояние глубины — в шапке, а не на канвасе: там его не разглядеть. */
  function showDepthState(levels, d) {
    if (!ui || !ui.depth) return;
    let text = null;
    let bad = false;
    const box = depthCache.get(keyOf(active() || {})) || {};
    const shown = pickBands(d);
    const pct = Math.max(1, Number(S.nearPct) || 25) / 100;
    if (shown) {
      const val = (b) => b.usd || b.quote || 0;
      const total = shown.reduce((sum, b) => sum + val(b), 0);
      // «У цены» должно значить «у цены»: считаем то, что лежит в заданном
      // проценте от неё. Всё окно — это примерно впятеро в обе стороны, и
      // называть его так нельзя.
      // Считаем не полосы целиком, а их долю внутри окна: полоса от −5 % до
      // +400 % задевает край ±10 % и целиком в него не попадает. Так же
      // считает воркер в разборе LP — иначе цифры расходились втрое.
      const lo = d.price * (1 - pct);
      const hi = d.price * (1 + pct);
      const near = shown.reduce((sum, b) => {
        const over = Math.min(hi, b.hi) - Math.max(lo, b.lo);
        return over > 0 && b.hi > b.lo ? sum + val(b) * (over / (b.hi - b.lo)) : sum;
      }, 0);
      text = 'у цены ±' + Math.round(pct * 100) + '% ' + money(near)
        + (box.stale ? ' · обновляю' : '');
      d.__near = near;
      d.__total = total;
    }
    else if (S.addedOnly && d && Array.isArray(d.bands) && d.bands.length) {
      text = 'заведено вручную: пусто'; bad = true;
    }
    else if (levels.needRpc) { text = 'глубина: нужен RPC'; bad = true; }
    else if (levels.depthError) { text = 'глубина: ' + levels.depthError; bad = true; }
    else if (levels.depthWait) text = 'глубина: читаю цепь…';

    // Вторая цифра — сколько в токен залили люди и сколько лежит в пуле
    // лаунчпада, по всем пулам целиком (GeckoTerminal). Раньше тут было
    // «весь токен: заведено», хотя считалось только окно ±5× от цены, а
    // лесенки Liquidity Ladder туда не попадали вовсе — отсюда и «ликва
    // неправильно считается» на BLAST.
    if (ui.depthAll) {
      const cur = active();
      const tv = cur ? askTvl(cur) : null;
      if (tv && tv.ok && Number.isFinite(tv.people) && Number.isFinite(tv.total)) {
        ui.depthAll.hidden = levels.depthOff === true;
        ui.depthAll.textContent = 'залили люди ' + money(tv.people)
          + (Number(tv.launchpad) > 0 ? ' · лаунчпад ' + money(Number(tv.launchpad)) : '');
        ui.depthAll.title = 'Вся ликвидность токена по ' + tv.pools + ' пулам, целиком: '
          + money(tv.total) + '.' + BR
          + 'Залили люди — все пулы, кроме пула лаунчпада (он набирает сам из торгов).' + BR
          + (tv.sure ? '' : 'Пул лаунчпада не опознан — всё посчитано как «люди».' + BR)
          + 'Крупнейшие: ' + (tv.top || []).map((p) => p.name + ' ' + money(Number(p.usd) || 0)
            + (p.launchpad ? ' (лаунчпад)' : '')).join(BR + '            ') + BR
          + 'Источник — GeckoTerminal, обновляется раз в 10 минут.';
      } else {
        const has = d && d.addedUsd !== undefined && !levels.depthOff;
        ui.depthAll.hidden = !has;
        if (has) {
          ui.depthAll.textContent = 'залили люди ≥' + money(d.addedUsd);
          ui.depthAll.title = 'Пока нет данных GeckoTerminal — это только то, что видно из цепи'
            + ' в окне ±5× от цены. Всего в пулах может быть больше.';
        }
      }
    }

    ui.depth.hidden = !text;
    if (!text) return;
    ui.depth.className = 'depth' + (bad ? ' bad' : '');
    ui.depth.textContent = text;
    ui.depth.title = d && d.__near !== undefined
      ? 'Ликвидность в пределах ±' + Math.round(pct * 100) + ' % от цены: '
        + money(d.__near) + BR
        + 'Во всём окне (примерно впятеро вверх и вниз): ' + money(d.__total) + BR
        + 'Пулы токена складываются на одну шкалу цены: посчитано '
        + (d.counted || '?') + ' из ' + (d.pools || '?') + ' созданных. Мелкие пулы '
        + 'пропускаются — их доля меньше трёх процентов, а чтение стоит дорого.' + BR
        + (Array.isArray(d.parts) && d.parts.length
            ? 'Где лежат деньги: ' + d.parts
                .map((p) => (p.symbol || p.quote.slice(0, 8) + '…') + ' ' + money(p.usd))
                .join(', ') + BR
            : '')
        + (d.addedUsd !== undefined
            ? 'Завели руками: ' + money(d.addedUsd) + ' в ' + (d.addedPools || 0)
              + ' пул(ах), остальное набрал сам пул лаунчпада.' + BR
            : '')
        + (Array.isArray(d.perPool) && d.perPool.length
            ? 'По пулам: ' + d.perPool
                .map((p) => (p.fee === null ? 'дин. комиссия' : p.fee + '%') + ' против ' + (p.symbol || p.quote.slice(0, 8) + '…')
                  + ' ' + money(p.usd))
                .join(BR + '            ') + BR
            : '')
        + 'Обновляется раз в ' + (S.depthSec || 90) + ' секунд.'
        + (d.fee !== undefined ? BR + 'комиссия пула ' + (d.fee === null ? 'динамическая' : d.fee + '%') : '')
        + (d.poolId ? BR + 'пул ' + d.poolId : '')
      : text;
  }

  function paintLiquidity(pools) {
    if (!ui || !ui.liq) return;
    const total = pools.reduce((sum, p) => sum + (Number(p.liquidity) || 0), 0);
    if (!total) { ui.liq.hidden = true; return; }
    ui.liq.hidden = false;
    ui.liq.textContent = 'ликв. ' + money(total);
    ui.liq.title = 'Ликвидность самого пула, не твоя.' + BR
      + pools.map((p) => (p.exchange || 'пул') + ' — ' + money(Number(p.liquidity) || 0)
        + (p.fee_ratio ? ', комиссия ' + p.fee_ratio + '%' : '')).join(BR)
      + BR + 'Источник — GMGN. Распределение по цене он не отдаёт.';
  }

  /*
   * Глубина всего пула — сколько ликвидности стоит на каждом уровне цены.
   * Считает сервис-воркер: читает пул на цепи через StateView. Ни Liquidity
   * Ladder, ни GMGN такого не отдают, только суммарную цифру.
   */
  // Числа из шапки GMGN по каждой вкладке: объём за сутки и его ликвидность.
  const headOf = new Map();
  const depthCache = new Map();
  let rpcSet = false;

  /**
   * Забыть посчитанную ликвидность по токену и перечитать её заново.
   * Зовём после обновления фисов: раз уж пересчитались деньги позиции,
   * цифры по пулу рядом с ними не должны оставаться девяностосекундной
   * давности.
   */
  function refreshLiquidity(t) {
    const target = t || active();
    if (!target) return;
    const k = keyOf(target);
    depthCache.delete(k);
    liqCache.delete(k);
    domDirty = true;
    fetchDepth(target, () => { domDirty = true; pushLevels(); });
    showLiquidity(target);
  }

  function fetchDepth(t, onReady) {
    const k = keyOf(t);
    const box = depthCache.get(k);
    if (box && Date.now() - box.at < Math.max(30, Number(S.depthSec) || 90) * 1000) {
      return box.data;
    }
    // Молчаливых веток тут быть не должно: не ответил воркер — так и скажем,
    // иначе на графике просто пусто и непонятно, чего ждать.
    depthCache.set(k, { data: box ? box.data : null, err: null, pending: true, at: Date.now() });
    try {
      chrome.runtime.sendMessage({ type: 'depth', chain: t.chain, addr: t.addr }, (r) => {
        const lost = chrome.runtime.lastError;
        const prev = depthCache.get(k);
        const good = r && r.ok && Array.isArray(r.bands) && r.bands.length;
        depthCache.set(k, {
          // неудачное обновление не должно стирать то, что уже показано:
          // полосы пропадали на ровном месте и было непонятно, что случилось
          data: good ? r : (prev && prev.data) || null,
          stale: !good && !!(prev && prev.data),
          err: lost ? 'воркер не ответил: ' + lost.message
            : (r && !r.ok ? r.error
              : (r && r.ok && !good ? 'в пуле нет ликвидности рядом с ценой' : null)),
          at: Date.now(),
        });
        if (onReady) onReady();
      });
    } catch (e) {
      // Раньше тут всегда писалось «обнови страницу», даже когда страницу
      // уже обновили и дело было в другом. Говорим как есть: оборвалась
      // связь с расширением — тогда да, обновить; иначе — сам текст ошибки.
      const msg = String(e && e.message || e);
      const orphan = /context invalidated|Extension context/i.test(msg)
        || !(chrome.runtime && chrome.runtime.id);
      depthCache.set(k, { data: null, at: Date.now() - 60000,   // повтор через ~30 с, а не через 90
        err: orphan ? 'расширение обновилось после этой страницы — обнови её (Cmd+R)'
          : 'запрос не ушёл: ' + msg });
    }
    return box ? box.data : null;
  }

  function pushLevels() {
    launcher();                       // это дёшево: ни выборок, ни раскладки

    const t = active();
    const dirty = domDirty || lastLevels === null;
    if (!dirty && (!S.open || S.min)) return;   // ничего не менялось и смотреть некому

    openTick();                       // одна пачка чтений раскладки на весь проход

    if (dirty) {
      siteButton(pageToken());
      autoMerge();
      showActions(t);
    }

    if (!t) { badge(null); showNumbers(null); showLiquidity(null); return; }

    // Дорогой разбор страницы: пока окно закрыто, он не нужен никому.
    if (!S.open || S.min || !dirty) return;
    domDirty = false;

    const f = frames.get(keyOf(t));
    const levels = readLevels(t);
    if (levels) {
      levels.showMine = S.mine === true;
      levels.depthThin = S.depthThin !== false;
      if (S.sizeOn === false) levels.sizeOff = true;
      askSupply(t);
      // Выпуск нужен графику, чтобы сказать не только «сколько токенов», но
      // и какую долю всего токена ты держишь: в штуках это ничего не значит.
      // Ключ тот же, под которым выпуск кладёт askSupply. Раньше здесь был
      // keyOf с косой чертой вместо двоеточия — выпуск не находился никогда,
      // и процент саплая на графике не появлялся.
      levels.supply = Number(supplyCache[t.chain + ':' + String(t.addr).toLowerCase()]) || 0;
      levels.collects = collects[t.chain + ':' + String(t.addr).toLowerCase()] || [];
      // Фисы в штуках и вложенное — для подписи мешка и безубытка.
      askPosFees(t);
      const pf = posFeesCache[t.chain + ':' + String(t.addr).toLowerCase()];
      if (pf && pf.quotes) {
        levels.feeTok = Number(pf.token) || 0;
        levels.feeQuotes = pf.quotes;
      }
      // Фисы и PnL — те же, что в шапке: панель «Fees & PnL», если она про
      // этот токен, иначе карточка. PnL сайта ВКЛЮЧАЕТ фисы — проверено на
      // TWINE: ступени $3 991 + несобрано $16.17 + собрано $24.02 − PnL
      // $30.82 = $4 000.37, ровно вложенные $4 000. Раньше фисы прибавлялись
      // второй раз, и безубыток уезжал далеко вниз.
      const nums = feeNumbers(t);
      if (nums) {
        levels.unclaimedUsd = nums.unclaimed;
        levels.claimedUsd = nums.claimed;
        // Карточка с бэкенда и ступени со страницы — из разного времени;
        // безубыток по ним считаем, только когда числа из панели.
        if (nums.pnl !== null && !levels.cached && nums.from === 'panel') levels.pnlSite = nums.pnl;
        levels.feesFrom = nums.from;
      }
      levels.fromCache = !!levels.cached;
      levels.takes = takesFor(t);
      levels.arm = S.watchOn === true && edgeArmed()
        ? { hi: S.edgeHi === true, lo: S.edgeLo === true, pct: Number(S.edgePct) || 0 }
        : null;
      levels.showBounds = S.bounds !== false;
      if (S.depthOn === false) { delete levels.depth; levels.depthOff = true; }
    }
    const d = fetchDepth(t, () => { domDirty = true; pushLevels(); });
    // Цена со страницы — это цена в пуле ТВОЕГО леддера. Если через него
    // прошла покупка сквозь все ступени, а выше никого не было, его цена
    // улетает в потолок (у SWARM было 3·10⁵⁰). Сделок и фисов в таком пуле
    // нет. Так и говорим, а рисуем по рыночной цене из цепи.
    const pc = levels ? Number(levels.current) : NaN;
    if (levels && pc > 0 && !(pc < 1e7 && pc > 1e-15)) {
      levels.poolDead = true;
      levels.current = null;
    }
    // Токена нет на странице — цены с неё тоже нет. Берём цену пула из цепи,
    // её уже прочитал расчёт глубины.
    if (levels && !(Number(levels.current) > 0) && Number(d && d.price) > 0) {
      levels.current = Number(d.price);
    }
    if (levels && levels.fromPairs) orientEnvelope(levels);
    // Что лежит в ступенях, решает цена в пуле самой лесенки, а не на рынке и
    // не то, что пишет сайт: у TWINE сайт писал «в диапазоне», а пул стоял на
    // предельном тике и всё было продано. Состав считаем по пулу из цепи,
    // подписи «на сколько выше» — по рынку.
    const pool = levels && (posFeesCache[t.chain + ':' + String(t.addr).toLowerCase()] || {}).pool;
    if (levels && pool && Array.isArray(levels.positions) && levels.positions.length) {
      const lo = Math.min(...levels.positions.map((r) => r[0]));
      const hi = Math.max(...levels.positions.map((r) => r[1]));
      if (pool.dead) {
        levels.poolDead = true;
        levels.poolPrice = Number(pool.price) > hi ? hi * 1.001 : lo * 0.999;
        if (Number(d && d.price) > 0) levels.current = Number(d.price);
      } else if (Number(pool.price) > 0 && !(Number(levels.current) > 0)) {
        // Пул живой, а цены со страницы нет (токен не открыт в Manage).
        // Цена из цепи может отставать на минуты, поэтому только как запасная.
        levels.poolPrice = Number(pool.price);
        levels.current = Number(d && d.price) > 0 ? Number(d.price) : Number(pool.price);
      }
    }
    if (levels) {
      const shown = pickBands(d);
      if (shown) {
        levels.depth = shown;
        levels.poolFee = d.fee;
        levels.depthPrice = d.price;    // от неё считаются накопленные суммы
      } else if (!rpcSet) {
        levels.needRpc = true;      // молчать про это нельзя, иначе непонятно
      } else {
        const box = depthCache.get(keyOf(t));
        if (box && box.err) levels.depthError = box.err;
        else if (!box || box.pending) levels.depthWait = true;
      }
    }
    // Плашки обновляем и там, где леддера на странице нет: иначе они
    // застывали с цифрами прошлого токена.
    showDepthState(levels || {}, d);
    lastLevels = levels;
    badge(levels);
    showNumbers(t);
    showLiquidity(t);
    // Пока фрейм не отозвался, он сидит на about:blank и наследует origin
    // этой страницы: сообщение с целевым origin gmgn.ai просто пропадёт,
    // а Chrome запишет ошибку. Ждём объявления.
    if (!f || !f.ready || !f.iframe.contentWindow) return;
    f.iframe.contentWindow.postMessage(
      { __ghoLL: true, type: 'levels', levels },
      'https://gmgn.ai',
    );
    f.iframe.contentWindow.postMessage(
      { __ghoLL: true, type: 'ui', showPanel: S.panel !== false },
      'https://gmgn.ai',
    );
  }

  function badge(levels) {
    if (!ui || !ui.badge) return;
    if (!levels || !Array.isArray(levels.positions) || !levels.positions.length) {
      ui.badge.hidden = true;
      return;
    }
    // Положение лесенки решает цена в её пуле; нет её — цена со страницы.
    // Пустая цена — «не знаем», а не ноль: иначе выходило «ниже диапазона».
    const px = Number(levels.poolPrice) > 0 ? Number(levels.poolPrice) : Number(levels.current);
    if (!(px > 0)) { ui.badge.hidden = true; return; }
    const lo = Math.min(...levels.positions.map((r) => r[0]));
    const hi = Math.max(...levels.positions.map((r) => r[1]));
    const out = px < lo || px > hi;
    ui.badge.hidden = false;
    ui.badge.className = 'badge' + (out ? ' out' : '');
    ui.badge.textContent = levels.poolDead
      ? (px < lo ? 'пул стоит ниже леддера' : 'пул стоит выше леддера')
      : out ? (px < lo ? 'ниже диапазона' : 'выше диапазона') : 'в диапазоне';
    ui.badge.title = 'Цена в пуле твоего леддера относительно его границ.\n'
      + 'Диапазон ' + lo + ' … ' + hi + ', сейчас ' + px
      + '\nЗа границами позиции перестают собирать комиссию.';
  }

  // ---------- вкладки ----------

  /**
   * Запомнить пул как текущий. Показывать окно — только по явному жесту
   * (кнопка-ярлык или клик по иконке GMGN): иначе закрытое окно вылезало
   * обратно от любого клика по сайту, а свёрнутое разворачивалось само.
   */
  function openWith(t, explicit) {
    const k = keyOf(t);
    const i = S.tabs.findIndex((x) => keyOf(x) === k);
    if (i === -1) {
      S.tabs.push(t);
      while (S.tabs.length > MAX_TABS) dropTab(keyOf(S.tabs[0]), true);
    } else {
      S.tabs[i].label = t.label;
    }
    S.active = k;
    if (explicit) { S.open = true; S.min = false; domDirty = true; }
    save();
    render();
  }

  // Ярлык внизу справа: единственный способ поднять окно, если ты его закрыл
  function launch() {
    if (!S.active) {
      const seen = [];
      for (const a of anchors()) {
        const t = parseLink(a);
        if (t && !seen.some((x) => keyOf(x) === keyOf(t))) seen.push(t);
      }
      if (seen.length === 1) { openWith(seen[0], true); return; }
      if (!S.tabs.length) return;
      S.active = keyOf(S.tabs[S.tabs.length - 1]);
    }
    S.open = true;
    S.min = false;
    domDirty = true;
    save();
    render();
  }

  function dropTab(k, quiet) {
    S.tabs = S.tabs.filter((x) => keyOf(x) !== k);
    const f = frames.get(k);
    if (f) { f.wrap.remove(); frames.delete(k); }
    if (S.active === k) S.active = S.tabs.length ? keyOf(S.tabs[S.tabs.length - 1]) : null;
    if (!S.tabs.length) S.open = false;
    if (!quiet) { save(); render(); }
  }

  // ---------- окно ----------

  const CSS = `
:host { all: initial; }
/* Атрибут hidden прячет через display:none из браузерного стиля, а любое
   наше display: flex его перебивает. Из-за этого меню настроек не
   закрывалось вообще никогда. Ставим правило на весь компонент. */
[hidden] { display: none !important; }
.win {
  position: fixed; z-index: 2147483000;
  display: flex; flex-direction: column;
  background: #0d1117; color: #c9d1d9;
  border: 1px solid #30363d; border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0,0,0,.6);
  font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  overflow: hidden;
}
.win.min { height: auto !important; }
.win.min .body, .win.min .grip, .win.min .menu { display: none; }
.bar { display: flex; align-items: center; gap: 6px; padding: 5px 6px; background: #161b22; cursor: move; user-select: none; }
.tabs { display: flex; gap: 4px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.tabs::-webkit-scrollbar { display: none; }
.tab { display: flex; align-items: center; gap: 5px; padding: 3px 6px; border-radius: 5px;
       background: #21262d; color: #8b949e; cursor: pointer; white-space: nowrap; max-width: 170px; }
.tab.on { background: #1f6feb; color: #fff; }
.tab b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.tab .x { opacity: .55; padding: 0 1px; }
.tab .x:hover { opacity: 1; }
.tools { display: flex; align-items: center; gap: 3px; }
.badge { padding: 3px 7px; border-radius: 5px; white-space: nowrap;
         background: rgba(74,222,128,.15); color: #4ade80; }
.badge.out { background: rgba(248,113,113,.16); color: #f87171; }
.fees { padding: 3px 7px; border-radius: 5px; white-space: nowrap;
        background: rgba(251,191,36,.14); color: #fbbf24; }
.liq { padding: 3px 7px; border-radius: 5px; white-space: nowrap;
       background: rgba(148,163,184,.16); color: #cbd5e1; }
.depth { padding: 3px 7px; border-radius: 5px; white-space: nowrap; max-width: 320px;
         overflow: hidden; text-overflow: ellipsis;
         background: rgba(96,165,250,.16); color: #93c5fd; }
.depth.bad { background: rgba(248,113,113,.16); color: #f87171; }
.depth.all { background: rgba(148,163,184,.14); color: #a8b3c0; }
.upd { padding: 3px 7px; border-radius: 5px; white-space: nowrap; cursor: pointer;
       background: rgba(52,211,153,.16); color: #34d399; }
.upd:hover { background: rgba(52,211,153,.3); }
.pnl { padding: 3px 7px; border-radius: 5px; white-space: nowrap;
       background: rgba(74,222,128,.14); color: #4ade80; }
.pnl.minus { background: rgba(248,113,113,.14); color: #f87171; }
.acts { display: flex; gap: 3px; }
.act { background: #1c2431; color: #9fb3c8; }
.act:hover { background: #26313f; color: #d7e3ef; }
.act { min-width: 96px; text-align: center; }
.act.off { opacity: .4; cursor: default; }
.act.off:hover { background: #1c2431; color: #9fb3c8; }
/* Настроек набралось на добрую тысячу пикселей — в окно они не влезают,
   и без прокрутки нижние просто уезжали за край и были недоступны. */
.menu { position: absolute; top: 34px; right: 6px; z-index: 4;
        padding: 10px 12px; background: #11161d; border: 1px solid #30363d;
        border-radius: 8px; box-shadow: 0 12px 30px rgba(0,0,0,.6);
        display: flex; flex-direction: column; gap: 8px; color: #b8c2cc;
        max-height: calc(100% - 46px); overflow-y: auto; overscroll-behavior: contain;
        /* Без ширины панель растягивалась длинными подписями на пол-экрана */
        width: 330px; max-width: calc(100% - 14px); box-sizing: border-box; }
.menu::-webkit-scrollbar { width: 8px; }
.menu::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
.menu::-webkit-scrollbar-track { background: transparent; }
.menu label { display: flex; align-items: center; gap: 7px; cursor: pointer;
              flex-wrap: wrap; }
.menu label b { color: #d7e3ef; }
.menu input { margin: 0; }
.menu .note { color: #6e7681; }
.menu .more-head { cursor: pointer; user-select: none; }
.menu .more-head:hover { color: #b8c2cc; }
.menu .more { display: flex; flex-direction: column; gap: 8px;
              padding-left: 10px; border-left: 2px solid #21262d; }
.menu .state { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
               white-space: pre-line; line-height: 1.5; }
.menu .state.bad { color: #f87171; }
.menu .row { display: flex; gap: 6px; flex-wrap: wrap; }
.menu .row.pair { padding-left: 16px; gap: 14px; }
.menu .row.pair label { padding-right: 0; }
.menu .mx { position: absolute; top: 6px; right: 6px; padding: 2px 7px; }
.menu label { padding-right: 26px; }
.menu .tiny { padding: 1px 6px; font-size: 10px; margin-left: 4px; }
.menu .toks { display: flex; flex-direction: column; gap: 6px; }
.menu .toks label { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; padding-right: 0; }
.menu .toks .none { color: #6e7681; }
.menu .toks label { justify-content: flex-start; }
.menu .toks .top { margin-left: auto; color: #8b949e; }
.menu .num.wide { width: 104px; }
.menu .lvls { display: flex; flex-wrap: wrap; gap: 4px; }
.menu .lvls .chip { display: flex; align-items: center; gap: 5px; padding: 2px 6px;
                    background: rgba(251,191,36,.14); color: #fbbf24; border-radius: 5px;
                    font: 11px ui-monospace, Menlo, monospace; }
.menu .lvls .chip b { cursor: pointer; color: #f87171; font-weight: 700; }
.menu .lvls .chip.close { background: rgba(248,113,113,.16); color: #f87171; }
.menu .lvls .none { color: #6e7681; }
.menu .edges { display: flex; flex-direction: column; gap: 5px; }
.menu .edges label { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
                     padding-right: 0; justify-content: flex-start; }
.menu .edges .side { margin-left: auto; color: #8b949e; }
.menu .edges .none { color: #6e7681; }
.menu .num { width: 58px; padding: 2px 4px; background: #0d1117; color: #c9d1d9;
             border: 1px solid #30363d; border-radius: 5px; font: 12px ui-monospace, Menlo, monospace; }
.menu .rpc { width: 190px; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.menu label { display: flex; align-items: center; gap: 7px; }
.menu .probe { color: #8b949e; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.btn { border: 0; background: #21262d; color: #c9d1d9; border-radius: 5px; padding: 3px 7px;
       cursor: pointer; font: inherit; line-height: 1.4; }
.btn:hover { background: #30363d; }
.btn.on { background: #1f6feb; color: #fff; }
select.btn { padding: 3px 4px; }
.body { position: relative; flex: 1; background: #0d1117; overflow: hidden; }
.pane { position: absolute; inset: 0; overflow: hidden; }
.pane[hidden] { display: none; }
.pane iframe { border: 0; display: block; transform-origin: 0 0; background: #0d1117; }
.hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        color: #6e7681; text-align: center; padding: 16px; }
.grip { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; }
.grip::after { content: ''; position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px;
               border-right: 2px solid #484f58; border-bottom: 2px solid #484f58; }
.dragging iframe { pointer-events: none; }
`;

  function build() {
    const host = document.createElement('div');
    host.id = 'llc-host';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="win">
        <div class="bar">
          <div class="tabs"></div>
          <span class="badge" hidden></span>
          <span class="pnl" hidden></span>
          <span class="fees" hidden></span>
          <span class="liq" hidden></span>
          <span class="depth" hidden></span>
          <span class="depth all" hidden></span>
          <span class="upd" hidden></span>
          <div class="acts"></div>
          <div class="tools">
            <button class="btn" data-a="menu" title="Настройки окна: что показывать и в каком масштабе">⚙</button>
            <button class="btn" data-a="reload" title="Перезагрузить график заново">⟳</button>
            <button class="btn" data-a="popout" title="Открыть этот токен на gmgn.ai в новой вкладке">↗</button>
            <button class="btn" data-a="min" title="Свернуть окно до шапки. Развернуть — этой же кнопкой или Alt+G">–</button>
            <button class="btn" data-a="close" title="Закрыть окно. Вернуть — синей кнопкой GMGN внизу справа или Alt+G">×</button>
          </div>
        </div>
        <div class="menu" hidden>
          <button class="btn mx" data-a="menu" title="Закрыть настройки">×</button>
          <label title="Кликаешь по пулу или леддеру на сайте — окно запоминает этот токен. Само окно при этом не открывается">
            <input type="checkbox" data-c="follow">
            Переключать график на тот пул, по которому я кликнул</label>
          <label title="Клик по иконке GMGN у леддера открывает график здесь. Ctrl/⌘+клик всё равно откроет вкладку">
            <input type="checkbox" data-c="intercept">
            Открывать GMGN в этом окне, а не в новой вкладке</label>
          <label title="Растягивает страницу GMGN шире окна и сдвигает вверх: навигация и торговая панель уходят за края, остаются свечи">
            <input type="checkbox" data-c="crop">
            Прятать шапку и правую панель GMGN, оставлять только график</label>
          <label title="По одному токену у тебя бывает несколько леддеров — это разные пулы и разные позиции. Галка сводит их в одну таблицу сразу при открытии Manage. Выключи, если удобнее смотреть каждый леддер отдельно: кнопка «все позиции» останется, будешь сводить руками, когда надо">
            <input type="checkbox" data-c="autoLoad">
            Сводить все мои леддеры по токену в одну таблицу</label>
          <div class="note">Сторож: сам собирает фисы</div>
          <label title="Главный выключатель. Пока он снят, не работает ничего: ни импульс, ни край диапазона, ни ручные уровни. Следит за ценой даже при закрытой вкладке">
            <input type="checkbox" data-c="watchOn">
            <b>Сторож включён</b></label>
          <label title="Самое простое правило: набежало больше порога — собрал, и неважно, что там с ценой. Размер комиссий сторож спрашивает у их же API, вкладка не нужна">
            <input type="checkbox" data-c="feesOn">
            Собирать, как только накопится больше порога</label>
          <label title="Держать по фоновой вкладке на каждый открытый леддер, в отдельной свёрнутой группе. Позиция появилась — вкладка завелась, закрылась — вкладка закрылась. Тогда сбору всегда есть где сработать, и твою вкладку трогать не приходится">
            <input type="checkbox" data-c="keepTabs">
            Держать свою вкладку на каждый леддер</label>
          <label title="Вкладка заводится одна на токен, а не на леддер. 0 — по вкладке на каждый токен. Каждая вкладка — целая страница сайта, это память и её собственные запросы">
            &nbsp;&nbsp;не больше <input class="num" type="number" data-n="maxTabs" min="0" step="1"> вкладок (0 — без предела)</label>
          <label title="Срабатывать, когда цена резко идёт вверх. Ручные уровни и край диапазона от этой галки не зависят">
            <input type="checkbox" data-c="pumpOn">
            Собирать на импульсе цены</label>
          <div class="row pair" title="На сколько процентов должна вырасти цена, чтобы это считалось импульсом. Считается от самой низкой цены внутри окна">
            <label>рост от <input class="num" type="number" data-n="pumpPct" min="1" step="1"> %</label>
            <label>за <input class="num" type="number" data-n="windowMin" min="1" step="1"> мин</label>
          </div>
          <div class="note" title="Если у токена свои условия, общие на него не действуют. У спокойного пула «плюс 50% за 5 минут» не случится никогда, у свежего мема — каждый час">Свои условия пампа по токену</div>
          <div class="pumps"></div>
          <div class="row">
            <select class="btn pumptok"></select>
            <input class="num" type="number" data-p="pumpPct" min="1" placeholder="%">
            <input class="num" type="number" data-p="windowMin" min="1" placeholder="мин">
            <input class="num" type="number" data-p="fadePct" min="0" placeholder="откат">
            <button class="btn" data-a="pumpadd">задать</button>
            <button class="btn" data-a="pumpoff" title="Не собирать комиссии на пампе по этому токену. Порог, уровни и край леддера продолжат работать">не собирать на пампе</button>
          </div>
          <label title="Цена подошла к верху леддера — собрать фисы. Выше верха ступени уже проданы, и фисы там не капают. Отмеченные ниже края ступеней работают вдобавок к этой галке, а не вместо неё">
            <input type="checkbox" data-c="edgeHi">
            Автосбор фисов у ВЕРХНЕЙ границы леддера</label>
          <label title="Цена подошла к низу леддера — собрать фисы. Обычно не нужно: внизу позиция уже вся в токене">
            <input type="checkbox" data-c="edgeLo">
            Автосбор фисов у НИЖНЕЙ границы</label>
          <label title="Ширина области у границы, в которой уже пора собирать. Цена вошла в неё — сработало. Ноль — только когда цена реально вышла за границу">
            &nbsp;&nbsp;область: <input class="num" type="number" data-n="edgePct" min="0" step="1"> % от границы</label>
          <label title="Ниже этой суммы собирать невыгодно: газ съест больше, чем соберём. Поставь 0, чтобы собирать любую сумму">
            не собирать меньше $<input class="num" type="number" data-n="minUsd" min="0" step="1"></label>
          <label title="Свап не всегда проходит с первого раза: не хватило газа, цена ушла за проскальзывание, узел не ответил. Столько раз пробуем ещё, с паузами 5, 12 и 25 секунд. Каждая попытка попадает в журнал">
            повторять при неудаче <input class="num" type="number" data-n="retryTimes" min="1" max="5" step="1"> раз</label>
          <label title="Если свап срывается из-за проскальзывания, на каждом повторе поднимаем поле Slippage на сайте на столько процентов. 0 — не трогать. Больше проскальзывание — хуже цена, но выше шанс, что пройдёт">
            &nbsp;&nbsp;и поднимать проскальзывание на <input class="num" type="number" data-n="slipStep" min="0" max="20" step="1"> %</label>
          <div class="note cost"></div>
          <div class="note tabsbox" title="Сторож работает только в своих вкладках — твои он не трогает. Здесь видно, на каждый ли леддер есть живая вкладка"></div>
          <div class="row">
            <button class="btn tiny" data-a="tabsopen" title="Открыть недостающие вкладки прямо сейчас, не дожидаясь выдержки в 30 секунд">открыть вкладки</button>
            <button class="btn tiny" data-a="tabsclose" title="Закрыть все вкладки, которые открыл сторож. Твои вкладки не трогаются">закрыть свои</button>
          </div>
          <div class="note state" title="Что сторож видит прямо сейчас. Обновляется, пока открыты настройки"></div>
          <div class="row">
            <button class="btn" data-a="checkcollect" title="Проверить боевой путь автосбора: есть ли доступ к их API, свежий ли список леддеров и что собралось бы прямо сейчас. Ничего не собирает">проверить автосбор</button>
            <button class="btn" data-a="screener" title="Топ токенов Robinhood по доходности для LP — отдельной вкладкой">скринер пулов ↗</button>
          </div>
          <div class="note">На каких токенах следить
            <button class="btn tiny" data-a="tokall">все</button>
            <button class="btn tiny" data-a="toknone">никого</button></div>
          <div class="toks"></div>
          <div class="note" title="Цена дошла до уровня снизу вверх — сторож собирает фисы. Срабатывает один раз на пересечение: чтобы уровень сработал снова, цена должна уйти под него и вернуться">Ручные уровни тейка</div>
          <div class="lvls"></div>
          <div class="row">
            <select class="btn lvltok"></select>
            <select class="btn lvlunit" title="Уровень можно задать ценой или капитализацией — что удобнее скопировать">
              <option value="price">цена</option>
              <option value="mcap">мкап</option>
            </select>
          </div>
          <div class="row">
            <input class="num wide" type="text" placeholder="0.0₄45 или 140k"
                   title="Понимает и подстрочник GMGN (0.0₄4523), и обычную запись, и сокращения вроде 140k или 1.2m">
            <select class="btn lvlact" title="Что делать, когда цена дойдёт до уровня">
              <option value="fees">собрать фисы</option>
              <option value="close">закрыть позиции</option>
            </select>
            <button class="btn" data-a="lvladd">поставить</button>
            <button class="btn" data-a="lvltest" title="Прогнать цепочку по выбранному токену через страницу: загрузить позиции, пересчитать комиссии и показать, что получилось бы. Ничего не нажимает">проверить уровень</button>
          </div>
          <div class="note" title="Верх каждой ступени леддера. Цена прошла его — ступень целиком вышла из диапазона и комиссию больше не собирает. Отметь те, на которых хочешь забирать фисы">Верхние края ступеней
            <button class="btn tiny" data-a="edgeall">все</button>
            <button class="btn tiny" data-a="edgenone">никого</button></div>
          <div class="row" title="Срабатывать не ровно на крае ступени, а со смещением. Минус — раньше края, плюс — за ним. Ноль — ровно на крае">
            сместить на <input class="num" type="number" data-n="edgeShift" step="1"> %
            <select class="btn edgeact" title="Что делать, когда цена дойдёт до отмеченного края">
              <option value="fees">собрать фисы</option>
              <option value="close">закрыть позиции</option>
            </select>
          </div>
          <div class="edges"></div>
          <div class="note more-head" data-a="more"></div>
          <div class="more" hidden>
          <label title="Как часто спрашивать размер комиссий. Это отдельный запрос к их сайту, чаще раза в полминуты смысла нет">
            &nbsp;&nbsp;проверять комиссии раз в <input class="num" type="number" data-n="feesSec" min="10" step="10"> с</label>
          <label title="Цену и границы сторож проверяет на каждом опросе — это один запрос к узлу. А чтобы узнать размер комиссий, надо лезть на страницу и жать «Update Fees», а это несколько секунд работы сайта. Цена у границы может стоять часами, поэтому на страницу ходим с этим шагом, а не каждую секунду. Поставь 0, чтобы ходить на каждом опросе">
            ходить на страницу раз в <input class="num" type="number" data-n="quietSec" min="0" step="1"> с</label>
          <label title="Как часто спрашивать цену. Все токены читаются одной пачкой, поэтому обращение к узлу одно независимо от их числа. Блок в этой сети — 0.1 секунды, так что чаще раза в секунду смысла нет">
            спрашивать цену раз в <input class="num" type="number" data-n="everySec" min="1" step="1"> с</label>
          <label title="Собираем, пока цена держится у пика. Если она уже откатилась от вершины больше чем на столько — памп кончился, и собирать в падение мы не станем. Ноль — только на самом пике">
            &nbsp;&nbsp;и цена не ниже пика на <input class="num" type="number" data-n="fadePct" min="0" step="1"> %</label>
          </div>
          <div class="note">Что рисовать на графике</div>
          <label title="Синие полосы слева: сколько денег стоит на каждом уровне цены во всём пуле">
            <input type="checkbox" data-c="depthOn"> Глубину пула</label>
          <label title="Тонкие штрихи вместо залитых полос: видно свечи под глубиной, и уровни не сливаются в сплошную заливку">
            <input type="checkbox" data-c="depthThin"> Глубину рисовать тонкими штрихами</label>
          <label title="Как часто пересчитывать глубину пула. Это самая дорогая операция: около 1800 обращений к узлу за раз. Реже — дешевле">Пересчитывать глубину раз в
            <select class="btn" data-a="depthsec">
              <option value="90">90 с</option>
              <option value="180">3 мин</option>
              <option value="300">5 мин</option>
              <option value="900">15 мин</option>
            </select></label>
          <label title="Что считать ликвидностью «у цены»: насколько далеко в обе стороны от текущей цены смотреть">Считать «у цены» в пределах
            <select class="btn" data-a="near">
              <option value="10">±10%</option>
              <option value="25">±25%</option>
              <option value="50">±50%</option>
              <option value="100">±100%</option>
            </select></label>
          <label title="Пул лаунчпада набирает ликвидность сам из торгов, и он обычно в разы больше остальных. Галка убирает его и оставляет только то, что в токен завели руками">
            <input type="checkbox" data-c="addedOnly"> Только добавленную ликвидность, без пула лаунчпада</label>
          <label title="Заливка ступеней твоего леддера: жёлтая — держим токен, зелёная — ждут деньги">
            <input type="checkbox" data-c="mine"> Мои ступени леддера</label>
          <label title="Сколько твоих денег стоит в диапазоне, с разбивкой по текущей цене: ниже — ждут покупки, выше — ждут продажи">
            <input type="checkbox" data-c="sizeOn"> Сумму моих позиций</label>
          <label title="Две линии по краям леддера. За ними позиции перестают собирать комиссию">
            <input type="checkbox" data-c="bounds"> Границы леддера</label>
          <label title="Горизонтали на уровнях входа топ-холдеров. Их много, и они спорят с остальными линиями">
            <input type="checkbox" data-c="holders"> Линии входа холдеров</label>
          <label title="Клик по сайту мимо окна убирает его с глаз. Вернуть — синей кнопкой GMGN внизу справа или Alt+G. Двигать окно каждый раз дольше">
            <input type="checkbox" data-c="dodge">
            Прятать окно, когда кликаю мимо него</label>
          <label title="Список топ-холдеров с их долей и точкой входа. Линии на свечах рисуются в любом случае, панель только занимает место">
            <input type="checkbox" data-c="panel">
            Показывать боковую панель топ-холдеров внутри окна</label>
          <label>Масштаб страницы GMGN
            <select class="btn" data-a="zoom" title="Во сколько раз уменьшить страницу GMGN внутри окна. Меньше — влезает больше, мельче шрифт">
              <option value="0.5">50%</option><option value="0.6">60%</option>
              <option value="0.75">75%</option><option value="0.9">90%</option>
              <option value="1">100%</option>
            </select></label>
          <label title="Узел сети для чтения глубины пула. Без него не показать, сколько ликвидности стоит на каждом уровне цены — этого не отдаёт ни один сайт">
            RPC сети <input class="btn rpc" type="text" placeholder="https://…" spellcheck="false"></label>
          <label title="Необязательно. Быстрый узел только для чтения цены и ликвидности пулов — это почти все запросы. Например OrbitFlare: https://robinhood.rpc.orbitflare.com?api_key=… Поиск пулов и сделок всё равно идёт через основной RPC: у таких узлов события отдаются окнами по 17 минут">
            RPC для чтения <input class="btn rpcstate" type="text" placeholder="необязательно" spellcheck="false"></label>
          <div class="row">
            <button class="btn" data-a="reload" title="Загрузить страницу GMGN заново, если она подвисла или устарела">Перезагрузить график</button>
            <button class="btn" data-a="popout" title="Открыть этот токен на gmgn.ai обычной вкладкой браузера">Открыть вкладкой</button>
            <button class="btn" data-a="probe" title="Проверить, доходит ли запрос до GMGN в обход окна. Покажет коды ответа">Проверить доступ</button>
          </div>
          <div class="probe"></div>
          <div class="note">Alt+G — свернуть или вернуть окно · версия <b class="ver">?</b></div>
        </div>
        <div class="body"><div class="hint">Кликни по пулу или леддеру — здесь появится его график.</div></div>
        <div class="grip"></div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);

    ui = {
      host, root,
      win: root.querySelector('.win'),
      bar: root.querySelector('.bar'),
      tabs: root.querySelector('.tabs'),
      body: root.querySelector('.body'),
      hint: root.querySelector('.hint'),
      grip: root.querySelector('.grip'),
      badge: root.querySelector('.badge'),
      fees: root.querySelector('.fees'),
      liq: root.querySelector('.liq'),
      depth: root.querySelector('.depth'),
      depthAll: root.querySelector('.depth.all'),
      upd: root.querySelector('.upd'),
      pnl: root.querySelector('.pnl'),
      acts: root.querySelector('.acts'),
      menu: root.querySelector('.menu'),
      probe: root.querySelector('.menu .probe'),
      ver: root.querySelector('.menu .ver'),
      rpc: root.querySelector('.menu .rpc'),
      rpcState: root.querySelector('.menu .rpcstate'),
      zoom: root.querySelector('select[data-a="zoom"]'),
      near: root.querySelector('select[data-a="near"]'),
      depthsec: root.querySelector('select[data-a="depthsec"]'),
      nums: root.querySelectorAll('input[data-n]'),
      cost: root.querySelector('.menu .cost'),
      tabsBox: root.querySelector('.menu .tabsbox'),
      state: root.querySelector('.menu .state'),
      more: root.querySelector('.menu .more'),
      moreHead: root.querySelector('.menu .more-head'),
      toks: root.querySelector('.menu .toks'),
      lvls: root.querySelector('.menu .lvls'),
      edges: root.querySelector('.menu .edges'),
      edgeact: root.querySelector('.menu .edgeact'),
      lvltok: root.querySelector('.menu .lvltok'),
      lvlval: root.querySelector('.menu .num.wide'),
      lvlunit: root.querySelector('.menu .lvlunit'),
      lvlact: root.querySelector('.menu .lvlact'),
      pumps: root.querySelector('.menu .pumps'),
      pumptok: root.querySelector('.menu .pumptok'),
      pumpin: root.querySelectorAll('.menu input[data-p]'),
    };

    ui.root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b || b.tagName === 'SELECT') return;
      const a = b.dataset.a;
      if (a === 'close') { S.open = false; }
      else if (a === 'min') { S.min = !S.min; }
      else if (a === 'lvladd') { addLevel(); }
      else if (a === 'lvltest') { testFire(); }
      else if (a === 'edgeall') { allEdges(true); return; }
      else if (a === 'edgenone') { allEdges(false); return; }
      else if (a === 'checkcollect') { checkCollect(); return; }
      else if (a === 'screener') {
        try { chrome.runtime.sendMessage({ type: 'openScreener' }, () => void chrome.runtime.lastError); }
        catch (err) { /* контекст расширения перезагрузили */ }
        return;
      }
      else if (a === 'tabsopen') { tabsDo('tabsOpen'); return; }
      else if (a === 'tabsclose') { tabsDo('tabsClose'); return; }
      else if (a === 'pumpadd') { addPump(); }
      else if (a === 'pumpoff') { togglePumpOff(ui.pumptok && ui.pumptok.value, true); }
      else if (a === 'tokall') { S.watchSkip = []; save(); pushWatch(); }
      else if (a === 'toknone') { S.watchSkip = ladders().map((l) => l.key); save(); pushWatch(); }
      else if (a === 'more') { S.more = !S.more; }
      else if (a === 'menu') { S.menu = !S.menu; }
      else if (a === 'open') { domDirty = true; }
      else if (a === 'reload') {
        const f = frames.get(S.active);
        if (f) { f.tries = 0; reloadFrame(S.active); }
      }
      else if (a === 'popout') { const t = active(); if (t) window.open(urlOf(t), '_blank', 'noopener'); }
      else if (a === 'probe') { const t = active(); if (t) probe(t, ui.probe); return; }
      save(); render();
    });

    // Окно открыто не в одной вкладке: сайт держат и в двух, и в трёх. Пока
    // каждая жила своей копией настроек, снятый в одной вкладке тейк в
    // остальных оставался — и срабатывал оттуда. Слушаем хранилище и
    // подхватываем общие настройки, не трогая своё оконное: размер, вкладки
    // и открытый график у каждой вкладки свои.
    const SHARED = ['watchOn', 'pumpOn', 'feesOn', 'edgeOn', 'edgeHi', 'edgeLo',
      'edgePct', 'edgeShift', 'edgeAct', 'takeLevels', 'tokenPump', 'watchSkip',
      'minUsd', 'feesSec', 'pumpPct', 'windowMin', 'fadePct', 'everySec',
      'quietSec', 'keepTabs', 'maxTabs',
      // Что рисовать — это тоже меняется из меню расширения и должно
      // применяться сразу, а не при следующей загрузке страницы.
      'mine', 'bounds', 'depthOn', 'sizeOn', 'holders', 'autoLoad', 'depthThin', 'addedOnly', 'nearPct'];
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !ui) return;
        // Сторож обновляет список леддеров сам — узнаём сразу, а не при
        // следующей загрузке страницы, иначе в окне висят закрытые.
        const box = changes[PKEY] && changes[PKEY].newValue;
        if (box && Array.isArray(box.pairs)) {
          pairs = box.pairs;
          pruneWatch();
          autoDone.clear();
          domDirty = true;
          pushLevels();
          render();
        }
        // Вышла новая версия — плашка появляется, не дожидаясь перезагрузки.
        if (changes.ghoUpd) showUpd(changes.ghoUpd.newValue || {});
        // Сбор в другой вкладке — точка появляется и здесь.
        if (changes[CKEY] && changes[CKEY].newValue) {
          collects = changes[CKEY].newValue;
          domDirty = true;
          pushLevels();
        }
        if (!changes[KEY]) return;
        const next = changes[KEY].newValue || {};
        let hit = false;
        for (const k of SHARED) {
          if (next[k] === undefined) continue;
          if (JSON.stringify(next[k]) === JSON.stringify(S[k])) continue;
          S[k] = next[k];
          hit = true;
        }
        if (!hit) return;
        // Сохранять в ответ нельзя: две вкладки будут будить друг друга по
        // кругу. Только показать у себя и перерисовать график.
        showLevels();
        showEdges();
        showTokens();
        showPumps();
        showState();
        domDirty = true;
        pushLevels();
      });
    } catch (e) { /* контекст расширения перезагрузили */ }

    try {
      chrome.storage.local.get('ghoUpd', (v) => showUpd((v && v.ghoUpd) || {}));
    } catch (e) { /* контекст расширения перезагрузили */ }

    try {
      chrome.storage.local.get('ghoRpc', (v) => {
        const box = (v && v.ghoRpc) || {};
        ui.rpc.value = box.robinhood || '';
        if (ui.rpcState) ui.rpcState.value = box.robinhoodState || '';
        rpcSet = !!box.robinhood;
      });
    } catch (e) { /* контекст ушёл */ }

    // Оба поля пишут в один объект: раньше запись одного затирала бы другое.
    const saveRpc = () => {
      const url = ui.rpc.value.trim();
      const state = ui.rpcState ? ui.rpcState.value.trim() : '';
      rpcSet = !!url;
      try { chrome.storage.local.set({ ghoRpc: { robinhood: url, robinhoodState: state } }); } catch (e) { /* ушёл */ }
      depthCache.clear();
      pushLevels();
    };
    ui.rpc.addEventListener('change', saveRpc);
    if (ui.rpcState) ui.rpcState.addEventListener('change', saveRpc);

    ui.zoom.addEventListener('change', () => { S.zoom = parseFloat(ui.zoom.value); save(); render(); });
    for (const box of ui.nums) {
      box.addEventListener('change', () => {
        const key = box.dataset.n;
        // Нижнюю границу берём только если она правда задана. Раньше здесь
        // было Number(box.min), а у поля без атрибута это ноль — и смещение
        // «минус десять» молча превращалось в ноль.
        const raw = box.getAttribute('min');
        const min = raw === null || raw === '' ? null : Number(raw);
        let v = parseInt(box.value, 10);
        // Пустое поле — значение по умолчанию, а не ноль: пустой порог роста
        // означал бы «срабатывать всегда».
        if (!isFinite(v)) v = DEFAULTS[key];
        S[key] = min !== null && isFinite(min) ? Math.max(min, v) : v;
        box.value = String(S[key]);
        save(); pushWatch();
      });
    }
    ui.edgeact.addEventListener('change', () => {
      S.edgeAct = ui.edgeact.value === 'close' ? 'close' : 'fees';
      save(); showEdges();
    });
    ui.depthsec.addEventListener('change', () => {
      S.depthSec = parseInt(ui.depthsec.value, 10) || 90;
      save(); depthCache.clear(); domDirty = true; pushLevels();
    });
    ui.lvltok.addEventListener('change', () => { showEdges(); showLevels(); });
    ui.near.addEventListener('change', () => {
      S.nearPct = parseInt(ui.near.value, 10) || 25;
      save(); render();
      domDirty = true; pushLevels();
    });

    // Меню должно вести себя как всплывашка: открыл, отметил, оно исчезло.
    // Клик по самому графику до нас не доходит — он внутри фрейма, поэтому
    // ловим ещё и уход мыши, и потерю фокуса окном.
    const closeMenu = () => { if (S.menu) { S.menu = false; save(); render(); } };

    ui.root.addEventListener('mousedown', (e) => {
      if (!S.menu) return;
      if (e.target.closest('.menu,[data-a="menu"]')) return;
      closeMenu();
    }, true);

    // Автозакрытия по уходу мыши здесь нет намеренно: пока ведёшь курсор от
    // меню к шестерёнке, оно успевало закрыться само, и клик по шестерёнке
    // открывал его заново — со стороны выглядело как «кнопка не закрывает».

    // Клики по самому окну обрабатывает его собственный слушатель выше;
    // здесь ловим только клики мимо, иначе нажатие на ⚙ закрывало меню
    // раньше, чем кнопка успевала его открыть, — и оно не закрывалось никогда.
    document.addEventListener('mousedown', (e) => {
      const path = e.composedPath ? e.composedPath() : [];
      if (ui && path.includes(ui.host)) return;
      closeMenu();
    }, true);
    window.addEventListener('blur', closeMenu);   // фокус ушёл в сам график

    ui.menu.addEventListener('change', (e) => {
      const edge = e.target.closest('input[data-e]');
      if (edge) {
        const key = ui.lvltok.value;
        const hi = Number(edge.dataset.e);
        const box = { ...(S.takeLevels || {}) };
        let list = [...(box[key] || [])].map(asLevel);
        // Ищем по источнику, а не по цене: смещение можно поменять, и тогда
        // цена уже другая, а край тот же.
        if (edge.checked) {
          if (!list.some((x) => x.from === hi)) {
            list.push({ v: edgePrice(hi), unit: 'price',
                        act: S.edgeAct === 'close' ? 'close' : 'fees', from: hi });
          }
        } else {
          list = list.filter((x) => x.from !== hi);
        }
        if (list.length) box[key] = list.sort((a, b) => a.v - b.v);
        else delete box[key];
        S.takeLevels = box;
        takesChanged();
        return;
      }

      const tok = e.target.closest('input[data-w]');
      if (tok) {
        const skip = new Set(S.watchSkip || []);
        if (tok.checked) skip.delete(tok.dataset.w);
        else skip.add(tok.dataset.w);
        S.watchSkip = [...skip];
        save(); pushWatch();
        return;
      }
      const box = e.target.closest('input[data-c]');
      if (!box) return;
      S[box.dataset.c] = box.checked;
      if (box.dataset.c === 'mine') S.mineSet = true;
      S.edgeOn = edgeArmed();         // старое общее поле держим в согласии
      if (['watchOn', 'pumpOn', 'feesOn', 'keepTabs', 'edgeOn', 'edgeHi', 'edgeLo']
        .includes(box.dataset.c)) pushWatch();
      save(); render();
      // Перерисовку графика запускает только «страница изменилась». Без этого
      // галка срабатывала лишь при следующем шевелении сайта.
      domDirty = true;
      pushLevels();
    });
    ui.bar.addEventListener('click', (e) => {
      if (S.menu && !e.target.closest('[data-a="menu"]')) { S.menu = false; save(); render(); }
    });

    ui.bar.addEventListener('dblclick', (e) => {
      if (e.target.closest('.tab') || e.target.closest('[data-a]')) return;
      S.min = !S.min; save(); render();
    });

    try {
      ui.ver.textContent = chrome.runtime.getManifest().version;
    } catch (e) { ui.ver.textContent = '—'; }

    if (ui.upd) {
      ui.upd.addEventListener('click', () => {
        const u = ui.upd.dataset.url;
        if (u) window.open(u, '_blank');
      });
    }

    dragging(ui.bar, (dx, dy, g0) => ({ ...g0, x: g0.x + dx, y: g0.y + dy }), (e) => !!e.target.closest('.tab,.upd,[data-a]'));
    dragging(ui.grip, (dx, dy, g0) => ({ ...g0, w: Math.max(320, g0.w + dx), h: Math.max(200, g0.h + dy) }));
  }

  /**
   * Ярлык. Пока окно скрыто — единственная кнопка, которая его поднимает.
   * На нём же написано, какой пул откроется: это ответ на вопрос «по какому
   * пулу я кликнул».
   */
  function launcher() {
    if (!lui) {
      const host = document.createElement('div');
      host.id = 'llc-launch';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          :host { all: initial; }
          .pill {
            position: fixed; right: 18px; bottom: 18px; z-index: 2147482999;
            display: flex; align-items: center; gap: 7px;
            padding: 9px 14px; border-radius: 999px;
            background: #1f6feb; color: #fff;
            border: 0; box-shadow: 0 6px 22px rgba(0,0,0,.55);
            font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            cursor: pointer; user-select: none;
          }
          .pill:hover { background: #2b7ffb; }
          .dot { width: 8px; height: 8px; border-radius: 50%; background: #9ef0b8; }
          .dot.off { background: rgba(255,255,255,.45); }
        </style>
        <div class="pill" title="Открыть окно с графиком GMGN">
          <span class="dot"></span>📈 <span class="txt">GMGN</span>
        </div>`;
      (document.body || document.documentElement).appendChild(host);
      lui = { host, pill: root.querySelector('.pill'), txt: root.querySelector('.txt'), dot: root.querySelector('.dot') };
      lui.pill.addEventListener('click', launch);
    }

    const t = active();
    const hidden = S.open && !S.min;
    lui.host.style.display = hidden ? 'none' : '';
    lui.txt.textContent = t ? t.label : 'GMGN';
    lui.dot.className = 'dot' + (t ? '' : ' off');
    lui.pill.title = t
      ? 'Показать график: ' + t.label + ' (' + t.chain + ')'
      : 'Кликни по пулу на сайте, потом сюда — откроется его график';
  }

  function dragging(handle, calc, skip) {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || (skip && skip(e))) return;
      e.preventDefault();
      const x0 = e.clientX, y0 = e.clientY, g0 = { ...S.geom };
      ui.win.classList.add('dragging');
      const move = (ev) => { S.geom = clamp(calc(ev.clientX - x0, ev.clientY - y0, g0)); place(); };
      const up = () => {
        ui.win.classList.remove('dragging');
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        save(); render();
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    });
  }

  function clamp(g) {
    const W = window.innerWidth, H = window.innerHeight;
    const w = Math.min(Math.max(320, g.w), W - 8);
    const h = Math.min(Math.max(160, g.h), H - 8);
    return {
      w, h,
      x: Math.min(Math.max(0, g.x), Math.max(0, W - w)),
      // хотя бы полоса окна должна оставаться на экране, иначе оно «теряется»
      y: Math.min(Math.max(0, g.y), Math.max(0, H - Math.min(h, 160))),
    };
  }

  function defaultGeom() {
    const w = Math.min(660, window.innerWidth - 40);
    const h = Math.min(440, window.innerHeight - 120);
    return { x: window.innerWidth - w - 24, y: 72, w, h };
  }

  function place() {
    const g = S.geom;
    ui.win.style.left = g.x + 'px';
    ui.win.style.top = g.y + 'px';
    ui.win.style.width = g.w + 'px';
    ui.win.style.height = g.h + 'px';
  }

  const active = () => S.tabs.find((t) => keyOf(t) === S.active) || null;

  // ---------- отрисовка ----------

  function render() {
    if (!ui) build();
    if (!S.geom) S.geom = defaultGeom();

    ui.host.style.display = S.open && S.tabs.length ? '' : 'none';
    launcher();
    if (!S.tabs.length) { for (const [k] of frames) evict(k); return; }
    // Окно закрыли — фрейм не выгружаем: иначе GMGN грузится заново и теряет
    // масштаб, а закрывать окно приходится часто.
    if (!S.open) return;

    ui.win.classList.toggle('min', !!S.min);
    place();

    // вкладки
    ui.tabs.textContent = '';
    for (const t of S.tabs) {
      askSymbol(t);
      const k = keyOf(t);
      const el = document.createElement('div');
      el.className = 'tab' + (k === S.active ? ' on' : '');
      el.innerHTML = '<b></b><span class="x">×</span>';
      // Пока символ не приехал, показываем короткий адрес — но не пустоту.
      const name = t.label || symCache[t.chain + ':' + String(t.addr).toLowerCase()]
        || short(t.addr);
      el.querySelector('b').textContent = name;
      el.title = name + '\n' + t.chain + ' · ' + t.addr
        + '\nКлик — показать этот токен, × — убрать вкладку';
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('x')) { dropTab(k); return; }
        S.active = k; S.min = false; save(); render();
      });
      ui.tabs.appendChild(el);
    }

    ui.more.hidden = !S.more;
    ui.moreHead.textContent = (S.more ? '▾ ' : '▸ ') + 'Тонкая настройка';
    ui.menu.hidden = !S.menu;
    ui.root.querySelector('[data-a="menu"]').classList.toggle('on', !!S.menu);
    for (const box of ui.menu.querySelectorAll('input[data-c]')) {
      box.checked = !!S[box.dataset.c];
    }
    ui.zoom.value = String(S.zoom);
    ui.near.value = String(S.nearPct || 25);
    ui.depthsec.value = String(S.depthSec || 90);
    ui.edgeact.value = S.edgeAct === 'close' ? 'close' : 'fees';
    for (const box of ui.nums) {
      const v = S[box.dataset.n];
      box.value = String(v === undefined ? DEFAULTS[box.dataset.n] : v);
    }
    showCost();
    showState();
    showTabs();
    showTokens();
    showLevels();
    showEdges();
    showPumps();

    if (S.min) return;
    const t = active();
    ui.hint.hidden = !!t;
    if (!t) { for (const [, f] of frames) f.wrap.hidden = true; return; }
    mountFrames();
  }

  function mountFrames() {
    const t = active();
    if (!t) return;
    const k = keyOf(t);

    if (!frames.get(k)) {
      const wrap = document.createElement('div');
      wrap.className = 'pane';
      ui.body.appendChild(wrap);
      // ready взводится только по объявлению из самого фрейма
      const f0 = { wrap, token: t, used: 0, ready: false, loaded: false, iframe: null };
      frames.set(k, f0);
      reloadFrame(k);
    }

    const f = frames.get(k);
    f.used = ++useTick;

    for (const [key, fr] of frames) {
      const on = key === k;
      fr.wrap.hidden = !on;
      if (on) sizeFrame(fr);
    }

    // выгружаем давно не открывавшиеся, чтобы не жечь CPU на нескольких GMGN сразу
    const live = [...frames.entries()].sort((a, b) => b[1].used - a[1].used);
    for (const [key] of live.slice(KEEP_ALIVE)) evict(key);
    pushLevels();
  }

  /**
   * Пересоздаём элемент, а не переприсваиваем src: после ошибки Cloudflare
   * фрейм застревает и повторное присваивание того же адреса навигацию не
   * запускает. Заодно один раз пробуем молча — 503 у CF часто разовый.
   */
  function reloadFrame(k) {
    const f = frames.get(k);
    if (!f) return;

    f.ready = false;

    const iframe = document.createElement('iframe');
    // без allow-top-navigation: страница GMGN не сможет вышибить нас из фрейма
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
    iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
    iframe.src = urlOf(f.token);
    f.loaded = false;
    iframe.addEventListener('load', () => { f.loaded = true; });
    if (f.iframe) f.iframe.remove();
    f.wrap.appendChild(iframe);
    f.iframe = iframe;
    sizeFrame(f);

    // Без автоповторов: лишние заходы только злят бот-защиту Cloudflare.
    // Не поехало — показываем, что случилось, и ждём решения человека.
  }

  /**
   * Проба: доходит ли запрос до GMGN в обход фрейма — от имени расширения.
   * Если да, график можно рисовать самим и Cloudflare нам больше не помеха.
   */
  function probe(t, out) {
    out.textContent = 'проверяю…';
    try {
      chrome.runtime.sendMessage(
        { type: 'probe', chain: t.chain, addr: t.addr },
        (r) => {
          const err = chrome.runtime.lastError;
          const res = err ? { error: err.message } : r;
          out.textContent = describe(res);
          // чтобы результат можно было прочитать снаружи, не открывая консоль
          document.documentElement.dataset.ghoProbe = JSON.stringify(res || {});
        },
      );
    } catch (e) {
      out.textContent = 'расширение перезагрузили — обнови страницу';
    }
  }

  function describe(r) {
    if (!r) return 'ответа нет';
    if (r.error) return 'ошибка: ' + r.error;
    if (r.depth) return 'глубина: ' + r.depth + ' · RPC ' + r.rpc;
    if (!r.params) return 'нет подписей запросов — открой любой токен на gmgn.ai, потом сюда';
    const parts = ['страница: ' + r.page, 'свечи: ' + r.candles];
    if (r.bars !== null && r.bars !== undefined) parts.push('баров: ' + r.bars);
    parts.push('подписям ' + r.ageMin + ' мин');
    return parts.join(' · ');
  }

  function evict(k) {
    const f = frames.get(k);
    if (!f) return;
    f.wrap.remove();
    frames.delete(k);
  }

  function sizeFrame(f) {
    if (!f.iframe) return;
    const z = S.zoom;
    const g = S.geom;
    const visW = g.w, visH = g.h - (ui.bar.offsetHeight || 30);
    // в кроп-режиме растягиваем страницу шире окна и сдвигаем вверх:
    // шапка GMGN уезжает за верхний край, торговая панель — за правый
    const padX = S.crop ? 320 : 0;
    const padY = S.crop ? 108 : 0;
    f.iframe.style.width = (visW / z + padX) + 'px';
    f.iframe.style.height = (visH / z + padY) + 'px';
    f.iframe.style.transform = `scale(${z}) translate(0px, ${-padY}px)`;
  }

  // ---------- запуск ----------

  async function init() {
    S = { ...DEFAULTS, ...(await load()) };

    // Разовое выключение того, что действует на странице без спроса.
    // Значения по умолчанию не помогают: у того, кто пользовался прежними
    // версиями, настройка сохранена включённой и продолжает подменять
    // содержимое Manage. Гасим один раз и запоминаем, что уже гасили.
    if (S.calmed !== true) {
      S.autoLoad = true;
      S.calmed = true;
      save();
    }
    // Общая галка «у края» разделена на верхнюю и нижнюю. Кто край не
    // включал — у того обе выключены; кто включал — оставляем, как было.
    if (S.edgeSplit !== true) {
      if (S.edgeOn !== true) { S.edgeHi = false; S.edgeLo = false; }
      S.edgeOn = edgeArmed();
      S.edgeSplit = true;
      save();
      pushWatch();
    }
    // Предел в 6 вкладок был взят с потолка: при седьмом токене сбор по нему
    // просто не шёл. Снимаем его один раз у тех, у кого он остался от
    // прежних версий, — если человек сам поставил другое число, не трогаем.
    if (S.tabsFree !== true) {
      if (Number(S.maxTabs) === 6) S.maxTabs = 0;
      S.tabsFree = true;
      save();
    }
    // Шаг похода на страницу раньше хранился в минутах — переносим, иначе
    // «1 минута» превратилась бы в «1 секунду» и сайт задёргало бы.
    if (S.quietSec === undefined && S.quietMin !== undefined) {
      S.quietSec = Math.max(0, Number(S.quietMin) || 0) * 60;
    }
    delete S.quietMin;
    try { chrome.storage.local.remove('llLadders'); } catch (e) { /* уже нет */ }
    const box = await loadKey(PKEY);
    if (box && Array.isArray(box.pairs)) pairs = box.pairs;
    rungCache = (await loadKey(RKEY)) || {};
    collects = (await loadKey(CKEY)) || {};
    if (!Array.isArray(S.tabs)) S.tabs = [];
    S.geom = S.geom ? clamp(S.geom) : defaultGeom();
    // После перезагрузки страницы график сам не поднимаем: вкладки и размер
    // помним, а какой пул смотреть — решает первый клик. Иначе оверлей
    // всплывает с токеном из прошлой сессии, которого сейчас и в помине нет.
    S.active = null;
    S.menu = false;
    if (!S.mineSet) S.mine = true;      // пока галку не трогали — ступени показываем

    build();
    render();
    pushWatch();
    scan();

    document.addEventListener('click', (e) => {
      if (Date.now() < ownClickUntil) return;     // это мы сами нажали на сайте
      humanAt = Date.now();
      const path = e.composedPath ? e.composedPath() : [];
      // клики по самому окну и по кнопке-ярлыку не в счёт
      if (ui && path.includes(ui.host)) return;
      if (lui && path.includes(lui.host)) return;

      // Нажал Close или Collect на самом сайте — запомненные ступени тут же
      // устарели. Сбрасываем их и несколько секунд перечитываем чаще, иначе
      // закрытая ступень висит на графике до следующего захода в Manage.
      const hit = e.target && e.target.closest && e.target.closest('button');
      const what = hit ? (hit.textContent || '').replace(/\s+/g, ' ').trim() : '';
      if (/^(close|collect|update\s+fees|refresh\s+fees)\b/i.test(what)) {
        forgetRungs(pageToken());
        // Глубину пересчитываем только после закрытия: это сорок запросов к
        // узлу, и на сбор комиссий она всё равно почти не меняется.
        if (/^close\b/i.test(what)) refreshLiquidity(pageToken());
      }

      // Запоминаем, по какому пулу он кликнул: только этот и подгружаем.
      const clicked = tokenNear(e.target);
      if (clicked) intent = { t: clicked, at: Date.now() };

      if (S.follow && clicked) openWith(clicked, false);

      // Убрать окно с глаз одним кликом: тащить его каждый раз дольше
      if (S.dodge && S.open && !S.min) { S.open = false; save(); render(); }
    }, true);

    // Раньше здесь было «разобрать через 350 мс после последнего изменения».
    // На этом сайте цены тикают непрерывно, тишины не наступает никогда, и
    // разбор откладывался до запасного таймера — кнопка появлялась через
    // несколько секунд. Теперь это ограничение частоты: не чаще раза в
    // четверть секунды, но и не позже.
    let pending = null;
    let lastScan = 0;
    const MIN_GAP = 250;
    const kick = () => {
      const wait = Math.max(0, MIN_GAP - (Date.now() - lastScan));
      clearTimeout(pending);
      pending = setTimeout(() => { lastScan = Date.now(); scan(); }, wait);
    };
    const mo = new MutationObserver(() => { domDirty = true; kick(); });
    mo.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['href'],
    });

    // фрейм сообщает, что доехал до gmgn.ai и готов принимать уровни
    window.addEventListener('message', (e) => {
      if (e.origin !== 'https://gmgn.ai') return;
      const d = e.data;
      if (!d || d.__ghoLL !== true) return;
      if (d.type === 'head') {
        // Объём и ликвидность из шапки GMGN: своей ликвидностью мы считаем
        // глубину по цепи, а объём из логов пришлось бы собирать по свопам.
        for (const [k, f] of frames) {
          if (!f.iframe || f.iframe.contentWindow !== e.source) continue;
          headOf.set(k, { ...d.head, at: Date.now() });
          domDirty = true;
          pushLevels();
          break;
        }
        return;
      }
      if (d.type !== 'ready') return;
      for (const [, f] of frames) {
        if (f.iframe && f.iframe.contentWindow === e.source) {
          f.ready = true;
          pushLevels();
          return;
        }
      }
    });

    // Список леддеров приходит из MAIN-world перехватчика: сайт сам просит
    // /api/v1/pnl/dashboard-stats, а мы читаем тело ответа. Кладём в storage,
    // чтобы в Manage список был под рукой без захода на дашборд.
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.origin !== location.origin) return;
      const d = e.data;
      if (!d || d.__llTap !== true) return;
      if (d.type === 'stats-shape') {
        // Адрес дашборда вместе с кошельком и авторизацией: сторож сможет
        // повторить его сам, без открытой вкладки.
        try {
          chrome.storage.local.set({ llStats: {
            url: d.url, headers: d.headers || {}, at: d.at } });
        } catch (err) { /* контекст расширения перезагрузили */ }
        return;
      }
      if (d.type === 'collect-done') {
        if (d.ok) noteCollect(d.kind, d.at);
        return;
      }
      if (d.type === 'collect-shape') {
        // Снимок до сбора: какой токен, по какой цене и сколько фисов было.
        // После ответа сайта из него получится точка на графике.
        collectSnap = snapCollect();
        // Запомнили, как сайт собирает комиссии. Сервис-воркер сможет
        // повторить это сам, когда вкладка закрыта.
        try {
          chrome.storage.local.set({ llCollect: {
            url: d.url, method: d.method, body: d.body,
            headers: d.headers || {}, at: d.at } });
        } catch (err) { /* контекст расширения перезагрузили */ }
        return;
      }
      if (d.type !== 'pairs') return;
      if (!Array.isArray(d.pairs) || !d.pairs.length) return;
      pairs = d.pairs;
      pruneWatch();       // закрытые позиции не должны тащить за собой настройки
      autoDone.clear();   // список леддеров обновился — есть что дотянуть заново
      try { chrome.storage.local.set({ [PKEY]: { pairs, savedAt: Date.now() } }); } catch (err) { /* контекст ушёл */ }
      pushLevels();
    });

    try {
      chrome.runtime.onMessage.addListener((msg, sender, reply) => {
        // Перекличка: сторож просыпается после сна и не помнит, живо ли
        // расширение в его вкладках. Без ответа вкладка считалась бы
        // мёртвой и переоткрывалась зря.
        if (msg && msg.type === 'ping') { reply({ alive: true }); return false; }
        if (!msg || msg.type !== 'impulse') return false;
        // Отвечаем, взялись мы за дело или нет: сторож раздаёт поручение по
        // одной вкладке, иначе один и тот же сбор ушёл бы в цепь несколько раз.
        // Отвечаем не только «взялись», но и чем кончилось: собрали, нажали
        // без подтверждения, ждём порога или не вышло.
        onImpulse(msg)
          .then((r) => reply(r && typeof r === 'object' ? r : { handled: !!r }))
          .catch(() => reply({ handled: false }));
        return true;
      });
      // Говорим сторожу, что страница поднялась: если вкладку открыл он сам,
      // у него для неё припасено поручение.
      chrome.runtime.sendMessage({ type: 'llReady' }, (r) => {
        void chrome.runtime.lastError;
        ownTab = !!(r && r.mine);
      });
    } catch (e) { /* контекст расширения перезагрузили */ }

    // Контекст расширения умирает при его перезагрузке, а страница живёт
    // дальше со старым скриптом. Ловим это сразу, а не когда что-то не сработало.
    setInterval(() => {
      try {
        if (!chrome.runtime || !chrome.runtime.id) throw new Error('нет контекста');
      } catch (e) {
        if (ui && ui.depth) {
          ui.depth.hidden = false;
          ui.depth.className = 'depth bad';
          ui.depth.textContent = 'расширение обновилось — обнови страницу (Cmd+R)';
        }
      }
    }, 5000);

    setInterval(pushLevels, 4000);
    setInterval(() => { selfHeal().catch(() => { healing = false; }); }, 5000);
    setInterval(() => { if (S.open && S.menu) { showState(); showTabs(); } }, 4000);

    window.addEventListener('resize', () => { S.geom = clamp(S.geom); place(); });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && S.menu) { S.menu = false; save(); render(); return; }
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'g' || e.key === 'G' || e.code === 'KeyG')) {
        e.preventDefault();
        if (S.open && !S.min) { S.min = true; save(); render(); }
        else launch();
      }
    });
  }

  // Под тестами файл только отдаёт разбор наружу и ничего не поднимает
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseLink, labelFor, tokenNear, harvest, scopeOf, scopesFor,
      readLevels, readFees, readPnl, feesIn, pnlIn, anchors, parseIds, mergeIds,
      summaryIn, moneyOf, rowsIn, isFilled,
      siteActions, feesAction, collectAction, mergeAction,
      selectAllTargets, selectedCount,
      // Под тестами даём поднять окно целиком: именно так ловятся вызовы
      // несуществующих функций — синтаксис у них верный, падает только в бою.
      __boot: init,
      // Что ушло бы на график последним — тестам надо видеть посылку целиком.
      __lastLevels: () => lastLevels,
      // Список леддеров, как его прочло окно: без него не видно, почему в
      // настройках пусто — пары не пришли или их разобрали неверно.
      __pairs: () => pairs,
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
