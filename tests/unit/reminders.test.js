import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remindersFor, dueReminders, pruneSent } from '../../extension/lib/reminders.js';

const now = Date.parse('2026-10-20T10:00:00');
const ago = (days) => new Date(now - days * 86400e3).toISOString();
const base = { key: 'v:hh:1', title: 'Маркетолог', company: 'Ромашка', url: 'https://hh.ru/vacancy/1' };

test('нет ответа 7 и 14 дней', () => {
  assert.deepEqual(remindersFor({ ...base, status: 'applied', statusChangedAt: ago(3) }, now), []);
  assert.equal(remindersFor({ ...base, status: 'responded', statusChangedAt: ago(7) }, now)[0].text, '7 дней без ответа — напишите рекрутеру');
  assert.equal(remindersFor({ ...base, status: 'applied', statusChangedAt: ago(15) }, now)[0].kind, 'wait14');
  assert.deepEqual(remindersFor({ ...base, status: 'viewed', statusChangedAt: ago(30) }, now), []);
});

test('интервью: накануне, за 3 часа, после', () => {
  const iv = (at) => remindersFor({ ...base, status: 'interview', statusChangedAt: ago(2), interviewAt: at }, now);
  assert.equal(iv('2026-10-21T09:00:00')[0].text, 'Интервью завтра в 09:00 — подготовьтесь');
  assert.equal(iv('2026-10-20T18:30:00')[0].text, 'Интервью сегодня в 18:30 — подготовьтесь');
  assert.equal(iv('2026-10-20T12:00:00')[0].text, 'Интервью через 2 ч (в 12:00) — подготовьтесь');
  assert.equal(iv('2026-10-19T15:00:00')[0].kind, 'ivafter');
  assert.deepEqual(iv('2026-10-25T10:00:00'), [], 'до интервью далеко');
});

test('оффер ждёт ответа; уже отправленные не повторяются; старые отметки чистятся', () => {
  const v = { ...base, status: 'offer', statusChangedAt: ago(3) };
  const [r] = dueReminders([v], { now });
  assert.equal(r.kind, 'offer2');
  assert.deepEqual(dueReminders([v], { now, sent: { [r.id]: ago(0) } }), []);
  assert.deepEqual(Object.keys(pruneSent({ a: ago(1), b: ago(90) }, now)), ['a']);
  // Новая смена статуса — новое напоминание (другой id).
  assert.notEqual(remindersFor({ ...v, statusChangedAt: ago(4) }, now)[0].id, r.id);
});
