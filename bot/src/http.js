// HTTP API для расширения: проверка привязки, уведомления, отвязка.
import http from 'node:http';
import { formatNotification } from './bot.js';

const TOKEN_RE = /^[0-9a-f]{32}$/;

const BANNER_RE = /^[\w-]{1,64}$/;

export function statsHtml(report) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const row = (cells) => `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`;
  const sum = report.banners.reduce((a, b) => ({ view: a.view + b.view, click: a.click + b.click }), { view: 0, click: 0 });
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Баннеры solk / job</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:24px;color:#17181b}table{border-collapse:collapse;margin:12px 0 28px}td,th{padding:6px 14px;border-bottom:1px solid #e6e7ea;text-align:right}td:first-child,th:first-child{text-align:left}h1{font-size:24px}</style>
<h1>Партнёрские баннеры: ${report.days} дн. (с ${esc(report.from)})</h1>
<p>Всего: показов ${sum.view}, кликов ${sum.click}, CTR ${sum.view ? Math.round((sum.click / sum.view) * 10000) / 100 : 0}%. Считаются только общие числа — без данных пользователей.</p>
<table><tr><th>Баннер</th><th>Показы</th><th>Клики</th><th>CTR, %</th></tr>${report.banners.map((b) => row([b.id, b.view, b.click, b.ctr])).join('')}</table>
<table><tr><th>День</th><th>Показы</th><th>Клики</th><th>CTR, %</th></tr>${report.daily.map((d) => row([d.day, d.view, d.click, d.ctr])).join('')}</table>`;
}

export function createApi({ store, tg, notifyPerHour = 30, statsKey = '' }) {
  const sent = new Map(); // token → отметки времени отправок за час
  const adHits = new Map(); // ip → отметки времени (защита от накрутки счётчиков)

  const json = (res, code, obj) => {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 64e3) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return json(res, 204, {});
    try {
      if (url.pathname === '/health') return json(res, 200, { ok: true });

      // Счётчики баннеров: только общие числа, никаких идентификаторов.
      if (url.pathname === '/api/ad-events' && req.method === 'POST') {
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const now = Date.now();
        const recent = (adHits.get(ip) || []).filter((t) => now - t < 3600e3);
        if (recent.length >= 60) return json(res, 429, { error: 'too many requests' });
        adHits.set(ip, [...recent, now]);
        const { events } = await readBody(req);
        const clean = {};
        for (const [id, r] of Object.entries(events && typeof events === 'object' ? events : {}).slice(0, 50)) {
          const view = Math.min(5000, Math.max(0, Math.floor(Number(r?.view) || 0)));
          const click = Math.min(500, Math.max(0, Math.floor(Number(r?.click) || 0)));
          if (BANNER_RE.test(id) && (view || click)) clean[id] = { view, click };
        }
        if (!Object.keys(clean).length) return json(res, 400, { error: 'no events' });
        store.addAdEvents(clean);
        return json(res, 200, { ok: true });
      }

      if ((url.pathname === '/api/ad-stats' || url.pathname === '/stats') && req.method === 'GET') {
        if (!statsKey || url.searchParams.get('key') !== statsKey) return json(res, 403, { error: 'forbidden' });
        const report = store.adReport(Math.min(365, Number(url.searchParams.get('days')) || 30));
        if (url.pathname === '/api/ad-stats') return json(res, 200, report);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(statsHtml(report));
      }

      if (url.pathname === '/api/link-status' && req.method === 'GET') {
        const token = url.searchParams.get('token') || '';
        if (!TOKEN_RE.test(token)) return json(res, 400, { error: 'bad token' });
        const link = store.get(token);
        return json(res, 200, { linked: Boolean(link), name: link?.name || '' });
      }

      if (url.pathname === '/api/unlink' && req.method === 'POST') {
        const { token } = await readBody(req);
        if (!TOKEN_RE.test(token || '')) return json(res, 400, { error: 'bad token' });
        return json(res, 200, { ok: true, unlinked: store.unlink(token) });
      }

      if (url.pathname === '/api/notify' && req.method === 'POST') {
        const { token, title, items } = await readBody(req);
        if (!TOKEN_RE.test(token || '')) return json(res, 400, { error: 'bad token' });
        const link = store.get(token);
        if (!link) return json(res, 404, { error: 'not linked' });
        const list = (Array.isArray(items) ? items : []).filter((x) => x && x.title && /^https?:\/\//i.test(x.url || ''));
        if (!list.length) return json(res, 400, { error: 'no items' });
        const now = Date.now();
        const recent = (sent.get(token) || []).filter((t) => now - t < 3600e3);
        if (recent.length >= notifyPerHour) return json(res, 429, { error: 'too many notifications' });
        sent.set(token, [...recent, now]);
        try {
          await tg.send(link.chatId, formatNotification(title || 'Новые вакансии', list));
        } catch (e) {
          // Пользователь заблокировал бота — привязка больше не нужна.
          if (e.code === 403) { store.unlink(token); return json(res, 404, { error: 'not linked' }); }
          throw e;
        }
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 400, { error: String(e.message || e) });
    }
  });
}
