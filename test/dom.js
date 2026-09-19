// Мини-обвязка: поднимаем jsdom, подсовываем разбор из overlay.js.
// jsdom не считает раскладку, поэтому offsetParent подменяем: он у нас
// означает ровно одно — «элемент не спрятан», и скрытость в фикстурах
// задана через style="display:none".
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

function load(fixture) {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', fixture), 'utf8');
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);

  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      for (let n = this; n; n = n.parentElement) {
        if (n.style && n.style.display === 'none') return null;
      }
      return this.ownerDocument.body;
    },
  });

  global.window = dom.window;
  global.document = dom.window.document;
  // В браузере location — глобальный. Без него обработчик сообщений падал
  // молча, и тест не видел ничего из того, что приходит от перехватчика.
  global.location = dom.window.location;

  delete require.cache[require.resolve(path.join(ROOT, 'src/ll/overlay.js'))];
  const parse = require(path.join(ROOT, 'src/ll/overlay.js'));
  return { dom, doc: dom.window.document, parse };
}

/**
 * Поднять окно целиком на заданном хранилище. Возвращает хранилище, чтобы
 * смотреть, что окно в него записало, и способ пнуть его «изменением из
 * другой вкладки» — так же, как это делает Chrome.
 */
async function bootOverlay(store, fixture = 'manage.html') {
  const { dom, parse } = load(fixture);
  const changed = [];
  const errors = [];
  global.chrome = {
    runtime: {
      id: 'test',
      lastError: null,
      onMessage: { addListener() {} },
      getManifest: () => ({ version: 'test' }),
      sendMessage(msg, cb) { if (cb) cb({ ok: true, tokens: [], rows: [], lastRun: Date.now(), api: false }); },
    },
    storage: {
      local: {
        get(k, cb) {
          const out = typeof k === 'string' ? { [k]: store[k] } : store;
          if (typeof cb === 'function') { cb(out); return undefined; }
          return Promise.resolve(out);
        },
        set: (box) => { Object.assign(store, box); return Promise.resolve(); },
        remove() {},
      },
      onChanged: { addListener: (fn) => changed.push(fn) },
    },
  };
  for (const name of ['MutationObserver', 'HTMLInputElement', 'HTMLElement',
                      'Event', 'CustomEvent', 'MouseEvent', 'Node', 'NodeFilter',
                      'getComputedStyle', 'requestAnimationFrame']) {
    if (dom.window[name] !== undefined) global[name] = dom.window[name];
  }
  dom.window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  const timers = [];
  const realInterval = global.setInterval;
  global.setInterval = (fn, ms) => { const id = realInterval(fn, ms); timers.push(id); return id; };
  await parse.__boot();
  return {
    dom, parse, store, errors,
    /** Как будто другая вкладка или воркер поменяли хранилище. */
    poke(key, value) {
      store[key] = value;
      for (const fn of changed) fn({ [key]: { newValue: value } }, 'local');
    },
    close() {
      for (const id of timers) clearInterval(id);
      global.setInterval = realInterval;
      dom.window.close();
    },
  };
}

module.exports = { load, bootOverlay };
