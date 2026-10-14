// Сквозной тест расширения в настоящем Chromium.
// Поднимает локальный сервер с фикстурами (имитация hh.ru, Avito, t.me, карьерного
// сайта), загружает расширение и проходит путь пользователя: профиль и резюме →
// «Найти работу» → счётчики на плитках → панели → статусы.
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

// PDF-резюме генерируем отдельным headless-браузером (page.pdf работает только там).
const resumePdf = path.join(os.tmpdir(), `resume-${process.pid}.pdf`);
{
  const b = await chromium.launch();
  const pg = await b.newPage();
  await pg.setContent(`<html><body style="font-family:sans-serif">
    <h1>Иванов Иван</h1><h2>Python backend-разработчик</h2>
    <p>Опыт 4 года. Python, Django, FastAPI, PostgreSQL, Redis, Docker, Kafka, Git.</p>
    <p>Разрабатывал микросервисы для финтеха, highload API.</p></body></html>`);
  await pg.pdf({ path: resumePdf });
  await b.close();
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-profile-'));
const context = await chromium.launchPersistentContext(userDir, {
  headless: false,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run'],
  viewport: { width: 1440, height: 900 },
});

let failed = false;
const step = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed = true; console.log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`); }
};
const pageErrors = [];
const until = async (fn, ms = 10000, what = 'условие') => {
  const t0 = Date.now();
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`);
    await new Promise((res) => setTimeout(res, 250));
  }
};

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const dash = `chrome-extension://${extId}/dashboard.html`;
  const storage = (pg) => pg.evaluate(() => chrome.storage.local.get(null));

  let page;
  await step('после установки открывается главная с панелью профиля', async () => {
    page = await until(() => context.pages().find((p) => p.url().startsWith(dash)), 10000, 'вкладка главной');
    page.on('pageerror', (e) => pageErrors.push(e.message));
    if (process.env.DEBUG_E2E) page.on('console', (m) => console.log('  [console]', m.type(), m.text()));
    await page.waitForSelector('.drawer.open.dk-profile');
    assert.equal(await page.locator('.t-src').count(), 4);
    assert.equal(await page.locator('#whoName').textContent(), 'Ваше имя');
  });

  await step('профиль: резюме PDF, навыки, должность, условия', async () => {
    const d = page.locator('#drawerBody');
    await d.locator('input[type=file]').setInputFiles(resumePdf);
    await d.locator('.file-pill').waitFor();
    assert.match(await d.locator('.file-pill').textContent(), /resume-\d+\.pdf/);
    // Должность подставилась из резюме.
    const pos = d.locator('.field', { hasText: 'Желаемая должность' }).locator('input');
    assert.equal(await pos.inputValue(), 'Python backend-разработчик');
    // Навыки из резюме.
    const found = await d.locator('.chip.add:not(.all)').allTextContents();
    for (const sk of ['Python', 'Django', 'FastAPI', 'PostgreSQL', 'Kafka']) assert.ok(found.some((c) => c.includes(sk)), `${sk} в ${found}`);
    await d.locator('.chip.add.all').click();
    // Python — основной стек.
    await d.locator('.chip.skill', { hasText: 'Python' }).locator('.star').click();
    await d.locator('.field', { hasText: 'Имя' }).first().locator('input').fill('Иван');
    await d.locator('.field', { hasText: 'Чем я занимаюсь' }).locator('textarea').fill('Бэкенд на Python: API, микросервисы, PostgreSQL, финтех.');
    await d.locator('.seg button', { hasText: 'Middle' }).click();
    await d.locator('.field', { hasText: 'Зарплата от' }).locator('input').fill('220000');
    await d.locator('.seg button', { hasText: 'Офис' }).click(); // выключить офис
    await d.locator('.field', { hasText: 'Не показывать' }).locator('input').fill('1С');
    await d.locator('.skill-input').fill('Docker');
    await d.locator('.skill-input').press('Enter');
    await d.locator('button[type=submit]', { hasText: 'Сохранить профиль' }).click();
    await d.locator('.savebar .muted', { hasText: 'Сохранено' }).waitFor();

    const all = await storage(page);
    assert.equal(all.profile.name, 'Иван');
    assert.equal(all.profile.position, 'Python backend-разработчик');
    assert.equal(all.profile.grade, 'middle');
    assert.deepEqual(all.profile.formats.sort(), ['hybrid', 'remote']);
    assert.ok(all.profile.skills.includes('*Python'), all.profile.skills.join(','));
    assert.ok(all.profile.skills.includes('Docker'));
    assert.match(all.resume.text, /highload API/);
    // Поиск по должности создан на hh.ru и Avito.
    const auto = all.sources.filter((x) => x.auto);
    assert.deepEqual(auto.map((x) => x.platform).sort(), ['avito', 'hh']);
    assert.ok(auto.find((x) => x.platform === 'hh').url.includes('text=Python%20backend'));
  });

  // Вкладку, открытую расширением при установке, Playwright не умеет сделать видимой —
  // дальше работаем в обычной вкладке.
  await page.close();
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  if (process.env.DEBUG_E2E) page.on('console', (m) => console.log('  [console]', m.type(), m.text()));
  await page.goto(`${dash}#profile`);

  await step('главная показывает имя, должность и профиль', async () => {
    await page.waitForSelector('.drawer.open');
    await page.locator('.drawer-close').click();
    await until(() => page.evaluate(() => !document.querySelector('.drawer.open')), 3000, 'закрытие панели');
    assert.equal(await page.locator('#whoName').textContent(), 'Иван');
    assert.equal(await page.locator('#whoPosition').textContent(), 'Python backend-разработчик');
    assert.match(await page.locator('#profileTile').textContent(), /resume-\d+\.pdf/);
    assert.match(await page.locator('#clockTime').textContent(), /^\d\d:\d\d$/);
  });

  // Реальные hh.ru/Avito в тесте недоступны: выключаем автопоиски и подставляем фикстуры.
  await page.evaluate(async (b) => {
    const { sources, settings } = await chrome.storage.local.get(['sources', 'settings']);
    const mk = (id, platform, name, url, cfg = {}) => ({ id, platform, name, url, intervalMin: 120, enabled: true, cfg: { enrichDelay: [100, 200], enrichMax: 10, ...cfg } });
    await chrome.storage.local.set({
      settings: { ...(settings || {}), autoRun: false, skipWhenLocked: false, pauseBetweenSources: [100, 200] },
      sources: [
        ...sources.map((x) => ({ ...x, enabled: false })),
        mk('hh', 'hh', 'hh: python', `${b}/hh/search`),
        mk('hh2', 'hh', 'hh: без data-qa', `${b}/hh2/search`, { enrichMax: 0 }),
        mk('av', 'avito', 'Avito: python', `${b}/avito`),
        mk('tg', 'telegram', 'TG: testjobs', `${b}/s/testjobs`, { pages: 2 }),
        mk('car', 'generic', 'Тополь: карьера', `${b}/careers`),
        mk('cap', 'hh', 'hh: капча', `${b}/captcha`),
      ],
    });
  }, base);

  await step('«Найти работу»: прогресс на кнопке и плитках, затем итог', async () => {
    await page.locator('#findBtn').click();
    await until(() => page.locator('#findText').textContent().then((t) => t.startsWith('Ищу')), 5000, 'прогресс на кнопке');
    await until(() => page.locator('.t-src.scanning').count(), 15000, 'плитка в состоянии поиска');
    await until(async () => {
      const st = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
      const { runs } = await page.evaluate(() => chrome.storage.local.get('runs'));
      return !st.running && (runs?.length || 0) >= 6;
    }, 180000, 'окончание поиска');
    await until(() => page.locator('#findText').textContent().then((t) => t === '/ Найти работу'), 5000, 'кнопка вернулась');
    await page.locator('.toast.show', { hasText: 'Поиск завершён' }).waitFor({ timeout: 8000 });
  });

  const all = await storage(page);
  const v = (k) => all[`v:${k}`];
  const state = (id) => all[`srcstate:${id}`];

  await step('разбор hh: карточки, описание, навыки, дата', async () => {
    const a = v('hh:101');
    assert.ok(a, 'нет v:hh:101');
    assert.equal(a.title, 'Middle Python-разработчик');
    assert.equal(a.company, 'ООО Ромашка');
    assert.deepEqual(a.salary, { from: 250000, to: null, currency: 'RUB' });
    assert.ok(a.enriched, 'описание не подгружено');
    for (const sk of ['python', 'django', 'postgresql', 'redis', 'docker', 'git', 'rest']) assert.ok(a.skills.includes(sk), `нет навыка ${sk}`);
    assert.ok(a.skillsOptional.includes('kafka') && a.skillsOptional.includes('kubernetes'));
    assert.ok(a.publishedAt?.startsWith('2026-10-10'), `дата ${a.publishedAt}`);
    assert.equal(v('hh:201')?.title, 'Python Backend Developer (FastAPI)');
  });

  await step('разбор Avito, Telegram (вторая страница, без резюме, дубль hh) и сайта компании', async () => {
    const av = v('avito:3001234567');
    assert.equal(av?.title, 'Python-разработчик (удалённо)');
    assert.equal(av.company, 'ООО Липа');
    const tg = v('telegram:testjobs/10');
    assert.equal(tg?.title, 'Senior Python Developer');
    assert.deepEqual(tg.salary, { from: 350000, to: 450000, currency: 'RUB' });
    assert.ok(!v('telegram:testjobs/11'), 'резюме попало в вакансии');
    assert.ok(!v('telegram:testjobs/12'), 'дубль hh сохранён отдельно');
    assert.ok(v('hh:101').alsoAt.some((x) => x.url.includes('testjobs/12')));
    assert.equal(v('telegram:testjobs/5')?.title, 'QA Automation Engineer');
    const job = v(`generic:${base}/careers/jobs/backend-python-501`);
    assert.equal(job?.company, 'Тополь');
    assert.ok(!Object.keys(all).some((k) => k.includes('about-us')), 'ссылка «О компании» стала вакансией');
    assert.equal(state('cap').lastStatus, 'blocked');
  });

  await step('плитки источников: число подходящих, новые, предупреждение о капче', async () => {
    await page.waitForTimeout(1500);
    const counts = Object.fromEntries(await Promise.all(['hh', 'avito', 'telegram', 'generic'].map(async (p) => [p, await page.locator(`.t-${p} .count`).textContent()])));
    // Ожидаемое число считаем той же функцией, что и интерфейс.
    const expected = await page.evaluate(async () => {
      const { scoreAll } = await import('./lib/match.js');
      const store = await import('./lib/store.js');
      const a = await chrome.storage.local.get(null);
      const rows = scoreAll(store.vacanciesFrom(a), { ...(await store.getProfile()) }, a.resume?.text || '');
      const out = {};
      for (const p of ['hh', 'avito', 'telegram', 'generic']) out[p] = String(rows.filter(({ v: x, s }) => x.platform === p && s.score >= 0.5 && !['hidden', 'rejected'].includes(x.status)).length);
      return out;
    });
    assert.deepEqual(counts, expected);
    assert.ok(Number(counts.hh) >= 2 && Number(counts.telegram) >= 1 && Number(counts.generic) >= 1, JSON.stringify(counts));
    assert.ok(await page.locator('.t-hh.has-new').count(), 'нет красной точки у hh');
    assert.ok(await page.locator('.t-hh.warn').count(), 'нет предупреждения о капче');
    assert.match(await page.locator('.t-hh .sub').textContent(), /нужна проверка/);
    assert.match(await page.locator('.t-telegram .sub').textContent(), /\d+ нов/);
  });

  await step('«Лучшее», воронка и поиск на главной', async () => {
    const top = await page.locator('#topTile .mini-title').allTextContents();
    assert.ok(top.length >= 3 && /Python/i.test(top[0]), top.join(' | '));
    assert.ok(!top.includes('Программист 1С'));
    assert.match(await page.locator('#funnelTile').textContent(), /Новые подходящие/);
    assert.match(await page.locator('#searchTile').textContent(), /⚠ 1 с проблемой/);
  });

  await step('панель hh: статистика, список, источники', async () => {
    await page.locator('.t-hh').click();
    await page.waitForSelector('.drawer.open.dk-hh .vc');
    const stats = await page.locator('.stat b').allTextContents();
    assert.equal(stats[0], await page.locator('.t-hh .count').textContent());
    const titles = await page.locator('#drawerBody .vc h3 a').allTextContents();
    assert.ok(titles.every((t) => !/Курьер|1С/.test(t)), titles.join(' | '));
    assert.ok(await page.locator('#drawerBody .src-row', { hasText: 'hh: капча' }).locator('.fix').count(), 'нет ссылки «пройти проверку»');
  });

  await step('статус и заметка из панели попадают в «Мои отклики» и воронку', async () => {
    const card = page.locator('#drawerBody .vc').first();
    const title = await card.locator('h3 a').textContent();
    await card.locator('select').selectOption('applied');
    await card.locator('button', { hasText: 'Заметка' }).click();
    await card.locator('textarea').fill('Написал рекрутеру');
    await card.locator('textarea').blur();
    await page.keyboard.press('Escape');
    await until(() => page.locator('#appliedTile .mini-title').allTextContents().then((t) => t.includes(title)), 5000, 'вакансия в «Мои отклики»');
    assert.match(await page.locator('#funnelTile li', { hasText: 'Отправил резюме' }).textContent(), /^1/);
    const u = Object.entries(await storage(page)).filter(([k]) => k.startsWith('u:')).map(([, x]) => x);
    assert.ok(u.some((x) => x.status === 'applied' && x.note === 'Написал рекрутеру'));
  });

  await step('открытие вакансии из «Лучшее» ставит «Просмотрел»', async () => {
    const link = page.locator('#topTile a').first();
    const [tab] = await Promise.all([context.waitForEvent('page'), link.click()]);
    await tab.close();
    await until(async () => Object.values(await storage(page)).some((x) => x?.status === 'viewed'), 4000, 'статус viewed');
  });

  await step('повторное «Найти работу» сразу после поиска не дёргает сайты', async () => {
    const n = hits.length;
    await page.locator('#findBtn').click();
    await page.locator('.toast.show', { hasText: 'меньше 10 минут' }).waitFor({ timeout: 5000 });
    assert.equal(hits.length, n);
  });

  await step('панель Telegram: добавление канала', async () => {
    await page.locator('.t-telegram').click();
    await page.waitForSelector('.drawer.open.dk-telegram');
    await page.locator('.add-src input').first().fill('@some_jobs_channel');
    await page.locator('.add-src button[type=submit]').click();
    await page.locator('.add-src .muted', { hasText: 'Добавлено' }).waitFor();
    await page.waitForSelector('#drawerBody .src-row:has-text("some_jobs_channel")');
    const { sources } = await storage(page);
    assert.ok(sources.some((x) => x.url === 'https://t.me/s/some_jobs_channel' && x.platform === 'telegram'));
    await page.keyboard.press('Escape');
  });

  await step('панель «Поиск и настройки»: журнал и сохранение настроек', async () => {
    await page.locator('.t-search').click();
    await page.waitForSelector('.drawer.open.dk-search');
    assert.ok(await page.locator('table.log tbody tr').count() >= 6);
    const inp = page.locator('.field', { hasText: '«подходит»' }).locator('input');
    await inp.fill('45');
    await page.locator('.settings button[type=submit]').click();
    await until(async () => (await storage(page)).settings.matchScore === 0.45, 3000, 'matchScore');
    await page.keyboard.press('Escape');
  });

  await step('сбор с открытой вкладки (кнопка в меню расширения)', async () => {
    const tab = await context.newPage();
    await tab.goto(`${base}/careers`);
    await tab.bringToFront();
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
    const r = await page.evaluate((id) => chrome.runtime.sendMessage({ type: 'collectTab', tabId: id }), tabId);
    assert.equal(r.platform, 'generic');
    assert.ok(r.found >= 2 && r.added === 0, JSON.stringify(r));
    await tab.close();
  });

  await step('на странице нет ошибок JavaScript и мусорного текста', async () => {
    assert.deepEqual(pageErrors, []);
    for (const hash of ['', 'profile', 'hh', 'all', 'funnel', 'applied', 'search']) {
      await page.evaluate((x) => { location.hash = x; }, hash);
      await page.waitForTimeout(300);
      const text = await page.evaluate(() => document.body.innerText);
      assert.ok(!/\b(null|undefined|NaN)\b/.test(text), `«${hash}»: ${text.match(/.{0,40}\b(null|undefined|NaN)\b.{0,40}/)?.[0]}`);
    }
    await page.evaluate(() => { location.hash = ''; });
  });

  const shots = process.env.SCREENSHOT_DIR;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.bringToFront();
    await page.evaluate(() => { location.hash = ''; });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(shots, 'home.png') });
    await page.evaluate(() => { location.hash = 'hh'; });
    await page.waitForSelector('.drawer.open .vc');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, 'drawer-hh.png') });
    await page.evaluate(() => { location.hash = 'profile'; });
    await page.waitForSelector('.drawer.open .pform');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, 'drawer-profile.png') });
    await page.evaluate(() => { location.hash = ''; });
    await page.setViewportSize({ width: 420, height: 900 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(shots, 'home-mobile.png'), fullPage: true });
    const pop = await context.newPage();
    await pop.setViewportSize({ width: 360, height: 380 });
    await pop.goto(`chrome-extension://${extId}/popup.html`);
    await pop.waitForTimeout(300);
    await pop.screenshot({ path: path.join(shots, 'popup.png') });
  }
} finally {
  await context.close();
  server.close();
  fs.rmSync(extDir, { recursive: true, force: true });
  fs.rmSync(userDir, { recursive: true, force: true });
  fs.rmSync(resumePdf, { force: true });
}

console.log(failed ? '\nE2E: есть ошибки' : '\nE2E: всё прошло');
process.exit(failed ? 1 : 0);
