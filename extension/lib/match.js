// Отбор и оценка вакансий по профилю. Чистые функции, без chrome.*.
//
// 1. Жёсткие фильтры профиля — вакансия, которая их не проходит, не показывается
//    и не считается «подходящей»:
//      • должность: желаемая должность или одно из её названий есть там, где вы
//        выбрали искать (название / компания / описание). Сравниваем по смысловым
//        словам с учётом падежей и перевода EN↔RU: «Marketing manager» = «менеджер по
//        маркетингу», а «Главный специалист отдела безопасности» — не «Специалист по
//        маркетингу»;
//      • город: только города из профиля; другие — только если работа удалённая;
//      • тип занятости, формат, стоп-слова, свежесть.
// 2. Оценка «Подходит мне» (0..1) у прошедших: должность, навыки, похожесть на
//    резюме и «Чем я занимаюсь», зарплата, грейд, свежесть.

import { GRADES, resolveSkill, extractSkills, salaryInRub, parseEmployment } from './parse.js';
import { canonicalCity, vacancyCities } from './geo.js';

export const DEFAULT_PROFILE = {
  name: '',
  position: '',           // «Маркетолог» или «Product Marketing Manager»
  about: '',              // чем занимаюсь, свободный текст
  titleKeywords: [],      // другие названия должности
  matchIn: { title: true, company: false, description: true }, // где должна встречаться должность
  grade: '',
  skills: [],             // ['*SMM', 'Яндекс Директ'] — «*» = основной навык
  minSalary: 0,           // ₽ в месяц
  formats: ['remote', 'hybrid', 'office'],
  employment: [],         // пусто = любой тип занятости
  cities: [],
  stopWords: [],
  maxAgeDays: 30,
  examples: [],           // примеры подходящих вакансий: [{ url, title, text }]
};

// ---------- Текст ----------

const STOP = new Set(`
и в во на с со к ко по о об от до за из у для при про не но а или то же ли бы как что это так все всё мы вы вас нас наш ваш наша ваша наши ваши
его ее её их они она он оно был была были быть будет будем есть нет также если чтобы где когда который которая которые которых работа работы работать
опыт опыта команда команды компании компания задачи требования условия обязанности года лет год плюсом будет знание знания умение навыки хороший хорошее
the a an and or of to in on for with at by from is are be as we you your our will this that it work team experience years job role skills requirements
`.split(/\s+/).filter(Boolean));

// Грубый стеммер: первые 6 букв + словарь, сводящий английские и русские формы
// к одному корню, — так «Marketing Manager» совпадает с «менеджер по маркетингу».
const SYN = {
  develo: 'разраб', progra: 'разраб', програ: 'разраб', engine: 'инжене', analys: 'аналит', analyt: 'аналит',
  manage: 'менедж', design: 'дизайн', дизайн: 'дизайн', tester: 'тестир', testin: 'тестир', qa: 'тестир',
  market: 'маркет', маркет: 'маркет', recrui: 'рекрут', backen: 'бэкенд', бекенд: 'бэкенд', fronte: 'фронте', фронт: 'фронте',
  produc: 'продук', продук: 'продук', brand: 'бренд', sales: 'продаж', seller: 'продаж', продав: 'продаж',
  conten: 'контен', perfor: 'перфор', перфом: 'перфор', digita: 'диджит', диджит: 'диджит', target: 'таргет',
  head: 'руково', lead: 'руково', chief: 'руково', direct: 'директ', accoun: 'аккаун', аккаун: 'аккаун',
  specia: 'специа', expert: 'экспер', assist: 'ассист', copywr: 'копира', copyri: 'копира', editor: 'редакт',
  financ: 'финанс', lawyer: 'юрист', legal: 'юрист', logist: 'логист', operat: 'операт', consul: 'консул',
  servic: 'сервис', suppor: 'поддер', bookke: 'бухгал',
};
function stem(w) {
  // «Маркетплейс» — другая профессия, чем «маркетолог», хотя корень похож.
  if (w.startsWith('маркетплейс') || w.startsWith('marketplace')) return 'mplace';
  const s = w.length > 6 ? w.slice(0, 6) : w;
  return SYN[s] || s;
}

