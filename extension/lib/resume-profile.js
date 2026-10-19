// «Заполнить из резюме»: достаём из текста резюме всё, что нужно профилю.
// Рассчитано на резюме с hh.ru (PDF/DOCX/RTF), но работает и с произвольным текстом.

import { extractSkills, parseSalary, SKILL_NAMES } from './parse.js';
import { canonicalCity, findCity } from './geo.js';

const lines = (t) => t.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
// Для навыков нужны «сырые» строки: в hh-резюме навыки разделены двойными пробелами.
const rawLines = (t) => t.split('\n').map((l) => l.trim()).filter(Boolean);

const HEADERS = /^(желаемая должность|специализаци|занятость|тип занятости|график работы|график|формат работы|формат|желательное время|готов к|готовность|переезд|командировк|оформление|опыт работы|образование|ключевые навыки|навыки|знание языков|дополнительная информация|обо мне|о себе|повышение квалификации|тесты|рекомендации|портфолио|гражданство|контакты|резюме обновлено|experience|education|skills|about me|summary)/i;
const JOB_WORD = /(маркетолог|разработчик|developer|engineer|инженер|аналитик|analyst|менеджер|manager|специалист|дизайнер|designer|тестировщик|руководитель|директор|бухгалтер|юрист|рекрутер|копирайтер|smm|seo|таргетолог|продюсер|логист|администратор|ассистент|программист|lead|head|продавец|консультант|оператор|редактор)/i;

// Строки после заголовка до следующего заголовка. Заголовков может быть несколько.
function sectionAfter(ls, headerRe, stopRe = HEADERS, max = 40) {
  const out = [];
  ls.forEach((l, i) => {
    if (!headerRe.test(l)) return;
    for (let j = i + 1; j < ls.length && out.length < max; j++) {
      if (stopRe.test(ls[j])) break;
      out.push(ls[j]);
    }
  });
  return out;
}

function guessName(ls) {
  // Первая строка из 2–3 слов с заглавной буквы без цифр: «Иванов Иван Иванович».
  const line = ls.slice(0, 8).find((l) => /^[А-ЯЁA-Z][а-яёa-z-]+(\s+[А-ЯЁA-Z][а-яёa-z-]+){1,2}$/.test(l) && !JOB_WORD.test(l));
  if (!line) return '';
  const words = line.split(/\s+/);
  // В российских резюме обычно «Фамилия Имя Отчество».
  return words.length >= 2 ? words[1] : words[0];
}

function guessPosition(ls) {
  const sec = sectionAfter(ls, /^желаемая должность/i, HEADERS, 4);
  const fromSection = sec.find((l) => !/^(специализаци|—|-|•)/i.test(l) && !/\d{2,}/.test(l));
  if (fromSection) return fromSection.replace(/[,;.]$/, '');
  const head = ls.slice(0, 15).find((l) => JOB_WORD.test(l) && l.length <= 80 && !/@|\+7|\d{3}/.test(l));
  return head ? head.replace(/[,;.]$/, '') : '';
}

// Строки-поля резюме («Тип занятости: полная», «График: 5/2») — не должности.
const NOT_TITLE = /:|\d|занятост|график|формат|зарплат|опыт|время в пути|переезд|командиров|гражданств|оформлен|релокац|удал[её]нн|полный день|гибрид/i;

function guessAltTitles(ls, position) {
  const spec = sectionAfter(ls, /^специализаци/i, HEADERS, 10)
    .flatMap((l) => l.replace(/^[—•\-–\s]+/, '').split(/,\s*/))
    .map((l) => l.trim())
    .filter((l) => l && l.length <= 60 && !NOT_TITLE.test(l) && l.toLowerCase() !== position.toLowerCase());
  return [...new Set(spec)].slice(0, 6);
}

function guessYears(text) {
  const m = text.match(/опыт работы\s*[—–-]?\s*(\d{1,2})\s*(?:год|лет)/i) || text.match(/(\d{1,2})\+?\s*(?:год|года|лет)\s+опыта/i)
    || text.match(/опыт(?:ом)?\s+(?:работы\s+)?(?:более\s+|свыше\s+)?(\d{1,2})[\s-]*(?:лет|год)/i) || text.match(/(\d{1,2})[\s-]*(?:летн\w+)\s+опыт/i);
  return m ? Number(m[1]) : null;
}

