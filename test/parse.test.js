const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./dom");
const fs = require("node:fs");
const path = require("node:path");

const DOGSHIT = {
  chain: "robinhood",
  addr: "0x905b79845eaea281e4200f206fe7920dad685dd3",
};
const AI = {
  chain: "robinhood",
  addr: "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18",
};
const BNB = {
  chain: "bsc",
  addr: "0xb3fac946e4cb11c881c43ca6acde9a1b2129ffff",
};
const tok = (t, label) => ({ ...t, label: label || "" });

test("дашборд: ссылка разбирается в чейн, адрес и имя пары", () => {
  const { doc, parse } = load("dashboard.html");
  const a = doc.querySelector('a[href*="905b79"]');
  const t = parse.parseLink(a);
  assert.equal(t.chain, "robinhood");
  assert.equal(t.addr, DOGSHIT.addr);
  assert.equal(t.label, "USDG/DOGSHIT");
});

test("имя пары не утекает из чужого текста", () => {
  const { doc, parse } = load("dashboard.html");
  const link = doc.createElement("a");
  link.setAttribute("href", "https://gmgn.ai/bsc/token/" + BNB.addr);
  doc.getElementById("sidebar").appendChild(link);
  // рядом только «/manage» и обычный текст — подписи взяться неоткуда
  assert.equal(parse.labelFor(link), null);
});

test("дашборд: внешние границы леддера и текущая цена", () => {
  const { parse } = load("dashboard.html");
  const L = parse.readLevels(tok(DOGSHIT));
  assert.deepEqual(L.positions, [[0.000113, 0.000684]]);
  assert.equal(L.current, 0.000197);
});

test("дашборд: комиссии и открытый PnL", () => {
  const { parse } = load("dashboard.html");
  assert.deepEqual(parse.readFees(tok(DOGSHIT)), {
    unclaimed: 16.24,
    claimed: 18.76,
    ladders: 1,
  });
  assert.equal(parse.readPnl(tok(DOGSHIT)).usd, -48.34);
  assert.equal(parse.readPnl(tok(AI)).usd, 6.67);
});

test("клик по карточке даёт её токен, клик мимо — ничего", () => {
  const { doc, parse } = load("dashboard.html");
  const inside = doc
    .querySelectorAll(".card")[1]
    .querySelector(".text-right div");
  assert.equal(parse.tokenNear(inside).addr, AI.addr);
  assert.equal(parse.tokenNear(doc.getElementById("sidebar")), null);
  // корень со всеми карточками сразу — это уже не карточка
  assert.equal(parse.tokenNear(doc.getElementById("ladders")), null);
});

test("manage: пять ступеней леддера, а не диапазон дашборда", () => {
  const { parse } = load("manage.html");
  const L = parse.readLevels(tok(DOGSHIT));
  assert.deepEqual(L.positions, [
    [0.000113, 0.000162],
    [0.000162, 0.000232],
    [0.000232, 0.000333],
    [0.000333, 0.000477],
    [0.000477, 0.000684],
  ]);
  assert.equal(L.current, 0.000197);
});

test("manage: слиппедж и диапазоны ID не попадают в уровни", () => {
  const { parse } = load("manage.html");
  const L = parse.readLevels(tok(DOGSHIT));
  for (const [lo, hi] of L.positions) {
    assert.ok(
      lo < 1 && hi < 1,
      `в уровни просочилось целое число: ${lo}..${hi}`,
    );
  }
});

test("manage: скрытая панель дашборда не подменяет токен", () => {
  const { doc, parse } = load("manage.html");
  const visible = parse.anchors().map((a) => parse.parseLink(a).addr);
  assert.deepEqual(visible, [DOGSHIT.addr]);
  // клик по строке позиции обязан дать DOGSHIT, а не соседний BNB-леддер
  const row = doc.querySelector("#positions .row .range");
  assert.equal(parse.tokenNear(row).addr, DOGSHIT.addr);
  // у чужого токена видимых областей нет, значит и уровней нет
  assert.equal(parse.readLevels(tok(BNB)), null);
});

test("manage: комиссии берутся из скрытой панели, там их больше негде взять", () => {
  const { parse } = load("manage.html");
  assert.deepEqual(parse.readFees(tok(DOGSHIT)), {
    unclaimed: 16.24,
    claimed: 18.76,
    ladders: 1,
  });
});

test("цена внутри диапазона определяется по той же ступени, что и на сайте", () => {
  const { parse } = load("manage.html");
  const L = parse.readLevels(tok(DOGSHIT));
  const live = L.positions.filter(
    ([lo, hi]) => L.current >= lo && L.current <= hi,
  );
  assert.equal(live.length, 1);
  assert.deepEqual(live[0], [0.000162, 0.000232]);
});

test("склейка леддеров: объединение без дублей и по возрастанию", () => {
  const { parse } = load("manage.html");
  assert.deepEqual(parse.parseIds("2275557, 2275556, 2275555"), [
    "2275557",
    "2275556",
    "2275555",
  ]);
  assert.deepEqual(parse.parseIds("  "), []);
  assert.deepEqual(
    parse.mergeIds([
      ["2275557", "2275556"],
      ["2275556", "2275553"],
    ]),
    ["2275553", "2275556", "2275557"],
  );
});

test("сводка «Fees & PnL» разбирается парами подпись → значение", () => {
  const { doc, parse } = load("manage.html");
  const box = doc.createElement("div");
  box.innerHTML = `
    <span>Total Value:</span><span>$394.18</span>
    <span>Unclaimed Fees:</span><span>$34.1734</span>
    <span>Claimed:</span><span>$18.7600</span>
    <span>Age:</span><span>2h 31m</span>
    <span>Net PnL:</span><span>$-52.89 (-10.6%)</span>
    <span>DPR:</span><span>13.28%</span>
    <span>Price:</span><span>0.0001727</span>`;
  doc.body.appendChild(box);
  const sum = parse.summaryIn(doc.body);
  assert.equal(sum.value, "$394.18");
  assert.equal(sum.unclaimed, "$34.1734");
  assert.equal(sum.pnl, "$-52.89 (-10.6%)");
  assert.equal(sum.dpr, "13.28%");
  assert.equal(parse.moneyOf(sum.pnl), -52.89);
  assert.equal(parse.moneyOf("$394.18"), 394.18);
  assert.equal(parse.moneyOf(""), null);
});

test("без панели Fees & PnL сводки нет, а не пустой объект", () => {
  const { doc, parse } = load("dashboard.html");
  assert.equal(parse.summaryIn(doc.body), null);
});

test("сторона позиции читается из колонки Side", () => {
  const { doc, parse } = load("manage.html");
  const rows = parse.rowsIn(doc.getElementById("positions"));
  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.map((r) => r.side),
    ["ask", "ask", "ask", "both", "bid", "bid"],
  );
});

test("закрытая позиция исчезает с графика", () => {
  const { parse } = load("manage.html");
  const L = parse.readLevels({
    chain: "robinhood",
    addr: "0x905b79845eaea281e4200f206fe7920dad685dd3",
    label: "",
  });
  // в таблице шесть строк, шестая закрыта — на график идут пять
  assert.equal(L.rungs.length, 5);
  assert.ok(
    !L.rungs.some((r) => r.lo === 0.00009),
    "закрытая ступень осталась на графике",
  );
  assert.deepEqual(
    L.rungs.map((r) => r.side),
    ["bid", "both", "ask", "ask", "ask"],
  );
});

test("обломки цен не попадают в Token IDs", () => {
  const { parse } = load("manage.html");
  // «$0.002386 – $0.003256», разбитое по не-цифрам, давало 0 / 002386 / 003256
  assert.deepEqual(parse.parseIds("0.002386, 0.003256"), []);
  assert.deepEqual(parse.parseIds("1247044, 1247043, 1247042"), [
    "1247044",
    "1247043",
    "1247042",
  ]);
  assert.deepEqual(parse.parseIds("0, 1, 2, 07, 08, 026"), []);
  assert.deepEqual(
    parse.mergeIds([
      ["1247044", "0"],
      ["026", "1247043"],
    ]),
    ["1247043", "1247044"],
  );
});

test("без таблицы позиций отдаются только границы, без ступеней", () => {
  const { doc, parse } = load("manage.html");
  doc.getElementById("positions").remove(); // ушли на другой пул
  const hidden = doc.getElementById("hidden-dashboard");
  hidden.style.display = ""; // карточка дашборда видна
  const L = parse.readLevels({
    chain: "robinhood",
    addr: "0x905b79845eaea281e4200f206fe7920dad685dd3",
    label: "",
  });
  assert.equal(L.envelope, true, "должно быть помечено как только границы");
  assert.deepEqual(L.positions, [[0.000113, 0.000684]]);
});

test("каждая кнопка шапки имеет рабочий обработчик", () => {
  const { parse } = load("manage.html");
  const t = {
    chain: "robinhood",
    addr: "0x905b79845eaea281e4200f206fe7920dad685dd3",
    label: "USDG/DOGSHIT",
  };
  const acts = parse.siteActions(t);

  assert.equal(acts.length, 3, "кнопок всегда три, недоступные гаснут");
  for (const a of acts) {
    assert.equal(typeof a.label, "string");
    assert.ok(a.hint, `у кнопки «${a.label}» нет подсказки`);
    assert.equal(
      typeof a.run,
      "function",
      `у кнопки «${a.label}» нет обработчика`,
    );
  }
});

test("нажатие кнопки не роняет расширение", () => {
  const { parse } = load("manage.html");
  const t = {
    chain: "robinhood",
    addr: "0x905b79845eaea281e4200f206fe7920dad685dd3",
    label: "",
  };
  // именно так ловится ReferenceError вроде «selectAll is not defined»:
  // ошибка вылезает не при сборке кнопки, а при нажатии
  for (const a of parse.siteActions(t)) {
    const fake = { dataset: {}, textContent: "" };
    assert.doesNotThrow(() => {
      const r = a.run(fake);
      if (r && r.catch) r.catch(() => {});
    }, `кнопка «${a.label}» падает при нажатии`);
  }
});

test("«Select all» находится, даже когда это кнопка с иконкой внутри", () => {
  const { doc, parse } = load("manage.html");
  const btn = doc.createElement("button");
  btn.innerHTML = "<svg></svg>Select all"; // ровно так это сделано на сайте
  doc.getElementById("positions").appendChild(btn);
  const targets = parse.selectAllTargets();
  assert.ok(targets.length, "кнопка «Select all» не найдена");
  assert.equal(targets[0].tagName, "BUTTON");
});

