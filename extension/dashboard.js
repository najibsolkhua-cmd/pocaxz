// Главная solk / job: плитки-источники, центральная плитка с кнопкой поиска,
// профиль, лучшее, воронка, отклики и панели, которые выезжают справа.

import * as store from './lib/store.js';
import { DEFAULT_PROFILE, scoreAll, profileSkills, exclusionStats } from './lib/match.js';
import { $, h, logo, fmtTime, daysSince, plural, download } from './ui/dom.js';
import { createVacancyList } from './ui/vacancies.js';
import { renderProfile } from './ui/profile.js';
import { sourceRows, addSourceForm } from './ui/sources.js';
import { makeZip } from './lib/zip.js';
import { createAdSlot } from './ui/ads.js';
import { supportLink } from './config.js';
import * as tg from './lib/telegram.js';
import { createPartnerTile } from './ui/partners.js';

const send = (msg) => chrome.runtime.sendMessage(msg);
const PLATFORMS = ['avito', 'generic', 'telegram', 'hh'];
const STATUS_LABEL = Object.fromEntries(store.STATUSES);
const GRADE_LABEL = { intern: 'Стажёр', junior: 'Junior', middle: 'Middle', senior: 'Senior', lead: 'Lead' };

const state = {
  all: {}, profile: DEFAULT_PROFILE, settings: store.DEFAULT_SETTINGS, sources: [], resume: null,
  scored: [], status: { running: false, progress: null },
};

// ---------------- Данные ----------------

async function loadState() {
  const all = await chrome.storage.local.get(null);
  state.all = all;
  state.profile = store.sanitizeProfile(all.profile);
  state.profiles = all.profiles || [{ id: 'p1', title: 'Профиль 1' }];
  state.activeProfile = all.activeProfile || 'p1';
  state.settings = { ...store.DEFAULT_SETTINGS, ...(all.settings || {}) };
  state.sources = all.sources || [];
  state.resume = all.resume || null;
  state.scored = scoreAll(store.vacanciesFrom(all), state.profile, state.resume?.text || '');
}

const isLive = (v) => !['hidden', 'rejected'].includes(v.status);
const matching = (rows) => rows.filter(({ v, s }) => isLive(v) && s.score >= state.settings.matchScore);

// ---------------- Главная ----------------

// Часы: размеры считаем по реальным контурам цифр (canvas measureText), чтобы время
// и дата были ровно друг под другом и одной ширины, без «воздуха» по бокам.
const CLOCK_FONT = '600 100px Manrope';
const STROKE = 7;
let clockShown = '';
function inkBox(ctx, str) {
  const m = ctx.measureText(str);
  return { left: m.actualBoundingBoxLeft, right: m.actualBoundingBoxRight, ascent: m.actualBoundingBoxAscent, descent: m.actualBoundingBoxDescent };
}

function renderClock() {
  const d = new Date();
  const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const date = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  if (`${t}|${date}` === clockShown) return;
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = CLOCK_FONT;
  const tm = inkBox(ctx, t);
  const dm = inkBox(ctx, date);
  const half = STROKE / 2;
  const timeW = tm.left + tm.right + STROKE;
  const k = timeW / (dm.left + dm.right); // дата растягивается до ширины времени
  const time = $('clockText');
  const dt = $('clockDate');
  time.textContent = t;
  time.setAttribute('x', tm.left + half);
  time.setAttribute('y', tm.ascent + half);
  const timeBottom = tm.ascent + tm.descent + STROKE;
  const gap = (tm.ascent + tm.descent) * 0.2;
  dt.textContent = date;
  dt.style.fontSize = `${100 * k}px`; // style, а не атрибут: атрибут перебивается CSS
  dt.setAttribute('x', dm.left * k);
  dt.setAttribute('y', timeBottom + gap + dm.ascent * k);
  const h = timeBottom + gap + (dm.ascent + dm.descent) * k;
  $('clockSvg').setAttribute('viewBox', `0 0 ${timeW.toFixed(1)} ${h.toFixed(1)}`);
  // Доля высоты часов, которую занимает время, — по ней «/ поддержка» встаёт по центру строки.
  $('mainTile').style.setProperty('--time-frac', (timeBottom / h).toFixed(3));
  clockShown = `${t}|${date}`;
}

function renderLimit() {
  const n = Number(state.settings.scanLimit) || 100;
  let preset = false;
  document.querySelectorAll('.limit button').forEach((b) => {
    const on = Number(b.dataset.limit) === n;
    preset ||= on;
    b.classList.toggle('on', on);
  });
  const inp = $('limitInput');
  if (document.activeElement !== inp) inp.value = preset ? '' : String(n);
  inp.classList.toggle('on', !preset);
  const hint = limitHint(n);
  $('limitHint').textContent = hint.short;
  $('limitHint').title = hint.long;
  $('limitHint').classList.toggle('warn', hint.deep);
}

