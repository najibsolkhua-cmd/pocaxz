// Фоновый обход источников. Открывает сохранённые страницы в вашем браузере
// (с вашими cookies и IP), внедряет extractors/page.js, забирает вакансии и
// складывает их в chrome.storage.local.

import * as store from './lib/store.js';
import { normalizeItem, dedupKey } from './lib/parse.js';
import { scoreAll } from './lib/match.js';
import { siteApiFor, readSiteApi } from './lib/sites.js';
import { sendToTelegram } from './lib/telegram.js';
import { dueReminders, pruneSent } from './lib/reminders.js';
import { flushAdStats } from './lib/adstats.js';
import { backupNow } from './lib/cloud.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const BLOCK_PAUSE_MIN = 6 * 60;

// ---------- Расписание ----------

async function setupAlarm() {
  const s = await store.getSettings();
  await chrome.alarms.clear('tick');
  chrome.alarms.create('tick', { periodInMinutes: Math.max(1, s.tickMinutes), delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await setupAlarm();
  // С версии 0.10 по умолчанию ничего не удаляем: прежнее «45 дней» было значением по умолчанию.
  if (reason === 'update') {
    const s = await store.getSettings();
    if (s.retentionDays === 45) await store.saveSettings({ ...s, retentionDays: 0 });
  }
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html#profile') });
  scheduleBadge();
});
chrome.runtime.onStartup.addListener(setupAlarm);
chrome.runtime.onStartup.addListener(() => { checkReminders().catch(() => {}); });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'tick') return;
  // Напоминания — всегда, даже если автопоиск выключен.
  checkReminders().catch(console.error);
  flushAdStats().catch(() => {});
  backupNow().catch(() => {}); // автокопия на Яндекс Диск, если подключён и пора
  tick().catch(console.error);
});

// Напоминания о следующем шаге: в браузере и в Telegram, каждое — один раз.
async function checkReminders() {
  const settings = await store.getSettings();
  if (settings.reminders === false) return;
  const { remindersSent } = await chrome.storage.local.get('remindersSent');
  const sent = pruneSent(remindersSent);
  const due = dueReminders(await store.getVacancies(), { sent });
  for (const r of due.slice(0, 5)) {
    notify(`rem:${r.id}`, `⏰ ${r.text}`, [r.title, r.company].filter(Boolean).join(' — '), r.url);
    await sendToTelegram(`⏰ ${r.text}`, [{ title: r.title, company: r.company, url: r.url }]).catch(() => {});
    sent[r.id] = new Date().toISOString();
  }
  await chrome.storage.local.set({ remindersSent: sent });
  return due.length;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) setupAlarm();
  if (Object.keys(changes).some((k) => k.startsWith('u:') || k === 'profile' || k === 'resume')) scheduleBadge();
});

// ---------- Обход ----------

let running = false;
let current = null;
// «Стоп»: прерываем обход и закрываем текущую вкладку.
let stopRequested = false;
let currentHandle = null;
// Промис, который выполняется в момент «Стоп»: им обрываются все ожидания обхода
// (загрузка вкладки, паузы между страницами и источниками, скрипт на странице).
let stopSignal = null;
let fireStop = () => {};
class Stopped extends Error { constructor() { super('остановлено'); } }
function armStop() { stopSignal = new Promise((r) => { fireStop = r; }); }
const abortable = (p) => (stopSignal ? Promise.race([p, stopSignal.then(() => { throw new Stopped(); })]) : p);
const nap = (ms) => (stopSignal ? Promise.race([sleep(ms), stopSignal]) : sleep(ms));
// Прогресс для главной: какие источники в очереди, какой обходится сейчас.
let progress = { total: 0, done: 0, current: null, queue: [], finishedAt: null };

// MV3 усыпляет service worker через 30 с без событий; во время обхода
// держим его живым лёгкими вызовами API.
function keepAlive() {
  const t = setInterval(() => chrome.runtime.getPlatformInfo(), 20e3);
  return () => clearInterval(t);
}

async function planDue(settings, { force = false, sourceId = null } = {}) {
  const now = Date.now();
  const sources = (await store.getSources()).filter((s) => (sourceId ? s.id === sourceId : s.enabled));
  const due = [];
  for (const s of sources) {
    const st = await store.getSrcState(s.id);
    if (sourceId) { due.push(s); continue; }
    if (force) {
      // «Найти работу» не дёргает источник, который только что обходили.
      // Если лимит увеличили — ищем заново, даже если недавно искали.
      const fresh = st.lastRunAt && now - Date.parse(st.lastRunAt) < settings.manualGapMin * 60e3
        && st.lastStatus !== 'failed' && (st.lastLimit || 0) >= settings.scanLimit;
      if (!fresh) due.push(s);
      continue;
    }
    // Новый источник автоматически не дёргаем: первый раз — по кнопке или через его интервал.
    if (!st.nextRunAt) { await store.setSrcState(s.id, { ...st, nextRunAt: new Date(now + s.intervalMin * 60e3).toISOString() }); continue; }
    if (Date.parse(st.nextRunAt) <= now) due.push(s);
  }
  return due;
}

