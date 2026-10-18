// Список вакансий с фильтрами и карточками (используется во всех панелях).

import * as store from '../lib/store.js';
import { SKILL_NAMES } from '../lib/parse.js';
import { h, fmtTime, fmtDate, fmtSalary, daysSince } from './dom.js';
import { DEFAULT_TEMPLATES, renderLetter } from '../lib/letters.js';
import { remindersFor } from '../lib/reminders.js';

// Значение для <input type="datetime-local"> в местном времени.
const localInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
};

// Профиль и шаблоны писем для кнопки «Откликнуться» — их передаёт главная (setCardContext).
let ctx = { profile: {}, letters: null };
export function setCardContext(next) { ctx = { ...ctx, ...next }; }
const lettersCfg = () => ctx.letters || { templates: DEFAULT_TEMPLATES, defaultId: 'short', contacts: '' };
const say = (text) => window.dispatchEvent(new CustomEvent('solk-toast', { detail: text }));

export function letterFor(v, s, templateId) {
  const L = lettersCfg();
  const t = L.templates.find((x) => x.id === (templateId || L.defaultId)) || L.templates[0];
  return renderLetter(t, { vacancy: v, profile: ctx.profile, matched: s?.matched || [], contacts: L.contacts });
}

// Отклик в один клик: письмо — в буфер обмена, вакансия — в новой вкладке, статус — «Откликнулся».
// На hh.ru расширение само нажимает «Откликнуться» и вставляет письмо в форму.
export async function respond(v, s, letter = letterFor(v, s)) {
  let copied = false;
  try { await navigator.clipboard.writeText(letter); copied = true; } catch { /* нет доступа к буферу */ }
  chrome.runtime.sendMessage({ type: 'respondAssist', url: v.url, letter, platform: v.platform }).catch(() => {});
  if (['new', 'viewed'].includes(v.status)) await store.setUserFields(v.key, { status: 'responded' });
  say(v.platform === 'hh'
    ? 'Открываю вакансию на hh.ru: нажму «Откликнуться» и вставлю письмо. Проверьте его перед отправкой.'
    : copied ? 'Письмо скопировано — вставьте его в форму отклика на сайте (Ctrl+V). Статус: «Откликнулся».' : 'Вакансия открыта. Статус: «Откликнулся».');
}

// Окно «Письмо»: выбрать шаблон, поправить текст, скопировать или откликнуться.
export function openLetterDialog(v, s) {
  const L = lettersCfg();
  const area = h('textarea', { class: 'letter-text', rows: 14 }, letterFor(v, s));
  const pick = h('select', { onchange: (e) => { area.value = letterFor(v, s, e.target.value); } },
    L.templates.map((t) => h('option', { value: t.id, selected: t.id === L.defaultId }, t.name)));
  const dlg = h('dialog', { class: 'letter-dialog', onclose: () => dlg.remove() },
    h('form', { method: 'dialog', class: 'letter-form' },
      h('div', { class: 'letter-head' }, h('b', {}, `Письмо: ${v.title}`), h('button', { class: 'link muted', value: 'cancel' }, '✕')),
      h('label', { class: 'flabel' }, 'Шаблон', pick),
      area,
      h('p', { class: 'muted small' }, 'Шаблоны и контакты для подписи — в «Поиск и настройки» → «Сопроводительные письма».'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: async () => { await respond(v, s, area.value); dlg.close(); } }, 'Откликнуться с этим письмом'),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(area.value); say('Письмо скопировано'); } catch { area.select(); say('Выделил текст — нажмите Ctrl+C'); }
        } }, 'Скопировать'))));
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

const GRADE_LABEL = { intern: 'Стажёр', junior: 'Junior', middle: 'Middle', senior: 'Senior', lead: 'Lead' };
const FORMAT_LABEL = { remote: 'Удалённо', hybrid: 'Гибрид', office: 'Офис' };
const PAGE = 50;
const skillName = (k) => SKILL_NAMES[k] || k.replace(/^custom:/, '');

