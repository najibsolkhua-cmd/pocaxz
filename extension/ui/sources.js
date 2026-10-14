// Источники: список с состоянием обхода и форма добавления.

import * as store from '../lib/store.js';
import { h, fmtTime } from './dom.js';

const send = (msg) => chrome.runtime.sendMessage(msg);
const INTERVALS = [30, 60, 120, 240, 360, 720, 1440];
const intervalLabel = (m) => (m < 60 ? `каждые ${m} мин` : m < 1440 ? `каждые ${m / 60} ч` : 'раз в сутки');

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
    help: 'Любая страница со списком вакансий: сайт компании, rabota.ru, superjob.ru, rabota.sber.ru… Должность и город из профиля подставятся сами — в ссылку или в поля поиска на сайте, переходить туда и заполнять ничего не нужно.',
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

function stateLine(st) {
  if (!st.lastRunAt) return 'ещё не искали';
  const parts = [fmtTime(st.lastRunAt)];
  if (st.lastStatus === 'failed') parts.push('ошибка');
  else if (st.lastStatus === 'blocked') parts.push('сайт попросил проверку');
  else {
    if (st.lastTotal) parts.push(`на сайте ${st.lastTotal.toLocaleString('ru-RU')}`);
    parts.push(`собрано ${st.lastFound ?? 0}`);
    if (st.lastAdded) parts.push(`новых ${st.lastAdded}`);
    if (st.lastDetailed) parts.push(`описаний ${st.lastDetailed}`);
    if (st.lastStatus === 'partial') parts.push('остановлено проверкой');
    if (st.lastStatus === 'stopped') parts.push('остановлено вами');
  }
  return parts.join(' · ');
}

function fillLine(s, st) {
  if (s.platform !== 'generic' || s.autoFill === false || !st.filled) return null;
  const f = st.filled;
  const what = [f.query ? h('span', {}, 'должность ', h('b', {}, `«${f.query}»`)) : null, f.city ? h('span', {}, `${f.query ? ', ' : ''}город `, h('b', {}, f.city)) : null].filter(Boolean);
  if (!what.length) return null;
  return h('div', { class: 'src-fill' }, `Подставлено ${f.via === 'ссылка' ? 'в ссылку' : 'в поля сайта'}: `, ...what, '. Проверьте, что сайт понял правильно.', f.note ? ` (${f.note})` : '');
}

export function sourceRows(sources, all) {
  const update = async (id, patch) => {
    const list = await store.getSources();
    await store.saveSources(list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };
  if (!sources.length) return h('div', { class: 'empty small' }, 'Источников пока нет — добавьте ниже.');
  return h('div', { class: 'src-list' }, sources.map((s) => {
    const st = all[`srcstate:${s.id}`] || {};
    const bad = ['failed', 'blocked', 'partial'].includes(st.lastStatus);
    return h('div', { class: `src-row ${s.enabled ? '' : 'off'}` },
      h('label', { class: 'switch', title: s.enabled ? 'Включён — нажмите, чтобы выключить' : 'Выключен' },
        h('input', { type: 'checkbox', checked: s.enabled, onchange: (e) => update(s.id, { enabled: e.target.checked }) }), h('span', {})),
      h('div', { class: 'src-main' },
        h('div', { class: 'src-name', title: s.name }, h('span', { class: 'src-title' }, s.name), s.auto ? h('span', { class: 'tag' }, 'по должности') : null),
        h('a', { class: 'src-url', href: s.url, target: '_blank', rel: 'noopener', title: s.url }, s.url),
        h('div', { class: `src-state ${bad ? 'bad' : ''}` }, stateLine(st),
          st.lastError ? h('span', { class: 'muted' }, ` · ${st.lastError}`) : null,
          ['blocked', 'partial'].includes(st.lastStatus) ? h('a', { href: s.url, target: '_blank', rel: 'noopener', class: 'fix' }, ' Открыть и пройти проверку →') : null),
        fillLine(s, st),
        s.platform === 'generic' ? h('label', { class: 'src-autofill', title: 'Перед поиском вписывать должность и город из профиля в ссылку или в поля поиска на сайте' },
          h('input', { type: 'checkbox', checked: s.autoFill !== false, onchange: (e) => update(s.id, { autoFill: e.target.checked }) }), 'Подставлять должность и город из профиля') : null),
      h('div', { class: 'src-actions' },
        h('select', { title: 'Как часто искать автоматически', onchange: (e) => update(s.id, { intervalMin: Number(e.target.value) }) },
          INTERVALS.map((m) => h('option', { value: m, selected: m === s.intervalMin }, intervalLabel(m)))),
        h('button', { type: 'button', class: 'btn small', onclick: async (e) => {
          const btn = e.currentTarget;
          const r = await send({ type: 'runNow', sourceId: s.id });
          btn.textContent = r?.busy ? 'занято' : 'ищу…';
          btn.disabled = true;
        } }, 'Искать'),
        h('button', { type: 'button', class: 'btn small ghost', title: 'Удалить источник', onclick: async () => {
          if (!confirm(`Удалить источник «${s.name}»? Найденные вакансии останутся.`)) return;
          await store.removeSource(s.id);
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
    if (store.isSingleVacancyUrl(u)) {
      msg.textContent = 'Это ссылка на одну вакансию, а не на поиск. Добавьте её в профиль как «Пример подходящей вакансии» — по ней найдутся похожие.';
      return;
    }
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
    // Должность из профиля — сразу в ссылку, если у неё есть параметр поиска.
    await store.syncAutoSources(await store.getProfile());
    const saved = (await store.getSources()).find((x) => x.id === src.id) || src;
    form.reset();
    msg.textContent = saved.url !== src.url
      ? `Добавлено: ${saved.name}. Должность из профиля уже в ссылке. Нажмите «Искать» или «/ Найти работу».`
      : `Добавлено: ${saved.name}. Должность и город впишутся в поля сайта при поиске. Нажмите «Искать» или «/ Найти работу».`;
  } },
  h('p', { class: 'muted small' }, help.help),
  platform === 'generic' ? h('p', { class: 'note-warn' }, 'Поля сайта заполняются автоматически и могут быть заполнены не совсем точно: всё зависит от сайта и профессии. Для узких специальностей после первого поиска проверьте строку «Подставлено…» у источника или откройте ссылку сами.') : null,
  h('div', { class: 'row' }, url, name, h('button', { type: 'submit', class: 'btn primary' }, 'Добавить')),
  platform === 'generic' ? h('details', {}, h('summary', { class: 'small muted' }, 'Ручная настройка, если вакансии не находятся автоматически'),
    h('div', { class: 'grid3' },
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Шаблон ссылки на вакансию (RegExp)'), link),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'CSS-селектор карточки'), item),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'CSS-селектор названия'), title))) : null,
  msg);
  return form;
}
