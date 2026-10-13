import * as store from './lib/store.js';
import { scoreVacancy, profileSkills } from './lib/match.js';
import { extractSkills, SKILL_NAMES, salaryInRub } from './lib/parse.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const STATUS_LABEL = Object.fromEntries(store.STATUSES);
const GRADE_LABEL = { intern: 'Стажёр', junior: 'Junior', middle: 'Middle', senior: 'Senior', lead: 'Lead' };
const FORMAT_LABEL = { remote: 'Удалённо', hybrid: 'Гибрид', office: 'Офис' };
const PAGE = 100;

// Все данные со сторонних сайтов выводим только через textContent.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'href') el.href = /^https?:\/\//i.test(v) ? v : '#';
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false && c !== '') el.append(c instanceof Node ? c : String(c));
  return el;
}

const splitList = (s) => (s || '').split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
function ago(iso) {
  if (!iso) return '';
  const d = (Date.now() - Date.parse(iso)) / 86400e3;
  if (d < 1 / 24) return 'только что';
  if (d < 1) return `${Math.round(d * 24)} ч назад`;
  return `${Math.round(d)} дн назад`;
}
function fmtSalary(s) {
  if (!s) return '';
  const cur = { RUB: '₽', USD: '$', EUR: '€', KZT: '₸' }[s.currency] || s.currency;
  const n = (x) => x.toLocaleString('ru-RU');
  if (s.from && s.to) return `${n(s.from)}–${n(s.to)} ${cur}`;
  if (s.from) return `от ${n(s.from)} ${cur}`;
  if (s.to) return `до ${n(s.to)} ${cur}`;
  return '';
}

// ---------------- Навигация ----------------

const views = ['vacancies', 'profile', 'sources', 'log'];
function currentView() {
  const v = location.hash.slice(1);
  return views.includes(v) ? v : 'vacancies';
}
function showView() {
  const v = currentView();
  for (const name of views) $(`view-${name}`).hidden = name !== v;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
  render[v]();
}
window.addEventListener('hashchange', showView);

// ---------------- Вакансии ----------------

const filters = { status: 'active', platform: '', minScore: 40, q: '', sort: 'score', limit: PAGE };
let statusChip = null;

