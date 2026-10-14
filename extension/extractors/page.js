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
    const idOf = typeof re === 'function' ? re : (a) => { const m = a.href.match(re); return m ? (m[1] || m[0]) : null; };
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

  // В ссылке есть номер вакансии: /vacancy/47123456, /vakansii/smm-46123456.html, uuid.
  const HAS_ID = /\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}-/i;
  // Шаблон ссылки: сегмент с номером заменяем на «:id». Ссылки одного шаблона — карточки одного списка.
  const NOT_JOBS = /^(blog|news|novosti|press|media|article|articles|stati|statya|event|events|promo|product|products|catalog|shop|tovar|tag|tags|author|help|faq|company|companies|employer|reviews|otzyvy)$/i;
  function linkTemplate(href, origin) {
    try {
      const u = new URL(href);
      if (u.origin !== origin) return null;
      const segs = u.pathname.split('/').filter(Boolean);
      let idIdx = -1;
      segs.forEach((x, i) => { if (HAS_ID.test(x)) idIdx = i; });
      if (idIdx < 0 || segs.slice(0, idIdx).some((x) => NOT_JOBS.test(x))) return null;
      return { tpl: segs.map((x, i) => (i === idIdx ? ':id' : x)).join('/'), id: segs[idIdx] };
    } catch { return null; }
  }
  // Сайт без слов «vacancy/job» в ссылках (например, /search/4219605): ищем самый
  // многочисленный шаблон ссылок с номером внутри страницы (не в шапке и не в подвале).
  function clusterRe(root, here) {
    const groups = new Map();
    for (const a of root.querySelectorAll('a[href]')) {
      if (inChrome(a)) continue;
      const t = linkTemplate(a.href, here.origin);
      if (!t) continue;
      if (!groups.has(t.tpl)) groups.set(t.tpl, new Set());
      groups.get(t.tpl).add(t.id);
    }
    const best = [...groups].filter(([, ids]) => ids.size >= 2).sort((x, y) => y[1].size - x[1].size)[0];
    if (!best) return null;
    return (a) => { const t = linkTemplate(a.href, here.origin); return t && t.tpl === best[0] ? t.id : null; };
  }

  function genericParse(root, cfg, here = location) {
    const listPath = here.pathname.replace(/\/+$/, '');
    if (cfg.itemSelector) {
      return [...root.querySelectorAll(cfg.itemSelector)].map((card) => {
        const a = (cfg.linkSelector && card.querySelector(cfg.linkSelector)) || (card.matches('a[href]') ? card : card.querySelector('a[href]'));
        const t = cfg.titleSelector ? card.querySelector(cfg.titleSelector) : null;
        const url = (a?.href || here.href).split('#')[0];
        return { externalId: url, url, title: text(t) || text(a), cardText: blockText(card).slice(0, 1500), snippet: blockText(card).slice(0, 600) };
      }).filter((it) => it.title);
    }
    const toItems = (cards) => cards
      .filter(({ a }) => {
        try {
          const u = new URL(a.href);
          const p = u.pathname.replace(/\/+$/, '');
          // Ссылка на саму выдачу или на её «родителя» — это навигация, не вакансия.
          return u.origin === here.origin ? p !== listPath && !listPath.startsWith(`${p}/`) : true;
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
    if (cfg.linkPattern) return toItems(cardsByLinks(new RegExp(cfg.linkPattern, 'i'), root, { skipChrome: true }));
    let items = toItems(cardsByLinks(JOB_LINK_RE, root, { skipChrome: true }));
    // Среди ссылок «/vakansii/…» есть и рубрики. Если у большинства вакансий в ссылке номер —
    // ссылки без номера (рубрики, подборки) отбрасываем.
    const withId = items.filter((it) => HAS_ID.test(new URL(it.url).pathname));
    if (withId.length >= 3 && withId.length < items.length) items = withId;
    if (items.length >= 2) return items;
    const byTpl = clusterRe(root, here);
    const more = byTpl ? toItems(cardsByLinks(byTpl, root, { skipChrome: true })) : [];
    return more.length > items.length ? more : items;
  }

  // Сайты-приложения (React/Next/Vue) часто кладут список вакансий в JSON внутри страницы.
  const TITLE_KEYS = ['title', 'name', 'vacancyName', 'vacancyTitle', 'jobTitle', 'position', 'positionName', 'header'];
  const ID_KEYS = ['id', 'vacancyId', 'vacancy_id', 'uuid', 'slug', 'code', 'externalId', 'guid'];
  const URL_KEYS = ['url', 'link', 'href', 'vacancyUrl', 'alternate_url', 'absoluteUrl', 'publicUrl'];
  const JOB_KEY = /salary|zarplat|city|location|region|address|employ|company|employer|schedule|experience|description|requirement|duties|vacanc|publish|grade|remote|format/i;
  const str = (v) => (v == null ? '' : typeof v === 'string' || typeof v === 'number' ? String(v) : typeof v === 'object' ? str(v.name ?? v.title ?? v.value ?? v.text ?? '') : '');
  function jsonJobs(root, pageUrl) {
    const blobs = [];
    for (const sc of root.querySelectorAll('script')) {
      const t = (sc.textContent || '').trim();
      if (t.length < 50 || sc.type === 'application/ld+json') continue;
      if (sc.type === 'application/json' || sc.id === '__NEXT_DATA__' || sc.id === '__NUXT_DATA__') { try { blobs.push(JSON.parse(t)); } catch { /* не JSON */ } continue; }
      const m = t.match(/^(?:window\.)?[\w$.[\]'"]+\s*=\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*;?\s*$/);
      if (m) { try { blobs.push(JSON.parse(m[1])); } catch { /* не JSON */ } }
    }
    const titleOf = (x) => TITLE_KEYS.map((k) => x[k]).find((v) => typeof v === 'string' && v.trim().length >= 3 && v.length <= 160);
    const idOf = (x) => ID_KEYS.map((k) => x[k]).find((v) => (typeof v === 'string' || typeof v === 'number') && String(v).length >= 1);
    const urlOf = (x) => URL_KEYS.map((k) => x[k]).find((v) => typeof v === 'string' && /^(https?:\/\/|\/)/.test(v));
    const jobLike = (x) => x && typeof x === 'object' && !Array.isArray(x) && titleOf(x) && (idOf(x) != null || urlOf(x)) && Object.keys(x).some((k) => JOB_KEY.test(k));
    let best = [];
    let seen = 0;
    const visit = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 14 || seen++ > 200000) return;
      if (Array.isArray(o)) {
        const jobs = o.filter(jobLike);
        if (jobs.length >= 2 && jobs.length >= o.length * 0.6 && jobs.length > best.length) best = jobs;
        for (const x of o) visit(x, depth + 1);
        return;
      }
      for (const v of Object.values(o)) visit(v, depth + 1);
    };
    blobs.forEach((b) => visit(b, 0));
    const anchors = [...root.querySelectorAll('a[href]')];
    return best.map((x) => {
      const id = idOf(x);
      const own = urlOf(x);
      let url = own ? new URL(own, pageUrl).href : null;
      if (!url && id != null && String(id).length >= 3) url = anchors.find((a) => a.href.includes(String(id)))?.href || null;
      url = (url || `${pageUrl.split('#')[0]}#${encodeURIComponent(String(id ?? titleOf(x)))}`);
      const sal = x.salary && typeof x.salary === 'object' ? x.salary : {};
      const from = x.salaryFrom ?? x.salary_from ?? sal.from ?? sal.min;
      const to = x.salaryTo ?? x.salary_to ?? sal.to ?? sal.max;
      const salaryText = from || to ? `${from ? `от ${from}` : ''} ${to ? `до ${to}` : ''} ${str(sal.currency) || 'руб.'}` : typeof x.salary === 'string' ? x.salary : '';
      const desc = [x.description, x.shortDescription, x.short_description, x.requirements, x.responsibilities, x.duties, x.snippet, x.announce].map(str).filter(Boolean).join('\n');
      return {
        externalId: url,
        url,
        title: clean(titleOf(x)).slice(0, 160),
        company: clean(str(x.company) || str(x.employer) || str(x.companyName) || str(x.organization)),
        location: clean(str(x.city) || str(x.location) || str(x.region) || str(x.address) || str(x.area)),
        salaryText,
        description: htmlToText(desc).slice(0, 4000),
        formatText: [str(x.schedule), str(x.workFormat), str(x.format), str(x.employment), x.remote ? 'удалённо' : ''].filter(Boolean).join(', '),
        publishedText: str(x.publishedAt || x.published_at || x.datePublished || x.publicationDate || x.createdAt || x.created_at || x.date),
      };
    });
  }

  // ---------------- Поля поиска на сайте ----------------
  // Находим на странице поле «должность / поиск» и поле «город», вписываем значения
  // из профиля и жмём «Найти». Работает на большинстве сайтов: формы, React, Vue.
  const QUERY_HINT = /должност|ваканс|vacanc|професс|ключев|поиск|search|query|keyword|запрос|найти|искать|what|position|title|text/i;
  const CITY_HINT = /город|регион|местополож|населён|населен|city|location|region|area|метро/i;
  const BAD_INPUT = /mail|почт|phone|телефон|парол|password|login|логин|промокод|coupon|подпис|subscribe|имя|name\b/i;
  const inputHints = (el) => [el.placeholder, el.getAttribute('aria-label'), el.name, el.id, el.title, el.labels?.[0]?.textContent].filter(Boolean).join(' ');
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 30 && r.height > 8 && getComputedStyle(el).visibility !== 'hidden'; };
  const norm = (v) => (v || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();

  function findSearchInputs() {
    const inputs = [...document.querySelectorAll('input:not([type]), input[type="text"], input[type="search"]')]
      .filter((el) => shown(el) && !el.disabled && !el.readOnly);
    let query = null;
    let city = null;
    let best = 0;
    for (const el of inputs) {
      const hint = inputHints(el);
      if (BAD_INPUT.test(hint) && !QUERY_HINT.test(hint)) continue;
      if (CITY_HINT.test(hint) && !/должност|ваканс|професс/i.test(hint)) { city ||= el; continue; }
      let score = 0;
      if (QUERY_HINT.test(hint)) score += 3;
      if (el.type === 'search' || el.getAttribute('role') === 'searchbox' || el.getAttribute('enterkeyhint') === 'search') score += 2;
      if (!inChrome(el)) score += 1;
      score += Math.min(2, el.getBoundingClientRect().width / 400);
      if (score >= 3 && score > best) { best = score; query = el; }
    }
    return { query, city };
  }

  // Значение «как будто ввёл человек»: React и Vue узнают об изменении по событию input.
  function setValue(el, v) {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  }

  // Город выбираем из подсказки сайта: просто текст в поле многие сайты не принимают.
  async function pickCity(input, city) {
    const prev = input.value;
    setValue(input, city);
    const want = norm(city);
    const option = await waitFor(() => [...document.querySelectorAll('[role="option"], li, [class*="suggest" i] *, [class*="option" i], [class*="dropdown" i] *, [class*="autocomplete" i] *, [class*="popup" i] *')]
      .filter((o) => o !== input && !o.contains(input) && shown(o) && norm(text(o)).startsWith(want) && text(o).length < 90)
      .sort((x, y) => text(x).length - text(y).length)[0], 4000);
    if (option) { option.click(); await sleep(600); return true; }
    setValue(input, prev);
    return false;
  }

  function submitNear(input) {
    const scope = input.form || input.closest('[role="search"], [class*="search" i], [class*="filter" i]') || input.parentElement?.parentElement?.parentElement || document.body;
    const buttons = [...scope.querySelectorAll('button, input[type="submit"], [role="button"], a')].filter(shown);
    const label = (b) => (text(b) || b.value || b.getAttribute('aria-label') || b.title || '').trim();
    const byText = buttons.find((b) => /^(найти|искать|поиск|показать|применить|search|find)(\s|$)/i.test(label(b)) || (b.type === 'submit' && !/сброс|очист|reset/i.test(label(b))));
    if (byText) { byText.click(); return 'кнопка'; }
    if (input.form) { try { input.form.requestSubmit(); return 'форма'; } catch { /* нет кнопки отправки */ } }
    // Кнопка-иконка с лупой справа от поля.
    const r = input.getBoundingClientRect();
    const icon = buttons.find((b) => !label(b).replace(/\s/g, '') && b.querySelector('svg, img, i') && Math.abs(b.getBoundingClientRect().top - r.top) < 40);
    if (icon) { icon.click(); return 'кнопка'; }
    pressEnter(input);
    return 'Enter';
  }

  async function fillSearch(cfg) {
    await sleep(cfg.waitMs ?? 1500);
    const { query: qIn, city: cIn } = await waitFor(() => { const r = findSearchInputs(); return r.query || r.city ? r : null; }, 3000) || {};
    const out = { found: Boolean(qIn), cityFound: Boolean(cIn), query: null, city: null, submitted: null };
    if (cIn && cfg.city && !norm(cIn.value).includes(norm(cfg.city))) {
      if (await pickCity(cIn, cfg.city)) out.city = cfg.city;
    }
    if (qIn && cfg.query && norm(qIn.value) !== norm(cfg.query)) {
      setValue(qIn, cfg.query);
      out.query = cfg.query;
      await sleep(400);
    }
    if (out.query || out.city) out.submitted = submitNear(qIn || cIn);
    return out;
  }

  // Кнопка «Показать ещё» на сайтах, которые подгружают список без перехода.
  async function clickMore(cfg, countNow) {
    for (let i = 0; i < (cfg.moreClicks ?? 30); i++) {
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

  // Сайты, которые подгружают список при прокрутке (бесконечная лента).
  async function scrollLoad(cfg, countNow) {
    for (let i = 0; i < (cfg.scrollRounds ?? 25); i++) {
      if (countNow() >= cfg.limit) return;
      const before = countNow();
      window.scrollTo(0, document.body.scrollHeight);
      const grown = await waitFor(() => countNow() > before, 3500);
      if (!grown) return;
      await sleep(rand(500, 1200));
    }
  }

  // Если вакансии не распознались — что вообще есть на странице (для подсказки).
  function diagnose() {
    const links = [...document.querySelectorAll('a[href]')].filter((a) => !inChrome(a));
    const sample = links.map((a) => a.href.replace(location.origin, '')).filter((h) => h.length > 1 && !h.startsWith('#')).slice(0, 6);
    return `на странице ${links.length} ссылок, вакансии не распознаны${sample.length ? ` (например: ${sample.join(', ')})` : ''}. Укажите шаблон ссылки в «Ручной настройке».`;
  }

  function genericNext(root = document) {
    const rel = root.querySelector('a[rel="next"]');
    if (rel?.href) return rel.href;
    const a = [...root.querySelectorAll('a[href]')].find((x) => /^(далее|следующая|вперёд|вперед|next|›|»|→)$/i.test(text(x)) && !inChrome(x));
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
          await waitFor(() => count() > 0 || jsonJobs(document, location.href).length > 0, 15000);
          await gentleScroll(4);
          await clickMore(cfg, count);
          await scrollLoad(cfg, count);
          items = genericParse(document, cfg);
          if (!items.length) items = jsonJobs(document, location.href);
          if (!items.length) error = diagnose();
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

  // Режим «без вкладки»: страницу скачали запросом (сайты банков в Яндекс Браузере
  // закрыты для расширений во вкладке) и разбираем её здесь.
  function parseDoc(html, url) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const b = doc.createElement('base');
    b.href = url;
    doc.head.prepend(b);
    return doc;
  }
  function parseHtml(html, url, cfg = {}) {
    const doc = parseDoc(html, url);
    const here = new URL(url);
    const ld = jsonLdJobs(doc);
    let items = ld.length ? ld.map((j) => fromJsonLd(j, url)) : genericParse(doc, cfg, here);
    if (!items.length) items = jsonJobs(doc, url);
    const reason = detectBlock(doc, items.length);
    const next = genericNext(doc);
    return { platform: 'generic', items: items.slice(0, cfg.limit || 1000), total: cfg.pageNo ? null : totalFrom(doc, 'generic'), nextUrl: next && next !== url ? next : null, blocked: Boolean(reason), reason, error: items.length ? null : 'браузер не пускает расширение на этот сайт во вкладке, а в скачанной странице вакансий нет (сайт рисует их скриптом). Вставьте ссылку на страницу с уже выполненным поиском (с должностью в адресе)', url, title: doc.title };
  }
  function detailHtml(html, url) {
    const doc = parseDoc(html, url);
    const d = genericDetail(doc, url);
    return { ...d, pageTitle: d.pageTitle || text(doc.querySelector('h1')), enriched: true };
  }

  globalThis.__jobRadar = { extract, details, current, detectPlatform, fillSearch, parseHtml, detailHtml };
})();
