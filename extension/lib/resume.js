// Чтение файла резюме в текст прямо в браузере: PDF, DOCX, RTF, TXT.
// Файл никуда не отправляется.

export async function readResumeFile(file) {
  const name = file.name.toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());
  let text;
  if (name.endsWith('.pdf') || file.type === 'application/pdf') text = await pdfToText(buf);
  else if (name.endsWith('.docx')) text = await docxToText(buf);
  else if (name.endsWith('.rtf')) text = rtfToText(buf);
  else if (name.endsWith('.doc')) throw new Error('Старый формат .doc не поддерживается — сохраните резюме как PDF или DOCX.');
  else text = decodeText(buf);
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 30) throw new Error('В файле почти нет текста. Если это скан, скачайте резюме с hh.ru в PDF или DOCX.');
  return text;
}

function decodeText(buf) {
  const utf = new TextDecoder('utf-8').decode(buf);
  // Если в UTF-8 много «�», скорее всего это Windows-1251.
  const bad = (utf.match(/�/g) || []).length;
  return bad > utf.length / 50 ? new TextDecoder('windows-1251').decode(buf) : utf;
}

// ---------- PDF (pdf.js лежит в vendor/) ----------

async function pdfToText(buf) {
  const pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');
  const doc = await pdfjs.getDocument({ data: buf, isEvalSupported: false, disableFontFace: true }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    const lines = [];
    for (const it of content.items) {
      line += it.str;
      if (it.hasEOL) { lines.push(line); line = ''; }
    }
    if (line) lines.push(line);
    pages.push(lines.join('\n'));
  }
  await doc.destroy();
  return pages.join('\n\n');
}

// ---------- DOCX: zip-архив, текст в word/document.xml ----------

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzipEntry(buf, wanted) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Файл повреждён или это не DOCX.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      const lNameLen = dv.getUint16(local + 26, true);
      const lExtraLen = dv.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new Error(`Неподдерживаемое сжатие ZIP (${method}).`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`В архиве нет ${wanted}.`);
}

async function docxToText(buf) {
  const xml = new TextDecoder().decode(await unzipEntry(buf, 'word/document.xml'));
  // Берём только текст из <w:t> и разметку абзацев — пробелы между тегами не текст.
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br[^>]*\/>|<\/w:p>/g)) {
    if (m[1] != null) out += m[1];
    else if (m[0].startsWith('<w:tab')) out += '\t';
    else out += '\n';
  }
  return out
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

// ---------- RTF (hh.ru умеет отдавать резюме в RTF) ----------

function rtfToText(buf) {
  const src = new TextDecoder('latin1').decode(buf);
  const cp1251 = new TextDecoder('windows-1251');
  let out = '';
  let i = 0;
  let depth = 0;
  const skipAt = [];
  let uc = 1;
  let skipChars = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { if (skipAt.length && skipAt[skipAt.length - 1] === depth) skipAt.pop(); depth--; i++; continue; }
    const skipping = skipAt.length > 0;
    if (c === '\\') {
      const n = src[i + 1];
      if (n === '\\' || n === '{' || n === '}') { if (!skipping) out += n; i += 2; continue; }
      if (n === "'") {
        if (skipChars > 0) skipChars--;
        else if (!skipping) out += cp1251.decode(new Uint8Array([parseInt(src.substr(i + 2, 2), 16)]));
        i += 4;
        continue;
      }
      if (n === '*') { skipAt.push(depth); i += 2; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i, i + 40));
      if (!m) { i += 2; continue; }
      const [all, word, arg] = m;
      i += all.length;
      if (['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'listtable', 'listoverridetable', 'themedata', 'datastore', 'latentstyles'].includes(word)) skipAt.push(depth);
      else if (word === 'uc') uc = Number(arg);
      else if (word === 'u' && !skipping) { let code = Number(arg); if (code < 0) code += 65536; out += String.fromCharCode(code); skipChars = uc; }
      else if ((word === 'par' || word === 'line' || word === 'row') && !skipping) out += '\n';
      else if ((word === 'tab' || word === 'cell') && !skipping) out += '\t';
      continue;
    }
    if (c === '\r' || c === '\n') { i++; continue; }
    if (skipChars > 0) { skipChars--; i++; continue; }
    if (!skipping) out += c;
    i++;
  }
  return out;
}
