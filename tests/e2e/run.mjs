// Сквозной тест расширения в настоящем Chromium.
// Поднимает локальный сервер с фикстурами (имитация hh.ru, Avito, t.me, карьерного
// сайта), загружает расширение и проверяет весь путь: обход → разбор → CRM.
//
// Запуск: npm run test:e2e   (нужны Playwright и xvfb; в CI — xvfb-run)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fx = (name) => fs.readFileSync(path.join(root, 'tests/fixtures', name), 'utf8');

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* попробуем глобальный */ }
  const g = execSync('npm root -g').toString().trim();
  return import(path.join(g, 'playwright/index.mjs'));
}

// ---------- сервер фикстур ----------
function route(url) {
  const u = new URL(url, 'http://x');
  const p = u.pathname;
  if (p === '/hh/search') return fx('hh-serp.html');
  if (p === '/hh2/search') return fx('hh-serp-nodataqa.html');
  if (p === '/vacancy/101') return fx('hh-vacancy-101.html');
  if (/^\/vacancy\/\d+$/.test(p)) return `<!doctype html><meta charset="utf-8"><div data-qa="vacancy-description"><p>Описание вакансии ${p}. Python, Docker.</p></div>`;
  if (p === '/avito') return fx('avito.html');
  if (p.startsWith('/moskva/vakansii/python')) return fx('avito-item.html');
  if (p.startsWith('/moskva/vakansii/')) return '<!doctype html><meta charset="utf-8"><div data-marker="item-view/item-description"><p>Доставка заказов по городу, график 5/2.</p></div>';
  if (p === '/s/testjobs') return u.searchParams.get('before') ? fx('tme-before.html') : fx('tme.html');
  if (p === '/careers') return fx('careers.html');
  if (p === '/careers/jobs/backend-python-501') return fx('careers-job-501.html');
  if (p === '/careers/jobs/data-engineer-502') return '<!doctype html><meta charset="utf-8"><main><h1>Data Engineer</h1><p>Airflow, Spark, ClickHouse, Python. Удалённо.</p></main>';
  if (p.startsWith('/careers/')) return '<!doctype html><meta charset="utf-8"><main><h1>О нас</h1><p>Мы большая компания.</p></main>';
  if (p === '/captcha') return fx('captcha.html');
  return null;
}

const hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.url);
  const body = route(req.url);
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body || 'not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------- расширение с доступом к 127.0.0.1 ----------
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-ext-'));
fs.cpSync(path.join(root, 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const { chromium } = await loadPlaywright();
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-profile-'));
const context = await chromium.launchPersistentContext(userDir, {
  headless: false,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run'],
  viewport: { width: 1280, height: 900 },
});

let failed = false;
const step = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed = true; console.log(`FAIL ${name}\n     ${e.message}`); }
};

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const dash = `chrome-extension://${extId}/dashboard.html`;

  // Вкладка профиля открывается сама при установке.
  await step('после установки открывается профиль', async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !context.pages().some((p) => p.url().startsWith(dash))) await new Promise((r) => setTimeout(r, 200));
    assert.ok(context.pages().some((p) => p.url().startsWith(`${dash}#profile`)));
  });

  const page = await context.newPage();
  await page.goto(dash);

  // Заполняем профиль через форму, как пользователь.
  await step('профиль сохраняется через форму', async () => {
    await page.goto(`${dash}#profile`);
    await page.fill('#pKeywords', 'python, backend');
    await page.selectOption('#pGrade', 'middle');
    await page.fill('#pSkills', '*Python, Django, PostgreSQL, Docker, Redis, Git');
    await page.fill('#pSalary', '220000');
    await page.check('input[name=fmt][value=remote]');
    await page.check('input[name=fmt][value=hybrid]');
    await page.uncheck('input[name=fmt][value=office]');
    await page.fill('#pStop', '1С');
    await page.click('#profileForm button[type=submit]');
    await page.waitForSelector('#profileSaved:has-text("Сохранено")');
    const { profile } = await page.evaluate(() => chrome.storage.local.get('profile'));
    assert.equal(profile.grade, 'middle');
    assert.deepEqual(profile.formats, ['remote', 'hybrid']);
    assert.equal(profile.skills[0], '*Python');
  });

  await step('навыки находятся в тексте резюме', async () => {
    await page.fill('#resume', 'Опыт 4 года: Python, FastAPI, Kafka, ClickHouse, Kubernetes');
    await page.click('#findSkills');
    const chips = await page.locator('#foundSkills button.chip').allTextContents();
    for (const s of ['FastAPI', 'Kafka', 'ClickHouse', 'Kubernetes']) assert.ok(chips.some((c) => c.includes(s)), `${s} в ${chips}`);
    assert.ok(!chips.some((c) => c.includes('Python')), 'Python уже в профиле');
  });

  // Источники: в тесте задаём платформу явно, потому что все фикстуры на 127.0.0.1.
  await page.evaluate(async (b) => {
    const mk = (id, platform, name, url, cfg = {}) => ({ id, platform, name, url, intervalMin: 120, enabled: true, cfg: { enrichDelay: [100, 200], enrichMax: 10, ...cfg } });
    await chrome.storage.local.set({
      settings: { autoRun: false, tickMinutes: 60, notifyScore: 0.6, skipWhenLocked: false, openIn: 'tab', retentionDays: 45, manualEnrichMax: 5, pauseBetweenSources: [100, 200] },
      sources: [
        mk('hh', 'hh', 'hh: python', `${b}/hh/search`),
        mk('hh2', 'hh', 'hh: без data-qa', `${b}/hh2/search`, { enrichMax: 0 }),
        mk('av', 'avito', 'Avito: python', `${b}/avito`),
        mk('tg', 'telegram', 'TG: testjobs', `${b}/s/testjobs`, { pages: 2 }),
        mk('car', 'generic', 'Тополь: карьера', `${b}/careers`),
        mk('cap', 'hh', 'hh: капча', `${b}/captcha`),
      ],
    });
  }, base);

  await step('обход всех источников завершается', async () => {
    const r = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'runNow' }));
    assert.ok(r.started);
    const deadline = Date.now() + 150000;
    for (;;) {
      const { runs } = await page.evaluate(() => chrome.storage.local.get('runs'));
      const st = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
      if ((runs?.length || 0) >= 6 && !st.running) break;
      if (Date.now() > deadline) throw new Error(`не дождались: ${runs?.length || 0} обходов`);
      await new Promise((res) => setTimeout(res, 1000));
    }
  });

  const all = await page.evaluate(() => chrome.storage.local.get(null));
  const v = (k) => all[`v:${k}`];
  const state = (id) => all[`srcstate:${id}`];

  await step('hh: карточки и подробное описание', async () => {
    const a = v('hh:101');
    assert.ok(a, 'нет v:hh:101');
    assert.equal(a.title, 'Middle Python-разработчик');
    assert.equal(a.company, 'ООО Ромашка');
    assert.deepEqual(a.salary, { from: 250000, to: null, currency: 'RUB' });
    assert.ok(a.enriched, 'описание не подгружено');
    for (const s of ['python', 'django', 'postgresql', 'redis', 'docker', 'git', 'rest']) assert.ok(a.skills.includes(s), `нет навыка ${s}`);
    assert.ok(a.skillsOptional.includes('kafka') && a.skillsOptional.includes('kubernetes'));
    assert.ok(a.formats.includes('remote'));
    assert.ok(a.publishedAt?.startsWith('2026-10-10'), `дата ${a.publishedAt}`);
    assert.equal(a.url, `${base}/vacancy/101`);
    assert.ok(v('hh:102') && v('hh:103'));
    assert.equal(state('hh').lastStatus, 'ok');
  });

  await step('hh: запасной разбор по ссылкам без data-qa', async () => {
    assert.equal(v('hh:201')?.title, 'Python Backend Developer (FastAPI)');
    assert.deepEqual(v('hh:201').salary, { from: 200000, to: 280000, currency: 'RUB' });
    assert.equal(v('hh:202')?.title, 'Junior Python-разработчик');
  });

  await step('Avito: выдача и карточка', async () => {
    const a = v('avito:3001234567');
    assert.ok(a, 'нет вакансии Avito');
    assert.equal(a.title, 'Python-разработчик (удалённо)');
    assert.equal(a.salary?.from, 220000);
    assert.equal(a.company, 'ООО Липа');
    assert.ok(a.skills.includes('flask') && a.skillsOptional.includes('celery'));
    assert.ok(a.publishedAt, 'нет даты');
  });

  await step('Telegram: вакансии, без резюме, вторая страница, дубль hh', async () => {
    const p = v('telegram:testjobs/10');
    assert.ok(p, 'нет поста 10');
    assert.equal(p.title, 'Senior Python Developer');
    assert.equal(p.company, 'Ёлка Тех');
    assert.deepEqual(p.salary, { from: 350000, to: 450000, currency: 'RUB' });
    assert.ok(p.skills.includes('fastapi') && p.skillsOptional.includes('kubernetes'));
    assert.ok(!v('telegram:testjobs/11'), 'резюме попало в вакансии');
    assert.ok(!v('telegram:testjobs/12'), 'дубль hh сохранён отдельно');
    assert.ok(v('hh:101').alsoAt.some((x) => x.url.includes('testjobs/12')), 'дубль не привязан к hh:101');
    assert.equal(v('telegram:testjobs/5')?.title, 'QA Automation Engineer');
    assert.ok(hits.some((h) => h.includes('before=10')));
  });

  await step('сайт компании: SPA, JSON-LD, без мусорных ссылок', async () => {
    const job = v(`generic:${base}/careers/jobs/backend-python-501`);
    assert.ok(job, 'нет вакансии 501');
    assert.equal(job.company, 'Тополь');
    assert.deepEqual(job.salary, { from: 260000, to: 340000, currency: 'RUB' });
    assert.ok(job.skillsOptional.includes('clickhouse'));
    assert.ok(v(`generic:${base}/careers/jobs/data-engineer-502`));
    assert.ok(!Object.keys(all).some((k) => k.includes('about-us') || k.includes('benefits')), 'ссылки «О компании» попали в вакансии');
  });

  await step('капча: источник помечен и поставлен на паузу', async () => {
    const st = state('cap');
    assert.equal(st.lastStatus, 'blocked');
    assert.ok(Date.parse(st.nextRunAt) - Date.now() > 5 * 3600e3, 'пауза меньше 5 часов');
  });

  await step('CRM: лента отсортирована, стоп-слово и чужой стек ниже порога', async () => {
    await page.goto(`${dash}#vacancies`);
    await page.waitForSelector('.card');
    const titles = await page.locator('.card h3 a').allTextContents();
    assert.ok(titles.length >= 4, `карточек ${titles.length}`);
    assert.ok(/Python/.test(titles[0]), `первая: ${titles[0]}`);
    assert.ok(!titles.includes('Программист 1С'), '1С не скрыт стоп-словом');
    assert.ok(!titles.includes('Курьер'), 'курьер прошёл порог');
    const scores = (await page.locator('.card .score').allTextContents()).map(Number);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  });

  await step('CRM: смена статуса и заметка сохраняются, открытие ставит «Просмотрел»', async () => {
    const card = page.locator('.card').first();
    await card.locator('select').selectOption('applied');
    await card.locator('button:has-text("Заметка")').click();
    await card.locator('textarea').fill('Написал рекрутеру 13.10');
    await card.locator('textarea').blur();
    await page.waitForTimeout(300);
    const u = await page.evaluate(() => chrome.storage.local.get(null).then((a) => Object.entries(a).filter(([k]) => k.startsWith('u:'))));
    assert.ok(u.some(([, x]) => x.status === 'applied' && x.note === 'Написал рекрутеру 13.10'), JSON.stringify(u));

    const second = page.locator('.card').nth(1);
    const [popup] = await Promise.all([context.waitForEvent('page'), second.locator('h3 a').click()]);
    await popup.close();
    await page.waitForTimeout(500);
    const u2 = await page.evaluate(() => chrome.storage.local.get(null).then((a) => Object.values(a).filter((x) => x?.status === 'viewed').length));
    assert.equal(u2, 1);
  });

  await step('CRM: «Скрыть» убирает вакансию из активных', async () => {
    const before = await page.locator('.card').count();
    await page.locator('.card').last().locator('button:has-text("Скрыть")').click();
    await page.waitForFunction((n) => document.querySelectorAll('.card').length === n - 1, before, { timeout: 5000 });
  });

  await step('повторный обход не затирает статус и не плодит дубли', async () => {
    const countV = async () => page.evaluate(() => chrome.storage.local.get(null).then((a) => Object.keys(a).filter((k) => k.startsWith('v:')).length));
    const n1 = await countV();
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'runNow', sourceId: 'hh' }));
    await page.waitForFunction(() => chrome.runtime.sendMessage({ type: 'status' }).then((s) => !s.running), null, { timeout: 60000, polling: 1000 });
    await page.waitForTimeout(500);
    assert.equal(await countV(), n1);
    const u = await page.evaluate(() => chrome.storage.local.get(null).then((a) => Object.values(a).filter((x) => x?.status === 'applied').length));
    assert.equal(u, 1);
  });

  // Площадка определяется по домену, поэтому 127.0.0.1 — это «сайт компании».
  await step('сбор с открытой вкладки (кнопка в popup)', async () => {
    const tab = await context.newPage();
    await tab.goto(`${base}/careers`);
    await tab.bringToFront();
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
    const r = await page.evaluate((id) => chrome.runtime.sendMessage({ type: 'collectTab', tabId: id }), tabId);
    assert.equal(r.platform, 'generic');
    assert.ok(r.found >= 2, JSON.stringify(r));
    assert.equal(r.added, 0, 'вакансии уже были собраны обходом');
    await tab.close();
  });

  await step('добавление источника из формы определяет площадку', async () => {
    await page.goto(`${dash}#sources`);
    await page.fill('#aUrl', 'https://t.me/some_jobs_channel');
    await page.click('#addForm button[type=submit]');
    await page.waitForSelector('#addMsg:has-text("Добавлено")');
    const { sources } = await page.evaluate(() => chrome.storage.local.get('sources'));
    const s = sources.find((x) => x.url === 'https://t.me/s/some_jobs_channel');
    assert.ok(s, 'нет источника');
    assert.equal(s.platform, 'telegram');
    await page.waitForSelector('#srcBody tr:has-text("some_jobs_channel")');
  });

  // Скриншоты для README.
  const shots = process.env.SCREENSHOT_DIR;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.goto(`${dash}#vacancies`);
    await page.waitForSelector('.card');
    await page.screenshot({ path: path.join(shots, 'crm-vacancies.png'), fullPage: true });
    await page.goto(`${dash}#sources`);
    await page.waitForSelector('#srcBody tr');
    await page.screenshot({ path: path.join(shots, 'crm-sources.png'), fullPage: true });
    await page.goto(`${dash}#profile`);
    await page.waitForSelector('#pSkills');
    await page.screenshot({ path: path.join(shots, 'crm-profile.png'), fullPage: true });
    const pop = await context.newPage();
    await pop.setViewportSize({ width: 360, height: 360 });
    await pop.goto(`chrome-extension://${extId}/popup.html`);
    await pop.screenshot({ path: path.join(shots, 'popup.png') });
  }

} finally {
  await context.close();
  server.close();
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.rmSync(userDir, { recursive: true, force: true });
}

console.log(failed ? '\nE2E: есть ошибки' : '\nE2E: всё прошло');
process.exit(failed ? 1 : 0);
