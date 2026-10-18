// Настройки публичной версии. Меняются здесь — и выкладываются новой версией в магазины.

export const CONFIG = {
  // Сайт-переходник: страница установки, политика конфиденциальности, рекламный блок.
  siteUrl: 'https://solkhua.ru/',
  // Поддержка: пока бот не запущен — личный Telegram, потом — бот (botUsername ниже).
  supportUrl: 'https://t.me/max_max3700',

  // Telegram-бот: поддержка и уведомления о новых вакансиях.
  // botUsername — имя бота из @BotFather (без @), botApi — адрес сервера бота (папка bot/).
  // Пока botApi пустой, раздел «Уведомления в Telegram» показывается как «скоро».
  telegram: {
    botUsername: '',
    botApi: '',
  },

  // Реклама во время поиска (площадка бесплатная, доход — с показов РСЯ).
  //   mode: 'stub' — демонстрационные объявления (проверка механики, без РСЯ);
  //         'rsya' — блок РСЯ со страницы сайта (frameUrl) во фрейме;
  //         'off'  — без рекламы.
  ads: {
    mode: 'stub',
    frameUrl: 'https://solkhua.ru/ad.html',
    rotateSec: 20,
  },
};

// Партнёрские баннеры (плитка справа внизу). Список берётся из partners.json на сайте —
// добавлять и менять баннеры можно без выпуска новой версии расширения. Пока файл
// недоступен, показываются встроенные примеры из ui/partners.js.
CONFIG.partners = {
  url: 'https://solkhua.ru/partners.json',
  rotateSec: 8,
  refreshHours: 6,
};

// Резервная копия на Яндекс Диске. clientId — из приложения на oauth.yandex.ru
// (доступ «Яндекс Диск: доступ к папке приложения»), Redirect URI — https://<id расширения>.chromiumapp.org/
// Пока clientId пустой, раздел «Резервная копия на Яндекс Диске» показывается как «скоро».
CONFIG.yandexDisk = {
  clientId: '',
  apiBase: 'https://cloud-api.yandex.net/v1/disk',
  path: 'app:/solk-job-backup.json',
  autoHours: 12, // автокопия не чаще, чем раз в столько часов
};

export const supportLink = () => (CONFIG.telegram.botUsername ? `https://t.me/${CONFIG.telegram.botUsername}` : CONFIG.supportUrl);
