/*
 * Общий журнал расширения.
 *
 * Зачем: ошибка в сервис-воркере видна только в его консоли, ошибка на
 * странице — только в консоли вкладки, а вкладки сторожа фоновые, и туда
 * никто не смотрит. Поэтому всё пишется в одно место в chrome.storage, и
 * журнал виден в меню расширения — вместе с тем, что случилось до ошибки.
 *
 * Записи однотипные: { ts, level, module, msg, data }. Ключи RPC из строк
 * вырезаются: журнал копируют и присылают, ключу там не место.
 */
(function () {
  const KEY = "ghoLog";
  const CAP = 400; // сколько записей храним
  const FLUSH_MS = 1500; // копим и пишем пачкой: storage не резиновый
  const MAX_LEN = 600; // длина одного текстового поля

  const scope = typeof self !== "undefined" ? self : window;
  if (scope.GHO_LOG) return;

  let queue = [];
  let timer = null;
  let where = "ext";

  /** Ключи и подписи из ссылок наружу не отдаём. */
  function clean(text) {
    return String(text)
      .replace(/([?&](?:api[_-]?key|key|token|apikey)=)[^&\s"']+/gi, "$1…")
      .replace(/\/v2\/[A-Za-z0-9_-]{16,}/g, "/v2/…")
      .replace(/\b(0x[0-9a-fA-F]{6})[0-9a-fA-F]{20,}\b/g, "$1…")
      .slice(0, MAX_LEN);
  }

  /** Данные к записи: без циклов, без громадин, без ключей. */
  function tidy(data) {
    if (data === undefined || data === null) return undefined;
    if (data instanceof Error)
      return { error: clean(data.message), stack: clean(data.stack || "") };
    if (typeof data !== "object") return clean(data);
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (v instanceof Error) out[k] = clean(v.message);
      else if (typeof v === "object") {
        try {
          out[k] = clean(JSON.stringify(v));
        } catch (e) {
          out[k] = "[не сериализуется]";
        }
      } else
        out[k] = typeof v === "number" || typeof v === "boolean" ? v : clean(v);
    }
    return out;
  }

  function flush() {
    timer = null;
    const batch = queue;
    queue = [];
    if (!batch.length) return;
    try {
      chrome.storage.local.get(KEY, (box) => {
        if (chrome.runtime && chrome.runtime.lastError) return;
        const old = box && Array.isArray(box[KEY]) ? box[KEY] : [];
        const next = old.concat(batch).slice(-CAP);
        try {
          chrome.storage.local.set({ [KEY]: next });
        } catch (e) {
          /* переживём */
        }
      });
    } catch (e) {
      /* контекст расширения ушёл — журнал не важнее работы */
    }
  }

  function put(level, module, msg, data) {
    const rec = {
      ts: Date.now(),
      level,
      module: module || where,
      msg: clean(msg),
    };
    const d = tidy(data);
    if (d !== undefined) rec.data = d;
    queue.push(rec);
    if (queue.length > CAP) queue = queue.slice(-CAP);
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
    if (level === "error") {
      try {
        console.error("[gho]", rec.module, rec.msg, rec.data || "");
      } catch (e) {
        /* нет консоли */
      }
    }
    return rec;
  }

  const api = {
    /** Логгер с постоянным именем: воркер и сторож живут в одной области. */
    at(name) {
      return {
        info: (msg, data) => put("info", name, msg, data),
        warn: (msg, data) => put("warn", name, msg, data),
        err: (msg, data) => put("error", name, msg, data),
      };
    },
    /** Кто пишет: «sw», «watch», «overlay», «lp», «menu», «screener». */
    use(name) {
      where = String(name || "ext");
      return api;
    },
    info(msg, data) {
      return put("info", where, msg, data);
    },
    warn(msg, data) {
      return put("warn", where, msg, data);
    },
    err(msg, data) {
      return put("error", where, msg, data);
    },
    /** Ошибки, до которых не дотянулись руками: глобальные обработчики. */
    catchAll() {
      const onErr = (e) => {
        const err = (e && (e.error || e.reason)) || null;
        const file = String((e && e.filename) || (err && err.stack) || "");
        // Чужие ошибки со страниц сайта нам не нужны — только свои файлы.
        if (where !== "sw" && file && !/chrome-extension:\/\//.test(file))
          return;
        put(
          "error",
          where,
          (err && err.message) || String((e && e.message) || e),
          { stack: clean((err && err.stack) || ""), file: clean(file) },
        );
      };
      try {
        scope.addEventListener("error", onErr);
      } catch (e) {
        /* нет окна */
      }
      try {
        scope.addEventListener("unhandledrejection", onErr);
      } catch (e) {
        /* нет окна */
      }
      return api;
    },
    /** Прочитать журнал: для меню расширения. */
    read() {
      return new Promise((res) => {
        try {
          chrome.storage.local.get(KEY, (box) => res((box && box[KEY]) || []));
        } catch (e) {
          res([]);
        }
      });
    },
    clear() {
      queue = [];
      return new Promise((res) => {
        try {
          chrome.storage.local.set({ [KEY]: [] }, () => res(true));
        } catch (e) {
          res(false);
        }
      });
    },
    /** Строкой — чтобы скопировать и прислать. */
    text(list) {
      return (list || [])
        .map((r) => {
          const t = new Date(r.ts).toISOString().slice(11, 19);
          const d = r.data ? " " + JSON.stringify(r.data) : "";
          return `${t} ${r.level} ${r.module}: ${r.msg}${d}`;
        })
        .join("\n");
    },
    KEY,
    CAP,
  };

  scope.GHO_LOG = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
