import { detectPlatformByUrl, PLATFORM_NAMES } from './lib/store.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function show(text, kind = '') {
  const el = $('msg');
  el.hidden = false;
  el.className = `msg ${kind}`;
  el.textContent = text;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshState() {
  const s = await send({ type: 'status' });
  $('state').textContent = s?.running ? `ищу: ${s.current || '…'}` : '';
}

$('collect').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!/^https?:/.test(tab?.url || '')) return show('Откройте страницу сайта с вакансиями.', 'warn');
  $('collect').disabled = true;
  show('Собираю… Описания новых вакансий подгружаются по одной с паузами, это может занять до минуты.');
  const r = await send({ type: 'collectTab', tabId: tab.id });
  $('collect').disabled = false;
  if (r?.error && !r.found) return show(`Ошибка: ${r.error}`, 'warn');
  if (r?.blocked) return show(`Сайт показал проверку (${r.reason}). Пройдите её вручную и попробуйте ещё раз.`, 'warn');
  show(`${PLATFORM_NAMES[r.platform] || r.platform}: найдено ${r.found}, новых ${r.added}, обновлено ${r.updated}.`, 'ok');
});

// Вкладку узнаём заранее: chrome.permissions.request должен вызываться сразу
// в обработчике клика, без await перед ним.
let currentTab = null;
activeTab().then((t) => { currentTab = t; });

$('addSource').addEventListener('click', async () => {
  const tab = currentTab;
  if (!/^https?:/.test(tab?.url || '')) return show('Откройте страницу сайта с вакансиями.', 'warn');
  const platform = detectPlatformByUrl(tab.url);
  if (platform === 'generic') {
    const ok = await chrome.permissions.request({ origins: [`${new URL(tab.url).origin}/*`] });
    if (!ok) return show('Без доступа к сайту расширение не сможет его обходить.', 'warn');
  }
  const r = await send({ type: 'addSource', url: tab.url, name: tab.title, platform });
  if (r?.exists) return show('Этот источник уже добавлен.');
  show(`Добавлено: ${PLATFORM_NAMES[platform]} — «${tab.title}». Первый обход — в течение нескольких минут.`, 'ok');
});

$('runAll').addEventListener('click', async () => {
  const r = await send({ type: 'runNow' });
  if (r?.busy) show('Поиск уже идёт.');
  else if (r && !r.started) show('Все источники проверялись меньше 10 минут назад или ещё не добавлены. Откройте главную.');
  else show(`Ищу в ${r.total} источн. Вкладки будут открываться в фоне и закрываться сами.`, 'ok');
  refreshState();
});

$('openCrm').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

refreshState();
