// Партнёрские баннеры: несколько рекламодателей по очереди, постоянно (не только во время поиска).
// Список — в partners.json на сайте (CONFIG.partners.url), кешируется в браузере.
// Выбор баннеров идёт здесь же, в браузере, по должности из профиля: профиль никуда не отправляется.
//
// Формат баннера (partners.json → { "banners": [ ... ] }):
//   id          — уникальный код
//   advertiser  — рекламодатель (обязателен по закону о рекламе)
//   erid        — токен маркировки из ОРД (обязателен для показа в РФ)
//   title, text — заголовок и короткий текст
//   cta         — текст кнопки («Подробнее»)
//   url         — партнёрская ссылка
//   image       — https-картинка на фон (необязательно)
//   bg, color   — цвет фона и текста, если нет картинки
//   professions — слова должностей, кому показывать (пусто — всем): ["маркетолог", "smm"]
//   weight      — как часто показывать относительно других (по умолчанию 1)

import { CONFIG } from '../config.js';
import { h } from './dom.js';
import { countAd, flushAdStats } from '../lib/adstats.js';

// Встроенные примеры: показываются, пока на сайте нет partners.json. Реальных брендов здесь нет.
export const SAMPLE_BANNERS = [
  { id: 'sample-school', advertiser: 'Онлайн-школа (пример)', title: 'Профессия «Интернет-маркетолог»', text: 'Первые 2 недели бесплатно — проверьте, ваше ли это', cta: 'Подробнее', url: 'https://solkhua.ru/', bg: 'linear-gradient(135deg, #5b2bd6, #ff5c8a)', color: '#fff', professions: ['маркетолог', 'маркетинг', 'smm', 'таргет', 'marketing'] },
  { id: 'sample-bank', advertiser: 'Банк (пример)', title: 'Зарплатная карта с кешбэком', text: 'Получайте зарплату на карту с кешбэком до 30% у партнёров', cta: 'Оформить', url: 'https://solkhua.ru/', bg: 'linear-gradient(135deg, #ffdd2d, #ffb800)', color: '#17181b' },
  { id: 'sample-resume', advertiser: 'Карьерный сервис (пример)', title: 'Разбор резюме за 24 часа', text: 'Карьерный консультант подскажет, что поправить, чтобы чаще звали на интервью', cta: 'Узнать больше', url: 'https://solkhua.ru/', bg: 'linear-gradient(135deg, #0a86d1, #17c3b2)', color: '#fff' },
  { id: 'sample-it', advertiser: 'IT-школа (пример)', title: 'Python-разработчик с нуля', text: 'Курс с трудоустройством и проектами в портфолио', cta: 'Подробнее', url: 'https://solkhua.ru/', bg: 'linear-gradient(135deg, #17181b, #3d5aa8)', color: '#fff', professions: ['разработчик', 'developer', 'python', 'программист', 'аналитик'] },
];

const stem = (w) => w.toLowerCase().replace(/ё/g, 'е').slice(0, 6);
const valid = (b) => b && b.id && b.title && /^https:\/\//i.test(b.url || '') && b.advertiser;

// Баннеры для этого профиля: целевые по должности + общие (без professions).
export function pickBanners(banners, profile) {
  const words = [profile?.position, ...(profile?.titleKeywords || [])].join(' ').toLowerCase().match(/[a-zа-яё]{3,}/g) || [];
  const mine = new Set(words.map(stem));
  const fits = (b) => !b.professions?.length || b.professions.some((p) => mine.has(stem(p)) || [...mine].some((w) => w.startsWith(stem(p)) || stem(p).startsWith(w)));
  const out = [];
  for (const b of banners.filter(valid).filter(fits)) {
    for (let i = 0; i < Math.max(1, Math.min(5, Number(b.weight) || 1)); i++) out.push(b);
  }
  // Сначала целевые баннеры, потом общие.
  return out.sort((a, b) => Number(Boolean(b.professions?.length)) - Number(Boolean(a.professions?.length)));
}