export function vacancyCard(v, s) {
  const pct = Math.round(s.score * 100);
  const setStatus = (status) => store.setUserFields(v.key, { status });
  const open = () => { if (v.status === 'new') setStatus('viewed'); };

  const noteBox = h('div', { class: 'vc-note', hidden: !v.note },
    h('textarea', {
      rows: 2,
      placeholder: 'Заметка: кому писали, контакты, дата интервью…',
      onchange: (e) => store.setUserFields(v.key, { note: e.target.value }),
    }, v.note));

  const salary = fmtSalary(v.salary);
  const waiting = store.WAITING_STATUSES.includes(v.status) ? daysSince(v.statusChangedAt) : null;

  return h('article', { class: `vc st-${v.status}`, 'data-key': v.key },
    h('div', { class: `vc-score ${pct >= 65 ? 'hi' : pct >= 45 ? 'mid' : ''}`, title: scoreTitle(s) }, h('b', {}, `${pct}%`), h('small', {}, 'подходит')),
    h('div', { class: 'vc-body' },
      h('h3', {},
        v.status === 'new' ? h('span', { class: 'vc-new', title: 'Ещё не смотрели' }) : null,
        h('a', { href: v.url, target: '_blank', rel: 'noopener', onclick: open, onauxclick: open }, v.title)),
      h('div', { class: 'vc-meta' },
        v.company ? h('span', { class: 'vc-company' }, v.company) : null,
        salary ? h('span', { class: 'vc-salary' }, salary) : null,
        s.otherCity ? h('span', { class: 'vc-remote', title: 'Город не из вашего профиля, но работа удалённая' }, `Удалёнка · ${s.otherCity}`) : v.location ? h('span', {}, v.location) : null,
        v.grades?.length ? h('span', {}, v.grades.map((g) => GRADE_LABEL[g]).join('/')) : null,
        v.formats?.length ? h('span', {}, v.formats.map((f) => FORMAT_LABEL[f]).join(', ')) : null,
        // Время — когда вакансию последний раз видел поиск CRM (совпадает с «Последний поиск»),
        // а не «N ч назад» от даты публикации: сайты часто дают только дату, и часы выходили неверными.
        h('span', { class: 'vc-src', title: `Впервые найдена: ${fmtTime(v.firstSeenAt)}${v.publishedAt ? ` · опубликована: ${fmtDate(v.publishedAt)}` : ''}` },
          `${store.PLATFORM_NAMES[v.platform]} · поиск ${fmtTime(v.lastSeenAt || v.firstSeenAt)}${v.publishedAt ? ` · опубл. ${fmtDate(v.publishedAt)}` : ''}`),
        waiting != null ? h('span', { class: `vc-wait ${waiting >= 7 ? 'late' : ''}` }, `ждёт ответа ${waiting} дн`) : null,
        v.status === 'interview' && v.interviewAt ? h('span', { class: 'vc-wait' }, `интервью ${fmtTime(v.interviewAt)}`) : null),
      remindersFor(v).map((r) => h('div', { class: 'vc-remind' }, `⏰ ${r.text}`)),
      v.status === 'interview' ? h('label', { class: 'vc-iv' }, 'Дата и время интервью',
        h('input', { type: 'datetime-local', value: localInput(v.interviewAt), onchange: (e) => store.setUserFields(v.key, { interviewAt: e.target.value ? new Date(e.target.value).toISOString() : null }) }),
        h('span', { class: 'muted small' }, 'напомню накануне и за 3 часа')) : null,
      h('div', { class: 'vc-why' }, whyLine(s)),
      (v.snippet || v.description) ? h('p', { class: 'vc-snippet' }, (v.snippet || v.description).slice(0, 360)) : null,
      (s.matched.length || s.missing.length) ? h('div', { class: 'chips' },
        s.matched.map((k) => h('span', { class: 'chip ok', title: 'Есть у вас' }, skillName(k))),
        s.missing.slice(0, 6).map((k) => h('span', { class: 'chip miss', title: 'Нет в профиле' }, skillName(k)))) : null,
      v.alsoAt?.length ? h('div', { class: 'vc-also' }, 'Также: ',
        v.alsoAt.map((a, i) => [i ? ', ' : '', h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.source || store.PLATFORM_NAMES[a.platform])])) : null,
      noteBox),
    h('div', { class: 'vc-side' },
      ['new', 'viewed'].includes(v.status) ? h('button', { class: 'btn small primary vc-respond', type: 'button', title: 'Откроет вакансию, скопирует сопроводительное письмо и поставит статус «Откликнулся»', onclick: () => respond(v, s) }, 'Откликнуться') : null,
      h('select', { class: `status-sel st-${v.status}`, title: 'Статус', onchange: (e) => setStatus(e.target.value) },
        store.STATUSES.map(([k, label]) => h('option', { value: k, selected: k === v.status }, label))),
      h('button', { class: 'link', type: 'button', onclick: () => openLetterDialog(v, s) }, 'Письмо'),
      h('button', { class: 'link', type: 'button', onclick: () => { noteBox.hidden = !noteBox.hidden; if (!noteBox.hidden) noteBox.querySelector('textarea').focus(); } }, v.note ? 'Заметка ✎' : 'Заметка'),
      v.status !== 'hidden' ? h('button', { class: 'link muted', type: 'button', onclick: () => setStatus('hidden') }, 'Скрыть') : null));
}

