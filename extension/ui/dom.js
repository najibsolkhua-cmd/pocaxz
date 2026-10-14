// Мини-хелперы для DOM. Всё, что пришло со сторонних сайтов, выводится только
// через textContent — так HTML из вакансий не может выполниться на странице.

export const $ = (id) => document.getElementById(id);

export function h(tag, attrs = {}, ...children) {
  const svg = tag.startsWith('svg:');
  const el = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'href') el.setAttribute('href', /^https?:\/\//i.test(v) || v.startsWith('#') ? v : '#');
    else if (k in el && !svg && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false && c !== '') el.append(c instanceof Node ? c : String(c));
  return el;
}

export const splitList = (s) => (s || '').split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean);

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `сегодня ${time}`;
  const y = new Date(today.getTime() - 86400e3);
  if (d.toDateString() === y.toDateString()) return `вчера ${time}`;
  const tomorrow = new Date(today.getTime() + 86400e3);
  if (d.toDateString() === tomorrow.toDateString()) return `завтра ${time}`;
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function ago(iso) {
  if (!iso) return '';
  const d = (Date.now() - Date.parse(iso)) / 86400e3;
  if (d < 1 / 24) return 'только что';
  if (d < 1) return `${Math.round(d * 24)} ч назад`;
  return `${Math.round(d)} дн назад`;
}

export function daysSince(iso) {
  return iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400e3) : null;
}

export function fmtSalary(s) {
  if (!s) return '';
  const cur = { RUB: '₽', USD: '$', EUR: '€', KZT: '₸' }[s.currency] || s.currency;
  const n = (x) => x.toLocaleString('ru-RU');
  if (s.from && s.to) return `${n(s.from)}–${n(s.to)} ${cur}`;
  if (s.from) return `от ${n(s.from)} ${cur}`;
  if (s.to) return `до ${n(s.to)} ${cur}`;
  return '';
}

export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Логотипы площадок для плиток и заголовков панелей.
export function logo(platform, size = 'big') {
  const cls = `logo logo-${platform} logo-${size}`;
  if (platform === 'avito') {
    return h('svg:svg', { class: cls, viewBox: '0 0 100 100', 'aria-hidden': 'true' },
      h('svg:circle', { cx: 30, cy: 22, r: 10, fill: '#965eeb' }),
      h('svg:circle', { cx: 68, cy: 28, r: 22, fill: '#00a2ff', stroke: '#fff', 'stroke-width': 2.5 }),
      h('svg:circle', { cx: 32, cy: 66, r: 28, fill: '#04d95c' }),
      h('svg:circle', { cx: 74, cy: 74, r: 17, fill: '#f4404f' }));
  }
  if (platform === 'telegram') {
    return h('svg:svg', { class: cls, viewBox: '0 0 100 100', 'aria-hidden': 'true' },
      h('svg:path', { fill: '#fff', d: 'M8 49c0-3 2-5 5-6l71-29c4-2 8 1 7 6L80 84c-1 4-5 6-9 3L52 72l-9 9c-2 2-5 1-5-2V64l34-31c1-1 0-2-1-1L30 58l-18-6c-3-1-4-2-4-3z' }));
  }
  if (platform === 'hh') {
    return h('div', { class: `${cls} hh-mark` }, h('span', {}, 'hh'));
  }
  return h('div', { class: `${cls} sites-mark` }, 'https://');
}
