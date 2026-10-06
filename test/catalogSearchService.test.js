const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_LIMIT,
  SearchInputError,
  parseCatalogSearchRequest,
  searchCatalog,
} = require('../services/catalogSearchService');

function createProductModel(records) {
  let lastFilter;
  return {
    get lastFilter() { return lastFilter; },
    find(filter) {
      lastFilter = filter;
      let skip = 0;
      let limit = records.length;
      const chain = {
        populate() { return chain; },
        sort() { return chain; },
        skip(value) { skip = value; return chain; },
        limit(value) { limit = value; return chain; },
        lean: async () => records.slice(skip, skip + limit),
      };
      return chain;
    },
    countDocuments: async () => records.length,
  };
}

const EmptyUserModel = {
  find() {
    return {
      select() { return this; },
      limit() { return this; },
      lean: async () => [],
    };
  },
};

test('product search terms and regex punctuation are escaped and do not throw', async (t) => {
  for (const query of ['iPhone', 'Samsung', 'rice', 'shoes', 'PS5', 'Gwarinpa', 'a completely nonexistent product', '(', '[', '.*']) {
    await t.test(query, async () => {
      const products = createProductModel([]);
      const input = parseCatalogSearchRequest({ q: query });
      const result = await searchCatalog(input, { ProductModel: products, UserModel: EmptyUserModel });
      assert.deepEqual(result, {
        products: [], total: 0, page: 1, limit: 30, hasMore: false,
      });
      const expression = products.lastFilter.$and[1].$or[0].name.$regex;
      assert.doesNotThrow(() => new RegExp(expression, 'i'));
      if (query === '(' || query === '[' || query === '.*') {
        assert.equal(new RegExp(expression).test('anything'), false);
      }
    });
  }
});

test('empty search is a successful empty catalog response', async () => {
  const input = parseCatalogSearchRequest({ q: '' });
  const result = await searchCatalog(input, { ProductModel: createProductModel([]), UserModel: EmptyUserModel });
  assert.equal(result.total, 0);
  assert.deepEqual(result.products, []);
  assert.equal(result.page, 1);
  assert.equal(result.hasMore, false);
});

test('pagination uses stable page offsets and clamps large result limits', async () => {
  const records = Array.from({ length: 75 }, (_, index) => ({ id: index + 1 }));
  const ProductModel = createProductModel(records);
  const page1 = await searchCatalog(
    parseCatalogSearchRequest({ q: 'phone', page: '1', limit: '30' }),
    { ProductModel, UserModel: EmptyUserModel },
  );
  const page2 = await searchCatalog(
    parseCatalogSearchRequest({ q: 'phone', page: '2', limit: '30' }),
    { ProductModel, UserModel: EmptyUserModel },
  );
  assert.equal(page1.products[0].id, 1);
  assert.equal(page2.products[0].id, 31);
  assert.equal(page1.hasMore, true);
  assert.equal(page2.hasMore, true);
  assert.equal(new Set([...page1.products, ...page2.products].map((item) => item.id)).size, 60);
  assert.equal(parseCatalogSearchRequest({ q: 'phone', limit: '500' }).limit, MAX_LIMIT);
});

test('vendor-name search is constrained to approved vendors in the existing user model', async () => {
  let vendorFilter;
  const UserModel = {
    find(filter) {
      vendorFilter = filter;
      return {
        select() { return this; },
        limit() { return this; },
        lean: async () => [{ _id: '507f1f77bcf86cd799439011' }],
      };
    },
  };
  const ProductModel = createProductModel([]);
  await searchCatalog(parseCatalogSearchRequest({ q: 'Lucas' }), { ProductModel, UserModel });
  assert.equal(vendorFilter.isVendor, true);
  assert.equal(vendorFilter.vendorStatus, 'approved');
  assert.ok(ProductModel.lastFilter.$and[1].$or.some((part) => part.vendor));
});

test('invalid search parameters return a validation error', () => {
  assert.throws(() => parseCatalogSearchRequest({ q: ['iPhone'] }), SearchInputError);
  assert.throws(() => parseCatalogSearchRequest({ q: 'x', page: '0' }), SearchInputError);
});
