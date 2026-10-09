const test = require('node:test');
const assert = require('node:assert/strict');
const { replacement, canUseAsMain } = require('../utils/imageRefinementPolicy');

test('ordinary publication replaces its source without changing the main photo', () => {
  const product = { imageUrls: ['main', 'side', 'back'], images: { main: 'main', front: 'side' } };
  assert.deepEqual(replacement(product, 'side', 'refined'), {
    imageUrls: ['main', 'refined', 'back'], 'images.front': 'refined',
  });
});

test('explicit main publication promotes the refined gallery photo in both image formats', () => {
  const product = { imageUrls: ['main', 'side', 'back'], images: { main: 'main', front: 'side' }, price: 200, stockQuantity: 20 };
  const before = structuredClone(product);
  assert.deepEqual(replacement(product, 'side', 'refined', { setAsMain: true }), {
    imageUrls: ['refined', 'main', 'back'], 'images.main': 'refined', 'images.front': 'refined',
  });
  assert.deepEqual(product, before, 'policy must not mutate the source product');
});

test('promoting the existing main photo does not duplicate it', () => {
  assert.deepEqual(replacement({ imageUrls: ['main', 'side'], images: { main: 'main' } }, 'main', 'refined', { setAsMain: true }), {
    imageUrls: ['refined', 'side'], 'images.main': 'refined',
  });
});

test('legacy structured-only product preserves the previous main image', () => {
  assert.deepEqual(replacement({ images: { main: 'main', others: ['side'] } }, 'side', 'refined', { setAsMain: true }), {
    imageUrls: ['refined', 'main'], 'images.main': 'refined', 'images.others': ['refined'],
  });
});

test('variant-only source stays restricted to its variant', () => {
  const product = { imageUrls: ['main'], variants: [{ imageUrls: ['variant'] }] };
  assert.equal(canUseAsMain(product, 'variant'), false);
  assert.deepEqual(replacement(product, 'variant', 'refined'), { 'variants.0.imageUrls': ['refined'] });
  assert.throws(() => replacement(product, 'variant', 'refined', { setAsMain: true }), /variant-only/);
});

test('removed source and missing product are not eligible for main publication', () => {
  assert.equal(canUseAsMain(null, 'old'), false);
  assert.equal(canUseAsMain({ imageUrls: ['new'] }, 'old'), false);
  assert.throws(() => replacement({ imageUrls: ['new'] }, 'old', 'refined', { setAsMain: true }), /obsolete/);
});
