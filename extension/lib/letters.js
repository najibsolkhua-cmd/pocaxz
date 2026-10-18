// Сопроводительные письма: шаблоны с подстановками из профиля и вакансии.
//
// Подстановки: {вакансия} {компания} {имя} {должность} {навыки} {опыт} {контакты}
// Фрагмент в [[двойных скобках]] пропадает целиком, если хоть одна подстановка в нём пустая:
//   «Меня заинтересовала вакансия «{вакансия}»[[ в компании «{компания}»]].»
// «рад(а)», «готов(а)» — по полу из настроек писем: «рад» / «рада» / как есть.
//
// Шаблон «Под вакансию» (auto) не редактируется: письмо собирается заново для каждой вакансии —
// из её названия, компании, навыков из описания, формата работы и самых близких к ней
// предложений вашего «Чем я занимаюсь».

import { SKILL_NAMES } from './parse.js';
import { tokens } from './match.js';

export const AUTO_TEMPLATE = { id: 'auto', name: 'Под вакансию (собирается само)', auto: true, text: '' };

export const DEFAULT_TEMPLATES = [
  AUTO_TEMPLATE,
  {
    id: 'short',
    name: 'Короткое',
    text: `Здравствуйте!

Меня заинтересовала вакансия «{вакансия}»[[ в компании «{компания}»]]. [[Мой опыт: {опыт}]]
[[
Подхожу по ключевым навыкам: {навыки}.]]

Буду рад(а) обсудить детали на созвоне.

[[{имя}]][[
{контакты}]]`,
  },
  {
    id: 'detailed',
    name: 'Подробное',
    text: `Добрый день!

Откликаюсь на вакансию «{вакансия}»[[ в «{компания}»]]. Я — {должность}[[, {опыт}]].
[[
Что могу дать команде с первых недель: {навыки}.]]

Почему эта вакансия: мне близки задачи из описания, и я понимаю, как применить в них свой опыт. Готов(а) выполнить тестовое задание, если это поможет принять решение.

Спасибо за внимание!
[[{имя}]][[
{контакты}]]`,
  },
];

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Первое содержательное предложение «Чем я занимаюсь» (до ~220 символов), со строчной буквы.
export function experienceLine(about) {
  const text = clean(about);
  if (!text) return '';
  const first = text.split(/(?<=[.!?])\s+/)[0] || text;
  const cut = first.length > 220 ? `${first.slice(0, 220).replace(/[,;\s]+\S*$/, '')}…` : first;
  return cut.replace(/[.!?]+$/, '').replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase());
}

// Навыки для письма: сначала те, что совпали с вакансией, потом основные из профиля.
export function letterSkills(matched = [], profileSkills = [], limit = 5) {
  const fromVacancy = matched.map((k) => SKILL_NAMES[k] || String(k).replace(/^custom:/, ''));
  const own = profileSkills.map((s) => String(s).replace(/^\*/, ''));
  return [...new Map([...fromVacancy, ...own].filter(Boolean).map((x) => [x.toLowerCase(), x])).values()].slice(0, limit).join(', ');
}

// Хранилище писем → полный набор: шаблон «Под вакансию» всегда первый. Тем, у кого письма
// были до его появления, он один раз ставится по умолчанию.
export function normalizeLetters(raw) {
  const saved = raw?.templates?.length ? raw.templates.filter((t) => t.id !== 'auto') : DEFAULT_TEMPLATES.filter((t) => !t.auto);
  const migrate = !raw?.autoAdded;
  return {
    templates: [AUTO_TEMPLATE, ...saved],
    defaultId: migrate ? 'auto' : (raw.defaultId && [AUTO_TEMPLATE, ...saved].some((t) => t.id === raw.defaultId) ? raw.defaultId : 'auto'),
    contacts: raw?.contacts || '',
    gender: ['m', 'f'].includes(raw?.gender) ? raw.gender : '',
    autoAdded: true,
  };
}

// «рад(а)» → «рад» / «рада».
export function applyGender(text, gender) {
  if (!gender) return text;
  return text.replace(/(\p{L}+)\(а\)/gu, (_, w) => (gender === 'f' ? `${w}а` : w));
}

const GRADE_TEXT = { intern: 'стажёр', junior: 'junior', middle: 'middle', senior: 'senior', lead: 'lead' };
const FORMAT_TEXT = { remote: 'удалённо', hybrid: 'гибрид', office: 'офис' };
const sentence = (s) => {
  const t = clean(s).replace(/^[-–—•*\s]+/, '');
  if (!t) return '';
  return `${t[0].toUpperCase()}${t.slice(1)}`.replace(/[.!?…]*$/, (end) => end || '.');
};
// «Маркетолог» → «маркетолог», а «Product Manager» — как есть.
const lower = (s) => s.replace(/^[А-ЯЁ](?=[а-яё])/, (c) => c.toLowerCase());

