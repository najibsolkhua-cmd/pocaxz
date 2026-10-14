// Фоновый обход источников. Открывает сохранённые страницы в вашем браузере
// (с вашими cookies и IP), внедряет extractors/page.js, забирает вакансии и
// складывает их в chrome.storage.local.

import * as store from './lib/store.js';
import { normalizeItem, dedupKey } from './lib/parse.js';
import { scoreAll } from './lib/match.js';

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
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html#profile') });
  scheduleBadge();
});
chrome.runtime.onStartup.addListener(setupAlarm);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') tick().catch(console.error); });

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
    if (!st.nextRunAt || Date.parse(st.nextRunAt) <= now) due.push(s);
  }
  return due;
}

// Вызывающий код уже выставил running = true.
async function runQueue(due, settings) {
  const stop = keepAlive();
  try {
    progress = { total: due.length, done: 0, current: null, queue: due.map((s) => ({ id: s.id, platform: s.platform, name: s.name })), finishedAt: null };
    for (let i = 0; i < due.length; i++) {
      if (stopRequested) break;
      if (i > 0) await sleep(rand(...settings.pauseBetweenSources));
      if (stopRequested) break;
      current = due[i].name;
      progress.current = progress.queue.shift();
      progress.found = 0;
      progress.page = 0;
      progress.detail = 0;
      await runSource(due[i], settings);
      progress.done++;
    }
    await cleanup(settings);
  } finally {
    running = false;
    current = null;
    progress = { ...progress, current: null, queue: [], finishedAt: new Date().toISOString(), stopped: stopRequested };
    stopRequested = false;
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
    const skip = !settings.autoRun || (settings.skipWhenLocked && (await chrome.idle.queryState(60)) === 'locked');
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
  if (running) return { busy: true, current };
  running = true;
  try {
    const settings = await store.getSettings();
    const due = await planDue(settings, { force: true, sourceId });
    if (!due.length) { running = false; return { started: false, total: 0 }; }
    runQueue(due, settings).catch(console.error);
    return { started: true, total: due.length };
  } catch (e) {
    running = false;
    throw e;
  }
}

function waitTabComplete(tabId, timeout = 45e3) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { done(); reject(new Error('страница не загрузилась за 45 с')); }, timeout);
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') { done(); resolve(); } };
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') { done(); resolve(); } }).catch(() => {});
  });
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
  await inject(tabId);
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (m, c) => globalThis.__jobRadar[m](c),
    args: [method, cfg],
  });
  return r?.result;
}

const extractInTab = async (tabId, cfg) => (await callInTab(tabId, 'extract', cfg)) || { items: [], error: 'пустой ответ экстрактора' };

// Паузы между страницами выдачи и между карточками — как у человека.
const PAGE_DELAY = { hh: [2500, 5000], avito: [4000, 8000], telegram: [1500, 3000], generic: [2000, 4000] };
const DETAIL_DELAY = { hh: [2500, 6000], avito: [5000, 10000], generic: [2500, 5000], telegram: [2000, 4000] };
const DETAIL_CAP = { hh: 50, avito: 10, generic: 10, telegram: 0 };
const RECHECK_PER_RUN = { hh: 6, avito: 4, generic: 0, telegram: 0 };
const MAX_PAGES = 100;

// Переход вкладки на новый адрес: ждём сначала начала загрузки, потом её конца —
// иначе можно прочитать старую страницу, у которой статус ещё «complete».
function navigate(tabId, url, timeout = 45e3) {
  return new Promise((resolve, reject) => {
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
  });
}

// Подробности: для hh и Avito — запросом с той же вкладки, для сайтов компаний —
// переходом на страницу (там часто всё рисует JavaScript).
async function fetchDetails(tabId, platform, list) {
  if (!list.length) return { results: {}, blocked: null };
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
    await sleep(rand(...DETAIL_DELAY.generic));
  }
  return { results, blocked: null };
}

async function runSource(src, settings) {
  const started = new Date();
  const st = await store.getSrcState(src.id);
  const limit = Math.max(1, Math.min(Number(settings.scanLimit) || 100, 5000));
  const collected = new Map();
  let total = null;
  let blocked = null;
  let error = null;
  let pages = 0;
  let stats = { found: 0, added: 0, updated: 0 };
  let detailed = 0;
  let archived = 0;
  let handle;
  try {
    handle = await openHidden(src.url, settings.openIn);
    currentHandle = handle;
    await waitTabComplete(handle.tabId);
    await sleep(rand(1500, 3000));
    let url = src.url;

    // 1. Страницы выдачи — пока не наберём лимит или выдача не кончится.
    for (;;) {
      const res = await extractInTab(handle.tabId, { platform: src.platform, ...src.cfg, limit: limit - collected.size, pageNo: pages });
      pages++;
      if (pages === 1) total = res.total;
      if (res.error && !res.items?.length) error = res.error;
      if (res.blocked) { blocked = res.reason; break; }
      const before = collected.size;
      for (const it of res.items || []) if (!collected.has(it.externalId) && collected.size < limit) collected.set(it.externalId, it);
      progress.found = collected.size;
      progress.page = pages;
      if (stopRequested || collected.size >= limit || collected.size === before || !res.nextUrl || pages >= MAX_PAGES) break;
      url = res.nextUrl;
      await sleep(rand(...PAGE_DELAY[src.platform]));
      try { await navigate(handle.tabId, url); } catch (e) { error = String(e?.message || e); break; }
    }

    const items = [...collected.values()];
    stats = await ingest(items, src.platform, src);

    // 2. Подробное описание — только для лучших новых вакансий, чтобы не ждать часами.
    if (!blocked && !stopRequested && DETAIL_CAP[src.platform]) {
      const want = Math.min(Number(settings.deepCheck) || 20, DETAIL_CAP[src.platform]);
      const cand = await pickForDetails(items, src.platform, settings, want);
      if (cand.length) {
        progress.detail = cand.length;
        const d = await fetchDetails(handle.tabId, src.platform, cand.map((c) => ({ externalId: c.externalId, url: c.url })));
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
    if (!blocked && !stopRequested && RECHECK_PER_RUN[src.platform]) {
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
    if (src.platform === 'generic' && !blocked && !error && !stopRequested && collected.size && collected.size < limit) {
      archived += await archiveMissing(src, new Set(collected.keys()));
    }
  } catch (e) {
    // Вкладку закрыли по кнопке «Стоп» — это не ошибка.
    if (!stopRequested) error = String(e?.message || e);
  } finally {
    handle?.close();
  }
  // Найденное до остановки сохраняем.
  if (stopRequested && collected.size && !stats.found) {
    try { stats = await ingest([...collected.values()], src.platform, src); } catch { /* ignore */ }
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
    lastTotal: total,
    lastFound: collected.size,
    lastAdded: stats.added,
    lastDetailed: detailed,
    lastPages: pages,
    lastLimit: limit,
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
  return { status, ...stats };
}

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
  }
}

async function cleanup(settings) {
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
  const res = await extractInTab(tabId, { platform: 'auto', limit: 1000 });
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
    currentHandle?.close();
    return { stopping: true };
  },
  status: async () => ({ running, current, progress }),
  collectTab: ({ tabId }) => collectFromTab(tabId),
  inspectUrl: ({ url }) => inspectUrl(url),
  async addSource({ url, name, platform }) {
    const sources = await store.getSources();
    const src = store.makeSource(url, { name, platform });
    if (sources.some((s) => s.url === src.url)) return { exists: true };
    await store.saveSources([...sources, src]);
    return { added: src };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve(h(msg)).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
