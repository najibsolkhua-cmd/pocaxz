// Тема главной до первой отрисовки — без вспышки белого фона. Сам выбор хранится в настройках,
// здесь — его копия в localStorage (её читаем синхронно).
try {
  if (localStorage.getItem('solk-theme') === 'dark') document.documentElement.classList.add('theme-dark');
} catch { /* без localStorage — светлая */ }
