// Экстрактор, который внедряется во вкладку с hh.ru / Avito / t.me / сайтом компании.
// Это то же самое, что выполнить скрипт в консоли DevTools, только автоматически.
// Файл самодостаточный (без import), потому что выполняется в контексте страницы.
//
//   __jobRadar.extract(cfg)  — вакансии с текущей страницы выдачи
//       → { items, total, nextUrl, blocked, reason, error }
//   __jobRadar.details(cfg)  — подробности по ссылкам (тот же сайт, по одной, с паузами)
//       → { results: { [externalId]: { description, ... } | { archived: true } | { error } }, blocked }
//   __jobRadar.current(cfg)  — подробности текущей (уже открытой) страницы вакансии

(() => {
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
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG') return;
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

  const BLOCK_MARKERS = ['captcha', 'капча', 'не робот', 'доступ ограничен', 'access denied', 'проверка браузера', 'подозрительн', 'are you human', 'too many requests', 'слишком много запросов'];
  const CAPTCHA_SEL = 'iframe[src*="captcha" i], [data-qa*="captcha" i], #captcha, .captcha, form[action*="captcha" i], [class*="smart-captcha" i]';

  // Если вакансии нашлись, страница не заблокирована (скрытые формы с капчей
  // для входа бывают и на обычных страницах).
  function detectBlock(doc, itemsFound) {
    if (itemsFound) return null;
    if (doc.querySelector(CAPTCHA_SEL)) return 'captcha';
    const t = `${doc.title}\n${(doc.body?.textContent || '').slice(0, 4000)}`.toLowerCase();
    const hit = BLOCK_MARKERS.find((m) => t.includes(m));
    return hit ? `маркер «${hit}»` : null;
  }

  // Ссылки в шапке, меню и подвале — не вакансии.
  const inChrome = (a) => Boolean(a.closest('header, nav, footer, [role="navigation"], [class*="breadcrumb" i]'));

  // Карточки по ссылкам: для каждой ссылки-вакансии поднимаемся к самому большому
  // предку, где нет ссылок на другие вакансии. Не зависит от CSS-классов.
  function cardsByLinks(re, root = document, { skipChrome = false } = {}) {
    const byId = new Map();
    const idOf = (a) => { const m = a.href.match(re); return m ? (m[1] || m[0]) : null; };
    for (const a of root.querySelectorAll('a[href]')) {
      const id = idOf(a);
      if (!id || (skipChrome && inChrome(a))) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(a);
    }
    const out = [];
    for (const [id, anchors] of byId) {
      const a = anchors.slice().sort((x, y) => text(y).length - text(x).length)[0];
      let card = a;
      while (card.parentElement && card.parentElement !== root.body && card.parentElement !== root) {
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
    if (r.status === 404 || r.status === 410) return { gone: true };
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    // Относительные ссылки в разобранной странице считаем от её адреса.
    const base = doc.createElement('base');
    base.href = r.url || url;
    doc.head.prepend(base);
    return { doc };
  }

  // «Всего N вакансий» из заголовка выдачи.
  function totalFrom(root, platform) {
    const num = (s) => { const n = Number(String(s).replace(/[^\d]/g, '')); return n > 0 && n < 10_000_000 ? n : null; };
    if (platform === 'avito') {
      const c = root.querySelector('[data-marker="page-title/count"]');
      if (c && num(text(c))) return num(text(c));
      const h1 = text(root.querySelector('h1'));
      const m = h1.match(/(\d[\d ]*)$/);
      if (m) return num(m[1]);
    }
    const heads = [...root.querySelectorAll('h1, h2, [data-qa*="title" i], [data-qa*="found" i], [class*="count" i]')].slice(0, 30).map(text).join('\n');
    const re = /(?:найден[оа]?\s+)?(\d[\d ]{0,9})\s*(?:ваканси[йяие]|vacanc|результат)/i;
    const m = heads.match(re) || (root.body?.textContent || '').slice(0, 8000).replace(/[  ]/g, ' ').match(re);
    return m ? num(m[1]) : null;
  }

  // ---------------- hh.ru ----------------
  const HH_RE = /\/vacancy\/(\d+)(?:[?#/]|$)/;

  function hhParse(root) {
    let cards = [...root.querySelectorAll('[data-qa="vacancy-serp__vacancy"]')].map((card) => {
      const a = q(card, '[data-qa="serp-item__title"] || a[data-qa*="title"] || h2 a || a[href*="/vacancy/"]');
      const m = a?.href.match(HH_RE);
      return m ? { id: m[1], a, card } : null;
    }).filter(Boolean);
    if (!cards.length) cards = cardsByLinks(HH_RE, root);
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

  function hhNext() {
    const u = new URL(location.href);
    u.searchParams.set('page', String(Number(u.searchParams.get('page') || 0) + 1));
    return u.href;
  }

  const HH_ARCHIVED = /вакансия в архиве|в архиве с|вакансия закрыта|работодатель закрыл|приём откликов (?:на эту вакансию )?(?:остановлен|прекращ)|vacancy (?:is )?archived/i;

  function hhDetail(doc) {
    const desc = q(doc, '[data-qa="vacancy-description"] || .vacancy-description || .g-user-content');
    const top = (doc.body?.textContent || '').slice(0, 6000);
    if (doc.querySelector('[data-qa*="archived" i], [data-qa="vacancy-archive-description"]') || HH_ARCHIVED.test(top)) return { archived: true };
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
    if (fmt) out.formatText = fmt;
    if (created) out.publishedText = created.replace(/^.*?опубликована\s*/i, '');
    return out;
  }

  // ---------------- Avito ----------------
  const AVITO_RE = /_(\d{6,})(?:[?#]|$)/;

  function avitoParse(root) {
    let cards = [...root.querySelectorAll('[data-marker="item"]')].map((card) => {
      const a = q(card, '[data-marker="item-title"] || a[itemprop="url"] || a[href]');
      const id = card.getAttribute('data-item-id') || a?.href.match(AVITO_RE)?.[1];
      return id && a ? { id, a, card } : null;
    }).filter(Boolean);
    if (!cards.length) cards = cardsByLinks(AVITO_RE, root);
    return cards.map(({ id, a, card }) => {
      const priceMeta = card.querySelector('meta[itemprop="price"]');
      const priceText = text(q(card, '[data-marker="item-price"] || [itemprop="price"] || [class*="price"]'));
      return {
        externalId: id,
        url: a.href.split('?')[0],
        title: text(q(card, '[itemprop="name"] || [data-marker="item-title"]')) || text(a),
        location: text(q(card, '[data-marker="item-address"] || [class*="geo"]')),
        salaryText: priceText || (priceMeta ? `${priceMeta.content} ₽` : ''),
        snippet: card.querySelector('meta[itemprop="description"]')?.content || text(q(card, '[class*="description"]')),
        cardText: blockText(card).slice(0, 1500),
        publishedText: text(q(card, '[data-marker="item-date"] || [class*="date"]')),
      };
    });
  }

  function avitoNext() {
    const u = new URL(location.href);
    u.searchParams.set('p', String(Number(u.searchParams.get('p') || 1) + 1));
    return u.href;
  }

  const AVITO_GONE = /снято с публикации|снято с продажи|объявление удалено|срок размещения (?:объявления )?истёк|объявление не найдено|вакансия закрыта|больше не актуальн/i;

  function avitoDetail(doc) {
    if (AVITO_GONE.test((doc.body?.textContent || '').slice(0, 8000))) return { archived: true };
    const desc = q(doc, '[data-marker="item-view/item-description"] || [itemprop="description"] || [class*="item-description"]');
    const out = { description: blockText(desc || doc.querySelector('main') || doc.body).slice(0, 8000), links: linksIn(desc) };
    const seller = text(q(doc, '[data-marker="seller-info/name"] || [data-marker*="seller-link"]'));
    if (seller) out.company = seller;
    const params = [...doc.querySelectorAll('[data-marker="item-view/item-params"] li, [class*="params"] li')].map(text).join('\n');
    if (params) out.formatText = params;
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
      };
    }).filter((it) => it.description);
  }

  function tgNext(items) {
    const nums = items.map((i) => Number(i.externalId.split('/')[1])).filter(Boolean);
    if (!nums.length || Math.min(...nums) <= 1) return null;
    const channel = location.pathname.replace(/^\/s\//, '').split('/')[0];
    return `${location.origin}/s/${channel}?before=${Math.min(...nums)}`;
  }

  // ---------------- Любой сайт ----------------
  function jsonLdJobs(root) {
    const out = [];
    const visit = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(visit); return; }
      const type = [].concat(o['@type'] || []);
      if (type.includes('JobPosting')) out.push(o);
      if (o['@graph']) visit(o['@graph']);
      if (Array.isArray(o.itemListElement)) visit(o.itemListElement.map((x) => x.item || x));
    };
    for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(s.textContent)); } catch { /* битый JSON-LD */ }
    }
    return out;
  }

  function htmlToText(html) {
    return blockText(new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html').body);
  }

  function fromJsonLd(j, pageUrl) {
    const sal = j.baseSalary?.value || {};
    const cur = j.baseSalary?.currency || sal.currency || 'RUB';
    const salaryText = sal.minValue || sal.maxValue || sal.value
      ? `${sal.minValue ? `от ${sal.minValue}` : ''} ${sal.maxValue ? `до ${sal.maxValue}` : ''} ${!sal.minValue && !sal.maxValue ? sal.value : ''} ${cur}`
      : '';
    const loc = [].concat(j.jobLocation || [])[0]?.address;
    const url = j.url ? new URL(j.url, pageUrl).href : pageUrl;
    return {
      externalId: url,
      url,
      title: clean(j.title),
      company: clean(j.hiringOrganization?.name || ''),
      location: clean(typeof loc === 'string' ? loc : loc?.addressLocality || ''),
      salaryText,
      description: htmlToText(j.description).slice(0, 8000),
      formatText: [j.employmentType, j.jobLocationType].flat().filter(Boolean).join(', '),
      publishedText: j.datePosted || '',
    };
  }

  function genericDetail(doc, url) {
    const ld = jsonLdJobs(doc)[0];
    if (ld) { const it = fromJsonLd(ld, url); delete it.externalId; delete it.url; return it; }
    const main = doc.querySelector('main, article, [role="main"]') || doc.body;
    const h1 = text(doc.querySelector('h1'));
    return { description: blockText(main).slice(0, 8000), ...(h1 ? { pageTitle: h1 } : {}) };
  }

  const JOB_LINK_RE = /\/(?:vacanc|vakans|job|jobs|career|careers|position|positions|openings|rabota)[^?#]*\/[^/?#]{3,}/i;
  const GENERIC_LINK_TEXT = /^(подробнее|откликнуться|смотреть|посмотреть|узнать (?:больше|подробнее)|перейти|читать|details|apply|more|view|открыть)$/i;
  const MORE_RE = /^(показать|загрузить|смотреть|ещё|еще)\s*(ещё|еще|больше)?(\s+ваканси\S*)?$|^(show|load)\s+more|^ещё\s+\d+/i;

  function genericParse(root, cfg) {
    const listPath = location.pathname.replace(/\/+$/, '');
    if (cfg.itemSelector) {
      return [...root.querySelectorAll(cfg.itemSelector)].map((card) => {
        const a = (cfg.linkSelector && card.querySelector(cfg.linkSelector)) || (card.matches('a[href]') ? card : card.querySelector('a[href]'));
        const t = cfg.titleSelector ? card.querySelector(cfg.titleSelector) : null;
        const url = (a?.href || location.href).split('#')[0];
        return { externalId: url, url, title: text(t) || text(a), cardText: blockText(card).slice(0, 1500), snippet: blockText(card).slice(0, 600) };
      }).filter((it) => it.title);
    }
    const re = cfg.linkPattern ? new RegExp(cfg.linkPattern, 'i') : JOB_LINK_RE;
    return cardsByLinks(re, root, { skipChrome: true })
      .filter(({ a }) => {
        try {
          const u = new URL(a.href);
          const p = u.pathname.replace(/\/+$/, '');
          // Ссылка на саму выдачу или на её «родителя» — это навигация, не вакансия.
          return u.origin === location.origin ? p !== listPath && !listPath.startsWith(`${p}/`) : true;
        } catch { return false; }
      })
      .map(({ a, card }) => {
        const heading = q(card, 'h1 || h2 || h3 || h4 || h5 || [class*="title" i] || [class*="name" i]');
        const linkText = text(a);
        const firstLine = blockText(card).split('\n').find((l) => l.length >= 4 && !GENERIC_LINK_TEXT.test(l)) || '';
        const title = text(heading) || (GENERIC_LINK_TEXT.test(linkText) || linkText.length < 4 ? firstLine : linkText);
        const url = a.href.split('#')[0];
        return { externalId: url, url, title: title.slice(0, 160), cardText: blockText(card).slice(0, 1500), snippet: blockText(card).slice(0, 600) };
      })
      .filter((it) => it.title.length >= 4);
  }

  // Кнопка «Показать ещё» на сайтах, которые подгружают список без перехода.
  async function clickMore(cfg, countNow) {
    for (let i = 0; i < (cfg.moreClicks ?? 10); i++) {
      if (countNow() >= cfg.limit) return;
      const btn = [...document.querySelectorAll('button, a, [role="button"]')]
        .find((b) => MORE_RE.test(text(b)) && b.offsetParent !== null && !inChrome(b));
      if (!btn) return;
      const before = countNow();
      btn.click();
      const grown = await waitFor(() => countNow() > before, 8000);
      if (!grown) return;
      await sleep(rand(800, 1600));
    }
  }

  function genericNext() {
    const rel = document.querySelector('a[rel="next"]');
    if (rel?.href) return rel.href;
    const a = [...document.querySelectorAll('a[href]')].find((x) => /^(далее|следующая|вперёд|вперед|next|›|»|→)$/i.test(text(x)) && !inChrome(x));
    return a?.href || null;
  }

  // ---------------- Точки входа ----------------
  function detectPlatform() {
    const h = location.hostname;
    if (/(^|\.)hh\.ru$/.test(h)) return 'hh';
    if (/(^|\.)avito\.ru$/.test(h)) return 'avito';
    if (h === 't.me' && location.pathname.startsWith('/s/')) return 'telegram';
    return 'generic';
  }

  async function extract(cfg = {}) {
    const platform = cfg.platform && cfg.platform !== 'auto' ? cfg.platform : detectPlatform();
    const first = !cfg.pageNo;
    cfg.limit = cfg.limit || 100;
    let items = [];
    let nextUrl = null;
    let error = null;
    try {
      if (platform === 'hh') {
        await waitFor(() => document.querySelector('[data-qa="vacancy-serp__vacancy"], [data-qa="serp-item__title"]') || cardsByLinks(HH_RE).length > 0, 15000);
        await gentleScroll(4);
        items = hhParse(document);
        nextUrl = items.length ? hhNext() : null;
      } else if (platform === 'avito') {
        await waitFor(() => document.querySelector('[data-marker="item"]') || cardsByLinks(AVITO_RE).length > 0, 15000);
        await gentleScroll(6);
        items = avitoParse(document);
        nextUrl = items.length ? avitoNext() : null;
      } else if (platform === 'telegram') {
        await waitFor(() => document.querySelector('.tgme_widget_message'), 10000);
        items = tgParse(document);
        nextUrl = tgNext(items);
      } else {
        await sleep(cfg.waitMs ?? 2500);
        const ld = jsonLdJobs(document);
        if (ld.length) items = ld.map((j) => fromJsonLd(j, location.href));
        else {
          const count = () => genericParse(document, cfg).length;
          await waitFor(() => count() > 0, 12000);
          await gentleScroll(4);
          await clickMore(cfg, count);
          items = genericParse(document, cfg);
        }
        nextUrl = genericNext();
      }
    } catch (e) {
      error = String(e?.message || e);
    }
    const reason = detectBlock(document, items.length);
    return {
      platform,
      items,
      total: first ? totalFrom(document, platform) : null,
      nextUrl: nextUrl && nextUrl !== location.href ? nextUrl : null,
      blocked: Boolean(reason),
      reason,
      error,
      url: location.href,
      title: document.title,
    };
  }

  const DETAIL = { hh: hhDetail, avito: avitoDetail, generic: genericDetail, telegram: genericDetail };

  async function details(cfg) {
    const results = {};
    let blocked = null;
    const [d1, d2] = cfg.delay || [2500, 6000];
    for (const it of cfg.items || []) {
      try {
        const u = new URL(it.url, location.href);
        if (u.origin !== location.origin) { results[it.externalId] = { error: 'другой сайт' }; continue; }
        const r = await fetchDoc(u.href);
        if (r.gone) results[it.externalId] = { archived: true };
        else if (r.doc.querySelector(CAPTCHA_SEL) && !r.doc.querySelector('[data-qa="vacancy-description"], [data-marker="item-view/item-description"]')) { blocked = 'captcha при загрузке описаний'; break; }
        else results[it.externalId] = { ...DETAIL[cfg.platform](r.doc, u.href), enriched: true };
      } catch (e) {
        results[it.externalId] = { error: String(e.message || e) };
      }
      await sleep(rand(d1, d2));
    }
    return { results, blocked };
  }

  async function current(cfg) {
    await sleep(cfg.waitMs ?? 2000);
    const platform = cfg.platform || detectPlatform();
    const d = DETAIL[platform](document, location.href);
    return { ...d, pageTitle: d.pageTitle || text(document.querySelector('h1')), enriched: true, url: location.href };
  }

  globalThis.__jobRadar = { extract, details, current, detectPlatform };
})();
