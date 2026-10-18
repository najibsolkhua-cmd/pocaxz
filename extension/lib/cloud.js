// Резервная копия на Яндекс Диске: всё, что хранит расширение, одним файлом в папке
// приложения (Приложения/solk-job на Диске пользователя). Доступ — только к этой папке.
//
// Вход — OAuth Яндекса через chrome.identity (пароль расширение не видит), токен хранится
// в браузере. Копия делается сама после поиска (не чаще autoHours), восстановление — кнопкой.

import { CONFIG } from '../config.js';

const local = { get: (k) => chrome.storage.local.get(k), set: (o) => chrome.storage.local.set(o), remove: (k) => chrome.storage.local.remove(k) };
const cfg = () => CONFIG.yandexDisk || {};
export const cloudEnabled = () => Boolean(cfg().clientId);

// В копию не попадают служебные кеши и сам токен.
const SKIP = new Set(['cloud', 'partnersCache', 'adStats']);
export function makeBackup(all, version = chrome.runtime.getManifest?.().version || '') {
  const data = Object.fromEntries(Object.entries(all).filter(([k]) => !SKIP.has(k)));
  return { app: 'solk-job', version, at: new Date().toISOString(), data };
}

export async function authorize() {
  const redirect = chrome.identity.getRedirectURL();
  const url = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${encodeURIComponent(cfg().clientId)}&redirect_uri=${encodeURIComponent(redirect)}&force_confirm=yes`;
  const back = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  const params = new URLSearchParams(new URL(back).hash.slice(1));
  const token = params.get('access_token');
  if (!token) throw new Error(params.get('error_description') || 'Яндекс не выдал доступ');
  const expiresIn = Number(params.get('expires_in')) || 365 * 86400;
  const cloud = { token, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(), connectedAt: new Date().toISOString() };
  await local.set({ cloud });
  return cloud;
}

export const getCloud = async () => (await local.get('cloud')).cloud || null;
export const disconnect = () => local.remove('cloud');

const api = async (token, path, fetchImpl) => {
  const r = await fetchImpl(`${cfg().apiBase}${path}`, { headers: { Authorization: `OAuth ${token}`, Accept: 'application/json' } });
  if (r.status === 401) throw Object.assign(new Error('Доступ к Яндекс Диску истёк — подключите заново'), { code: 401 });
  return r;
};

export async function upload(token, backup, fetchImpl = fetch) {
  const r = await api(token, `/resources/upload?path=${encodeURIComponent(cfg().path)}&overwrite=true`, fetchImpl);
  if (!r.ok) throw new Error(`Яндекс Диск: ${r.status}`);
  const { href, method } = await r.json();
  const put = await fetchImpl(href, { method: method || 'PUT', body: JSON.stringify(backup) });
  if (!put.ok) throw new Error(`Яндекс Диск: загрузка ${put.status}`);
  return backup.at;
}

// null — копии на Диске ещё нет.
export async function download(token, fetchImpl = fetch) {
  const r = await api(token, `/resources/download?path=${encodeURIComponent(cfg().path)}`, fetchImpl);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Яндекс Диск: ${r.status}`);
  const { href } = await r.json();
  const file = await fetchImpl(href);
  if (!file.ok) throw new Error(`Яндекс Диск: скачивание ${file.status}`);
  const backup = await file.json();
  if (backup?.app !== 'solk-job' || typeof backup.data !== 'object') throw new Error('Это не копия solk / job');
  return backup;
}

// Сохранить сейчас (или автоматически, если пора). Возвращает время копии или null.
export async function backupNow({ force = false, fetchImpl = fetch } = {}) {
  const cloud = await getCloud();
  if (!cloud?.token) return null;
  if (!force && cloud.lastBackupAt && Date.now() - Date.parse(cloud.lastBackupAt) < (cfg().autoHours || 12) * 3600e3) return null;
  const all = await local.get(null);
  try {
    const at = await upload(cloud.token, makeBackup(all), fetchImpl);
    await local.set({ cloud: { ...cloud, lastBackupAt: at, lastError: null } });
    return at;
  } catch (e) {
    await local.set({ cloud: { ...cloud, lastError: e.message } });
    throw e;
  }
}

// Восстановить: данные из копии заменяют совпадающие ключи; подключение к Диску остаётся.
export async function restoreNow({ fetchImpl = fetch } = {}) {
  const cloud = await getCloud();
  if (!cloud?.token) throw new Error('Яндекс Диск не подключён');
  const backup = await download(cloud.token, fetchImpl);
  if (!backup) return null;
  await local.set({ ...backup.data, cloud: { ...cloud, lastRestoreAt: new Date().toISOString() } });
  return backup;
}
