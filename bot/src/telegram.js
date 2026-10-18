// Минимальный клиент Telegram Bot API (без сторонних библиотек).
export function createTelegram(token, fetchImpl = fetch) {
  const call = async (method, params = {}) => {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) {
      const err = new Error(`telegram ${method}: ${j.description || r.status}`);
      err.code = j.error_code || r.status;
      throw err;
    }
    return j.result;
  };
  return {
    call,
    send: (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
    typing: (chatId) => call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}),
    // Длинный опрос: бот работает без домена и HTTPS-вебхука.
    async *updates() {
      let offset = 0;
      for (;;) {
        try {
          const list = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
          for (const u of list) { offset = u.update_id + 1; yield u; }
        } catch (e) {
          console.error(e.message);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    },
  };
}

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
