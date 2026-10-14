// Панель «Профиль и резюме»: резюме и автозаполнение, должность и похожие названия,
// чем вы занимаетесь, примеры подходящих вакансий, навыки, условия.

import * as store from '../lib/store.js';
import { extractSkills, SKILL_NAMES, resolveSkill, EMPLOYMENT } from '../lib/parse.js';
import { DEFAULT_PROFILE } from '../lib/match.js';
import { SKILLS } from '../lib/skills.js';
import { CITIES, canonicalCity } from '../lib/geo.js';
import { readResumeFile } from '../lib/resume.js';
import { profileFromResume } from '../lib/resume-profile.js';
import { suggestTitles } from '../lib/roles.js';
import { h, splitList, fmtTime } from './dom.js';

const GRADES = [['', 'Не важно'], ['intern', 'Стажёр'], ['junior', 'Junior'], ['middle', 'Middle'], ['senior', 'Senior'], ['lead', 'Lead']];
const FORMATS = [['remote', 'Удалённо'], ['hybrid', 'Гибрид'], ['office', 'Офис']];
const send = (msg) => chrome.runtime.sendMessage(msg);

// Поле-«чипсы»: значения через запятую или Enter, у каждого крестик.
// opts.star — можно отметить звёздочкой (основной навык), opts.normalize — привести к виду.
function chipEditor(values, { placeholder, list, normalize = (x) => x, star = false, onChange }) {
  const box = h('div', { class: 'chip-editor' });
  const input = h('input', { list, placeholder, class: 'chip-input' });
  const key = (x) => normalize(x.replace(/^\*/, '')).toLowerCase();
  const draw = () => {
    box.replaceChildren(
      ...values.map((raw, i) => {
        const primary = star && raw.startsWith('*');
        const name = raw.replace(/^\*/, '');
        return h('span', { class: `chip edit${primary ? ' primary' : ''}` },
          star ? h('button', { type: 'button', class: 'star', title: primary ? 'Основной — нажмите, чтобы снять' : 'Сделать основным', onclick: () => { values[i] = primary ? name : `*${name}`; draw(); onChange(); } }, primary ? '★' : '☆') : null,
          name,
          h('button', { type: 'button', class: 'x', title: 'Убрать', onclick: () => { values.splice(i, 1); draw(); onChange(); } }, '×'));
      }),
      input);
  };
  const add = (val) => {
    let added = false;
    for (const raw of splitList(val)) {
      const v = normalize(raw);
      if (v && !values.some((x) => key(x) === v.toLowerCase())) { values.push(v); added = true; }
    }
    draw();
    if (added) onChange();
  };
  const set = (arr) => { values.splice(0, values.length, ...arr); draw(); };
  input.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) { e.preventDefault(); add(input.value); input.value = ''; }
    else if (e.key === 'Enter') e.preventDefault();
    if (e.key === 'Backspace' && !input.value && values.length) { values.pop(); draw(); onChange(); }
  });
  // Вставка «Москва, СПб, Казань» целиком.
  input.addEventListener('paste', (e) => {
    const t = e.clipboardData.getData('text');
    if (/[,;\n]/.test(t)) { e.preventDefault(); add(t); }
  });
  // Выбор из подсказки и уход из поля тоже добавляют значение.
  input.addEventListener('change', () => { if (input.value.trim()) { add(input.value); input.value = ''; } });
  box.addEventListener('click', (e) => { if (e.target === box) input.focus(); });
  draw();
  return { el: box, add, set, values };
}

const skillLabel = (name) => { const r = resolveSkill(name); return r && !r.custom ? r.name : name.trim(); };

