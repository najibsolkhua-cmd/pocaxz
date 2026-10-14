// Города: синонимы для сравнения, регион hh.ru и адрес раздела на Avito.

export const CITIES = [
  { name: 'Москва', aliases: ['москва', 'мск', 'moscow'], hh: 1, avito: 'moskva' },
  { name: 'Санкт-Петербург', aliases: ['санкт-петербург', 'спб', 'питер', 'петербург', 'saint-petersburg', 'st. petersburg'], hh: 2, avito: 'sankt-peterburg' },
  { name: 'Екатеринбург', aliases: ['екатеринбург', 'екб'], hh: 3, avito: 'ekaterinburg' },
  { name: 'Новосибирск', aliases: ['новосибирск', 'нск'], hh: 4, avito: 'novosibirsk' },
  { name: 'Казань', aliases: ['казань'], hh: 88, avito: 'kazan' },
  { name: 'Нижний Новгород', aliases: ['нижний новгород', 'нн', 'нижний'], hh: 66, avito: 'nizhniy_novgorod' },
  { name: 'Самара', aliases: ['самара'], hh: 78, avito: 'samara' },
  { name: 'Краснодар', aliases: ['краснодар'], hh: 53, avito: 'krasnodar' },
  { name: 'Ростов-на-Дону', aliases: ['ростов-на-дону', 'ростов'], hh: 76, avito: 'rostov-na-donu' },
  { name: 'Челябинск', aliases: ['челябинск'], hh: 104, avito: 'chelyabinsk' },
  { name: 'Уфа', aliases: ['уфа'], hh: 99, avito: 'ufa' },
  { name: 'Пермь', aliases: ['пермь'], hh: 72, avito: 'perm' },
  { name: 'Воронеж', aliases: ['воронеж'], hh: 26, avito: 'voronezh' },
  { name: 'Красноярск', aliases: ['красноярск'], hh: 54, avito: 'krasnoyarsk' },
  { name: 'Омск', aliases: ['омск'], hh: 68, avito: 'omsk' },
  { name: 'Волгоград', aliases: ['волгоград'], hh: 24, avito: 'volgograd' },
];

const norm = (s) => (s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

export function findCity(raw) {
  const s = norm(raw);
  if (!s) return null;
  return CITIES.find((c) => c.aliases.some((a) => norm(a) === s) || norm(c.name) === s) || null;
}

// Каноническое имя: «спб» → «Санкт-Петербург». Неизвестный город оставляем как есть.
export function canonicalCity(raw) {
  const c = findCity(raw);
  if (c) return c.name;
  const t = (raw || '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

// Упоминается ли город (с учётом синонимов) в тексте адреса вакансии.
export function cityMatches(cityRaw, location) {
  const loc = norm(location);
  if (!loc) return false;
  const c = findCity(cityRaw);
  const variants = c ? [c.name, ...c.aliases] : [cityRaw];
  return variants.some((v) => loc.includes(norm(v)));
}

export function cityByAvitoSlug(slug) {
  return CITIES.find((c) => c.avito === slug)?.name || null;
}

// Остальные города — только для распознавания в тексте вакансии («…в Минске», «г. Химки»).
const MORE_CITIES = [
  'Тюмень', 'Саратов', 'Тольятти', 'Ижевск', 'Барнаул', 'Ульяновск', 'Иркутск', 'Хабаровск', 'Ярославль', 'Владивосток',
  'Махачкала', 'Томск', 'Оренбург', 'Кемерово', 'Новокузнецк', 'Рязань', 'Астрахань', 'Набережные Челны', 'Пенза', 'Киров',
  'Липецк', 'Чебоксары', 'Калининград', 'Тула', 'Ставрополь', 'Курск', 'Улан-Удэ', 'Сочи', 'Тверь', 'Магнитогорск',
  'Иваново', 'Брянск', 'Белгород', 'Сургут', 'Владимир', 'Архангельск', 'Чита', 'Калуга', 'Смоленск', 'Волжский',
  'Курган', 'Череповец', 'Орёл', 'Вологда', 'Саранск', 'Владикавказ', 'Якутск', 'Мурманск', 'Подольск', 'Тамбов',
  'Грозный', 'Стерлитамак', 'Петрозаводск', 'Кострома', 'Нижневартовск', 'Новороссийск', 'Йошкар-Ола', 'Химки', 'Балашиха',
  'Мытищи', 'Королёв', 'Люберцы', 'Красногорск', 'Одинцово', 'Зеленоград', 'Долгопрудный', 'Реутов', 'Пушкино', 'Колпино',
  'Пушкин', 'Гатчина', 'Всеволожск', 'Мурино', 'Кудрово', 'Сыктывкар', 'Нальчик', 'Шахты', 'Дзержинск', 'Энгельс',
  'Минск', 'Алматы', 'Астана', 'Ташкент', 'Бишкек', 'Ереван', 'Тбилиси', 'Баку', 'Киев', 'Гродно', 'Брест', 'Гомель', 'Витебск',
  'Шымкент', 'Караганда', 'Дубай', 'Белград', 'Лимассол', 'Варшава', 'Берлин', 'Прага',
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Регулярка на город с падежными окончаниями: «Москва/Москве/Москвы», «Минск/Минске».
function cityRegex(name) {
  const base = norm(name).replace(/[аяоеьйиы]$/u, '');
  return new RegExp(`(?<![\\p{L}])${escapeRe(base)}[\\p{L}]{0,3}(?![\\p{L}-])`, 'iu');
}

const DETECT = [
  ...CITIES.map((c) => ({ name: c.name, res: [c.name, ...c.aliases.filter((a) => a.length >= 3)].map(cityRegex) })),
  ...MORE_CITIES.map((n) => ({ name: n, res: [cityRegex(n)] })),
];

// Все города, упомянутые в тексте (канонические названия).
export function citiesIn(text) {
  const t = (text || '').replace(/ё/g, 'е');
  if (!t) return [];
  return DETECT.filter((c) => c.res.some((re) => re.test(t))).map((c) => c.name);
}

// Город вакансии: сначала поле «адрес», иначе название и начало описания.
export function vacancyCities(v) {
  const fromLocation = citiesIn(v.location);
  if (fromLocation.length) return fromLocation;
  return citiesIn(`${v.title}\n${(v.description || v.snippet || '').slice(0, 400)}`);
}

export const ALL_CITY_NAMES = [...CITIES.map((c) => c.name), ...MORE_CITIES];
