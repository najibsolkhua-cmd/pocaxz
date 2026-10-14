// Список файлов расширения для кнопки «Скачать расширение для друга».
// Запуск: node scripts/gen-files.mjs (тест проверяет, что список актуален).
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../extension/', import.meta.url).pathname;
export function listFiles(dir = root) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.name.startsWith('.')) return [];
    return e.isDirectory() ? listFiles(full) : [path.relative(root, full).split(path.sep).join('/')];
  }).filter((f) => f !== 'files.json').sort();
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  fs.writeFileSync(path.join(root, 'files.json'), `${JSON.stringify(listFiles(), null, 1)}\n`);
  console.log('extension/files.json обновлён');
}
