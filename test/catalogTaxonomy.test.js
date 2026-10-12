const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const taxonomy = require('../services/catalogTaxonomyService');
const labels = require('./fixtures/catalogLabels.v1.json');
const Product = require('../models/Product');
const Category = require('../models/Category');
const { initializeCatalogTaxonomy } = require('../scripts/initializeCatalogTaxonomy');

test('all 23 parents and 186 children preserve exact original labels and order', () => {
    assert.equal(taxonomy.validateManifest(), true);
    assert.deepEqual(Object.fromEntries(taxonomy.manifest.categories.map(parent => [parent.label, parent.children.map(child => child.label)])), labels);
    assert.equal(taxonomy.nodes.length, 209);
    assert.equal(new Set(taxonomy.nodes.map(node => node.id)).size, 209);
});
test('aliases retain parent scope and repeated labels retain separate identities', () => {
    assert.equal(taxonomy.resolveLabels('Health & Beauty > Medicine').child.label, 'Medicine');
    assert.equal(taxonomy.resolveLabels('Supermarket', 'Food Cupboard').parent.label, 'Groceries');
    assert.equal(taxonomy.resolveLabels('Fashion > Men').child.label, "Men's Fashion");
    assert.equal(taxonomy.resolveLabels('Phones & Tablets > Accessories').child.label, 'Mobile Phone Accessories');
    assert.equal(taxonomy.resolveLabels('Fashion > Accessories'), null);
    assert.notEqual(taxonomy.resolveLabels('Fashion > Watches').child.id, taxonomy.resolveLabels('Jewelry & Watches > Wrist Watches').child.id);
});
test('unknown, contradictory and deeper paths require manual resolution', () => {
    for (const [parent, child] of [['Unknown', ''], ['Fashion > Watches', 'Footwear'], ['Fashion > Watches > Unknown', '']]) assert.equal(taxonomy.resolveLabels(parent, child), null);
});
test('category references are optional and checked without connecting mongoose', async () => {
    const base = { name: 'Fixture', description: 'Fixture', price: 10, stockQuantity: 1, sellerType: 'naijago', category: 'Legacy category' };
    await new Product(base).validate();
    const { parent, child } = taxonomy.resolveLabels('Cosmetics & Beauty > Medicine');
    await new Product({ ...base, category: parent.label, subcategory: child.label, categoryId: parent.id, subcategoryId: child.id }).validate();
    await assert.rejects(new Product({ ...base, categoryId: parent.id, subcategoryId: child.id }).validate(), /conflict/);
    assert.equal(mongoose.connection.readyState, 0);
    assert.equal(Category.schema.options.autoCreate, false);
    assert.equal(Category.schema.options.autoIndex, false);
});

test('model validation tolerates unchanged hydrated stale references but rejects new reference writes', async () => {
    const base = { name: 'Fixture', description: 'Fixture', price: 10, stockQuantity: 1, sellerType: 'naijago',
        category: 'Fashion', subcategory: 'Footwear', categoryId: 'ffffffffffffffffffffffff' };
    const saved = Product.hydrate(base); saved.description = 'Edited';
    await saved.validate(); assert.equal(String(saved.categoryId), base.categoryId);
    await assert.rejects(new Product(base).validate(), { code: 'INVALID_PRODUCT_CATEGORY' });
    saved.categoryId = 'eeeeeeeeeeeeeeeeeeeeeeee';
    await assert.rejects(saved.validate(), { code: 'INVALID_PRODUCT_CATEGORY' });
    assert.equal(mongoose.connection.readyState, 0);
});
test('database readiness requires explicit enablement, complete identities and unique key index', async () => {
    let reads = 0;
    const fixture = { find() { reads++; return { lean: async () => taxonomy.databaseRecords() }; }, collection: { indexes: async () => [{ unique: true, key: { key: 1 } }] } };
    assert.equal(await taxonomy.databaseReadiness({ Category: fixture, connection: { readyState: 1 }, env: {} }), false);
    assert.equal(reads, 0);
    assert.equal(await taxonomy.databaseReadiness({ Category: fixture, connection: { readyState: 1 }, env: { CATEGORY_REFERENCE_WRITES_ENABLED: 'true' } }), true);
    fixture.collection.indexes = async () => [];
    assert.equal(await taxonomy.databaseReadiness({ Category: fixture, connection: { readyState: 1 }, env: { CATEGORY_REFERENCE_WRITES_ENABLED: 'true' } }), false);
});
test('explicit initialization is repeatable and dry run writes nothing', async () => {
    let rows = [], writes = 0;
    const collection = { find: () => ({ toArray: async () => rows }), createIndex: async () => { writes++; },
        updateOne: async (_filter, update) => { writes++; rows.push(update.$setOnInsert); } };
    assert.equal((await initializeCatalogTaxonomy({ collection })).missing, 209);
    assert.equal(writes, 0);
    assert.equal((await initializeCatalogTaxonomy({ collection, apply: true })).missing, 209);
    assert.equal((await initializeCatalogTaxonomy({ collection, apply: true })).missing, 0);
    rows[0] = { ...rows[0], label: 'Unexpected change' };
    const before = writes;
    await assert.rejects(initializeCatalogTaxonomy({ collection, apply: true }), /conflict/);
    assert.equal(writes, before);
});
