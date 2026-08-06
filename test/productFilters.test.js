const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildHierarchicalCategoryFilter,
  buildPriceFilter,
} = require('../utils/productFilters');

test('parent categories match themselves and descendants', () => {
  const regex = buildHierarchicalCategoryFilter('Fashion').category.$regex;
  assert.equal(regex.test('Fashion'), true);
  assert.equal(regex.test('Fashion > Men Fashion'), true);
  assert.equal(regex.test('Fashionable Gadgets'), false);
});

test('subcategory selection remains scoped to that hierarchy', () => {
  const regex = buildHierarchicalCategoryFilter('Fashion > Shoes').category.$regex;
  assert.equal(regex.test('Fashion > Shoes'), true);
  assert.equal(regex.test('Fashion > Shoes > Trainers'), true);
  assert.equal(regex.test('Fashion > Bags'), false);
});

test('budget range accepts either or both boundaries', () => {
  assert.deepEqual(buildPriceFilter('10000', '50000'), { $gte: 10000, $lte: 50000 });
  assert.deepEqual(buildPriceFilter('', '50000'), { $lte: 50000 });
  assert.equal(buildPriceFilter('', ''), undefined);
});
