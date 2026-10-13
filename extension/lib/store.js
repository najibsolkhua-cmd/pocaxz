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
  notifyScore: 0.6,        // уведомлять о новых вакансиях с оценкой не ниже
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

export const PLATFORM_NAMES = { hh: 'hh.ru', avito: 'Avito', telegram: 'Telegram', generic: 'Сайт' };

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
  const all = await getAll();
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
