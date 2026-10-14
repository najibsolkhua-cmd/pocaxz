// Разбор «сырых» данных со страницы в нормализованную вакансию.
// Чистые функции без chrome.* — их можно тестировать в Node.

import { SKILLS, CASE_SENSITIVE_ALIASES } from './skills.js';

// Приблизительные курсы для сравнения зарплат в разных валютах.
export const FX = { RUB: 1, USD: 90, EUR: 100, KZT: 0.18 };

export function normSpaces(s) {
  return (s || '').replace(/[    ]/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

// ---------- Зарплата ----------

const NUM = String.raw`\d{1,3}(?:[   ]\d{3})+|\d+(?:[.,]\d+)?`;
const MULT = String.raw`\s*(?:тыс(?:\.|яч[а-я]*)?|т\.\s?р\.?|к|k)(?![a-zа-яё])`;
const CUR = String.raw`₽|руб(?:\.|л[а-яё]*)?|р\.|rub|rur|\$|usd|долл(?:\.|ар[а-яё]*)?|€|eur|евро|₸|kzt|тенге`;
const SALARY_RE = new RegExp(
  String.raw`(?:(от|from|до|up to)\s*)?(${CUR})?\s*(${NUM})(${MULT})?` +
  String.raw`(?:\s*(?:-|–|—|до|to)\s*(${CUR})?\s*(${NUM})(${MULT})?)?` +
  String.raw`\s*(${CUR})?`,
  'giu',
);
const SALARY_HINT_RE = /(зарплат|з\/п|(?<![\p{L}\p{N}])зп(?![\p{L}\p{N}])|оклад|доход|salary|вилка|компенсац|ставка)/iu;

function toNumber(s) {
  return parseFloat(s.replace(/[   ]/g, '').replace(',', '.'));
}

function currencyOf(s) {
  if (!s) return null;
  const c = s.toLowerCase();
  if (c === '$' || c.startsWith('usd') || c.startsWith('долл')) return 'USD';
  if (c === '€' || c.startsWith('eur') || c.startsWith('евро')) return 'EUR';
  if (c === '₸' || c.startsWith('kzt') || c.startsWith('тенге')) return 'KZT';
  return 'RUB';
}

// Возвращает { from, to, currency } или null. Числа — в единицах валюты в месяц.
export function parseSalary(text) {
  const t = normSpaces(text);
  if (!t) return null;
  for (const m of t.matchAll(SALARY_RE)) {
    const [, prefix, cur1, n1, mult1, cur2, n2, mult2, cur3] = m;
    const curRaw = cur1 || cur2 || cur3;
    const hasMult = Boolean(mult1 || mult2);
    const before = t.slice(Math.max(0, m.index - 25), m.index);
    if (!curRaw && !hasMult && !SALARY_HINT_RE.test(before)) continue;

    const currency = currencyOf(curRaw) || 'RUB';
    // «200-300к»: множитель указан один раз в конце и относится к обоим числам.
    const k1 = mult1 || (n2 && mult2) ? 1000 : 1;
    const k2 = mult2 || (mult1 && !mult2) ? 1000 : 1;
    let a = toNumber(n1) * k1;
    let b = n2 ? toNumber(n2) * k2 : null;
    // Без «к» рублёвая сумма меньше 1000 — это почти всегда тысячи («150-200 т.р.» уже учтено выше).
    if (currency === 'RUB' && !hasMult && a < 1000 && SALARY_HINT_RE.test(before)) {
      a *= 1000;
      if (b != null && b < 1000) b *= 1000;
    }
    const rub = (x) => x * FX[currency];
    if (rub(a) < 10000 || rub(a) > 5000000) continue;
    if (b != null && (b < a || rub(b) > 5000000)) b = null;

    const isUpTo = prefix && /^(до|up to)$/iu.test(prefix);
    if (isUpTo && b == null) return { from: null, to: Math.round(a), currency };
    return { from: Math.round(a), to: b == null ? null : Math.round(b), currency };
  }
  return null;
}

export function salaryInRub(s) {
  if (!s) return null;
  const k = FX[s.currency] || 1;
  return { from: s.from == null ? null : s.from * k, to: s.to == null ? null : s.to * k };
}

// ---------- Грейд ----------

export const GRADES = ['intern', 'junior', 'middle', 'senior', 'lead'];

const GRADE_PATTERNS = [
  ['intern', /(intern|trainee|стаж[её]р|стажировк)/iu],
  ['junior', /(junior|джун|джуниор|младш|начинающ|entry[- ]level)/iu],
  ['middle', /(middle|мидл|миддл)/iu],
  ['senior', /(senior|сеньор|синьор|старш|ведущ)/iu],
  ['lead', /(team ?lead|тимлид|тим-лид|tech ?lead|техлид|\blead\b|(?<![\p{L}\p{N}])лид(?![\p{L}\p{N}])|руководител|head of|principal|архитектор|architect)/iu],
];

function gradesByWords(text) {
  return GRADE_PATTERNS.filter(([, re]) => re.test(text)).map(([g]) => g);
}

function gradesByExperience(text) {
  const t = text.toLowerCase();
  if (/(без опыта|нет опыта|опыт не требуется|не требуется опыт)/u.test(t)) return ['intern', 'junior'];
  if (/более\s*6\s*лет|от\s*6\s*лет|6\+\s*лет/u.test(t)) return ['senior', 'lead'];
  if (/3\s*[–-]\s*6\s*лет/u.test(t)) return ['middle', 'senior'];
  if (/1\s*[–-]\s*3\s*(года|лет)/u.test(t)) return ['junior', 'middle'];
  const m = t.match(/опыт[а-яё ]{0,25}?(?:от|не менее|более|больше)?\s*(\d{1,2})(?:\+|\s*(?:год|лет|года))/u);
  if (m) {
    const y = Number(m[1]);
    if (y <= 1) return ['junior'];
    if (y <= 3) return ['middle'];
    if (y <= 5) return ['senior'];
    return ['senior', 'lead'];
  }
  return [];
}

// Сначала смотрим заголовок, потом опыт, потом весь текст.
export function parseGrades(title, body = '') {
  const byTitle = gradesByWords(title || '');
  if (byTitle.length) return byTitle;
  const byExp = gradesByExperience(body);
  if (byExp.length) return byExp;
  return gradesByWords((body || '').slice(0, 1500));
}

// ---------- Формат работы ----------

export function parseFormats(text) {
  const t = (text || '').toLowerCase();
  const out = new Set();
  if (/(удал[её]нн|удал[её]нк|удаленно|удалённо|remote|из любой точки|дистанционн)/u.test(t)) out.add('remote');
  if (/(гибрид|hybrid|гибкий график посещения)/u.test(t)) out.add('hybrid');
  if (/(в офисе|офис(?![\p{L}\p{N}])|офисе|office|on-?site|полный день в офисе)/u.test(t)) out.add('office');
  return [...out];
}

// ---------- Даты ----------

const MONTHS = {
  январ: 0, феврал: 1, март: 2, апрел: 3, ма: 4, июн: 5, июл: 6, август: 7, сентябр: 8, октябр: 9, ноябр: 10, декабр: 11,
};

function monthIndex(word) {
  const w = word.toLowerCase();
  for (const [stem, i] of Object.entries(MONTHS)) {
    if (stem === 'ма' ? /^ма[яй]/u.test(w) : w.startsWith(stem)) return i;
  }
  return -1;
}

// «3 часа назад», «вчера в 14:20», «12 октября», «опубликована 5 сентября 2026», ISO.
export function parseRuDate(text, now = new Date()) {
  if (!text) return null;
  const t = normSpaces(text).toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
    const d = new Date(text);
    return isNaN(d) ? null : d.toISOString();
  }
  const ago = t.match(/(\d+)\s*(минут|мин|час|дн|день|недел)[а-яё]*\s*назад/u);
  if (ago) {
    const n = Number(ago[1]);
    const unit = ago[2];
    const ms = unit.startsWith('мин') ? 60e3 : unit.startsWith('час') ? 3600e3 : unit.startsWith('недел') ? 7 * 86400e3 : 86400e3;
    return new Date(now.getTime() - n * ms).toISOString();
  }
  if (/только что|сегодня/u.test(t)) return now.toISOString();
  if (/вчера/u.test(t)) return new Date(now.getTime() - 86400e3).toISOString();
  if (/позавчера/u.test(t)) return new Date(now.getTime() - 2 * 86400e3).toISOString();
  const m = t.match(/(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?/u);
  if (m) {
    const mi = monthIndex(m[2]);
    if (mi >= 0) {
      let year = m[3] ? Number(m[3]) : now.getFullYear();
      let d = new Date(year, mi, Number(m[1]), 12);
      // «28 декабря» в январе — это прошлый год.
      if (!m[3] && d.getTime() > now.getTime() + 86400e3) d = new Date(year - 1, mi, Number(m[1]), 12);
      return d.toISOString();
    }
  }
  return null;
}

// ---------- Навыки ----------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasRegex(alias) {
  // Границы — не буква/цифра. Для «c++», «.net», «c#» это тоже работает.
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(alias)}(?![\\p{L}\\p{N}_+#])`, 'giu');
}

const DICT = SKILLS.map(([slug, name, aliases]) => ({
  slug,
  name,
  matchers: aliases.map((a) => ({ re: aliasRegex(a), needsUpper: CASE_SENSITIVE_ALIASES.has(a) })),
}));

export const SKILL_NAMES = Object.fromEntries(SKILLS.map(([slug, name]) => [slug, name]));

function hasMatch(text, { re, needsUpper }) {
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    if (!needsUpper || /[A-ZА-ЯЁ]/u.test(m[0])) return true;
  }
  return false;
}

// Свободный навык из профиля -> slug словаря или собственный slug.
export function resolveSkill(raw) {
  const s = normSpaces(raw).toLowerCase();
  if (!s) return null;
  for (const [slug, name, aliases] of SKILLS) {
    if (slug === s || name.toLowerCase() === s || aliases.includes(s)) return { slug, name, custom: false };
  }
  return { slug: `custom:${s}`, name: normSpaces(raw), custom: true, re: aliasRegex(s) };
}

const OPTIONAL_MARKER_RE = /(будет плюсом|будет преимуществом|желательно|приветствуется|nice to have|плюсом будет|как плюс)/iu;

// Возвращает { required: [slug], optional: [slug] }.
// Навыки, встреченные только после «будет плюсом», считаются необязательными.
export function extractSkills(text, extra = []) {
  const t = text || '';
  const cut = t.search(OPTIONAL_MARKER_RE);
  const main = cut >= 0 ? t.slice(0, cut) : t;
  const tail = cut >= 0 ? t.slice(cut) : '';
  const required = [];
  const optional = [];
  const all = [...DICT, ...extra.filter((e) => e.custom).map((e) => ({ slug: e.slug, matchers: [{ re: e.re, needsUpper: false }] }))];
  for (const sk of all) {
    if (sk.matchers.some((m) => hasMatch(main, m))) required.push(sk.slug);
    else if (tail && sk.matchers.some((m) => hasMatch(tail, m))) optional.push(sk.slug);
  }
  return { required, optional };
}

// ---------- Telegram/VK: пост — это вакансия? ----------

const VAC_POS_RE = /(#ваканси|#vacanc|#job\b|#работа|#hiring|ваканси[яи]|ищем\s|требуется|требуются|в команду|в нашу команду|открыта позиция|hiring|зарплата|з\/п|(?<![\p{L}\p{N}])зп(?![\p{L}\p{N}])|salary|вилка|обязанности|требования|откликнуться|присылайте резюме|отправляйте резюме)/iu;
const VAC_NEG_RE = /(#резюме|#resume|#cv\b|#ищу_?работу|ищу работу|рассмотрю предложения|#реклама|#промо|erid[:\s])/iu;

export function looksLikeVacancy(text) {
  const t = text || '';
  if (VAC_NEG_RE.test(t)) return false;
  return VAC_POS_RE.test(t);
}

// Заголовок поста: первая содержательная строка без эмодзи и хэштегов.
export function titleFromPost(text) {
  const lines = (text || '').split(/\n+/).map((l) =>
    normSpaces(l.replace(/#[\p{L}\p{N}_]+/gu, '').replace(/[\p{Extended_Pictographic}️]/gu, '').replace(/^[\s\-–—•*:|]+/u, '')),
  );
  const line = lines.find((l) => l.length >= 4 && !/^ваканси[яи]:?$/iu.test(l)) || lines.find(Boolean) || 'Вакансия';
  const m = line.match(/^ваканси[яи]\s*[:\-–—]\s*(.+)$/iu);
  return (m ? m[1] : line).slice(0, 140);
}

export function companyFromPost(text) {
  const m = (text || '').match(/(?:компания|company|работодатель)\s*[:\-–—]\s*([^\n,.;|]{2,60})/iu);
  return m ? normSpaces(m[1]) : '';
}

// ---------- Сайты компаний: ссылка — это вакансия? ----------
// Названия любые («Продавец-кассир», «Товаровед»), поэтому отсекаем только явную навигацию.

const JUNK_TITLE_RE = /^(о нас|о компании|компания|бонусы|льготы|преимущества|контакты|войти|вход|регистрация|все вакансии|вакансии|карьера|блог|новости|пресс|faq|вопросы|помощь|политика|главная|наши ценности|ценности|команда|офисы?|как мы работаем|как устроен|отбор|этапы|стажировк[аи]$|студентам|выпускникам|направлени[яе]|подписаться|поделиться|cookie|куки|privacy|about|benefits|contacts?|login|sign in|blog|news|home)(?![\p{L}])/iu;

export function looksLikeJobTitle(title) {
  const t = normSpaces(title);
  return t.length >= 4 && t.length <= 160 && !JUNK_TITLE_RE.test(t);
}

// ---------- Сборка вакансии ----------

export function dedupKey(company, title) {
  const n = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/(?<![\p{L}\p{N}])(ооо|ао|пао|зао|llc|ltd|inc)(?![\p{L}\p{N}])/gu, '').trim();
  const c = n(company);
  const t = n(title);
  return c && t ? `${c}|${t}` : null;
}

// item — то, что вернул экстрактор со страницы (см. extractors/page.js).
export function normalizeItem(item, platform, now = new Date()) {
  const isPost = platform === 'telegram' || platform === 'vk';
  const body = normSpaces([item.snippet, item.description, item.formatText].filter(Boolean).join('\n')).slice(0, 9000);
  const fullText = [item.title, item.salaryText, item.cardText, body, (item.tags || []).join(', ')].filter(Boolean).join('\n');

  if (isPost && !looksLikeVacancy(fullText)) return null;

  const title = normSpaces(item.title) || normSpaces(item.pageTitle) || (isPost ? titleFromPost(item.description || item.cardText) : '');
  if (!title) return null;
  // На сайтах компаний ссылки вида /careers/about тоже похожи на вакансии.
  if (platform === 'generic' && !looksLikeJobTitle(title)) return null;
  if (item.archived) return null;
  const company = normSpaces(item.company) || (isPost ? companyFromPost(fullText) : '');
  const skillText = [title, body, (item.tags || []).join(', '), item.cardText].filter(Boolean).join('\n');
  const { required, optional } = extractSkills(skillText);
  // Теги «Ключевые навыки» на hh всегда обязательные.
  for (const tag of item.tags || []) {
    const r = resolveSkill(tag);
    if (r && !r.custom && !required.includes(r.slug)) required.push(r.slug);
  }

  return {
    platform,
    externalId: String(item.externalId),
    url: item.url,
    title,
    company,
    location: normSpaces(item.location),
    salary: parseSalary(item.salaryText || '') || parseSalary(fullText),
    grades: parseGrades(title, [item.experience, body, item.cardText].filter(Boolean).join('\n')),
    formats: parseFormats(fullText),
    skills: required,
    skillsOptional: optional.filter((s) => !required.includes(s)),
    snippet: normSpaces(item.snippet || '').slice(0, 600),
    description: body,
    links: item.links || [],
    publishedAt: parseRuDate(item.publishedText, now) || null,
    enriched: Boolean(item.enriched),
  };
}
