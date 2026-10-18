// HTTP API для расширения: проверка привязки, уведомления, отвязка.
import http from 'node:http';
import { formatNotification } from './bot.js';

const TOKEN_RE = /^[0-9a-f]{32}$/;

export function createApi({ store, tg, notifyPerHour = 30 }) {
  const sent = new Map(); // token → отметки времени отправок за час

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
