import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreVacancy } from '../../extension/lib/match.js';
import { normalizeItem } from '../../extension/lib/parse.js';

const now = new Date('2026-10-13T12:00:00');
const profile = {
  titleKeywords: ['python', 'backend'],
  grade: 'middle',
  skills: ['*Python', 'Django', 'PostgreSQL', 'Docker', 'Redis'],
  minSalary: 250000,
  formats: ['remote', 'hybrid'],
  cities: ['Москва'],
  stopWords: ['1С'],
  maxAgeDays: 30,
};
const vac = (over) => ({
  ...normalizeItem({ externalId: Math.random(), url: 'https://hh.ru/vacancy/1', company: 'X', ...over }, 'hh', now),
  firstSeenAt: now.toISOString(),
});

test('подходящая вакансия выше неподходящей', () => {
  const good = scoreVacancy(vac({ title: 'Middle Python Backend', salaryText: 'до 320 000 ₽', snippet: 'Django, PostgreSQL, Docker. Удалённо' }), profile, now.getTime());
  const bad = scoreVacancy(vac({ title: 'Senior Java Developer', salaryText: 'от 150 000 ₽', snippet: 'Spring, Kafka, Oracle. Офис' }), profile, now.getTime());
  assert.ok(good.score > 0.75, `good=${good.score}`);
  assert.ok(bad.score < 0.35, `bad=${bad.score}`);
  assert.deepEqual(good.missing, []);
  assert.ok(good.matched.includes('django'));
});

test('стоп-слово обнуляет оценку', () => {
  const s = scoreVacancy(vac({ title: 'Программист 1С', snippet: 'Python будет плюсом' }), profile, now.getTime());
  assert.equal(s.score, 0);
  assert.equal(s.stopped, '1с');
});

test('старые вакансии отсекаются', () => {
  const v = { ...vac({ title: 'Python Backend' }), firstSeenAt: '2026-08-01T00:00:00Z', publishedAt: null };
  assert.equal(scoreVacancy(v, profile, now.getTime()).tooOld, true);
});

test('без основного стека оценка ниже', () => {
  const withPy = scoreVacancy(vac({ title: 'Backend', snippet: 'Python, Docker, Redis' }), profile, now.getTime());
  const noPy = scoreVacancy(vac({ title: 'Backend', snippet: 'Go, Docker, Redis' }), profile, now.getTime());
  assert.ok(withPy.score > noPy.score);
});

import { scoreAll } from '../../extension/lib/match.js';

test('профессия вне IT: подбор по должности и тексту', () => {
  const sales = {
    position: 'Менеджер по продажам', about: 'B2B продажи, холодные звонки, ведение клиентов в CRM, переговоры',
    grade: '', skills: [], minSalary: 0, formats: [], cities: [], stopWords: [], maxAgeDays: 30,
  };
  const mk = (title, snippet) => vac({ title, snippet });
  const rows = scoreAll([
    mk('Менеджер по продажам B2B', 'Поиск клиентов, холодные звонки, переговоры, CRM, план продаж'),
    mk('Менеджер по работе с клиентами', 'Ведение клиентской базы, переговоры, CRM'),
    mk('Python-разработчик', 'Django, PostgreSQL, Docker'),
    mk('Водитель-экспедитор', 'Доставка грузов по городу, категория C'),
  ], sales, '', now.getTime());
  const by = Object.fromEntries(rows.map(({ v, s }) => [v.title, s.score]));
  assert.ok(by['Менеджер по продажам B2B'] > 0.6, JSON.stringify(by));
  assert.ok(by['Менеджер по продажам B2B'] > by['Менеджер по работе с клиентами']);
  assert.ok(by['Менеджер по работе с клиентами'] > by['Python-разработчик']);
  assert.ok(by['Python-разработчик'] < 0.35 && by['Водитель-экспедитор'] < 0.35, JSON.stringify(by));
});

test('должность в названии: «developer» = «разработчик»', () => {
  const p = { ...profile, titleKeywords: [], position: 'Python разработчик' };
  const a = scoreVacancy(vac({ title: 'Python Developer', snippet: 'Django' }), p, now.getTime());
  assert.equal(a.parts.title, 1);
});