// Вызывающий код уже выставил running = true.
async function runQueue(due, settings) {
  const stop = keepAlive();
  armStop();
  try {
    const all = await store.getAll();
    const per = due.length === 1 ? settings.scanLimit : store.budgetPlan(due.length, settings.scanLimit).per;
    progress = {
      total: due.length, done: 0, current: null, finishedAt: null,
      queue: due.map((s) => ({ id: s.id, platform: s.platform, name: s.name, est: estimateSec(s, per, settings, all[`srcstate:${s.id}`] || {}) })),
      pauseSec: (settings.pauseBetweenSources[0] + settings.pauseBetweenSources[1]) / 2000,
    };
    let remaining = Number(settings.scanLimit) || 100;
    for (let i = 0; i < due.length; i++) {
      if (stopRequested) break;
      if (i > 0) await nap(rand(...settings.pauseBetweenSources));
      if (stopRequested) break;
      current = due[i].name;
      progress.current = progress.queue.shift();
      progress.currentStart = Date.now();
      progress.found = 0;
      progress.page = 0;
      progress.detail = 0;
      // Лимит на весь поиск делим между источниками; что не добрал один — достаётся следующим.
      const quota = due.length === 1 ? settings.scanLimit : store.shareFor(remaining, due.length - i, settings.scanLimit);
      progress.quota = quota;
      const r = await runSource(due[i], settings, quota);
      remaining -= r?.fresh || 0;
      progress.done++;
    }
    if (!stopRequested) await cleanup(settings);
    // После поиска — свежая копия на Яндекс Диск (если подключён; не чаще autoHours).
    if (!stopRequested) backupNow().catch(() => {});
  } finally {
    running = false;
    current = null;
    progress = { ...progress, current: null, queue: [], finishedAt: new Date().toISOString(), stopped: stopRequested };
    // После «Стоп» автопоиск не продолжается через 5 минут: каждый источник ждёт свой интервал.
    if (stopRequested) await rescheduleAll().catch(console.error);
    stopRequested = false;
    stopSignal = null;
    currentHandle = null;
    stop();
  }
}

// Плановый обход по будильнику.
async function tick() {
  if (running) return;
  running = true;
  try {
    const settings = await store.getSettings();
    // Автопоиск включается только после первого поиска вручную: при первом заходе
    // профиль ещё не заполнен, и искать «наугад» не нужно.
    const { autoArmed, runs } = await chrome.storage.local.get(['autoArmed', 'runs']);
    const armed = autoArmed ?? Boolean(runs?.length);
    const skip = !armed || !settings.autoRun || (settings.skipWhenLocked && (await chrome.idle.queryState(60)) === 'locked');
    const due = skip ? [] : await planDue(settings);
    if (!due.length) { running = false; return; }
    await runQueue(due, settings);
  } catch (e) {
    running = false;
    throw e;
  }
}

// Ручной запуск: кнопка «Найти работу» или «Искать» у источника.
async function startManual(sourceId) {
  // Только что нажали «Стоп» — обход доделывает запись найденного, это доли секунды.
  for (let i = 0; i < 100 && running && stopRequested; i++) await sleep(100);
  if (running) return { busy: true, current };
  running = true;
  try {
    const settings = await store.getSettings();
    await chrome.storage.local.set({ autoArmed: true });
    const due = await planDue(settings, { force: true, sourceId });
    if (!due.length) { running = false; return { started: false, total: 0 }; }
    runQueue(due, settings).catch(console.error);
    const plan = store.budgetPlan(due.length, settings.scanLimit);
    return { started: true, total: due.length, per: due.length === 1 ? settings.scanLimit : plan.per, deep: due.length > 1 && plan.deep, etaSec: progress.total ? etaSec() : null };
  } catch (e) {
    running = false;
    throw e;
  }
}

function waitTabComplete(tabId, timeout = 45e3) {
  return abortable(new Promise((resolve, reject) => {
    const timer = setTimeout(() => { done(); reject(new Error('страница не загрузилась за 45 с')); }, timeout);
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') { done(); resolve(); } };
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') { done(); resolve(); } }).catch(() => {});
  }));
}

async function openHidden(url, mode) {
  if (mode === 'tab') {
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      return { tabId: tab.id, close: () => chrome.tabs.remove(tab.id).catch(() => {}) };
    } catch { /* нет открытых окон — откроем отдельное */ }
  }
  const win = await chrome.windows.create({ url, focused: false, state: 'minimized' });
  return { tabId: win.tabs[0].id, close: () => chrome.windows.remove(win.id).catch(() => {}) };
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['extractors/page.js'] });
}

async function callInTab(tabId, method, cfg) {
  await abortable(inject(tabId));
  const [r] = await abortable(chrome.scripting.executeScript({
    target: { tabId },
    func: (m, c) => globalThis.__jobRadar[m](c),
    args: [method, cfg],
  }));
  return r?.result;
}

const extractInTab = async (tabId, cfg) => (await callInTab(tabId, 'extract', cfg)) || { items: [], error: 'пустой ответ экстрактора' };

// Паузы между страницами выдачи и между карточками — как у человека.
const PAGE_DELAY = { hh: [2500, 5000], avito: [4000, 8000], telegram: [1500, 3000], generic: [2000, 4000] };
const DETAIL_DELAY = { hh: [2500, 6000], avito: [5000, 10000], generic: [2500, 5000], telegram: [2000, 4000] };
const DETAIL_CAP = { hh: 50, avito: 10, generic: 20, telegram: 0 };
const RECHECK_PER_RUN = { hh: 6, avito: 4, generic: 0, telegram: 0 };
const MAX_PAGES = 100;