// Лимит — на весь поиск, делится между включёнными источниками.
function limitHint(n) {
  const k = state.sources.filter((s) => s.enabled).length;
  if (k <= 1) return { short: '', long: '', deep: false };
  const plan = store.budgetPlan(k, n);
  if (plan.deep) {
    return {
      short: `${k} ист. · по ~${plan.per}`,
      long: `Источников (${k}) много для лимита ${n}: на каждый не выходит даже страницы выдачи. Каждый источник всё равно будет проверен — по первой странице (~${plan.per} вакансий), всего около ${plan.total}. Это займёт больше времени, зато ничего не пропустим. Повторный поиск проверяет только новые вакансии и идёт быстро.`,
      deep: true,
    };
  }
  return { short: `≈${plan.per} на источник`, long: `${n} новых вакансий делятся между ${k} источниками: примерно по ${plan.per}. Если в источнике новых меньше, остаток достаётся следующим.`, deep: false };
}

async function setLimit(n) {
  const v = Math.max(1, Math.min(5000, Math.round(Number(n) || 0)));
  if (!v) return;
  await store.saveSettings({ ...(await store.getSettings()), scanLimit: v });
  toast(`За поиск проверю до ${v} новых ${plural(v, 'вакансии', 'вакансий', 'вакансий')} — поровну между источниками. ${limitHint(v).long}`.trim());
}

function renderSourceTiles() {
  const prog = state.status.progress;
  const running = state.status.running;
  for (const p of PLATFORMS) {
    const tile = document.querySelector(`.t-${p}`);
    const rows = state.scored.filter(({ v }) => v.platform === p);
    const good = matching(rows);
    const fresh = good.filter(({ v }) => v.status === 'new');
    const srcs = state.sources.filter((s) => s.platform === p);
    const states = srcs.map((s) => state.all[`srcstate:${s.id}`] || {});
    const blocked = states.some((st) => st.lastStatus === 'blocked');
    const last = states.map((st) => st.lastRunAt).filter(Boolean).sort().pop();
    const scanning = running && prog?.current?.platform === p;
    const queued = running && prog?.queue?.some((q) => q.platform === p);

    tile.classList.toggle('scanning', scanning);
    tile.classList.toggle('has-new', fresh.length > 0);
    tile.querySelector('.count').textContent = rows.length || srcs.length ? good.length.toLocaleString('ru-RU') : '';
    tile.title = `${store.PLATFORM_NAMES[p]}: подходят вам ${good.length} из ${rows.length} собранных, новых ${fresh.length}`;

    let sub;
    if (scanning) sub = prog.page ? `ищу… стр. ${prog.page} · ${prog.found || 0} вак.` : 'ищу…';
    else if (queued) sub = 'в очереди';
    else if (!srcs.length) sub = p === 'hh' || p === 'avito' ? 'укажите должность в профиле' : '+ добавить источник';
    else if (blocked) sub = '⚠ сайт просит проверку — откройте';
    else if (!last) sub = `${srcs.length} ${plural(srcs.length, 'источник', 'источника', 'источников')} · ещё не искали`;
    else {
      const onSite = states.map((st) => st.lastTotal).filter((n) => n > 0).reduce((a, b) => a + b, 0);
      sub = `подходят ${good.length} из ${rows.length}${onSite ? ` · на сайте ${onSite.toLocaleString('ru-RU')}` : ` · ${fmtTime(last)}`}`;
    }
    tile.querySelector('.sub').textContent = sub;
    tile.classList.toggle('warn', blocked && !scanning);
  }
}

function renderMain() {
  const p = state.profile;
  $('whoName').textContent = p.name || 'Ваше имя';
  $('whoName').classList.toggle('placeholder', !p.name);
  $('whoPosition').textContent = p.position || 'укажите желаемую должность';
  $('whoPosition').classList.toggle('placeholder', !p.position);

  const { running, progress } = state.status;
  const btn = $('findBtn');
  btn.classList.toggle('busy', running);
  $('stopBtn').hidden = !running;
  $('mainTile').classList.toggle('running', Boolean(running));
  // Реклама — только пока идёт поиск, на месте часов и имени.
  const showAd = Boolean(running) && ad.enabled;
  $('mainTile').classList.toggle('with-ad', showAd);
  if (showAd) ad.show(); else ad.hide();
  $('eta').hidden = !running;
  if (running) $('etaText').textContent = etaLine(progress?.etaSec);
  if (running && progress?.total) {
    const cur = progress.current;
    // Коротко, в одну строку: площадка · страница · сколько собрано · какой источник по счёту.
    const step = progress.detail ? 'описания' : progress.page ? `стр. ${progress.page} · ${progress.found || 0} вак.` : 'открываю';
    $('findText').textContent = `Ищу: ${cur ? store.PLATFORM_NAMES[cur.platform] : '…'} · ${step} · ${Math.min(progress.done + 1, progress.total)}/${progress.total}`;
    btn.title = cur ? `Сейчас: ${cur.name}` : '';
    $('findFill').style.width = `${Math.round((progress.done / progress.total) * 100)}%`;
  } else if (running) {
    $('findText').textContent = 'Ищу…';
    $('findFill').style.width = '0%';
  } else {
    $('findText').textContent = '/ Найти работу';
    $('findFill').style.width = '0%';
  }
}

