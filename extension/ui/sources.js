// Источники: список с состоянием обхода и форма добавления.

import * as store from '../lib/store.js';
import { h, fmtTime } from './dom.js';

const send = (msg) => chrome.runtime.sendMessage(msg);
const INTERVALS = [30, 60, 120, 240, 360, 720, 1440];
const intervalLabel = (m) => (m < 60 ? `каждые ${m} мин` : m < 1440 ? `каждые ${m / 60} ч` : 'раз в сутки');
const STATUS_TEXT = { ok: 'ok', empty: 'пусто', failed: 'ошибка', blocked: 'нужна проверка' };

const ADD_HELP = {
  hh: {
    placeholder: 'https://hh.ru/search/vacancy?text=…  или просто запрос: python backend',
    help: 'Лучше всего: настройте поиск на hh.ru со своими фильтрами (город, опыт, график), скопируйте ссылку из адресной строки и вставьте сюда. Можно ввести просто запрос.',
  },
  avito: {
    placeholder: 'https://www.avito.ru/moskva/vakansii?q=…  или запрос: менеджер по продажам',
    help: 'Откройте Avito → Работа → Вакансии, задайте город и фильтры, отсортируйте «По дате» и вставьте ссылку. Можно ввести просто запрос.',
  },
  telegram: {
    placeholder: 'https://t.me/имя_канала  или  @имя_канала',
    help: 'Только публичные каналы. Расширение читает их открытую веб-версию t.me/s/…, входить в Telegram не нужно.',
  },
  generic: {
    placeholder: 'https://company.ru/careers/vacancies',
    help: 'Страница со списком вакансий компании. Браузер спросит разрешение на доступ к сайту — его нужно дать. Если вакансии не находятся, раскройте «Ручная настройка».',
  },
};

function toUrl(platform, raw) {
  const v = raw.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (platform === 'telegram') {
    const name = v.replace(/^@/, '').replace(/^t\.me\//, '');
    return /^[A-Za-z0-9_]{4,}$/.test(name) ? `https://t.me/s/${name}` : null;
  }
  if ((platform === 'hh' || platform === 'avito') && v) return store.autoSearchUrl(platform, v);
  if (platform === 'generic' && /^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(v)) return `https://${v}`;
  return null;
}

export function sourceRows(sources, all, { compact = false } = {}) {
  const update = async (id, patch) => {
    const list = await store.getSources();
    await store.saveSources(list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };
  if (!sources.length) return h('div', { class: 'empty small' }, 'Источников пока нет.');
  return h('div', { class: 'src-list' }, sources.map((s) => {
    const st = all[`srcstate:${s.id}`] || {};
    return h('div', { class: `src-row ${s.enabled ? '' : 'off'}` },
      h('label', { class: 'switch', title: s.enabled ? 'Включён' : 'Выключен' },
        h('input', { type: 'checkbox', checked: s.enabled, onchange: (e) => update(s.id, { enabled: e.target.checked }) }), h('span', {})),
      h('div', { class: 'src-main' },
        h('div', { class: 'src-name' }, s.name, s.auto ? h('span', { class: 'tag' }, 'по должности') : null),
        h('a', { class: 'src-url', href: s.url, target: '_blank', rel: 'noopener' }, s.url),
        h('div', { class: 'src-state' },
          st.lastRunAt ? `${fmtTime(st.lastRunAt)} · ` : 'ещё не искали',
          st.lastStatus ? h('span', { class: `st-${st.lastStatus}` }, STATUS_TEXT[st.lastStatus]) : null,
          st.lastStatus === 'ok' || st.lastStatus === 'empty' ? ` · найдено ${st.lastFound}, новых ${st.lastAdded}` : null,
          st.lastError ? h('span', { class: 'muted' }, ` · ${st.lastError}`) : null,
          st.lastStatus === 'blocked' ? h('a', { href: s.url, target: '_blank', rel: 'noopener', class: 'fix' }, ' Открыть и пройти проверку →') : null)),
      compact ? null : h('select', { onchange: (e) => update(s.id, { intervalMin: Number(e.target.value) }) },
        INTERVALS.map((m) => h('option', { value: m, selected: m === s.intervalMin }, intervalLabel(m)))),
      h('div', { class: 'src-actions' },
        h('button', { type: 'button', class: 'btn small', onclick: async (e) => {
          const r = await send({ type: 'runNow', sourceId: s.id });
          e.target.textContent = r?.busy ? 'идёт поиск…' : 'ищу…';
        } }, 'Искать'),
        h('button', { type: 'button', class: 'link muted', onclick: async () => {
          if (confirm(`Удалить источник «${s.name}»? Найденные вакансии останутся.`)) await store.removeSource(s.id);
        } }, 'Удалить')));
  }));
}

export function addSourceForm(platform) {
  const help = ADD_HELP[platform];
  const url = h('input', { required: true, placeholder: help.placeholder });
  const name = h('input', { placeholder: 'Название (необязательно)' });
  const msg = h('span', { class: 'muted small' });
  const link = h('input', { placeholder: '/vacancies/(\\d+)' });
  const item = h('input', { placeholder: '.vacancy-card' });
  const title = h('input', { placeholder: '.vacancy-card__title' });

  const form = h('form', { class: 'add-src', onsubmit: async (e) => {
    e.preventDefault();
    const u = toUrl(platform, url.value);
    if (!u) { msg.textContent = 'Не похоже на ссылку. Вставьте адрес страницы целиком.'; return; }
    const detected = store.detectPlatformByUrl(u);
    const p = platform === 'generic' ? detected : platform;
    if (platform !== 'generic' && detected !== platform) { msg.textContent = `Это ссылка не на ${store.PLATFORM_NAMES[platform]}.`; return; }
    // Доступ к сайту компании запрашиваем первым действием — пока жив клик.
    if (p === 'generic') {
      const ok = await chrome.permissions.request({ origins: [`${new URL(u).origin}/*`] });
      if (!ok) { msg.textContent = 'Без доступа к сайту его нельзя обходить.'; return; }
    }
    const cfg = {};
    if (link.value.trim()) {
      try { new RegExp(link.value.trim()); cfg.linkPattern = link.value.trim(); } catch { msg.textContent = 'Шаблон ссылки — некорректное регулярное выражение.'; return; }
    }
    if (item.value.trim()) cfg.itemSelector = item.value.trim();
    if (title.value.trim()) cfg.titleSelector = title.value.trim();
    const sources = await store.getSources();
    const src = store.makeSource(u, { platform: p, name: name.value.trim() || undefined, cfg });
    if (sources.some((s) => s.url === src.url)) { msg.textContent = 'Такой источник уже есть.'; return; }
    await store.saveSources([...sources, src]);
    form.reset();
    msg.textContent = `Добавлено: ${src.name}. Нажмите «Искать» или «/ Найти работу».`;
  } },
  h('p', { class: 'muted small' }, help.help),
  h('div', { class: 'row' }, url, name, h('button', { type: 'submit', class: 'btn primary' }, 'Добавить')),
  platform === 'generic' ? h('details', {}, h('summary', { class: 'small muted' }, 'Ручная настройка, если вакансии не находятся автоматически'),
    h('div', { class: 'grid3' },
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Шаблон ссылки на вакансию (RegExp)'), link),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'CSS-селектор карточки'), item),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'CSS-селектор названия'), title))) : null,
  msg);
  return form;
}
