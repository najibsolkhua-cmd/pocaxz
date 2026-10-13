// Фоновый обход источников. Открывает сохранённые страницы в вашем браузере
// (с вашими cookies и IP), внедряет extractors/page.js, забирает вакансии и
// складывает их в chrome.storage.local.

import * as store from './lib/store.js';
import { normalizeItem, dedupKey } from './lib/parse.js';
import { scoreVacancy, profileSkills } from './lib/match.js';

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
});
chrome.runtime.onStartup.addListener(setupAlarm);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') tick().catch(console.error); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) setupAlarm();
  if (Object.keys(changes).some((k) => k.startsWith('u:') || k === 'profile')) scheduleBadge();
});

// ---------- Обход ----------

let running = false;
let current = null;

// MV3 усыпляет service worker через 30 с без событий; во время обхода
// держим его живым лёгкими вызовами API.
function keepAlive() {
  const t = setInterval(() => chrome.runtime.getPlatformInfo(), 20e3);
  return () => clearInterval(t);
}

async function tick({ force = false, sourceId = null } = {}) {
  if (running) return { busy: true };
  const settings = await store.getSettings();
  if (!force && !settings.autoRun) return { skipped: 'autoRun off' };
  if (!force && settings.skipWhenLocked && (await chrome.idle.queryState(60)) === 'locked') return { skipped: 'locked' };

  running = true;
  const stop = keepAlive();
  try {
    const now = Date.now();
    const sources = (await store.getSources()).filter((s) => (sourceId ? s.id === sourceId : s.enabled));
    const due = [];
    for (const s of sources) {
      const st = await store.getSrcState(s.id);
      if (sourceId || force || !st.nextRunAt || Date.parse(st.nextRunAt) <= now) due.push(s);
    }
    for (let i = 0; i < due.length; i++) {
      if (i > 0) await sleep(rand(...settings.pauseBetweenSources));
      current = due[i].name;
      await runSource(due[i], settings);
    }
    await cleanup(settings);
    return { ran: due.length };
  } finally {
    running = false;
    current = null;
    stop();
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

async function extractInTab(tabId, cfg) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['extractors/page.js'] });
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (c) => globalThis.__jobRadar.extract(c),
    args: [cfg],
  });
  return r?.result || { items: [], error: 'пустой ответ экстрактора' };
}

async function knownIds(platform) {
  const all = await store.getAll();
  const p = `v:${platform}:`;
  return Object.entries(all).filter(([k, v]) => k.startsWith(p) && v.enriched).map(([, v]) => v.externalId);
}

async function runSource(src, settings) {
  const started = new Date();
  const st = await store.getSrcState(src.id);
  let res;
  let handle;
  try {
    handle = await openHidden(src.url, settings.openIn);
    await waitTabComplete(handle.tabId);
    await sleep(rand(1500, 3500));
    res = await extractInTab(handle.tabId, { platform: src.platform, ...src.cfg, knownIds: await knownIds(src.platform) });
  } catch (e) {
    res = { items: [], error: String(e?.message || e) };
  } finally {
    handle?.close();
  }

  const stats = await ingest(res.items || [], src.platform, src.name);
  const failures = res.blocked || (res.error && !res.items?.length) ? (st.failures || 0) + 1 : 0;
  let status = 'ok';
  let waitMin = src.intervalMin * rand(0.85, 1.15);
  if (res.blocked) {
    status = 'blocked';
    waitMin = Math.max(BLOCK_PAUSE_MIN, src.intervalMin * 2 ** failures);
    notify(`blocked:${src.id}`, `Источник «${src.name}» просит проверку`,
      'Откройте страницу и пройдите проверку вручную. Обход этого источника приостановлен на 6 часов.', src.url);
  } else if (failures) {
    status = 'failed';
    waitMin = Math.min(24 * 60, src.intervalMin * 2 ** Math.min(failures, 5));
  } else if (!res.items?.length) {
    status = 'empty';
  }

  await store.setSrcState(src.id, {
    lastRunAt: started.toISOString(),
    nextRunAt: new Date(Date.now() + waitMin * 60e3).toISOString(),
    lastStatus: status,
    lastError: res.reason || res.error || null,
    lastFound: stats.found,
    lastAdded: stats.added,
    failures,
  });
  await store.addRun({
    at: started.toISOString(),
    source: src.name,
    platform: src.platform,
    status,
    found: stats.found,
    added: stats.added,
    error: res.reason || res.error || null,
    ms: Date.now() - started.getTime(),
  });
  return { status, ...stats };
}

