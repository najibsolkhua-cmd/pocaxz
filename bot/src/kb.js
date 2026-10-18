// База знаний: knowledge/*.md + README.md проекта. Для режима без Claude — поиск по разделам.
import fs from 'node:fs';
import path from 'node:path';

export function loadKnowledge({ knowledgeDir, readmePath }) {
  const parts = [];
  for (const f of fs.readdirSync(knowledgeDir).filter((x) => x.endsWith('.md')).sort()) {
    parts.push(fs.readFileSync(path.join(knowledgeDir, f), 'utf8'));
  }
  try { parts.push(fs.readFileSync(readmePath, 'utf8')); } catch { /* README необязателен */ }
  return parts.join('\n\n');
}

// Разделы по заголовкам ## / ###.
export function sections(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^#{2,3}\s+(.+)/);
    if (m) { cur = { title: m[1].trim(), body: [] }; out.push(cur); continue; }
    if (cur) cur.body.push(line);
  }
  return out.map((s) => ({ title: s.title, body: s.body.join('\n').trim() })).filter((s) => s.body);
}

const stem = (w) => w.toLowerCase().replace(/ё/g, 'е').slice(0, 5);
const words = (t) => (t.toLowerCase().match(/[a-zа-яё0-9]{3,}/gi) || []).map(stem);
const STOP = new Set(['как', 'что', 'это', 'для', 'где', 'мне', 'мой', 'мои', 'мою', 'или', 'мож', 'нужн', 'почем', 'котор', 'когда', 'есть', 'мен', 'мож']);

// Самые подходящие разделы по совпадению слов (с весом заголовка).
export function search(secs, question, limit = 2) {
  const q = [...new Set(words(question))].filter((w) => !STOP.has(w));
  if (!q.length) return [];
  return secs.map((s) => {
    const title = new Set(words(s.title));
    const body = words(s.body);
    const counts = new Map();
    body.forEach((w) => counts.set(w, (counts.get(w) || 0) + 1));
    const score = q.reduce((n, w) => n + (title.has(w) ? 3 : 0) + Math.min(3, counts.get(w) || 0), 0);
    return { ...s, score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}
