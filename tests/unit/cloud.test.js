import { test } from 'node:test';
import assert from 'node:assert/strict';

// Хранилище браузера в памяти.
const db = {};
globalThis.chrome = {
  storage: { local: {
    get: async (k) => (k == null ? structuredClone(db) : Object.fromEntries([k].flat().filter((x) => x in db).map((x) => [x, structuredClone(db[x])]))),
    set: async (o) => { Object.assign(db, structuredClone(o)); },
    remove: async (k) => { [k].flat().forEach((x) => delete db[x]); },
  } },
  runtime: { getManifest: () => ({ version: '9.9.9' }) },
};
const cloud = await import('../../extension/lib/cloud.js');
const ads = await import('../../extension/lib/adstats.js');
const { CONFIG } = await import('../../extension/config.js');

// Яндекс Диск в памяти: тот же порядок запросов, что у настоящего API.
function fakeDisk() {
  let blob = null;
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push([opts.method || 'GET', url, opts.headers?.Authorization]);
    const json = (code, obj) => ({ ok: code < 300, status: code, json: async () => obj });
    if (opts.headers?.Authorization === 'OAuth expired') return json(401, {});
    if (url.includes('/resources/upload')) return json(200, { href: 'https://uploader.example/put', method: 'PUT' });
    if (url === 'https://uploader.example/put') { blob = opts.body; return json(201, {}); }
    if (url.includes('/resources/download')) return blob ? json(200, { href: 'https://downloader.example/get' }) : json(404, {});
    if (url === 'https://downloader.example/get') return json(200, JSON.parse(blob));
    return json(404, {});
  };
  return { fetchImpl, calls };
}

test('Яндекс Диск: копия без токена и кешей, восстановление на «новом компьютере»', async () => {
  const disk = fakeDisk();
  Object.assign(db, { profile: { name: 'Анна' }, 'v:hh:1': { title: 'Маркетолог' }, 'u:hh:1': { status: 'applied' }, partnersCache: { x: 1 }, cloud: { token: 'T1' } });
  assert.equal(await cloud.download('T1', disk.fetchImpl), null, 'копии ещё нет');
  const at = await cloud.backupNow({ force: true, fetchImpl: disk.fetchImpl });
  assert.ok(at && db.cloud.lastBackupAt === at);
  assert.equal(disk.calls[1][2], 'OAuth T1');
  assert.ok(disk.calls[1][1].startsWith(`${CONFIG.yandexDisk.apiBase}/resources/upload?path=app%3A%2Fsolk-job-backup.json`));
  const saved = await cloud.download('T1', disk.fetchImpl);
  assert.equal(saved.version, '9.9.9');
  assert.deepEqual(Object.keys(saved.data).sort(), ['profile', 'u:hh:1', 'v:hh:1']);
  // Автокопия не чаще autoHours.
  assert.equal(await cloud.backupNow({ fetchImpl: disk.fetchImpl }), null);
  // Новый компьютер: пусто, подключили Диск — восстановили.
  for (const k of Object.keys(db)) delete db[k];
  db.cloud = { token: 'T1' };
  await cloud.restoreNow({ fetchImpl: disk.fetchImpl });
  assert.equal(db['u:hh:1'].status, 'applied');
  assert.equal(db.profile.name, 'Анна');
  assert.equal(db.cloud.token, 'T1', 'подключение осталось');
});

test('Яндекс Диск: истёкший доступ — понятная ошибка', async () => {
  db.cloud = { token: 'expired' };
  await assert.rejects(cloud.backupNow({ force: true, fetchImpl: fakeDisk().fetchImpl }), /подключите заново/);
  assert.match(db.cloud.lastError, /подключите заново/);
});

test('счётчики баннеров: копятся, уходят на сервер общими числами и обнуляются', async () => {
  CONFIG.telegram.botApi = 'https://bot.example';
  delete db.adStats;
  await ads.countAd('school', 'view');
  await ads.countAd('school', 'view');
  await ads.countAd('school', 'click');
  await ads.countAd('bad id', 'view');
  const sent = [];
  const fetchImpl = async (url, opts) => { sent.push([url, JSON.parse(opts.body)]); return { ok: true }; };
  assert.equal(await ads.flushAdStats({ force: true, fetchImpl }), true);
  assert.deepEqual(sent[0], ['https://bot.example/api/ad-events', { events: { school: { view: 2, click: 1 } } }]);
  assert.deepEqual(db.adStats.pending, {});
  assert.equal(await ads.flushAdStats({ force: true, fetchImpl }), false, 'нечего отправлять');
  CONFIG.telegram.botApi = '';
});
