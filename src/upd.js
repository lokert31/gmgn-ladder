/*
 * Обновления расширения.
 *
 * Расширение ставится распакованным, а такие Chrome сам не обновляет: новая
 * версия выходит на GitHub, а у человека остаётся старая, и узнать об этом
 * ему неоткуда. Раз в шесть часов спрашиваем у GitHub последний релиз и,
 * если он новее, говорим об этом там, куда человек и так смотрит: значок
 * расширения, меню и шапка окна на Liquidity Ladder.
 *
 * Подменить файлы сами мы не можем — их кладёт человек, распаковав архив
 * поверх своей папки (или `git pull`, если он брал репозиторием). Зато
 * можем перезапустить расширение после этого: chrome.runtime.reload() у
 * распакованного перечитывает папку с диска, и ходить в chrome://extensions
 * не нужно.
 */
(function () {
  const KEY = "ghoUpd";
  const ALARM = "gho-upd";
  const EVERY_MIN = 6 * 60;
  const REPO = "lokert31/gmgn-ladder";
  const API = "https://api.github.com/repos/" + REPO + "/releases/latest";
  const PAGE = "https://github.com/" + REPO + "/releases/latest";
  const NET_MS = 10000; // дольше ждать нечего: проверка не срочная
  const TRIES = 3;

  const log = () =>
    self.GHO_LOG ? self.GHO_LOG.at("upd") : { info() {}, warn() {}, err() {} };

  function mine() {
    try {
      return chrome.runtime.getManifest().version;
    } catch (e) {
      return "0.0.0";
    }
  }

  /** «3.31.0» против «3.4.1»: сравниваем числами, а не строками. */
  function cmpVer(a, b) {
    const x = String(a || "")
      .split(/[^\d]+/)
      .filter((s) => s !== "");
    const y = String(b || "")
      .split(/[^\d]+/)
      .filter((s) => s !== "");
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (Number(x[i]) || 0) - (Number(y[i]) || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  async function read() {
    try {
      const v = await chrome.storage.local.get(KEY);
      return (v && v[KEY]) || {};
    } catch (e) {
      return {};
    }
  }

  async function write(box) {
    try {
      await chrome.storage.local.set({ [KEY]: box });
    } catch (e) {
      /* не записалось — переживём, спросим в следующий раз */
    }
    return box;
  }

  /** Запрос с тайм-аутом и повтором с нарастающей паузой. */
  async function askGithub() {
    let last = "";
    for (let i = 0; i < TRIES; i++) {
      const stop = new AbortController();
      const t = setTimeout(() => stop.abort(), NET_MS);
      try {
        const res = await fetch(API, {
          signal: stop.signal,
          headers: { accept: "application/vnd.github+json" },
        });
        clearTimeout(t);
        if (res.ok) return await res.json();
        // 403 — упёрлись в лимит GitHub (60 запросов в час на адрес).
        last =
          res.status === 403
            ? "GitHub не отвечает (лимит запросов)"
            : "GitHub ответил " + res.status;
      } catch (e) {
        clearTimeout(t);
        last =
          String((e && e.message) || e) === "The user aborted a request."
            ? "GitHub не ответил за " + NET_MS / 1000 + " с"
            : "запрос не ушёл: " + String((e && e.message) || e);
      }
      if (i < TRIES - 1)
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(3, i)));
    }
    throw new Error(last || "не вышло спросить GitHub");
  }

  function badge(on) {
    try {
      if (!chrome.action || !chrome.action.setBadgeText) return;
      chrome.action.setBadgeText({ text: on ? "↑" : "" });
      if (chrome.action.setBadgeBackgroundColor) {
        chrome.action.setBadgeBackgroundColor({ color: "#34d399" });
      }
      if (chrome.action.setTitle) {
        chrome.action.setTitle({
          title: on
            ? "Вышла новая версия расширения — открой настройки"
            : "Настройки GMGN × Liquidity Ladder",
        });
      }
    } catch (e) {
      /* значка нет — не беда */
    }
  }

  function tell(ver, notes) {
    try {
      chrome.notifications.create("gho-upd-" + ver, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/128.png"),
        title: "Расширение: вышла версия " + ver,
        message:
          (notes ? notes.slice(0, 140) + "\n\n" : "") +
          "Открой настройки расширения — там кнопки «скачать» и «перезапустить».",
      });
    } catch (e) {
      /* уведомления выключены */
    }
  }

  /**
   * Спросить GitHub про последний релиз.
   *
   * force — человек нажал «проверить»: идём, даже если ходили недавно.
   */
  async function check(force) {
    const box = await read();
    const now = Date.now();
    if (!force && box.at && now - box.at < EVERY_MIN * 60000 * 0.9) return box;
    let rel = null;
    try {
      rel = await askGithub();
    } catch (e) {
      log().warn("не спросил про обновление", { why: String(e && e.message) });
      return write({ ...box, at: now, err: String((e && e.message) || e) });
    }
    const ver = String((rel && rel.tag_name) || "").replace(/^v/, "");
    if (!ver)
      return write({ ...box, at: now, err: "у релиза нет номера версии" });
    const zip = ((rel && rel.assets) || []).find((a) =>
      /\.zip$/i.test(String(a && a.name)),
    );
    const next = {
      at: now,
      ver,
      have: mine(),
      notes: String((rel && rel.body) || "").slice(0, 400),
      url: (zip && zip.browser_download_url) || PAGE,
      page: PAGE,
      err: "",
      told: box.told || "",
    };
    const fresh = cmpVer(ver, next.have) > 0;
    badge(fresh);
    if (fresh && box.told !== ver) {
      next.told = ver;
      tell(ver, next.notes);
      log().info("вышла новая версия", { ver, have: next.have });
    }
    return write(next);
  }

  /** Что показать человеку: своя версия, последняя и есть ли разница. */
  async function state() {
    const box = await read();
    const have = mine();
    return {
      have,
      ver: box.ver || "",
      fresh: !!(box.ver && cmpVer(box.ver, have) > 0),
      notes: box.notes || "",
      url: box.url || PAGE,
      page: PAGE,
      at: box.at || 0,
      err: box.err || "",
    };
  }

  /**
   * Перезапустить расширение: у распакованного это перечитывание папки с
   * диска, то есть и есть установка только что скачанных файлов.
   */
  function apply() {
    badge(false);
    setTimeout(() => {
      try {
        chrome.runtime.reload();
      } catch (e) {
        /* не дали — человек нажмёт ⟳ в chrome://extensions */
      }
    }, 200);
    return { ok: true };
  }

  try {
    // Первый заход — через минуту после старта воркера, а не сразу: при
    // запуске Chrome у него есть дела поважнее, да и сеть ещё не поднялась.
    chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: EVERY_MIN });
    chrome.alarms.onAlarm.addListener((a) => {
      if (a.name === ALARM) check(false).catch(() => {});
    });
  } catch (e) {
    /* нет будильников — останется проверка по кнопке */
  }
  // Значок должен говорить правду сразу после пробуждения воркера — но это
  // чтение из хранилища, без похода в сеть: сеть отложена до будильника.
  read()
    .then((box) => badge(!!(box.ver && cmpVer(box.ver, mine()) > 0)))
    .catch(() => {});

  self.GHO_UPD = { check, state, apply, cmpVer, KEY, PAGE, EVERY_MIN };
})();
