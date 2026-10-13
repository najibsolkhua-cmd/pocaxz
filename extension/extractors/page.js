// Экстрактор, который внедряется во вкладку с hh.ru / Avito / t.me / карьерным сайтом.
// Это то же самое, что выполнить скрипт в консоли DevTools, только автоматически.
// Файл самодостаточный (без import), потому что выполняется в контексте страницы.
//
// Вызов: globalThis.__jobRadar.extract({ platform, enrichMax, knownIds, ... })
// Результат: { items: [...], blocked: bool, reason, url, title }

(() => {
  if (globalThis.__jobRadar) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const clean = (s) => (s || '').replace(/[  ]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

  // Текст элемента с переводами строк между блоками. Работает и для документов из
  // DOMParser, где innerText не учитывает вёрстку.
  const BLOCK = new Set(['P', 'DIV', 'LI', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'UL', 'OL', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'BLOCKQUOTE']);
  function blockText(el) {
    if (!el) return '';
    const parts = [];
    const walk = (n) => {
      if (n.nodeType === 3) { parts.push(n.nodeValue); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
      if (tag === 'BR') { parts.push('\n'); return; }
      const isBlock = BLOCK.has(tag);
      if (isBlock) parts.push('\n');
      for (const c of n.childNodes) walk(c);
      if (isBlock) parts.push('\n');
    };
    walk(el);
    return clean(parts.join(''));
  }
  const text = (el) => (el ? clean(el.textContent) : '');
  const q = (root, sel) => {
    for (const s of sel.split('||')) {
      const el = root.querySelector(s.trim());
      if (el) return el;
    }
    return null;
  };

  async function waitFor(fn, timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const r = fn();
      if (r) return r;
      await sleep(300);
    }
    return fn();
  }

  // Плавная прокрутка, чтобы подгрузились «ленивые» карточки.
  async function gentleScroll(steps = 6) {
    for (let i = 1; i <= steps; i++) {
      window.scrollTo(0, (document.body.scrollHeight * i) / steps);
      await sleep(rand(250, 600));
    }
    window.scrollTo(0, 0);
  }

  // Если вакансии нашлись, страница не заблокирована (скрытые формы с капчей
  // для входа бывают и на обычных страницах).
  function detectBlock(itemsFound) {
    if (itemsFound) return null;
    if (document.querySelector('iframe[src*="captcha" i], [data-qa*="captcha" i], #captcha, .captcha, form[action*="captcha" i], [class*="smart-captcha" i]')) {
      return 'captcha';
    }
    const t = `${document.title}\n${(document.body?.innerText || '').slice(0, 4000)}`.toLowerCase();
    const markers = ['captcha', 'капча', 'не робот', 'доступ ограничен', 'access denied', 'проверка браузера', 'подозрительн', 'are you human', 'too many requests', 'слишком много запросов'];
    const hit = markers.find((m) => t.includes(m));
    return hit ? `маркер «${hit}»` : null;
  }

  // Карточки по ссылкам: для каждой ссылки-вакансии поднимаемся к самому большому
  // предку, где нет ссылок на другие вакансии. Не зависит от CSS-классов.
  function cardsByLinks(re, root = document) {
    const byId = new Map();
    for (const a of root.querySelectorAll('a[href]')) {
      const m = a.href.match(re);
      if (!m) continue;
      const id = m[1] || m[0];
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(a);
    }
    const idOf = (a) => { const m = a.href.match(re); return m ? (m[1] || m[0]) : null; };
    const out = [];
    for (const [id, anchors] of byId) {
      const a = anchors.slice().sort((x, y) => text(y).length - text(x).length)[0];
      let card = a;
      while (card.parentElement && card.parentElement !== document.body) {
        const p = card.parentElement;
        let other = false;
        for (const x of p.querySelectorAll('a[href]')) {
          const xid = idOf(x);
          if (xid && xid !== id) { other = true; break; }
        }
        if (other) break;
        card = p;
      }
      out.push({ id, a, card });
    }
    return out;
  }

  function linksIn(el) {
    if (!el) return [];
    return [...new Set([...el.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => /^https?:/.test(h)))].slice(0, 20);
  }

  async function fetchDoc(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    return new DOMParser().parseFromString(html, 'text/html');
  }

  // Подгрузка описаний для новых вакансий: по одной, с паузами, только тот же сайт.
  async function enrich(items, cfg, detailFn) {
    const known = new Set(cfg.knownIds || []);
    const todo = items.filter((it) => !known.has(String(it.externalId))).slice(0, cfg.enrichMax ?? 0);
    const [d1, d2] = cfg.enrichDelay || [3000, 7000];
    for (const it of todo) {
      try {
        const u = new URL(it.url, location.href);
        if (u.origin !== location.origin) continue;
        const doc = await fetchDoc(u.href);
        if (doc.querySelector('[data-qa*="captcha" i], iframe[src*="captcha" i]')) { it.enrichError = 'captcha'; break; }
        Object.assign(it, detailFn(doc), { enriched: true });
      } catch (e) {
        it.enrichError = String(e.message || e);
      }
      await sleep(rand(d1, d2));
    }
  }

  // ---------------- hh.ru ----------------
  const HH_RE = /\/vacancy\/(\d+)(?:[?#/]|$)/;

  async function hhList(cfg) {
    await waitFor(() => document.querySelector('[data-qa="vacancy-serp__vacancy"], [data-qa="serp-item__title"]') || cardsByLinks(HH_RE).length > 0, 15000);
    await gentleScroll(4);
    let cards = [...document.querySelectorAll('[data-qa="vacancy-serp__vacancy"]')].map((card) => {
      const a = q(card, '[data-qa="serp-item__title"] || a[data-qa*="title"] || h2 a || a[href*="/vacancy/"]');
      const m = a?.href.match(HH_RE);
      return m ? { id: m[1], a, card } : null;
    }).filter(Boolean);
    if (!cards.length) cards = cardsByLinks(HH_RE);

    return cards.map(({ id, a, card }) => ({
      externalId: id,
      url: `${location.origin}/vacancy/${id}`,
      title: text(q(card, '[data-qa="serp-item__title-text"] || [data-qa="serp-item__title"]')) || text(a),
      company: text(q(card, '[data-qa="vacancy-serp__vacancy-employer-text"] || [data-qa="vacancy-serp__vacancy-employer"]')),
      location: text(q(card, '[data-qa="vacancy-serp__vacancy-address"] || [data-qa*="address"]')),
      salaryText: text(q(card, '[data-qa*="compensation"] || [class*="compensation"]')),
      experience: text(q(card, '[data-qa*="work-experience"] || [data-qa*="experience"]')),
      snippet: [...card.querySelectorAll('[data-qa^="vacancy-serp__vacancy_snippet"]')].map(text).join('\n'),
      cardText: blockText(card).slice(0, 1500),
      publishedText: text(q(card, '[data-qa*="publication"] || [data-qa*="date"]')),
    }));
  }

  function hhDetail(doc) {
    const desc = q(doc, '[data-qa="vacancy-description"] || .vacancy-description || .g-user-content');
    const tags = [...doc.querySelectorAll('[data-qa="skills-element"], [data-qa="bloko-tag__text"]')].map(text).filter(Boolean);
    const created = text(q(doc, '[class*="vacancy-creation-time"] || [data-qa*="creation"]'));
    const out = {
      description: blockText(desc || doc.querySelector('main') || doc.body).slice(0, 8000),
      tags,
      experience: text(q(doc, '[data-qa="vacancy-experience"]')),
      links: linksIn(desc),
    };
    const sal = text(q(doc, '[data-qa*="vacancy-salary"] || [data-qa*="compensation"]'));
    if (sal) out.salaryText = sal;
    const emp = text(q(doc, '[data-qa="vacancy-company-name"] || [data-qa*="employer-name"]'));
    if (emp) out.company = emp;
    const fmt = text(q(doc, '[data-qa*="work-formats"] || [data-qa*="work-schedule"]'));
    if (fmt) out.description = `${fmt}\n${out.description}`;
    if (created) out.publishedText = created.replace(/^.*?опубликована\s*/i, '');
    return out;
  }

  // ---------------- Avito ----------------
  const AVITO_RE = /_(\d{6,})(?:[?#]|$)/;

  async function avitoList() {
    await waitFor(() => document.querySelector('[data-marker="item"]') || cardsByLinks(AVITO_RE).length > 0, 15000);
    await gentleScroll(6);
    let cards = [...document.querySelectorAll('[data-marker="item"]')].map((card) => {
      const a = q(card, '[data-marker="item-title"] || a[itemprop="url"] || a[href]');
      const id = card.getAttribute('data-item-id') || a?.href.match(AVITO_RE)?.[1];
      return id && a ? { id, a, card } : null;
    }).filter(Boolean);
    if (!cards.length) cards = cardsByLinks(AVITO_RE);

    return cards.map(({ id, a, card }) => {
      const priceMeta = card.querySelector('meta[itemprop="price"]');
      const priceText = text(q(card, '[data-marker="item-price"] || [itemprop="price"] || [class*="price"]'));
      return {
        externalId: id,
        url: a.href.split('?')[0],
        title: text(q(card, '[itemprop="name"] || [data-marker="item-title"]')) || text(a),
        company: text(q(card, '[data-marker="item-line"] || [class*="seller"] || [class*="company"]')),
        location: text(q(card, '[data-marker="item-address"] || [class*="geo"]')),
        salaryText: priceText || (priceMeta ? `${priceMeta.content} ₽` : ''),
        snippet: text(q(card, 'meta[itemprop="description"]'))
          || card.querySelector('meta[itemprop="description"]')?.content
          || text(q(card, '[class*="description"]')),
        cardText: blockText(card).slice(0, 1500),
        publishedText: text(q(card, '[data-marker="item-date"] || [class*="date"]')),
      };
    });
  }

  function avitoDetail(doc) {
    const desc = q(doc, '[data-marker="item-view/item-description"] || [itemprop="description"] || [class*="item-description"]');
    const out = { description: blockText(desc || doc.querySelector('main') || doc.body).slice(0, 8000), links: linksIn(desc) };
    const seller = text(q(doc, '[data-marker="seller-info/name"] || [data-marker*="seller-link"]'));
    if (seller) out.company = seller;
    const params = [...doc.querySelectorAll('[data-marker="item-view/item-params"] li, [class*="params"] li')].map(text).join('\n');
    if (params) out.description = `${params}\n${out.description}`;
    return out;
  }

  // ---------------- Telegram (t.me/s/<канал>) ----------------
  function tgParse(root) {
    return [...root.querySelectorAll('.tgme_widget_message[data-post]')].map((m) => {
      const post = m.getAttribute('data-post');
      const body = m.querySelector('.tgme_widget_message_text');
      const time = m.querySelector('.tgme_widget_message_date time, time[datetime]');
      return {
        externalId: post,
        url: `https://t.me/${post}`,
        title: '',
        description: blockText(body),
        cardText: '',
        links: linksIn(body),
        publishedText: time?.getAttribute('datetime') || '',
        _num: Number(post.split('/')[1]) || 0,
      };
    }).filter((it) => it.description);
  }

  async function tgList(cfg) {
    await waitFor(() => document.querySelector('.tgme_widget_message'), 10000);
    const items = tgParse(document);
    // Более старые посты: /s/<канал>?before=<id>, тот же источник.
    const channel = location.pathname.replace(/^\/s\//, '').split('/')[0];
    for (let p = 1; p < (cfg.pages || 1); p++) {
      const min = Math.min(...items.map((i) => i._num).filter(Boolean));
      if (!isFinite(min) || min <= 1) break;
      await sleep(rand(1500, 3500));
      try {
        const doc = await fetchDoc(`${location.origin}/s/${channel}?before=${min}`);
        const more = tgParse(doc);
        if (!more.length) break;
        items.push(...more);
      } catch { break; }
    }
    return items;
  }

  // ---------------- Любой сайт ----------------
  function jsonLdJobs() {
    const out = [];
    const visit = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(visit); return; }
      const type = [].concat(o['@type'] || []);
      if (type.includes('JobPosting')) out.push(o);
      if (o['@graph']) visit(o['@graph']);
      if (o.itemListElement) visit(o.itemListElement.map?.((x) => x.item || x));
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(s.textContent)); } catch { /* битый JSON-LD */ }
    }
    return out;
  }

  function htmlToText(html) {
    return blockText(new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html').body);
  }

  function fromJsonLd(j) {
    const sal = j.baseSalary?.value || {};
    const cur = j.baseSalary?.currency || sal.currency || 'RUB';
    const salaryText = sal.minValue || sal.maxValue || sal.value
      ? `${sal.minValue ? `от ${sal.minValue}` : ''} ${sal.maxValue ? `до ${sal.maxValue}` : ''} ${!sal.minValue && !sal.maxValue ? sal.value : ''} ${cur}`
      : '';
    const loc = [].concat(j.jobLocation || [])[0]?.address;
    const url = j.url || location.href;
    return {
      externalId: j.identifier?.value || j.identifier || url,
      url,
      title: clean(j.title),
      company: clean(j.hiringOrganization?.name || ''),
      location: clean(typeof loc === 'string' ? loc : loc?.addressLocality || ''),
      salaryText,
      description: htmlToText(j.description).slice(0, 8000),
      cardText: [j.employmentType, j.jobLocationType].flat().filter(Boolean).join(', '),
      publishedText: j.datePosted || '',
    };
  }

  function genericDetail(doc) {
    // На странице вакансии ищем JSON-LD, иначе основной текст.
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const j = [].concat(JSON.parse(s.textContent)).flatMap((x) => x['@graph'] || [x]).find((x) => [].concat(x['@type']).includes('JobPosting'));
        if (j) { const it = fromJsonLd(j); delete it.externalId; delete it.url; return it; }
      } catch { /* ignore */ }
    }
    const main = doc.querySelector('main, article, [role="main"]') || doc.body;
    return { description: blockText(main).slice(0, 8000) };
  }

  const JOB_LINK_RE = /\/(?:vacanc|vakans|job|jobs|career|careers|position|positions|openings|rabota)[^?#]*\/[^/?#]{3,}/i;

  async function genericList(cfg) {
    await sleep(cfg.waitMs ?? 2500);
    await gentleScroll(4);

    const ld = jsonLdJobs();
    if (ld.length) return ld.map(fromJsonLd);

    if (cfg.itemSelector) {
      await waitFor(() => document.querySelector(cfg.itemSelector), 10000);
      return [...document.querySelectorAll(cfg.itemSelector)].map((card) => {
        const a = (cfg.linkSelector && card.querySelector(cfg.linkSelector)) || (card.matches('a[href]') ? card : card.querySelector('a[href]'));
        const t = cfg.titleSelector ? card.querySelector(cfg.titleSelector) : null;
        const url = a?.href || location.href;
        return { externalId: url, url, title: text(t) || text(a), cardText: blockText(card).slice(0, 1500), description: blockText(card).slice(0, 3000) };
      }).filter((it) => it.title);
    }

    const re = cfg.linkPattern ? new RegExp(cfg.linkPattern, 'i') : JOB_LINK_RE;
    await waitFor(() => cardsByLinks(re).length > 0, 10000);
    return cardsByLinks(re)
      .filter(({ a }) => { const l = text(a).length; return l >= 6 && l <= 200; })
      .map(({ id, a, card }) => {
        const heading = q(card, 'h1 || h2 || h3 || h4 || [class*="title" i]');
        return {
          externalId: a.href.split('#')[0],
          url: a.href.split('#')[0],
          title: text(heading) || text(a),
          cardText: blockText(card).slice(0, 1500),
          description: blockText(card).slice(0, 3000),
          _id: id,
        };
      });
  }

  // ---------------- Точка входа ----------------
  function detectPlatform() {
    const h = location.hostname;
    if (/(^|\.)hh\.ru$/.test(h)) return 'hh';
    if (/(^|\.)avito\.ru$/.test(h)) return 'avito';
    if (h === 't.me' && location.pathname.startsWith('/s/')) return 'telegram';
    return 'generic';
  }

  async function extract(cfg = {}) {
    const platform = cfg.platform && cfg.platform !== 'auto' ? cfg.platform : detectPlatform();
    let items = [];
    let error = null;
    try {
      if (platform === 'hh') {
        items = await hhList(cfg);
        if (!detectBlock(items.length)) await enrich(items, cfg, hhDetail);
      } else if (platform === 'avito') {
        items = await avitoList(cfg);
        if (!detectBlock(items.length)) await enrich(items, cfg, avitoDetail);
      } else if (platform === 'telegram') {
        items = await tgList(cfg);
      } else {
        items = await genericList(cfg);
        await enrich(items, cfg, genericDetail);
      }
    } catch (e) {
      error = String(e?.message || e);
    }
    const reason = detectBlock(items.length) || (items.some((i) => i.enrichError === 'captcha') ? 'captcha при загрузке описаний' : null);
    items.forEach((i) => { delete i._num; delete i._id; });
    return { platform, items, blocked: Boolean(reason), reason, error, url: location.href, title: document.title };
  }

  globalThis.__jobRadar = { extract, detectPlatform };
})();
