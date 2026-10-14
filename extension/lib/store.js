// Хранилище поверх chrome.storage.local.
//
// Ключи:
//   profile, settings, sources, runs
//   srcstate:<sourceId>  — состояние источника (пишет только фон)
//   v:<platform>:<id>    — вакансия (пишет только фон)
//   u:<platform>:<id>    — статус/заметка пользователя (пишет только CRM)
// Разделение v:/u: нужно, чтобы фоновый сбор не затёр статус, который вы
// поменяли в ту же секунду.

import { DEFAULT_PROFILE } from './match.js';

const local = chrome.storage.local;

export const STATUSES = [
  ['new', 'Не смотрел'],
  ['viewed', 'Просмотрел'],
  ['applied', 'Отправил резюме'],
  ['interview', 'Интервью'],
  ['offer', 'Оффер'],
  ['rejected', 'Отказ'],
  ['hidden', 'Скрыто'],
];

export const DEFAULT_SETTINGS = {
  autoRun: true,
  tickMinutes: 5,          // как часто фон проверяет, не пора ли обойти источники
  matchScore: 0.5,         // с какой оценки вакансия считается «подходящей»
  notifyScore: 0.65,       // уведомлять о новых вакансиях с оценкой не ниже
  manualGapMin: 10,        // «Найти работу» не трогает источник, если его обходили недавно
  skipWhenLocked: true,    // не обходить, пока экран заблокирован
  openIn: 'tab',           // 'tab' — фоновая вкладка, 'window' — свёрнутое окно
  retentionDays: 45,       // удалять старые вакансии, которые вы не трогали
  manualEnrichMax: 10,     // сколько описаний подгружать при сборе с текущей вкладки
  pauseBetweenSources: [8000, 20000], // пауза между источниками, мс
};

export const PLATFORM_DEFAULTS = {
  hh: { intervalMin: 120, cfg: { enrichMax: 10, enrichDelay: [3000, 8000] } },
  avito: { intervalMin: 240, cfg: { enrichMax: 3, enrichDelay: [8000, 15000] } },
  telegram: { intervalMin: 60, cfg: { pages: 2 } },
  generic: { intervalMin: 360, cfg: { enrichMax: 5, enrichDelay: [3000, 7000] } },
};

export const PLATFORM_NAMES = { hh: 'hh.ru', avito: 'Avito', telegram: 'Telegram', generic: 'Сайты компаний' };

export function detectPlatformByUrl(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)hh\.ru$/.test(u.hostname)) return 'hh';
    if (/(^|\.)avito\.ru$/.test(u.hostname)) return 'avito';
    if (u.hostname === 't.me') return 'telegram';
  } catch { /* не URL */ }
  return 'generic';
}

// t.me/channel и t.me/s/channel -> t.me/s/channel (веб-превью без авторизации).
export function normalizeSourceUrl(url, platform) {
  if (platform === 'telegram') {
    const m = url.match(/t\.me\/(?:s\/)?([A-Za-z0-9_]{4,})/);
    if (m) return `https://t.me/s/${m[1]}`;
  }
  return url.trim();
}

export async function getProfile() {
  const { profile } = await local.get('profile');
  return { ...DEFAULT_PROFILE, ...(profile || {}) };
}
export const saveProfile = (profile) => local.set({ profile });

export async function getSettings() {
  const { settings } = await local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
export const saveSettings = (settings) => local.set({ settings });

export async function getSources() {
  const { sources } = await local.get('sources');
  return sources || [];
}
export const saveSources = (sources) => local.set({ sources });

export function makeSource(url, { platform, name, cfg } = {}) {
  const p = platform || detectPlatformByUrl(url);
  const d = PLATFORM_DEFAULTS[p];
  const normUrl = normalizeSourceUrl(url, p);
  const defaultName = p === 'telegram' ? `TG: @${normUrl.split('/s/')[1] || ''}` : url;
  return {
    id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    platform: p,
    name: name || defaultName,
    url: normUrl,
    intervalMin: d.intervalMin,
    enabled: true,
    cfg: { ...d.cfg, ...(cfg || {}) },
  };
}

export async function getSrcState(id) {
  const k = `srcstate:${id}`;
  return (await local.get(k))[k] || {};
}
export const setSrcState = (id, st) => local.set({ [`srcstate:${id}`]: st });

export async function getAll() {
  return local.get(null);
}

// Вакансии вместе с пользовательскими полями.
export async function getVacancies() {
  return vacanciesFrom(await getAll());
}

export function vacanciesFrom(all) {
  const out = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('v:')) continue;
    const u = all[`u${k.slice(1)}`] || {};
    out.push({ ...v, status: u.status || 'new', note: u.note || '', statusChangedAt: u.statusChangedAt || null });
  }
  return out;
}

export async function setUserFields(vKey, patch) {
  const uKey = `u${vKey.slice(1)}`;
  const cur = (await local.get(uKey))[uKey] || {};
  const next = { ...cur, ...patch };
  if (patch.status && patch.status !== cur.status) next.statusChangedAt = new Date().toISOString();
  await local.set({ [uKey]: next });
}

export async function addRun(run) {
  const { runs } = await local.get('runs');
  const next = [run, ...(runs || [])].slice(0, 300);
  await local.set({ runs: next });
}

// ---------- Резюме ----------

export async function getResume() {
  const { resume } = await local.get('resume');
  return resume || null; // { name, size, type, text, uploadedAt }
}
export const saveResume = (resume) => (resume ? local.set({ resume }) : local.remove('resume'));

// ---------- Автоматические поиски по желаемой должности ----------
// Когда в профиле указана должность, создаём (или обновляем) поиск на hh.ru и Avito.
// Пользователь может выключить или удалить их — тогда мы их не трогаем.

export function autoSearchUrl(platform, query) {
  const q = encodeURIComponent(query);
  if (platform === 'hh') return `https://hh.ru/search/vacancy?text=${q}&area=113&order_by=publication_time&search_period=30&items_on_page=50`;
  if (platform === 'avito') return `https://www.avito.ru/all/vakansii?q=${q}&s=104`;
  return null;
}

export async function syncAutoSources(profile) {
  const query = (profile.position || '').trim();
  const sources = await getSources();
  const { autoRemoved } = await local.get('autoRemoved');
  const removed = new Set(autoRemoved || []);
  let changed = false;
  for (const platform of ['hh', 'avito']) {
    const idx = sources.findIndex((s) => s.auto === platform);
    if (!query) continue;
    const url = autoSearchUrl(platform, query);
    const name = `${PLATFORM_NAMES[platform]}: ${query}`;
    if (idx >= 0) {
      if (sources[idx].url !== url) {
        sources[idx] = { ...sources[idx], url, name };
        await local.remove(`srcstate:${sources[idx].id}`);
        changed = true;
      }
    } else if (!removed.has(platform)) {
      sources.push({ ...makeSource(url, { platform, name }), auto: platform });
      changed = true;
    }
  }
  if (changed) await saveSources(sources);
  return changed;
}

export async function removeSource(id) {
  const sources = await getSources();
  const src = sources.find((s) => s.id === id);
  if (src?.auto) {
    const { autoRemoved } = await local.get('autoRemoved');
    await local.set({ autoRemoved: [...new Set([...(autoRemoved || []), src.auto])] });
  }
  await saveSources(sources.filter((s) => s.id !== id));
  await local.remove(`srcstate:${id}`);
}
