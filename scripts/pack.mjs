// Сборка релиза:
//   dist/solk-job-<версия>-store.zip — для загрузки в каталоги (manifest.json в корне архива);
//   site/downloads/solk-job.zip      — для ручной установки с сайта (папка solk-job внутри).
// Запуск: npm run pack
import fs from 'node:fs';
import path from 'node:path';
import { makeZip } from '../extension/lib/zip.js';
import { listFiles } from './gen-files.mjs';

const root = new URL('..', import.meta.url).pathname;
const ext = path.join(root, 'extension');
const files = [...listFiles(), 'files.json'];
const read = (f) => new Uint8Array(fs.readFileSync(path.join(ext, f)));
const { version } = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.mkdirSync(path.join(root, 'site', 'downloads'), { recursive: true });
const store = path.join(root, 'dist', `solk-job-${version}-store.zip`);
fs.writeFileSync(store, makeZip(files.map((name) => ({ name, data: read(name) }))));
const manual = path.join(root, 'site', 'downloads', 'solk-job.zip');
fs.writeFileSync(manual, makeZip(files.map((name) => ({ name: `solk-job/${name}`, data: read(name) }))));
console.log(`Версия ${version}:\n  ${path.relative(root, store)} — загрузить в каталоги\n  ${path.relative(root, manual)} — для сайта`);