async function renderVacancies() {
  const [vs, profile] = await Promise.all([store.getVacancies(), store.getProfile()]);
  const ps = profileSkills(profile);
  const now = Date.now();
  const scored = vs.map((v) => ({ v, s: scoreVacancy(v, profile, now, ps) }));

  // Счётчики статусов по всем вакансиям, прошедшим порог оценки.
  const counts = {};
  for (const { v, s } of scored) if (s.score * 100 >= filters.minScore || v.status !== 'new') counts[v.status] = (counts[v.status] || 0) + 1;
  const chips = $('statusChips');
  chips.replaceChildren(...store.STATUSES.map(([key, label]) => h('button', {
    class: `chip${statusChip === key ? ' active' : ''}`,
    onclick: () => { statusChip = statusChip === key ? null : key; filters.limit = PAGE; renderVacancies(); },
  }, `${label}: ${counts[key] || 0}`)));

  const q = filters.q.toLowerCase();
  let rows = scored.filter(({ v, s }) => {
    if (statusChip) { if (v.status !== statusChip) return false; } else if (filters.status === 'active' && ['hidden', 'rejected'].includes(v.status)) return false;
    if (filters.platform && v.platform !== filters.platform) return false;
    // Порог оценки применяем только к ещё не разобранным вакансиям.
    if (v.status === 'new' && s.score * 100 < filters.minScore) return false;
    if (q && !`${v.title} ${v.company} ${v.description} ${v.snippet}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const dateOf = (v) => Date.parse(v.publishedAt || v.firstSeenAt) || 0;
  rows.sort(filters.sort === 'date' ? (a, b) => dateOf(b.v) - dateOf(a.v) : (a, b) => b.s.score - a.s.score || dateOf(b.v) - dateOf(a.v));

  const list = $('vacList');
  if (!rows.length) {
    list.replaceChildren(h('div', { class: 'empty' }, vs.length
      ? 'Под фильтры ничего не подошло. Попробуйте снизить порог оценки.'
      : 'Вакансий пока нет. Добавьте источники на вкладке «Источники» или соберите вакансии с открытой страницы через иконку расширения.'));
    $('more').hidden = true;
    return;
  }
  list.replaceChildren(...rows.slice(0, filters.limit).map(({ v, s }) => vacancyCard(v, s)));
  $('more').hidden = rows.length <= filters.limit;
  $('more').textContent = `Показать ещё (${rows.length - filters.limit})`;
}

function vacancyCard(v, s) {
  const pct = Math.round(s.score * 100);
  const setStatus = async (status) => { await store.setUserFields(v.key, { status }); };
  const statusSel = h('select', { title: 'Статус', onchange: (e) => setStatus(e.target.value) },
    store.STATUSES.map(([k, label]) => h('option', { value: k, selected: k === v.status }, label)));

  const noteBox = h('div', { class: 'note', hidden: !v.note },
    h('textarea', {
      placeholder: 'Заметка: кому писал, контакты, дата интервью…',
      onchange: (e) => store.setUserFields(v.key, { note: e.target.value }),
    }, v.note));

  const salary = fmtSalary(v.salary);
  const meta = h('div', { class: 'meta' },
    v.company && h('span', {}, v.company),
    v.location && h('span', {}, v.location),
    salary && h('span', { class: 'salary' }, salary),
    v.grades?.length ? h('span', {}, v.grades.map((g) => GRADE_LABEL[g]).join('/')) : null,
    v.formats?.length ? h('span', {}, v.formats.map((f) => FORMAT_LABEL[f]).join(', ')) : null,
    h('span', {}, `${store.PLATFORM_NAMES[v.platform]} · ${(v.sources || []).join(', ')}`),
    v.alsoAt?.length ? h('span', {}, `ещё в ${v.alsoAt.length} ист.`) : null,
    h('span', {}, ago(v.publishedAt || v.firstSeenAt)));

  const skillChips = h('div', { class: 'chips' },
    s.matched.map((k) => h('span', { class: 'chip ok', title: 'Есть у вас' }, SKILL_NAMES[k] || k.replace(/^custom:/, ''))),
    s.missing.slice(0, 8).map((k) => h('span', { class: 'chip miss', title: 'Нет в профиле' }, SKILL_NAMES[k] || k.replace(/^custom:/, ''))),
    s.stopped && h('span', { class: 'chip' }, `стоп-слово: ${s.stopped}`));

  const open = () => { if (v.status === 'new') setStatus('viewed'); };

  return h('article', { class: `card st-${v.status}` },
    h('div', { class: `score ${pct >= 65 ? 'hi' : pct >= 45 ? 'mid' : ''}`, title: scoreTitle(s) }, `${pct}`),
    h('div', {},
      h('h3', {}, v.status === 'new' && h('span', { class: 'new-dot', title: 'Не смотрел' }),
        h('a', { href: v.url, target: '_blank', rel: 'noopener', onclick: open, onauxclick: open }, v.title)),
      meta,
      v.snippet || v.description ? h('p', { class: 'snippet' }, (v.snippet || v.description).slice(0, 400)) : null,
      skillChips,
      v.alsoAt?.length ? h('div', { class: 'meta small' }, 'Также: ', v.alsoAt.map((a) => h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.source || a.platform))) : null),
    h('div', { class: 'side' },
      statusSel,
      h('button', { class: 'link', onclick: () => { noteBox.hidden = !noteBox.hidden; } }, v.note ? 'Заметка ✎' : 'Заметка'),
      v.status !== 'hidden' && h('button', { class: 'link', onclick: () => setStatus('hidden') }, 'Скрыть')),
    noteBox);
}

function scoreTitle(s) {
  if (!s.parts) return '';
  const p = s.parts;
  const pc = (x) => `${Math.round(x * 100)}%`;
  return `Навыки ${pc(p.skills)} · Название ${pc(p.title)} · Грейд ${pc(p.grade)} · Зарплата ${pc(p.salary)} · Свежесть ${pc(p.fresh)}`;
}

let qTimer;
$('q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { filters.q = e.target.value; filters.limit = PAGE; renderVacancies(); }, 200); });
$('fStatus').addEventListener('change', (e) => { filters.status = e.target.value; statusChip = null; renderVacancies(); });
$('fPlatform').addEventListener('change', (e) => { filters.platform = e.target.value; renderVacancies(); });
$('fSort').addEventListener('change', (e) => { filters.sort = e.target.value; renderVacancies(); });
$('fScore').addEventListener('input', (e) => { filters.minScore = Number(e.target.value); $('fScoreVal').textContent = `${e.target.value}%`; renderVacancies(); });
$('more').addEventListener('click', () => { filters.limit += PAGE; renderVacancies(); });

// ---------------- Профиль ----------------

async function renderProfile() {
  const p = await store.getProfile();
  $('pKeywords').value = (p.titleKeywords || []).join(', ');
  $('pGrade').value = p.grade || '';
  $('pSkills').value = (p.skills || []).join(', ');
  $('pSalary').value = p.minSalary || '';
  document.querySelectorAll('input[name="fmt"]').forEach((c) => { c.checked = (p.formats || []).includes(c.value); });
  $('pCities').value = (p.cities || []).join(', ');
  $('pStop').value = (p.stopWords || []).join(', ');
  $('pAge').value = p.maxAgeDays || 30;
  const { resumeText } = await chrome.storage.local.get('resumeText');
  $('resume').value = resumeText || '';
}

$('profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await store.saveProfile({
    titleKeywords: splitList($('pKeywords').value),
    grade: $('pGrade').value,
    skills: splitList($('pSkills').value),
    minSalary: Number($('pSalary').value) || 0,
    formats: [...document.querySelectorAll('input[name="fmt"]:checked')].map((c) => c.value),
    cities: splitList($('pCities').value),
    stopWords: splitList($('pStop').value),
    maxAgeDays: Number($('pAge').value) || 30,
  });
  $('profileSaved').textContent = 'Сохранено. Оценки пересчитаны.';
  setTimeout(() => { $('profileSaved').textContent = ''; }, 3000);
});

$('findSkills').addEventListener('click', async () => {
  const text = $('resume').value;
  await chrome.storage.local.set({ resumeText: text });
  const { required, optional } = extractSkills(text);
  const have = new Set(profileSkills({ skills: splitList($('pSkills').value) }).map((s) => s.slug));
  const found = [...new Set([...required, ...optional])].filter((s) => !have.has(s));
  const box = $('foundSkills');
  if (!found.length) { box.replaceChildren(h('span', { class: 'muted' }, 'Новых навыков не найдено — всё уже в профиле.')); return; }
  box.replaceChildren(h('span', { class: 'muted small' }, 'Нажмите, чтобы добавить в профиль, затем «Сохранить профиль»:'),
    ...found.map((slug) => h('button', {
      class: 'chip',
      type: 'button',
      onclick: (e) => {
        const cur = splitList($('pSkills').value);
        $('pSkills').value = [...cur, SKILL_NAMES[slug]].join(', ');
        e.target.remove();
      },
    }, `+ ${SKILL_NAMES[slug]}`)));
});

// ---------------- Источники ----------------

const INTERVALS = [30, 60, 120, 240, 360, 720, 1440];
const intervalLabel = (m) => (m < 60 ? `${m} мин` : m < 1440 ? `${m / 60} ч` : 'раз в сутки');

async function renderSources() {
  const sources = await store.getSources();
  const all = await store.getAll();
  const body = $('srcBody');
  if (!sources.length) {
    body.replaceChildren(h('tr', {}, h('td', { colspan: 6, class: 'empty' }, 'Источников пока нет.')));
    return;
  }
  const update = async (id, patch) => {
    const list = await store.getSources();
    await store.saveSources(list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };
  body.replaceChildren(...sources.map((s) => {
    const st = all[`srcstate:${s.id}`] || {};
    return h('tr', {},
      h('td', {}, h('input', { type: 'checkbox', checked: s.enabled, title: 'Включён', onchange: (e) => update(s.id, { enabled: e.target.checked }) })),
      h('td', { class: 'url' },
        h('div', {}, h('strong', {}, s.name)),
        h('div', { class: 'small muted' }, `${store.PLATFORM_NAMES[s.platform]} · `, h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.url))),
      h('td', {}, h('select', { onchange: (e) => update(s.id, { intervalMin: Number(e.target.value) }) },
        INTERVALS.map((m) => h('option', { value: m, selected: m === s.intervalMin }, intervalLabel(m))))),
      h('td', {},
        st.lastRunAt ? h('div', {}, fmtDate(st.lastRunAt)) : h('span', { class: 'muted' }, 'ещё не было'),
        st.lastStatus && h('div', { class: `small status-${st.lastStatus}` },
          { ok: 'ok', empty: 'пусто', failed: 'ошибка', blocked: 'проверка/капча' }[st.lastStatus],
          st.lastStatus !== 'failed' && st.lastStatus !== 'blocked' ? ` · найдено ${st.lastFound}, новых ${st.lastAdded}` : ''),
        st.lastError && h('div', { class: 'small muted' }, st.lastError)),
      h('td', {}, st.nextRunAt ? fmtDate(st.nextRunAt) : 'скоро'),
      h('td', {}, h('div', { class: 'row' },
        h('button', { onclick: async () => { const r = await send({ type: 'runNow', sourceId: s.id }); flashRun(r); } }, 'Обойти'),
        h('button', { class: 'link', onclick: async () => {
          if (!confirm(`Удалить источник «${s.name}»? Собранные вакансии останутся.`)) return;
          await store.saveSources((await store.getSources()).filter((x) => x.id !== s.id));
          await chrome.storage.local.remove(`srcstate:${s.id}`);
        } }, 'Удалить'))));
  }));
}

async function addSourceFromForm({ url, name, cfg }) {
  const platform = store.detectPlatformByUrl(url);
  // Доступ к сайту компании запрашиваем сразу, пока действует клик пользователя.
  if (platform === 'generic') {
    let origin;
    try { origin = `${new URL(url).origin}/*`; } catch { return 'Это не похоже на ссылку.'; }
    const ok = await chrome.permissions.request({ origins: [origin] });
    if (!ok) return 'Без доступа к сайту расширение не сможет его обходить.';
  }
  const sources = await store.getSources();
  const src = store.makeSource(url, { name: name || undefined, cfg });
  if (sources.some((s) => s.url === src.url)) return 'Такой источник уже есть.';
  await store.saveSources([...sources, src]);
  return `Добавлено: ${src.name}`;
}

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cfg = {};
  if ($('aLink').value.trim()) cfg.linkPattern = $('aLink').value.trim();
  if ($('aItem').value.trim()) cfg.itemSelector = $('aItem').value.trim();
  if ($('aTitle').value.trim()) cfg.titleSelector = $('aTitle').value.trim();
  if (cfg.linkPattern) { try { new RegExp(cfg.linkPattern); } catch { $('addMsg').textContent = 'Шаблон ссылки — некорректное регулярное выражение.'; return; } }
  $('addMsg').textContent = await addSourceFromForm({ url: $('aUrl').value.trim(), name: $('aName').value.trim(), cfg });
  e.target.reset();
});

$('quickHH').addEventListener('click', async () => {
  const q = $('quickQ').value.trim();
  if (!q) return;
  const url = `https://hh.ru/search/vacancy?text=${encodeURIComponent(q)}&order_by=publication_time&search_period=30&items_on_page=50`;
  $('addMsg').textContent = await addSourceFromForm({ url, name: `hh: ${q}` });
});
$('quickAvito').addEventListener('click', async () => {
  const q = $('quickQ').value.trim();
  if (!q) return;
  const url = `https://www.avito.ru/all/vakansii?q=${encodeURIComponent(q)}&s=104`;
  $('addMsg').textContent = await addSourceFromForm({ url, name: `Avito: ${q}` });
});

// ---------------- Журнал и настройки ----------------

async function renderLog() {
  await renderSettings();
  await renderRuns();
}

async function renderSettings() {
  const s = await store.getSettings();
  $('sAuto').checked = s.autoRun;
  $('sTick').value = s.tickMinutes;
  $('sLocked').checked = s.skipWhenLocked;
  $('sOpen').value = s.openIn;
  $('sNotify').value = Math.round(s.notifyScore * 100);
  $('sManual').value = s.manualEnrichMax;
  $('sRetention').value = s.retentionDays;
}

async function renderRuns() {
  const { runs } = await chrome.storage.local.get('runs');
  const body = $('logBody');
  if (!runs?.length) { body.replaceChildren(h('tr', {}, h('td', { colspan: 6, class: 'empty' }, 'Обходов ещё не было.'))); return; }
  body.replaceChildren(...runs.slice(0, 100).map((r) => h('tr', {},
    h('td', {}, fmtDate(r.at)),
    h('td', {}, r.source),
    h('td', { class: `status-${r.status}` }, r.status),
    h('td', {}, r.found ?? ''),
    h('td', {}, r.added ?? ''),
    h('td', { class: 'small muted' }, r.error || ''))));
}

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await store.saveSettings({
    ...(await store.getSettings()),
    autoRun: $('sAuto').checked,
    tickMinutes: Math.max(1, Number($('sTick').value) || 5),
    skipWhenLocked: $('sLocked').checked,
    openIn: $('sOpen').value,
    notifyScore: (Number($('sNotify').value) || 0) / 100,
    manualEnrichMax: Number($('sManual').value) || 0,
    retentionDays: Number($('sRetention').value) || 45,
  });
  $('settingsSaved').textContent = 'Сохранено.';
  setTimeout(() => { $('settingsSaved').textContent = ''; }, 3000);
});

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('exportCsv').addEventListener('click', async () => {
  const [vs, profile] = await Promise.all([store.getVacancies(), store.getProfile()]);
  const ps = profileSkills(profile);
  const cols = ['score', 'status', 'title', 'company', 'salary_rub_from', 'salary_rub_to', 'grades', 'formats', 'location', 'platform', 'url', 'published', 'note'];
  const esc = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const lines = vs.map((v) => {
    const rub = salaryInRub(v.salary) || {};
    return [Math.round(scoreVacancy(v, profile, Date.now(), ps).score * 100), STATUS_LABEL[v.status], v.title, v.company, rub.from, rub.to,
      (v.grades || []).join('/'), (v.formats || []).join('/'), v.location, v.platform, v.url, v.publishedAt || v.firstSeenAt, v.note].map(esc).join(';');
  });
  download(`job-radar-${new Date().toISOString().slice(0, 10)}.csv`, `﻿${cols.join(';')}\n${lines.join('\n')}`, 'text/csv');
});

$('exportJson').addEventListener('click', async () => {
  download(`job-radar-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await store.getAll()), 'application/json');
});
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!confirm(`Восстановить ${Object.keys(data).length} записей? Текущие данные с теми же ключами будут заменены.`)) return;
    await chrome.storage.local.set(data);
    alert('Готово.');
  } catch (err) {
    alert(`Не получилось прочитать файл: ${err.message}`);
  }
});

// ---------------- Общее ----------------

function flashRun(r) {
  $('runState').textContent = r?.busy ? `обход уже идёт: ${r.current || ''}` : 'обход запущен…';
}
$('runAll').addEventListener('click', async () => flashRun(await send({ type: 'runNow' })));

async function pollState() {
  const s = await send({ type: 'status' }).catch(() => null);
  $('runState').textContent = s?.running ? `идёт обход: ${s.current || '…'}` : '';
}
setInterval(pollState, 3000);

const render = { vacancies: renderVacancies, profile: renderProfile, sources: renderSources, log: renderLog };

// Живое обновление при изменениях из фона. Формы профиля и настроек не
// перерисовываем, чтобы не сбросить то, что вы вводите. Пока открыта заметка,
// ленту тоже не трогаем.
const live = { vacancies: renderVacancies, sources: renderSources, log: renderRuns };
let changeTimer;
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local') return;
  const v = currentView();
  if (!live[v]) return;
  if (v === 'vacancies' && document.activeElement?.tagName === 'TEXTAREA') return;
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => live[v](), 400);
});

showView();
pollState();
