const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { planCategoryBackfill, planCategoryRollback, auditProducts } = require('../scripts/migrateProductCategories');
test('backfill proposals change references only and leave input fixtures untouched', async () => {
    const product = { _id: 'fixture', category: 'Health & Beauty', subcategory: 'Medicine', price: 100, stockQuantity: 7, isActive: true };
    const original = JSON.stringify(product);
    const entry = planCategoryBackfill(product);
    assert.equal(entry.state, 'proposed'); assert.deepEqual(Object.keys(entry.after), ['categoryId', 'subcategoryId']);
    assert.equal(JSON.stringify(product), original);
    const report = await auditProducts([product, { _id: 'unknown', category: 'unknown' }]);
    assert.deepEqual(report.counts, { proposed: 1, manual_review: 1 });
});
test('unknown paths, conflicts and existing references are not automatically overwritten', () => {
    assert.equal(planCategoryBackfill({ category: 'Fashion > Footwear > Unknown' }).state, 'manual_review');
    assert.equal(planCategoryBackfill({ category: 'Fashion', categoryId: 'ffffffffffffffffffffffff' }).state, 'reference_conflict');
    const proposed = planCategoryBackfill({ category: 'Fashion > Footwear' });
    assert.equal(planCategoryBackfill({ category: 'Fashion > Footwear', ...proposed.after }).state, 'already_referenced');
});
test('rollback planning rejects changed products and unverified journals', () => {
    const product = { _id: 'fixture', category: 'Fashion > Footwear', subcategory: '' };
    const entry = { ...planCategoryBackfill(product), state: 'applied' };
    assert.equal(planCategoryRollback(entry, { ...product, ...entry.after }).state, 'rollback_proposed');
    assert.equal(planCategoryRollback(entry, { ...product, ...entry.after, category: 'Fashion > Watches' }).state, 'skip_changed');
    assert.equal(planCategoryRollback({ ...entry, manifestChecksum: 'wrong' }, product).state, 'invalid_journal');
});
test('CLI refuses apply/rollback before connecting to any database', () => {
    for (const flag of ['--apply', '--rollback', '--write=true']) {
        const result = spawnSync(process.execPath, ['scripts/migrateProductCategories.js', flag], { cwd: require('node:path').join(__dirname, '..'), env: {} });
        assert.equal(result.status, 1); assert.match(String(result.stderr), /cannot apply migrations/);
    }
});