// «осталось ≈ 3:12 · готово к 16:15». Оценка — по числу страниц и описаний и по прошлым поискам.
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s >= 3600) return `${Math.floor(s / 3600)} ч ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} мин`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function etaLine(sec) {
  if (sec == null) return 'считаю время…';
  if (sec <= 5) return 'почти готово…';
  const end = new Date(Date.now() + sec * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `осталось ≈ ${fmtDuration(sec)} · готово к ${end}`;
}
const aboutMin = (sec) => (sec < 90 ? 'около минуты' : `около ${Math.round(sec / 60)} ${plural(Math.round(sec / 60), 'минуты', 'минут', 'минут')}`);

function renderProfileTile() {
  const p = state.profile;
  const cur = state.profiles.find((x) => x.id === state.activeProfile);
  document.querySelector('.t-profile .tile-title').textContent = state.profiles.length > 1 ? `Профиль: ${cur?.title || ''}` : 'Профиль и резюме';
  const el = $('profileTile');
  const ps = profileSkills(p);
  const empty = !p.position && !ps.length && !state.resume;
  if (empty) {
    el.replaceChildren(h('p', { class: 'cta' }, 'Начните здесь: должность, навыки и резюме — по ним подбираются вакансии.'));
    return;
  }
  const conds = [
    p.grade ? GRADE_LABEL[p.grade] : null,
    p.minSalary ? `от ${p.minSalary.toLocaleString('ru-RU')} ₽` : null,
    (p.formats || []).length && p.formats.length < 3 ? p.formats.map((f) => ({ remote: 'удалённо', hybrid: 'гибрид', office: 'офис' }[f])).join(', ') : null,
  ].filter(Boolean);
  el.replaceChildren(...[
    h('div', { class: 'resume-pill' }, state.resume ? `📄 ${state.resume.name}` : '📄 Загрузите резюме'),
    conds.length ? h('p', { class: 'conds' }, conds.join(' · ')) : null,
    h('div', { class: 'tile-chips' }, [...ps].sort((a, b) => b.primary - a.primary).slice(0, 12).map((s) => h('span', { class: s.primary ? 'primary' : '' }, s.name))),
  ].filter(Boolean));
}

function openVacancy(e, v) {
  e.stopPropagation();
  if (v.status === 'new') store.setUserFields(v.key, { status: 'viewed' });
}

// Оставляем столько пунктов, сколько целиком помещается в плитку, — без обрезанных строк.
function fitList(box, more) {
  const ul = box.querySelector('ul, ol');
  if (!ul) return 0;
  let hidden = 0;
  const overflow = () => box.scrollHeight > box.clientHeight + 1;
  while (ul.children.length > 1 && overflow()) { ul.lastElementChild.remove(); hidden++; }
  if (hidden && more) {
    const total = () => hidden;
    ul.append(more(total()));
    while (ul.children.length > 2 && overflow()) { ul.children[ul.children.length - 2].remove(); hidden++; ul.lastElementChild.replaceWith(more(total())); }
  }
  return hidden;
}

function renderTopTile() {
  const rows = matching(state.scored).filter(({ v }) => ['new', 'viewed'].includes(v.status)).sort((a, b) => b.s.score - a.s.score).slice(0, 6);
  $('topTile').replaceChildren(rows.length
    ? h('ol', { class: 'mini-list' }, rows.map(({ v, s }) => h('li', {},
      h('span', { class: 'mini-score' }, Math.round(s.score * 100)),
      h('a', { href: v.url, target: '_blank', rel: 'noopener', onclick: (e) => openVacancy(e, v) },
        h('span', { class: 'mini-title' }, v.title),
        h('span', { class: 'mini-sub' }, [v.company, store.PLATFORM_NAMES[v.platform]].filter(Boolean).join(' · '))))))
    : h('p', { class: 'cta' }, state.scored.length ? 'Новых подходящих нет — загляните позже или ослабьте условия в профиле.' : 'Нажмите «/ Найти работу» — здесь появятся лучшие совпадения.'));
  fitList($('topTile'));
  const f = funnelCounts();
  $('topMore').textContent = f.good ? `Все ${f.good} подходящих и воронка →` : 'Все вакансии и воронка →';
}

// Те же числа, что на плитках источников и в «Поиске»: «подходят» = сумма по источникам.
function funnelCounts() {
  const good = matching(state.scored);
  const c = {};
  for (const { v } of state.scored) c[v.status] = (c[v.status] || 0) + 1;
  return {
    good: good.length,
    unseen: good.filter(({ v }) => v.status === 'new').length,
    viewed: c.viewed || 0, responded: c.responded || 0, applied: c.applied || 0, interview: c.interview || 0, offer: c.offer || 0, rejected: c.rejected || 0, hidden: c.hidden || 0,
    mine: store.MY_STATUSES.reduce((n, k) => n + (c[k] || 0), 0),
  };
}

const partners = createPartnerTile($('partnersTile'));

function renderSearchTile() {
  const runs = state.all.runs || [];
  const last = runs[0];
  const srcStates = state.sources.map((s) => state.all[`srcstate:${s.id}`] || {});
  const problems = srcStates.filter((st) => st.lastStatus === 'blocked' || st.lastStatus === 'failed').length;
  const next = srcStates.map((st) => st.nextRunAt).filter(Boolean).sort()[0];
  const total = state.scored.length;
  const good = funnelCounts().good;
  const auto = state.settings.autoRun;
  $('searchTile').replaceChildren(h('dl', { class: 'facts' },
    h('dt', {}, 'Последний поиск'), h('dd', {}, last ? fmtTime(last.at) : 'ещё не было'),
    h('dt', {}, 'Подходят вам'), h('dd', {}, `${good} из ${total} собранных`),
    h('dt', {}, 'Источников'), h('dd', {}, `${state.sources.filter((s) => s.enabled).length}${problems ? ` · ⚠ ${problems} с проблемой` : ''}`),
    h('dt', {}, 'Авто-поиск'), h('dd', {}, !auto ? 'выключен' : !state.all.autoArmed && !runs.length ? 'включится после первого поиска' : next ? `следующий ${fmtTime(next)}` : 'включён')));
}

// «Мои отклики»: всё, кроме «Не смотрел» и «Просмотрел», свежие изменения сверху.
function renderAppliedTile() {
  const rows = state.scored.filter(({ v }) => store.MY_STATUSES.includes(v.status))
    .sort((a, b) => Date.parse(b.v.statusChangedAt || 0) - Date.parse(a.v.statusChangedAt || 0));
  $('appliedTile').replaceChildren(rows.length
    ? h('ul', { class: 'mini-list plain' }, rows.slice(0, 8).map(({ v }) => {
      const d = daysSince(v.statusChangedAt);
      const waiting = store.WAITING_STATUSES.includes(v.status);
      const note = waiting ? `${STATUS_LABEL[v.status]} · ${d >= 7 ? `ждёт ответа ${d} дн — напомните о себе` : `ждёт ответа ${d ?? 0} дн`}` : STATUS_LABEL[v.status];
      return h('li', {}, h('a', { href: v.url, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() },
        h('span', { class: 'mini-title' }, v.title),
        h('span', { class: `mini-sub ${waiting && d >= 7 ? 'late' : ''}` }, [v.company, note].filter(Boolean).join(' · '))));
    }))
    : h('p', { class: 'cta' }, 'Отметьте у вакансии «Откликнулся» или «Отправил резюме» — она появится здесь, и вы не забудете про ответ.'));
  fitList($('appliedTile'), (n) => h('li', { class: 'mini-more' }, `и ещё ${n} — открыть все →`));
}

function renderHome() {
  renderLimit();
  renderSourceTiles();
  renderMain();
  renderProfileTile();
  renderTopTile();
  partners.update(state.profile);
  renderSearchTile();
  renderAppliedTile();
}

// ---------------- Панели ----------------

const DRAWERS = {
  hh: { title: 'hh.ru', platform: 'hh' },
  avito: { title: 'Avito', platform: 'avito' },
  telegram: { title: 'Telegram', platform: 'telegram' },
  generic: { title: 'Сайты компаний', platform: 'generic' },
  profile: { title: 'Профиль и резюме' },
  all: { title: 'Подходящие вакансии и воронка' },
  applied: { title: 'Мои отклики' },
  search: { title: 'Поиск и настройки' },
};

let drawer = null; // { kind, list, refresh, guard }

function openDrawer(kind) {
  const def = DRAWERS[kind];
  if (!def) return closeDrawer();
  const body = $('drawerBody');
  $('drawer').className = `drawer open dk-${kind}`;
  $('drawer').setAttribute('aria-hidden', 'false');
  $('scrim').hidden = false;
  document.body.classList.add('drawer-open');
  $('drawerTitle').replaceChildren(...[def.platform ? logo(def.platform, 'small') : null, h('span', {}, def.title)].filter(Boolean));
  body.scrollTop = 0;

  drawer = { kind };
  if (def.platform) buildPlatformDrawer(body, def.platform);
  else if (kind === 'profile') buildProfileDrawer(body);
  else if (kind === 'all') buildListDrawer(body, { showStatusTabs: true, showPlatform: true, funnel: true });
  else if (kind === 'applied') buildListDrawer(body, { statuses: store.MY_STATUSES, showStatusTabs: true, showPlatform: true });
  else if (kind === 'search') buildSearchDrawer(body);
}

function closeDrawer() {
  $('drawer').className = 'drawer';
  $('drawer').setAttribute('aria-hidden', 'true');
  $('scrim').hidden = true;
  document.body.classList.remove('drawer-open');
  drawer = null;
}

function buildListDrawer(body, { funnel = false, ...opts }) {
  const list = createVacancyList({ ...opts, matchScore: state.settings.matchScore });
  const excl = h('div', {});
  const stats = funnel ? h('div', { class: 'stats' }) : null;
  body.replaceChildren(...[stats, excl, list.el].filter(Boolean));
  drawer.refresh = () => {
    if (stats) {
      // Воронка — здесь же, над списком: сколько подходит и что с ними дальше.
      const f = funnelCounts();
      stats.replaceChildren(
        stat(f.good, 'подходят вам', `С оценкой «Подходит мне» от ${Math.round(state.settings.matchScore * 100)}%`),
        stat(f.unseen, 'ещё не смотрел'),
        stat(f.mine, 'в «Моих откликах»', 'Всё, кроме «Не смотрел» и «Просмотрел»'),
        stat(f.interview + f.offer, 'интервью и офферы'));
    }
    excl.replaceChildren(exclusionLine(state.scored));
    list.update(state.scored);
  };
  drawer.refresh();
}

function buildPlatformDrawer(body, platform) {
  const list = createVacancyList({ platform, matchScore: state.settings.matchScore });
  const stats = h('div', { class: 'stats' });
  const excl = h('div', {});
  const srcBox = h('div', {});
  const autoNote = (platform === 'hh' || platform === 'avito')
    ? h('p', { class: 'muted small' }, state.profile.position
      ? `Поиск по должности «${state.profile.position}» добавлен автоматически. Свой поиск с фильтрами точнее: настройте его на сайте и вставьте ссылку ниже.`
      : 'Укажите желаемую должность в профиле — поиск на этой площадке настроится сам. Или вставьте ссылку на свой поиск ниже.')
    : null;
  body.replaceChildren(
    stats,
    excl,
    h('section', { class: 'dsec' }, h('h3', {}, 'Подходящие вакансии'), list.el),
    h('section', { class: 'dsec' }, h('h3', {}, 'Источники'), autoNote, srcBox, addSourceForm(platform)));

  drawer.refresh = () => {
    const rows = state.scored.filter(({ v }) => v.platform === platform);
    const good = matching(rows);
    const srcs = state.sources.filter((s) => s.platform === platform);
    const onSite = srcs.map((s) => state.all[`srcstate:${s.id}`]?.lastTotal).filter((n) => n > 0);
    stats.replaceChildren(
      stat(onSite.length ? onSite.reduce((a, b) => a + b, 0) : '—', 'вакансий на сайте', 'Сколько вакансий площадка показывает по вашим ссылкам'),
      stat(rows.length, 'собрано', `Проверяем до ${state.settings.scanLimit} в каждом источнике — лимит меняется на главной`),
      stat(good.length, 'подходят вам', `С оценкой «Подходит мне» от ${Math.round(state.settings.matchScore * 100)}%`),
      stat(good.filter(({ v }) => v.status === 'new').length, 'ещё не смотрели'));
    excl.replaceChildren(exclusionLine(rows));
    list.update(rows);
    if (!isEditing(srcBox)) srcBox.replaceChildren(sourceRows(srcs, state.all));
  };
  drawer.refresh();
}

// «Отсеяно фильтрами профиля: 120 — другая должность 90, другой город 25».
function exclusionLine(rows) {
  const by = exclusionStats(rows);
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  if (!total) return h('div', { class: 'excl', hidden: true });
  const parts = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} — ${n}`).join(', ');
  return h('div', { class: 'excl' }, 'Отсеяно по вашему профилю: ', h('b', {}, total), ` (${parts}). `,
    h('a', { href: '#profile' }, 'Изменить фильтры в профиле'));
}

const stat = (n, label, title) => h('div', { class: 'stat', title }, h('b', {}, typeof n === 'number' ? n.toLocaleString('ru-RU') : n), h('span', {}, label));

// Перерисовываем блок, только если вы в нём сейчас ничего не вводите.
// (Раньше проверялся любой фокус — и после «Удалить» список не обновлялся.)
const isEditing = (box) => {
  const a = document.activeElement;
  return box.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(a.type)));
};

async function buildProfileDrawer(body) {
  drawer.refresh = null; // форму не перерисовываем на лету
  await renderProfile(body, {
    onSaved: () => toast('Профиль сохранён — оценки всех вакансий пересчитаны'),
    onSwitched: async () => {
      await loadState();
      renderHome();
      await buildProfileDrawer(body);
      toast(`Профиль: ${state.profiles.find((x) => x.id === state.activeProfile)?.title || ''}`);
    },
  });
}

function buildSearchDrawer(body) {
  const s = state.settings;
  const auto = h('input', { type: 'checkbox', checked: s.autoRun });
  const locked = h('input', { type: 'checkbox', checked: s.skipWhenLocked });
  const openIn = h('select', {}, h('option', { value: 'tab', selected: s.openIn === 'tab' }, 'в фоновой вкладке'), h('option', { value: 'window', selected: s.openIn === 'window' }, 'в свёрнутом окне'));
  const match = h('input', { type: 'number', min: 10, max: 95, step: 5, value: Math.round(s.matchScore * 100) });
  const notify = h('input', { type: 'number', min: 0, max: 100, step: 5, value: Math.round(s.notifyScore * 100) });
  const retention = h('input', { type: 'number', min: 0, max: 3650, value: s.retentionDays || 0, title: '0 — никогда не удалять' });
  const saved = h('span', { class: 'muted small' });

  const settingsForm = h('form', { class: 'settings', onsubmit: async (e) => {
    e.preventDefault();
    await store.saveSettings({
      ...(await store.getSettings()),
      autoRun: auto.checked,
      skipWhenLocked: locked.checked,
      openIn: openIn.value,
      matchScore: Math.min(0.95, Math.max(0.1, (Number(match.value) || 50) / 100)),
      notifyScore: (Number(notify.value) || 0) / 100,
      retentionDays: Math.max(0, Number(retention.value) || 0),
    });
    saved.textContent = 'Сохранено';
    setTimeout(() => { saved.textContent = ''; }, 2500);
  } },
  h('label', { class: 'check' }, auto, 'Искать автоматически, пока открыт браузер'),
  h('label', { class: 'check' }, locked, 'Не искать, когда экран заблокирован'),
  h('div', { class: 'grid3' },
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Открывать сайты'), openIn),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Вакансия «подходит» с оценки, %'), match),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Уведомлять с оценки, %'), notify),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Удалять нетронутые через, дней (0 — никогда)'), retention)),
  h('div', { class: 'savebar' }, h('button', { class: 'btn primary', type: 'submit' }, 'Сохранить'), saved));

  const srcBox = h('div', {});
  const logBody = h('tbody', {});
  const importFile = h('input', { type: 'file', accept: 'application/json', hidden: true, onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (Array.isArray(data.solkJobSources)) {
        const n = await store.importSources(data.solkJobSources);
        toast(n ? `Добавлено источников: ${n}` : 'Все источники из файла у вас уже есть');
        return;
      }
      if (confirm(`Восстановить ${Object.keys(data).length} записей из копии? Совпадающие данные будут заменены.`)) {
        await chrome.storage.local.set(data);
        toast('Данные восстановлены');
      }
    } catch (err) { alert(`Не получилось прочитать файл: ${err.message}`); }
  } });

  body.replaceChildren(
    h('section', { class: 'dsec' }, h('h3', {}, 'Как искать'), settingsForm),
    h('section', { class: 'dsec' }, h('h3', {}, 'Все источники'), srcBox),
    telegramSection(),
    shareSection(),
    h('section', { class: 'dsec' }, h('h3', {}, 'Данные'),
      h('p', { class: 'muted small' }, 'Всё хранится только в этом браузере. Сделайте резервную копию, если переустанавливаете расширение.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: exportCsv }, 'Скачать вакансии (Excel/CSV)'),
        h('button', { class: 'btn', type: 'button', onclick: async () => download(`solk-job-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await chrome.storage.local.get(null)), 'application/json') }, 'Резервная копия'),
        h('button', { class: 'btn', type: 'button', onclick: () => importFile.click() }, 'Восстановить из копии / добавить источники'),
        importFile),
      h('div', { class: 'danger-zone' },
        h('div', {}, h('b', {}, 'Сбросить статистику'),
          h('p', { class: 'muted small' }, 'Удалит все собранные вакансии, статусы откликов, заметки и журнал. Источники, профили, резюме и настройки останутся.')),
        h('button', { class: 'btn danger', type: 'button', onclick: async () => {
          if (!confirm('Сбросить всю статистику? Собранные вакансии, статусы откликов и заметки будут удалены.')) return;
          if (!confirm('Точно? Это нельзя отменить. Если нужно — сначала сделайте «Резервную копию».')) return;
          const n = await store.resetStats();
          toast(`Статистика сброшена: удалено ${n} вакансий. Нажмите «/ Найти работу», чтобы собрать заново.`);
        } }, 'Сбросить статистику'))),
    h('section', { class: 'dsec' }, h('h3', {}, 'Журнал поиска'),
      h('table', { class: 'log' }, h('thead', {}, h('tr', {}, ['Когда', 'Источник', 'Итог', 'Найдено', 'Новых', 'Комментарий'].map((t) => h('th', {}, t)))), logBody)));

  drawer.refresh = () => {
    if (!isEditing(srcBox)) srcBox.replaceChildren(sourceRows(state.sources, state.all));
    const runs = (state.all.runs || []).slice(0, 60);
    logBody.replaceChildren(...(runs.length ? runs.map((r) => h('tr', {},
      h('td', {}, fmtTime(r.at)), h('td', {}, r.source), h('td', { class: `st-${r.status}` }, { ok: 'ok', empty: 'пусто', failed: 'ошибка', blocked: 'проверка', partial: 'частично', stopped: 'остановлено' }[r.status] || r.status),
      h('td', {}, r.found ?? ''), h('td', {}, r.added ?? ''), h('td', { class: 'muted' }, r.error || '')))
      : [h('tr', {}, h('td', { colspan: 6, class: 'empty' }, 'Поиска ещё не было.'))]));
  };
  drawer.refresh();
}

