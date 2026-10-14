// Панель «Профиль и резюме»: кто вы, какую должность ищете, резюме, навыки, фильтры.

import * as store from '../lib/store.js';
import { extractSkills, SKILL_NAMES, resolveSkill } from '../lib/parse.js';
import { SKILLS } from '../lib/skills.js';
import { readResumeFile } from '../lib/resume.js';
import { h, splitList, fmtTime } from './dom.js';

const GRADES = [['', 'Не важно'], ['intern', 'Стажёр'], ['junior', 'Junior'], ['middle', 'Middle'], ['senior', 'Senior'], ['lead', 'Lead']];
const FORMATS = [['remote', 'Удалённо'], ['hybrid', 'Гибрид'], ['office', 'Офис']];

// Навыки профиля — список строк, «*» в начале = основной стек.
function skillChips(skills, onChange) {
  const box = h('div', { class: 'skill-editor' });
  const input = h('input', { list: 'skill-dict', placeholder: 'Добавить навык и Enter', class: 'skill-input' });
  const draw = () => {
    box.replaceChildren(
      ...skills.map((raw, i) => {
        const primary = raw.startsWith('*');
        const name = raw.replace(/^\*/, '');
        return h('span', { class: `chip skill${primary ? ' primary' : ''}` },
          h('button', { type: 'button', class: 'star', title: primary ? 'Основной стек' : 'Сделать основным', onclick: () => { skills[i] = primary ? name : `*${name}`; draw(); onChange(); } }, primary ? '★' : '☆'),
          name,
          h('button', { type: 'button', class: 'x', title: 'Убрать', onclick: () => { skills.splice(i, 1); draw(); onChange(); } }, '×'));
      }),
      input);
  };
  const add = (val) => {
    for (const name of splitList(val)) {
      const r = resolveSkill(name);
      const label = r && !r.custom ? r.name : name;
      if (!skills.some((s) => resolveSkill(s.replace(/^\*/, ''))?.slug === r?.slug)) skills.push(label);
    }
    draw();
    onChange();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); if (input.value.trim()) { add(input.value); input.value = ''; input.focus(); } }
    if (e.key === 'Backspace' && !input.value && skills.length) { skills.pop(); draw(); onChange(); input.focus(); }
  });
  input.addEventListener('change', () => { if (input.value.trim() && SKILLS.some(([, n]) => n === input.value.trim())) { add(input.value); input.value = ''; } });
  draw();
  return { el: box, add };
}