// ---------- Сколько ждать ----------
// Оценка времени на источник: открытие, страницы выдачи, описания, проверка архива.
// Если источник уже обходили, учитываем, сколько это заняло в прошлый раз.
const EST = { hh: { open: 9, page: 8, detail: 5 }, avito: { open: 11, page: 11, detail: 8.5 }, telegram: { open: 7, page: 5, detail: 0 }, generic: { open: 12, page: 7, detail: 6 } };
const PER_PAGE = { hh: 40, avito: 50, telegram: 20, generic: 30 };
function estimateSec(src, quota, settings, st) {
  const e = EST[src.platform] || EST.generic;
  // Повторный поиск берёт только новые — их обычно столько же, сколько было в прошлый раз.
  const expectNew = st.lastRunAt ? Math.min(quota, Math.max(st.lastFresh ?? quota, 5)) : quota;
  const pages = Math.max(1, Math.min(MAX_PAGES, Math.ceil(expectNew / PER_PAGE[src.platform])));
  const details = Math.min(Number(settings.deepCheck) || 20, DETAIL_CAP[src.platform] || 0, expectNew);
  let t = e.open + pages * e.page + details * e.detail + (RECHECK_PER_RUN[src.platform] || 0) * e.detail * 0.6 + (store.autoFillOn(src) ? 8 : 0);
  if (st.lastMs && ['ok', 'empty', 'partial'].includes(st.lastStatus)) t = 0.5 * t + 0.5 * (st.lastMs / 1000);
  return Math.round(t);
}
function etaSec() {
  if (!progress.total) return null;
  const cur = progress.current ? Math.max(5, (progress.current.est || 30) - (Date.now() - (progress.currentStart || Date.now())) / 1000) : 0;
  const rest = progress.queue.reduce((n, q) => n + (q.est || 30), 0);
  return Math.round(cur + rest + progress.queue.length * (progress.pauseSec || 0));
}

// Переход вкладки на новый адрес: ждём сначала начала загрузки, потом её конца —
// иначе можно прочитать старую страницу, у которой статус ещё «complete».
function navigate(tabId, url, timeout = 45e3) {
  return abortable(new Promise((resolve, reject) => {
    let started = false;
    const timer = setTimeout(() => { done(); reject(new Error('страница не загрузилась за 45 с')); }, timeout);
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') started = true;
      if (info.status === 'complete' && started) { done(); setTimeout(resolve, rand(1200, 2500)); }
    };
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch((e) => { done(); reject(e); });
  }));
}

// Подробности: для hh и Avito — запросом с той же вкладки, для сайтов компаний —
// переходом на страницу (там часто всё рисует JavaScript).
async function fetchDetails(tabId, platform, list, mode = 'tab') {
  if (!list.length) return { results: {}, blocked: null };
  if (mode === 'fetch') {
    const results = {};
    for (const it of list) {
      if (stopRequested) break;
      const r = await viaOffscreen('detail', it.url).catch((e) => ({ fail: String(e?.message || e) }));
      results[it.externalId] = r.fail ? { error: r.fail } : r;
      await nap(rand(...DETAIL_DELAY.generic));
    }
    return { results, blocked: null };
  }
  if (platform !== 'generic') {
    // Порциями по 3, чтобы «Стоп» срабатывал быстро.
    const results = {};
    for (let i = 0; i < list.length && !stopRequested; i += 3) {
      const r = (await callInTab(tabId, 'details', { platform, items: list.slice(i, i + 3), delay: DETAIL_DELAY[platform] })) || { results: {} };
      Object.assign(results, r.results);
      if (r.blocked) return { results, blocked: r.blocked };
    }
    return { results, blocked: null };
  }
  const results = {};
  for (const it of list) {
    if (stopRequested) break;
    try {
      await navigate(tabId, it.url);
      results[it.externalId] = await callInTab(tabId, 'current', { platform, waitMs: 1500 });
    } catch (e) {
      results[it.externalId] = { error: String(e?.message || e) };
    }
    await nap(rand(...DETAIL_DELAY.generic));
  }
  return { results, blocked: null };
}

// Есть ли у расширения доступ к сайту. В Яндекс Браузере и Chrome пользователь может
// ограничить доступ «по клику» — тогда сайты не читаются, пока не нажать «Разрешить».
async function hasAccess(url) {
  try { return await chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] }); } catch { return false; }
}
const NO_ACCESS = (url) => `Нет доступа к сайту ${new URL(url).hostname}. На главной нажмите «Разрешить доступ» (или в настройках расширения: «Доступ к сайтам» → «На всех сайтах»).`;

const isPermError = (e) => /must request permission|Cannot access contents|cannot be scripted|extensions gallery/i.test(String(e?.message || e));

// Режим «без вкладки». Яндекс Браузер включает защищённый режим на сайтах банков
// (tbank.ru, rabota.sber.ru…) и не пускает туда расширения — такие страницы скачиваем
// запросом и разбираем в скрытом документе расширения.
let offscreenCreating = null;
async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('браузер не умеет читать страницы без вкладки');
  if (await chrome.offscreen.hasDocument?.()) return;
  offscreenCreating ||= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Разбор страниц с вакансиями, закрытых для вкладок расширения',
  }).catch((e) => { if (!/single offscreen/i.test(e.message)) throw e; }).finally(() => { offscreenCreating = null; });
  await offscreenCreating;
}
async function viaOffscreen(type, url, cfg = {}) {
  await abortable(ensureOffscreen());
  return (await abortable(chrome.runtime.sendMessage({ target: 'offscreen', type, url, cfg }))) || { fail: 'пустой ответ' };
}

