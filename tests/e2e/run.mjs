// Сквозной тест расширения в настоящем Chromium.
// Поднимает локальный сервер с фикстурами (имитация hh.ru, Avito, t.me, карьерного
// сайта), загружает расширение и проходит путь пользователя: резюме → автозаполнение
// профиля → «Найти работу» с лимитом → постраничный сбор → плитки → панели → архив.
//
// Запуск: npm run test:e2e   (нужны Playwright и xvfb; в CI — xvfb-run)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fx = (name) => fs.readFileSync(path.join(root, 'tests/fixtures', name), 'utf8');

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* попробуем глобальный */ }
  const g = execSync('npm root -g').toString().trim();
  return import(path.join(g, 'playwright/index.mjs'));
}

// ---------- сервер фикстур ----------
const flags = { hide502: false };
function route(url) {
  const u = new URL(url, 'http://x');
  const p = u.pathname;
  const page = Number(u.searchParams.get('page') || 0);
  if (p === '/hh/search') return page === 0 ? fx('hh-serp.html') : page === 1 ? fx('hh-serp-page2.html') : '<!doctype html><meta charset="utf-8"><p>Ничего не найдено</p>';
  if (p === '/hh2/search') return fx('hh-serp-nodataqa.html');
  if (p === '/vacancy/101') return fx('hh-vacancy-101.html');
  if (p === '/vacancy/104') return fx('hh-vacancy-archived.html');
  if (/^\/vacancy\/\d+$/.test(p)) return `<!doctype html><meta charset="utf-8"><h1>Вакансия</h1><div data-qa="vacancy-description"><p>Описание вакансии ${p}. Python, Docker.</p></div>`;
  if (p === '/avito') return Number(u.searchParams.get('p') || 1) >= 2 ? fx('avito-page2.html') : fx('avito.html');
  if (p.startsWith('/moskva/vakansii/python')) return fx('avito-item.html');
  if (p.startsWith('/moskva/vakansii/')) return '<!doctype html><meta charset="utf-8"><div data-marker="item-view/item-description"><p>Доставка заказов по городу, график 5/2.</p></div>';
  if (p === '/s/testjobs') return u.searchParams.get('before') ? fx('tme-before.html') : fx('tme.html');
  if (p === '/careers') return flags.hide502 ? fx('careers.html').replace(/<div class="job"><h3>Data Engineer[\s\S]*?<\/div>/, '') : fx('careers.html');
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
    <p>Проживает: Москва</p>
    <p>Опыт 4 года. Python, Django, FastAPI, PostgreSQL, Redis, Docker, Kafka, Git.</p>
    <p>Разрабатывал микросервисы для финтеха, highload API, интеграции с платёжными системами и внутренние сервисы аналитики.</p></body></html>`);
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
  const waitIdle = (pg, ms = 240000) => until(async () => {
    const st = await pg.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
    return !st.running;
  }, ms, 'окончание поиска');

  let page = await until(() => context.pages().find((p) => p.url().startsWith(dash)), 10000, 'вкладка главной');
  await step('после установки открывается главная с панелью профиля', async () => {
    await page.waitForSelector('.drawer.open.dk-profile');
    assert.equal(await page.locator('.t-src').count(), 4);
    assert.equal(await page.locator('.t-src img.logo').count(), 4, 'логотипы площадок — SVG-картинки');
    assert.ok(await page.locator('img.brand[src="img/solk-job.svg"]').count(), 'логотип solk/job из SVG');
  });

  // Вкладку, открытую расширением при установке, Playwright не умеет сделать видимой —
  // дальше работаем в обычной вкладке.
  await page.close();
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const acceptAll = (dlg) => dlg.accept();
  page.on('dialog', acceptAll);
  if (process.env.DEBUG_E2E) page.on('console', (m) => console.log('  [console]', m.type(), m.text()));
  await page.goto(`${dash}#profile`);
  const d = page.locator('#drawerBody');

  await step('резюме PDF: профиль заполняется сам', async () => {
    await d.locator('input[type=file]').setInputFiles(resumePdf);
    await d.locator('.file-pill').waitFor();
    await d.locator('.auto-msg', { hasText: 'Заполнено из резюме' }).waitFor();
    assert.equal(await d.locator('.field', { hasText: 'Имя' }).first().locator('input').inputValue(), 'Иван');
    assert.equal(await d.locator('.field', { hasText: 'Желаемая должность' }).locator('input').inputValue(), 'Python backend-разработчик');
    const skills = await d.locator('.field, section').filter({ hasText: 'основные навыки' }).locator('.chip.edit').allTextContents();
    for (const sk of ['Python', 'Django', 'FastAPI', 'PostgreSQL', 'Kafka']) assert.ok(skills.some((c) => c.includes(sk)), `${sk} в ${skills}`);
    assert.ok(await d.locator('.seg button.on', { hasText: 'Middle' }).count(), 'грейд Middle по стажу 4 года');
    const cities = await d.locator('.field', { hasText: 'Города' }).locator('.chip.edit').allTextContents();
    assert.ok(cities.some((c) => c.includes('Москва')), `город: ${cities}`);
    // Профиль из резюме сохраняется сам — поиски hh.ru и Avito по должности появляются сразу.
    await until(async () => (await storage(page)).sources?.some((x) => x.auto === 'avito'), 5000, 'автопоиски после резюме');
    const st = await storage(page);
    assert.ok(decodeURIComponent(st.sources.find((x) => x.auto === 'hh').url).includes('Python backend-разработчик'));
    assert.equal(st.profile.position, 'Python backend-разработчик');
  });

  await step('кнопка «Заполнить профиль из резюме» и похожие должности', async () => {
    await d.locator('.field', { hasText: 'Имя' }).first().locator('input').fill('');
    await d.locator('button', { hasText: 'Заполнить профиль из резюме' }).click();
    assert.equal(await d.locator('.field', { hasText: 'Имя' }).first().locator('input').inputValue(), 'Иван');
    const sugg = await d.locator('.suggest .chip.add').allTextContents();
    assert.ok(sugg.some((t) => t.includes('Python-разработчик')), `подсказки: ${sugg}`);
    await d.locator('.suggest .chip.add', { hasText: 'Python-разработчик' }).first().click();
    const titles = await d.locator('.field', { hasText: 'Другие названия' }).locator('.chip.edit').allTextContents();
    assert.ok(titles.some((t) => t.includes('Python-разработчик')), `названия: ${titles}`);
  });

  await step('города через запятую с синонимами, стоп-слова, условия', async () => {
    const city = d.locator('.field', { hasText: 'Города' }).locator('.chip-input');
    await city.fill('спб, Казань');
    await city.press('Enter');
    const cities = await d.locator('.field', { hasText: 'Города' }).locator('.chip.edit').allTextContents();
    assert.ok(cities.some((c) => c.includes('Санкт-Петербург')) && cities.some((c) => c.includes('Казань')), `города: ${cities}`);
    await d.locator('section', { hasText: 'основные навыки' }).locator('.chip.edit', { hasText: /^☆?Python×?$/ }).locator('.star').click();
    await d.locator('.seg button', { hasText: 'Офис' }).click();
    const fmt = await d.locator('.field', { hasText: 'Формат' }).locator('.seg button.on').allTextContents();
    if (fmt.includes('Офис')) await d.locator('.seg button', { hasText: 'Офис' }).click();
    await d.locator('.seg button', { hasText: 'Удалённо' }).evaluate((b) => { if (!b.classList.contains('on')) b.click(); });
    await d.locator('.field', { hasText: 'Зарплата от' }).locator('input').fill('220000');
    const stop = d.locator('.field', { hasText: 'Не показывать' }).locator('.chip-input');
    await stop.fill('1С');
    await stop.press('Enter');
  });

  await step('«Искать должность только»: название и описание по умолчанию, компания — по выбору', async () => {
    const seg = d.locator('.field', { hasText: 'Искать должность только' }).locator('.seg button');
    assert.deepEqual(await seg.evaluateAll((bs) => bs.map((b) => b.classList.contains('on'))), [true, false, true]);
    await seg.nth(1).click();
    await seg.nth(1).click();
    assert.ok(await d.locator('.field', { hasText: 'Тип занятости' }).count());
  });

  await step('пример подходящей вакансии по ссылке', async () => {
    await d.locator('.field', { hasText: 'Примеры подходящих' }).locator('input').fill(`${base}/vacancy/101`);
    await d.locator('.field', { hasText: 'Примеры подходящих' }).locator('button', { hasText: 'Добавить' }).click();
    await d.locator('.example a', { hasText: 'Middle Python-разработчик' }).waitFor({ timeout: 30000 });
  });

  await step('сохранение профиля и автопоиск по должности с городом', async () => {
    await d.locator('button[type=submit]', { hasText: 'Сохранить профиль' }).click();
    await d.locator('.savebar .muted', { hasText: 'Сохранено' }).waitFor();
    const all = await storage(page);
    assert.equal(all.profile.name, 'Иван');
    assert.ok(all.profile.skills.includes('*Python'), all.profile.skills.join(','));
    assert.deepEqual(all.profile.cities, ['Москва', 'Санкт-Петербург', 'Казань']);
    assert.ok(all.profile.stopWords.includes('1С'));
    assert.equal(all.profile.examples.length, 1);
    assert.ok(!all.profile.formats.includes('office'));
    assert.deepEqual(all.profile.matchIn, { title: true, company: false, description: true });
    const hh = all.sources.find((x) => x.auto === 'hh');
    assert.ok(hh, 'нет автопоиска hh');
    assert.ok(decodeURIComponent(hh.url).includes('Python backend-разработчик OR Python-разработчик') || decodeURIComponent(hh.url).includes('"Python backend-разработчик" OR Python-разработчик'), decodeURIComponent(hh.url));
    assert.ok(hh.url.includes('area=1'), 'регион — первый город (Москва)');
    assert.ok(all.sources.find((x) => x.auto === 'avito').url.includes('/moskva/'));
  });

  await step('смена должности сразу меняет её в ссылках hh.ru и Avito', async () => {
    const pos = d.locator('.field', { hasText: 'Желаемая должность' }).locator('input');
    const urls = async () => {
      const { sources } = await storage(page);
      return { hh: decodeURIComponent(sources.find((x) => x.auto === 'hh').url), avito: new URL(sources.find((x) => x.auto === 'avito').url).searchParams.get('q') };
    };
    await pos.fill('Go-разработчик');
    await pos.blur();
    await until(async () => (await urls()).avito === 'Go-разработчик', 5000, 'Avito: новая должность');
    assert.ok((await urls()).hh.includes('text=Go-разработчик'), (await urls()).hh);
    await d.locator('.savebar .muted', { hasText: 'hh.ru и Avito обновлён' }).waitFor();
    await pos.fill('Python backend-разработчик');
    await pos.blur();
    await until(async () => (await urls()).avito === 'Python backend-разработчик', 5000, 'Avito: должность вернулась');
    assert.ok((await urls()).hh.includes('Python-разработчик'), 'синонимы снова в запросе hh');
  });

  await step('главная: имя, должность, часы, лимит', async () => {
    await page.locator('.drawer-close').click();
    await until(() => page.evaluate(() => !document.querySelector('.drawer.open')), 3000, 'закрытие панели');
    // Главная обновляется по изменению хранилища (не чаще раза в секунду).
    await until(async () => (await page.locator('#whoName').textContent()) === 'Иван', 4000, 'имя на главной');
    await until(async () => (await page.locator('#whoPosition').textContent()) === 'Python backend-разработчик', 4000, `должность на главной: ${await page.locator('#whoPosition').textContent()}`);
    assert.match(await page.locator('#clockText').textContent(), /^\d\d:\d\d$/);
    assert.ok(await page.locator('#clockSvg').getAttribute('viewBox'), 'у часов подогнан viewBox');
    const [tw, dw] = await page.evaluate(() => ['clockText', 'clockDate'].map((id) => document.getElementById(id).getBBox().width));
    assert.ok(Math.abs(tw - dw) / tw < 0.08, `время и дата одной ширины: ${tw} / ${dw}`);
    assert.ok(await page.locator('#accessBar').isHidden(), 'доступ к сайтам есть — плашки нет');
    assert.ok(await page.locator('.limit button.on', { hasText: '100' }).count(), 'по умолчанию 100');
    await page.locator('#limitInput').fill('250');
    await page.locator('#limitInput').press('Enter');
    await until(async () => (await storage(page)).settings?.scanLimit === 250, 3000, 'лимит 250');
    await page.locator('.limit button', { hasText: '10' }).first().click();
    await until(async () => (await storage(page)).settings?.scanLimit === 10, 3000, 'лимит 10');
  });

  // Реальные hh.ru/Avito в тесте недоступны: выключаем автопоиски и подставляем фикстуры.
  await page.evaluate(async (b) => {
    const { sources, settings } = await chrome.storage.local.get(['sources', 'settings']);
    const mk = (id, platform, name, url, cfg = {}) => ({ id, platform, name, url, intervalMin: 120, enabled: true, cfg });
    await chrome.storage.local.set({
      settings: { ...(settings || {}), autoRun: false, skipWhenLocked: false, pauseBetweenSources: [100, 200] },
      sources: [
        ...sources.map((x) => ({ ...x, enabled: false })),
        mk('hh', 'hh', 'hh: python', `${b}/hh/search`),
        mk('hh2', 'hh', 'hh: без data-qa', `${b}/hh2/search`),
        mk('av', 'avito', 'Avito: python', `${b}/avito`),
        mk('tg', 'telegram', 'TG: testjobs', `${b}/s/testjobs`),
        mk('car', 'generic', 'Тополь: карьера', `${b}/careers`),
        mk('cap', 'hh', 'hh: капча', `${b}/captcha`),
      ],
    });
  }, base);

  await step('лимит 10: источник с 6 вакансиями на двух страницах собирается целиком, но не больше лимита', async () => {
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'runNow', sourceId: 'hh' }));
    await waitIdle(page);
    const st = (await storage(page))['srcstate:hh'];
    assert.equal(st.lastTotal, 6, 'всего на сайте из заголовка');
    assert.equal(st.lastFound, 6, 'обе страницы выдачи');
    assert.equal(st.lastPages, 3, 'третья страница пустая — стоп');
    assert.ok(hits.some((h) => h.includes('/hh/search?page=1')));
  });

  await step('«Найти работу» с лимитом 100: прогресс, все источники, итог', async () => {
    await page.locator('.limit button', { hasText: '100' }).first().click();
    await until(async () => (await storage(page)).settings?.scanLimit === 100, 3000, 'лимит 100');
    await page.locator('#findBtn').click();
    await until(() => page.locator('#findText').textContent().then((t) => t.startsWith('Ищу')), 5000, 'прогресс на кнопке');
    await until(() => page.locator('.t-src.scanning').count(), 20000, 'плитка в состоянии поиска');
    await waitIdle(page);
    await until(() => page.locator('#findText').textContent().then((t) => t === '/ Найти работу'), 5000, 'кнопка вернулась');
    await page.locator('.toast.show', { hasText: 'Поиск завершён' }).waitFor({ timeout: 8000 });
  });

  let all = await storage(page);
  const v = (k) => all[`v:${k}`];
  const state = (id) => all[`srcstate:${id}`];

  await step('hh: описание у лучших, навыки, дата, архивная вакансия скрыта', async () => {
    const a = v('hh:101');
    assert.ok(a?.enriched, 'описание hh:101 не подгружено');
    for (const sk of ['python', 'django', 'postgresql', 'redis', 'docker', 'git', 'rest']) assert.ok(a.skills.includes(sk), `нет навыка ${sk}`);
    assert.ok(a.publishedAt?.startsWith('2026-10-10'), `дата ${a.publishedAt}`);
    assert.ok(v('hh:104')?.archived, 'hh:104 «в архиве» должна быть помечена');
    assert.ok(v('hh:105'));
    assert.equal(v('hh:201')?.title, 'Python Backend Developer (FastAPI)');
  });

  await step('фильтры профиля: чужой город без удалёнки и чужая должность отсеяны, удалёнка из другого города — с пометкой', async () => {
    const r = await page.evaluate(async () => {
      const { scoreAll } = await import('./lib/match.js');
      const store = await import('./lib/store.js');
      const a = await chrome.storage.local.get(null);
      const rows = scoreAll(store.vacanciesFrom(a), store.sanitizeProfile(a.profile), a.resume?.text || '');
      return Object.fromEntries(rows.map(({ v: x, s }) => [x.key, { ex: s.excluded || null, other: s.otherCity || null }]));
    });
    assert.equal(r['v:hh:106'].ex, 'другой город', 'офис в Екатеринбурге');
    assert.equal(r['v:hh:105'].ex, null);
    assert.equal(r['v:hh:105'].other, 'Новосибирск');
    assert.equal(r['v:hh:102'].ex, 'другая должность', 'Java при профиле Python');
    assert.equal(r['v:avito:3007654321'].ex, 'другая должность', 'курьер');
    assert.equal(r['v:telegram:testjobs/5'].ex, 'другая должность', 'QA');
  });

  await step('Avito: две страницы, «на сайте», описание; Telegram; сайт компании', async () => {
    assert.equal(state('av').lastTotal, 3);
    assert.equal(state('av').lastFound, 3);
    assert.equal(v('avito:3001234567')?.company, 'ООО Липа');
    assert.ok(v('avito:3009999999'), 'вторая страница Avito');
    assert.equal(v('telegram:testjobs/10')?.title, 'Senior Python Developer');
    assert.ok(!v('telegram:testjobs/11'), 'резюме попало в вакансии');
    assert.equal(v('telegram:testjobs/5')?.title, 'QA Automation Engineer');
    const job = v(`generic:${base}/careers/jobs/backend-python-501`);
    assert.equal(job?.company, 'Тополь');
    assert.ok(v(`generic:${base}/careers/jobs/data-engineer-502`));
    assert.ok(!Object.keys(all).some((k) => k.includes('about-us') || k.includes('benefits')), 'ссылки меню попали в вакансии');
    assert.equal(state('cap').lastStatus, 'blocked');
  });

  await step('числа согласованы: плитки = воронка = «Поиск»', async () => {
    await page.waitForTimeout(1500);
    const counts = await Promise.all(['hh', 'avito', 'telegram', 'generic'].map((p) => page.locator(`.t-${p} .count`).textContent()));
    const sum = counts.reduce((a, b) => a + Number(b || 0), 0);
    const funnel = Number(await page.locator('#funnelTile li.lead b').textContent());
    const search = await page.locator('#searchTile').textContent();
    assert.equal(funnel, sum, `воронка ${funnel}, сумма плиток ${sum}`);
    assert.match(search, new RegExp(`Подходят вам${sum} из`));
    assert.ok(Number(counts[0]) >= 2, `hh: ${counts[0]}`);
    assert.match(await page.locator('.t-hh .sub').textContent(), /проверку/);
    // Воронка помещается в плитку целиком.
    const fits = await page.evaluate(() => { const t = document.querySelector('.t-funnel'); const last = t.querySelector('.funnel li:last-child'); return last.getBoundingClientRect().bottom <= t.getBoundingClientRect().bottom; });
    assert.ok(fits, 'строка «Отказ» вылезает за плитку');
  });

  await step('панель hh: «на сайте / собрано / подходят», объяснение оценки, без горизонтальной прокрутки', async () => {
    await page.locator('.t-hh').click();
    await page.waitForSelector('.drawer.open.dk-hh .vc');
    const labels = await page.locator('.stat span').allTextContents();
    assert.deepEqual(labels, ['вакансий на сайте', 'собрано', 'подходят вам', 'ещё не смотрели']);
    assert.equal(await page.locator('.stat b').nth(2).textContent(), await page.locator('.t-hh .count').textContent());
    assert.match(await page.locator('.vc-why').first().textContent(), /должность/);
    assert.match(await page.locator('.vc-score').first().textContent(), /%подходит/);
    assert.ok(await page.locator('.range', { hasText: 'Подходит мне от' }).count());
    const noHScroll = await page.evaluate(() => { const b = document.querySelector('.drawer-body'); return b.scrollWidth <= b.clientWidth + 1; });
    assert.ok(noHScroll, 'в панели есть горизонтальная прокрутка');
    const titles = await page.locator('#drawerBody .vc h3 a').allTextContents();
    assert.ok(!titles.some((t) => /1С/.test(t)), 'стоп-слово не сработало');
    assert.ok(!titles.includes('Python-разработчик (Django)'), 'архивная вакансия видна');
    assert.ok(!titles.includes('Python-разработчик в офис'), 'офис в другом городе виден');
    assert.ok(!titles.includes('Senior Java Developer'), 'чужая должность видна');
    assert.match(await page.locator('#drawerBody .vc', { hasText: 'Backend Python Developer' }).first().textContent(), /Удалёнка · Новосибирск/);
    assert.match(await page.locator('#drawerBody .excl').textContent(), /Отсеяно по вашему профилю: \d+ .*другая должность/);
  });

  await step('источники: короткие имена, ссылка не вылезает, удаление работает', async () => {
    const row = page.locator('#drawerBody .src-row', { hasText: 'hh: капча' });
    const overflow = await row.evaluate((r) => [...r.querySelectorAll('*')].some((el) => el.getBoundingClientRect().right > r.getBoundingClientRect().right + 1));
    assert.ok(!overflow, 'что-то вылезает за строку источника');
    await row.locator('button', { hasText: 'Удалить' }).click();
    await until(async () => (await page.locator('#drawerBody .src-row', { hasText: 'hh: капча' }).count()) === 0, 5000, 'строка исчезла после удаления');
    assert.ok(!(await storage(page)).sources.some((x) => x.id === 'cap'));
  });

  await step('ссылка на одну вакансию в поле источника — подсказка про «пример»', async () => {
    await page.locator('.add-src input').first().fill('https://hh.ru/vacancy/12345');
    await page.locator('.add-src button[type=submit]').click();
    await page.locator('.add-src .muted', { hasText: 'Пример подходящей вакансии' }).waitFor();
    await page.keyboard.press('Escape');
  });

  await step('статус и заметка → «Мои отклики» и воронка', async () => {
    await page.evaluate(() => { location.hash = 'all'; });
    await page.waitForSelector('.drawer.open.dk-all .vc');
    const card = page.locator('#drawerBody .vc').first();
    const title = await card.locator('h3 a').textContent();
    await card.locator('select').selectOption('applied');
    await card.locator('button', { hasText: 'Заметка' }).click();
    await card.locator('textarea').fill('Написал рекрутеру');
    await card.locator('textarea').blur();
    await page.keyboard.press('Escape');
    await until(() => page.locator('#appliedTile .mini-title').allTextContents().then((t) => t.includes(title)), 5000, 'вакансия в «Мои отклики»');
    assert.match(await page.locator('#funnelTile li', { hasText: 'Отправил резюме' }).textContent(), /^1/);
  });

  await step('сайт компании: вакансия пропала со страницы два раза — исчезает из списка', async () => {
    flags.hide502 = true;
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => chrome.runtime.sendMessage({ type: 'runNow', sourceId: 'car' }));
      await waitIdle(page, 60000);
    }
    all = await storage(page);
    assert.ok(v(`generic:${base}/careers/jobs/data-engineer-502`)?.archived, '502 не помечена архивной');
    const titles = await page.evaluate(async () => {
      const store = await import('./lib/store.js');
      return (await store.getVacancies()).map((x) => x.title);
    });
    assert.ok(!titles.includes('Data Engineer'));
  });

  await step('повторное «Найти работу» с тем же лимитом не дёргает сайты', async () => {
    const n = hits.length;
    await page.locator('#findBtn').click();
    try {
      await page.locator('.toast.show', { hasText: 'уже проверены' }).waitFor({ timeout: 5000 });
    } catch (e) {
      const st = await storage(page);
      const info = st.sources.filter((x) => x.enabled).map((x) => [x.id, st[`srcstate:${x.id}`]?.lastStatus, st[`srcstate:${x.id}`]?.lastLimit, st[`srcstate:${x.id}`]?.lastRunAt]);
      throw new Error(`тост: «${await page.locator('.toast').textContent()}» ${JSON.stringify(info)}`);
    }
    assert.equal(hits.length, n);
  });

  await step('кнопка «Стоп» останавливает поиск, найденное сохраняется', async () => {
    await page.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, scanLimit: 1000 } });
    });
    await page.waitForTimeout(600);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'runNow' }));
    await until(() => page.locator('#stopBtn').isVisible(), 8000, 'кнопка «Стоп» появилась');
    const text = await page.locator('#findText').textContent();
    const oneLine = await page.locator('#findText').evaluate((el) => el.offsetHeight < parseFloat(getComputedStyle(el).fontSize) * 1.8 && getComputedStyle(el).whiteSpace === 'nowrap');
    assert.ok(oneLine, `текст прогресса в одну строку: ${text}`);
    await page.locator('#stopBtn').click();
    await waitIdle(page, 30000);
    await until(() => page.locator('#stopBtn').isHidden(), 5000, 'кнопка «Стоп» скрылась');
    const st = await storage(page);
    assert.ok(Object.keys(st).some((k) => k.startsWith('srcstate:') && st[k].lastStatus === 'stopped'), 'источник помечен «остановлено»');
    // После «Стоп» следующий поиск у каждого источника — не раньше его интервала.
    for (const s of st.sources.filter((x) => x.enabled)) {
      const next = Date.parse(st[`srcstate:${s.id}`]?.nextRunAt || 0);
      assert.ok(next > Date.now() + s.intervalMin * 60e3 * 0.8, `${s.name}: следующий поиск через интервал (${st[`srcstate:${s.id}`]?.nextRunAt})`);
    }
    await page.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, scanLimit: 100 } });
    });
  });

  await step('несколько профилей: новый — чистый, источники общие, статусы у каждого свои', async () => {
    const before = await storage(page);
    const srcCount = before.sources.length;
    await page.evaluate(() => { location.hash = 'profile'; });
    await page.waitForSelector('.drawer.open .profiles-bar');
    page.off('dialog', acceptAll);
    page.once('dialog', (dlg) => dlg.accept('Аналитик'));
    await page.locator('.profiles-bar button', { hasText: 'Новый профиль' }).click();
    await until(async () => (await storage(page)).profiles?.length === 2, 5000, 'второй профиль');
    page.on('dialog', acceptAll);
    const st = await storage(page);
    assert.equal(st.sources.length, srcCount, 'источники остались');
    assert.ok(!st.resume, 'резюме пустое');
    assert.equal(st.profile.position || '', '');
    await page.waitForSelector('.profiles-bar select');
    assert.equal(await d.locator('.field', { hasText: 'Желаемая должность' }).locator('input').inputValue(), '');
    await page.evaluate(() => { location.hash = ''; });
    await until(async () => (await page.locator('#appliedTile .mini-title').count()) === 0, 5000, 'в новом профиле нет откликов');
    // Обратно в первый профиль — отклик на месте.
    await page.evaluate(() => { location.hash = 'profile'; });
    await page.waitForSelector('.drawer.open .profiles-bar select');
    await page.locator('.profiles-bar select').selectOption('p1');
    await until(async () => (await storage(page)).activeProfile === 'p1', 5000, 'переключение в p1');
    await page.evaluate(() => { location.hash = ''; });
    await until(async () => (await page.locator('#appliedTile .mini-title').count()) === 1, 5000, 'отклик первого профиля вернулся');
    assert.equal((await storage(page)).profile.name, 'Иван');
  });

  await step('сбор с открытой вкладки (кнопка в меню расширения)', async () => {
    const tab = await context.newPage();
    await tab.goto(`${base}/careers`);
    await tab.bringToFront();
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
    const r = await page.evaluate((id) => chrome.runtime.sendMessage({ type: 'collectTab', tabId: id }), tabId);
    assert.equal(r.platform, 'generic');
    assert.ok(r.found >= 1, JSON.stringify(r));
    await tab.close();
    await page.bringToFront();
  });

  const shotsEarly = process.env.SCREENSHOT_DIR;
  if (shotsEarly) {
    fs.mkdirSync(shotsEarly, { recursive: true });
    await page.evaluate(() => { location.hash = 'hh'; });
    await page.waitForSelector('.drawer.open .vc');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(shotsEarly, 'drawer-hh.png') });
    await page.evaluate(() => { location.hash = ''; });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(shotsEarly, 'home.png') });
  }

  await step('«Поделиться»: архив расширения для другого человека', async () => {
    await page.evaluate(() => { location.hash = 'search'; });
    await page.waitForSelector('.drawer.open .danger-zone');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('button', { hasText: 'Скачать расширение для друга' }).click()]);
    assert.match(dl.suggestedFilename(), /^solk-job-\d+\.\d+\.\d+\.zip$/);
    const zipPath = await dl.path();
    const py = 'import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;n=z.namelist();print(len(n));print(json.loads(z.read("solk-job/manifest.json"))["name"])';
    const [count, name] = execFileSync('python3', ['-I', '-c', py, zipPath], { encoding: 'utf8' }).trim().split('\n');
    const expected = JSON.parse(fs.readFileSync(new URL('../../extension/files.json', import.meta.url), 'utf8')).length + 1;
    assert.equal(Number(count), expected, 'в архиве все файлы расширения');
    assert.equal(name, 'solk / job');
    const [src] = await Promise.all([page.waitForEvent('download'), page.locator('button', { hasText: 'Скачать мои источники' }).click()]);
    const shared = JSON.parse(fs.readFileSync(await src.path(), 'utf8'));
    assert.ok(Array.isArray(shared.solkJobSources) && shared.solkJobSources.length && shared.solkJobSources.every((x) => x.url && !('id' in x)));
  });

  await step('сброс статистики — только после двух подтверждений', async () => {
    await page.evaluate(() => { location.hash = 'search'; });
    await page.waitForSelector('.drawer.open .danger-zone');
    let asked = 0;
    const onDialog = (dlg) => { asked++; dlg.accept(); };
    page.off('dialog', acceptAll);
    page.on('dialog', onDialog);
    await page.locator('.danger-zone button').click();
    await until(async () => !Object.keys(await storage(page)).some((k) => k.startsWith('v:')), 5000, 'вакансии удалены');
    page.off('dialog', onDialog);
    page.on('dialog', acceptAll);
    assert.equal(asked, 2, 'два подтверждения');
    const st = await storage(page);
    assert.ok(st.sources.length && st.profiles.length === 2 && st.profile.name === 'Иван', 'источники и профили на месте');
    assert.ok(!st.runs && !Object.keys(st).some((k) => k.startsWith('u:') || k.startsWith('srcstate:')));
  });

  await step('на страницах нет ошибок JavaScript и мусорного текста', async () => {
    assert.deepEqual(pageErrors, []);
    for (const hash of ['', 'profile', 'hh', 'all', 'funnel', 'applied', 'search', 'telegram', 'generic', 'avito']) {
      await page.evaluate((x) => { location.hash = x; }, hash);
      await page.waitForTimeout(350);
      const text = await page.evaluate(() => document.body.innerText);
      assert.ok(!/\b(null|undefined|NaN)\b/.test(text), `«${hash}»: ${text.match(/.{0,40}\b(null|undefined|NaN)\b.{0,40}/)?.[0]}`);
    }
    await page.evaluate(() => { location.hash = ''; });
  });

  const shots = process.env.SCREENSHOT_DIR;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    const snap = async (hash, file, sel) => {
      await page.evaluate((x) => { location.hash = x; }, hash);
      if (sel) await page.waitForSelector(sel);
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(shots, file) });
    };
    await snap('profile', 'drawer-profile.png', '.drawer.open .pform');
    await page.evaluate(() => { document.querySelector('#drawerBody').scrollTop = 900; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, 'drawer-profile-2.png') });
    await page.setViewportSize({ width: 420, height: 900 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(shots, 'home-mobile.png'), fullPage: true });
    const pop = await context.newPage();
    await pop.setViewportSize({ width: 360, height: 400 });
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