test("каждый узел, который ищет разметка окна, в ней есть", () => {
  // Трижды ловил одно и то же: правка добавляла ссылку на узел, а сам узел в
  // разметку не попадал. querySelector возвращал null, обработчик падал, и
  // инициализация обрывалась молча — окно оставалось мёртвым.
  const fs = require("node:fs");
  const path = require("node:path");
  const { JSDOM } = require("jsdom");

  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  const tpl = /root\.innerHTML = `([\s\S]*?)`;/.exec(src);
  assert.ok(tpl, "не нашёл разметку окна");

  const dom = new JSDOM("<!doctype html><body></body>");
  const box = dom.window.document.createElement("div");
  box.innerHTML = tpl[1].replace(/\$\{CSS\}/g, "");

  const selectors = [...src.matchAll(/\broot\.querySelector\('([^']+)'\)/g)]
    .map((m) => m[1])
    // у ярлыка своя разметка, он строится отдельно
    .filter((s) => ![".pill", ".txt", ".dot"].includes(s));

  const missing = selectors.filter((s) => !box.querySelector(s));
  assert.deepEqual(
    missing,
    [],
    "этих узлов нет в разметке: " + missing.join(", "),
  );
});

test("скрипты сервис-воркера не объявляют одинаковых имён", () => {
  // importScripts складывает всё в одну область: два одинаковых const —
  // и воркер не регистрируется вовсе, а с ним отваливается вся глубина пула.
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "..", "src");

  const top = (file) => {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    return [
      ...src.matchAll(
        /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm,
      ),
    ].map((m) => m[1]);
  };

  const a = top("chain.js");
  const b = top("sw.js");
  const clash = a.filter((n) => b.includes(n));
  assert.deepEqual(clash, [], "имена объявлены дважды: " + clash.join(", "));
});

test("галка «только добавленную» переключает набор полос", () => {
  // Повторяем выбор из оверлея: он должен брать разные наборы, а при
  // пустом «заведённом» — ничего, чтобы плашка сказала «пусто», а не
  // молча показала общую цифру вместо запрошенной.
  const pick = (S, d) => {
    if (!d) return null;
    if (S.addedOnly) {
      return Array.isArray(d.bandsAdded) && d.bandsAdded.length
        ? d.bandsAdded
        : null;
    }
    return Array.isArray(d.bands) && d.bands.length ? d.bands : null;
  };
  const d = { bands: [{ usd: 100 }], bandsAdded: [{ usd: 7 }] };
  assert.equal(pick({ addedOnly: false }, d)[0].usd, 100);
  assert.equal(pick({ addedOnly: true }, d)[0].usd, 7);
  assert.equal(
    pick({ addedOnly: true }, { bands: [{ usd: 100 }], bandsAdded: [] }),
    null,
  );
});

test("в настройках есть галка «только добавленную ликвидность»", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  assert.ok(src.includes('data-c="addedOnly"'), "галки нет в разметке меню");
  assert.ok(
    /addedOnly: false/.test(src),
    "у настройки нет значения по умолчанию",
  );
});

test("обновление фисов перечитывает ликвидность", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  assert.ok(
    /function refreshLiquidity/.test(src),
    "нет функции сброса кэша ликвидности",
  );
  const fees = src.slice(
    src.indexOf("function feesAction"),
    src.indexOf("function feesAction") + 2000,
  );
  assert.ok(
    fees.includes("refreshLiquidity()"),
    "обновление фисов не трогает ликвидность",
  );
});

test("настройки глубины сохраняются между перезагрузками", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  const save = src.slice(
    src.indexOf("function save()"),
    src.indexOf("function load()"),
  );
  for (const key of ["addedOnly", "depthThin", "nearPct"]) {
    assert.ok(
      save.includes(key),
      "настройка " + key + " не попадает в storage и потеряется",
    );
  }
});

test("в шапке две отдельные цифры ликвидности", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  assert.ok(src.includes('<span class="depth all"'), "нет второй плашки");
  assert.ok(
    src.includes("depthAll: root.querySelector('.depth.all')"),
    "вторая плашка не подхвачена",
  );
  assert.ok(
    src.includes("весь токен: заведено"),
    "вторая плашка ничего не пишет",
  );
  assert.ok(
    src.includes("'у цены ±'"),
    "первая плашка не подписана как «у цены»",
  );
});

test("окно «у цены» берётся из настройки и считает долю полосы в окне", () => {
  const near = (price, pct, bands) => {
    const lo = price * (1 - pct);
    const hi = price * (1 + pct);
    return bands.reduce((s, b) => {
      const over = Math.min(hi, b.hi) - Math.max(lo, b.lo);
      return over > 0 && b.hi > b.lo ? s + b.usd * (over / (b.hi - b.lo)) : s;
    }, 0);
  };
  const bands = [
    { lo: 90, hi: 95, usd: 10 }, // −10..−5 %
    { lo: 99, hi: 101, usd: 50 }, // у самой цены
    { lo: 140, hi: 160, usd: 30 }, // +40..+60 %
  ];
  assert.equal(
    near(100, 0.1, bands),
    60,
    "в ±10 % должны попасть только ближние две",
  );
  assert.equal(
    near(100, 0.5, bands),
    75,
    "в ±50 % дальняя полоса попадает только наполовину: 10 + 50 + 15",
  );
  const wide = [{ lo: 95, hi: 500, usd: 100 }]; // от −5 % до +400 %
  assert.ok(
    Math.abs(near(100, 0.1, wide) - 3.7) < 0.1,
    "широкая полоса не должна целиком считаться «у цены», вышло " + near(100, 0.1, wide),
  );
  assert.equal(
    near(100, 0.01, bands),
    50,
    "в ±1 % — только та, что накрывает цену",
  );
});

test("тонкие штрихи включены по умолчанию и доезжают до графика", () => {
  const overlay = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  const bridge = fs.readFileSync(
    path.join(__dirname, "..", "src", "bridge.js"),
    "utf8",
  );
  assert.ok(
    /depthThin: true/.test(overlay),
    "тонкие штрихи должны быть по умолчанию",
  );
  assert.ok(
    overlay.includes("levels.depthThin"),
    "настройка не кладётся в уровни",
  );
  assert.ok(bridge.includes("L.depthThin"), "график не читает настройку");
});

test("глубина рисуется непрозрачной и с накопленными суммами", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "bridge.js"),
    "utf8",
  );
  const block = src.slice(
    src.indexOf("глубина всего пула"),
    src.indexOf("глубина всего пула") + 4000,
  );
  assert.ok(
    !/rgba\(96, 165, 250, \.[0-3]\d?\)/.test(block),
    "полосы глубины не должны быть полупрозрачными",
  );
  assert.ok(
    block.includes("L.depthPrice"),
    "нет цены, от которой считаются суммы",
  );
  assert.ok(
    /\[2, 5, 10, 25, 50, 100\]/.test(block),
    "нет отметок для накопленных сумм",
  );
  const overlay = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  assert.ok(
    overlay.includes("levels.depthPrice = d.price"),
    "цена не доезжает до графика",
  );
});

test("накопленная сумма считается от цены до уровня", () => {
  const val = (b) => b.usd || b.quote || 0;
  // Границы полос намеренно не совпадают с отметками: на живых данных они
  // тоже не совпадают, а на совпадении вылезает разница в последнем бите
  // (100 * 1.1 — это 110.00000000000001).
  const bands = [
    { lo: 85, hi: 95, usd: 100 },
    { lo: 95, hi: 105, usd: 200 },
    { lo: 105, hi: 115, usd: 300 },
    { lo: 115, hi: 125, usd: 400 },
  ];
  const upto = (price, pc) => {
    const level = price * (1 + pc / 100);
    const lo = Math.min(price, level);
    const hi = Math.max(price, level);
    return bands
      .filter((x) => x.hi > lo && x.lo < hi)
      .reduce((a, x) => a + val(x), 0);
  };
  assert.equal(
    upto(100, -10),
    300,
    "вниз на 10 % — полосы, накрывающие 90..100",
  );
  assert.equal(
    upto(100, -20),
    300,
    "вниз на 20 % — те же две, ниже 85 ничего нет",
  );
  assert.equal(
    upto(100, 10),
    500,
    "вверх на 10 % — полосы, накрывающие 100..110",
  );
  assert.equal(upto(100, 20), 900, "вверх на 20 % — добавляется 115..125");
});

test("разбор страницы не голодает на непрерывно меняющемся DOM", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  assert.ok(
    !/pending = setTimeout\(scan, 350\)/.test(src),
    "откладывать разбор до тишины нельзя: на этом сайте цены тикают всегда",
  );
  assert.ok(
    /MIN_GAP - \(Date\.now\(\) - lastScan\)/.test(src),
    "нужен потолок ожидания, а не сброс таймера на каждое изменение",
  );
});

test("потолок ожидания срабатывает даже при непрерывных изменениях", () => {
  // Повторяем логику kick(): изменения идут каждые 50 мс без остановки.
  const MIN_GAP = 250;
  let lastScan = 0;
  let now = 1000;
  const fired = [];
  let due = null;
  const kick = () => {
    due = now + Math.max(0, MIN_GAP - (now - lastScan));
  };
  for (let i = 0; i < 40; i++) {
    now += 50;
    if (due !== null && now >= due) {
      lastScan = now;
      fired.push(now);
      due = null;
    }
    kick();
  }
  assert.ok(
    fired.length >= 6,
    "за две секунды разбор должен пройти много раз, вышло " + fired.length,
  );
  const gaps = fired.map((v, i) => (i ? v - fired[i - 1] : 0)).slice(1);
  assert.ok(
    Math.max(...gaps) <= 300,
    "пауза между разборами не должна расти, максимум " + Math.max(...gaps),
  );
});

test("подтягивается только тот токен, который открыли сами", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  const fn = src.slice(
    src.indexOf("function autoMerge"),
    src.indexOf("function siteButton"),
  );
  // Раньше подгрузка смотрела, что лежит на странице. На переходе она
  // успевала увидеть прошлый токен и загружала его обратно, отменяя переход.
  assert.ok(fn.includes("if (!intent"), "подгружать без клика человека нельзя");
  assert.ok(
    fn.includes("Date.now() - intent.at > INTENT_TTL"),
    "старое намерение срабатывать не должно",
  );
  assert.ok(
    fn.includes("keyOf(now) !== keyOf(t)"),
    "пока сайт не показал нужный токен, вмешиваться нельзя",
  );
  assert.ok(
    fn.includes("document.activeElement === input"),
    "пока в поле стоит курсор, подставлять туда ID нельзя",
  );
  assert.ok(fn.includes("autoDone.has(k)"), "иначе попытка повторялась бы каждый проход");
  const click = src.slice(
    src.indexOf("const clicked = tokenNear(e.target)"),
    src.indexOf("const clicked = tokenNear(e.target)") + 220,
  );
  assert.ok(click.includes("intent = { t: clicked"), "клик по пулу не запоминается");
});

