// Картинки для каталогов (Chrome Web Store, Opera Add-ons, Edge Add-ons):
//   store/img/screenshot-*.png — 1280×800, store/img/promo-small.png — 440×280,
//   store/img/promo-marquee.png — 1400×560. Запуск: npm run store:assets (нужен Playwright).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const out = path.join(root, 'store', 'img');
fs.mkdirSync(out, { recursive: true });
async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* глобальный */ }
  return import(path.join(execSync('npm root -g').toString().trim(), 'playwright/index.mjs'));
}
const { chromium } = await loadPlaywright();
const ext = path.join(root, 'extension');
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'store-')), {
  headless: false, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const dash = `chrome-extension://${new URL(sw.url()).host}/dashboard.html`;
const page = await ctx.newPage();
await page.goto(dash);
await page.evaluate(async () => {
  const now = Date.now();
  const iso = (m) => new Date(now - m * 60e3).toISOString();
  const V = [
    ['hh', '1', 'Маркетолог по продукту', 'ООО Леккер', 150000, 'Санкт-Петербург'],
    ['hh', '2', 'Digital-маркетолог', 'Фонд содействия', 120000, 'Санкт-Петербург'],
    ['hh', '3', 'Руководитель отдела маркетинга', 'Клиника Ботаника', 180000, 'Санкт-Петербург'],
    ['avito', '4', 'Маркетолог + SMM-специалист', 'Злата', 90000, 'Санкт-Петербург'],
    ['telegram', 'c/5', 'Интернет-маркетолог', 'Ёлка', 130000, 'Удалённо'],
    ['generic', 'https://career.example.ru/7', 'Продуктовый маркетолог', 'Т-Банк', 200000, 'Санкт-Петербург'],
    ['hh', '8', 'B2B-маркетолог', 'Сервер Молл', 140000, 'Санкт-Петербург'],
    ['hh', '9', 'Маркетолог-аналитик', 'Ромашка', 160000, 'Санкт-Петербург'],
  ];
  const data = {};
  V.forEach(([platform, id, title, company, from, location], i) => {
    const key = `v:${platform}:${id}`;
    data[key] = { key, platform, externalId: id, url: 'https://hh.ru/', title, company, location, salary: { from, to: null, currency: 'RUB' }, grades: ['middle'], formats: ['hybrid'], skills: ['smm', 'yandex_direct', 'metrika'], skillsOptional: [], snippet: 'SMM, контекстная реклама, Яндекс Директ, веб-аналитика, юнит-экономика. Гибридный формат, белая зарплата.', description: 'Маркетолог: SMM, Яндекс Директ, Метрика, аналитика, юнит-экономика.', firstSeenAt: iso(60 + i), lastSeenAt: iso(5), publishedAt: iso(60 * 24 * (i % 4)), sources: ['src'] };
  });
  data['u:hh:8'] = { status: 'applied', statusChangedAt: iso(60 * 24 * 2) };
  data['u:hh:9'] = { status: 'interview', statusChangedAt: iso(60 * 5) };
  data['u:avito:4'] = { status: 'responded', statusChangedAt: iso(60) };
  await chrome.storage.local.set({
    ...data,
    profile: { name: 'Анна', position: 'Маркетолог', titleKeywords: ['Менеджер по маркетингу', 'Интернет-маркетолог'], about: 'Маркетинг, SMM, Директ, аналитика, юнит-экономика', skills: ['*SMM', 'Яндекс Директ', 'Юнит-экономика', 'Яндекс Метрика'], minSalary: 120000, formats: ['remote', 'hybrid', 'office'], cities: ['Санкт-Петербург'], stopWords: [], maxAgeDays: 30, grade: 'middle' },
    resume: { name: 'Резюме Анна.pdf', text: 'Маркетолог', uploadedAt: iso(100) },
    sources: [
      { id: 's1', platform: 'hh', name: 'hh.ru: Маркетолог', url: 'https://hh.ru/search/vacancy?text=маркетолог', intervalMin: 120, enabled: true, cfg: {}, auto: 'hh' },
      { id: 's2', platform: 'avito', name: 'Avito: Маркетолог', url: 'https://www.avito.ru/sankt-peterburg/vakansii?q=маркетолог', intervalMin: 240, enabled: true, cfg: {}, auto: 'avito' },
      { id: 's3', platform: 'generic', name: 'Сайт компании', url: 'https://career.example.ru/', intervalMin: 360, enabled: true, cfg: {} },
      { id: 's4', platform: 'telegram', name: 'TG: @marketing_jobs', url: 'https://t.me/s/marketing_jobs', intervalMin: 60, enabled: true, cfg: {} },
    ],
    'srcstate:s1': { lastRunAt: iso(5), lastStatus: 'ok', lastTotal: 1234, lastFound: 100 },
    'srcstate:s2': { lastRunAt: iso(5), lastStatus: 'ok', lastTotal: 419, lastFound: 100 },
    'srcstate:s3': { lastRunAt: iso(5), lastStatus: 'ok', lastFound: 12 },
    'srcstate:s4': { lastRunAt: iso(5), lastStatus: 'ok', lastFound: 40 },
    runs: [{ at: iso(5), source: 'hh.ru: Маркетолог', status: 'ok', found: 100, added: 12 }],
    autoArmed: true,
  });
});
await page.reload();
await page.waitForTimeout(1500);
const shot = async (hash, file) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(out, file) });
};
await shot('', 'screenshot-1-home.png');
await shot('all', 'screenshot-2-vacancies.png');
await shot('applied', 'screenshot-3-responses.png');
await shot('profile', 'screenshot-4-profile.png');
await shot('generic', 'screenshot-5-sites.png');
await ctx.close();

// Промо-картинки из HTML.
const b = await chromium.launch();
for (const [w, hgt, file] of [[440, 280, 'promo-small.png'], [1400, 560, 'promo-marquee.png']]) {
  const p = await b.newPage({ viewport: { width: w, height: hgt } });
  await p.goto(`file://${path.join(root, 'store', 'promo.html')}?w=${w}`);
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(out, file) });
}
await b.close();
console.log('Готово:', fs.readdirSync(out).join(', '));