function guessGrade(text, position) {
  if (/(руководитель|директор|head|lead|тимлид|cmo|cto)/i.test(position)) return 'lead';
  const y = guessYears(text);
  if (y == null) return '';
  if (y < 1) return 'junior';
  if (y < 3) return 'junior';
  if (y < 6) return 'middle';
  return 'senior';
}

function guessFormats(text) {
  const t = text.toLowerCase();
  const out = new Set();
  const line = (t.match(/(?:график работы|формат работы)[^\n]*/g) || []).join(' ');
  const src = line || t.slice(0, 3000);
  if (/удал[её]нн|remote|дистанц/.test(src)) out.add('remote');
  if (/гибрид|hybrid/.test(src)) out.add('hybrid');
  if (/полный день|на месте работодателя|офис|сменный|гибкий график/.test(src)) out.add('office');
  return out.size ? [...out] : [];
}

function guessCity(text) {
  const m = text.match(/(?:проживает|город|место проживания|location)\s*:?\s*([А-ЯЁA-Z][^\n,;]{1,40})/i);
  if (m) return canonicalCity(m[1].trim());
  for (const l of lines(text).slice(0, 15)) {
    const c = findCity(l.replace(/[,.].*$/, ''));
    if (c) return c.name;
  }
  return '';
}

function guessSalary(ls) {
  const sec = sectionAfter(ls, /^желаемая должность/i, /^(опыт работы|образование|ключевые навыки)/i, 12).join('\n');
  const s = parseSalary(sec);
  if (!s) return 0;
  const v = s.from || s.to || 0;
  return s.currency === 'RUB' ? v : 0;
}

function guessAbout(ls) {
  const about = sectionAfter(ls, /^(обо мне|о себе|about me|summary|профессиональные навыки и качества)/i, HEADERS, 30).join('\n');
  if (about.length >= 60) return about.slice(0, 1500);
  // Нет раздела «Обо мне» — собираем содержательные предложения, без ФИО, контактов и полей резюме.
  // Строку, которую PDF перенёс («…платёжными системами и» + «внутренние сервисы»), склеиваем,
  // иначе короткий хвост отсеется и предложение оборвётся на «и».
  const joined = [];
  for (const l of ls) {
    const prev = joined.at(-1);
    if (prev && !/[.!?:;]$/.test(prev) && /^[a-zа-яё]/.test(l) && !HEADERS.test(l)) joined[joined.length - 1] = `${prev} ${l}`;
    else joined.push(l);
  }
  const sentences = joined.filter((l) => l.length >= 60 && !/@|\+7|https?:|проживает|гражданство|родил/i.test(l) && !HEADERS.test(l));
  return sentences.join(' ').slice(0, 1000);
}

function guessSkills(_ls, text) {
  const ls = rawLines(text);
  const { required, optional } = extractSkills(text);
  const dict = [...new Set([...required, ...optional])].map((s) => SKILL_NAMES[s]);
  // Блок «Навыки» из hh: короткие пункты, которых может не быть в словаре.
  const block = sectionAfter(ls, /^(ключевые навыки|навыки|skills)$/i, HEADERS, 40)
    .flatMap((l) => l.split(/[,;•·]|\s{2,}/))
    .map((x) => x.replace(/^[—\-–\s]+/, '').trim())
    .filter((x) => x.length >= 2 && x.length <= 40 && !/^(знание языков|русский|английский —)/i.test(x));
  const seen = new Set(dict.map((x) => x.toLowerCase()));
  const extra = block.filter((x) => !seen.has(x.toLowerCase()) && (seen.add(x.toLowerCase()), true));
  return [...dict, ...extra].slice(0, 40);
}

export function profileFromResume(text) {
  const ls = lines(text);
  const position = guessPosition(ls);
  const city = guessCity(text);
  return {
    name: guessName(ls),
    position,
    titleKeywords: guessAltTitles(ls, position),
    about: guessAbout(ls),
    grade: guessGrade(text, position),
    minSalary: guessSalary(ls),
    formats: guessFormats(text),
    cities: city ? [city] : [],
    skills: guessSkills(ls, text),
  };
}