test("сайз в диапазоне делится по цене, ступень с ценой — пропорционально", () => {
  // Повторяем расчёт из drawSize.
  const shareBelow = (r, cur) => {
    if (!isFinite(cur) || cur <= r.lo) return 0;
    if (cur >= r.hi) return 1;
    const a = Math.log(r.lo);
    const b = Math.log(r.hi);
    return b > a ? (Math.log(cur) - a) / (b - a) : 0;
  };
  const rungs = [
    { lo: 100, hi: 200, value: 300 }, // целиком ниже цены
    { lo: 200, hi: 800, value: 100 }, // цена внутри
    { lo: 800, hi: 900, value: 50 }, // целиком выше
  ];
  const cur = 400;
  const total = rungs.reduce((s, r) => s + r.value, 0);
  const below = rungs.reduce((s, r) => s + r.value * shareBelow(r, cur), 0);

  assert.equal(
    shareBelow(rungs[0], cur),
    1,
    "ступень ниже цены — целиком в «ниже»",
  );
  assert.equal(
    shareBelow(rungs[2], cur),
    0,
    "ступень выше цены — ничего в «ниже»",
  );
  const part = shareBelow(rungs[1], cur);
  assert.ok(
    part > 0 && part < 1,
    "ступень с ценой должна делиться, вышло " + part,
  );
  // 400 — середина 200..800 по логарифмической шкале: ln(2)/ln(4) = 0.5
  assert.ok(
    Math.abs(part - 0.5) < 1e-9,
    "делить надо по логарифму цены, вышло " + part,
  );
  assert.ok(
    Math.abs(below - 350) < 1e-9,
    "ниже цены должно оказаться 350, вышло " + below,
  );
  assert.ok(Math.abs(total - below - 100) < 1e-9, "выше цены — остаток");
});

test("сумма позиций рисуется даже с выключенными границами леддера", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "bridge.js"),
    "utf8",
  );
  const draw = src.slice(
    src.indexOf("function drawLevels"),
    src.indexOf("function drawSize"),
  );
  // Выход у отрисовки теперь один: границы рисуются отдельным блоком и
  // подпись сайза не зависит от того, показаны ли они.
  const calls = draw.match(/drawSize\(/g) || [];
  assert.equal(calls.length, 1, "подпись сайза рисуется ровно один раз");
  assert.ok(!/showBounds === false\)\s*\{[\s\S]{0,200}return;/.test(draw),
    "выключенные границы не должны обрывать остальную отрисовку");
  assert.ok(
    /const cur = Number\(L\.current\) > 0 \? Number\(L\.current\) : NaN;[\s\S]{0,400}const yOf/.test(draw),
    "цена должна быть видна всей отрисовке, а не только блоку ступеней",
  );
  const overlay = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  assert.ok(overlay.includes('data-c="sizeOn"'), "нет галки в настройках");
  assert.ok(
    overlay.includes("levels.sizeOff"),
    "настройка не доезжает до графика",
  );
});

test("настройки сторожа есть в меню и уезжают в хранилище воркера", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  for (const sel of [
    'data-c="watchOn"',
    'data-n="pumpPct"',
    'data-n="windowMin"',
    'data-n="minUsd"',
    'data-n="quietSec"',
  ]) {
    assert.ok(src.includes(sel), "в разметке меню нет " + sel);
  }
  assert.ok(
    /function pushWatch/.test(src),
    "настройки сторожа не попадают в хранилище",
  );
  assert.ok(
    src.includes("chrome.storage.local.set({ llWatch:"),
    "ключ настроек сторожа не тот",
  );
  const save = src.slice(
    src.indexOf("function save()"),
    src.indexOf("function load()"),
  );
  for (const key of ["watchOn", "pumpPct", "windowMin", "minUsd", "quietSec"]) {
    assert.ok(
      save.includes(key),
      "настройка " + key + " не переживёт перезагрузку",
    );
  }
});

test("на импульсе жмётся та же кнопка, а не подписывается транзакция", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  const fn = src.slice(
    src.indexOf("async function onImpulse"),
    src.indexOf("function impulseNote"),
  );
  assert.ok(
    fn.includes("collectAction()"),
    "должна использоваться существующая кнопка сбора",
  );
  assert.ok(
    fn.includes("moneyOf(sum.unclaimed)"),
    "порог надо сверять с реальными фисами",
  );
  assert.ok(fn.includes("have < need"), "нет проверки минимальной суммы");
  assert.ok(
    !/privateKey|signTransaction|eth_sendRawTransaction/.test(src),
    "расширение не должно подписывать транзакции само",
  );
});

test("числовые настройки сторожа принимают любое значение, а порог отключается нулём", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  assert.ok(
    !/data-a="pump"|data-a="minusd"/.test(src),
    "готовые варианты в списке — не настройка, нужен свободный ввод",
  );
  assert.ok(
    /<input class="num" type="number" data-n="minUsd" min="0"/.test(src),
    "порог должен допускать ноль, чтобы собирать любую сумму",
  );
  assert.ok(
    /data-n="pumpPct" min="1"/.test(src),
    "рост цены нулём отключать нельзя",
  );
  const push = src.slice(
    src.indexOf("function pushWatch"),
    src.indexOf("function save()"),
  );
  assert.ok(
    push.includes("Math.max(0, Number(S.minUsd) || 0)"),
    "ноль в пороге должен доезжать до сторожа, а не подменяться значением по умолчанию",
  );
  assert.ok(
    push.includes("quietSec"),
    "пауза между срабатываниями не доезжает до сторожа",
  );
});

test("сведение леддеров в одну таблицу можно отключить", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  assert.ok(
    src.includes("Сводить все мои леддеры по токену в одну таблицу"),
    "настройка должна называть то, что делает: несколько пулов сводятся в одну таблицу",
  );
  const fn = src.slice(
    src.indexOf("function autoMerge"),
    src.indexOf("function siteButton"),
  );
  assert.ok(
    fn.includes("S.autoLoad === false"),
    "выключенная настройка должна отключать сведение",
  );
});

test("счёт расхода честный: пачка одна, вызовов по числу токенов", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  const fn = src.slice(
    src.indexOf("function showCost"),
    src.indexOf("function pushWatch"),
  );
  assert.ok(
    fn.includes("86400 / every"),
    "обращения в сутки считаются от частоты опроса",
  );
  assert.ok(
    fn.includes("perDay * n"),
    "вызовов должно быть по числу токенов, а не по числу опросов",
  );

  // сам расчёт: 5 секунд, 5 токенов
  const every = 5;
  const n = 5;
  const perDay = Math.round(86400 / every);
  assert.equal(
    perDay,
    17280,
    "при опросе раз в 5 секунд — 17280 обращений в сутки",
  );
  assert.equal(perDay * n, 86400, "и 86400 вызовов внутри них на пять токенов");
});

test("настройки края диапазона есть в меню", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  // Общей галки «у края» больше нет: верх и низ — две отдельные настройки.
  for (const sel of [
    'data-c="edgeHi"',
    'data-c="edgeLo"',
    'data-n="edgePct"',
    'data-n="everySec"',
  ]) {
    assert.ok(src.includes(sel), "в меню нет " + sel);
  }
  const push = src.slice(
    src.indexOf("function pushWatch"),
    src.indexOf("function save()"),
  );
  for (const key of ["edgeOn", "edgePct", "everySec"]) {
    assert.ok(
      push.includes(key),
      "настройка " + key + " не доезжает до сторожа",
    );
  }
  assert.ok(
    push.includes("Math.max(1, Number(S.everySec)"),
    "опрос чаще раза в секунду смысла не имеет и должен быть ограничен снизу",
  );
});

test("сторожа можно выключить на отдельном токене", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  assert.ok(
    src.includes('<div class="toks"></div>'),
    "нет места под список токенов",
  );
  assert.ok(
    src.includes("box.dataset.w = x.key"),
    "галки не привязаны к токену",
  );
  const fn = src.slice(
    src.indexOf("function showTokens"),
    src.indexOf("function showCost"),
  );
  assert.ok(
    fn.includes("ui.toks.dataset.sign !== sign"),
    "список нельзя пересобирать на каждом проходе: по таким галкам не попасть мышью",
  );
  const push = src.slice(
    src.indexOf("function pushWatch"),
    src.indexOf("function save()"),
  );
  assert.ok(
    push.includes("skip:"),
    "список выключенных не доезжает до сторожа",
  );
  const save = src.slice(
    src.indexOf("function save()"),
    src.indexOf("function load()"),
  );
  assert.ok(
    save.includes("watchSkip"),
    "выбор не переживёт перезагрузку страницы",
  );
});

test("расход считается только по включённым токенам", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  const fn = src.slice(
    src.indexOf("function showCost"),
    src.indexOf("function pushWatch"),
  );
  assert.ok(
    fn.includes("watchKeys().length"),
    "считать надо только те токены, за которыми следим",
  );
  const keys = src.slice(
    src.indexOf("function watchKeys"),
    src.indexOf("function pruneWatch"),
  );
  assert.ok(
    keys.includes("!skip.has(l.key)"),
    "выключенные леддеры запросов не создают",
  );
  assert.ok(
    keys.includes("new Set("),
    "у токена бывает несколько леддеров — запрос на него всё равно один",
  );
  assert.ok(
    fn.includes("ни одного токена не выбрано"),
    "пустой выбор надо назвать словами",
  );
});

test("откат от пика настраивается и доезжает до сторожа", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  assert.ok(src.includes('data-n="fadePct"'), "нет настройки отката от пика");
  const push = src.slice(
    src.indexOf("function pushWatch"),
    src.indexOf("function save()"),
  );
  assert.ok(push.includes("fadePct"), "настройка не доезжает до сторожа");
  assert.ok(
    push.includes("Math.max(0, Number(S.fadePct) || 0)"),
    "ноль означает «только на самом пике» и подменяться не должен",
  );
  const save = src.slice(
    src.indexOf("function save()"),
    src.indexOf("function load()"),
  );
  assert.ok(save.includes("fadePct"), "настройка не переживёт перезагрузку");
});

test("выбранные края подписаны на графике", () => {
  const overlay = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  const bridge = fs.readFileSync(
    path.join(__dirname, "..", "src", "bridge.js"),
    "utf8",
  );
  assert.ok(
    overlay.includes('data-c="edgeHi"') && overlay.includes('data-c="edgeLo"'),
    "нет выбора края в настройках",
  );
  assert.ok(
    overlay.includes("levels.arm"),
    "график не знает, какие края на взводе",
  );
  assert.ok(
    /S\.watchOn === true && edgeArmed\(\)/.test(overlay),
    "подписывать край надо только когда сторож и правда включён",
  );
  assert.ok(bridge.includes("⏱ сбор"), "на графике нет отметки у края");
  assert.ok(
    bridge.includes("L.arm.pct > 0"),
    "полоса срабатывания не рисуется",
  );
});