// API сайта: POST с JSON, с куками сайта (у расширения есть доступ к нему).
async function fromSiteApi(api, pageUrl) {
  const key = `siteApi:${api.id}`;
  const known = (await chrome.storage.local.get(key))[key];
  const fetchJson = async (endpoint, body) => {
    const r = await fetch(endpoint, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    return r.ok ? r.json() : null;
  };
  const r = await abortable(readSiteApi(api, pageUrl, fetchJson, known)).catch((e) => { if (e instanceof Stopped) throw e; return null; });
  if (r && r.variant !== known) await chrome.storage.local.set({ [key]: r.variant });
  return r;
}

// После «Найти» на сайте: ждём перехода на страницу результатов (или перерисовки списка).
function settleAfterSubmit(tabId) {
  return abortable(new Promise((resolve) => {
    let started = false;
    let done = false;
    const timers = [];
    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(resolve, rand(1800, 2800));
    };
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') started = true;
      if (info.status === 'complete' && started) finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    timers.push(setTimeout(() => { if (!started) finish(); }, 5000), setTimeout(finish, 45e3));
  }));
}

async function runSource(src, settings, quota = settings.scanLimit) {
  const started = new Date();
  const st = await store.getSrcState(src.id);
  const profile = await store.getProfile();
  // Должность и город из профиля — в ссылку (если там есть параметр поиска) или в поля сайта.
  const fill = store.autoFillOn(src) && profile.position ? { query: store.searchQueryFor(profile), city: (profile.cities || [])[0] || '' } : null;
  const startUrl = (fill && store.retargetGenericUrl(src.url, profile)) || src.url;
  if (startUrl !== src.url) {
    const list = await store.getSources();
    await store.saveSources(list.map((x) => (x.id === src.id ? { ...x, url: startUrl, name: store.sourceName(startUrl, x.platform) } : x)));
  }
  if (!(await hasAccess(startUrl))) {
    await store.setSrcState(src.id, { ...st, lastRunAt: started.toISOString(), nextRunAt: new Date(Date.now() + src.intervalMin * 60e3).toISOString(), lastStatus: 'failed', lastError: NO_ACCESS(startUrl), lastErrorKind: 'access', failures: (st.failures || 0) + 1 });
    await store.addRun({ at: started.toISOString(), source: src.name, sourceId: src.id, platform: src.platform, status: 'failed', found: 0, added: 0, error: NO_ACCESS(startUrl), ms: 0 });
    return { status: 'failed', found: 0, added: 0, fresh: 0 };
  }
  quota = Math.max(1, Math.min(Number(quota) || 100, 5000));
  const before0 = await store.getAll();
  const isKnown = (it) => Boolean(before0[`v:${src.platform}:${String(it.externalId)}`]);
  const collected = new Map();
  let fresh = 0; // новых для нас вакансий — только они расходуют лимит
  let total = null;
  let blocked = null;
  let error = null;
  let pages = 0;
  let stats = { found: 0, added: 0, updated: 0 };
  let detailed = 0;
  let archived = 0;
  let handle = null;
  let mode = src.platform === 'generic' && (src.cfg?.fetchMode || st.mode === 'fetch') ? 'fetch' : 'tab';
  let guarded = false; // браузер не пустил расширение на страницу (защищённый режим)
  let errorKind = null; // для справки «Что делать?» у источника: access | download | error
  // Что подставили из профиля — показываем у источника, чтобы можно было проверить.
  let fillInfo = startUrl !== src.url ? { query: fill.query, via: 'ссылка' } : null;
  try {
    let url = startUrl;
    if (mode === 'tab') {
      handle = await openHidden(url, settings.openIn);
      currentHandle = handle;
      await waitTabComplete(handle.tabId);
      await nap(rand(1500, 3000));
      if (fill && !stopRequested) {
        try {
          const r = await callInTab(handle.tabId, 'fillSearch', { ...fill, waitMs: 600 });
          if (r?.query || r?.city) {
            fillInfo = { query: r.query || fillInfo?.query || null, city: r.city || null, via: 'поля сайта' };
            if (r.submitted) await settleAfterSubmit(handle.tabId);
            url = (await chrome.tabs.get(handle.tabId).catch(() => null))?.url || url;
          }
        } catch (e) {
          if (!isPermError(e)) throw e;
          mode = 'fetch';
          guarded = true;
        }
      }
    }

    // 1. Страницы выдачи — пока не наберём свою долю новых вакансий или выдача не кончится.
    for (;;) {
      const cfg = { platform: src.platform, ...src.cfg, limit: Math.max(1, quota - fresh) + (collected.size - fresh), pageNo: pages };
      let res = null;
      if (mode === 'tab') {
        try {
          res = await extractInTab(handle.tabId, cfg);
          // Первая страница пустая и без капчи — чаще всего сайт не успел догрузиться.
          if (!res.items?.length && !res.blocked && !stopRequested && pages === 0) {
            await nap(rand(2500, 4500));
            try {
              res = await extractInTab(handle.tabId, { ...cfg, waitMs: 4000 });
              // Поиск сайта по должности ничего не дал (у сайта строгий поиск) — берём исходный список.
              if (!res.items?.length && fillInfo?.via === 'поля сайта') {
                await navigate(handle.tabId, startUrl);
                url = startUrl;
                res = await extractInTab(handle.tabId, { ...cfg, waitMs: 2500 });
                fillInfo = { ...fillInfo, note: 'поиск сайта по должности ничего не нашёл — проверен весь список' };
              } else if (!res.items?.length) {
                await navigate(handle.tabId, url);
                res = await extractInTab(handle.tabId, { ...cfg, waitMs: 5000 });
              }
            } catch { /* оставляем первый результат */ }
          }
        } catch (e) {
          if (!isPermError(e) || src.platform !== 'generic') throw e;
          mode = 'fetch';
          guarded = true;
        }
      }
      // Сайт рисует список скриптом из своего API (например, T-Банк) — берём вакансии из API:
      // в «Защищённом режиме» сразу, во вкладке — если на странице ничего не нашлось.
      const api = pages === 0 && src.platform === 'generic' ? siteApiFor(url, src.cfg) : null;
      if (api && (mode === 'fetch' || !res?.items?.length)) {
        const r = await fromSiteApi(api, url);
        if (r?.items.length) {
          if (handle) { handle.close(); handle = null; currentHandle = null; }
          res = { items: r.items, total: r.total, nextUrl: null };
          mode = 'fetch';
          fillInfo = { query: null, city: null, via: 'API сайта' };
        }
      }
      if (mode === 'fetch' && !res?.items?.length) {
        if (handle) { handle.close(); handle = null; currentHandle = null; }
        res = await viaOffscreen('parse', url, cfg);
        if (res.fail) { error = `не удалось скачать страницу: ${res.fail}`; errorKind = 'download'; break; }
      }
      pages++;
      if (pages === 1) total = res.total;
      if (res.error && !res.items?.length) error = res.error;
      if (res.blocked) { blocked = res.reason; break; }
      const before = collected.size;
      let newOnPage = 0;
      for (const it of res.items || []) {
        if (collected.has(it.externalId)) continue;
        const known = isKnown(it);
        if (!known && fresh >= quota) continue;
        collected.set(it.externalId, it);
        if (!known) { fresh++; newOnPage++; }
      }
      progress.found = collected.size;
      progress.page = pages;
      // Повторный поиск: если на странице только уже известные вакансии, дальше — старые.
      if (stopRequested || fresh >= quota || collected.size === before || !newOnPage || !res.nextUrl || pages >= MAX_PAGES) break;
      url = res.nextUrl;
      await nap(rand(...PAGE_DELAY[src.platform]));
      if (mode === 'tab') {
        try { await navigate(handle.tabId, url); } catch {
          // Сеть моргнула — ещё одна попытка, потом сдаёмся и сохраняем собранное.
          await nap(rand(3000, 6000));
          try { await navigate(handle.tabId, url); } catch (e) { error = String(e?.message || e); errorKind = 'download'; break; }
        }
      }
    }

    const items = [...collected.values()];
    stats = await ingest(items, src.platform, src);

    // 2. Подробное описание — только для лучших новых вакансий, чтобы не ждать часами.
    if (!blocked && !stopRequested && DETAIL_CAP[src.platform]) {
      const want = Math.min(Number(settings.deepCheck) || 20, DETAIL_CAP[src.platform]);
      const cand = await pickForDetails(items, src.platform, settings, want);
      if (cand.length) {
        progress.detail = cand.length;
        const d = await fetchDetails(handle?.tabId, src.platform, cand.map((c) => ({ externalId: c.externalId, url: c.url })), mode);
        const enriched = [];
        for (const c of cand) {
          const r = d.results[c.externalId];
          if (!r || r.error) continue;
          if (r.archived) { await markArchived(src.platform, c.externalId); archived++; continue; }
          enriched.push({ ...collected.get(c.externalId), ...r });
        }
        if (enriched.length) await ingest(enriched, src.platform, src, { quiet: true });
        detailed = enriched.length;
        if (d.blocked) blocked = d.blocked;
      }
    }

    // 3. Давно не встречавшиеся вакансии из вашего списка — не ушли ли в архив.
    if (!blocked && !stopRequested && mode === 'tab' && RECHECK_PER_RUN[src.platform]) {
      const stale = await pickForRecheck(src.platform, new Set(collected.keys()), settings);
      if (stale.length) {
        const d = await fetchDetails(handle.tabId, src.platform, stale);
        const patch = {};
        const all = await store.getAll();
        for (const it of stale) {
          const r = d.results[it.externalId];
          const k = `v:${src.platform}:${it.externalId}`;
          if (!all[k] || !r || r.error) continue;
          patch[k] = { ...all[k], lastCheckedAt: new Date().toISOString(), ...(r.archived ? { archived: true, archivedAt: new Date().toISOString() } : {}) };
          if (r.archived) archived++;
        }
        if (Object.keys(patch).length) await chrome.storage.local.set(patch);
      }
    }

    // Сайт компании показывает весь список: если вакансии нет два обхода подряд — её сняли.
    if (src.platform === 'generic' && !blocked && !error && !stopRequested && collected.size && fresh < quota && pages === 1) {
      archived += await archiveMissing(src, new Set(collected.keys()));
    }
  } catch (e) {
    // Вкладку закрыли по кнопке «Стоп» — это не ошибка.
    if (!stopRequested) {
      error = String(e?.message || e);
      if (isPermError(error)) {
        const tab = handle ? await chrome.tabs.get(handle.tabId).catch(() => null) : null;
        const at = tab?.url || startUrl;
        const reachable = /^https?:/i.test(at) && (await hasAccess(at));
        errorKind = reachable ? 'download' : 'access';
        error = reachable
          ? `Страница ${new URL(startUrl).hostname} не открылась или ушла на другой адрес. Откройте ссылку вручную: если сайт работает, повторите поиск.`
          : NO_ACCESS(/^https?:/i.test(at) ? at : startUrl);
      }
    }
  } finally {
    handle?.close();
  }
  // Найденное до остановки сохраняем.
  if (stopRequested && collected.size && !stats.found) {
    try { stats = await ingest([...collected.values()], src.platform, src); } catch { /* ignore */ }
  }

  if (guarded && !collected.size && !stopRequested) {
    error = `Яндекс Браузер открывает ${new URL(startUrl).hostname} в «Защищённом режиме» и не пускает туда расширения. Выключите его: ☰ → Настройки → Безопасность → «Защита от угроз» → снимите галочку «Открывать страницы онлайн-банков и платёжных систем в защищённом режиме», затем нажмите «Искать». Подробнее — «Что делать?» ниже.`;
    errorKind = 'guarded';
  }
  const failures = blocked || (error && !collected.size) ? (st.failures || 0) + 1 : 0;
  let status = 'ok';
  let waitMin = src.intervalMin * rand(0.85, 1.15);
  if (blocked) {
    status = collected.size ? 'partial' : 'blocked';
    waitMin = Math.max(BLOCK_PAUSE_MIN, src.intervalMin * 2 ** failures);
    notify(`blocked:${src.id}`, `«${src.name}» просит проверку`,
      'Откройте страницу и пройдите проверку вручную. Источник приостановлен на 6 часов, найденное сохранено.', src.url);
  } else if (failures) {
    status = 'failed';
    waitMin = Math.min(24 * 60, src.intervalMin * 2 ** Math.min(failures, 5));
  } else if (stopRequested) {
    status = 'stopped';
    waitMin = src.intervalMin;
  } else if (!collected.size) {
    status = 'empty';
  }

  const note = [blocked || error, archived ? `в архиве: ${archived}` : null].filter(Boolean).join(' · ') || null;
  await store.setSrcState(src.id, {
    lastRunAt: started.toISOString(),
    nextRunAt: new Date(Date.now() + waitMin * 60e3).toISOString(),
    lastStatus: status,
    lastError: note,
    lastErrorKind: blocked ? 'blocked' : error && !collected.size ? (errorKind || 'error') : null,
    lastTotal: total,
    lastFound: collected.size,
    lastAdded: stats.added,
    lastFresh: fresh,
    lastQuota: quota,
    lastDetailed: detailed,
    lastPages: pages,
    lastLimit: settings.scanLimit,
    lastMs: Date.now() - started.getTime(),
    mode: mode === 'fetch' && collected.size ? 'fetch' : null,
    filled: fillInfo || st.filled || null,
    failures,
  });
  await store.addRun({
    at: started.toISOString(),
    source: src.name,
    sourceId: src.id,
    platform: src.platform,
    status,
    total,
    found: collected.size,
    added: stats.added,
    pages,
    error: note,
    ms: Date.now() - started.getTime(),
  });
  return { status, ...stats, fresh };
}

