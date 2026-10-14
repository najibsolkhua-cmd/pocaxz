import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeZip, crc32 } from '../../extension/lib/zip.js';
import { listFiles } from '../../scripts/gen-files.mjs';

test('список файлов для архива актуален (npm run files)', () => {
  const listed = JSON.parse(fs.readFileSync(new URL('../../extension/files.json', import.meta.url), 'utf8'));
  assert.deepEqual(listed, listFiles());
  assert.ok(listed.includes('manifest.json'));
});

test('crc32 как в zlib', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('архив открывается обычным unzip', () => {
  const enc = new TextEncoder();
  const zip = makeZip([
    { name: 'solk-job/manifest.json', data: enc.encode('{"name":"x"}') },
    { name: 'solk-job/img/лого.svg', data: enc.encode('<svg/>') },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  const file = path.join(dir, 'a.zip');
  fs.writeFileSync(file, zip);
  const py = 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print("|".join(z.namelist()));print(z.read("solk-job/manifest.json").decode())';
  const out = execFileSync('python3', ['-I', '-c', py, file], { encoding: 'utf8' });
  assert.equal(out.trim(), 'solk-job/manifest.json|solk-job/img/лого.svg\n{"name":"x"}');
});