// Уведомления о новых подходящих вакансиях в Telegram (через бота solk / job).
function telegramSection() {
  const status = h('p', { class: 'muted small' });
  const actions = h('div', { class: 'row' });
  const sec = h('section', { class: 'dsec' }, h('h3', {}, 'Уведомления в Telegram'), status, actions);
  let poll = null;
  const draw = (link, note = '') => {
    clearInterval(poll);
    if (!tg.tgEnabled()) {
      status.textContent = 'Скоро: бот solk / job будет присылать новые подходящие вакансии в Telegram и отвечать на вопросы.';
      actions.replaceChildren(h('button', { class: 'btn', type: 'button', disabled: true }, 'Подключить Telegram'));
      return;
    }
    if (link?.linked) {
      status.textContent = `Подключено${link.name ? ` (${link.name})` : ''}: новые вакансии с оценкой от ${Math.round(state.settings.notifyScore * 100)}% придут в Telegram.${note ? ` ${note}` : ''}`;
      actions.replaceChildren(
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          const ok = await tg.sendToTelegram('Проверка: уведомления работают', [{ title: 'Так будет выглядеть новая вакансия', company: 'solk / job', score: 100, url: 'https://t.me' }]).catch(() => false);
          draw(await tg.getLink(), ok ? 'Тестовое сообщение отправлено.' : 'Не получилось отправить — проверьте бота.');
        } }, 'Отправить тест'),
        h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await tg.unlink(); draw(null); } }, 'Отключить'));
      return;
    }
    status.textContent = link?.token
      ? 'Откройте бота в Telegram и нажмите «Запустить» (Start) — подключение проверится само.'
      : 'Новые подходящие вакансии будут приходить в Telegram. Нажмите кнопку — откроется бот, нажмите в нём «Запустить».';
    actions.replaceChildren(h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      const url = await tg.startLink();
      window.open(url, '_blank', 'noopener');
      draw(await tg.getLink());
    } }, link?.token ? 'Открыть бота ещё раз' : 'Подключить Telegram'));
    if (link?.token) {
      const until = Date.now() + 3 * 60e3;
      poll = setInterval(async () => {
        if (Date.now() > until || !sec.isConnected) { clearInterval(poll); return; }
        const next = await tg.checkLink().catch(() => null);
        if (next?.linked) draw(next, 'Готово!');
      }, 3000);
    }
  };
  tg.getLink().then((l) => draw(l));
  return sec;
}

