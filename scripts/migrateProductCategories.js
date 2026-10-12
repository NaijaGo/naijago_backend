// Audit-only Stage 1 tool: there is deliberately no database write implementation.
const fs = require('node:fs');
const { resolveLabels, assertReferences, checksum } = require('../services/catalogTaxonomyService');
function planCategoryBackfill(product) {
    const resolved = resolveLabels(product.category, product.subcategory);
    if (!resolved) return { id: String(product._id), state: 'manual_review', category: product.category, subcategory: product.subcategory || '' };
    if (product.categoryId || product.subcategoryId) {
        try { assertReferences(product); return { id: String(product._id), state: 'already_referenced' }; }
        catch (_) { return { id: String(product._id), state: 'reference_conflict' }; }
    }
    return {
        id: String(product._id), state: 'proposed', manifestChecksum: checksum,
        before: { category: product.category, subcategory: product.subcategory || '', categoryId: null, subcategoryId: null },
        after: { categoryId: resolved.parent.id, subcategoryId: resolved.child?.id || null },
        // A future approved writer must use these conditions and journal actual modifications.
        conditions: { _id: String(product._id), category: product.category, subcategory: product.subcategory ?? null,
            categoryId: null, subcategoryId: null, updatedAt: product.updatedAt || null },
    };
}
function planCategoryRollback(entry, product) {
    if (entry?.state !== 'applied' || entry.manifestChecksum !== checksum || !entry.before || !entry.after) return { state: 'invalid_journal' };
    if (String(product._id) !== String(entry.id) || product.category !== entry.before.category ||
        (product.subcategory || '') !== entry.before.subcategory || String(product.categoryId || '') !== String(entry.after.categoryId || '') ||
        String(product.subcategoryId || '') !== String(entry.after.subcategoryId || '')) return { state: 'skip_changed' };
    return { state: 'rollback_proposed', id: entry.id, restore: { categoryId: entry.before.categoryId, subcategoryId: entry.before.subcategoryId } };
}
async function auditProducts(cursor) {
    const report = { mode: 'dry-run-only', manifestChecksum: checksum, counts: {}, entries: [] };
    for await (const product of cursor) {
        const entry = planCategoryBackfill(product);
        report.counts[entry.state] = (report.counts[entry.state] || 0) + 1;
        report.entries.push(entry);
    }
    return report;
}
async function main() {
    const args = process.argv.slice(2);
    // Reject all write requests before reading credentials or connecting.
    if (args.some(arg => /^(--apply|--rollback|--execute|--write)(=|$)/.test(arg))) throw new Error('Product category migration is dry-run-only. Separate approval and implementation are required for any writes.');
    const dbName = args.find(arg => arg.startsWith('--database='))?.slice(11);
    const uri = process.env.CATEGORY_AUDIT_MONGO_URI;
    if (!uri || !dbName || !/^[a-zA-Z0-9_-]+$/.test(dbName)) throw new Error('Provide an explicit audit URI and database. Production credentials are never loaded automatically.');
    const mongoose = require('mongoose');
    try {
        await mongoose.connect(uri, { dbName, autoCreate: false, autoIndex: false });
        const report = await auditProducts(mongoose.connection.db.collection('products').find({}, { projection: { category: 1, subcategory: 1, categoryId: 1, subcategoryId: 1, updatedAt: 1 } }));
        const reportPath = args.find(arg => arg.startsWith('--report='))?.slice(9);
        if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        else console.log(JSON.stringify(report, null, 2));
    } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(() => { console.error('Category audit refused or failed. This tool cannot apply migrations or rollback writes.'); process.exitCode = 1; });
module.exports = { planCategoryBackfill, planCategoryRollback, auditProducts };
