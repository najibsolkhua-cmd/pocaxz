// Напоминания о следующем шаге по откликам. Чистые функции: кто, что и когда напомнить.
//   «Откликнулся» / «Отправил резюме» без ответа 7 и 14 дней — написать рекрутеру;
//   «Интервью» с датой — накануне, за 3 часа и после (отметить итог, сказать спасибо);
//   «Оффер» без решения 2 дня — ответить работодателю.

const DAY = 86400e3;
const HOUR = 3600e3;

const timeOf = (iso) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

export function remindersFor(v, now = Date.now()) {
  const out = [];
  const since = v.statusChangedAt ? now - Date.parse(v.statusChangedAt) : 0;
  const add = (kind, text, stamp = v.statusChangedAt) => out.push({ id: `${v.key}|${kind}|${stamp || ''}`, kind, key: v.key, text, title: v.title, company: v.company || '', url: v.url });

  if (['responded', 'applied'].includes(v.status)) {
    if (since >= 14 * DAY) add('wait14', '2 недели без ответа — напомните о себе или двигайтесь дальше');
    else if (since >= 7 * DAY) add('wait7', '7 дней без ответа — напишите рекрутеру');
  }
  if (v.status === 'interview' && v.interviewAt) {
    const at = Date.parse(v.interviewAt);
    const left = at - now;
    if (left > 0 && left <= 3 * HOUR) add('iv3', `Интервью через ${Math.max(1, Math.round(left / HOUR))} ч (в ${timeOf(at)}) — подготовьтесь`, v.interviewAt);
    else if (left > 3 * HOUR && left <= DAY) add('iv24', `Интервью ${sameDay(at, now) ? 'сегодня' : 'завтра'} в ${timeOf(at)} — подготовьтесь`, v.interviewAt);
    else if (left < -2 * HOUR && left > -2 * DAY) add('ivafter', 'Как прошло интервью? Поблагодарите и отметьте итог', v.interviewAt);
  }
  if (v.status === 'offer' && since >= 2 * DAY) add('offer2', 'Оффер ждёт ответа — ответьте работодателю');
  return out;
}

// Ещё не отправленные напоминания (sent — { id: когда отправили }).
export function dueReminders(vacancies, { now = Date.now(), sent = {} } = {}) {
  return vacancies.flatMap((v) => remindersFor(v, now)).filter((r) => !sent[r.id]);
}

// Старые отметки об отправке больше не нужны.
export function pruneSent(sent, now = Date.now(), keepDays = 60) {
  return Object.fromEntries(Object.entries(sent || {}).filter(([, at]) => now - Date.parse(at) < keepDays * DAY));
}