const rescheduleAll = () => store.rescheduleAll();

async function markArchived(platform, externalId) {
  const k = `v:${platform}:${externalId}`;
  const cur = (await chrome.storage.local.get(k))[k];
  if (cur) await chrome.storage.local.set({ [k]: { ...cur, archived: true, archivedAt: new Date().toISOString() } });
}

// Кандидаты на подробную проверку: ещё без описания, лучшие по предварительной оценке.
async function pickForDetails(items, platform, settings, want) {
  if (!want) return [];
  const ids = new Set(items.map((i) => String(i.externalId)));
  const rows = (await scored()).filter(({ v }) => v.platform === platform && ids.has(v.externalId) && !v.enriched && !v.archived);
  const floor = settings.matchScore * 0.6;
  return rows.filter(({ s }) => s.score >= floor).sort((a, b) => b.s.score - a.s.score).slice(0, want).map(({ v }) => v);
}

// Вакансии из вашего списка, которых не было в этой выдаче и которые давно не проверяли.
async function pickForRecheck(platform, seenIds, settings) {
  const dayAgo = Date.now() - 86400e3;
  const rows = (await scored()).filter(({ v, s }) => v.platform === platform && !v.archived && !seenIds.has(v.externalId)
    && (s.score >= settings.matchScore || ['applied', 'interview'].includes(v.status))
    && !['hidden', 'rejected'].includes(v.status)
    && Date.parse(v.lastCheckedAt || v.lastSeenAt || 0) < dayAgo);
  return rows.sort((a, b) => b.s.score - a.s.score).slice(0, RECHECK_PER_RUN[platform]).map(({ v }) => ({ externalId: v.externalId, url: v.url }));
}

