const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { createCommissionService, rateForProduct, buildPayload, validateChanges } = require('../services/vendorCommissionService');
const { manifest } = require('../services/catalogTaxonomyService');
const { getCommissionRateForCategory } = require('../utils/vendorCommissionRates');
const { createVendorCommissionRouter } = require('../routes/vendorCommissionRoutes');
const AppSetting = require('../models/AppSetting');
const fashion = manifest.categories.find(p => p.label === 'Fashion');
const home = manifest.categories.find(p => p.label === 'Home & Office');
const beauty = manifest.categories.find(p => p.label === 'Cosmetics & Beauty');
const restaurant = manifest.categories.find(p => p.label === 'Restaurant');
const groceries = manifest.categories.find(p => p.label === 'Groceries');
const actor = '68b6d6a5249ec462b92f4bd6';
const body = (percentage = 9.5, revision = 0) => ({ revision, reason: 'Updated vendor agreement', changes: [{ categoryId: fashion.id, percentage }] });
function fixture(initial = null) {
    let saved = initial ? structuredClone(initial) : null;
    const writes = [], reads = [];
    const query = run => ({ select() { return this; }, session(session) { reads.push(session); return this; }, lean() { return this; }, then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); } });
    const Setting = {
        findOne(filter) { assert.equal(filter.key, 'vendor_category_commissions'); return query(() => saved && structuredClone(saved)); },
        findOneAndUpdate(filter, update, options) {
            writes.push({ filter, update, options });
            return query(() => {
                const revision = saved?.commissionRevision || 0;
                const matches = filter.commissionRevision === undefined ? revision === 0 : filter.commissionRevision === revision;
                if (!matches) return null;
                saved = { ...(saved || {}), ...structuredClone(update.$set), commissionRevision: revision + update.$inc.commissionRevision,
                    vendorCommissionHistory: [...(saved?.vendorCommissionHistory || []), ...structuredClone(update.$push.vendorCommissionHistory.$each)].slice(-100), updatedAt: new Date() };
                return structuredClone(saved);
            });
        },
    };
    return { service: createCommissionService({ Setting }), writes, reads, saved: () => saved };
}
test('all 23 categories are returned, no initialization write on an empty database', async () => {
    const f = fixture(); const result = await f.service.getSettings();
    assert.equal(result.categories.length, 23); assert.equal(result.categories.reduce((n, row) => n + row.subcategoryCount, 0), 186);
    assert.deepEqual(result.categories.map(row => row.label), manifest.categories.map(row => row.label));
    assert.equal(result.revision, 0); assert.equal(f.writes.length, 0);
});
test('without overrides every parent/child retains the exact legacy commission calculation', () => {
    for (const parent of manifest.categories) for (const category of [parent.label, ...parent.children.map(child => `${parent.label} > ${child.label}`)]) {
        assert.equal(rateForProduct(category, '', {}), getCommissionRateForCategory(category));
    }
    for (const category of ['', null, 'Unknown', 'Health & Beauty', 'Animal Products', 'Fragrance', 'Restaurant > Drinks', 'Food & Beverage > Restaurant Equipment']) {
        assert.equal(rateForProduct(category, '', {}), getCommissionRateForCategory(category));
    }
});
test('configured parent applies to combined and separate subcategories, including aliases', () => {
    const overrides = { [beauty.id]: 8.25, [home.id]: 4, [groceries.id]: 0 };
    assert.equal(rateForProduct('Health & Beauty', 'Medicine', overrides), 0.0825);
    assert.equal(rateForProduct('Cosmetics & Beauty > Medicine', '', overrides), 0.0825);
    assert.equal(rateForProduct('Home & Office > Appliances', '', overrides), 0.04);
    assert.equal(rateForProduct('Supermarket', 'Fresh Produce', overrides), 0);
    assert.equal(rateForProduct('Fashion', "Men's Fashion", overrides), 0.12);
});
test('invalid category evidence never selects a configured override', () => {
    assert.equal(rateForProduct('Fashion', 'Medicine', { [fashion.id]: 1 }), 0.12);
    assert.equal(rateForProduct('Unknown', 'Drinks', { [restaurant.id]: 1 }), 0.08);
});
test('food commission overrides change fees only; shared restriction policy is unchanged', () => {
    const policy = require('../utils/categoryPolicy');
    const food = { category: 'Restaurant', subcategory: 'Meals' };
    const medicine = { category: 'Cosmetics & Beauty', subcategory: 'Medicine' };
    assert.equal(rateForProduct(food.category, food.subcategory, { [restaurant.id]: 10 }), 0.10);
    assert.equal(policy.isRestaurantCategory(food), true); assert.equal(policy.isMedicineProduct(medicine), true);
});
test('validation rejects unknown IDs, child IDs, duplicates, strings and unsafe percentages', () => {
    for (const percentage of [-1, 101, NaN, Infinity, '10', true, 1.234, undefined]) assert.throws(() => validateChanges({ ...body(), changes: [{ categoryId: fashion.id, percentage }] }), /Commission/);
    for (const categoryId of ['bad', beauty.children[0].id]) assert.throws(() => validateChanges({ ...body(), changes: [{ categoryId, percentage: 10 }] }), /category ID/);
    assert.throws(() => validateChanges({ ...body(), changes: [body().changes[0], body().changes[0]] }), /only once/);
    assert.throws(() => validateChanges({ ...body(), revision: -1 }), /Refresh/);
    assert.throws(() => validateChanges({ ...body(), reason: 'x' }), /reason/);
    for (const percentage of [0, 100, 9.99, null]) assert.doesNotThrow(() => validateChanges(body(percentage)));
});
test('saved changes record reason, actor, previous and new rates, with optimistic revision', async () => {
    const f = fixture(); const result = await f.service.updateSettings(body(), actor);
    assert.equal(result.revision, 1); assert.equal(result.categories.find(row => row.categoryId === fashion.id).overridePercentage, 9.5);
    assert.equal(result.history[0].changedBy, actor); assert.equal(result.history[0].changes[0].previousPercentage, null);
    assert.equal(result.history[0].changes[0].newPercentage, 9.5); assert.equal(result.history[0].reason, body().reason);
    assert.equal(f.writes[0].options.runValidators, true); assert.equal(f.writes[0].update.$push.vendorCommissionHistory.$slice, -100);
    assert.equal(f.writes[0].filter.key, 'vendor_category_commissions');
});
test('clearing an override restores defaults without replacing unrelated category rates', async () => {
    const f = fixture({ commissionRevision: 2, vendorCommissionRates: [{ categoryId: fashion.id, percentage: 8 }, { categoryId: beauty.id, percentage: 7 }] });
    const result = await f.service.updateSettings(body(null, 2), actor);
    assert.equal(result.categories.find(row => row.categoryId === fashion.id).overridePercentage, null);
    assert.equal((await f.service.getOverrides())[beauty.id], 7);
    assert.equal(rateForProduct('Fashion', '', await f.service.getOverrides()), 0.12);
});
test('no-op, invalid or stale submissions do not write', async () => {
    const f = fixture(); await f.service.updateSettings(body(null), actor); assert.equal(f.writes.length, 0);
    await assert.rejects(f.service.updateSettings(body(4, 2), actor), error => error.statusCode === 409);
    await assert.rejects(f.service.updateSettings(body(101), actor), error => error.statusCode === 400);
    await assert.rejects(f.service.updateSettings(body(), null), error => error.statusCode === 403);
    assert.equal(f.writes.length, 0);
});
test('lost update and simultaneous first save surface HTTP 409', async () => {
    const f = fixture(); const result = await Promise.allSettled([f.service.updateSettings(body(8), actor), f.service.updateSettings(body(9), actor)]);
    assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(result.find(row => row.status === 'rejected').reason.statusCode, 409);
    const duplicate = createCommissionService({ Setting: { findOne() { return { select() { return this; }, lean: async () => null }; }, findOneAndUpdate() { return { lean: async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); } }; } } });
    await assert.rejects(duplicate.updateSettings(body(), actor), error => error.statusCode === 409);
});
test('malformed saved overrides fail safely rather than charging an arbitrary rate', () => {
    for (const entries of [[{ categoryId: fashion.id, percentage: 101 }], [{ categoryId: 'unknown', percentage: 10 }], [{ categoryId: fashion.id, percentage: 10 }, { categoryId: fashion.id, percentage: 11 }]]) {
        assert.throws(() => buildPayload({ vendorCommissionRates: entries }), error => error.statusCode === 503);
    }
});
test('checkout settings read uses the order transaction session and never writes', async () => {
    const f = fixture(); const session = { fixture: true }; assert.deepEqual(await f.service.getOverrides(session), {});
    assert.deepEqual(f.reads, [session]); assert.equal(f.writes.length, 0);
});
const orderSource = fs.readFileSync(path.join(__dirname, '../routes/orderRoutes.js'), 'utf8');
const start = orderSource.indexOf('const calculateItemCommission = (');
const end = orderSource.indexOf('\n};', start);
const calculateItemCommission = vm.runInNewContext(`(${orderSource.slice(start, end + 3).replace('const calculateItemCommission = ', '').replace(/;$/, '')})`, { rateForProduct });
test('actual checkout settings loader forwards the transaction and attaches one override snapshot', async () => {
    const calls = []; const session = { fixture: true };
    const begin = orderSource.indexOf('const getCostLowCommissionConfig = async (');
    const finish = orderSource.indexOf('\n};', begin);
    const loader = vm.runInNewContext(`(${orderSource.slice(begin, finish + 3).replace('const getCostLowCommissionConfig = ', '').replace(/;$/, '')})`, {
        AppSetting: { findOne(filter) {
            assert.equal(filter.key, 'cost_low_store');
            return { select() { return this; }, lean() { return this; }, session(value) { calls.push(value); return this; },
                then(resolve) { return Promise.resolve({ costLowStore: { vendorId: 'cost-low', commissionKoboPerUnit: 5700 } }).then(resolve); } };
        } },
        getVendorCommissionOverrides: async value => { calls.push(value); return { [fashion.id]: 9 }; },
    });
    const result = await loader(session);
    assert.equal(result.categoryOverrides[fashion.id], 9); assert.equal(result.commissionKoboPerUnit, 5700);
    assert.deepEqual(calls, [session, session]);
});
test('actual legacy public commission response retains keys and adds all main category rates', async () => {
    const marker = "router.get('/commission-rates', async (req, res) => {";
    const begin = orderSource.indexOf(marker); const finish = orderSource.indexOf('\n    // router.get(', begin);
    const handler = vm.runInNewContext(`(${orderSource.slice(begin, finish).trim().replace("router.get('/commission-rates', ", '').replace(/\);$/, '')})`, {
        CATEGORY_COMMISSION_RATES: require('../utils/vendorCommissionRates').CATEGORY_COMMISSION_RATES,
        getVendorCommissionOverrides: async () => ({ [fashion.id]: 9, [groceries.id]: 0 }), rateForProduct,
        require: name => { assert.equal(name, '../config/catalogTaxonomy.json'); return manifest; }, console,
    });
    let response; await handler({}, { json(value) { response = value; } });
    assert.equal(response.success, true); assert.equal(response.defaultRate, 0.08);
    assert.equal(response.commissionStructure.Fashion.rate, 9); assert.equal(response.commissionStructure.Groceries.rateDecimal, 0);
    for (const parent of manifest.categories) assert.ok(response.commissionStructure[parent.label]);
    for (const label of Object.keys(require('../utils/vendorCommissionRates').CATEGORY_COMMISSION_RATES)) assert.ok(response.commissionStructure[label]);
    assert.equal(response.history, undefined);
});
test('route errors hide internal exceptions and retain safe validation errors', async () => {
    for (const failure of [new Error('fixture-internal-error'), Object.assign(new Error('Safe configuration error'), { statusCode: 503 })]) {
        const router = createVendorCommissionRouter({ settingsService: { getSettings: async () => { throw failure; } } });
        let code, response; await router.stack[0].route.stack[0].handle({}, { status(value) { code = value; return this; }, json(value) { response = value; } });
        assert.equal(code, failure.statusCode || 500); assert.doesNotMatch(response.message, /fixture-internal-error/);
    }
});
test('actual item calculation uses percentage overrides and preserves Cost Low fixed fees', () => {
    const config = { vendorId: 'cost-low', commissionKoboPerUnit: 5700, categoryOverrides: { [fashion.id]: 0, [restaurant.id]: 20 } };
    const base = { sellerType: 'vendor', sellerId: 'normal', itemSubtotal: 2000, quantity: 2, category: 'Restaurant', subcategory: 'Meals', costLowConfig: config };
    const result = calculateItemCommission(base); assert.equal(result.itemCommission, 400); assert.equal(result.commissionRate, 0.2);
    assert.equal(calculateItemCommission({ ...base, category: 'Fashion', subcategory: '' }).itemCommission, 0);
    const fixed = calculateItemCommission({ ...base, sellerId: 'cost-low' }); assert.equal(fixed.itemCommission, 114); assert.equal(fixed.commissionType, 'fixed_per_unit');
    assert.equal(calculateItemCommission({ ...base, sellerId: 'cost-low', sellerType: 'admin' }).itemCommission, 300);
});
test('both checkout paths pass authoritative product classification; persisted shipment snapshots remain', () => {
    assert.equal((orderSource.match(/subcategory: product\.subcategory,\s+costLowConfig,/g) || []).length, 2);
    assert.match(orderSource, /const categoryOverrides = await getVendorCommissionOverrides\(session\)/);
    assert.match(orderSource, /commissionRate: item\.commissionRate/);
    assert.match(orderSource, /itemCommission: item\.itemCommission/);
});
test('new fields validate entirely in memory on the existing settings schema', () => {
    const model = new AppSetting({ key: 'vendor_category_commissions', commissionRevision: 1, vendorCommissionRates: [{ categoryId: fashion.id, percentage: 0 }],
        vendorCommissionHistory: [{ changedBy: actor, changedAt: new Date(), reason: 'Test update', changes: [{ categoryId: fashion.id, label: fashion.label, previousPercentage: null, newPercentage: 0 }] }] });
    assert.equal(model.validateSync(), undefined);
    const invalid = new AppSetting({ key: 'vendor_category_commissions', vendorCommissionRates: [{ categoryId: fashion.id, percentage: 101 }] });
    assert.ok(invalid.validateSync());
});
test('actual admin guard protects commission route; mocked HTTP responds 200/400/401/403/409', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/adminRoutes.js'), 'utf8');
    assert.match(source, /router\.use\('\/commission-settings', protect, authorizeAdmin,/);
    const begin = source.indexOf('const authorizeAdmin = ('); const finish = source.indexOf('\n};', begin);
    const authorizeAdmin = vm.runInNewContext(`(${source.slice(begin, finish + 3).replace('const authorizeAdmin = ', '').replace(/;$/, '')})`);
    const f = fixture(); const app = express(); app.use(express.json());
    app.use('/api/admin/commission-settings', (req, res, next) => {
        if (!req.headers.authorization) return res.status(401).json({ message: 'Unauthenticated fixture' });
        req.user = { _id: actor, isAdmin: req.headers.authorization === 'Bearer admin-fixture' }; next();
    }, authorizeAdmin, createVendorCommissionRouter({ settingsService: f.service }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/admin/commission-settings`;
    const headers = { Authorization: 'Bearer admin-fixture', 'Content-Type': 'application/json' };
    try {
        assert.equal((await fetch(url)).status, 401);
        assert.equal((await fetch(url, { headers: { Authorization: 'Bearer vendor-fixture' } })).status, 403);
        assert.equal((await fetch(url, { headers })).status, 200);
        assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body(200)) })).status, 400);
        assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body()) })).status, 200);
        assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body(8)) })).status, 409);
        assert.equal(f.writes.length, 1);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