// Предложения «Чем я занимаюсь», ближе всего к тексту вакансии (по общим словам), в исходном порядке.
export function relevantSentences(about, vacancyText, limit = 2) {
  const parts = clean(about).split(/(?<=[.!?])\s+|\s*[;•]\s*/).map((x) => x.trim()).filter((x) => x.length >= 15 && x.length <= 260);
  if (!parts.length) return [];
  const want = new Set(tokens(vacancyText));
  const scored = parts.map((text, i) => {
    const own = [...new Set(tokens(text))];
    const hits = own.filter((t) => want.has(t)).length;
    return { text, i, score: own.length ? hits / Math.sqrt(own.length) : 0, hits };
  });
  const best = scored.filter((x) => x.hits > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  return (best.length ? best : scored.slice(0, 1)).sort((a, b) => a.i - b.i).map((x) => sentence(x.text));
}

// Письмо под конкретную вакансию — из всего, что известно о ней и о вас.
export function autoLetter({ vacancy = {}, profile = {}, matched = [], contacts = '', gender = '' } = {}) {
  const title = clean(vacancy.title);
  const company = clean(vacancy.company);
  const position = clean(profile.position);
  const vacancyText = [vacancy.title, vacancy.description, vacancy.snippet, (vacancy.tags || []).join(' ')].filter(Boolean).join(' ');
  const out = ['Здравствуйте!'];

  out.push(`Меня заинтересовала вакансия «${title || 'из вашего объявления'}»${company ? ` в компании «${company}»` : ''} — хочу предложить свою кандидатуру.`);

  const grade = GRADE_TEXT[profile.grade];
  const who = position ? `Я — ${lower(position)}${grade && !new RegExp(grade, 'i').test(position) ? ` уровня ${grade}` : ''}.` : '';
  const about = relevantSentences(profile.about, vacancyText).join(' ');
  if (who || about) out.push([who, about].filter(Boolean).join(' '));

  const fromVacancy = [...new Set(matched.map((k) => SKILL_NAMES[k] || String(k).replace(/^custom:/, '')))].slice(0, 5);
  const others = (profile.skills || []).map((x) => String(x).replace(/^\*/, ''))
    .filter((x) => !fromVacancy.some((m) => m.toLowerCase() === x.toLowerCase())).slice(0, Math.max(0, 5 - fromVacancy.length));
  if (fromVacancy.length) {
    out.push(`В описании вижу то, с чем работаю постоянно: ${fromVacancy.join(', ')}.${others.length ? ` Также владею: ${others.join(', ')}.` : ''}`);
  } else if (others.length) {
    out.push(`Мои основные навыки: ${others.join(', ')}.`);
  }

  const both = (vacancy.formats || []).filter((f) => (profile.formats || []).includes(f));
  const city = (profile.cities || []).find((c) => clean(vacancy.location).toLowerCase().includes(String(c).toLowerCase()));
  const terms = [
    both.length && both.length < 3 ? `формат «${both.map((f) => FORMAT_TEXT[f]).join(' / ')}» мне подходит` : '',
    city ? `я нахожусь в городе ${city}` : '',
  ].filter(Boolean);
  if (terms.length) out.push(sentence(terms.join(', ')));

  out.push('Буду рад(а) рассказать подробнее о своём опыте на созвоне и ответить на вопросы. Если нужно — готов(а) выполнить тестовое задание.');
  out.push(['С уважением,', clean(profile.name), String(contacts || '').trim()].filter(Boolean).join('\n'));
  return applyGender(out.join('\n\n'), gender).replace(/[ \t]+\n/g, '\n').trim();
}

export function renderLetter(template, { vacancy = {}, profile = {}, matched = [], contacts = '', gender = '' } = {}) {
  if (template?.auto) return autoLetter({ vacancy, profile, matched, contacts, gender });
  const values = {
    вакансия: clean(vacancy.title),
    компания: clean(vacancy.company),
    имя: clean(profile.name),
    должность: clean(profile.position).toLowerCase(),
    навыки: letterSkills(matched, profile.skills || []),
    опыт: experienceLine(profile.about),
    контакты: String(contacts || '').trim(),
  };
  const fill = (s) => s.replace(/\{([а-яё]+)\}/g, (_, k) => values[k] ?? '');
  const withOptional = String(template.text || template).replace(/\[\[([\s\S]*?)\]\]/g, (_, part) => {
    const keys = [...part.matchAll(/\{([а-яё]+)\}/g)].map((m) => m[1]);
    return keys.every((k) => values[k]) ? part : '';
  });
  return applyGender(fill(withOptional), gender)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +([.,!?])/g, '$1')
    .trim();
}
