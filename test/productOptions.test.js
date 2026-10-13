const test = require('node:test');
const assert = require('node:assert/strict');
const { parseColors, resolveSelection } = require('../utils/productOptions');
const Product = require('../models/Product');
const Shipment = require('../models/Shipment');
const inventory = require('../services/inventoryService');
const { GroupOrder } = require('../models/PlannedOrders');

test('seller colours parse multipart JSON and comma-separated labels without inventing choices', () => {
  assert.deepEqual(parseColors('["Black","Royal Blue","black", ""]'), ['Black','Royal Blue']);
  assert.deepEqual(parseColors('Cream, Brown'), ['Cream','Brown']);
  assert.deepEqual(parseColors([]), []);
});
test('invalid, huge and structured colour fields are rejected', () => {
  for (const value of [{}, [null], ['x'.repeat(41)], Array(33).fill('blue'), ['blue\nred']]) {
    assert.throws(() => parseColors(value), error => error.statusCode === 400);
  }
});
test('legacy products and older clients may omit colour and size choices', () => {
  assert.deepEqual(resolveSelection({}, {}), { selectedColor: null, selectedSize: null });
  assert.equal(resolveSelection({ availableColors: ['Blue'] }, {}).selectedColor, null);
});
test('selected colours are canonical seller values; tampered or stale choices fail closed', () => {
  assert.equal(resolveSelection({ availableColors: ['Royal Blue'] }, { selectedColor: 'royal blue' }).selectedColor, 'Royal Blue');
  for (const selectedColor of ['Red', {}, ['Blue'], 'x'.repeat(41)]) {
    assert.throws(() => resolveSelection({ availableColors: ['Blue'] }, { selectedColor }), error => error.code === 'PRODUCT_OPTIONS_INVALID');
  }
});
test('sizes support legacy strings and backend object sizes, but reject unknown choices', () => {
  const product = { sizeData: { type: 'clothing', sizes: [{value:'M'}, 'L'] } };
  assert.equal(resolveSelection(product, {selectedSize:'M'}).selectedSize, 'M');
  assert.equal(resolveSelection(product, {selectedSize:'L'}).selectedSize, 'L');
  assert.throws(() => resolveSelection(product, {selectedSize:'XXL'}), /no longer available/);
});
test('custom dimensions match the actual stored dimensions and label', () => {
  const size = { label:'Small', length:10, width:20, height:30, unit:'cm' };
  assert.deepEqual(resolveSelection({ sizeData:{ type:'custom', customDimensions:[size] } }, {selectedSize:size}).selectedSize, size);
  assert.throws(() => resolveSelection({sizeData:{type:'custom',customDimensions:[size]}}, {selectedSize:{...size,width:999}}), /dimensions/);
});
test('colours persist on products, shipments and planned items without changing financial fields', () => {
  assert.deepEqual(new Product({availableColors:['Blue']}).availableColors.toObject(), ['Blue']);
  const item = {product:'000000000000000000000001',name:'Shirt',image:'https://fixture.invalid/photo',price:200,quantity:1,selectedSize:'M',selectedColor:'Blue'};
  const shipment = new Shipment({items:[item]});
  assert.equal(shipment.items[0].selectedColor,'Blue'); assert.equal(shipment.items[0].price,200);
  const group = new GroupOrder({members:[{items:[item]}]});
  assert.equal(group.members[0].items[0].selectedColor,'Blue');
});
test('colour-specific reservations cannot silently use aggregate holds', () => {
  assert.throws(() => inventory.normalizeAllocations([{product:'000000000000000000000001',quantity:1,selectedColor:'Blue'}], {hold:true}), /not supported/);
});

test('legacy reservation identities remain byte-compatible; coloured lines remain distinct', () => {
  const { normalizeAllocations } = require('../services/deliveryReservationService');
  const product='000000000000000000000001';
  assert.deepEqual(normalizeAllocations([{product,quantity:1}]),[{product,offer:null,variantId:null,selectedSize:'',quantity:1}]);
  const colors=normalizeAllocations([{product,quantity:1,selectedColor:'Black'},{product,quantity:1,selectedColor:'Blue'}]);
  assert.equal(colors.length,2);
});
