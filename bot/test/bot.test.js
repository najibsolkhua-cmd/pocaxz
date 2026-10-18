import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { loadKnowledge, sections, search } from '../src/kb.js';
import { createAnswerer } from '../src/answer.js';
import { createStore } from '../src/store.js';
import { createBot, formatNotification } from '../src/bot.js';
import { createApi } from '../src/http.js';

const config = loadConfig({});
const knowledge = loadKnowledge(config);
const TOKEN = 'a'.repeat(32);

function fakeTg() {
  const sent = [];
  return { sent, send: async (chatId, text, extra) => { sent.push({ chatId, text, extra }); }, typing: async () => {}, call: async () => true };
}

test('база знаний: находит нужный раздел по вопросу', () => {
  const secs = sections(knowledge);
  assert.ok(secs.length > 15);
  assert.equal(search(secs, 'как подключить уведомления в телеграм')[0].title, 'Уведомления');
  assert.equal(search(secs, 'ошибка на tbank cannot access contents')[0].title, 'Ошибки и проблемы');
  assert.match(search(secs, 'как удалить источник')[0].title, /Источники/);
  assert.equal(search(secs, 'и а').length, 0);
});

test('без ключа Claude бот отвечает разделами базы знаний', async () => {
  const a = createAnswerer({ knowledge, anthropicKey: '', model: config.model, humanSupport: 'https://t.me/x' });
  assert.equal(a.mode, 'kb');
  assert.match(await a.answer(1, 'Почему не читается резюме?'), /PDF/);
  assert.match(await a.answer(1, 'погода в Москве завтра'), /поддержку: https:\/\/t\.me\/x/);
});

test('с Claude: база знаний кешируется, отказ модели обрабатывается', async () => {
  const calls = [];
  let reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Нажмите «Разрешить доступ».' }] };
  const client = { beta: { messages: { create: async (p) => { calls.push(p); return reply; } } } };
  const a = createAnswerer({ knowledge, anthropicKey: '', model: 'claude-opus-5-5', humanSupport: 'https://t.me/x', client });
  assert.equal(a.mode, 'claude');
  assert.equal(await a.answer(7, 'Нет доступа к сайту'), 'Нажмите «Разрешить доступ».');
  const p = calls[0];
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.fallbacks, 'default');
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.deepEqual(p.system.at(-1).cache_control, { type: 'ephemeral' });
  assert.ok(p.system.at(-1).text.includes('Защищённом режиме'));
  // Уточняющий вопрос идёт с историей диалога.
  await a.answer(7, 'А где эта кнопка?');
  assert.deepEqual(calls[1].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  reply = { stop_reason: 'refusal', content: [] };
  assert.match(await a.answer(8, 'что-то'), /поддержку/);
});

test('/start с токеном из расширения привязывает чат, /stop — отвязывает', async () => {
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-')));
  const tg = fakeTg();
  const bot = createBot({ tg, store, answerer: { answer: async () => 'ответ', forget() {} }, config });
  await bot.handle({ message: { chat: { id: 42 }, from: { first_name: 'Иван' }, text: `/start ${TOKEN}` } });
  assert.deepEqual({ chatId: store.get(TOKEN).chatId, name: store.get(TOKEN).name }, { chatId: 42, name: 'Иван' });
  assert.match(tg.sent[0].text, /Уведомления подключены/);
  await bot.handle({ message: { chat: { id: 42 }, text: '/start' } });
  assert.ok(tg.sent[1].extra.reply_markup.inline_keyboard.length >= 2, 'меню');
  await bot.handle({ message: { chat: { id: 42 }, text: 'Как добавить сайт <компании>?' } });
  assert.equal(tg.sent[2].text, 'ответ');
  await bot.handle({ message: { chat: { id: 42 }, text: '/stop' } });
  assert.equal(store.get(TOKEN), null);
});

test('API для расширения: статус привязки, уведомления, лимит', async () => {
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-')));
  const tg = fakeTg();
  const server = createApi({ store, tg, notifyPerHour: 2 }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await (await fetch(`${base}/api/link-status?token=${TOKEN}`)).json(), { linked: false, name: '' });
    assert.equal((await fetch(`${base}/api/link-status?token=bad`)).status, 400);
    const items = [{ title: 'Маркетолог <B2B>', company: 'Ромашка', score: 91, url: 'https://hh.ru/vacancy/1' }];
    assert.equal((await post('/api/notify', { token: TOKEN, title: 'Новых: 1', items })).status, 404, 'не привязан');
    store.link(TOKEN, 5, 'Иван');
    assert.deepEqual(await (await fetch(`${base}/api/link-status?token=${TOKEN}`)).json(), { linked: true, name: 'Иван' });
    assert.equal((await post('/api/notify', { token: TOKEN, title: 'Новых: 1', items })).status, 200);
    assert.equal(tg.sent[0].chatId, 5);
    assert.match(tg.sent[0].text, /<b>91%<\/b> <a href="https:\/\/hh\.ru\/vacancy\/1">Маркетолог &lt;B2B&gt;<\/a> — Ромашка/);
    assert.equal((await post('/api/notify', { token: TOKEN, items: [{ title: 'x', url: 'javascript:alert(1)' }] })).status, 400, 'только http(s)-ссылки');
    assert.equal((await post('/api/notify', { token: TOKEN, items })).status, 200);
    assert.equal((await post('/api/notify', { token: TOKEN, items })).status, 429, 'не больше 2 в час');
    assert.equal((await post('/api/unlink', { token: TOKEN })).status, 200);
    assert.equal(store.get(TOKEN), null);
  } finally {
    server.close();
  }
});

test('текст уведомления экранирует HTML и ограничен 10 вакансиями', () => {
  const items = Array.from({ length: 15 }, (_, i) => ({ title: `V${i}`, url: `https://x.ru/${i}`, score: 80 }));
  const t = formatNotification('Новых: 15', items);
  assert.equal((t.match(/<a /g) || []).length, 10);
  assert.ok(t.startsWith('🔔 Новых: 15'));
});
