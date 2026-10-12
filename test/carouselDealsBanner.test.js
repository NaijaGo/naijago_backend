const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { CarouselSlide, VALID_CAROUSEL_ACTIONS, VALID_CAROUSEL_PLACEMENTS } = require('../models/CarouselSlide');
test('Deals is additive; existing carousel placements and actions remain valid without any database connection', () => {
  assert.deepEqual(VALID_CAROUSEL_PLACEMENTS, ['main', 'promo']);
  assert.deepEqual(VALID_CAROUSEL_ACTIONS, ['none', 'restaurant', 'pharmacy', 'category', 'product', 'external', 'deals']);
  for (const actionType of VALID_CAROUSEL_ACTIONS) {
    const doc = new CarouselSlide({ placement: 'promo', imageUrl: 'https://fixture.invalid/banner.png', actionType });
    assert.equal(doc.validateSync(), undefined);
  }
  assert.ok(new CarouselSlide({placement:'promo', imageUrl:'fixture', actionType:'invalid'}).validateSync());
});
function harness() {
  const routes = []; const protect = () => {}; const authorization = { roles: ['admin'] };
  const router = Object.fromEntries(['get','post','put','delete'].map(method => [method, (path, ...handlers) => routes.push({method,path,handlers})]));
  const context = { module: { exports: {} }, console,
    require(name) {
      if (name === 'express') return {Router: () => router};
      if (name.includes('authMiddleware')) return {protect, authorizeRoles: (...roles) => {
        assert.deepEqual(roles,['admin']); return authorization;
      }};
      if (name.includes('CarouselSlide')) return {CarouselSlide: {}, VALID_CAROUSEL_ACTIONS, VALID_CAROUSEL_PLACEMENTS};
      throw Error('Unexpected dependency; no database permitted');
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../routes/adminCarouselRoutes.js'),'utf8') +
    '\nmodule.exports.sanitize = sanitizeSlidePayload;', context);
  return {routes, protect, authorization, sanitize:context.module.exports.sanitize};
}
test('actual admin payload sanitizer accepts Deals and preserves legacy unknown-action fallback', () => {
  const h = harness();
  const payload = h.sanitize({placement:' PROMO ', imageUrl:' https://fixture.invalid/banner.png ', actionType:' DEALS ', sortOrder:'2', isActive:true});
  assert.equal(payload.actionType,'deals'); assert.equal(payload.placement,'promo'); assert.equal(payload.sortOrder,2);
  assert.equal(payload.imageUrl,'https://fixture.invalid/banner.png');
  assert.equal(h.sanitize({actionType:'unknown'}).actionType,'none');
  for (const actionType of VALID_CAROUSEL_ACTIONS) assert.equal(h.sanitize({actionType}).actionType,actionType);
});
test('all existing carousel admin handlers retain login and admin guards', () => {
  const h = harness(); assert.equal(h.routes.length,4);
  for (const route of h.routes) {
    assert.equal(route.handlers[0],h.protect); assert.equal(route.handlers[1],h.authorization);
  }
});
