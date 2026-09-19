/*
 * Перехват данных Liquidity Ladder (MAIN world).
 *
 * Сайт при загрузке дашборда просит /api/v1/pnl/dashboard-stats, и в ответе
 * лежит массив open_pairs — по элементу на леддер, с token_ids, границами
 * диапазона, комиссиями и PnL. Это и есть список всех пулов пользователя.
 *
 * Читать его из ISOLATED world нельзя: там свой fetch, и запросы страницы
 * через него не проходят. Поэтому оборачиваем fetch и XHR прямо на странице
 * и передаём разобранный результат наверх постом сообщения — тем же приёмом,
 * что и bridge.js на gmgn.ai. Ни заголовков, ни токенов авторизации мы не
 * трогаем: берём только тело уже случившегося ответа.
 */
(() => {
  'use strict';

  if (window.__LLC_TAP__) return;
  window.__LLC_TAP__ = true;

  const WANTED = /\/api\/v1\/pnl\/dashboard-stats/;
  // Сбор комиссий на встроенном кошельке подписывает их сервер, а не кошелёк
  // в браузере. Значит, этот запрос можно однажды запомнить и потом повторять
  // без открытой вкладки. Тело запоминаем как есть — оно уходит на тот же
  // сайт, откуда и пришло, и дальше браузера не выходит.
  const COLLECT = /\/execute\/v\d\/(batch-)?(collect-fees|close|remove|decrease)/;
  // Что именно это было: сбор фисов или выход из позиции. Раньше здесь
  // стояла ссылка на несуществующий CLOSE — лог молча падал.
  const kindOf = (url) => (/collect-fees/.test(String(url)) ? 'fees' : 'close');

  /** Заголовки запроса в простой вид: у fetch их три разных обличья. */
  function headersOf(init) {
    const out = {};
    const h = init && init.headers;
    if (!h) return out;
    try {
      if (typeof h.forEach === 'function') h.forEach((v, k) => { out[k] = v; });
      else if (Array.isArray(h)) for (const [k, v] of h) out[k] = v;
      else for (const [k, v] of Object.entries(h)) out[k] = String(v);
    } catch (e) { /* заголовки бывают экзотические — тогда просто без них */ }
    return out;
  }

  function remember(url, init, input) {
    try {
      const method = (init && init.method) || (input && input.method) || 'POST';
      const body = init && typeof init.body === 'string' ? init.body : null;
      if (!body) return;
      // Заголовки бывают и на самом объекте Request — тогда в init их нет
      // вовсе, и запомненный запрос уходил бы без авторизации.
      const headers = { ...headersOf(input && input.headers ? input : null),
                        ...headersOf(init) };
      window.postMessage({ __llTap: true, type: 'collect-shape',
                           url: String(url), method, body, headers, at: Date.now() },
                         location.origin);
      // В консоль кладём только устройство запроса — имена полей и их типы,
      // без самих значений: там адрес кошелька, и светить его незачем.
      let shape = null;
      try {
        const j = JSON.parse(body);
        shape = {};
        for (const [k, v] of Object.entries(j)) {
          shape[k] = Array.isArray(v)
            ? 'массив из ' + v.length + ' × ' + (typeof v[0])
            : typeof v;
        }
      } catch (e) { shape = 'не JSON, длина ' + body.length; }
      // Главное в этом логе — поймали мы заголовок авторизации или нет: без
      // него фоновый сбор через их API работать не будет.
      const auth = Object.keys(headers).some((k) => /^authorization$/i.test(k));
      console.log('[LLC] ' + (kindOf(url) === 'close' ? 'закрытие' : 'сбор фисов')
                  + (auth ? ' (авторизация есть)' : ' (АВТОРИЗАЦИИ НЕТ)') + ':',
                  String(url).replace(/^https?:\/\/[^/]+/, ''),
                  method, JSON.stringify(shape));
    } catch (e) { /* перехват не должен ломать сам сбор */ }
  }

  function publish(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { return; }
    if (!data || !Array.isArray(data.open_pairs)) return;

    const pairs = data.open_pairs.map((p) => ({
      token0: String(p.token0 || '').toLowerCase(),
      token1: String(p.token1 || '').toLowerCase(),
      symbols: [p.token0_symbol, p.token1_symbol].filter(Boolean).join('/'),
      chainId: p.chain_id,
      ids: Array.isArray(p.token_ids) ? p.token_ids.map(String) : [],
      positions: p.n_positions,
      lo: p.price_lower,
      hi: p.price_upper,
      current: p.current_price,
      unclaimed: p.unclaimed_fees_usd,
      claimed: typeof p.claimed_fees_usd === 'number' ? p.claimed_fees_usd : null,
      pnl: p.unrealized_pnl_usd,
      apr: p.daily_apr,
      group: p.ladder_group_id,
    })).filter((p) => p.ids.length);

    if (!pairs.length) return;
    window.postMessage({ __llTap: true, type: 'pairs', pairs }, location.origin);
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const out = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (COLLECT.test(url)) {
        remember(url, init, input);
        // Чем кончилось — нужно, чтобы поставить точку сбора на графике
        // только по прошедшему, а не по каждому нажатию.
        out.then((res) => {
          window.postMessage({ __llTap: true, type: 'collect-done', kind: kindOf(url),
                               ok: !!(res && res.ok), at: Date.now() }, location.origin);
        }).catch(() => {});
      }
      if (WANTED.test(url)) {
        // Запрос дашборда запоминаем целиком: в нём и заголовок авторизации,
        // и адрес кошелька в параметрах. Без кошелька сайт список не отдаёт,
        // а взять его больше неоткуда — значит, повторять надо ровно этот.
        try {
          const headers = { ...headersOf(input && input.headers ? input : null),
                            ...headersOf(init) };
          if (Object.keys(headers).some((k) => /^authorization$/i.test(k))) {
            window.postMessage({ __llTap: true, type: 'stats-shape',
                                 url: String(url), headers, at: Date.now() },
                               location.origin);
          }
        } catch (e) { /* перехват не должен ломать запрос сайта */ }
        out.then((res) => res.clone().text().then(publish).catch(() => {})).catch(() => {});
      }
    } catch (e) { /* перехват никогда не должен ломать запрос сайта */ }
    return out;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (WANTED.test(String(url))) {
        this.addEventListener('load', () => {
          try { publish(this.responseText); } catch (e) { /* см. выше */ }
        });
      }
    } catch (e) { /* см. выше */ }
    return origOpen.apply(this, arguments);
  };
})();