// ---------- Сохранение ----------

const HH_LINK_RE = /hh\.ru\/vacancy\/(\d+)/;

async function ingest(items, platform, sourceName) {
  const now = new Date();
  const nowIso = now.toISOString();
  const all = await store.getAll();
  const profile = await store.getProfile();
  const settings = await store.getSettings();
  const ps = profileSkills(profile);

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
      const merged = { ...ex, lastSeenAt: nowIso, sources: [...new Set([...(ex.sources || []), sourceName])] };
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
    const sc = scoreVacancy(v, profile, now.getTime(), ps);
    if (sc.score >= settings.notifyScore) fresh.push({ v, score: sc.score });
  }

  if (Object.keys(write).length) await chrome.storage.local.set(write);
  if (fresh.length) {
    fresh.sort((a, b) => b.score - a.score);
    notify(`new:${Date.now()}`, `Новых подходящих вакансий: ${fresh.length}`,
      fresh.slice(0, 3).map((f) => `${Math.round(f.score * 100)}% · ${f.v.title}${f.v.company ? ` — ${f.v.company}` : ''}`).join('\n'));
  }
  scheduleBadge();
  return { found: items.length, added, updated };
}

async function cleanup(settings) {
  const all = await store.getAll();
  const limit = Date.now() - settings.retentionDays * 86400e3;
  const remove = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('v:')) continue;
    const u = all[`u${k.slice(1)}`];
    const kept = u && !['new', 'viewed', 'hidden'].includes(u.status);
    const t = Date.parse(v.publishedAt || v.firstSeenAt);
    if (!kept && t < limit) remove.push(k, `u${k.slice(1)}`);
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
  const [vs, profile, settings] = await Promise.all([store.getVacancies(), store.getProfile(), store.getSettings()]);
  const ps = profileSkills(profile);
  const now = Date.now();
  const n = vs.filter((v) => v.status === 'new' && scoreVacancy(v, profile, now, ps).score >= settings.notifyScore).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#2f6fed' });
  await chrome.action.setBadgeText({ text: n ? String(n > 999 ? '999+' : n) : '' });
}

// ---------- Сообщения от popup и CRM ----------

async function collectFromTab(tabId) {
  const settings = await store.getSettings();
  const tab = await chrome.tabs.get(tabId);
  const platform = store.detectPlatformByUrl(tab.url);
  const res = await extractInTab(tabId, {
    platform: platform === 'telegram' && !/\/s\//.test(tab.url) ? 'generic' : 'auto',
    enrichMax: settings.manualEnrichMax,
    enrichDelay: [2000, 5000],
    knownIds: await knownIds(platform),
  });
  const stats = await ingest(res.items || [], res.platform, `Вручную: ${new URL(tab.url).hostname}`);
  await store.addRun({ at: new Date().toISOString(), source: `Вручную: ${tab.title}`, platform: res.platform, status: res.blocked ? 'blocked' : 'ok', found: stats.found, added: stats.added, error: res.reason || res.error || null, ms: 0 });
  return { ...stats, platform: res.platform, blocked: res.blocked, reason: res.reason, error: res.error };
}

const handlers = {
  async runNow({ sourceId }) {
    if (running) return { busy: true, current };
    tick({ force: true, sourceId }).catch(console.error);
    return { started: true };
  },
  status: async () => ({ running, current }),
  collectTab: ({ tabId }) => collectFromTab(tabId),
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
