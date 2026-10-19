// Список вакансий с фильтрами и карточками (используется во всех панелях).

import * as store from '../lib/store.js';
import { SKILL_NAMES } from '../lib/parse.js';
import { h, fmtTime, fmtDate, fmtSalary, daysSince } from './dom.js';
import { normalizeLetters, renderLetter } from '../lib/letters.js';
import { remindersFor } from '../lib/reminders.js';

// Значение для <input type="datetime-local"> в местном времени.
const localInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
};

// Профиль и шаблоны писем для кнопки «Скопировать письмо» — их передаёт главная (setCardContext).
let ctx = { profile: {}, letters: null };
export function setCardContext(next) { ctx = { ...ctx, ...next }; }
const lettersCfg = () => ctx.letters || normalizeLetters(null);
const say = (text) => window.dispatchEvent(new CustomEvent('solk-toast', { detail: text }));

export function letterFor(v, s, templateId) {
  const L = lettersCfg();
  const t = L.templates.find((x) => x.id === (templateId || L.defaultId)) || L.templates[0];
  return renderLetter(t, { vacancy: v, profile: ctx.profile, matched: s?.matched || [], contacts: L.contacts, gender: L.gender });
}

export const IS_MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');
// «⌘ Cmd + V (Mac) · Ctrl + V (Windows)» — сначала клавиши вашей системы.
export function pasteKeys() {
  const mac = h('span', { class: 'kbd-pair' }, h('kbd', {}, '⌘ Cmd'), ' + ', h('kbd', {}, 'V'), ' на Mac');
  const win = h('span', { class: 'kbd-pair' }, h('kbd', {}, 'Ctrl'), ' + ', h('kbd', {}, 'V'), ' на Windows');
  return IS_MAC ? [mac, ' · ', win] : [win, ' · ', mac];
}

// Где на сайте вставлять письмо.
const WHERE = {
  hh: 'На hh.ru нажмите «Откликнуться» и затем «Сопроводительное письмо» (или «Добавить сопроводительное»), щёлкните в поле письма.',
  avito: 'На Avito нажмите «Откликнуться» или «Написать» и щёлкните в поле сообщения.',
  telegram: 'В посте найдите контакт для откликов (@ник, ссылку или почту), откройте чат и щёлкните в поле сообщения.',
  generic: 'На сайте нажмите «Откликнуться» / «Отправить резюме» и щёлкните в поле «Сопроводительное письмо», «Комментарий» или «О себе».',
};

