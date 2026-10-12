const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareProductCategory, resolveLabels, assertReferences } = require('../services/catalogTaxonomyService');
const { buildCategorySelectionFilter } = require('../utils/productFilters');
const medicine = resolveLabels('Cosmetics & Beauty > Medicine');
const ids = { categoryId: medicine.parent.id, subcategoryId: medicine.child.id };
test('old combined and separate requests retain their labels', () => {
    for (const input of [{ category: 'Health & Beauty > Medicine' }, { category: 'Health & Beauty', subcategory: 'Medicine' }]) {
        const result = prepareProductCategory(input);
        assert.equal(result.category, input.category);
        assert.equal(result.subcategory, input.subcategory || '');
        assert.equal(result.categoryId, null);
        const ready = prepareProductCategory(input, {}, { referencesReady: true });
        assert.equal(ready.categoryId, ids.categoryId); assert.equal(ready.subcategoryId, ids.subcategoryId);
        assertReferences(ready);
    }
});
test('ID-only creation emits a compatible combined path and validates parent-child identities', () => {
    const result = prepareProductCategory(ids, {}, { referencesReady: true });
    assert.equal(result.category, 'Cosmetics & Beauty > Medicine');
    assert.equal(result.subcategory, 'Medicine');
    assert.throws(() => prepareProductCategory(ids), /not enabled/);
    assert.throws(() => prepareProductCategory({ ...ids, category: 'Fashion' }, {}, { referencesReady: true }), /conflict/);
    assert.throws(() => prepareProductCategory({ ...ids, categoryId: 'ffffffffffffffffffffffff' }, {}, { referencesReady: true }), /valid category/);
});
test('partial updates retain omitted fields; old clients cannot leave stale IDs', () => {
    const current = { category: 'Cosmetics & Beauty', subcategory: 'Medicine', ...ids };
    assert.deepEqual(prepareProductCategory({ price: 10 }, current), current);
    assert.equal(prepareProductCategory({ category: current.category }, current).subcategory, 'Medicine');
    assert.deepEqual(prepareProductCategory({ categoryId: ids.categoryId }, current, { referencesReady: true }), current);
    const alias = prepareProductCategory({ category: 'Health & Beauty' }, current, { referencesReady: true });
    assert.equal(alias.subcategory, 'Medicine'); assert.equal(alias.subcategoryId, ids.subcategoryId);
    assert.throws(() => prepareProductCategory({ category: 'Fashion > Footwear' }, current), /matching subcategory/);
    const changed = prepareProductCategory({ category: 'Fashion > Footwear', subcategory: '' }, current);
    assert.equal(changed.subcategory, ''); assert.equal(changed.categoryId, null); assert.equal(changed.subcategoryId, null);
});
test('unmapped legacy values remain editable without renaming', () => {
    assert.equal(prepareProductCategory({ category: 'Home Appliances > Blenders' }, {}, { referencesReady: true }).category, 'Home Appliances > Blenders');
    assert.equal(prepareProductCategory({ category: 'Home Appliances > Blenders' }, {}, { referencesReady: true }).categoryId, null);
});
test('ID filters also include legacy label matching and reject conflicting selections', () => {
    const filter = buildCategorySelectionFilter(ids);
    assert.deepEqual(filter.$or[0].$and[0], ids);
    assert.match(String(filter.$or[1].$or[0].category.$regex), /Medicine/);
    assert.throws(() => buildCategorySelectionFilter({ ...ids, category: 'Fashion' }), /conflict/);
    assert.throws(() => buildCategorySelectionFilter({ ...ids, subcategory: 'Fragrance' }), /conflict/);
    assert.deepEqual(buildCategorySelectionFilter({ categoryId: ids.categoryId, subcategory: 'Medicine' }).$or[0].$and[0], ids);
    assert.deepEqual(buildCategorySelectionFilter({ ...ids, category: 'Health & Beauty' }).$or[0].$and[0], ids);
    assert.equal(buildCategorySelectionFilter({}), null);
});
