import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { siteApiFor, readSiteApi, jobFromObject } from '../../extension/lib/sites.js';

const json = JSON.parse(fs.readFileSync(new URL('../fixtures/tbank-api.json', import.meta.url), 'utf8'));
const page = 'https://www.tbank.ru/career/vacancies/all/saint-petersburg/?searchQuery=маркетолог';

test('T-Банк: страница карьеры читается через API сайта', async () => {
  const api = siteApiFor(page);
  assert.equal(api?.id, 'tbank');
  assert.equal(siteApiFor('https://www.tbank.ru/cards/'), null, 'не карьера');
  assert.equal(siteApiFor('https://example.com/jobs'), null);
  const calls = [];
  // Сервер принимает только второй вариант запроса — адаптер пробует варианты по очереди.
  const fetchJson = async (url, body) => { calls.push([url, body]); return calls.length === 2 ? json : null; };
  const r = await readSiteApi(api, page, fetchJson);
  assert.equal(calls[0][0], 'https://www.tbank.ru/pfpjobs/papi/getVacancies');
  assert.equal(r.variant, 1);
  assert.equal(r.items.length, 3);
  assert.equal(r.total, 3);
  const py = r.items[0];
  assert.equal(py.url, 'https://www.tbank.ru/career/it/vacancy/moscow/python-backend/');
  assert.equal(py.location, 'Москва');
  assert.match(py.description, /FastAPI/);
  assert.match(py.formatText, /Гибрид/);
  // В следующий раз сразу запоминаемый вариант.
  calls.length = 0;
  const again = await readSiteApi(api, page, async (u, b) => { calls.push(b); return json; }, 1);
  assert.equal(calls.length, 1);
  assert.equal(again.variant, 1);
  // Сервер отвечает только на адрес с параметрами сайта — доходим и до него.
  const seen = [];
  const withParams = await readSiteApi(api, page, async (u, b) => { seen.push(u); return u.includes('appName=pfpjobs') ? json : null; });
  assert.ok(withParams.items.length === 3 && seen.at(-1).endsWith('?appName=pfpjobs&origin=web%2Cib5%2Cplatform'));
  assert.equal(withParams.variant, api.bodies.length, 'первый вариант второго адреса');
});

test('T-Банк: браузер не пускает запрос (защищённый режим) — одна попытка, без перебора вариантов', async () => {
  const api = siteApiFor(page);
  let calls = 0;
  const blocked = async () => { calls++; throw Object.assign(new Error('Failed to fetch'), { blocked: true }); };
  await assert.rejects(readSiteApi(api, page, blocked), (e) => e.blocked === true);
  assert.equal(calls, 1);
});

test('вакансия без ссылки ведёт на страницу списка', () => {
  const it = jobFromObject({ id: 'a3', title: 'Представитель', subtitle: 'Санкт-Петербург' }, page);
  assert.ok(it.url.startsWith('https://www.tbank.ru/career/vacancies/all/saint-petersburg/?searchQuery='));
  assert.ok(it.url.endsWith('#a3'));
  assert.equal(jobFromObject({ id: 1 }, page), null);
});