// Полоса профилей: переключение, новый профиль, переименование, удаление.
async function profilesBar(isDirty, onSwitched) {
  const { profiles, active } = await store.ensureProfiles();
  const guard = () => !isDirty() || confirm('В профиле есть несохранённые изменения. Продолжить без сохранения?');
  const sel = h('select', { class: 'profile-select', title: 'Активный профиль', onchange: async (e) => {
    if (!guard()) { e.target.value = active; return; }
    await store.switchProfile(e.target.value);
    onSwitched?.();
  } }, profiles.map((x) => h('option', { value: x.id, selected: x.id === active }, x.title)));
  return h('div', { class: 'profiles-bar' },
    h('span', { class: 'field-label' }, 'Профиль'),
    sel,
    h('button', { type: 'button', class: 'btn small', onclick: async () => {
      if (!guard()) return;
      const t = prompt('Название нового профиля (например, «Продакт-маркетолог»). Резюме, должность и фильтры будут пустыми, источники останутся общими.', '');
      if (t === null) return;
      await store.createProfile(t);
      onSwitched?.();
    } }, '+ Новый профиль'),
    h('button', { type: 'button', class: 'btn small ghost', onclick: async () => {
      const cur = profiles.find((x) => x.id === active);
      const t = prompt('Новое название профиля', cur?.title || '');
      if (!t?.trim()) return;
      await chrome.storage.local.set({ profiles: profiles.map((x) => (x.id === active ? { ...x, title: t.trim(), named: true } : x)) });
      onSwitched?.();
    } }, 'Переименовать'),
    profiles.length > 1 ? h('button', { type: 'button', class: 'btn small ghost', onclick: async () => {
      const cur = profiles.find((x) => x.id === active);
      if (!confirm(`Удалить профиль «${cur?.title}»? Его резюме, фильтры и статусы откликов удалятся. Источники и собранные вакансии останутся.`)) return;
      await store.deleteProfile(active);
      onSwitched?.();
    } }, 'Удалить') : null);
}

