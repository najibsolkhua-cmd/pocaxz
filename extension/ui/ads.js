// Рекламный блок на главной во время поиска. Сама CRM бесплатная — показы оплачивает реклама.
//
// mode 'stub' — демонстрационные объявления: проверить механику и вёрстку до подключения РСЯ.
// mode 'rsya' — фрейм со страницей сайта (site/ad.html), где стоит код блока РСЯ: в самом
//   расширении сторонние скрипты запрещены правилами Manifest V3, поэтому реклама живёт на сайте.

import { CONFIG } from '../config.js';
import { h } from './dom.js';

// Демо-объявления: картинки нарисованы CSS, ничего не грузится из сети.
const STUBS = [
  { domain: 'example-shop.ru', title: 'Дизайнерские кровати. В наличии и на заказ', art: 'bed' },
  { domain: 'course.example.ru', title: 'Курс «Маркетолог с нуля» — первые 2 недели бесплатно', art: 'course' },
  { domain: 'coworking.example.ru', title: 'Коворкинг у метро: рабочее место от 490 ₽ в день', art: 'desk' },
];

export function createAdSlot() {
  const mode = CONFIG.ads?.mode || 'off';
  const el = h('div', { class: 'ad-card', hidden: true, 'aria-label': 'Реклама' });
  if (mode === 'off') return { el, show() {}, hide() {}, enabled: false };

  let timer = null;
  let i = Math.floor(Math.random() * STUBS.length);
  const drawStub = () => {
    const ad = STUBS[i % STUBS.length];
    el.replaceChildren(
      h('div', { class: `ad-art ad-art-${ad.art}`, 'aria-hidden': 'true' }),
      h('div', { class: 'ad-shade' }),
      h('div', { class: 'ad-text' },
        h('div', { class: 'ad-meta' }, h('b', {}, ad.domain), ' Реклама · пример'),
        h('div', { class: 'ad-title' }, ad.title)),
      h('span', { class: 'ad-badge', title: 'Здесь будет блок Рекламной сети Яндекса' }, 'заглушка РСЯ'));
  };
  const drawFrame = () => {
    if (el.querySelector('iframe')) return;
    el.replaceChildren(h('iframe', {
      class: 'ad-frame',
      src: CONFIG.ads.frameUrl,
      title: 'Реклама',
      loading: 'lazy',
      referrerpolicy: 'strict-origin',
    }));
  };

  return {
    el,
    enabled: true,
    show() {
      if (!el.hidden) return;
      el.hidden = false;
      if (mode === 'rsya' && CONFIG.ads.frameUrl) { drawFrame(); return; }
      drawStub();
      timer = setInterval(() => { i++; drawStub(); }, (CONFIG.ads.rotateSec || 20) * 1000);
    },
    hide() {
      el.hidden = true;
      clearInterval(timer);
      timer = null;
    },
  };
}
