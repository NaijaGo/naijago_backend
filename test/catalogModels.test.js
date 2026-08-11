const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Product = require('../models/Product');
const ProductOffer = require('../models/ProductOffer');

const baseProduct = () => ({
  name: 'Test Blender',
  description: 'A real stocked catalogue item',
  price: 25000,
  category: 'Home Appliances > Blenders',
  stockQuantity: 4,
  imageUrls: ['https://example.com/blender.jpg'],
});

test('NaijaGo product validates without a vendor', async () => {
  const product = new Product({ ...baseProduct(), sellerType: 'naijago' });
  await product.validate();
  assert.equal(product.sellerType, 'naijago');
  assert.equal(product.sellerId, null);
  assert.equal(product.vendor, null);
  assert.equal(product.productStatus, 'active');
});

test('legacy vendor is normalized into seller fields', async () => {
  const vendorId = new mongoose.Types.ObjectId();
  const product = new Product({ ...baseProduct(), vendor: vendorId });
  await product.validate();
  assert.equal(product.sellerType, 'vendor');
  assert.equal(String(product.sellerId), String(vendorId));
});

test('invalid product discount is rejected', async () => {
  const product = new Product({ ...baseProduct(), discountPrice: 26000 });
  await assert.rejects(product.validate(), /Discount price must be lower/);
});

test('zero-stock active product normalizes to out of stock', async () => {
  const product = new Product({ ...baseProduct(), stockQuantity: 0 });
  await product.validate();
  assert.equal(product.productStatus, 'out_of_stock');
  assert.equal(product.isActive, false);
});

test('NaijaGo offer allows nullable seller and vendor offer does not', async () => {
  const productId = new mongoose.Types.ObjectId();
  const naijaGoOffer = new ProductOffer({
    product: productId,
    sellerType: 'naijago',
    price: 25000,
    stockQuantity: 2,
    status: 'active',
  });
  await naijaGoOffer.validate();
  assert.equal(naijaGoOffer.sellerId, null);

  const vendorOffer = new ProductOffer({
    product: productId,
    sellerType: 'vendor',
    price: 25000,
    stockQuantity: 2,
  });
  await assert.rejects(vendorOffer.validate(), /Vendor offers require a sellerId/);
});
