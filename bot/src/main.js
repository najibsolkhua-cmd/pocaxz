// Запуск: TELEGRAM_BOT_TOKEN=... [ANTHROPIC_API_KEY=...] npm start
import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { loadKnowledge } from './kb.js';
import { createAnswerer } from './answer.js';
import { createTelegram } from './telegram.js';
import { createBot } from './bot.js';
import { createApi } from './http.js';

const config = loadConfig();
if (!config.telegramToken) {
  console.error('Нужен TELEGRAM_BOT_TOKEN (получите у @BotFather). См. bot/README.md.');
  process.exit(1);
}
const store = createStore(config.dataDir);
const tg = createTelegram(config.telegramToken);
const answerer = createAnswerer({ ...config, knowledge: loadKnowledge(config) });
const bot = createBot({ tg, store, answerer, config });

createApi({ store, tg, notifyPerHour: config.notifyPerHour, statsKey: config.statsKey }).listen(config.port, () => {
  console.log(`API: http://0.0.0.0:${config.port} · ответы: ${answerer.mode === 'claude' ? `Claude (${config.model})` : 'база знаний без ИИ'}`);
});

for await (const update of tg.updates()) bot.handle(update);