// Свежий список с сайта (не чаще refreshHours), иначе кеш, иначе примеры.
let inflight = null;
export function loadBanners() {
  inflight ||= loadBannersOnce().finally(() => { inflight = null; });
  return inflight;
}
async function loadBannersOnce() {
  const cfg = CONFIG.partners || {};
  const { partnersCache } = await chrome.storage.local.get('partnersCache');
  const fresh = partnersCache && Date.now() - Date.parse(partnersCache.at) < (cfg.refreshHours || 6) * 3600e3;
  if (fresh || !cfg.url) return partnersCache?.banners?.length ? partnersCache.banners : SAMPLE_BANNERS;
  try {
    const r = await fetch(cfg.url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(String(r.status));
    const banners = ((await r.json()).banners || []).filter(valid);
    if (banners.length) {
      await chrome.storage.local.set({ partnersCache: { at: new Date().toISOString(), banners } });
      return banners;
    }
  } catch {
    // Сайт недоступен — не дёргаем его при каждой перерисовке: следующая попытка через refreshHours.
    await chrome.storage.local.set({ partnersCache: { at: new Date().toISOString(), banners: partnersCache?.banners || [] } });
  }
  return partnersCache?.banners?.length ? partnersCache.banners : SAMPLE_BANNERS;
}

export function createPartnerTile(root) {
  let list = [];
  let i = 0;
  let timer = null;
  const dots = h('div', { class: 'pb-dots' });

  const draw = () => {
    if (!list.length) { root.replaceChildren(h('p', { class: 'cta' }, 'Здесь будут предложения партнёров.')); return; }
    const b = list[i % list.length];
    const style = b.image
      ? { backgroundImage: `linear-gradient(180deg, rgba(0,0,0,.05) 30%, rgba(0,0,0,.65)), url("${encodeURI(b.image)}")`, color: '#fff' }
      : { background: b.bg || '#7d5a5a', color: b.color || '#fff' };
    // Показ засчитываем, только если вкладка на экране.
    if (document.visibilityState === 'visible') countAd(b.id, 'view');
    const ad = h('a', { class: 'pb', href: b.url, target: '_blank', rel: 'sponsored noopener', style, 'data-id': b.id, onclick: (e) => {
      e.stopPropagation();
      countAd(b.id, 'click').then(() => flushAdStats({ force: true }));
    } },
      h('span', { class: 'pb-mark' }, `Реклама · ${b.advertiser}${b.erid ? ` · erid: ${b.erid}` : ''}`),
      h('span', { class: 'pb-body' },
        h('b', { class: 'pb-title' }, b.title),
        b.text ? h('span', { class: 'pb-text' }, b.text) : null,
        h('span', { class: 'pb-cta' }, b.cta || 'Подробнее')));
    const unique = [...new Map(list.map((x) => [x.id, x])).values()];
    dots.replaceChildren(...unique.map((x) => h('button', {
      type: 'button',
      class: x.id === b.id ? 'on' : '',
      title: x.title,
      'aria-label': x.title,
      onclick: (e) => { e.stopPropagation(); i = list.findIndex((y) => y.id === x.id); draw(); restart(); },
    })));
    root.replaceChildren(ad, unique.length > 1 ? dots : null);
  };
  const restart = () => {
    clearInterval(timer);
    timer = setInterval(() => { i++; draw(); }, (CONFIG.partners?.rotateSec || 8) * 1000);
  };
  root.addEventListener('mouseenter', () => clearInterval(timer));
  root.addEventListener('mouseleave', restart);

  return {
    async update(profile) {
      const banners = await loadBanners();
      const next = pickBanners(banners, profile);
      const sig = next.map((b) => b.id).join('|');
      if (sig === list.map((b) => b.id).join('|')) return;
      list = next;
      i = 0;
      draw();
      restart();
    },
  };
}
