// Скрытый документ расширения: скачивает страницу запросом и разбирает её тем же
// экстрактором, что и во вкладке. Нужен для сайтов, куда браузер не пускает расширения
// во вкладке (например, сайты банков в защищённом режиме Яндекс Браузера).

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg?.target !== 'offscreen') return false;
  (async () => {
    try {
      const r = await fetch(msg.url, { credentials: 'include' });
      if (msg.type === 'detail' && (r.status === 404 || r.status === 410)) return send({ archived: true });
      if (!r.ok) return send({ fail: `HTTP ${r.status}` });
      const html = await r.text();
      const url = r.url || msg.url;
      send(msg.type === 'detail' ? globalThis.__jobRadar.detailHtml(html, url) : globalThis.__jobRadar.parseHtml(html, url, msg.cfg || {}));
    } catch (e) {
      send({ fail: String(e?.message || e) });
    }
  })();
  return true;
});
