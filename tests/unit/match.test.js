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
  const by = Object.fromEntries(rows.map(({ v, s }) => [v.title, s]));
  assert.ok(by['Менеджер по продажам B2B'].score > 0.6, JSON.stringify(by));
  // Строго по должности: без «продаж» в названии/описании вакансия не проходит.
  for (const t of ['Менеджер по работе с клиентами', 'Python-разработчик', 'Водитель-экспедитор']) {
    assert.equal(by[t].score, 0, t);
    assert.equal(by[t].excluded, 'другая должность', t);
  }
});

test('должность в названии: «developer» = «разработчик»', () => {
  const p = { ...profile, titleKeywords: [], position: 'Python разработчик' };
  const a = scoreVacancy(vac({ title: 'Python Developer', snippet: 'Django' }), p, now.getTime());
  assert.equal(a.parts.title, 1);
});

test('маркетолог: чужие должности отсеиваются, свои проходят', () => {
  const p = { position: 'Маркетолог', titleKeywords: ['Специалист по маркетингу', 'Marketing manager'], skills: ['SMM'], formats: [], cities: [], stopWords: [], maxAgeDays: 30 };
  const rows = scoreAll([
    vac({ title: 'Главный специалист отдела безопасности', snippet: 'Безопасность, Excel' }),
    vac({ title: 'Delivery Manager', snippet: 'Agile, Jira' }),
    vac({ title: 'B2B-менеджер по продажам', snippet: 'Продажи рекламы' }),
    vac({ title: 'Менеджер маркетплейсов', snippet: 'Ozon, Wildberries' }),
    vac({ title: 'Head of Marketing', snippet: 'SMM, бренд' }),
    vac({ title: 'Digital-маркетолог', snippet: 'SMM, директ' }),
    vac({ title: 'Специалист отдела рекламы', snippet: 'Ищем маркетолога в команду рекламы. Маркетинговые исследования, SMM.' }),
  ], p, '', now.getTime());
  const ok = rows.filter(({ s }) => !s.excluded).map(({ v }) => v.title);
  assert.deepEqual(ok, ['Head of Marketing', 'Digital-маркетолог', 'Специалист отдела рекламы']);
  const d = rows.find(({ v }) => v.title === 'Специалист отдела рекламы').s;
  assert.equal(d.where, 'description');
  assert.ok(rows.find(({ v }) => v.title === 'Digital-маркетолог').s.score > d.score, 'должность в названии важнее');
});

test('«искать только в названии» отсекает упоминания в описании', () => {
  const p = { position: 'Маркетолог', matchIn: { title: true, company: false, description: false }, formats: [], cities: [], stopWords: [], maxAgeDays: 30 };
  const s = scoreVacancy(vac({ title: 'Специалист отдела рекламы', snippet: 'Ищем маркетолога в команду.' }), p, now.getTime());
  assert.equal(s.excluded, 'другая должность');
});

test('город: только из профиля, другой — лишь при удалёнке и с пометкой', () => {
  const p = { position: 'Маркетолог', cities: ['спб'], formats: ['remote', 'hybrid', 'office'], stopWords: [], maxAgeDays: 30 };
  const msk = scoreVacancy(vac({ title: 'Маркетолог', location: 'Москва', snippet: 'Офис' }), p, now.getTime());
  assert.equal(msk.excluded, 'другой город');
  const minsk = scoreVacancy(vac({ title: 'Digital-маркетолог в ЮниКредит. Минск.', snippet: 'Офис' }), p, now.getTime());
  assert.equal(minsk.excluded, 'другой город');
  const remote = scoreVacancy(vac({ title: 'Маркетолог', location: 'Москва', snippet: 'Удалённая работа' }), p, now.getTime());
  assert.ok(!remote.excluded);
  assert.equal(remote.otherCity, 'Москва');
  const spb = scoreVacancy(vac({ title: 'Маркетолог', location: 'Санкт-Петербург, м. Невский проспект' }), p, now.getTime());
  assert.ok(!spb.excluded && !spb.otherCity);
  const noCity = scoreVacancy(vac({ title: 'Маркетолог', snippet: 'Продвижение бренда' }), p, now.getTime());
  assert.ok(!noCity.excluded, 'город не указан — показываем');
  const remoteNotWanted = scoreVacancy(vac({ title: 'Маркетолог', location: 'Москва', snippet: 'Удалённо' }), { ...p, formats: ['office'] }, now.getTime());
  assert.equal(remoteNotWanted.excluded, 'другой город');
});

test('тип занятости из профиля', () => {
  const p = { position: 'Маркетолог', employment: ['full'], formats: [], cities: [], stopWords: [], maxAgeDays: 30 };
  assert.equal(scoreVacancy(vac({ title: 'Маркетолог', snippet: 'Частичная занятость, подработка' }), p, now.getTime()).excluded, 'другой тип занятости');
  assert.ok(!scoreVacancy(vac({ title: 'Маркетолог', snippet: 'Полная занятость' }), p, now.getTime()).excluded);
  assert.ok(!scoreVacancy(vac({ title: 'Маркетолог', snippet: 'Без уточнений' }), p, now.getTime()).excluded);
});

test('должность на английском = русская: Product Marketing Manager (PMM)', () => {
  const p = { position: 'Product Marketing Manager (PMM)', formats: [], cities: [], stopWords: [], maxAgeDays: 30 };
  assert.equal(scoreVacancy(vac({ title: 'Продуктовый маркетолог' }), p, now.getTime()).where, 'title');
  assert.equal(scoreVacancy(vac({ title: 'PMM в финтех' }), p, now.getTime()).where, 'title');
  assert.equal(scoreVacancy(vac({ title: 'Product manager' }), p, now.getTime()).excluded, 'другая должность');
});