test('ручные уровни настраиваются и доезжают до сторожа', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  assert.ok(src.includes('data-a="lvladd"'), 'нет кнопки постановки уровня');
  assert.ok(/function addLevel/.test(src) && /function dropLevel/.test(src),
    'уровень должен и ставиться, и убираться');
  const push = src.slice(src.indexOf('function pushWatch'), src.indexOf('function save()'));
  assert.ok(push.includes('levels:'), 'уровни не доезжают до сторожа');
  const save = src.slice(src.indexOf('function save()'), src.indexOf('function load()'));
  assert.ok(save.includes('takeLevels'), 'уровни не переживут перезагрузку страницы');
});

test('в списке сторожа леддеры, а не токены', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  const fn = src.slice(src.indexOf('function ladders'), src.indexOf('function watchKeys'));
  assert.ok(fn.includes('p.group'), 'леддер надо опознавать по его id от сайта');
  assert.ok(fn.includes("chain + ':' + low + ':' + p.lo + ':' + p.hi"),
    'без id нужен запасной ключ по границам');
  const show = src.slice(src.indexOf('function showTokens'), src.indexOf('function fmtPrice'));
  assert.ok(show.includes("'верх ' + fmtPrice(x.hi)"), 'в строке должен быть верх диапазона');
});

test('свои условия пампа по токену настраиваются и сохраняются', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  assert.ok(src.includes('data-a="pumpadd"'), 'нет кнопки задания условий');
  for (const p of ['data-p="pumpPct"', 'data-p="windowMin"', 'data-p="fadePct"']) {
    assert.ok(src.includes(p), 'нет поля ' + p);
  }
  const fn = src.slice(src.indexOf('function addPump'), src.indexOf('function dropPump'));
  assert.ok(fn.includes("box.value !== ''"),
    'пустое поле должно означать «как у всех», а не ноль');
  const push = src.slice(src.indexOf('function pushWatch'), src.indexOf('function save()'));
  assert.ok(push.includes('pump:'), 'условия не доезжают до сторожа');
  const save = src.slice(src.indexOf('function save()'), src.indexOf('function load()'));
  assert.ok(save.includes('tokenPump'), 'условия не переживут перезагрузку');
});

test('форма запроса на сбор комиссий запоминается', () => {
  const tap = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'tap.js'), 'utf8');
  assert.ok(/execute\\\/v\\d\\\/\(batch-\)\?collect-fees/.test(tap) || tap.includes('collect-fees'),
    'перехват не ловит запрос сбора');
  assert.ok(tap.includes("type: 'collect-shape'"), 'форма запроса не передаётся наверх');
  const overlay = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  assert.ok(overlay.includes('llCollect'), 'форма запроса не сохраняется');
});

test('в подсказках больше не обещано подтверждение в кошельке', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  assert.ok(!src.includes('Подпись транзакции остаётся в кошельке'),
    'на встроенном кошельке подписывает сайт, обещать окно кошелька нельзя');
  assert.ok(!src.includes('жду кошелёк'), 'ждать кошелёк на встроенном не приходится');
  assert.ok(src.includes('встроенном кошельке сайт подпишет') || src.includes('встроенном кошельке сайт подписывает сам'),
    'надо прямо сказать, что подтверждать нечего');
});

test('цена из GMGN разбирается в любом виде', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  const SUBS = { '₀': 0, '₁': 1, '₂': 2, '₃': 3, '₄': 4, '₅': 5, '₆': 6, '₇': 7, '₈': 8, '₉': 9 };
  const parse = (text) => {
    let t = String(text || '').trim().replace(/\s+/g, '').replace(/,/g, '.').replace(/^\$/, '');
    if (!t) return null;
    const sub = /^0\.0([₀-₉]+|\((\d+)\))(\d+)$/.exec(t);
    if (sub) {
      const zeros = sub[2] !== undefined
        ? Number(sub[2]) : Number([...sub[1]].map((c) => SUBS[c]).join(''));
      if (!isFinite(zeros)) return null;
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
  };

  assert.ok(src.includes('function parseAmount'), 'разбора в коде нет');
  // подстрочник GMGN: 0.0₄4523 — это четыре нуля после запятой
  assert.equal(parse('0.0₄4523'), 0.00004523);
  assert.equal(parse('0.0(4)4523'), 0.00004523);
  assert.equal(parse('0.00004523'), 0.00004523);
  assert.equal(parse('0.0₆12'), 0.00000012, 'шесть нулей');
  assert.equal(parse('140k'), 140000);
  assert.equal(parse('1.2m'), 1200000);
  assert.equal(parse('140к'), 140000, 'русская «к» тоже должна работать');
  assert.equal(parse('$0.00177'), 0.00177);
  assert.equal(parse('0,00177'), 0.00177, 'запятая как разделитель');
  assert.equal(parse(''), null);
  assert.equal(parse('абв'), null);
  assert.equal(parse('-5'), null, 'отрицательный уровень бессмысленен');
});

test('уровни рисуются на графике и различаются по действию', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge.js'), 'utf8');
  const overlay = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  assert.ok(bridge.includes('function drawTakes'), 'уровни не рисуются');
  assert.ok(/t\.act === 'close' \? 'rgba\(248/.test(bridge), 'закрытие должно быть другим цветом');
  assert.ok(overlay.includes('levels.takes'), 'уровни не доезжают до графика');
  assert.ok(/function takesFor/.test(overlay), 'нет перевода уровней в цены');
  assert.ok(overlay.includes("type: 'supply'"), 'мкап нечем перевести в цену');
});

test('закрытие позиций жмёт только общую кнопку', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  const fn = src.slice(src.indexOf('function closeAction'), src.indexOf('function siteActions'));
  assert.ok(fn.includes('RE_CLOSE_ALL'), 'нужна общая кнопка Close (N)');
  assert.ok(fn.includes('ensureSelection'), 'перед закрытием надо отметить позиции');
  assert.ok(!/findBtn\(\/\^close\$\/i\)/.test(fn),
    'в отдельную строку тыкать нельзя: промах закроет чужую позицию');
});

test('после закрытия позиций уровни по токену снимаются', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  assert.ok(/function clearTakes/.test(src), 'нет снятия уровней');
  const fn = src.slice(src.indexOf('async function onImpulse'), src.indexOf('function clearTakes'));
  assert.ok(fn.includes('const done = !!res.ok'),
    'снимать уровни можно только если закрытие правда случилось');
  const run = src.slice(src.indexOf('function closeAction'), src.indexOf('function siteActions'));
  assert.ok(run.includes('rowCount() < before') || run.includes('left < before'),
    'закрытие подтверждается уходом позиций со страницы, а не нажатием');
  assert.ok(fn.includes('clearTakes(msg.chain'), 'уровни не снимаются после закрытия');
  assert.ok(fn.includes('forgetRungs('),
    'закрытые ступени надо забыть, иначе они висят на графике');
  const clear = src.slice(src.indexOf('function clearTakes'), src.indexOf('function tell'));
  // Одна дверь на все изменения уровней: сохранить, сказать сторожу и
  // перерисовать график. Разошлись по трём вызовам — что-нибудь забудется.
  assert.ok(clear.includes('takesChanged()'), 'сторож должен узнать, что уровней больше нет');
});

test('на одном токене уживаются уровни на фисы и на закрытие', () => {
  // Уровни хранятся списком объектов, а не числами: у каждого своё действие.
  const asLevel = (x) => (x && typeof x === 'object'
    ? { v: Number(x.v), unit: x.unit === 'mcap' ? 'mcap' : 'price',
        act: x.act === 'close' ? 'close' : 'fees' }
    : { v: Number(x), unit: 'price', act: 'fees' });

  const list = [{ v: 100, unit: 'price', act: 'fees' },
                { v: 140000, unit: 'mcap', act: 'close' }].map(asLevel);
  assert.equal(list.length, 2, 'оба уровня должны сохраняться');
  assert.deepEqual(list.map((x) => x.act), ['fees', 'close']);
  assert.equal(asLevel(55).act, 'fees', 'старый формат читается как сбор фисов');
  assert.equal(asLevel(55).unit, 'price');
});

test('в настройках нет ярлыков с двумя полями сразу', () => {
  // Клик по такому ярлыку всегда попадает в первое поле — вторую галку
  // мышью не нажать вовсе. Ровно на этом сломался выбор нижнего края.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  const menu = src.slice(src.indexOf('<div class="menu"'), src.indexOf('</div>\n      </div>'));
  const bad = [];
  for (const m of menu.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)) {
    const n = (m[1].match(/<input/g) || []).length;
    if (n > 1) bad.push(m[1].replace(/\s+/g, ' ').slice(0, 70));
  }
  assert.deepEqual(bad, [], 'ярлык оборачивает несколько полей: ' + bad.join(' | '));
});

test('меню настроек прокручивается и не уезжает за край окна', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  const css = src.slice(src.indexOf('.menu {'), src.indexOf('.menu label'));
  assert.ok(/max-height:\s*calc\(100% - \d+px\)/.test(css),
    'без потолка высоты нижние настройки уезжают за край и недоступны');
  assert.ok(/overflow-y:\s*auto/.test(css), 'нет прокрутки');

  // Настроек реально больше, чем влезает: если это перестанет быть так,
  // потолок можно будет убрать, но пока он обязателен.
  const menu = src.slice(src.indexOf('<div class="menu"'), src.indexOf('</div>\n      </div>'));
  const rows = (menu.match(/<label/g) || []).length
    + (menu.match(/<div class="(note|row|toks|lvls|pumps)/g) || []).length;
  assert.ok(rows > 25, 'строк в меню ' + rows + ' — потолок высоты ещё нужен');

  // Двойная прокрутка внутри прокрутки — мышь застревает в списке токенов
  assert.ok(!/\.menu \.toks \{[^}]*overflow-y/.test(src),
    'вложенная прокрутка в списке токенов мешает крутить само меню');
});

test('сбор фисов сообщает, на каком шаге встал', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  const fn = src.slice(src.indexOf('function collectAction'), src.indexOf('function siteActions'));
  assert.ok(fn.includes('const fail ='), 'нет отчёта об осечке');
  assert.ok(fn.includes("console.warn('[LLC] сбор фисов встал:'"),
    'причина должна попадать в консоль: по слову «не работает» чинить нечего');
  for (const why of ['панели Fees & PnL нет', 'не смог отметить позиции', 'кнопки «Collect (N)» нет']) {
    assert.ok(fn.includes(why), 'нет сообщения про «' + why + '»');
  }
  assert.ok(fn.includes("impulseNote('сбор: '"), 'шаги должны быть видны в шапке, а не только на кнопке');
});

test('в выборе токена все открытые вкладки, а не только текущая', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  const fn = src.slice(src.indexOf('function tokenChoices'), src.indexOf('function showLevels'));
  assert.ok(fn.includes('...S.tabs'), 'вкладки окна должны попадать в список');
  assert.ok(fn.includes('pageToken()'), 'токен открытой страницы тоже');
  assert.ok(fn.includes('S.takeLevels'), 'токены с уровнями не должны пропадать из списка');
  assert.ok(fn.includes('String(t.addr).toLowerCase()'),
    'адреса из ссылок GMGN приходят в смешанном регистре — иначе задвоятся');
});