export async function renderProfile(container, { onSaved } = {}) {
  const p = await store.getProfile();
  let resume = await store.getResume();
  const skills = [...(p.skills || [])];
  let dirty = false;
  const markDirty = () => { dirty = true; saveBar.classList.add('dirty'); savedMsg.textContent = 'Есть несохранённые изменения'; };

  const f = {
    name: h('input', { value: p.name || '', placeholder: 'Как к вам обращаться', oninput: markDirty }),
    position: h('input', { value: p.position || '', placeholder: 'Например: Python backend-разработчик', oninput: markDirty }),
    about: h('textarea', { rows: 4, placeholder: 'Чем вы занимаетесь: продукты, задачи, отрасли, чем гордитесь. Чем подробнее, тем точнее подбор.', oninput: markDirty }, p.about || ''),
    keywords: h('input', { value: (p.titleKeywords || []).join(', '), placeholder: 'backend, бэкенд, серверный разработчик', oninput: markDirty }),
    salary: h('input', { type: 'number', min: 0, step: 10000, value: p.minSalary || '', placeholder: '250000', oninput: markDirty }),
    cities: h('input', { value: (p.cities || []).join(', '), placeholder: 'Москва, Санкт-Петербург', oninput: markDirty }),
    stop: h('input', { value: (p.stopWords || []).join(', '), placeholder: '1С, битрикс, холодные звонки', oninput: markDirty }),
    age: h('input', { type: 'number', min: 1, max: 90, value: p.maxAgeDays || 30, oninput: markDirty }),
  };
  let grade = p.grade || '';
  const gradeSeg = h('div', { class: 'seg' }, GRADES.map(([k, label]) => h('button', {
    type: 'button', class: k === grade ? 'on' : '', onclick: (e) => { grade = k; [...gradeSeg.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); markDirty(); },
  }, label)));
  const formats = new Set(p.formats || []);
  const formatSeg = h('div', { class: 'seg' }, FORMATS.map(([k, label]) => h('button', {
    type: 'button', class: formats.has(k) ? 'on' : '', onclick: (e) => { formats.has(k) ? formats.delete(k) : formats.add(k); e.currentTarget.classList.toggle('on'); markDirty(); },
  }, label)));

  const skillEd = skillChips(skills, markDirty);

  // --- резюме
  const fileInput = h('input', { type: 'file', accept: '.pdf,.docx,.rtf,.txt,application/pdf', hidden: true });
  const resumeInfo = h('div', { class: 'resume-info' });
  const foundBox = h('div', { class: 'chips' });
  const resumeText = h('pre', { class: 'resume-text', hidden: true });
  const drop = h('div', { class: 'dropzone', tabindex: 0, onclick: () => fileInput.click(), onkeydown: (e) => { if (e.key === 'Enter') fileInput.click(); } },
    h('strong', {}, 'Перетащите файл резюме сюда'),
    h('span', {}, 'или нажмите, чтобы выбрать · PDF, DOCX, RTF, TXT'));

  function suggestFromText(text) {
    const { required, optional } = extractSkills(text);
    const have = new Set(skills.map((s) => resolveSkill(s.replace(/^\*/, ''))?.slug));
    const found = [...new Set([...required, ...optional])].filter((s) => !have.has(s));
    if (!found.length) { foundBox.replaceChildren(h('span', { class: 'muted small' }, 'Все навыки из резюме уже в профиле.')); return; }
    foundBox.replaceChildren(
      h('span', { class: 'muted small' }, `Нашли в резюме ${found.length} навыков — нажмите, чтобы добавить:`),
      ...found.map((slug) => h('button', { type: 'button', class: 'chip add', onclick: (e) => { skillEd.add(SKILL_NAMES[slug]); e.currentTarget.remove(); } }, `+ ${SKILL_NAMES[slug]}`)),
      h('button', { type: 'button', class: 'chip add all', onclick: () => { skillEd.add(found.map((s) => SKILL_NAMES[s]).join(',')); foundBox.replaceChildren(); } }, 'Добавить все'));
  }

  function drawResume() {
    if (!resume) {
      resumeInfo.replaceChildren(h('span', { class: 'muted' }, 'Резюме не загружено. Без него подбор работает по должности, описанию и навыкам.'));
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

  async function takeFile(file) {
    if (!file) return;
    resumeInfo.replaceChildren(h('span', { class: 'muted' }, `Читаю «${file.name}»…`));
    try {
      const text = await readResumeFile(file);
      resume = { name: file.name, size: file.size, type: file.type, text, uploadedAt: new Date().toISOString() };
      await store.saveResume(resume);
      drawResume();
      suggestFromText(text);
      // Должность из первой строки резюме, если её ещё нет.
      if (!f.position.value.trim()) {
        const guess = text.split('\n').map((l) => l.trim()).find((l) => /(разработчик|developer|engineer|инженер|аналитик|менеджер|дизайнер|специалист|тестировщик|руководитель|бухгалтер|маркетолог|юрист|lead)/i.test(l) && l.length < 80);
        if (guess) { f.position.value = guess; markDirty(); }
      }
    } catch (e) {
      resumeInfo.replaceChildren(h('span', { class: 'warn' }, `Не удалось прочитать файл: ${e.message}`));
    }
  }
  fileInput.addEventListener('change', () => takeFile(fileInput.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); takeFile(e.dataTransfer.files[0]); });
  drawResume();

  // --- сохранение
  const savedMsg = h('span', { class: 'muted' });
  async function save() {
    const profile = {
      ...p,
      name: f.name.value.trim(),
      position: f.position.value.trim(),
      about: f.about.value.trim(),
      titleKeywords: splitList(f.keywords.value),
      grade,
      skills: [...skills],
      minSalary: Number(f.salary.value) || 0,
      formats: [...formats],
      cities: splitList(f.cities.value),
      stopWords: splitList(f.stop.value),
      maxAgeDays: Number(f.age.value) || 30,
    };
    await store.saveProfile(profile);
    const changed = await store.syncAutoSources(profile);
    dirty = false;
    saveBar.classList.remove('dirty');
    savedMsg.textContent = changed && profile.position
      ? `Сохранено. Поиск «${profile.position}» на hh.ru и Avito настроен.`
      : 'Сохранено. Оценки вакансий пересчитаны.';
    onSaved?.(profile);
  }
  const saveBar = h('div', { class: 'savebar' }, h('button', { type: 'submit', class: 'btn primary' }, 'Сохранить профиль'), savedMsg);

  const datalist = h('datalist', { id: 'skill-dict' }, SKILLS.map(([, name]) => h('option', { value: name })));

  const form = h('form', { class: 'pform', onsubmit: (e) => { e.preventDefault(); save(); } },
    datalist,
    h('section', {},
      h('h3', {}, 'Кто вы и что ищете'),
      field('Имя', f.name),
      field('Желаемая должность', f.position, 'По ней настраивается поиск на hh.ru и Avito и считается совпадение с названием вакансии.'),
      field('Чем я занимаюсь', f.about),
      field('Другие названия должности', f.keywords, 'Через запятую. Если одно из них есть в названии вакансии, это плюс.')),
    h('section', {},
      h('h3', {}, 'Резюме'),
      drop, fileInput, resumeInfo, foundBox, resumeText),
    h('section', {},
      h('h3', {}, 'Навыки'),
      h('p', { class: 'muted small' }, '★ — основной стек: вакансии без него опускаются ниже. Можно вписать любой навык, даже если его нет в подсказках.'),
      skillEd.el),
    h('section', {},
      h('h3', {}, 'Условия'),
      field('Грейд', gradeSeg),
      field('Зарплата от, ₽ в месяц', f.salary),
      field('Формат', formatSeg),
      field('Города для офиса', f.cities),
      field('Не показывать, если в тексте есть', f.stop, 'Стоп-слова через запятую.'),
      field('Вакансии не старше, дней', f.age)),
    saveBar);

  container.replaceChildren(form);
  return { isDirty: () => dirty };
}

// div, а не label: внутри бывают кнопки, и клик по подписи нажимал бы первую из них.
function field(label, control, hint) {
  return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}
