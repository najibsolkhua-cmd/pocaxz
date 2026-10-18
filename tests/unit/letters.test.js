import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TEMPLATES, renderLetter, experienceLine, letterSkills } from '../../extension/lib/letters.js';

const profile = { name: 'Анна', position: 'Маркетолог', about: 'Пять лет веду performance-маркетинг для e-commerce: Директ, VK Реклама, аналитика. Подняла ROMI в 2 раза.', skills: ['*SMM', 'Яндекс Директ', 'Юнит-экономика'] };

test('письмо: подстановки из профиля и вакансии, совпавшие навыки первыми', () => {
  const t = renderLetter(DEFAULT_TEMPLATES[1], { vacancy: { title: 'Интернет-маркетолог', company: 'Ромашка' }, profile, matched: ['yandex_direct', 'metrika'], contacts: '+7 900 000-00-00 · t.me/anna' });
  assert.match(t, /вакансия «Интернет-маркетолог» в компании «Ромашка»\./);
  assert.match(t, /Мой опыт: пять лет веду performance-маркетинг для e-commerce: Директ, VK Реклама, аналитика/);
  assert.match(t, /ключевым навыкам: Яндекс Директ, Яндекс Метрика, SMM, Юнит-экономика\./);
  assert.match(t, /Анна\n\+7 900 000-00-00/);
  assert.ok(!/[{}[\]]/.test(t), 'не осталось скобок шаблона');
});

test('письмо: пустые фрагменты пропадают целиком', () => {
  const t = renderLetter(DEFAULT_TEMPLATES[1], { vacancy: { title: 'Маркетолог', company: '' }, profile: { position: 'Маркетолог' } });
  assert.match(t, /вакансия «Маркетолог»\./);
  assert.ok(!/компании|Мой опыт|навыкам|undefined/.test(t), t);
  assert.ok(!/\n{3,}/.test(t));
});

test('строка опыта и навыки', () => {
  assert.equal(experienceLine('Делаю сайты. И ещё много всего.'), 'делаю сайты');
  assert.equal(experienceLine(''), '');
  assert.ok(experienceLine('а'.repeat(400)).length <= 222);
  assert.equal(letterSkills(['python'], ['*Python', 'Django']), 'Python, Django');
});

test('письмо под вакансию: собирается из вакансии и профиля', async () => {
  const { autoLetter, normalizeLetters, relevantSentences, applyGender } = await import('../../extension/lib/letters.js');
  const p = { ...profile, grade: 'middle', formats: ['remote'], cities: ['Москва'], about: 'Веду соцсети брендов и пишу контент-планы. Пять лет запускаю рекламу в Яндекс Директ для e-commerce. Люблю котиков.' };
  const v = { title: 'Performance-маркетолог', company: 'Ромашка', description: 'Запуск и оптимизация рекламы в Яндекс Директ, аналитика e-commerce.', formats: ['remote'], location: 'Москва' };
  const t = autoLetter({ vacancy: v, profile: p, matched: ['yandex_direct'], contacts: 't.me/anna', gender: 'f' });
  assert.match(t, /вакансия «Performance-маркетолог» в компании «Ромашка»/);
  assert.match(t, /Я — маркетолог уровня middle\./);
  assert.match(t, /Пять лет запускаю рекламу в Яндекс Директ/, 'взято самое близкое к вакансии предложение');
  assert.ok(!/котиков/.test(t), 'нерелевантное предложение не попало');
  assert.match(t, /работаю постоянно: Яндекс Директ\. Также владею: SMM, Юнит-экономика\./);
  assert.match(t, /Формат «удалённо» мне подходит, я нахожусь в городе Москва\./);
  assert.match(t, /Буду рада .*готова выполнить/);
  assert.match(t, /С уважением,\nАнна\nt\.me\/anna$/);
  assert.ok(!/undefined|\{|\[\[/.test(t));
  // Почти пустой профиль — всё равно связное письмо.
  const bare = autoLetter({ vacancy: { title: 'Курьер' } });
  assert.match(bare, /^Здравствуйте!\n\nМеня заинтересовала вакансия «Курьер» — хочу/);
  assert.match(bare, /рад\(а\)/);
  assert.deepEqual(relevantSentences('', 'x'), []);
  assert.equal(applyGender('Готов(а), рад(а)', 'm'), 'Готов, рад');
  // Старые настройки писем: «Под вакансию» добавляется первым и один раз становится основным.
  const old = normalizeLetters({ templates: [{ id: 'short', name: 'Моё', text: 'Привет' }], defaultId: 'short', contacts: 'x' });
  assert.deepEqual(old.templates.map((x) => x.id), ['auto', 'short']);
  assert.equal(old.defaultId, 'auto');
  assert.equal(normalizeLetters({ ...old, defaultId: 'short' }).defaultId, 'short', 'выбор пользователя после миграции сохраняется');
  assert.equal(normalizeLetters(null).templates.length, 3);
});
