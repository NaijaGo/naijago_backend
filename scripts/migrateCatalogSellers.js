/*
 * Backfills seller fields and one primary ProductOffer for existing products.
 * Safe default: audit only. Pass --apply to write changes.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../models/Product');
const ProductOffer = require('../models/ProductOffer');

const apply = process.argv.includes('--apply');

async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required.');
  await mongoose.connect(process.env.MONGO_URI);

  const products = Product.find({}).cursor();
  const report = { scanned: 0, naijago: 0, vendor: 0, productsUpdated: 0, offersCreated: 0 };

  for await (const product of products) {
    report.scanned += 1;
    const sellerType = product.vendor ? 'vendor' : 'naijago';
    const sellerId = product.vendor || null;
    report[sellerType] += 1;

    const productChanges = {};
    if (product.sellerType !== sellerType) productChanges.sellerType = sellerType;
    if (String(product.sellerId || '') !== String(sellerId || '')) productChanges.sellerId = sellerId;
    if (!product.productStatus) {
      productChanges.productStatus = !product.isActive
        ? 'disabled'
        : product.stockQuantity > 0 ? 'active' : 'out_of_stock';
    }
    if (!product.source) productChanges.source = sellerType === 'vendor' ? 'vendor' : 'naijago_catalog';

    if (Object.keys(productChanges).length) {
      report.productsUpdated += 1;
      if (apply) await Product.updateOne({ _id: product._id }, { $set: productChanges });
    }

    const offerFilter = { product: product._id, sellerType, sellerId };
    const hasOffer = await ProductOffer.exists(offerFilter);
    if (!hasOffer) {
      report.offersCreated += 1;
      if (apply) {
        await ProductOffer.create({
          ...offerFilter,
          sku: product.sku || undefined,
          price: product.price,
          discountPrice: product.discountPrice,
          stockQuantity: product.stockQuantity,
          status: product.productStatus || (product.isActive ? 'active' : 'disabled'),
          fulfilmentLocation: product.productLocation,
          isPrimary: true,
        });
      }
    }
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...report }, null, 2));
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