async function archiveMissing(src, seenIds) {
  const all = await store.getAll();
  const patch = {};
  let n = 0;
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('v:generic:') || v.archived || !(v.sources || []).includes(src.name) || seenIds.has(v.externalId)) continue;
    const missed = (v.missedRuns || 0) + 1;
    patch[k] = { ...v, missedRuns: missed, ...(missed >= 2 ? { archived: true, archivedAt: new Date().toISOString() } : {}) };
    if (missed >= 2) n++;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  return n;
}

// ---------- Сохранение ----------

const HH_LINK_RE = /hh\.ru\/vacancy\/(\d+)/;

async function ingest(items, platform, src, { quiet = false } = {}) {
  const sourceName = typeof src === 'string' ? src : src.name;
  const now = new Date();
  const nowIso = now.toISOString();
  const all = await store.getAll();
  const settings = await store.getSettings();

  const byDedup = new Map();
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('v:')) continue;
    const d = dedupKey(v.company, v.title);
    if (d) byDedup.set(d, k);
  }

  const write = {};
  const get = (k) => write[k] || all[k];
  const addAlso = (k, n) => {
    const v = { ...get(k) };
    const also = v.alsoAt || [];
    if (!also.some((a) => a.url === n.url) && v.url !== n.url) also.push({ platform: n.platform, url: n.url, source: sourceName });
    write[k] = { ...v, alsoAt: also, lastSeenAt: nowIso };
  };

  let added = 0;
  let updated = 0;
  const fresh = [];
  for (const it of items) {
    const n = normalizeItem(it, platform, now);
    if (!n) continue;
    const key = `v:${platform}:${n.externalId}`;
    const ex = get(key);

    if (ex) {
      const merged = { ...ex, lastSeenAt: nowIso, missedRuns: 0, sources: [...new Set([...(ex.sources || []), sourceName])] };
      // Не затираем подробное описание кратким текстом из выдачи.
      for (const [f, val] of Object.entries(n)) {
        if (val == null || val === '' || (Array.isArray(val) && !val.length)) continue;
        if (ex.enriched && !n.enriched && ['description', 'skills', 'skillsOptional', 'grades', 'formats', 'company', 'salary'].includes(f)) continue;
        merged[f] = val;
      }
      merged.enriched = ex.enriched || n.enriched;
      write[key] = merged;
      updated++;
      continue;
    }

    // Пост в Telegram со ссылкой на уже известную вакансию hh — это дубль.
    const hhLink = n.links.map((l) => l.match(HH_LINK_RE)?.[1]).find(Boolean);
    if (hhLink && get(`v:hh:${hhLink}`)) { addAlso(`v:hh:${hhLink}`, n); continue; }
    const d = dedupKey(n.company, n.title);
    if (d && byDedup.has(d)) { addAlso(byDedup.get(d), n); continue; }

    const v = { key, ...n, firstSeenAt: nowIso, lastSeenAt: nowIso, sources: [sourceName], alsoAt: [] };
    write[key] = v;
    if (d) byDedup.set(d, key);
    added++;
    fresh.push(key);
  }

  if (Object.keys(write).length) await chrome.storage.local.set(write);
  if (fresh.length && !quiet) await notifyFresh(new Set(fresh), settings);
  scheduleBadge();
  return { found: items.length, added, updated };
}

