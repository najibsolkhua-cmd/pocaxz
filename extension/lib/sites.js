// Сайты, которые рисуют список вакансий скриптом и берут его из своего API.
// В Яндекс Браузере часть из них (сайты банков) открывается в «Защищённом режиме»,
// куда расширения не пускают, — тогда вакансии берём прямо из этого API.

// T-Банк: сайт карьеры грузит вакансии POST-запросом на /pfpjobs/papi/getVacancies,
// список — в payload.vacancies, город — в subtitle.
// Точный формат запроса не опубликован: пробуем несколько вариантов и запоминаем рабочий.
const TBANK = {
  id: 'tbank',
  match: (u) => /(^|\.)(tbank|tinkoff)\.ru$/i.test(u.hostname) && /career|vacanc/i.test(u.pathname),
  endpoint: (u) => `${u.origin}/pfpjobs/papi/getVacancies`,
  bodies: [
    { limit: 300, offset: 0, filters: { generatedGraphQL: { type: 'T_CAREER' } } },
    { limit: 300, offset: 0, generatedGraphQL: { type: 'T_CAREER' } },
    { limit: 300, offset: 0, filter: { generatedGraphQL: { type: 'T_CAREER' } } },
    { limit: 300, offset: 0, generatedGraphQL: { type: 'T_CAREER', categories: [] } },
  ],
  list: (json) => json?.payload?.vacancies || json?.payload?.items || json?.vacancies,
};

export const SITE_APIS = [TBANK];

export function siteApiFor(url, cfg = {}) {
  let u;
  try { u = new URL(url); } catch { return null; }
  return SITE_APIS.find((a) => cfg.api === a.id || a.match(u)) || null;
}

const str = (v) => (v == null ? '' : typeof v === 'string' || typeof v === 'number' ? String(v)
  : Array.isArray(v) ? v.map(str).filter(Boolean).join(', ') : typeof v === 'object' ? str(v.name ?? v.title ?? v.value ?? v.text ?? '') : '');
const stripTags = (h) => str(h).replace(/<br\s*\/?>|<\/(p|li|div)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

// Объект вакансии из JSON → карточка для normalizeItem.
export function jobFromObject(x, pageUrl) {
  const title = str(x.title ?? x.name ?? x.vacancyName ?? x.position ?? x.header).trim();
  if (!title) return null;
  const id = str(x.id ?? x.vacancyId ?? x.slug ?? x.urlSlug ?? x.code ?? x.uuid);
  const own = str(x.url ?? x.link ?? x.href ?? x.vacancyUrl);
  const base = new URL(pageUrl);
  const url = own ? new URL(own, base.origin).href : `${pageUrl.split('#')[0]}#${encodeURIComponent(id || title)}`;
  const sal = x.salary && typeof x.salary === 'object' ? x.salary : {};
  const from = x.salaryFrom ?? sal.from ?? sal.min;
  const to = x.salaryTo ?? sal.to ?? sal.max;
  const salaryText = from || to ? `${from ? `от ${from}` : ''} ${to ? `до ${to}` : ''} ${str(sal.currency) || 'руб.'}`.trim() : typeof x.salary === 'string' ? x.salary : '';
  const tags = [x.tags, x.labels, x.schedule, x.employment, x.workFormat, x.format, x.experience].map(str).filter(Boolean).join(', ');
  const description = [x.description, x.shortDescription, x.short_description, x.announce, x.requirements, x.responsibilities, x.duties]
    .map(stripTags).filter(Boolean).join('\n');
  return {
    externalId: url,
    url,
    title: title.slice(0, 160),
    company: str(x.company ?? x.employer ?? x.companyName ?? x.organization),
    location: str(x.subtitle ?? x.city ?? x.cities ?? x.location ?? x.region ?? x.address),
    salaryText,
    formatText: tags,
    description: [description, tags].filter(Boolean).join('\n').slice(0, 6000),
    cardText: [title, str(x.subtitle), tags, description].filter(Boolean).join('\n').slice(0, 1500),
    publishedText: str(x.publishedAt ?? x.publicationDate ?? x.datePublished ?? x.createdAt ?? x.date),
  };
}

// Вакансии из API сайта. fetchJson(url, body) делает POST и возвращает JSON или null.
// known — номер варианта запроса, который сработал в прошлый раз.
export async function readSiteApi(api, pageUrl, fetchJson, known = null) {
  const order = known != null ? [known, ...api.bodies.keys()].filter((v, i, a) => a.indexOf(v) === i) : [...api.bodies.keys()];
  const endpoint = api.endpoint(new URL(pageUrl));
  for (const i of order) {
    const json = await fetchJson(endpoint, api.bodies[i]).catch(() => null);
    const list = api.list(json);
    if (Array.isArray(list) && list.length) {
      const items = list.map((x) => jobFromObject(x, pageUrl)).filter(Boolean);
      if (items.length) return { variant: i, items, total: Number(json?.payload?.total ?? json?.payload?.count) || list.length };
    }
  }
  return null;
}