// В буфер обмена: обычным способом, а если браузер не ответил за 1,5 с — старым (execCommand).
async function copyText(text) {
  try {
    const ok = await Promise.race([navigator.clipboard.writeText(text).then(() => true), new Promise((r) => setTimeout(() => r(false), 1500))]);
    if (ok) return true;
  } catch { /* попробуем запасной способ */ }
  const ta = h('textarea', { style: { position: 'fixed', top: '-1000px', opacity: '0' } }, text);
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

// Кнопка у вакансии: письмо под неё — в буфер обмена, и сразу видно, куда его вставить.
// Сами мы на сайтах ничего не нажимаем и статус не меняем: откликаетесь и отмечаете вы.
export async function copyLetter(v, s) {
  const letter = letterFor(v, s);
  const copied = await copyText(letter);
  return openLetterDialog(v, s, { copied, letter });
}

// Окно «Письмо»: текст под вакансию, шаги, куда вставить, и кнопка «Я откликнулся».
export function openLetterDialog(v, s, { copied = null, letter = null } = {}) {
  const L = lettersCfg();
  const area = h('textarea', { class: 'letter-text', rows: 12 }, letter ?? letterFor(v, s));
  const banner = h('div', { class: 'letter-ok' });
  const showCopied = (ok) => {
    banner.hidden = ok == null;
    banner.className = `letter-ok ${ok ? '' : 'bad'}`;
    banner.replaceChildren(...(ok
      ? [h('b', {}, '✓ Письмо скопировано в буфер обмена. '), 'Осталось вставить его на сайте: ', ...pasteKeys(), '.']
      : [h('b', {}, 'Не получилось скопировать автоматически. '), 'Текст выделен — нажмите ', h('kbd', {}, IS_MAC ? '⌘ Cmd' : 'Ctrl'), ' + ', h('kbd', {}, 'C'), ', чтобы скопировать.']));
  };
  showCopied(copied);
  const copyAgain = async () => {
    const ok = await copyText(area.value);
    if (!ok) { area.focus(); area.select(); }
    showCopied(ok);
    return ok;
  };
  const pick = h('select', { onchange: (e) => { area.value = letterFor(v, s, e.target.value); showCopied(null); } },
    L.templates.map((t) => h('option', { value: t.id, selected: t.id === L.defaultId }, t.name)));
  const canMark = ['new', 'viewed'].includes(v.status);
  const dlg = h('dialog', { class: 'letter-dialog', onclose: () => dlg.remove() },
    h('form', { method: 'dialog', class: 'letter-form' },
      h('div', { class: 'letter-head' }, h('b', {}, `Письмо: ${v.title}${v.company ? ` — ${v.company}` : ''}`), h('button', { class: 'link muted', value: 'cancel', title: 'Закрыть' }, '✕')),
      banner,
      h('ol', { class: 'letter-steps' },
        h('li', {}, 'Нажмите «Открыть вакансию» — она откроется в новой вкладке.'),
        h('li', {}, WHERE[v.platform] || WHERE.generic),
        h('li', {}, 'Вставьте письмо: ', ...pasteKeys(), '. Проверьте текст и отправьте отклик на сайте.'),
        h('li', {}, 'Вернитесь сюда и нажмите «Я откликнулся» — или выберите статус «Откликнулся» у вакансии. Статус ставите только вы: сами мы на сайтах ничего не отправляем.')),
      h('label', { class: 'flabel' }, 'Шаблон', pick),
      area,
      h('p', { class: 'muted small' }, 'Текст можно поправить прямо здесь — тогда нажмите «Скопировать ещё раз». «Под вакансию» собирается само из вакансии и вашего профиля; свои шаблоны, подпись и контакты — в «Поиск и настройки» → «Сопроводительные письма».'),
      h('div', { class: 'row' },
        /^https?:/i.test(v.url || '') ? h('a', { class: 'btn primary', href: v.url, target: '_blank', rel: 'noopener', onclick: () => {
          // Ещё раз копируем текст из окна — вдруг его правили.
          copyText(area.value);
          if (v.status === 'new') store.setUserFields(v.key, { status: 'viewed' });
        } }, 'Открыть вакансию ↗') : null,
        h('button', { class: 'btn', type: 'button', onclick: copyAgain }, 'Скопировать ещё раз'),
        canMark ? h('button', { class: 'btn ghost vc-mark', type: 'button', onclick: async () => {
          await store.setUserFields(v.key, { status: 'responded' });
          say('Статус: «Откликнулся». Вакансия теперь в «Моих откликах» — через 7 дней без ответа напомню.');
          dlg.close();
        } }, 'Я откликнулся') : null)));
  document.body.append(dlg);
  dlg.showModal();
  if (copied === false) { area.focus(); area.select(); }
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
      v.status === 'interview' ? interviewField(v) : null,
      h('div', { class: 'vc-why' }, whyLine(s)),
      (v.snippet || v.description) ? h('p', { class: 'vc-snippet' }, (v.snippet || v.description).slice(0, 360)) : null,
      (s.matched.length || s.missing.length) ? h('div', { class: 'chips' },
        s.matched.map((k) => h('span', { class: 'chip ok', title: 'Есть у вас' }, skillName(k))),
        s.missing.slice(0, 6).map((k) => h('span', { class: 'chip miss', title: 'Нет в профиле' }, skillName(k)))) : null,
      v.alsoAt?.length ? h('div', { class: 'vc-also' }, 'Также: ',
        v.alsoAt.map((a, i) => [i ? ', ' : '', h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.source || store.PLATFORM_NAMES[a.platform])])) : null,
      noteBox),
    h('div', { class: 'vc-side' },
      ['new', 'viewed'].includes(v.status) ? h('button', { class: 'btn small primary vc-respond', type: 'button', title: 'Скопирует сопроводительное письмо под эту вакансию и подскажет, куда его вставить. Откликаетесь и ставите статус вы сами.', onclick: () => copyLetter(v, s) }, 'Скопировать письмо') : null,
      h('select', { class: `status-sel st-${v.status}`, title: 'Статус', onchange: (e) => setStatus(e.target.value) },
        store.STATUSES.map(([k, label]) => h('option', { value: k, selected: k === v.status }, label))),
      ['new', 'viewed'].includes(v.status) ? null : h('button', { class: 'link', type: 'button', onclick: () => openLetterDialog(v, s) }, 'Письмо'),
      h('button', { class: 'link', type: 'button', onclick: () => { noteBox.hidden = !noteBox.hidden; if (!noteBox.hidden) noteBox.querySelector('textarea').focus(); } }, v.note ? 'Заметка ✎' : 'Заметка'),
      v.status !== 'hidden' ? h('button', { class: 'link muted', type: 'button', onclick: () => setStatus('hidden') }, 'Скрыть') : null));
}

