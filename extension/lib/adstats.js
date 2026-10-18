// Счётчики показов и кликов партнёрских баннеров — только общие числа по каждому баннеру,
// без идентификаторов пользователя, профиля и истории. Копятся в браузере и раз в 15 минут
// (клик — сразу) уходят на сервер бота: POST /api/ad-events { events: { id: { view, click } } }.

import { CONFIG } from '../config.js';

const local = { get: (k) => chrome.storage.local.get(k), set: (o) => chrome.storage.local.set(o) };
const ID_RE = /^[\w-]{1,64}$/;
const endpoint = () => (CONFIG.telegram?.botApi ? `${CONFIG.telegram.botApi.replace(/\/+$/, '')}/api/ad-events` : '');

export async function countAd(id, type) {
  if (!ID_RE.test(id || '') || !['view', 'click'].includes(type)) return;
  const { adStats } = await local.get('adStats');
  const st = adStats || { pending: {}, lastSentAt: null };
  const row = st.pending[id] || { view: 0, click: 0 };
  row[type]++;
  st.pending[id] = row;
  await local.set({ adStats: st });
}

export async function flushAdStats({ force = false, fetchImpl = fetch } = {}) {
  const url = endpoint();
  if (!url) return false;
  const { adStats } = await local.get('adStats');
  if (!adStats || !Object.keys(adStats.pending || {}).length) return false;
  if (!force && adStats.lastSentAt && Date.now() - Date.parse(adStats.lastSentAt) < 15 * 60e3) return false;
  const sending = adStats.pending;
  const r = await fetchImpl(url, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: sending }) }).catch(() => null);
  if (!r?.ok) return false;
  // Пока шёл запрос, могли добавиться новые показы — вычитаем только отправленное.
  const { adStats: now } = await local.get('adStats');
  const left = {};
  for (const [id, row] of Object.entries(now?.pending || {})) {
    const s = sending[id] || { view: 0, click: 0 };
    const rest = { view: row.view - s.view, click: row.click - s.click };
    if (rest.view > 0 || rest.click > 0) left[id] = { view: Math.max(0, rest.view), click: Math.max(0, rest.click) };
  }
  await local.set({ adStats: { pending: left, lastSentAt: new Date().toISOString() } });
  return true;
}
