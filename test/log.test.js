// Журнал: что попадает в записи, что из них вырезается и сколько хранится.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.join(__dirname, "..", "src");

/** Журнал живёт в своей области с chrome.storage — поднимаем такую же. */
function bootLog() {
  const store = {};
  const scope = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Object,
    Array,
    Error,
    String,
    Number,
    Boolean,
    Promise,
    RegExp,
    Math,
    chrome: {
      runtime: { lastError: null },
      storage: {
        local: {
          get(key, cb) {
            cb({ [key]: store[key] });
          },
          set(box, cb) {
            Object.assign(store, box);
            if (cb) cb();
          },
        },
      },
    },
  };
  scope.self = scope;
  scope.globalThis = scope;
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(path.join(SRC, "log.js"), "utf8"), scope, {
    filename: "log.js",
  });
  return { scope, store, log: scope.GHO_LOG };
}

const flushed = (store, log) =>
  new Promise((res) => setTimeout(() => res(store[log.KEY] || []), 1800));

test("журнал пишет записи одного вида и вырезает ключи", async () => {
  const { store, log } = bootLog();
  log.use("sw");
  log.err("узел не ответил", {
    url: "https://robinhood.rpc.orbitflare.com?api_key=ORBIT-SECRET-1234",
    code: 429,
  });
  const list = await flushed(store, log);
  assert.equal(list.length, 1);
  const r = list[0];
  assert.equal(r.level, "error");
  assert.equal(r.module, "sw");
  assert.equal(r.msg, "узел не ответил");
  assert.equal(r.data.code, 429, "числа остаются числами");
  assert.ok(
    !/ORBIT-SECRET/.test(JSON.stringify(r)),
    "ключ не должен попасть в журнал: " + r.data.url,
  );
  assert.match(r.data.url, /api_key=…/);
  assert.ok(r.ts > 0);
});

test("журнал помнит последние записи и не растёт без конца", async () => {
  const { store, log } = bootLog();
  for (let i = 0; i < log.CAP + 25; i++) log.at("watch").info("шаг " + i);
  const list = await flushed(store, log);
  assert.equal(list.length, log.CAP, "храним ровно столько, сколько обещали");
  assert.equal(
    list[list.length - 1].msg,
    "шаг " + (log.CAP + 24),
    "последняя запись — самая свежая",
  );
  assert.equal(list[0].module, "watch", "имя пишущего сохраняется");
});

test("ошибка объектом разбирается на текст и стек, строка читается человеком", async () => {
  const { store, log } = bootLog();
  log.use("overlay").err("сбор не прошёл", new Error("slippage too low"));
  log.warn("повтор 1 из 3", { why: "нет газа" });
  const list = await flushed(store, log);
  assert.match(list[0].data.error, /slippage too low/);
  const text = log.text(list);
  assert.match(text, /error overlay: сбор не прошёл/);
  assert.match(text, /warn overlay: повтор 1 из 3/);
});

test("чужие ошибки со страницы сайта в журнал не идут, свои идут", async () => {
  const { scope, store, log } = bootLog();
  const handlers = [];
  scope.addEventListener = (name, fn) => {
    if (name === "error") handlers.push(fn);
  };
  log.use("overlay").catchAll();
  handlers[0]({
    message: "чужая ошибка сайта",
    filename: "https://liquidityladder.it.com/app.js",
  });
  handlers[0]({
    message: "наша ошибка",
    filename: "chrome-extension://abc/src/ll/overlay.js",
  });
  const list = await flushed(store, log);
  assert.equal(
    list.length,
    1,
    "записалась только своя: " + JSON.stringify(list),
  );
  assert.equal(list[0].msg, "наша ошибка");
});
