// Кнопка «Установить»: ведёт в нужный каталог для браузера пользователя.
// Яндекс Браузер ставит расширения из каталога Opera Add-ons и из Chrome Web Store.
(function () {
  const cfg = window.SOLK || {};
  const ua = navigator.userAgent;
  const browser = /YaBrowser/i.test(ua) ? 'yandex' : /Edg\//.test(ua) ? 'edge' : /OPR\//.test(ua) ? 'opera'
    : /Firefox\//.test(ua) ? 'firefox' : /Chrome\//.test(ua) ? 'chrome' : 'other';
  const mobile = /Android|iPhone|iPad|Mobile/i.test(ua);
  const s = cfg.stores || {};
  const store = { yandex: s.opera || s.chrome, opera: s.opera || s.chrome, chrome: s.chrome, edge: s.edge || s.chrome }[browser];

  const btn = document.getElementById('installBtn');
  const note = document.getElementById('installNote');
  const box = document.getElementById('installBox');
  for (const id of ['botLink', 'botLink2']) { const a = document.getElementById(id); if (a && cfg.bot) a.href = cfg.bot; }

  if (mobile) {
    note.textContent = 'solk / job работает в браузере на компьютере. Откройте этот сайт на компьютере в Яндекс Браузере или Chrome.';
    return;
  }
  if (browser === 'firefox' || browser === 'other') {
    note.textContent = 'Откройте сайт в Яндекс Браузере, Chrome, Edge или Opera — в этом браузере расширение пока не работает.';
    return;
  }
  if (store) {
    btn.href = store;
    btn.target = '_blank';
    btn.rel = 'noopener';
    btn.textContent = browser === 'yandex' ? 'Добавить в Яндекс Браузер' : 'Установить бесплатно';
    return;
  }
  // Каталогов ещё нет: скачать архив и поставить вручную.
  btn.href = cfg.zip;
  btn.setAttribute('download', '');
  btn.textContent = 'Скачать бесплатно';
  note.textContent = 'Скоро — установка в один клик из каталога. Пока: скачайте архив и следуйте шагам ниже.';
  const page = browser === 'yandex' ? 'browser://extensions' : browser === 'edge' ? 'edge://extensions' : browser === 'opera' ? 'opera://extensions' : 'chrome://extensions';
  box.innerHTML = `<ol class="steps">
    <li>Скачайте архив и распакуйте его — появится папка «solk-job».</li>
    <li>Откройте <b>${page}</b> (скопируйте в адресную строку) и включите «Режим разработчика».</li>
    <li>Нажмите «Загрузить распакованное расширение» и выберите папку «solk-job».</li>
    <li>Откроется главная solk / job — перетащите туда резюме.</li>
  </ol>`;
})();
