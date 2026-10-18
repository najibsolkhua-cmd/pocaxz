import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBanners, SAMPLE_BANNERS } from '../../extension/ui/partners.js';

globalThis.chrome ||= { storage: { local: {} } };
const { STATUSES, MY_STATUSES } = await import('../../extension/lib/store.js');

test('партнёрские баннеры: сначала по профессии, чужие целевые не показываются', () => {
  const ids = (p) => [...new Set(pickBanners(SAMPLE_BANNERS, p).map((b) => b.id))];
  assert.deepEqual(ids({ position: 'Маркетолог', titleKeywords: ['SMM-менеджер'] }), ['sample-school', 'sample-bank', 'sample-resume']);
  assert.deepEqual(ids({ position: 'Python-разработчик' }), ['sample-it', 'sample-bank', 'sample-resume']);
  assert.deepEqual(ids({ position: '' }), ['sample-bank', 'sample-resume'], 'без должности — только общие');
});

test('баннер без рекламодателя или с http-ссылкой не показывается; вес повторяет баннер', () => {
  const list = pickBanners([
    { id: 'a', advertiser: 'A', title: 'x', url: 'http://a.ru' },
    { id: 'b', title: 'x', url: 'https://b.ru' },
    { id: 'c', advertiser: 'C', title: 'x', url: 'https://c.ru', weight: 3 },
  ], {});
  assert.deepEqual(list.map((b) => b.id), ['c', 'c', 'c']);
});

test('статусы: «Откликнулся» между «Просмотрел» и «Отправил резюме»; «Мои отклики» — всё, кроме двух первых', () => {
  assert.deepEqual(STATUSES.map(([k]) => k), ['new', 'viewed', 'responded', 'applied', 'interview', 'offer', 'rejected', 'hidden']);
  assert.deepEqual(MY_STATUSES, STATUSES.map(([k]) => k).filter((k) => !['new', 'viewed'].includes(k)));
});
