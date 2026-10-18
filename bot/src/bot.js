// Обработка сообщений бота: привязка уведомлений, меню, ответы на вопросы.
import { esc } from './telegram.js';

const TOKEN_RE = /^[0-9a-f]{32}$/;

export function createBot({ tg, store, answerer, config }) {
  const menu = {
    inline_keyboard: [
      [{ text: 'Установить solk / job', url: config.installUrl }],
      [{ text: 'Как начать', callback_data: 'q:Как установить и начать пользоваться?' }, { text: 'Уведомления', callback_data: 'q:Как подключить уведомления в Telegram?' }],
      [{ text: 'Написать человеку', url: config.humanSupport }],
    ],
  };
  const welcome = (name) => `Привет${name ? `, ${esc(name)}` : ''}! Я бот <b>solk / job</b> — бесплатной CRM для поиска работы.\n\n`
    + 'Задайте любой вопрос о solk / job обычными словами: как установить, добавить сайт, почему нет вакансий, что значит «Подходит мне 72%»…\n\n'
    + 'Новые подходящие вакансии могу присылать сюда: в расширении «Поиск и настройки» → «Уведомления в Telegram».';

  async function onMessage(msg) {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    const name = msg.from?.first_name || '';
    if (!text) return;

    const start = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/);
    if (start) {
      const token = start[1];
      if (token && TOKEN_RE.test(token)) {
        store.link(token, chatId, name);
        await tg.send(chatId, '✅ Уведомления подключены. Новые подходящие вакансии будут приходить сюда.\n\nОтключить: /stop или в расширении.');
        return;
      }
      await tg.send(chatId, welcome(name), { reply_markup: menu });
      return;
    }
    if (/^\/stop(@\w+)?$/.test(text)) {
      const n = store.unlinkChat(chatId);
      await tg.send(chatId, n ? 'Уведомления отключены. Подключить снова — в расширении: «Уведомления в Telegram».' : 'Уведомления и так не подключены.');
      return;
    }
    if (/^\/help(@\w+)?$/.test(text)) {
      await tg.send(chatId, welcome(name), { reply_markup: menu });
      return;
    }
    if (/^\/stats(@\w+)?$/.test(text) && config.adminChatIds?.includes(chatId)) {
      const r = store.adReport(7);
      const lines = r.banners.map((b) => `${esc(b.id)}: ${b.view} показов, ${b.click} кликов, CTR ${b.ctr}%`);
      await tg.send(chatId, `📊 Баннеры за 7 дней\n\n${lines.join('\n') || 'Пока нет показов.'}`);
      return;
    }
    if (/^\/new(@\w+)?$/.test(text)) {
      answerer.forget(chatId);
      await tg.send(chatId, 'Начнём сначала — задайте вопрос.');
      return;
    }
    await reply(chatId, text);
  }

  async function reply(chatId, question) {
    await tg.typing(chatId);
    const answer = await answerer.answer(chatId, question.slice(0, 2000));
    await tg.send(chatId, esc(answer).slice(0, 4000));
  }

  async function onCallback(cb) {
    await tg.call('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    const data = cb.data || '';
    if (data.startsWith('q:') && cb.message) await reply(cb.message.chat.id, data.slice(2));
  }

  return {
    async handle(update) {
      try {
        if (update.message) await onMessage(update.message);
        else if (update.callback_query) await onCallback(update.callback_query);
      } catch (e) {
        console.error('update', e.message);
      }
    },
  };
}

// Текст уведомления о новых вакансиях.
export function formatNotification(title, items) {
  const lines = items.slice(0, 10).map((x) => {
    const score = Number.isFinite(x.score) ? `<b>${Math.round(x.score)}%</b> ` : '';
    const company = x.company ? ` — ${esc(String(x.company).slice(0, 80))}` : '';
    return `${score}<a href="${esc(x.url)}">${esc(String(x.title).slice(0, 150))}</a>${company}`;
  });
  return `🔔 ${esc(String(title).slice(0, 120))}\n\n${lines.join('\n')}`;
}
