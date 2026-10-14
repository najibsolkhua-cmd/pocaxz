// Оценка «насколько вакансия подходит профилю». Чистые функции, без chrome.*.
//
// Из чего складывается оценка (0..1):
//   навыки     — какую долю требований вакансии закрывают ваши навыки;
//   текст      — похожесть текста вакансии на «должность + чем занимаюсь + резюме»
//                (TF-IDF, работает и для профессий, которых нет в словаре навыков);
//   должность  — сколько слов из желаемой должности есть в названии вакансии;
//   грейд, зарплата, свежесть.

import { GRADES, resolveSkill, extractSkills, salaryInRub } from './parse.js';

export const DEFAULT_PROFILE = {
  name: '',
  position: '',           // «Python backend-разработчик»
  about: '',              // чем занимаюсь, свободный текст
  titleKeywords: [],      // доп. варианты названия: «бэкенд», «backend»
  grade: '',
  skills: [],             // ['*Python', 'Django'] — «*» = основной стек
  minSalary: 0,           // ₽ в месяц
  formats: ['remote', 'hybrid', 'office'],
  cities: [],
  stopWords: [],
  maxAgeDays: 30,
};

// ---------- Текст ----------

const STOP = new Set(`
и в во на с со к ко по о об от до за из у для при про не но а или то же ли бы как что это так все всё мы вы вас нас наш ваш наша ваша наши ваши
его ее её их они она он оно был была были быть будет будем есть нет также если чтобы где когда который которая которые которых работа работы работать
опыт опыта команда команды компании компания задачи требования условия обязанности года лет год плюсом будет знание знания умение навыки хороший хорошее
the a an and or of to in on for with at by from is are be as we you your our will this that it work team experience years job role skills requirements
`.split(/\s+/).filter(Boolean));

// Грубый стеммер: для русского первые 6 букв дают приемлемое качество.
const SYN = { develo: 'разраб', progra: 'разраб', engine: 'инжене', analys: 'аналит', analyt: 'аналит', manage: 'менедж', design: 'дизайн', tester: 'тестир', testin: 'тестир', qa: 'тестир', market: 'маркет', accoun: 'бухгал', recrui: 'рекрут', backen: 'бэкенд', бекенд: 'бэкенд', fronte: 'фронте', фронт: 'фронте' };
function stem(w) {
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

// ---------- Профиль ----------

// Разбирает список навыков профиля. «*Python» — основной стек.
export function profileSkills(profile) {
  const out = [];
  for (const raw of profile.skills || []) {
    const primary = raw.trim().startsWith('*');
    const r = resolveSkill(raw.replace(/^\s*\*/, ''));
    if (r) out.push({ ...r, primary });
  }
  return out;
}

const GRADE_WORDS = /^(junior|middle|senior|lead|джун|мидл|сеньор|синьор|младши|старши|ведущи|главны|стажер|intern|trainee)/u;

// Контекст считается один раз на набор вакансий: IDF по корпусу и вектор профиля.
export function makeContext(profile, vacancies = [], resumeText = '') {
  const df = new Map();
  for (const v of vacancies) for (const t of new Set(tokens(vacText(v)))) df.set(t, (df.get(t) || 0) + 1);
  const n = Math.max(vacancies.length, 1);
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(1 + n / d));
  idf.default = Math.log(1 + n); // слово, которого нет ни в одной вакансии

  const ps = profileSkills(profile);
  const counts = new Map();
  tf(tokens(profile.position), 3, counts);
  (profile.titleKeywords || []).forEach((k) => tf(tokens(k), 2, counts));
  tf(tokens(ps.map((s) => s.name).join(' ')), 2, counts);
  tf(tokens(profile.about), 1, counts);
  tf(tokens(resumeText).slice(0, 3000), 0.5, counts);

  const posTokens = [...new Set(tokens(profile.position))].filter((t) => !GRADE_WORDS.test(t));
  return { ps, idf, profileVec: counts.size ? vectorize(counts, idf) : null, posTokens };
}

// ---------- Оценка ----------

export function scoreVacancy(v, profile, now = Date.now(), ctx = makeContext(profile, [v])) {
  const text = `${v.title}\n${v.company}\n${v.description || v.snippet || ''}`.toLowerCase();

  const stop = (profile.stopWords || []).map((s) => s.trim().toLowerCase()).filter(Boolean).find((s) => text.includes(s));
  if (stop) return { score: 0, stopped: stop, matched: [], missing: [] };

  const date = Date.parse(v.publishedAt || v.firstSeenAt) || now;
  const ageDays = Math.max(0, (now - date) / 86400e3);
  if (profile.maxAgeDays && ageDays > profile.maxAgeDays) return { score: 0, tooOld: true, matched: [], missing: [] };

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
  let skillScore = null; // null — сравнивать нечего, вес уходит тексту
  if (total && mine.size) {
    skillScore = got / total;
    const primaryHit = [...primary].some((s) => required.has(s) || optional.has(s));
    if (primary.size && !primaryHit) skillScore *= 0.5;
  }

  // --- похожесть текста
  let textScore = null;
  if (ctx.profileVec) {
    const vv = vectorize(tf(tokens(vacText(v))), ctx.idf);
    textScore = Math.min(1, cosine(ctx.profileVec, vv) / 0.3);
  }

  // --- должность в названии
  let titleScore = 0.5;
  const titleToks = new Set(tokens(v.title));
  const kws = (profile.titleKeywords || []).map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (ctx.posTokens.length) {
    titleScore = ctx.posTokens.filter((t) => titleToks.has(t)).length / ctx.posTokens.length;
  }
  if (kws.length) {
    const titleL = v.title.toLowerCase();
    if (kws.some((k) => titleL.includes(k))) titleScore = Math.max(titleScore, 1);
    else if (!ctx.posTokens.length) titleScore = 0;
  }

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

  // Веса; если какой-то сигнал недоступен, его вес переходит к тексту/должности.
  const w = { skills: 0.35, text: 0.2, title: 0.2, grade: 0.08, salary: 0.1, fresh: 0.07 };
  if (skillScore == null) { w.text += w.skills; w.skills = 0; skillScore = 0; }
  if (textScore == null) { w.title += w.text; w.text = 0; textScore = 0; }
  let score = w.skills * skillScore + w.text * textScore + w.title * titleScore + w.grade * gradeScore + w.salary * salaryScore + w.fresh * fresh;

  // Формат/город: штраф, а не фильтр — в тексте формат часто не указан.
  const wantFormats = new Set(profile.formats || []);
  if (v.formats?.length && wantFormats.size && !v.formats.some((f) => wantFormats.has(f))) score *= 0.5;
  const cities = (profile.cities || []).map((c) => c.toLowerCase()).filter(Boolean);
  const officeOnly = v.formats?.length && !v.formats.includes('remote');
  if (officeOnly && cities.length && v.location && !cities.some((c) => v.location.toLowerCase().includes(c))) score *= 0.5;

  return {
    score: Math.round(score * 100) / 100,
    matched,
    missing,
    parts: { skills: skillScore, text: textScore, title: titleScore, grade: gradeScore, salary: salaryScore, fresh },
  };
}

// Удобная обёртка: оценки для набора вакансий.
export function scoreAll(vacancies, profile, resumeText = '', now = Date.now()) {
  const ctx = makeContext(profile, vacancies, resumeText);
  return vacancies.map((v) => ({ v, s: scoreVacancy(v, profile, now, ctx) }));
}