// Короткое объяснение оценки прямо в карточке.
function whyLine(s) {
  if (s.excluded) return `Не подходит по профилю: ${s.excluded}${s.stopped ? ` «${s.stopped}»` : ''}`;
  if (!s.parts) return '';
  const p = s.parts;
  const w = s.weights || {};
  const out = [];
  out.push({ title: 'должность в названии ✓', description: 'должность в описании', company: 'должность в компании', any: 'должность не задана' }[s.where] || 'должность');
  if (w.skills) out.push(`навыки ${s.matched.length} из ${Math.ceil(s.skillsTotal || 0)}`);
  if (w.text) out.push(`похоже на резюме и опыт ${Math.round(p.text * 100)}%`);
  if (p.salary === 1) out.push('зарплата ✓');
  else if (p.salary === 0) out.push('зарплата ниже');
  if (p.grade === 1) out.push('грейд ✓');
  else if (p.grade === 0) out.push('другой грейд');
  return out.join(' · ');
}

function scoreTitle(s) {
  if (!s.parts) return s.excluded ? `Не подходит по фильтрам профиля: ${s.excluded}` : '';
  const p = s.parts;
  const pc = (x) => `${Math.round(x * 100)}%`;
  return `Навыки ${pc(p.skills)} · Похожесть текста ${pc(p.text)} · Должность ${pc(p.title)} · Грейд ${pc(p.grade)} · Зарплата ${pc(p.salary)} · Свежесть ${pc(p.fresh)}`;
}

