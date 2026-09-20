const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCategoryFilter,
  buildHierarchicalCategoryFilter,
  buildPriceFilter,
  buildEffectivePriceExpression,
} = require('../utils/productFilters');

test('shared category filter accepts legacy paths and split category fields', () => {
  const filter = buildCategoryFilter(' Fashion > Women > Dresses ');
  assert.equal(filter.$or[0].category.$regex.test('Fashion > Women > Dresses'), true);
  assert.equal(filter.$or[1].category.$regex.test('Fashion'), true);
  assert.equal(filter.$or[1].subcategory.$regex.test('Women > Dresses'), true);
  assert.equal(filter.$or[1].subcategory.$regex.test('Men > Dresses'), false);
  assert.deepEqual(buildCategoryFilter('Fashion'), buildHierarchicalCategoryFilter('Fashion'));
});

test('parent categories match themselves and descendants', () => {
  const regex = buildHierarchicalCategoryFilter('Fashion').category.$regex;
  assert.equal(regex.test('Fashion'), true);
  assert.equal(regex.test('Fashion > Men Fashion'), true);
  assert.equal(regex.test('Fashionable Gadgets'), false);
});

test('customer budget filters use a valid discount before regular price', () => {
  const expression = buildEffectivePriceExpression('', '50000');
  assert.deepEqual(expression, {
    $lte: [
      {
        $cond: [
          { $and: [{ $ne: ['$discountPrice', null] }, { $gt: ['$price', '$discountPrice'] }] },
          '$discountPrice',
          '$price',
        ],
      },
      50000,
    ],
  });
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
