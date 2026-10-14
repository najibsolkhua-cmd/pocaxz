import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSalary, parseGrades, parseFormats, parseRuDate, extractSkills,
  looksLikeVacancy, titleFromPost, normalizeItem, resolveSkill,
} from '../../extension/lib/parse.js';

test('зарплата: форматы hh.ru', () => {
  assert.deepEqual(parseSalary('от 150 000 до 250 000 ₽ за месяц, на руки'), { from: 150000, to: 250000, currency: 'RUB' });
  assert.deepEqual(parseSalary('150 000 – 250 000 ₽'), { from: 150000, to: 250000, currency: 'RUB' });
  assert.deepEqual(parseSalary('до 300 000 ₽'), { from: null, to: 300000, currency: 'RUB' });
  assert.deepEqual(parseSalary('от 200 000 руб.'), { from: 200000, to: null, currency: 'RUB' });
});

test('зарплата: посты Telegram', () => {
  assert.deepEqual(parseSalary('ЗП: 250-350к, удалёнка'), { from: 250000, to: 350000, currency: 'RUB' });
  assert.deepEqual(parseSalary('Вилка 3000-4500$'), { from: 3000, to: 4500, currency: 'USD' });
  assert.deepEqual(parseSalary('Зарплата: от 180 тыс. руб'), { from: 180000, to: null, currency: 'RUB' });
  assert.deepEqual(parseSalary('зп 200-300 на руки'), { from: 200000, to: 300000, currency: 'RUB' });
});

test('зарплата: не путаем с опытом, годами и телефонами', () => {
  assert.equal(parseSalary('Опыт 3-6 лет, офис в Москве, с 2026 года'), null);
  assert.equal(parseSalary('Звоните +7 999 123 45 67'), null);
  assert.equal(parseSalary('Зарплата по договорённости'), null);
});

test('грейд из названия, опыта и текста', () => {
  assert.deepEqual(parseGrades('Senior Python Developer'), ['senior']);
  assert.deepEqual(parseGrades('Middle/Senior Backend'), ['middle', 'senior']);
  assert.deepEqual(parseGrades('Python-разработчик', 'Опыт работы: 3–6 лет'), ['middle', 'senior']);
  assert.deepEqual(parseGrades('Разработчик', 'Требуемый опыт работы: 1–3 года'), ['junior', 'middle']);
  assert.deepEqual(parseGrades('Стажёр-аналитик'), ['intern']);
  assert.deepEqual(parseGrades('Тимлид команды платежей'), ['lead']);
  assert.deepEqual(parseGrades('Разработчик', 'Без опыта, обучим'), ['intern', 'junior']);
});

test('формат работы', () => {
  assert.deepEqual(parseFormats('Можно удалённо'), ['remote']);
  assert.deepEqual(parseFormats('Гибридный формат, офис у метро'), ['hybrid', 'office']);
  assert.deepEqual(parseFormats('Remote only'), ['remote']);
});

test('даты: относительные и абсолютные', () => {
  const now = new Date('2026-10-13T12:00:00');
  assert.equal(parseRuDate('3 часа назад', now), new Date('2026-10-13T09:00:00').toISOString());
  assert.equal(parseRuDate('вчера в 14:20', now), new Date('2026-10-12T12:00:00').toISOString());
  assert.equal(parseRuDate('12 октября', now), new Date(2026, 9, 12, 12).toISOString());
  assert.equal(parseRuDate('28 декабря', new Date('2026-01-05T12:00:00')), new Date(2025, 11, 28, 12).toISOString());
  assert.equal(parseRuDate('5 мая 2026', now), new Date(2026, 4, 5, 12).toISOString());
  assert.equal(parseRuDate('2026-10-01T10:00:00+00:00', now), '2026-10-01T10:00:00.000Z');
});

test('навыки: синонимы, границы слов и «будет плюсом»', () => {
  const r = extractSkills('Требования: Python 3, Django/DRF, постгрес, Docker. Будет плюсом: Kafka, k8s');
  assert.ok(r.required.includes('python'));
  assert.ok(r.required.includes('django'));
  assert.ok(r.required.includes('postgresql'));
  assert.ok(r.required.includes('docker'));
  assert.ok(r.optional.includes('kafka'));
  assert.ok(r.optional.includes('kubernetes'));
  assert.ok(!r.required.includes('kafka'));
});

test('навыки: короткие синонимы только с заглавной', () => {
  assert.ok(extractSkills('Пишем на Go и TS').required.includes('go'));
  assert.ok(!extractSkills('let it go, ready to go').required.includes('go'));
  assert.ok(extractSkills('Опыт с C++ и C#').required.includes('cpp'));
  assert.ok(extractSkills('Опыт с C++ и C#').required.includes('csharp'));
  assert.ok(!extractSkills('JavaScript').required.includes('java'));
});

test('свой навык из профиля', () => {
  const custom = resolveSkill('Мегаплан');
  assert.equal(custom.custom, true);
  assert.deepEqual(extractSkills('Настройка Мегаплан и интеграции', [custom]).required.includes(custom.slug), true);
  assert.equal(resolveSkill('postgres').slug, 'postgresql');
});

test('пост Telegram: вакансия или нет', () => {
  assert.ok(looksLikeVacancy('#вакансия Python-разработчик в финтех, ЗП 300к'));
  assert.ok(!looksLikeVacancy('#резюме Ищу работу Python-разработчиком'));
  assert.ok(!looksLikeVacancy('Дайджест статей недели про Python'));
  assert.equal(titleFromPost('🔥 #вакансия\nВакансия: Senior Python Developer\nКомпания: Ромашка'), 'Senior Python Developer');
});

test('normalizeItem: hh-карточка', () => {
  const n = normalizeItem({
    externalId: '123', url: 'https://hh.ru/vacancy/123', title: 'Middle Python-разработчик',
    company: 'ООО Ромашка', location: 'Москва', salaryText: 'от 250 000 ₽ на руки',
    snippet: 'Опыт с Django и PostgreSQL. Можно удалённо', tags: ['Docker', 'Redis'],
  }, 'hh', new Date('2026-10-13T12:00:00'));
  assert.equal(n.title, 'Middle Python-разработчик');
  assert.deepEqual(n.salary, { from: 250000, to: null, currency: 'RUB' });
  assert.deepEqual(n.grades, ['middle']);
  assert.deepEqual(n.formats, ['remote']);
  for (const s of ['python', 'django', 'postgresql', 'docker', 'redis']) assert.ok(n.skills.includes(s), s);
});

test('normalizeItem: пост без признаков вакансии отбрасывается', () => {
  assert.equal(normalizeItem({ externalId: 'c/1', description: 'Анонс митапа в пятницу' }, 'telegram'), null);
});