export async function renderProfile(container, { onSaved, onSwitched } = {}) {
  const p = await store.getProfile();
  let resume = await store.getResume();
  let dirty = false;
  const savedMsg = h('span', { class: 'muted' });
  const saveBar = h('div', { class: 'savebar' }, h('button', { type: 'submit', class: 'btn primary' }, 'Сохранить профиль'), savedMsg);
  const markDirty = () => { dirty = true; saveBar.classList.add('dirty'); savedMsg.textContent = 'Есть несохранённые изменения'; };

  // --- поля
  const f = {
    name: h('input', { value: p.name || '', placeholder: 'Как к вам обращаться', oninput: markDirty }),
    position: h('input', { value: p.position || '', placeholder: 'Например: Маркетолог', oninput: () => { markDirty(); drawSuggest(); } }),
    about: h('textarea', { rows: 5, placeholder: 'Чем вы занимаетесь: задачи, продукты, отрасли, результаты. Этот текст сравнивается с каждой вакансией.', oninput: markDirty }, p.about || ''),
    salary: h('input', { type: 'number', min: 0, step: 10000, value: p.minSalary || '', placeholder: '100000', oninput: markDirty }),
    age: h('input', { type: 'number', min: 1, max: 90, value: p.maxAgeDays || 30, oninput: markDirty }),
  };
  const titles = chipEditor([...(p.titleKeywords || [])], { placeholder: 'Добавить название и Enter', onChange: () => { markDirty(); drawSuggest(); } });
  const skills = chipEditor([...(p.skills || [])], { placeholder: 'Добавить навык и Enter', list: 'skill-dict', star: true, normalize: skillLabel, onChange: markDirty });
  const cities = chipEditor([...(p.cities || [])], { placeholder: 'Город и Enter (можно СПб, Мск)', list: 'city-dict', normalize: canonicalCity, onChange: markDirty });
  const stops = chipEditor([...(p.stopWords || [])], { placeholder: 'Слово и Enter', onChange: markDirty });
  const examples = [...(p.examples || [])];

  let grade = p.grade || '';
  const gradeSeg = h('div', { class: 'seg' }, GRADES.map(([k, label]) => h('button', {
    type: 'button', class: k === grade ? 'on' : '', 'data-v': k,
    onclick: (e) => { grade = k; [...gradeSeg.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); markDirty(); },
  }, label)));
  const formats = new Set(p.formats || []);
  const formatSeg = h('div', { class: 'seg' }, FORMATS.map(([k, label]) => h('button', {
    type: 'button', class: formats.has(k) ? 'on' : '', 'data-v': k,
    onclick: (e) => { formats.has(k) ? formats.delete(k) : formats.add(k); e.currentTarget.classList.toggle('on'); markDirty(); },
  }, label)));
  const employment = new Set(p.employment || []);
  const empSeg = h('div', { class: 'seg' }, EMPLOYMENT.map(([k, label]) => h('button', {
    type: 'button', class: employment.has(k) ? 'on' : '', 'data-v': k,
    onclick: (e) => { employment.has(k) ? employment.delete(k) : employment.add(k); e.currentTarget.classList.toggle('on'); markDirty(); },
  }, label)));

  // Где должна встречаться должность, чтобы вакансия считалась вашей.
  const matchIn = { ...DEFAULT_PROFILE.matchIn, ...(p.matchIn || {}) };
  const MATCH_IN = [['title', 'В названии вакансии'], ['company', 'В названии компании'], ['description', 'В описании вакансии']];
  const matchSeg = h('div', { class: 'seg' }, MATCH_IN.map(([k, label]) => h('button', {
    type: 'button', class: matchIn[k] ? 'on' : '',
    onclick: (e) => {
      matchIn[k] = !matchIn[k];
      if (!Object.values(matchIn).some(Boolean)) matchIn.title = true; // хотя бы одно место
      [...matchSeg.children].forEach((b, i) => b.classList.toggle('on', matchIn[MATCH_IN[i][0]]));
      e.currentTarget.blur();
      markDirty();
    },
  }, label)));

  const setGrade = (g) => { grade = g; [...gradeSeg.children].forEach((b) => b.classList.toggle('on', b.dataset.v === g)); };
  const setFormats = (arr) => { formats.clear(); arr.forEach((x) => formats.add(x)); [...formatSeg.children].forEach((b) => b.classList.toggle('on', formats.has(b.dataset.v))); };

  // --- похожие должности
  const suggestBox = h('div', { class: 'suggest' });
  function drawSuggest() {
    const list = suggestTitles(f.position.value, titles.values, resume?.text || '');
    if (!list.length) { suggestBox.replaceChildren(); return; }
    suggestBox.replaceChildren(
      h('span', { class: 'muted small' }, 'Похожие должности — нажмите, чтобы искать и по ним:'),
      ...list.map((t) => h('button', { type: 'button', class: 'chip add', onclick: () => { titles.add(t); } }, `+ ${t}`)));
  }

  // --- примеры подходящих вакансий
  const exList = h('div', { class: 'examples' });
  const exInput = h('input', { placeholder: 'Ссылка на вакансию, которая вам нравится (hh.ru, Avito, сайт компании)' });
  const exMsg = h('span', { class: 'muted small' });
  const drawExamples = () => {
    exList.replaceChildren(...examples.map((ex, i) => h('div', { class: 'example' },
      h('a', { href: ex.url, target: '_blank', rel: 'noopener' }, ex.title || ex.url),
      ex.company ? h('span', { class: 'muted small' }, ` · ${ex.company}`) : null,
      h('button', { type: 'button', class: 'x', title: 'Убрать', onclick: () => { examples.splice(i, 1); drawExamples(); markDirty(); } }, '×'))));
  };
  const exButton = h('button', { type: 'button', class: 'btn', onclick: async () => {
    const url = exInput.value.trim();
    if (!/^https?:\/\//i.test(url)) { exMsg.textContent = 'Вставьте ссылку целиком, начиная с https://'; return; }
    // Доступ к сайту компании нужно запросить сразу по клику.
    const platform = store.detectPlatformByUrl(url);
    if (platform === 'generic') {
      const ok = await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] });
      if (!ok) { exMsg.textContent = 'Без доступа к сайту не получится прочитать вакансию.'; return; }
    }
    exButton.disabled = true;
    exMsg.textContent = 'Открываю вакансию в фоне и читаю текст…';
    try {
      const r = await send({ type: 'inspectUrl', url });
      if (!r || r.error) throw new Error(r?.error || 'нет ответа');
      examples.push({ url, title: r.title, company: r.company, text: r.text });
      drawExamples();
      exInput.value = '';
      markDirty();
      const found = [...new Set(Object.values(extractSkills(r.text)).flat())].map((s) => SKILL_NAMES[s]);
      exMsg.textContent = `Добавлено: «${r.title || 'вакансия'}». Похожие вакансии получат выше оценку.${found.length ? ` Навыки из неё: ${found.slice(0, 8).join(', ')}.` : ''}`;
    } catch (e) {
      exMsg.textContent = `Не получилось прочитать: ${e.message}`;
    } finally {
      exButton.disabled = false;
    }
  } }, 'Добавить');
  drawExamples();

  // --- резюме
  const fileInput = h('input', { type: 'file', accept: '.pdf,.docx,.rtf,.txt,application/pdf', hidden: true });
  const resumeInfo = h('div', { class: 'resume-info' });
  const foundBox = h('div', { class: 'chips' });
  const resumeText = h('pre', { class: 'resume-text', hidden: true });
  const autoMsg = h('p', { class: 'auto-msg', hidden: true });
  const autoBtn = h('button', { type: 'button', class: 'btn accent', onclick: () => autofill() }, '✦ Заполнить профиль из резюме');
  const drop = h('div', { class: 'dropzone', tabindex: 0, onclick: () => fileInput.click(), onkeydown: (e) => { if (e.key === 'Enter') fileInput.click(); } },
    h('strong', {}, 'Перетащите файл резюме сюда'),
    h('span', {}, 'или нажмите, чтобы выбрать · PDF, DOCX, RTF, TXT · с hh.ru: «Скачать резюме»'));

  function suggestFromText(text) {
    const { required, optional } = extractSkills(text);
    const have = new Set(skills.values.map((s) => resolveSkill(s.replace(/^\*/, ''))?.slug));
    const found = [...new Set([...required, ...optional])].filter((s) => !have.has(s));
    if (!found.length) { foundBox.replaceChildren(); return; }
    foundBox.replaceChildren(
      h('span', { class: 'muted small' }, `В резюме есть ещё ${found.length} навыков — нажмите, чтобы добавить:`),
      ...found.map((slug) => h('button', { type: 'button', class: 'chip add', onclick: (e) => { skills.add(SKILL_NAMES[slug]); e.currentTarget.remove(); } }, `+ ${SKILL_NAMES[slug]}`)),
      h('button', { type: 'button', class: 'chip add all', onclick: () => { skills.add(found.map((s) => SKILL_NAMES[s]).join(',')); foundBox.replaceChildren(); } }, 'Добавить все'));
  }

  function drawResume() {
    autoBtn.hidden = !resume;
    if (!resume) {
      resumeInfo.replaceChildren(h('span', { class: 'muted' }, 'Резюме не загружено. Без него подбор идёт по должности, «Чем я занимаюсь» и навыкам.'));
      resumeText.hidden = true;
      return;
    }
    resumeText.textContent = resume.text;
    resumeInfo.replaceChildren(
      h('span', { class: 'file-pill' }, '📄 ', resume.name),
      h('span', { class: 'muted small' }, `${resume.text.length.toLocaleString('ru-RU')} символов · загружено ${fmtTime(resume.uploadedAt)}`),
      h('button', { type: 'button', class: 'link', onclick: () => { resumeText.hidden = !resumeText.hidden; } }, 'Показать текст'),
      h('button', { type: 'button', class: 'link', onclick: async () => { await store.saveResume(null); resume = null; foundBox.replaceChildren(); drawResume(); } }, 'Удалить'));
  }

  // Заполняем форму из резюме. Ничего не сохраняем — вы проверяете и жмёте «Сохранить».
  function autofill() {
    if (!resume) return;
    const r = profileFromResume(resume.text);
    const filled = [];
    if (r.name) { f.name.value = r.name; filled.push('имя'); }
    if (r.position) { f.position.value = r.position; filled.push('должность'); }
    if (r.titleKeywords.length) { titles.add(r.titleKeywords.join(',')); filled.push('похожие названия'); }
    if (r.about) { f.about.value = r.about; filled.push('«Чем я занимаюсь»'); }
    if (r.skills.length) { skills.add(r.skills.join(',')); filled.push(`навыки (${r.skills.length})`); }
    if (r.grade) { setGrade(r.grade); filled.push('грейд'); }
    if (r.minSalary) { f.salary.value = r.minSalary; filled.push('зарплата'); }
    if (r.formats.length) { setFormats(r.formats); filled.push('формат'); }
    if (r.cities.length) { cities.add(r.cities.join(',')); filled.push('город'); }
    drawSuggest();
    foundBox.replaceChildren();
    autoMsg.hidden = false;
    autoMsg.textContent = filled.length
      ? `Заполнено из резюме: ${filled.join(', ')}. Проверьте, поправьте при необходимости и нажмите «Сохранить профиль».`
      : 'В резюме не нашлось полей для профиля — заполните вручную.';
    markDirty();
  }

  async function takeFile(file) {
    if (!file) return;
    resumeInfo.replaceChildren(h('span', { class: 'muted' }, `Читаю «${file.name}»…`));
    try {
      const text = await readResumeFile(file);
      resume = { name: file.name, size: file.size, type: file.type, text, uploadedAt: new Date().toISOString() };
      await store.saveResume(resume);
      drawResume();
      // Пустой профиль заполняем сразу, иначе предлагаем кнопку.
      const empty = !f.position.value.trim() && !skills.values.length && !f.about.value.trim();
      if (empty) autofill();
      else suggestFromText(text);
    } catch (e) {
      resumeInfo.replaceChildren(h('span', { class: 'warn' }, `Не удалось прочитать файл: ${e.message}`));
    }
  }
  fileInput.addEventListener('change', () => takeFile(fileInput.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); takeFile(e.dataTransfer.files[0]); });
  drawResume();
  drawSuggest();

  // --- сохранение
  async function save() {
    const profile = {
      ...p,
      name: f.name.value.trim(),
      position: f.position.value.trim(),
      about: f.about.value.trim(),
      titleKeywords: [...titles.values],
      grade,
      skills: [...skills.values],
      minSalary: Number(f.salary.value) || 0,
      formats: [...formats],
      employment: [...employment],
      matchIn: { ...matchIn },
      cities: [...cities.values],
      stopWords: [...stops.values],
      maxAgeDays: Number(f.age.value) || 30,
      examples,
    };
    await store.saveProfile(profile);
    const changed = await store.syncAutoSources(profile);
    dirty = false;
    saveBar.classList.remove('dirty');
    autoMsg.hidden = true;
    savedMsg.textContent = changed && profile.position
      ? `Сохранено. Поиск «${profile.position}» на hh.ru и Avito обновлён — нажмите «/ Найти работу».`
      : 'Сохранено. Оценки всех вакансий пересчитаны.';
    onSaved?.(profile);
  }

  const form = h('form', { class: 'pform', onsubmit: (e) => { e.preventDefault(); save(); } },
    h('datalist', { id: 'skill-dict' }, SKILLS.map(([, name]) => h('option', { value: name }))),
    h('datalist', { id: 'city-dict' }, CITIES.map((c) => h('option', { value: c.name }))),
    h('section', {},
      h('h3', {}, 'Резюме'),
      h('p', { class: 'muted small lead' }, 'Загрузите резюме — профиль заполнится сам. Каждая найденная вакансия сравнивается с резюме, «Чем я занимаюсь», навыками и должностью.'),
      drop, fileInput, resumeInfo, h('div', { class: 'row' }, autoBtn), autoMsg, foundBox, resumeText),
    h('section', {},
      h('h3', {}, 'Кто вы и что ищете'),
      field('Имя', f.name),
      field('Желаемая должность', f.position, 'По ней настраивается поиск на hh.ru и Avito.'),
      field('Другие названия должности', h('div', {}, titles.el, suggestBox), 'Вакансия с любым из этих названий считается «вашей». Можно по-английски: Marketing manager = менеджер по маркетингу. Через запятую или Enter.'),
      field('Искать должность только', matchSeg, 'Вакансия показывается, только если ваша должность (или одно из названий выше) есть в отмеченных местах. Вакансии с должностью в названии — всегда выше.'),
      field('Чем я занимаюсь', f.about),
      field('Примеры подходящих вакансий', h('div', {}, exList, h('div', { class: 'row' }, exInput, exButton), exMsg),
        'Вставьте ссылку на вакансию, которая вам нравится, — найдём похожие, даже если названия отличаются.')),
    h('section', {},
      h('h3', {}, 'Навыки'),
      h('p', { class: 'muted small' }, '★ — основные навыки: вакансии без них опускаются ниже. Можно вписать любой навык, даже если его нет в подсказках.'),
      skills.el),
    h('section', {},
      h('h3', {}, 'Условия'),
      field('Грейд', gradeSeg),
      field('Зарплата от, ₽ в месяц', f.salary),
      field('Формат', formatSeg, 'Если отмечена «Удалённо», показываем и вакансии из других городов — с пометкой.'),
      field('Тип занятости', empSeg, 'Ничего не отмечено — подходит любой.'),
      field('Города', cities.el, 'Только эти города. Другие — лишь при удалённой работе. Через запятую или Enter, понимаем СПб, Питер, Мск, Екб. Первый город — регион поиска на hh.ru и Avito.'),
      field('Не показывать, если в тексте есть', stops.el, 'Стоп-слова через запятую: например, «холодные звонки», «1С».'),
      field('Вакансии не старше, дней', f.age)),
    saveBar);

  container.replaceChildren(await profilesBar(() => dirty, onSwitched), form);
  return { isDirty: () => dirty };
}

// div, а не label: внутри бывают кнопки, и клик по подписи нажимал бы первую из них.
function field(label, control, hint) {
  return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}
