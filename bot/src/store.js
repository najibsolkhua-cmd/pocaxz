// Хранилище бота: JSON-файл. Токен привязки → чат Telegram. Резюме и вакансии сюда не попадают.
import fs from 'node:fs';
import path from 'node:path';

export function createStore(dir) {
  const file = path.join(dir, 'store.json');
  fs.mkdirSync(dir, { recursive: true });
  let data = { links: {} };
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* первый запуск */ }
  data.links ||= {};
  data.adStats ||= {}; // { 'YYYY-MM-DD': { bannerId: { view, click } } } — только общие числа
  const save = () => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  };
  return {
    link(token, chatId, name) { data.links[token] = { chatId, name: name || '', linkedAt: new Date().toISOString() }; save(); },
    get: (token) => data.links[token] || null,
    unlink(token) { const had = Boolean(data.links[token]); delete data.links[token]; save(); return had; },
    addAdEvents(events, day = new Date().toISOString().slice(0, 10)) {
      const bucket = (data.adStats[day] ||= {});
      for (const [id, row] of Object.entries(events)) {
        const cur = (bucket[id] ||= { view: 0, click: 0 });
        cur.view += row.view;
        cur.click += row.click;
      }
      save();
    },
    // Сводка за последние N дней: по баннерам и по дням.
    adReport(days = 30, today = new Date()) {
      const from = new Date(today.getTime() - (days - 1) * 86400e3).toISOString().slice(0, 10);
      const byBanner = {};
      const byDay = {};
      for (const [day, rows] of Object.entries(data.adStats)) {
        if (day < from) continue;
        for (const [id, r] of Object.entries(rows)) {
          const b = (byBanner[id] ||= { view: 0, click: 0 });
          b.view += r.view;
          b.click += r.click;
          const d = (byDay[day] ||= { view: 0, click: 0 });
          d.view += r.view;
          d.click += r.click;
        }
      }
      const ctr = (r) => (r.view ? Math.round((r.click / r.view) * 10000) / 100 : 0);
      return {
        from,
        days,
        banners: Object.entries(byBanner).map(([id, r]) => ({ id, ...r, ctr: ctr(r) })).sort((a, b) => b.view - a.view),
        daily: Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([day, r]) => ({ day, ...r, ctr: ctr(r) })),
      };
    },
    unlinkChat(chatId) {
      const tokens = Object.keys(data.links).filter((t) => data.links[t].chatId === chatId);
      tokens.forEach((t) => delete data.links[t]);
      if (tokens.length) save();
      return tokens.length;
    },
  };
}
