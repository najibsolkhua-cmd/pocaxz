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
  assert.equal(plain.excluded, 'другая должность');
  assert.equal(withAlt.where, 'title');
  assert.equal(withEx.where, 'title');
  assert.ok(withAlt.score > 0.5 && withEx.score > 0.5, `${withAlt.score} ${withEx.score}`);
});

test('смена должности меняет её в ссылках hh.ru и Avito', async () => {
  const db = {};
  Object.assign(chrome.storage.local, {
    get: async (k) => (k == null ? { ...db } : Object.fromEntries([k].flat().filter((x) => x in db).map((x) => [x, db[x]]))),
    set: async (o) => { Object.assign(db, structuredClone(o)); },
    remove: async (k) => { [k].flat().forEach((x) => delete db[x]); },
  });
  db.sources = [
    { id: 'u1', platform: 'hh', url: 'https://spb.hh.ru/search/vacancy?text=%D0%9C%D0%B0%D1%80%D0%BA%D0%B5%D1%82%D0%BE%D0%BB%D0%BE%D0%B3&salary=100000', enabled: true, intervalMin: 30 },
    { id: 'u2', platform: 'hh', url: 'https://hh.ru/search/vacancy?text=python', enabled: true, intervalMin: 30 },
  ];
  // Первый заход: должность из резюме — сразу появляются поиски hh.ru и Avito.
  await store.syncAutoSources({ position: 'Маркетолог', titleKeywords: [], cities: ['Санкт-Петербург'] });
  let src = await store.getSources();
  // Своя ссылка hh.ru с той же должностью уже есть — дубль не создаём.
  assert.ok(!src.some((s) => s.auto === 'hh') && src.some((s) => s.auto === 'avito'));
  assert.ok(src.find((s) => s.auto === 'avito').url.includes(encodeURIComponent('Маркетолог')));
  db['srcstate:u1'] = { lastFound: 50 };
  // Сменили должность — в авто-поисках и в своей ссылке с прежней должностью она тоже меняется.
  await store.syncAutoSources({ position: 'SMM-менеджер', titleKeywords: [], cities: ['Санкт-Петербург'] });
  src = await store.getSources();
  const u1 = new URL(src.find((s) => s.id === 'u1').url);
  assert.equal(u1.searchParams.get('text'), 'SMM-менеджер');
  assert.equal(u1.searchParams.get('salary'), '100000');
  assert.equal(src.find((s) => s.id === 'u2').url, 'https://hh.ru/search/vacancy?text=python');
  assert.ok(new URL(src.find((s) => s.auto === 'avito').url).searchParams.get('q') === 'SMM-менеджер');
  assert.ok(!('srcstate:u1' in db), 'счётчики старой ссылки сброшены');
  // Своей ссылки нет — авто-поиск hh.ru создаётся и идёт по новой должности.
  await store.removeSource('u1');
  await store.syncAutoSources({ position: 'Таргетолог', titleKeywords: ['Специалист по таргету'], cities: [] });
  src = await store.getSources();
  assert.ok(decodeURIComponent(src.find((s) => s.auto === 'hh').url).includes('text=Таргетолог OR "Специалист по таргету"'));
  assert.equal(new URL(src.find((s) => s.auto === 'avito').url).searchParams.get('q'), 'Таргетолог');
});