async function scored() {
  const [vs, profile, resume] = await Promise.all([store.getVacancies(), store.getProfile(), store.getResume()]);
  return scoreAll(vs, profile, resume?.text || '');
}

async function notifyFresh(keys, settings) {
  const fresh = (await scored()).filter(({ v, s }) => keys.has(v.key) && s.score >= settings.notifyScore)
    .map(({ v, s }) => ({ v, score: s.score }));
  if (fresh.length) {
    fresh.sort((a, b) => b.score - a.score);
    notify(`new:${Date.now()}`, `Новых подходящих вакансий: ${fresh.length}`,
      fresh.slice(0, 3).map((f) => `${Math.round(f.score * 100)}% · ${f.v.title}${f.v.company ? ` — ${f.v.company}` : ''}`).join('\n'));
    // И в Telegram, если подключён бот.
    await sendToTelegram(`Новых подходящих вакансий: ${fresh.length}`,
      fresh.map(({ v, score }) => ({ title: v.title, company: v.company || '', score: Math.round(score * 100), url: v.url })))
      .catch((e) => console.warn('telegram', e));
  }
}

// Автоудаление — только если вы сами включили его в настройках («Удалять нетронутые через N дней»).
// По умолчанию ничего не удаляется: всё найденное и просмотренное хранится, пока вы не удалите сами.
async function cleanup(settings) {
  if (!(Number(settings.retentionDays) > 0)) return;
  const all = await store.getAll();
  const limit = Date.now() - settings.retentionDays * 86400e3;
  const remove = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('v:')) continue;
    // Не удаляем вакансию, если хоть в одном профиле вы с ней работали.
    const pids = (all.profiles || [{ id: 'p1' }]).map((x) => x.id);
    const kept = pids.some((pid) => { const u = all[store.uKeyFor(k, pid)]; return u && !['new', 'viewed', 'hidden'].includes(u.status); });
    const t = Date.parse(v.publishedAt || v.firstSeenAt);
    const archivedLongAgo = v.archived && Date.parse(v.archivedAt || 0) < Date.now() - 2 * 86400e3;
    if (!kept && (t < limit || archivedLongAgo)) remove.push(k, ...pids.map((pid) => store.uKeyFor(k, pid)));
  }
  if (remove.length) await chrome.storage.local.remove(remove);
}