// Дата интервью: можно выбрать в календаре или вписать с клавиатуры. Сохраняем, только когда
// дата полная и год настоящий: пока вы печатаете год, браузер на миг видит «0002» —
// раньше это сразу сохранялось, список перерисовывался и год «слетал».
function interviewField(v) {
  const hint = h('span', { class: 'muted small' }, 'напомню накануне и за 3 часа');
  const save = (e) => {
    const val = e.target.value;
    if (!val) {
      if (v.interviewAt && e.type === 'blur') { v.interviewAt = null; store.setUserFields(v.key, { interviewAt: null }); }
      return;
    }
    const d = new Date(val);
    const year = d.getFullYear();
    if (Number.isNaN(d.getTime()) || year < 2000 || year > 2100) {
      if (e.type === 'blur') { hint.textContent = 'Проверьте год — например, 2026'; hint.classList.add('bad'); }
      return;
    }
    hint.textContent = 'напомню накануне и за 3 часа';
    hint.classList.remove('bad');
    const iso = d.toISOString();
    if (iso !== v.interviewAt) { v.interviewAt = iso; store.setUserFields(v.key, { interviewAt: iso }); }
  };
  // Пока печатаете, ждём паузы: иначе сохранились бы промежуточные «14:03» по пути к «14:30».
  let timer = null;
  const later = (e) => { clearTimeout(timer); timer = setTimeout(() => save({ type: 'change', target: e.target }), 1200); };
  const saveNow = (e) => { clearTimeout(timer); save(e); };
  return h('label', { class: 'vc-iv' }, 'Дата и время интервью',
    h('input', {
      type: 'datetime-local', min: '2000-01-01T00:00', max: '2100-12-31T23:59', value: localInput(v.interviewAt),
      onchange: later, onblur: saveNow,
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
    }),
    hint);
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
    h('p', {}, 'Статусы ставите вы сами: «Откликнулся» — откликнулись на сайте (кнопка «Скопировать письмо» даёт готовое сопроводительное, но отправляете отклик и меняете статус вы), «Отправил резюме» — отправили резюме, «Отказ» — работодатель ответил отказом, «Скрыто» — вакансия неинтересна. Всё, кроме «Не смотрел», «Просмотрел» и «Скрыто», попадает в «Мои отклики». Вакансии, снятые с публикации, исчезают из выдачи, но в «Моих откликах» остаются.'),
    h('p', {}, '«поиск сегодня 18:12» — когда вакансию последний раз видел поиск solk / job; «опубл.» — дата публикации на сайте.'));

  const root = h('div', { class: 'vc-wrap' }, showStatusTabs ? tabsEl : null, filters, hint, listEl, h('div', { class: 'center' }, moreBtn));
  let pending = false;
  const editingCard = () => {
    const a = document.activeElement;
    return listEl.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(a.type)));
  };
  listEl.addEventListener('focusout', () => setTimeout(() => {
    if (pending && !editingCard()) { pending = false; draw(); }
  }, 0));

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
      data = scored;
      // Пока вы что-то вписываете в карточке (заметку, дату интервью), не перерисовываем —
      // чтобы не потерять ввод. Обновим, как только поле потеряет фокус.
      if (editingCard()) { pending = true; return; }
      draw();
    },
  };
}
