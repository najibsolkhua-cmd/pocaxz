import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { profileFromResume } from '../../extension/lib/resume-profile.js';
import { suggestTitles } from '../../extension/lib/roles.js';
import { canonicalCity, cityMatches } from '../../extension/lib/geo.js';
import { looksLikeJobTitle } from '../../extension/lib/parse.js';
import { scoreVacancy } from '../../extension/lib/match.js';

globalThis.chrome = { storage: { local: {} } };
const store = await import('../../extension/lib/store.js');

test('автозаполнение из резюме hh.ru', () => {
  const p = profileFromResume(fs.readFileSync(new URL('../fixtures/resume-hh.txt', import.meta.url), 'utf8'));
  assert.equal(p.name, 'Наджиб');
  assert.equal(p.position, 'Маркетолог');
  assert.deepEqual(p.titleKeywords, ['Маркетолог-аналитик', 'Менеджер по маркетингу', 'интернет-маркетолог']);
  assert.equal(p.grade, 'middle');
  assert.equal(p.minSalary, 100000);
  assert.deepEqual(p.cities, ['Санкт-Петербург']);
  assert.ok(p.formats.includes('remote'));
  assert.match(p.about, /Гибридный управленец/);
  for (const s of ['SMM', 'Яндекс Директ', 'Юнит-экономика', 'Маркетинговая стратегия']) assert.ok(p.skills.includes(s), s);
});

test('похожие должности: без лишнего', () => {
  const m = suggestTitles('Маркетолог');
  assert.ok(m.includes('Менеджер по маркетингу') && m.includes('Интернет-маркетолог'));
  assert.ok(!m.includes('Копирайтер') && !m.includes('Менеджер по продажам'));
  const py = suggestTitles('Python backend-разработчик');
  assert.ok(py.includes('Python-разработчик'));
  assert.ok(!py.some((t) => /Java/.test(t)));
  assert.ok(suggestTitles('SMM').includes('SMM-менеджер'));
  assert.deepEqual(suggestTitles('Менеджер'), []);
});

test('города: синонимы и сравнение с адресом', () => {
  assert.equal(canonicalCity('спб'), 'Санкт-Петербург');
  assert.equal(canonicalCity('Питер'), 'Санкт-Петербург');
  assert.equal(canonicalCity('мск'), 'Москва');
  assert.equal(canonicalCity('тверь'), 'Тверь');
  assert.ok(cityMatches('СПб', 'Санкт-Петербург, м. Невский проспект'));
  assert.ok(!cityMatches('Москва', 'Казань'));
});

test('сайты компаний: навигация отсекается, любые профессии проходят', () => {
  for (const t of ['О компании', 'Бонусы и льготы', 'Все вакансии', 'Контакты']) assert.ok(!looksLikeJobTitle(t), t);
  for (const t of ['Продавец-кассир', 'Товаровед', 'Стажер маркетолог', 'Водитель']) assert.ok(looksLikeJobTitle(t), t);
});

test('автопоиск: синонимы через OR и регион по городу', () => {
  const p = { position: 'Маркетолог', titleKeywords: ['Менеджер по маркетингу'], cities: ['спб'] };
  const hh = decodeURIComponent(store.autoSearchUrl('hh', p));
  assert.ok(hh.includes('text=Маркетолог OR "Менеджер по маркетингу"'), hh);
  assert.ok(hh.includes('area=2'));
  assert.ok(store.autoSearchUrl('avito', p).startsWith('https://www.avito.ru/sankt-peterburg/vakansii?q='));
  assert.ok(store.autoSearchUrl('hh', { position: 'x' }).includes('area=113'));
});

test('короткие имена источников и ссылки на одну вакансию', () => {
  assert.equal(store.sourceName('https://www.tbank.ru/career/vacancies/all/saint-petersburg/?cityId=c2&searchQuery=маркетолог', 'generic'), 'tbank.ru: маркетолог');
  assert.equal(store.sourceName('https://www.avito.ru/sankt-peterburg/vakansii?q=маркетолог&s=104', 'avito'), 'Avito: маркетолог, Санкт-Петербург');
  assert.equal(store.sourceName('https://spb.hh.ru/search/vacancy?text=&salary=', 'hh'), 'hh.ru: все вакансии');
  assert.ok(store.isSingleVacancyUrl('https://spb.hh.ru/vacancy/123456'));
  assert.ok(!store.isSingleVacancyUrl('https://hh.ru/search/vacancy?text=x'));
});

test('синонимы должности и пример вакансии повышают оценку', () => {
  const base = { position: 'Маркетолог', skills: [], formats: [], cities: [], stopWords: [], maxAgeDays: 30 };
  // «Маркетолог» и «Менеджер по маркетингу» и так совпадают по корню; «Бренд-менеджер» — нет.
  const v = { title: 'Бренд-менеджер', company: '', description: 'Развитие бренда, позиционирование, работа с агентствами', skills: [], skillsOptional: [], firstSeenAt: new Date().toISOString() };
  const plain = scoreVacancy(v, base);
  const withAlt = scoreVacancy(v, { ...base, titleKeywords: ['Бренд-менеджер'] });
  const withEx = scoreVacancy(v, { ...base, examples: [{ title: 'Бренд-менеджер', text: 'бренд, позиционирование, агентства' }] });
  assert.equal(plain.parts.title, 0);
  assert.equal(withAlt.parts.title, 1);
  assert.ok(withAlt.score > plain.score && withEx.score > plain.score, `${plain.score} ${withAlt.score} ${withEx.score}`);
});
