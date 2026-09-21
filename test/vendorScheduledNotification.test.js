'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function service() {
    const file = path.join(__dirname, '../services/vendorOrderNotificationService.js'), module = { exports: {} };
    const forbidden = new Proxy({}, { get() { return () => { throw new Error('Database/provider access forbidden in this test.'); }; } });
    vm.runInThisContext('(function(require,module,exports){\n' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(
        () => forbidden, module, module.exports);
    return module.exports;
}
test('scheduled vendor message shows WAT delivery window and does not demand immediate preparation', () => {
    const { buildVendorOrderMessage } = service();
    const order = { _id: 'synthetic-order', isPaid: true, schedule: { mode: 'scheduled', startAt: '2100-01-01T11:00:00Z', endAt: '2100-01-01T13:00:00Z' } };
    const shipment = { _id: 'synthetic-shipment', items: [], fulfillmentMethod: 'delivery' };
    const message = buildVendorOrderMessage({ order, shipment });
    assert.match(message, /Scheduled delivery window \(WAT\)/);
    assert.match(message, /12:00/); assert.match(message, /02:00/);
    assert.doesNotMatch(message, /start preparing this order/);
    assert.match(buildVendorOrderMessage({ order: { ...order, schedule: undefined }, shipment }), /start preparing this order/);
});
test('unpaid and review orders cannot send vendor preparation notifications', async () => {
    const { notifyVendorOfPaidShipment } = service();
    for (const order of [{ isPaid: false }, { isPaid: true, mainOrderStatus: 'payment_review' },
        { isPaid: true, paymentResult: { fulfillmentStatus: 'needs_attention' } }]) {
        await notifyVendorOfPaidShipment({ order, shipment: { vendor: 'synthetic-vendor' } });
    }
});
