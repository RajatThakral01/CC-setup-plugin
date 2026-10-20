import { expect, test } from '@playwright/test';
import { applyDiscount } from '../lib/pricing';

test('discounted prices are whole cents, rounded half up', () => {
  expect(applyDiscount(1999, 15)).toBe(1699);
  expect(applyDiscount(999, 50)).toBe(500);
  expect(applyDiscount(1000, 0)).toBe(1000);
  expect(applyDiscount(1000, 100)).toBe(0);
  expect(applyDiscount(1, 50)).toBe(1);
});

test('out-of-range input throws a RangeError', () => {
  for (const [price, percent] of [
    [1000, 101],
    [1000, -1],
    [1000, Number.NaN],
    [-5, 10],
    [10.5, 10],
  ])
    expect(() => applyDiscount(price!, percent!), `${price}, ${percent}`).toThrow(RangeError);
});
