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