// Список с панелью фильтров. opts.preset задаёт фиксированные условия панели.
export function createVacancyList({ platform = null, statuses = null, showStatusTabs = false, showPlatform = false, matchScore = 0.5 } = {}) {
  const st = { q: '', status: 'active', platform: platform || '', minScore: Math.round(matchScore * 100), sort: 'score', limit: PAGE, tab: statuses ? null : null };
  let data = [];

  const listEl = h('div', { class: 'vc-list' });
  const moreBtn = h('button', { class: 'btn ghost', type: 'button', hidden: true, onclick: () => { st.limit += PAGE; draw(); } });
  const tabsEl = h('div', { class: 'chips tabs-row' });

  const scoreVal = h('span', { class: 'muted' }, `${st.minScore}%`);
  const filters = h('div', { class: 'filters' },
    h('input', { type: 'search', placeholder: 'Поиск по названию, компании, тексту', oninput: (e) => { st.q = e.target.value.toLowerCase(); st.limit = PAGE; draw(); } }),
    statuses ? null : h('label', { class: 'flabel' }, 'Показать',
      h('select', { onchange: (e) => { st.status = e.target.value; st.limit = PAGE; draw(); } },
        h('option', { value: 'active' }, 'все, кроме скрытых и отказов'),
        h('option', { value: 'new' }, 'только непросмотренные'),
        h('option', { value: 'all' }, 'все, включая скрытые и отказы'))),
    showPlatform ? h('select', { onchange: (e) => { st.platform = e.target.value; st.limit = PAGE; draw(); } },
      h('option', { value: '' }, 'Все источники'),
      Object.entries(store.PLATFORM_NAMES).map(([k, n]) => h('option', { value: k, selected: k === st.platform }, n))) : null,
    statuses ? null : h('label', { class: 'range', title: 'Показывать вакансии, которые подходят вам не меньше чем на столько процентов' }, 'Подходит мне от',
      h('input', { type: 'range', min: 0, max: 100, step: 5, value: st.minScore, oninput: (e) => { st.minScore = Number(e.target.value); scoreVal.textContent = `${st.minScore}%`; st.limit = PAGE; draw(); } }),
      scoreVal),
    h('label', { class: 'flabel' }, 'Сортировка',
      h('select', { onchange: (e) => { st.sort = e.target.value; draw(); } },
        h('option', { value: 'score' }, 'сначала подходящие'),
        h('option', { value: 'date' }, 'сначала свежие'))));
  const hint = statuses ? null : h('details', { class: 'hint-box' },
    h('summary', {}, 'Что значат проценты и статусы?'),
    h('p', {}, '«Подходит мне» — насколько вакансия совпадает с вашим профилем: желаемая должность и её синонимы, навыки, текст резюме и «Чем я занимаюсь», зарплата, грейд и свежесть. Под каждой вакансией написано, из чего сложилась оценка. Ползунок скрывает вакансии ниже выбранного процента — только те, что вы ещё не разбирали.'),
    h('p', {}, 'Статусы ставите вы сами: «Откликнулся» — нажали «Откликнуться» на сайте, «Отправил резюме» — отправили резюме, «Отказ» — работодатель ответил отказом, «Скрыто» — вакансия неинтересна. Всё, кроме «Не смотрел», «Просмотрел» и «Скрыто», попадает в «Мои отклики». Вакансии, снятые с публикации, исчезают из выдачи, но в «Моих откликах» остаются.'),
    h('p', {}, '«поиск сегодня 18:12» — когда вакансию последний раз видел поиск solk / job; «опубл.» — дата публикации на сайте.'));

  const root = h('div', { class: 'vc-wrap' }, showStatusTabs ? tabsEl : null, filters, hint, listEl, h('div', { class: 'center' }, moreBtn));

  function draw() {
    if (showStatusTabs) {
      const counts = {};
      for (const { v } of data) counts[v.status] = (counts[v.status] || 0) + 1;
      tabsEl.replaceChildren(...store.STATUSES.filter(([k]) => !statuses || statuses.includes(k)).map(([k, label]) => h('button', {
        type: 'button',
        class: `chip tab st-${k}${st.tab === k ? ' active' : ''}`,
        onclick: () => { st.tab = st.tab === k ? null : k; st.limit = PAGE; draw(); },
      }, `${label} · ${counts[k] || 0}`)));
    }
    const rows = data.filter(({ v, s }) => {
      if (st.platform && v.platform !== st.platform) return false;
      if (statuses && !statuses.includes(v.status)) return false;
      if (st.tab) {
        if (v.status !== st.tab) return false;
      } else if (!statuses) {
        if (st.status === 'active' && ['hidden', 'rejected'].includes(v.status)) return false;
        if (st.status === 'new' && v.status !== 'new') return false;
        // Порог оценки — только для неразобранных: то, с чем вы работаете, видно всегда.
        if (['new', 'viewed'].includes(v.status) && s.score * 100 < st.minScore) return false;
      }
      if (st.q && !`${v.title} ${v.company} ${v.description} ${v.snippet}`.toLowerCase().includes(st.q)) return false;
      return true;
    });
    const dateOf = (v) => Date.parse(v.publishedAt || v.firstSeenAt) || 0;
    rows.sort(st.sort === 'date' ? (a, b) => dateOf(b.v) - dateOf(a.v) : (a, b) => b.s.score - a.s.score || dateOf(b.v) - dateOf(a.v));

    if (!rows.length) {
      listEl.replaceChildren(h('div', { class: 'empty' }, data.length
        ? 'Под эти условия ничего не подошло. Снизьте порог оценки или измените фильтр.'
        : 'Здесь пока пусто. Нажмите «/ Найти работу» на главной — вакансии появятся по мере поиска.'));
      moreBtn.hidden = true;
      return;
    }
    listEl.replaceChildren(...rows.slice(0, st.limit).map(({ v, s }) => vacancyCard(v, s)));
    moreBtn.hidden = rows.length <= st.limit;
    moreBtn.textContent = `Показать ещё ${Math.min(PAGE, rows.length - st.limit)} из ${rows.length - st.limit}`;
  }

  return {
    el: root,
    update(scored) {
      // Пока открыта заметка, не перерисовываем — чтобы не потерять ввод.
      if (root.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return;
      data = scored;
      draw();
    },
  };
}