test('проверка вхолостую доходит до нажатия и останавливается', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  assert.ok(src.includes('data-a="lvltest"'), 'нет кнопки проверки');
  assert.ok(/function testFire/.test(src), 'нет самой проверки');
  const fn = src.slice(src.indexOf('async function onImpulse'), src.indexOf('async function loadToken'));
  assert.ok(fn.includes('if (msg.dry)'), 'сухой прогон должен останавливаться перед нажатием');
  assert.ok(fn.includes("msg.act === 'close' && !msg.dry"),
    'проверка не должна закрывать позиции по-настоящему');
  assert.ok(fn.includes('loadToken('), 'нужные позиции должны подгружаться сами');
});

test('главный выключатель отделён от срабатывания на импульсе', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  assert.ok(src.includes('data-c="watchOn"') && src.includes('data-c="pumpOn"'),
    'нужны две разные галки: общая и про импульс');
  const watch = fs.readFileSync(path.join(__dirname, '..', 'src', 'watch.js'), 'utf8');
  assert.ok(watch.includes('S.pumpOn === false ? null : impulse('),
    'выключенный импульс не должен глушить уровни и край');
  const push = src.slice(src.indexOf('function pushWatch'), src.indexOf('function save()'));
  assert.ok(push.includes('pumpOn'), 'настройка не доезжает до сторожа');
});

test('вкладка без подписи получает символ токена из цепи', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  assert.ok(/function askSymbol/.test(src), 'символ не запрашивается');
  const fn = src.slice(src.indexOf('function askSymbol'), src.indexOf('function askSupply'));
  assert.ok(fn.includes('if (!t || !t.addr || t.label) return'),
    'у вкладки с готовой подписью спрашивать нечего');
  assert.ok(fn.includes('symCache[key] !== undefined'), 'без отметки запрос уйдёт на каждой отрисовке');
  assert.ok(fn.includes('tab.label = r.symbol') && fn.includes('save()'),
    'символ надо запомнить во вкладке, иначе он потеряется при перезагрузке');

  const sw = fs.readFileSync(path.join(__dirname, '..', 'src', 'sw.js'), 'utf8');
  assert.ok(/async symbol\(\{ chain, addr \}\)/.test(sw), 'воркер не умеет отдавать символ');

  // и в самой вкладке, и в списках вместо пустоты — короткий адрес
  assert.ok(src.includes("|| short(t.addr)"), 'пустая подпись недопустима');
});

test('закрытая ступень не висит на графике', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  assert.ok(/RUNGS_TTL = 15 \* 60000/.test(src),
    'у запомненных ступеней должен быть срок годности: иначе закрытый пул виден вечно');
  assert.ok(src.includes("Date.now() - (cached.savedAt || 0) > RUNGS_TTL"),
    'протухший кэш надо выбрасывать, а не отдавать на график');

  const fn = src.slice(src.indexOf('function forgetRungs'), src.indexOf('// ---------- разбор страницы'));
  assert.ok(fn.includes('delete rungCache[k]'), 'ступени не забываются');
  assert.ok(/if \(\+\+n < 6\) setTimeout\(again, 800 \* Math\.pow\(1\.6, n\)\)/.test(fn),
    'перечитывать надо несколько раз, но с растущим шагом, а не долбить страницу');
  assert.ok(/\^\(close\|collect\|update\\s\+fees\|refresh\\s\+fees\)/.test(src),
    'сброс должен срабатывать на Close, Collect и на пересчёт комиссий');
});

test('пересчёт комиссий обновляет и ступени, и глубину', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  const fees = src.slice(src.indexOf('function feesAction'), src.indexOf('function feesAction') + 2600);
  assert.ok(fees.includes('refreshLiquidity()'), 'глубина не перечитывается');
  assert.ok(fees.includes('forgetRungs(pageToken() || active())'),
    'после пересчёта сайт перерисовывает таблицу — ступени надо перечитать');
  // и на промахе тоже: таблица могла обновиться, даже если сводку не дождались
  const tail = fees.slice(fees.indexOf("done('не дождался')") - 200);
  assert.ok(tail.includes('forgetRungs'), 'на таймауте ступени тоже устарели');
});

test('все настройки окна переживают перезагрузку', () => {
  // Список сохраняемых ключей ведётся руками, а настроек уже под сорок —
  // забытая просто молча сбрасывается при следующем заходе.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  const block = src.slice(src.indexOf('const DEFAULTS = {'), src.indexOf('let S = { ...DEFAULTS }'));
  const keys = [...block.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
  assert.ok(keys.length > 30, 'настройки не нашлись, проверка бессмысленна');

  const save = src.slice(src.indexOf('function save()'), src.indexOf('function load()'));
  const missing = keys.filter((k) => !new RegExp('\\b' + k + '\\b').test(save));
  assert.deepEqual(missing, [], 'не сохраняются: ' + missing.join(', '));
});

test('чужой PnL не попадает в шапку', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  const at = src.indexOf('function showNumbers');
  const fn = src.slice(at, src.indexOf('\n  }\n', at));
  assert.ok(fn.includes('const sum = same ? readSummary() : null'),
    'панель «Fees & PnL» на странице одна — брать её можно только для своего токена');
  assert.ok(fn.includes('pageToken()'), 'не с чем сравнивать');
});

test('техническая мелочь спрятана, на виду только нужное', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  const menu = src.slice(src.indexOf('<div class="menu" hidden>'),
                         src.indexOf('<div class="note">Что рисовать на графике</div>'));
  const more = menu.slice(menu.indexOf('<div class="more" hidden>'));

  assert.ok(menu.includes('data-a="more"'), 'нет переключателя тонкой настройки');
  assert.ok(/more: false/.test(src), 'блок должен быть свёрнут по умолчанию');

  // частоты опроса и прочая техника — внутри свёрнутого блока
  // edgePct вынесен наверх: это не мелочь, а ширина области сбора у края
  for (const k of ['feesSec', 'quietSec', 'everySec', 'fadePct']) {
    assert.ok(more.includes('data-n="' + k + '"'), k + ' должен быть в тонкой настройке');
  }
  // а главное — снаружи
  const head = menu.slice(0, menu.indexOf('<div class="more" hidden>'));
  for (const k of ['watchOn', 'feesOn', 'pumpOn', 'edgeHi', 'edgeLo']) {
    assert.ok(head.includes('data-c="' + k + '"'), k + ' прятать нельзя');
  }
  assert.ok(head.includes('data-n="minUsd"'), 'порог — главная настройка, она на виду');
});

test('окно подхватывает обновлённый список леддеров без перезагрузки', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  assert.ok(src.includes('chrome.storage.onChanged.addListener'),
    'без этого в окне висят леддеры с момента загрузки страницы');
  const at = src.indexOf('chrome.storage.onChanged.addListener');
  const fn = src.slice(at, src.indexOf('} catch (e)', at));
  assert.ok(fn.includes('pairs = box.pairs'), 'список не подхватывается');
  assert.ok(fn.includes('pruneWatch()'), 'настройки закрытых леддеров надо убрать');
  assert.ok(fn.includes('render()'), 'список токенов в настройках должен перерисоваться');
});

test('суммы с пробелом между тысячами не теряются', () => {
  const { parse } = load('manage.html');
  // Сайт мешает две записи на одной странице: цены по-английски,
  // деньги по-русски и с пробелом. На «$1 515,07» разбор давал NaN,
  // и позиция на полторы тысячи просто пропадала с графика.
  assert.equal(parse.moneyOf('$1 515,07'), 1515.07);
  assert.equal(parse.moneyOf('$1 234 567,89'), 1234567.89);
  assert.equal(parse.moneyOf('$953,93'), 953.93);
  assert.equal(parse.moneyOf('$423.72'), 423.72, 'английская запись тоже должна работать');
  assert.equal(parse.moneyOf('$1,515.07'), 1515.07, 'запятая как разделитель тысяч');
  assert.equal(parse.moneyOf('$0.001776'), 0.001776, 'цены ломать нельзя');
  assert.equal(parse.moneyOf('-$1 515,07'), -1515.07, 'знак сохраняется');
  assert.equal(parse.moneyOf('$-52.89 (-10.6%)'), -52.89, 'хвост после числа не мешает');
  assert.equal(parse.moneyOf(''), null);
});

test('в сайз попадают все позиции таблицы, а не часть', () => {
  const { doc, parse } = load('manage.html');
  // Добавляем строку с русской записью суммы — раньше она выпадала.
  const rows = doc.getElementById('positions');
  const extra = doc.createElement('div');
  extra.className = 'row';
  extra.innerHTML = '<span class="range">$0.000263 – $0.000393</span>'
    + '<span>BID</span><span>$1 515,07</span><span>Active</span>';
  rows.appendChild(extra);

  const parsed = parse.rowsIn(rows);
  const big = parsed.find((r) => r.lo === 0.000263);
  assert.ok(big, 'строка не разобралась вовсе');
  assert.equal(big.value, 1515.07, 'сумма с пробелом обязана распознаться');
});

test('ничего не собирается само, пока это не включили отдельно', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  const box = src.slice(src.indexOf('const DEFAULTS = {'), src.indexOf('let S = { ...DEFAULTS }'));
  // Главный выключатель сам по себе не должен запускать трату газа.
  for (const k of ['watchOn', 'feesOn', 'pumpOn', 'edgeOn']) {
    assert.ok(new RegExp(k + ':\\s*false').test(box),
      k + ' обязан быть выключен по умолчанию: это действие с деньгами без спроса');
  }
  const watch = fs.readFileSync(path.join(__dirname, '..', 'src', 'watch.js'), 'utf8');
  const wbox = watch.slice(watch.indexOf('const WATCH_DEFAULTS'), watch.indexOf('// токен ->'));
  for (const k of ['on', 'feesOn', 'pumpOn', 'edgeOn']) {
    assert.ok(new RegExp('\\b' + k + ':\\s*false').test(wbox),
      k + ' в стороже тоже должен быть выключен');
  }
  assert.ok(src.includes('СОБИРАЕТ САМ:'),
    'человек должен видеть прямым текстом, что именно заряжено');
});