export function tokens(text) {
  const out = [];
  for (const m of (text || '').toLowerCase().matchAll(/[\p{L}][\p{L}\p{N}+#]*/gu)) {
    const w = m[0].replace(/ё/g, 'е');
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

// Слова, которые есть в названиях почти всех профессий и сами по себе ничего не значат.
export const GENERIC = new Set(tokens(
  'менеджер специалист руководитель ведущий главный старший младший помощник ассистент сотрудник эксперт отдела отдел '
  + 'направления группы управления департамента начальник заместитель стажер стажёр junior middle senior lead head chief '
  + 'manager specialist assistant expert intern старший ведущий главный',
));
const GRADE_WORDS = /^(junior|middle|senior|джун|мидл|сеньор|синьор|младши|старши|ведущи|главны|стажер|intern|trainee)/u;

function tf(toks, weight = 1, into = new Map()) {
  for (const t of toks) into.set(t, (into.get(t) || 0) + weight);
  return into;
}

function vectorize(counts, idf) {
  const v = new Map();
  let norm = 0;
  for (const [t, c] of counts) {
    const w = (1 + Math.log(c)) * (idf.get(t) ?? idf.default);
    v.set(t, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of v) v.set(t, w / norm);
  return v;
}

function cosine(a, b) {
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [t, w] of small) { const x = big.get(t); if (x) s += w * x; }
  return s;
}

const vacText = (v) => `${v.title} ${v.title} ${v.title}\n${v.description || v.snippet || ''}`;

// Токены вакансии считаются один раз: при тысячах вакансий это главный расход времени.
const tokCache = new Map();
function vacTokens(v) {
  const key = v.key ? `${v.key}|${v.lastSeenAt}|${v.enriched ? 1 : 0}` : null;
  if (key && tokCache.has(key)) return tokCache.get(key);
  const t = tokens(vacText(v));
  if (key) {
    if (tokCache.size > 20000) tokCache.clear();
    tokCache.set(key, t);
  }
  return t;
}

// ---------- Должность ----------

// Фраза должности: смысловые слова (core) обязательны; если смысловых нет
// («Менеджер»), обязательны все слова.
export function phrase(text) {
  const all = [...new Set(tokens(text))].filter((t) => !GRADE_WORDS.test(t));
  const core = all.filter((t) => !GENERIC.has(t));
  return { label: text, need: core.length ? core : all };
}

// «Product Marketing Manager (PMM)» → два варианта: «Product Marketing Manager» и «PMM».
// Так же для «А / Б» и «А, Б».
export function phrasesOf(text) {
  return (text || '').split(/[()/|,;]+/).map((x) => x.trim()).filter((x) => x.length >= 2)
    .map(phrase).filter((p) => p.need.length);
}

const hasAll = (need, set) => need.length > 0 && need.every((t) => set.has(t));

// Где в вакансии встречается одна из ваших должностей.
export function findPosition(v, phrases, matchIn) {
  if (!phrases.length) return { where: 'any' };
  const title = new Set(tokens(v.title));
  for (const p of phrases) if (hasAll(p.need, title)) return { where: 'title', phrase: p.label };
  if (matchIn.company) {
    const company = new Set(tokens(v.company));
    for (const p of phrases) if (hasAll(p.need, company)) return { where: 'company', phrase: p.label };
  }
  if (matchIn.description) {
    const desc = tokens(v.description || v.snippet || '');
    // Должность должна быть в начале описания (там пишут «Ищем маркетолога…»)
    // или встречаться хотя бы дважды — одно случайное упоминание не считается.
    const head = new Set(desc.slice(0, 80));
    const counts = tf(desc);
    for (const p of phrases) {
      if (hasAll(p.need, head) || (p.need.length && p.need.every((t) => (counts.get(t) || 0) >= 2))) return { where: 'description', phrase: p.label };
    }
  }
  return { where: null };
}

// ---------- Профиль ----------

// Разбирает список навыков профиля. «*SMM» — основной навык.
export function profileSkills(profile) {
  const out = [];
  for (const raw of profile.skills || []) {
    const primary = raw.trim().startsWith('*');
    const r = resolveSkill(raw.replace(/^\s*\*/, ''));
    if (r) out.push({ ...r, primary });
  }
  return out;
}

// Контекст считается один раз на набор вакансий: IDF по корпусу, вектор профиля, фразы должности.
export function makeContext(profile, vacancies = [], resumeText = '') {
  const df = new Map();
  for (const v of vacancies) for (const t of new Set(vacTokens(v))) df.set(t, (df.get(t) || 0) + 1);
  const n = Math.max(vacancies.length, 1);
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(1 + n / d));
  idf.default = Math.log(1 + n);

  const ps = profileSkills(profile);
  const counts = new Map();
  tf(tokens(profile.position), 3, counts);
  (profile.titleKeywords || []).forEach((k) => tf(tokens(k), 2, counts));
  tf(tokens(ps.map((s) => s.name).join(' ')), 2, counts);
  tf(tokens(profile.about), 1, counts);
  tf(tokens(resumeText).slice(0, 3000), 0.5, counts);
  for (const ex of profile.examples || []) {
    tf(tokens(ex.title), 2, counts);
    tf(tokens(ex.text).slice(0, 800), 1, counts);
  }

  const phrases = [profile.position, ...(profile.titleKeywords || []), ...(profile.examples || []).map((e) => e.title)]
    .flatMap(phrasesOf);
  const matchIn = { ...DEFAULT_PROFILE.matchIn, ...(profile.matchIn || {}) };
  const cities = (profile.cities || []).map(canonicalCity).filter(Boolean);
  return { ps, idf, profileVec: counts.size ? vectorize(counts, idf) : null, phrases, matchIn, cities };
}

// ---------- Отбор и оценка ----------

const out = (reason, extra = {}) => ({ score: 0, excluded: reason, matched: [], missing: [], ...extra });

export function scoreVacancy(v, profile, now = Date.now(), ctx = makeContext(profile, [v])) {
  const fullText = `${v.title}\n${v.company}\n${v.description || v.snippet || ''}`;
  const lower = fullText.toLowerCase();

  // --- жёсткие фильтры
  const stop = (profile.stopWords || []).map((s) => s.trim().toLowerCase()).filter(Boolean).find((s) => lower.includes(s));
  if (stop) return out('стоп-слово', { stopped: stop });

  const date = Date.parse(v.publishedAt || v.firstSeenAt) || now;
  const ageDays = Math.max(0, (now - date) / 86400e3);
  if (profile.maxAgeDays && ageDays > profile.maxAgeDays) return out('старая', { tooOld: true });

  const pos = findPosition(v, ctx.phrases, ctx.matchIn);
  if (!pos.where) return out('другая должность');

  const remote = (v.formats || []).includes('remote');
  const wantFormats = new Set(profile.formats || []);
  const vCities = vacancyCities(v);
  let otherCity = null;
  if (ctx.cities.length && vCities.length && !vCities.some((c) => ctx.cities.includes(c))) {
    // Другой город подходит, только если работа удалённая и удалёнка вам подходит.
    if (!remote || (wantFormats.size && !wantFormats.has('remote'))) return out('другой город', { cities: vCities });
    otherCity = vCities[0];
  }
  if (v.formats?.length && wantFormats.size && !v.formats.some((f) => wantFormats.has(f))) return out('другой формат');

  const wantEmp = new Set(profile.employment || []);
  if (wantEmp.size) {
    const emp = parseEmployment(fullText);
    if (emp.length && !emp.some((e) => wantEmp.has(e))) return out('другой тип занятости');
  }

  // --- навыки
  const { ps } = ctx;
  const required = new Set(v.skills || []);
  const optional = new Set(v.skillsOptional || []);
  const custom = ps.filter((s) => s.custom);
  if (custom.length) {
    const found = extractSkills(`${v.title}\n${v.description || v.snippet || ''}`, custom);
    found.required.forEach((s) => required.add(s));
    found.optional.forEach((s) => !required.has(s) && optional.add(s));
  }
  const mine = new Set(ps.map((s) => s.slug));
  const primary = new Set(ps.filter((s) => s.primary).map((s) => s.slug));
  let total = 0;
  let got = 0;
  const matched = [];
  const missing = [];
  for (const s of required) {
    total += 1;
    if (mine.has(s)) { got += 1; matched.push(s); } else missing.push(s);
  }
  for (const s of optional) {
    total += 0.5;
    if (mine.has(s)) { got += 0.5; matched.push(s); }
  }
  let skillScore = null;
  if (total && mine.size) {
    skillScore = got / total;
    const primaryHit = [...primary].some((s) => required.has(s) || optional.has(s));
    if (primary.size && !primaryHit) skillScore *= 0.6;
  }

  // --- похожесть на резюме и «Чем я занимаюсь»
  let textScore = null;
  if (ctx.profileVec) {
    const vv = vectorize(tf(vacTokens(v)), ctx.idf);
    textScore = Math.min(1, cosine(ctx.profileVec, vv) / 0.3);
  }

  // --- должность: в названии — лучше всего
  const titleScore = { title: 1, any: 0.7, company: 0.6, description: 0.5 }[pos.where];

  // --- грейд
  let gradeScore = 0.7;
  if (profile.grade && v.grades?.length) {
    const ug = GRADES.indexOf(profile.grade);
    const dist = Math.min(...v.grades.map((g) => Math.abs(GRADES.indexOf(g) - ug)));
    gradeScore = dist === 0 ? 1 : dist === 1 ? 0.4 : 0;
  }

  // --- зарплата
  let salaryScore = 0.6;
  const rub = salaryInRub(v.salary);
  if (profile.minSalary && rub) {
    const top = rub.to ?? rub.from;
    salaryScore = top >= profile.minSalary ? 1 : top >= profile.minSalary * 0.85 ? 0.5 : 0;
  }

  const fresh = Math.exp(-ageDays / 10);

  const w = { title: 0.3, skills: 0.28, text: 0.17, grade: 0.07, salary: 0.1, fresh: 0.08 };
  if (skillScore == null) { w.text += w.skills; w.skills = 0; skillScore = 0; }
  if (textScore == null) { w.title += w.text; w.text = 0; textScore = 0; }
  const score = w.title * titleScore + w.skills * skillScore + w.text * textScore + w.grade * gradeScore + w.salary * salaryScore + w.fresh * fresh;

  return {
    score: Math.round(score * 100) / 100,
    matched,
    missing,
    where: pos.where,
    phrase: pos.phrase,
    otherCity,
    cities: vCities,
    parts: { skills: skillScore, text: textScore, title: titleScore, grade: gradeScore, salary: salaryScore, fresh },
    skillsTotal: Math.round(total * 2) / 2,
    weights: w,
  };
}

// Оценки для набора вакансий.
export function scoreAll(vacancies, profile, resumeText = '', now = Date.now()) {
  const ctx = makeContext(profile, vacancies, resumeText);
  return vacancies.map((v) => ({ v, s: scoreVacancy(v, profile, now, ctx) }));
}

// Сколько вакансий отсеяли фильтры профиля и почему — показываем, чтобы было понятно.
export function exclusionStats(scored) {
  const by = {};
  for (const { s } of scored) if (s.excluded) by[s.excluded] = (by[s.excluded] || 0) + 1;
  return by;
}
