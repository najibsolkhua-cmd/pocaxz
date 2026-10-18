// Сопроводительные письма: шаблоны с подстановками из профиля и вакансии.
//
// Подстановки: {вакансия} {компания} {имя} {должность} {навыки} {опыт} {контакты}
// Фрагмент в [[двойных скобках]] пропадает целиком, если хоть одна подстановка в нём пустая:
//   «Меня заинтересовала вакансия «{вакансия}»[[ в компании «{компания}»]].»

import { SKILL_NAMES } from './parse.js';

export const DEFAULT_TEMPLATES = [
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

export function renderLetter(template, { vacancy = {}, profile = {}, matched = [], contacts = '' } = {}) {
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
  return fill(withOptional)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +([.,!?])/g, '$1')
    .trim();
}