test('верхние края ступеней можно отмечать по отдельности', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  assert.ok(src.includes('<div class="edges"></div>'), 'нет места под список краёв');
  const fn = src.slice(src.indexOf('function showEdges'), src.indexOf('/** Уровни и выбор токена'));
  assert.ok(fn.includes('rungCache['), 'края берутся из ступеней леддера');
  assert.ok(fn.includes('.sort((a, b) => b.hi - a.hi)'), 'сверху вниз, как на графике');
  assert.ok(fn.includes("box2.dataset.e"), 'галка не привязана к цене края');
  assert.ok(fn.includes('ступени неизвестны'), 'пустой случай надо назвать словами');

  // отметка края — это обычный уровень: та же механика и та же линия на графике
  const h = src.slice(src.indexOf("const edge = e.target.closest('input[data-e]')"),
                      src.indexOf("const tok = e.target.closest('input[data-w]')"));
  assert.ok(h.includes("unit: 'price'"), 'край должен становиться обычным уровнем');
  assert.ok(h.includes('edgePrice(hi)'), 'уровень ставится со смещением от края');
  assert.ok(h.includes("x.from === hi"),
    'искать надо по источнику: смещение можно поменять, и цена станет другой');
  assert.ok(h.includes('takesChanged()'), 'сторож должен узнать сразу');
});

test('заголовки берутся и с объекта Request', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'tap.js'), 'utf8');
  const fn = src.slice(src.indexOf('function remember'), src.indexOf('const origFetch'));
  assert.ok(fn.includes('headersOf(input && input.headers ? input : null)'),
    'при fetch(new Request(...)) заголовки лежат на запросе, а не в init');
  assert.ok(src.includes('АВТОРИЗАЦИИ НЕТ'),
    'в консоли должно быть видно, поймали мы авторизацию или нет');
});

test('в отчёте видно, какая версия расширения загружена', () => {
  // Половина «не работает» — это незагруженная сборка. Выяснять её по тексту
  // сообщений — плохой способ, пусть пишется прямо.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  const fn = src.slice(src.indexOf('function checkCollect'), src.indexOf('function testFire'));
  assert.ok(fn.includes('chrome.runtime.getManifest().version'), 'версия не берётся');
  assert.ok(fn.includes("['расширение ' + ver]"), 'версия не попадает в отчёт');
});

test('страницу, за которой человек работает, расширение не трогает', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'll', 'overlay.js'), 'utf8');
  assert.ok(/HUMAN_QUIET = 5 \* 60000/.test(src), 'нет понятия «человек за страницей»');
  const load = src.slice(src.indexOf('async function loadToken'),
                         src.indexOf('async function loadToken') + 700);
  assert.ok(load.includes("document.visibilityState === 'visible'"),
    'видимую вкладку подменять нельзя вовсе');
  assert.ok(load.includes('Date.now() - humanAt < HUMAN_QUIET'),
    'и фоновую — сразу после его работы в ней');

  const click = src.slice(src.indexOf("document.addEventListener('click'"),
                          src.indexOf("document.addEventListener('click'") + 300);
  assert.ok(click.includes('humanAt = Date.now()'), 'клик человека не отмечается');
  assert.ok(click.indexOf('ownClickUntil') < click.indexOf('humanAt'),
    'свои же нажатия не должны считаться за человека');

  const imp = src.slice(src.indexOf('async function onImpulse'), src.indexOf('async function loadToken'));
  assert.ok(imp.includes('вкладка открыта у тебя на экране'),
    'надо сказать, почему не сработало');
});

test("подгрузка включена и не может сработать мимо", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  assert.ok(/autoLoad: true/.test(src), "функция нужна — она должна работать");
  // У тех, кто застал версии, где её пришлось выключить, возвращаем обратно.
  const init = src.slice(
    src.indexOf("S.calmed !== true"),
    src.indexOf("S.calmed !== true") + 200,
  );
  assert.ok(init.includes("S.autoLoad = true"), "вернуть включённой");
  assert.ok(init.includes("S.calmed = true"), "и запомнить, что уже возвращали");
});

test("поле выбора токена следует за открытым графиком", () => {
  // Иначе уровень уходит не туда: смотришь MONEY, а лимитка ставится на DOGGO.
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  const at = src.indexOf("function showLevels");
  const fn = src.slice(at, at + 2000);
  assert.ok(fn.includes("const t = active();"), "поле не смотрит на активную вкладку");
  assert.ok(fn.includes("ui.lvltok.value = want"), "значение поля не подставляется");
  assert.ok(
    fn.includes("want !== lvlFollows"),
    "ручной выбор перебивать нельзя — только при смене открытого токена",
  );
  assert.ok(fn.includes("ui.pumptok.value = want"), "второе поле тоже должно следовать");
});

test("уровень от края ставится со смещением и выбранным действием", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  assert.ok(src.includes('data-n="edgeShift"'), "нет поля смещения");
  assert.ok(src.includes('class="btn edgeact"'), "нет выбора действия");
  assert.ok(/edgeShift: -10/.test(src), "по умолчанию за 10% до края");

  // сам расчёт: минус — раньше края, плюс — за ним
  const price = (hi, shift) => {
    const v = hi * (1 + shift / 100);
    return isFinite(v) && v > 0 ? v : hi;
  };
  assert.ok(Math.abs(price(0.002, -10) - 0.0018) < 1e-12, "−10% — это 0.0018 от 0.002");
  assert.ok(Math.abs(price(0.002, 0) - 0.002) < 1e-12, "ноль — ровно на крае");
  assert.ok(Math.abs(price(0.002, 5) - 0.0021) < 1e-12, "плюс — за краем");
  assert.equal(price(0.002, -200), 0.002, "бессмысленное смещение не должно давать ноль или минус");
});

test("панель настроек не растягивается на пол-экрана", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  const css = src.slice(src.indexOf(".menu {"), src.indexOf(".menu label"));
  assert.ok(/width:\s*\d+px/.test(css), "без заданной ширины длинные подписи растягивают панель");
  assert.ok(/max-width:\s*calc\(100% - \d+px\)/.test(css), "в узком окне панель должна ужиматься");
  assert.ok(/box-sizing:\s*border-box/.test(css), "иначе отступы вылезут за ширину");
});

test("область сбора у края настраивается и видна сразу", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  const menu = src.slice(
    src.indexOf('<div class="menu" hidden>'),
    src.indexOf('<div class="more" hidden>'),
  );
  assert.ok(menu.includes('data-n="edgePct"'), "область сбора нельзя прятать в мелочь");
  assert.ok(menu.includes("% от границы"), "подпись должна говорить, что это ширина области");
});

test("поручение берёт ровно одна вкладка", () => {
  // Если разослать всем, каждая свободная возьмётся за дело — и один и тот
  // же сбор уйдёт в цепь несколько раз.
  const wt = fs.readFileSync(path.join(__dirname, "..", "src", "watch.js"), "utf8");
  assert.ok(/async function handOut/.test(wt), "нет раздачи по одной вкладке");
  const fn = wt.slice(wt.indexOf("async function handOut"), wt.indexOf("function recordOutcome"));
  assert.ok(fn.includes("for (const tab of own)"), "обходим только свои вкладки, по очереди");
  assert.ok(fn.includes("tabs.filter((tab) => mine.has(tab.id))"),
    "вкладки человека в раздачу попадать не должны вовсе");
  assert.ok(fn.includes("if (r && r.handled) return { tabId: tab.id, r }"),
    "взялась одна — остальным не предлагаем");
  // Молчание — это «занята делом», а не отказ. Иначе тот же сбор уходил
  // следующей вкладке, то есть второй раз.
  assert.ok(/finish\(\{ handled: true, did: "unknown"/.test(fn),
    "молчащая вкладка считается занятой, а не отказавшей");
  assert.ok(fn.includes("clearTimeout(timer)"), "таймер ожидания надо снимать");
  assert.ok(!/for \(const tab of tabs\) \{\s*tell\(tab\.id, msg\);/.test(wt),
    "рассылки всем подряд быть не должно");

  const ov = fs.readFileSync(path.join(__dirname, "..", "src", "ll", "overlay.js"), "utf8");
  assert.ok(ov.includes("reply(r && typeof r === 'object' ? r : { handled: !!r })"),
    "вкладка должна отвечать, чем кончилось");
  const imp = ov.slice(ov.indexOf("async function onImpulse"), ov.indexOf("async function loadToken"));
  assert.ok(imp.includes("return false;"), "отказ должен быть явным");
  for (const did of ["wait", "dry", "closed", "fail"]) {
    assert.ok(imp.includes("did: '" + did + "'"), "исход «" + did + "» должен называться");
  }
});

test("настройки уровня стоят под своим заголовком", () => {
  // Блок краёв ступеней вклинивался между заголовком «Ручные уровни» и его
  // же полями — и было непонятно, к чему относится нижний выпадающий список.
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  // Ищем только в разметке: то же название встречается и в комментарии выше.
  const markup = src.slice(src.indexOf('<div class="menu" hidden>'));
  const at = (m) => markup.indexOf(m);
  const lvlHead = at("Ручные уровни тейка");
  const lvlAct = at('class="btn lvlact"');
  const edgeHead = at("Верхние края ступеней");
  const edgeAct = at('class="btn edgeact"');

  assert.ok(lvlHead < lvlAct, "поля уровня должны идти после своего заголовка");
  assert.ok(lvlAct < edgeHead, "блок краёв не должен разрывать блок уровней");
  assert.ok(edgeHead < edgeAct, "и у краёв свои поля тоже после заголовка");

  // и оба выбора действия на месте
  for (const cls of ["lvlact", "edgeact"]) {
    // Смещения считаются от разметки, а не от всего файла.
    const box = markup.slice(at('class="btn ' + cls + '"'), at('class="btn ' + cls + '"') + 400);
    assert.ok(box.includes("закрыть позиции"), cls + ": нет выбора «закрыть позиции»");
    assert.ok(box.includes("собрать фисы"), cls + ": нет выбора «собрать фисы»");
  }
});

test("во время своего нажатия числа в шапке не перечитываются", () => {
  // Сайт перерисовывает панель «Fees & PnL», и в середине этого числа в ней
  // неполные: в шапку попадал чужой PnL, а через секунду сам собой чинился.
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  assert.ok(/const acting = \(\) => Date\.now\(\) < actingUntil/.test(src),
    "нет признака «мы сейчас жмём сами»");
  const fn = src.slice(src.indexOf("function showNumbers"), src.indexOf("function showNumbers") + 500);
  assert.ok(fn.includes("if (acting()) return;"), "числа читаются во время нажатия");

  // все три наших действия обязаны помечаться
  assert.equal((src.match(/actNow\(/g) || []).length, 3,
    "каждое наше нажатие должно ставить заморозку");
  // и снимать её, а не ждать, пока истечёт время
  assert.ok((src.match(/actingUntil = 0;/g) || []).length >= 3,
    "после действия заморозку надо снимать сразу");
});

test("вкладку, открытую на экране, расширение не подменяет", () => {
  // Человек может смотреть в неё и не кликать — по времени это неотличимо
  // от заброшенной, а подмена содержимого прямо на глазах хуже всего.
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  const load = src.slice(src.indexOf("async function loadToken"),
                         src.indexOf("async function loadToken") + 600);
  assert.ok(load.includes("document.visibilityState === 'visible'"),
    "видимая вкладка должна отказываться сразу");
  assert.ok(load.indexOf("visibilityState") < load.indexOf("HUMAN_QUIET"),
    "проверка видимости обязана идти до проверки по времени");

  const wt = fs.readFileSync(path.join(__dirname, "..", "src", "watch.js"), "utf8");
  const hand = wt.slice(wt.indexOf("async function handOut"), wt.indexOf("async function handOut") + 500);
  assert.ok(hand.includes("mine.has(tab.id)"),
    "в чужой вкладке расширение не действует вовсе — там только график");
});

test("края ступеней отмечаются все разом", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  assert.ok(src.includes('data-a="edgeall"') && src.includes('data-a="edgenone"'),
    "нет кнопок «все» и «никого» у краёв");
  const fn = src.slice(src.indexOf("function allEdges"), src.indexOf("function edgePrice"));
  assert.ok(fn.includes("edgePrice(r.hi)"), "смещение должно применяться и здесь");
  assert.ok(fn.includes("list.some((x) => x.from === r.hi)"), "второй раз тот же край не добавляем");
  assert.ok(fn.includes("list.filter((x) => x.from === null)"),
    "снимать надо только края: вписанные руками уровни трогать нельзя");
});

test("отрицательное смещение не обрезается в ноль", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "ll", "overlay.js"),
    "utf8",
  );
  // в комментарии эта строка упоминается намеренно — ищем именно вызов
  assert.ok(!/const min = Number\(box\.min\)/.test(src),
    "у поля без атрибута min это ноль — и минус молча превращался в ноль");
  assert.ok(src.includes("box.getAttribute('min')"), "границу надо читать как атрибут");

  // сам разбор
  const clamp = (rawMin, value) => {
    const min = rawMin === null || rawMin === "" ? null : Number(rawMin);
    const v = parseInt(value, 10);
    return min !== null && isFinite(min) ? Math.max(min, v) : v;
  };
  assert.equal(clamp(null, "-10"), -10, "смещение вниз должно сохраняться");
  assert.equal(clamp("", "-10"), -10, "пустой атрибут — это «без границы»");
  assert.equal(clamp("0", "-10"), 0, "а заданный ноль по-прежнему обрезает");
  assert.equal(clamp("1", "0"), 1, "минимум в единицу тоже работает");
});


