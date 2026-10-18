import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TEMPLATES, renderLetter, experienceLine, letterSkills } from '../../extension/lib/letters.js';

const profile = { name: 'Анна', position: 'Маркетолог', about: 'Пять лет веду performance-маркетинг для e-commerce: Директ, VK Реклама, аналитика. Подняла ROMI в 2 раза.', skills: ['*SMM', 'Яндекс Директ', 'Юнит-экономика'] };

test('письмо: подстановки из профиля и вакансии, совпавшие навыки первыми', () => {
  const t = renderLetter(DEFAULT_TEMPLATES[0], { vacancy: { title: 'Интернет-маркетолог', company: 'Ромашка' }, profile, matched: ['yandex_direct', 'metrika'], contacts: '+7 900 000-00-00 · t.me/anna' });
  assert.match(t, /вакансия «Интернет-маркетолог» в компании «Ромашка»\./);
  assert.match(t, /Мой опыт: пять лет веду performance-маркетинг для e-commerce: Директ, VK Реклама, аналитика/);
  assert.match(t, /ключевым навыкам: Яндекс Директ, Яндекс Метрика, SMM, Юнит-экономика\./);
  assert.match(t, /Анна\n\+7 900 000-00-00/);
  assert.ok(!/[{}[\]]/.test(t), 'не осталось скобок шаблона');
});

test('письмо: пустые фрагменты пропадают целиком', () => {
  const t = renderLetter(DEFAULT_TEMPLATES[0], { vacancy: { title: 'Маркетолог', company: '' }, profile: { position: 'Маркетолог' } });
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
