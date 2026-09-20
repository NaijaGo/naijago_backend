'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Test-only loader for the ACTUAL existing quote and order creator. Every model
// comes from the isolated harness; live integrations/default connections cannot
// be imported or called. No listener, dotenv, production worker or server boot.
function loadCheckoutForTests({ models, connection }) {
    for (const name of ['MainOrder', 'Shipment', 'Product', 'ProductOffer', 'User', 'AppSetting']) {
        if (!models[name] || models[name].db !== connection) throw new Error('Checkout tests require models on the isolated connection.');
    }
    const file = path.join(__dirname, '../../routes/orderRoutes.js'), actualRequire = createRequire(file), module = { exports: {} };
    const forbidden = () => { throw new Error('Live integration is forbidden in checkout tests.'); };
    const blocked = new Proxy({}, { get: () => forbidden });
    const pure = new Set(['express', 'crypto', '../services/checkoutCatalogService', '../services/checkoutInventoryService',
        '../utils/checkoutQuoteSnapshot', '../utils/flutterwavePayment', '../utils/squadPayment',
        '../utils/orderPlanningPolicy', '../utils/deliveryScheduleAvailability']);
    function safeRequire(name) {
        if (pure.has(name)) return actualRequire(name);
        if (name === 'mongoose') return { startSession: () => connection.startSession() };
        if (name.startsWith('../models/')) return models[name.split('/').pop()] || blocked;
        if (name === '../middleware/authMiddleware') return { protect: forbidden, authorizeRoles: () => forbidden };
        if (name === '../services/deliveryFeeService') return { getDeliveryFeeSettings: async () => ({}),
            buildDeliveryFeeQuote: () => ({ amount: 500, source: 'isolated-test', zone: null }) };
        if (name === '../services/analyticsService') return { trackAnalyticsEvent: forbidden };
        if (name === 'axios' || name.startsWith('../services/')) return blocked;
        throw new Error('Unregistered checkout test dependency.');
    }
    vm.runInThisContext('(function(require, module, exports, console) {\n' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(
        safeRequire, module, module.exports, { log() {}, error() {} });
    return { calculateCheckoutSummary: module.exports.calculateCheckoutSummary, createUnpaidOrder: module.exports.createUnpaidOrder };
}
module.exports = { loadCheckoutForTests };
