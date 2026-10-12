const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../utils/categoryPolicy');
const { resolveLabels } = require('../services/catalogTaxonomyService');
test('medicine policy evaluates combined paths, aliases, split fields and IDs', () => {
    const { parent, child } = resolveLabels('Cosmetics & Beauty > Medicine');
    for (const value of [{ category: 'Health & Beauty > Medicine' }, { category: 'Cosmetics & Beauty', subcategory: 'Medicine' }, { categoryId: parent.id, subcategoryId: child.id }]) {
        assert.equal(policy.isMedicineCategory(value), true); assert.equal(policy.requiresProductModeration(value), true);
    }
    assert.equal(policy.isMedicineCategory({ category: 'Cosmetics & Beauty', subcategory: 'Fragrance' }), false);
});
test('ordering restrictions preserve medicine access and prescription protections', () => {
    assert.equal(policy.isRestrictedMedicine({ category: 'Cosmetics & Beauty', subcategory: 'Medicine', requiresPrescription: true }), true);
    assert.equal(policy.isRestrictedMedicine({ category: 'Legacy', medicineAccess: 'restricted' }), true);
    assert.equal(policy.isRestrictedMedicine({ category: 'Cosmetics & Beauty', subcategory: 'Medicine', medicineAccess: 'over_the_counter' }), false);
});
test('food checks preserve legacy heuristics and restaurant equipment exclusions', () => {
    assert.equal(policy.isRestaurantCategory({ category: 'Restaurant', subcategory: 'Meals' }), true);
    assert.equal(policy.isRestaurantCategory({ category: 'Restaurant', subcategory: 'Restaurant Equipment' }), true);
    assert.equal(policy.isRestaurantCategory({ category: 'Food & Beverage', subcategory: 'Restaurant Equipment' }), false);
    assert.equal(policy.isRestaurantCategory('Food & Beverage > Catering Supplies'), true);
    assert.equal(policy.requiresProductModeration({ category: 'Fashion', subcategory: 'Footwear' }), false);
});
