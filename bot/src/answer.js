// Ответы на вопросы о solk / job.
//   С ключом ANTHROPIC_API_KEY — Claude отвечает по базе знаний (база кешируется: prompt caching).
//   Без ключа — бот показывает самые подходящие разделы базы знаний.
import { sections, search } from './kb.js';

const SYSTEM = `Ты — бот поддержки solk / job: бесплатной CRM для поиска работы в виде расширения браузера.
Отвечай по-русски, коротко и по шагам, как живой специалист поддержки. Опирайся только на базу знаний ниже.
Если ответа в базе нет или вопрос не про solk / job — честно скажи, что не знаешь, и предложи написать человеку в поддержку.
Не выдумывай кнопки, настройки и функции, которых нет в базе. Форматирование: простой текст, списки с «1.» или «•», без Markdown-заголовков и без **.`;

export function createAnswerer({ knowledge, anthropicKey, model, humanSupport, client = null }) {
  const secs = sections(knowledge);
  const history = new Map(); // chatId → последние реплики (для уточняющих вопросов)

  const fromKb = (question) => {
    const found = search(secs, question);
    if (!found.length) return `Не нашёл ответа в справке. Напишите человеку в поддержку: ${humanSupport}`;
    return found.map((s) => `${s.title}\n${s.body.replace(/\*\*/g, '')}`).join('\n\n').slice(0, 3500);
  };

  let sdk = client;
  const getClient = async () => {
    if (sdk) return sdk;
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    sdk = new Anthropic({ apiKey: anthropicKey });
    return sdk;
  };

  return {
    mode: anthropicKey || client ? 'claude' : 'kb',
    async answer(chatId, question) {
      if (!anthropicKey && !client) return fromKb(question);
      const past = history.get(chatId) || [];
      const messages = [...past, { role: 'user', content: question }];
      try {
        const c = await getClient();
        const res = await c.beta.messages.create({
          model,
          max_tokens: 4000,
          // Чат поддержки: короткие ответы, низкое усилие.
          output_config: { effort: 'low' },
          // Если модель откажется отвечать, сервер сам повторит запрос на запасной модели.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: [
            { type: 'text', text: SYSTEM },
            // База знаний неизменна — кешируем её, чтобы каждый вопрос стоил дёшево.
            { type: 'text', text: `<knowledge_base>\n${knowledge}\n</knowledge_base>`, cache_control: { type: 'ephemeral' } },
          ],
          messages,
        });
        if (res.stop_reason === 'refusal') return `Не могу ответить на этот вопрос. Напишите в поддержку: ${humanSupport}`;
        const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (!text) return fromKb(question);
        history.set(chatId, [...messages, { role: 'assistant', content: text }].slice(-8));
        return text;
      } catch (e) {
        console.error('claude', e?.status || '', e?.message || e);
        return fromKb(question);
      }
    },
    forget(chatId) { history.delete(chatId); },
  };
}
