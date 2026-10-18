// Уведомления в Telegram через бота solk / job (папка bot/ в репозитории).
// Привязка без паролей: расширение придумывает случайный токен и открывает
// t.me/<бот>?start=<токен>; бот запоминает, какому чату принадлежит токен.
// Сам токен бота в расширении не хранится — сообщения отправляет сервер бота.

import { CONFIG } from '../config.js';

const local = chrome.storage.local;
const api = (path) => `${CONFIG.telegram.botApi.replace(/\/+$/, '')}${path}`;

export const tgEnabled = () => Boolean(CONFIG.telegram.botApi && CONFIG.telegram.botUsername);
export const getLink = async () => (await local.get('tgLink')).tgLink || null;

export async function startLink() {
  const token = crypto.randomUUID().replace(/-/g, '');
  await local.set({ tgLink: { token, linked: false, startedAt: new Date().toISOString() } });
  return `https://t.me/${CONFIG.telegram.botUsername}?start=${token}`;
}

export async function checkLink() {
  const link = await getLink();
  if (!link?.token || !tgEnabled()) return link;
  const r = await fetch(api(`/api/link-status?token=${encodeURIComponent(link.token)}`));
  if (!r.ok) throw new Error(`бот ответил ${r.status}`);
  const s = await r.json();
  const next = { ...link, linked: Boolean(s.linked), name: s.name || link.name || '' };
  await local.set({ tgLink: next });
  return next;
}

export async function unlink() {
  const link = await getLink();
  if (link?.token && tgEnabled()) {
    await fetch(api('/api/unlink'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: link.token }) }).catch(() => {});
  }
  await local.remove('tgLink');
}

// items: [{ title, company, score, url }]
export async function sendToTelegram(title, items) {
  const link = await getLink();
  if (!link?.linked || !tgEnabled()) return false;
  const r = await fetch(api('/api/notify'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: link.token, title, items: items.slice(0, 10) }),
  });
  if (r.status === 404) await local.set({ tgLink: { ...link, linked: false } }); // чат отвязали в боте
  return r.ok;
}