// «Поделиться»: у каждого человека своя копия расширения и свои данные.
// Отдаём установочный архив и, по желанию, свои источники.
async function downloadExtensionZip(btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Собираю архив…';
  try {
    const list = await (await fetch(chrome.runtime.getURL('files.json'))).json();
    const files = await Promise.all([...list, 'files.json'].map(async (name) => ({
      name: `solk-job/${name}`,
      data: new Uint8Array(await (await fetch(chrome.runtime.getURL(name))).arrayBuffer()),
    })));
    const { version } = chrome.runtime.getManifest();
    download(`solk-job-${version}.zip`, makeZip(files), 'application/zip');
  } catch (e) {
    alert(`Не получилось собрать архив: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function shareSection() {
  const zipBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => downloadExtensionZip(zipBtn) }, 'Скачать расширение для друга (.zip)');
  return h('section', { class: 'dsec' }, h('h3', {}, 'Поделиться'),
    h('p', { class: 'muted small' }, 'Расширение работает в браузере каждого человека: у него будут свои профиль, резюме и вакансии, ваши данные он не увидит. Отправьте ему архив в мессенджере, по почте или ссылкой (Яндекс Диск, Google Drive).'),
    h('div', { class: 'row' },
      zipBtn,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        const list = (await store.getSources()).filter((s) => !s.auto).map(({ url, name, platform, intervalMin }) => ({ url, name, platform, intervalMin }));
        download('solk-job-sources.json', JSON.stringify({ solkJobSources: list }, null, 1), 'application/json');
      } }, 'Скачать мои источники')),
    h('ol', { class: 'steps small' },
      h('li', {}, 'Другу: распаковать архив — появится папка «solk-job».'),
      h('li', {}, 'Открыть browser://extensions (Яндекс Браузер) или chrome://extensions (Chrome), включить «Режим разработчика».'),
      h('li', {}, 'Нажать «Загрузить распакованное расширение» и выбрать папку «solk-job».'),
      h('li', {}, 'Загрузить своё резюме — ссылки hh.ru и Avito настроятся сами. Ваши источники: «Данные» → «Восстановить из копии / добавить источники» → файл solk-job-sources.json.')));
}

function exportCsv() {
  const cols = ['Оценка', 'Статус', 'Должность', 'Компания', 'Зарплата от', 'Зарплата до', 'Валюта', 'Город', 'Источник', 'Ссылка', 'Дата', 'Заметка'];
  const esc = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const lines = [...state.scored].sort((a, b) => b.s.score - a.s.score).map(({ v, s }) => [
    Math.round(s.score * 100), STATUS_LABEL[v.status], v.title, v.company, v.salary?.from, v.salary?.to, v.salary?.currency,
    v.location, store.PLATFORM_NAMES[v.platform], v.url, (v.publishedAt || v.firstSeenAt || '').slice(0, 10), v.note,
  ].map(esc).join(';'));
  download(`solk-job-${new Date().toISOString().slice(0, 10)}.csv`, `﻿${cols.join(';')}\n${lines.join('\n')}`, 'text/csv');
}

// ---------------- Поиск ----------------

let toastTimer;
function toast(text) {
  let el = document.querySelector('.toast');
  if (!el) { el = h('div', { class: 'toast', role: 'status' }); document.body.append(el); }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

async function findWork() {
  const p = state.profile;
  if (!p.position && !(p.skills || []).length) {
    location.hash = 'profile';
    toast('Сначала укажите желаемую должность или навыки — по ним идёт поиск');
    return;
  }
  await store.syncAutoSources(p);
  const sources = (await store.getSources()).filter((s) => s.enabled);
  if (!sources.length) {
    location.hash = 'telegram';
    toast('Нет включённых источников — добавьте хотя бы один');
    return;
  }
  const r = await send({ type: 'runNow' });
  startedHere = Boolean(r?.started);
  if (r?.busy) toast('Поиск уже идёт');
  else if (r && !r.started) toast('Все источники уже проверены за последние 10 минут — результаты на плитках. Чтобы проверить больше вакансий, увеличьте лимит.');
  else if (r.deep) toast(`Источников ${r.total} — много для лимита ${state.settings.scanLimit}. Проверю каждый по первой странице (~${r.per} вакансий)${r.etaSec ? `, это займёт ${aboutMin(r.etaSec)}` : ''}: дольше, зато ничего не пропущу. Повторный поиск — только новые вакансии, быстро.`);
  else toast(`Ищу в ${r.total} ${plural(r.total, 'источнике', 'источниках', 'источниках')}${r.total > 1 ? `, примерно по ${r.per} новых вакансий в каждом` : ''}${r.etaSec ? `. Займёт ${aboutMin(r.etaSec)}` : ''}. Вкладки открываются в фоне и закрываются сами.`);
  pollStatus();
}

let pollTimer;
let startedHere = false; // итог показываем только для поиска, запущенного кнопкой на этой странице
async function pollStatus() {
  clearTimeout(pollTimer);
  const st = await send({ type: 'status' }).catch(() => null);
  if (st) {
    const wasRunning = state.status.running;
    state.status = st;
    renderMain();
    renderSourceTiles();
    if (wasRunning && !st.running && startedHere) {
      startedHere = false;
      const runs = (state.all.runs || []).slice(0, st.progress?.total || 0);
      const found = runs.reduce((n, r) => n + (r.found || 0), 0);
      const added = runs.reduce((n, r) => n + (r.added || 0), 0);
      toast(`Поиск завершён: проверено ${found}, новых ${added}, подходят вам ${funnelCounts().good}`);
    }
  }
  pollTimer = setTimeout(pollStatus, state.status.running ? 1000 : 5000);
}

// ---------------- Связка ----------------

function route() {
  // Воронка теперь внутри «Лучшее для вас».
  if (location.hash === '#funnel') { location.replace('#all'); return; }
  const kind = decodeURIComponent(location.hash.slice(1));
  if (kind && DRAWERS[kind]) openDrawer(kind);
  else closeDrawer();
}

let refreshTimer;
let lastRefresh = 0;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  // Во время поиска данные пишутся часто — не чаще раза в секунду.
  const wait = Math.max(150, 1000 - (Date.now() - lastRefresh));
  refreshTimer = setTimeout(async () => {
    lastRefresh = Date.now();
    await loadState();
    renderHome();
    drawer?.refresh?.();
  }, wait);
}

const ad = createAdSlot();

function bind() {
  document.querySelector('#mainTile .main-top').prepend(ad.el);
  $('supportLink').href = supportLink();
  document.querySelectorAll('[data-logo]').forEach((el) => el.replaceChildren(logo(el.dataset.logo)));
  document.querySelectorAll('[data-open]').forEach((el) => {
    const go = (e) => {
      if (e.target.closest('a')) return; // ссылки внутри плиток работают сами
      location.hash = el.dataset.open;
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === el) go(e); });
  });
  $('who').addEventListener('click', (e) => { e.stopPropagation(); location.hash = 'profile'; });
  $('findBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    // Состояние на странице может отставать на секунду — спрашиваем фон напрямую.
    const st = await send({ type: 'status' }).catch(() => null);
    if (st?.running) { toast('Поиск уже идёт — его можно остановить кнопкой «Стоп»'); return; }
    findWork();
  });
  $('stopBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    // Сразу возвращаем главную в исходное состояние, не дожидаясь фона.
    startedHere = false;
    state.status = { running: false, progress: { total: 0, done: 0, queue: [], stopped: true } };
    renderMain();
    renderSourceTiles();
    await send({ type: 'stop' });
    toast('Поиск остановлен. Найденное сохранено — поправьте профиль и нажмите «/ Найти работу» снова.');
    pollStatus();
  });
  $('supportLink').addEventListener('click', (e) => e.stopPropagation());
  document.querySelector('.brand-link').addEventListener('click', (e) => e.stopPropagation());
  // Плитки со списками подстраиваются под размер окна: без обрезанных строк.
  let fitTimer;
  window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => { renderTopTile(); renderAppliedTile(); }, 150); });
  document.querySelectorAll('.limit button').forEach((b) => b.addEventListener('click', () => setLimit(b.dataset.limit)));
  $('limitInput').addEventListener('change', (e) => setLimit(e.target.value));
  $('limitInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('scrim').addEventListener('click', () => { location.hash = ''; });
  document.querySelector('.drawer-close').addEventListener('click', (e) => { e.preventDefault(); location.hash = ''; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer) location.hash = ''; });
  window.addEventListener('hashchange', route);
  chrome.storage.onChanged.addListener((_c, area) => { if (area === 'local') scheduleRefresh(); });
}

// Доступ ко всем сайтам: если браузер выдал его только «по клику», просим разрешить.
const ALL_SITES = ['https://*/*', 'http://*/*'];
async function checkAccess() {
  const ok = await chrome.permissions.contains({ origins: ALL_SITES }).catch(() => true);
  $('accessBar').hidden = ok;
}
$('accessBtn').addEventListener('click', async () => {
  const ok = await chrome.permissions.request({ origins: ALL_SITES }).catch(() => false);
  if (ok) toast('Доступ разрешён — нажмите «/ Найти работу»');
  else toast('Браузер не дал доступ. Откройте настройки расширения → «Доступ к сайтам» → «На всех сайтах».');
  checkAccess();
});
chrome.permissions.onAdded?.addListener(checkAccess);
chrome.permissions.onRemoved?.addListener(checkAccess);

bind();
checkAccess();
await store.ensureProfiles();
renderClock();
// Шрифт подгружается не сразу — после загрузки пересчитываем размеры часов.
document.fonts.load(CLOCK_FONT).then(() => { clockShown = ''; renderClock(); });
setInterval(renderClock, 5000);
await loadState();
renderHome();
route();
pollStatus();
