// Оценка «насколько вакансия подходит профилю». Чистые функции, без chrome.*.

import { GRADES, resolveSkill, extractSkills, salaryInRub } from './parse.js';

export const DEFAULT_PROFILE = {
  titleKeywords: [],      // ['python', 'backend', 'бэкенд']
  grade: 'middle',
  skills: [],             // ['Python', '*Django', 'PostgreSQL'] — «*» = основной стек
  minSalary: 0,           // ₽ в месяц
  formats: ['remote', 'hybrid', 'office'],
  cities: [],
  stopWords: [],
  maxAgeDays: 30,
};

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

const W = { skills: 0.5, title: 0.2, grade: 0.1, salary: 0.1, fresh: 0.1 };

export function scoreVacancy(v, profile, now = Date.now(), ps = profileSkills(profile)) {
  const text = `${v.title}\n${v.company}\n${v.description || v.snippet || ''}`.toLowerCase();

  const stop = (profile.stopWords || []).map((s) => s.trim().toLowerCase()).filter(Boolean).find((s) => text.includes(s));
  if (stop) return { score: 0, stopped: stop, matched: [], missing: [] };

  const date = Date.parse(v.publishedAt || v.firstSeenAt) || now;
  const ageDays = Math.max(0, (now - date) / 86400e3);
  if (profile.maxAgeDays && ageDays > profile.maxAgeDays) return { score: 0, tooOld: true, matched: [], missing: [] };

  // Навыки: словарные уже извлечены при сборе, свои навыки из профиля ищем сейчас.
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
  let skillScore = total ? got / total : 0.3; // навыки не нашлись — нейтрально-низко
  const primaryHit = [...primary].some((s) => required.has(s) || optional.has(s));
  if (primary.size && !primaryHit) skillScore *= 0.5;

  const kws = (profile.titleKeywords || []).map((k) => k.trim().toLowerCase()).filter(Boolean);
  const titleL = v.title.toLowerCase();
  const titleScore = kws.length ? (kws.some((k) => titleL.includes(k)) ? 1 : 0) : 0.5;

  let gradeScore = 0.7;
  if (profile.grade && v.grades?.length) {
    const ug = GRADES.indexOf(profile.grade);
    const dist = Math.min(...v.grades.map((g) => Math.abs(GRADES.indexOf(g) - ug)));
    gradeScore = dist === 0 ? 1 : dist === 1 ? 0.4 : 0;
  }

  let salaryScore = 0.6;
  const rub = salaryInRub(v.salary);
  if (profile.minSalary && rub) {
    const top = rub.to ?? rub.from;
    salaryScore = top >= profile.minSalary ? 1 : top >= profile.minSalary * 0.85 ? 0.5 : 0;
  }

  const fresh = Math.exp(-ageDays / 10);

  let score = W.skills * skillScore + W.title * titleScore + W.grade * gradeScore + W.salary * salaryScore + W.fresh * fresh;

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
    parts: { skills: skillScore, title: titleScore, grade: gradeScore, salary: salaryScore, fresh },
  };
}