// ---------- Уведомления и бейдж ----------

const notifyUrls = new Map();
function notify(id, title, message, url) {
  if (url) notifyUrls.set(id, url);
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 1 });
}
chrome.notifications.onClicked.addListener((id) => {
  chrome.tabs.create({ url: notifyUrls.get(id) || chrome.runtime.getURL('dashboard.html') });
  chrome.notifications.clear(id);
});

let badgeTimer = null;
function scheduleBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(updateBadge, 500);
}
async function updateBadge() {
  const settings = await store.getSettings();
  const n = (await scored()).filter(({ v, s }) => v.status === 'new' && s.score >= settings.matchScore).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#b81400' });
  await chrome.action.setBadgeText({ text: n ? String(n > 999 ? '999+' : n) : '' });
}

// ---------- Сообщения от popup и CRM ----------

// Кнопка «Собрать с этой вкладки»: текущая страница + описания лучших.
async function collectFromTab(tabId) {
  const settings = await store.getSettings();
  const tab = await chrome.tabs.get(tabId);
  const host = new URL(tab.url).hostname;
  // Сайт закрыт для расширений во вкладке (защищённый режим) — читаем его без вкладки.
  const res = await extractInTab(tabId, { platform: 'auto', limit: 1000 }).catch(async (e) => {
    if (!isPermError(e)) throw e;
    const r = await viaOffscreen('parse', tab.url, { limit: 1000 });
    if (r.fail) throw new Error(r.fail);
    return r;
  });
  const src = `Вручную: ${host}`;
  const stats = await ingest(res.items || [], res.platform, src);
  let detailed = 0;
  if (!res.blocked && res.platform !== 'telegram') {
    const cand = await pickForDetails(res.items || [], res.platform, settings, Math.min(settings.manualEnrichMax, DETAIL_CAP[res.platform] || 0));
    if (cand.length && res.platform !== 'generic') {
      const d = await callInTab(tabId, 'details', { platform: res.platform, items: cand.map((c) => ({ externalId: c.externalId, url: c.url })), delay: [2000, 4500] });
      const byId = new Map((res.items || []).map((i) => [String(i.externalId), i]));
      const enriched = cand.map((c) => d?.results?.[c.externalId] && !d.results[c.externalId].error && !d.results[c.externalId].archived
        ? { ...byId.get(c.externalId), ...d.results[c.externalId] } : null).filter(Boolean);
      if (enriched.length) await ingest(enriched, res.platform, src, { quiet: true });
      detailed = enriched.length;
    }
  }
  await store.addRun({ at: new Date().toISOString(), source: `Вручную: ${tab.title}`, platform: res.platform, status: res.blocked ? 'blocked' : 'ok', total: res.total, found: stats.found, added: stats.added, error: res.reason || res.error || null, ms: 0 });
  return { ...stats, detailed, total: res.total, platform: res.platform, blocked: res.blocked, reason: res.reason, error: res.error };
}

// Пример подходящей вакансии для профиля: открываем ссылку и читаем её текст.
async function inspectUrl(url) {
  const settings = await store.getSettings();
  const handle = await openHidden(url, settings.openIn);
  try {
    await waitTabComplete(handle.tabId);
    const platform = store.detectPlatformByUrl(url);
    const r = await callInTab(handle.tabId, 'current', { platform: platform === 'telegram' ? 'generic' : platform, waitMs: 2500 });
    if (!r) throw new Error('страница не прочиталась');
    if (r.archived) return { error: 'Эта вакансия уже в архиве' };
    const title = r.title || r.pageTitle || '';
    const text = [r.description, (r.tags || []).join(', ')].filter(Boolean).join('\n').slice(0, 6000);
    if (!title && text.length < 50) throw new Error('на странице не нашлось текста вакансии');
    return { url, title, company: r.company || '', text };
  } finally {
    handle.close();
  }
}

const handlers = {
  runNow: ({ sourceId }) => startManual(sourceId),
  async stop() {
    if (!running) return { running: false };
    stopRequested = true;
    fireStop();
    currentHandle?.close();
    // Главная сразу возвращается в исходное состояние; найденное допишется в фоне.
    progress = { total: 0, done: 0, current: null, queue: [], finishedAt: new Date().toISOString(), stopped: true };
    return { stopping: true };
  },
  status: async () => ({
    running: running && !stopRequested,
    stopping: running && stopRequested,
    current: stopRequested ? null : current,
    progress: running && !stopRequested ? { ...progress, etaSec: etaSec() } : progress,
  }),
  collectTab: ({ tabId }) => collectFromTab(tabId),
  inspectUrl: ({ url }) => inspectUrl(url),
  checkReminders: () => checkReminders(),
  async addSource({ url, name, platform }) {
    const sources = await store.getSources();
    const src = store.makeSource(url, { name, platform });
    if (sources.some((s) => s.url === src.url)) return { exists: true };
    await store.saveSources([...sources, src]);
    return { added: src };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve(h(msg)).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
