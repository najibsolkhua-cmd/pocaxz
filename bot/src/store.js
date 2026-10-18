// Хранилище бота: JSON-файл. Токен привязки → чат Telegram. Резюме и вакансии сюда не попадают.
import fs from 'node:fs';
import path from 'node:path';

export function createStore(dir) {
  const file = path.join(dir, 'store.json');
  fs.mkdirSync(dir, { recursive: true });
  let data = { links: {} };
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* первый запуск */ }
  data.links ||= {};
  const save = () => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  };
  return {
    link(token, chatId, name) { data.links[token] = { chatId, name: name || '', linkedAt: new Date().toISOString() }; save(); },
    get: (token) => data.links[token] || null,
    unlink(token) { const had = Boolean(data.links[token]); delete data.links[token]; save(); return had; },
    unlinkChat(chatId) {
      const tokens = Object.keys(data.links).filter((t) => data.links[t].chatId === chatId);
      tokens.forEach((t) => delete data.links[t]);
      if (tokens.length) save();
      return tokens.length;
    },
  };
}