test("числа шапки GMGN доезжают до окна", () => {
  const bridge = fs.readFileSync(path.join(__dirname, "..", "src", "bridge.js"), "utf8");
  const panel = fs.readFileSync(path.join(__dirname, "..", "src", "panel.js"), "utf8");
  const ov = fs.readFileSync(path.join(__dirname, "..", "src", "ll", "overlay.js"), "utf8");

  assert.ok(/function headStats/.test(bridge), "числа из шапки никто не читает");
  assert.ok(bridge.includes("head: headStats()"), "и не отправляет");
  assert.ok(panel.includes("type: 'head', head: d.head"), "панель не передаёт их наверх");
  assert.ok(ov.includes("if (d.type === 'head')"), "окно их не принимает");
  assert.ok(ov.includes("headOf.set(k,"), "и не запоминает по вкладке");
});

test("мешок считается по формулам пула, а не делением на середину", () => {
  // Сумма ступени у сайта — по ТЕКУЩЕЙ цене. Раньше её делили на середину
  // ступени, и у ступеней высоко над рынком мешок занижался в разы.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "bridge.js"), "utf8");
  const body = src.slice(src.indexOf("function rungSplit(r, cur)"));
  const rungSplit = new Function("return " + body.slice(0, body.indexOf("\n  }") + 4))();

  // Ступень 100..400 целиком над рынком при цене 100: $100 — это ровно
  // 1 токен, и продастся он в среднем по √(100·400) = 200.
  const up = rungSplit({ lo: 100, hi: 400, value: 100 }, 100);
  assert.ok(Math.abs(up.tokens - 1) < 1e-9, "над рынком: токенов = сумма / цена, вышло " + up.tokens);
  assert.ok(Math.abs(up.proceeds / up.tokens - 200) < 1e-9, "уйдёт по среднему геометрическому границ");
  assert.ok(Math.abs(up.quote) < 1e-9, "котировки над рынком нет");

  // Ступень ниже цены: только котировка, токена нет.
  const down = rungSplit({ lo: 50, hi: 90, value: 100 }, 100);
  assert.equal(down.tokens, 0, "ступень ниже цены токена не держит");
  assert.ok(Math.abs(down.quote - 100) < 1e-9);

  // Цена внутри ступени: части вместе дают всю ступень.
  const mid = rungSplit({ lo: 100, hi: 400, value: 100 }, 200);
  assert.ok(mid.tokens > 0 && mid.quote > 0);
  assert.ok(Math.abs(mid.tokenUsd + mid.quote - 100) < 1e-9, "выше + ниже = вся ступень");
  assert.ok(Math.abs(mid.proceeds / mid.tokens - Math.sqrt(200 * 400)) < 1e-9);

  const fn = src.slice(src.indexOf("function drawMine"), src.indexOf("function drawSize"));
  assert.ok(fn.includes("rungSplit(r, cur)"), "линия обязана считаться той же формулой");
});

test("подпись у линии мешка не выдаёт себя за цену входа", () => {
  // Токен лежит в ступенях выше рынка и ждёт продажи. Подпись «средняя»
  // читалась как средняя покупка — и не сходилась с плюсовым PnL.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "bridge.js"), "utf8");
  const fn = src.slice(src.indexOf("function drawMine"), src.indexOf("function drawSize"));
  assert.ok(fn.includes("'мешок ' + nice(tokens)") && fn.includes("' · уйдёт по ~'"),
    "подпись должна говорить, что это цена будущей продажи");
  assert.ok(!/средняя /.test(fn), "слово «средняя» здесь вводит в заблуждение");
});

test("на линии мешка пишется доля выпуска, а не только штуки", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "bridge.js"), "utf8");
  const fn = src.slice(src.indexOf("function drawMine"), src.indexOf("function drawSize"));
  assert.ok(fn.includes("L.supply"), "долю считаем от выпуска, который шлёт страница");
  assert.ok(fn.includes("саплая"), "доля должна быть подписана");
  // Без выпуска подпись обязана остаться прежней, а не превратиться в «0%».
  assert.ok(fn.includes("shareText(tokens, supply)"), "доля считается общей функцией");
  const st = src.slice(src.indexOf("function shareText"), src.indexOf("const fmtPx"));
  const shareText = new Function("return " + st.trim())();
  assert.equal(shareText(100, 0), "", "нет выпуска — нет и доли, а не «0%»");
  assert.equal(shareText(12e6, 1e9), "1.2%");
  assert.equal(shareText(1, 1e9), "<0.01%");

  const ov = fs.readFileSync(path.join(__dirname, "..", "src", "ll", "overlay.js"), "utf8");
  assert.ok(ov.includes("levels.supply = Number(supplyCache"), "выпуск надо положить в посылку");
});

test("подписи на графике не ложатся друг на друга", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "bridge.js"), "utf8");
  // Берём настоящий place() из файла и проверяем на пересекающихся коробках.
  const body = src.slice(src.indexOf("function place(taken"));
  const place = new Function("return " + body.slice(0, body.indexOf("\n  }") + 4))();

  const taken = [{ x: 0, y: 100, w: 200, h: 20 }];
  const got = place(taken, [
    { x: 50, y: 105, w: 100, h: 14 },   // прямо внутри занятого
    { x: 50, y: 130, w: 100, h: 14 },   // а это свободно
  ]);
  assert.equal(got.y, 130, "должен взять свободное место, а не первое");
  assert.equal(taken.length, 2, "занятое место обязано запомниться");

  const stuck = place(taken, [{ x: 0, y: 100, w: 10, h: 10 }]);
  assert.equal(stuck.y, 100, "совсем некуда — рисуем как есть, но не пропадаем");
});

test("снятый уровень пропадает с графика сразу, а не когда-нибудь", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "ll", "overlay.js"), "utf8");
  const fn = src.slice(src.indexOf("function takesChanged"), src.indexOf("function dropLevel"));
  assert.ok(fn.includes("domDirty = true") && fn.includes("pushLevels()"),
    "без этого линия остаётся на графике до ближайшего изменения страницы");
  assert.ok(fn.includes("pushWatch()"), "сторожу тоже надо сказать");

  // И ни одно место не должно менять уровни в обход этой двери.
  const stray = [...src.matchAll(/S\.takeLevels = box;\n(\s*)([^\n]*)/g)]
    .map((m) => m[2].trim())
    .filter((line) => !line.startsWith("takesChanged()") && !line.startsWith("ui.lvlval"));
  assert.deepEqual(stray, [], "уровни меняются мимо takesChanged: " + stray.join(" | "));
});

test("снятый в одной вкладке тейк убирается во всех", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "ll", "overlay.js"), "utf8");
  assert.ok(src.includes("chrome.storage.onChanged.addListener"),
    "без слушателя вторая вкладка живёт со старыми уровнями и сработает от них");
  const fn = src.slice(src.indexOf("const SHARED = ["), src.indexOf("chrome.storage.local.get('ghoRpc'"));
  assert.ok(/SHARED = \[[^\]]*'takeLevels'/s.test(fn), "уровни обязаны разъезжаться по вкладкам");
  for (const own of ["geom", "tabs", "active", "zoom"]) {
    assert.ok(!new RegExp("'" + own + "'").test(fn.slice(0, fn.indexOf("];"))),
      own + " у каждой вкладки свой — подменять его чужим нельзя");
  }
  assert.ok(!/\bsave\(\)/.test(fn), "в ответ сохранять нельзя: вкладки будут будить друг друга");
});

test("перед Close отмечены все позиции, а не хоть одна", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "ll", "overlay.js"), "utf8");
  const fn = src.slice(src.indexOf("async function ensureSelection"), src.indexOf("function collectAction"));
  assert.ok(fn.includes("const total = rowCount()"), "надо знать, сколько позиций всего");
  assert.ok(fn.includes("selectedCount() >= total"), "готово — только когда отмечены все");
  assert.ok(!/if \(selectedCount\(\) > 0\) return true/.test(fn),
    "«хоть одна» — это частичное закрытие, когда просили выйти целиком");
  assert.ok(/await selectRows\(\);\s*return full\(\);/.test(fn), "запасной путь тоже обязан сверить итог");
});

