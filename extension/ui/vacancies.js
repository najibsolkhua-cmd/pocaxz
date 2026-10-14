// Список вакансий с фильтрами и карточками (используется во всех панелях).

import * as store from '../lib/store.js';
import { SKILL_NAMES } from '../lib/parse.js';
import { h, ago, fmtSalary, daysSince } from './dom.js';

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
  const waiting = v.status === 'applied' ? daysSince(v.statusChangedAt) : null;

  return h('article', { class: `vc st-${v.status}`, 'data-key': v.key },
    h('div', { class: `vc-score ${pct >= 65 ? 'hi' : pct >= 45 ? 'mid' : ''}`, title: scoreTitle(s) }, pct),
    h('div', { class: 'vc-body' },
      h('h3', {},
        v.status === 'new' ? h('span', { class: 'vc-new', title: 'Ещё не смотрели' }) : null,
        h('a', { href: v.url, target: '_blank', rel: 'noopener', onclick: open, onauxclick: open }, v.title)),
      h('div', { class: 'vc-meta' },
        v.company ? h('span', { class: 'vc-company' }, v.company) : null,
        salary ? h('span', { class: 'vc-salary' }, salary) : null,
        v.location ? h('span', {}, v.location) : null,
        v.grades?.length ? h('span', {}, v.grades.map((g) => GRADE_LABEL[g]).join('/')) : null,
        v.formats?.length ? h('span', {}, v.formats.map((f) => FORMAT_LABEL[f]).join(', ')) : null,
        h('span', { class: 'vc-src' }, `${store.PLATFORM_NAMES[v.platform]} · ${ago(v.publishedAt || v.firstSeenAt)}`),
        waiting != null ? h('span', { class: `vc-wait ${waiting >= 7 ? 'late' : ''}` }, `ждёт ответа ${waiting} дн`) : null),
      (v.snippet || v.description) ? h('p', { class: 'vc-snippet' }, (v.snippet || v.description).slice(0, 360)) : null,
      (s.matched.length || s.missing.length) ? h('div', { class: 'chips' },
        s.matched.map((k) => h('span', { class: 'chip ok', title: 'Есть у вас' }, skillName(k))),
        s.missing.slice(0, 6).map((k) => h('span', { class: 'chip miss', title: 'Нет в профиле' }, skillName(k)))) : null,
      v.alsoAt?.length ? h('div', { class: 'vc-also' }, 'Также: ',
        v.alsoAt.map((a, i) => [i ? ', ' : '', h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.source || store.PLATFORM_NAMES[a.platform])])) : null,
      noteBox),
    h('div', { class: 'vc-side' },
      h('select', { class: `status-sel st-${v.status}`, title: 'Статус', onchange: (e) => setStatus(e.target.value) },
        store.STATUSES.map(([k, label]) => h('option', { value: k, selected: k === v.status }, label))),
      h('button', { class: 'link', type: 'button', onclick: () => { noteBox.hidden = !noteBox.hidden; if (!noteBox.hidden) noteBox.querySelector('textarea').focus(); } }, v.note ? 'Заметка ✎' : 'Заметка'),
      v.status !== 'hidden' ? h('button', { class: 'link muted', type: 'button', onclick: () => setStatus('hidden') }, 'Скрыть') : null));
}

function scoreTitle(s) {
  if (!s.parts) return s.stopped ? `Стоп-слово: ${s.stopped}` : '';
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
    statuses ? null : h('select', { onchange: (e) => { st.status = e.target.value; st.limit = PAGE; draw(); } },
      h('option', { value: 'active' }, 'Без скрытых и отказов'),
      h('option', { value: 'new' }, 'Только новые'),
      h('option', { value: 'all' }, 'Все статусы')),
    showPlatform ? h('select', { onchange: (e) => { st.platform = e.target.value; st.limit = PAGE; draw(); } },
      h('option', { value: '' }, 'Все источники'),
      Object.entries(store.PLATFORM_NAMES).map(([k, n]) => h('option', { value: k, selected: k === st.platform }, n))) : null,
    statuses ? null : h('label', { class: 'range' }, 'от',
      h('input', { type: 'range', min: 0, max: 100, step: 5, value: st.minScore, oninput: (e) => { st.minScore = Number(e.target.value); scoreVal.textContent = `${st.minScore}%`; st.limit = PAGE; draw(); } }),
      scoreVal),
    h('select', { onchange: (e) => { st.sort = e.target.value; draw(); } },
      h('option', { value: 'score' }, 'Сначала подходящие'),
      h('option', { value: 'date' }, 'Сначала свежие')));

  const root = h('div', { class: 'vc-wrap' }, showStatusTabs ? tabsEl : null, filters, listEl, h('div', { class: 'center' }, moreBtn));

  function draw() {
    if (showStatusTabs) {
      const counts = {};
      for (const { v } of data) counts[v.status] = (counts[v.status] || 0) + 1;
      tabsEl.replaceChildren(...store.STATUSES.map(([k, label]) => h('button', {
        type: 'button',
        class: `chip tab st-${k}${st.tab === k ? ' active' : ''}`,
        onclick: () => { st.tab = st.tab === k ? null : k; st.limit = PAGE; draw(); },
      }, `${label} · ${counts[k] || 0}`)));
    }
    const rows = data.filter(({ v, s }) => {
      if (st.platform && v.platform !== st.platform) return false;
      if (statuses) {
        if (!statuses.includes(v.status)) return false;
      } else if (st.tab) {
        if (v.status !== st.tab) return false;
      } else {
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
