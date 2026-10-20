import { expect, test } from '@playwright/test';
import { paginate } from '../lib/paginate';

const list = [1, 2, 3, 4, 5, 6, 7];

test('pages are numbered from 1', () => {
  expect(paginate(list, 1, 3)).toEqual({ items: [1, 2, 3], page: 1, totalPages: 3 });
  expect(paginate(list, 2, 3).items).toEqual([4, 5, 6]);
  expect(paginate(list, 3, 3).items).toEqual([7]);
});

test('totalPages counts a partial last page and is at least 1', () => {
  expect(paginate(list, 1, 7).totalPages).toBe(1);
  expect(paginate(list, 1, 2).totalPages).toBe(4);
  expect(paginate([], 1, 5)).toEqual({ items: [], page: 1, totalPages: 1 });
});

test('pages outside the range are empty', () => {
  expect(paginate(list, 0, 3).items).toEqual([]);
  expect(paginate(list, 4, 3).items).toEqual([]);
  expect(paginate(list, -1, 3).items).toEqual([]);
});
