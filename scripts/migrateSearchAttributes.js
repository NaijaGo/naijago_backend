// Audit first. Only --apply writes derived search metadata; prices, stock, sellers
// and order history are never changed. Back up the database before applying.
require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../models/Product');
const { deriveSearchAttributes } = require('../utils/catalogSearch');

async function run() {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required.');
    const apply = process.argv.includes('--apply');
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
    const report = { mode: apply ? 'apply' : 'dry-run', scanned: 0, changed: 0, conflicts: 0, needsAudienceReview: 0 };
    for await (const product of Product.find({}).lean().cursor()) {
        report.scanned++;
        const attributes = deriveSearchAttributes(product);
        if (attributes.categoryFamily === 'fashion' && attributes.gender === 'unspecified') report.needsAudienceReview++;
        if (JSON.stringify(product.searchAttributes) === JSON.stringify(attributes)) continue;
        if (apply) {
            // Protect a concurrent vendor edit; the next run can handle conflicts.
            const result = await Product.updateOne({ _id: product._id, updatedAt: product.updatedAt },
                { $set: { searchAttributes: attributes } }, { timestamps: false });
            if (!result.matchedCount) { report.conflicts++; continue; }
        }
        report.changed++;
    }
    console.log(JSON.stringify(report, null, 2));
}
run().catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