test("безубыток всей сумки: ступени + фисы + собранное против вложенного", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "bridge.js"), "utf8");
  const grab = (name, until) => src.slice(src.indexOf(name), src.indexOf(until));
  const code = [
    grab("function rungSplit(r, cur)", "/** Стоимость ступени"),
    grab("function rungWorthAt", "const STABLE"),
    grab("const STABLE", "/**\n   * Безубыток"),
    grab("function breakEven", "/** Доля выпуска"),
  ].join("\n");
  const breakEven = new Function(code + "\nreturn breakEven;")();

  // Ступень 100..400 над рынком, цена 100: 1 токен, на верху станет $200.
  const rungs = [{ lo: 100, hi: 400, value: 100 }];

  // Вложил 150, фисов нет: сейчас −50, БУ где-то внутри ступени.
  const a = breakEven({ rungs, cost: 150 }, 100);
  assert.ok(Math.abs(a.pnl + 50) < 1e-9, "PnL сейчас −50");
  assert.ok(a.price > 100 && a.price < 400, "БУ внутри ступени, вышло " + a.price);
  // Проверка по определению: стоимость ступени в точке БУ равна вложенному.
  const sa = 10, sb = 20, sp = Math.sqrt(a.price);
  const L = 100 / (100 * (1 / 10 - 1 / 20));
  const worth = L * (1 / sp - 1 / sb) * a.price + L * (sp - sa);
  assert.ok(Math.abs(worth - 150) < 1e-6, "в точке БУ сумка стоит ровно вложенное");

  // Уже собранные $60 фисов — и мы в плюсе, БУ ниже цены.
  const b = breakEven({ rungs, cost: 150, claimedUsd: 60 }, 100);
  assert.ok(Math.abs(b.pnl - 10) < 1e-9);
  assert.ok(b.price < 100, "в плюсе — БУ ниже рынка");

  // Фисы в токене дорожают с ценой и приближают БУ.
  const c = breakEven({ rungs, cost: 150, feeTok: 0.2, feeQuotes: [] }, 100);
  assert.ok(c.price < a.price, "токен в фисах опускает точку безубытка");

  // Вложил больше, чем ступени дадут даже на самом верху.
  const d = breakEven({ rungs, cost: 300 }, 100);
  assert.ok(d.never && Math.abs(d.best + 100) < 1e-6, "на верху −100, БУ недостижим");

  // Без вложенного считать нечего.
  assert.equal(breakEven({ rungs }, 100), null);
});


test("автосбор у верхней границы — своя галка и выключается отдельно", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "ll", "overlay.js"), "utf8");
  assert.ok(src.includes('data-c="edgeHi"') && src.includes("Автосбор фисов у ВЕРХНЕЙ границы"),
    "верхняя граница — отдельная, прямо подписанная галка");
  assert.ok(!src.includes('data-c="edgeOn"'), "общей галки «у края» быть не должно — из-за неё было непонятно, что включено");
  const push = src.slice(src.indexOf("function pushWatch"), src.indexOf("function save()"));
  assert.ok(push.includes("edgeOn: edgeArmed()"), "сторожу край включён, только если отмечен верх или низ");
  assert.ok(push.includes("edgeHi: S.edgeHi === true"), "не отмечено — значит выключено");
  assert.ok(/edgeHi: false,/.test(src.slice(src.indexOf("const DEFAULTS = {"))), "по умолчанию выключен");
  const mig = src.slice(src.indexOf("if (S.edgeSplit !== true)"), src.indexOf("if (S.edgeSplit !== true)") + 300);
  assert.ok(mig.includes("if (S.edgeOn !== true) { S.edgeHi = false; S.edgeLo = false; }"),
    "кто общий край не включал — у того обе новые галки выключены");
});

test("не знаем, сколько фисов, — не собираем", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "ll", "overlay.js"), "utf8");
  const fn = src.slice(src.indexOf("async function onImpulse"), src.indexOf("async function loadToken"));
  assert.ok(fn.includes("if (have === null && !msg.dry)"), "неизвестная сумма не должна пропускать порог");
  assert.ok(fn.includes("did: 'wait', why: 'не видно сумму фисов на странице'"));
  assert.ok(fn.indexOf("if (have === null && !msg.dry)") < fn.indexOf("await act.run(null)"),
    "проверка обязана стоять до нажатия");
});

test("адрес токена берётся и из ссылки GMGN с рефкодом", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "bridge.js"), "utf8");
  const body = src.slice(src.indexOf("function ctxFromPath(path)"));
  const ctxFromPath = new Function("return " + body.slice(0, body.indexOf("\n  }") + 4))();
  const A = "0x462DfF4be800C77A61E69dC2EA6010E4237F674d";
  // Ровно та ссылка, на которой панель писала «HTTP 400».
  assert.deepEqual(ctxFromPath("/robinhood/token/LbosYDck_" + A), { chain: "robinhood", token: A });
  assert.deepEqual(ctxFromPath("/robinhood/token/" + A), { chain: "robinhood", token: A });
  const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
  assert.deepEqual(ctxFromPath("/sol/token/abcd_" + MINT), { chain: "sol", token: MINT });
  assert.equal(ctxFromPath("/robinhood/token/LbosYDck"), null, "рефкод без адреса — не адрес");

  const pn = fs.readFileSync(path.join(__dirname, "..", "src", "panel.js"), "utf8");
  const re = eval(/const TOKEN_RE = ([^;]+);/.exec(pn)[1]);
  assert.equal(re.exec("/robinhood/token/LbosYDck_" + A)[2], A);
  const ov = fs.readFileSync(path.join(__dirname, "..", "src", "ll", "overlay.js"), "utf8");
  const re2 = eval(/const LINK_RE = ([^;]+);/.exec(ov)[1]);
  assert.equal(re2.exec("https://gmgn.ai/robinhood/token/LbosYDck_" + A)[2], A);
});

test("«Session refreshed. Please retry.» — вкладку надо перезагрузить", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "ll", "overlay.js"), "utf8");
  const re = eval(/const RE_RETRY = ([^;]+);/.exec(src)[1]);
  assert.ok(re.test("Session refreshed. Please retry."), "ровно та ошибка, что на скрине");
  const collect = src.slice(src.indexOf("function collectAction"), src.indexOf("async function confirmIfAsked"));
  const close = src.slice(src.indexOf("function closeAction"), src.indexOf("function siteActions"));
  for (const [name, fn] of [["сбор", collect], ["закрытие", close]]) {
    assert.ok(fn.includes("const seen = new Set(retryBanners())"), name + ": запомнить старые сообщения до нажатия");
    assert.ok(fn.includes("await newRetryBanner(seen)"), name + ": реагировать только на новое сообщение");
    assert.ok(fn.includes("reload: true"), name + ": со старой сессией нужна перезагрузка, а не повтор здесь же");
  }
});

test("панель не шлёт данные окну GMGN, которое открыло вкладку", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "panel.js"), "utf8");
  const block = src.slice(src.indexOf("const foreign = (w) =>"), src.indexOf("if (hosts().length)"));
  const location = { origin: "https://gmgn.ai" };
  const gmgnTab = { location: { origin: "https://gmgn.ai" } };
  const llTab = { get location() { throw new Error("cross-origin"); } };
  // окно само себе родитель, открыто другой вкладкой GMGN — хозяина нет
  const w1 = { parent: null, opener: gmgnTab }; w1.parent = w1;
  const h1 = new Function("location", "window", block + "\nreturn hosts;")(location, w1)();
  assert.equal(h1.length, 0, "окно GMGN — не хозяин, слать ему нельзя");
  const w2 = { parent: null, opener: llTab }; w2.parent = w2;
  const h2 = new Function("location", "window", block + "\nreturn hosts;")(location, w2)();
  assert.equal(h2.length, 1, "окно Liquidity Ladder — хозяин");
});

test("сбор не встаёт, если панель «Fees & PnL» ещё не дорисовалась", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "ll", "overlay.js"), "utf8");
  const run = src.slice(src.indexOf("function collectAction"), src.indexOf("const RE_RETRY"));
  assert.ok(run.includes("await waitFor(feesAction, 8000)"), "панель надо подождать, а не проверить один раз");
  assert.ok(!run.includes("fail('панели Fees & PnL нет'); return"),
    "без панели — собирать без пересчёта, порог уже проверен до нажатия");
  const imp = src.slice(src.indexOf("async function onImpulse"), src.indexOf("async function loadToken"));
  assert.ok(imp.includes("await waitFor(feesAction, 8000)"));
  const w = src.slice(src.indexOf("async function waitFor"), src.indexOf("const findBtn"));
  assert.ok(w.includes("openTick()"), "кэш кнопок надо сбрасывать, иначе ждём вечно одно и то же");
});

test("только что собранные фисы не считаются в безубытке второй раз", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "bridge.js"), "utf8");
  const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
  const code = [grab("function rungSplit(r, cur)", "/** Стоимость ступени"), grab("function rungWorthAt", "const STABLE"),
    grab("const STABLE", "/**\n   * Безубыток"), grab("function breakEven", "/** Доля выпуска")].join("\n");
  const breakEven = new Function(code + "\nreturn breakEven;")();
  // TWINE в 10:14: PnL сайта −77.30, несобрано $0 (только что собрали $112.89),
  // а цепь, прочитанная до сбора, ещё показывает 25.7K токена + 50.63 USDG.
  const rungs = [{ lo: 0.002, hi: 0.003, value: 1000 }, { lo: 0.001, hi: 0.002, value: 2800 }];
  const be = breakEven({ rungs, pnlSite: -77.3, unclaimedUsd: 0, claimedUsd: 112.89,
    feeTok: 25700, feeQuotes: [{ symbol: "USDG", amount: 50.63 }] }, 0.00242);
  assert.ok(Math.abs(be.pnl + 77.3) < 0.01, "PnL с фисами обязан совпасть с PnL сайта, вышло " + be.pnl);
});


test("истёкшая сессия: своя вкладка входит заново сама, твоя — только плашка", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "ll", "overlay.js"), "utf8");
  const re = eval(/const RE_EXPIRED = ([^;]+);/.exec(src)[1]);
  assert.ok(re.test("Session expired. Please log in again"));
  assert.ok(re.test("Сессия истекла, войдите снова"));
  const fn = src.slice(src.indexOf("async function selfHeal"), src.indexOf("const RE_LOGOUT"));
  assert.ok(fn.startsWith("async function selfHeal() {\n    if (!ownTab"), "в чужой вкладке ничего не делаем");
  assert.ok(fn.includes("acting()"), "посреди сбора или закрытия страницу не перезагружаем");
  assert.ok(fn.includes("HEAL_GAP"), "не чаще раза в 5 минут — иначе можно зациклиться");
  assert.ok(fn.includes("location.reload()") && fn.includes("tap(btn)"), "обновить и нажать вход");
  assert.ok(fn.includes("/dashboard"), "после входа — за свежим доступом на Dashboard");
  const sw = fs.readFileSync(path.join(__dirname, "..", "src", "sw.js"), "utf8");
  assert.ok(sw.includes("own = self.GHO_WATCH.isMine(id)"), "своя ли вкладка, решает сторож, а не страница");
});
