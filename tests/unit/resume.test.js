import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readResumeFile } from '../../extension/lib/resume.js';

const file = (name, type = '') => new File([fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url))], name, { type });

test('DOCX: текст из word/document.xml', async () => {
  const text = await readResumeFile(file('resume.docx'));
  assert.match(text, /Иванов Иван/);
  assert.match(text, /Python backend-разработчик/);
  assert.match(text, /Docker & Kubernetes/);
  assert.match(text, /Английский — Upper-Intermediate/);
  assert.equal(text.split('\n')[1], 'Python backend-разработчик');
});

test('RTF: кириллица в cp1251 и \\u-escape', async () => {
  const text = await readResumeFile(file('resume.rtf'));
  assert.match(text, /Менеджер по продажам/);
  assert.match(text, /холодные звонки, B2B, Excel/);
  assert.match(text, /АБ test/);
  assert.doesNotMatch(text, /Arial|Test;/);
});

test('TXT в Windows-1251', async () => {
  const cp = Buffer.from([0xcf, 0xf0, 0xee, 0xe4, 0xe0, 0xe2, 0xe5, 0xf6, 0x2c, 0x20, 0xee, 0xef, 0xfb, 0xf2, 0x20, 0x35, 0x20, 0xeb, 0xe5, 0xf2, 0x2c, 0x20, 0xef, 0xf0, 0xee, 0xe4, 0xe0, 0xe6, 0xe8, 0x20, 0x42, 0x32, 0x42, 0x20, 0x43, 0x52, 0x4d]);
  const text = await readResumeFile(new File([cp], 'r.txt'));
  assert.equal(text, 'Продавец, опыт 5 лет, продажи B2B CRM');
});

test('старый .doc — понятная ошибка', async () => {
  await assert.rejects(readResumeFile(new File([Buffer.alloc(100)], 'r.doc')), /\.doc не поддерживается/);
});
