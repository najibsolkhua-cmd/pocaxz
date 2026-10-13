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
