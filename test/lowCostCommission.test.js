const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createLowCostCommissionService, feeToKobo, payload } = require('../services/lowCostCommissionService');
const { createVendorCommissionRouter } = require('../routes/vendorCommissionRoutes');
const SettingModel = require('../models/AppSetting');
const vendorId = '69301d2e1e0bda27c09bcbc2';
const actor = '68b6d6a5249ec462b92f4bd6';
const body = (feePerItem = 60.25, revision = 0) => ({ feePerItem, revision, vendorId, reason: 'Revised store agreement' });
function fixture(initial = { costLowStore: { vendorId, commissionKoboPerUnit: 5700 } }, approved = true) {
    let saved = initial && structuredClone(initial); let beforeUpdate = () => {};
    const writes = [], reads = [];
    const query = run => ({ select() { return this; }, lean() { return this; }, then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); } });
    const Setting = {
        findOne(filter) { assert.equal(filter.key, 'cost_low_store'); reads.push(filter); return query(() => saved && structuredClone(saved)); },
        findOneAndUpdate(filter, update, options) {
            writes.push({ filter, update, options });
            return query(() => {
                beforeUpdate();
                const values = { 'costLowStore.vendorId': saved?.costLowStore?.vendorId,
                    'costLowStore.commissionKoboPerUnit': saved?.costLowStore?.commissionKoboPerUnit,
                    costLowCommissionRevision: saved?.costLowCommissionRevision };
                if (!saved || Object.entries(values).some(([key, value]) => typeof filter[key] === 'object' && filter[key] !== null
                    ? value !== undefined : filter[key] === null ? value != null : value !== filter[key])) return null;
                saved = { ...saved, costLowStore: { ...saved.costLowStore, commissionKoboPerUnit: update.$set['costLowStore.commissionKoboPerUnit'] },
                    updatedBy: update.$set.updatedBy, costLowCommissionRevision: (saved.costLowCommissionRevision || 0) + 1,
                    costLowCommissionHistory: [...(saved.costLowCommissionHistory || []), ...structuredClone(update.$push.costLowCommissionHistory.$each)].slice(-100) };
                return structuredClone(saved);
            });
        },
    };
    const Vendor = { findById(id) { assert.equal(String(id), saved.costLowStore.vendorId); return query(() => ({ _id: id, businessName: 'Low Cost World fixture', isVendor: true, vendorStatus: approved ? 'approved' : 'suspended' })); } };
    return { service: createLowCostCommissionService({ Setting, Vendor }), writes, reads, saved: () => saved,
        onUpdate: callback => { beforeUpdate = () => callback(saved); } };
}
test('unconfigured store uses documented default without initializing or searching for vendors', async () => {
    const f = fixture(null); const data = await f.service.getSettings();
    assert.equal(data.feePerItem, 57); assert.equal(data.source, 'default'); assert.equal(data.configured, false); assert.equal(f.writes.length, 0);
});
test('configured store returns saved zero and fractional-naira fees without changing them', async () => {
    for (const fee of [0, 5700, 6025]) {
        const f = fixture({ costLowStore: { vendorId, commissionKoboPerUnit: fee } }); const data = await f.service.getSettings();
        assert.equal(data.feePerItem, fee / 100); assert.equal(data.configured, true); assert.equal(data.vendorId, vendorId); assert.equal(f.writes.length, 0);
    }
});
test('input validation accepts naira cents and rejects malformed, negative, fractional-kobo and unsafe fees', () => {
    for (const [fee, expected] of [[0, 0], [0.29, 29], [57, 5700], [60.25, 6025]]) assert.equal(feeToKobo(fee), expected);
    for (const fee of ['57', undefined, null, true, -1, NaN, Infinity, 0.001, 0.000000009, Number.MAX_SAFE_INTEGER, {}, Symbol('test')]) assert.throws(() => feeToKobo(fee), error => error.statusCode === 400);
});
test('save changes only the commission, converts naira to kobo, and audits administrator and reason', async () => {
    const f = fixture({ costLowStore: { vendorId, commissionKoboPerUnit: 5700 }, unrelatedField: 'retained' });
    const data = await f.service.updateSettings(body(), actor);
    assert.equal(data.feePerItem, 60.25); assert.equal(data.revision, 1); assert.equal(f.saved().costLowStore.vendorId, vendorId);
    assert.equal(f.saved().unrelatedField, 'retained'); assert.deepEqual(Object.keys(f.writes[0].update.$set), ['costLowStore.commissionKoboPerUnit', 'updatedBy']);
    assert.equal(f.writes[0].options.upsert, false); assert.equal(f.writes[0].options.runValidators, true);
    assert.equal(data.history[0].previousKoboPerUnit, 5700); assert.equal(data.history[0].newKoboPerUnit, 6025);
    assert.equal(data.history[0].changedBy, actor); assert.equal(data.history[0].reason, body().reason);
});
test('missing and null legacy fees retain their default until explicitly updated', async () => {
    for (const costLowStore of [{ vendorId }, { vendorId, commissionKoboPerUnit: null }]) {
        const f = fixture({ costLowStore }); assert.equal((await f.service.getSettings()).feePerItem, 57);
        assert.equal((await f.service.updateSettings(body(65), actor)).feePerItem, 65);
    }
});
test('unchanged fee, invalid fee, missing actor and invalid reason never write', async () => {
    const f = fixture(); await f.service.updateSettings(body(57), actor);
    await assert.rejects(f.service.updateSettings(body(-1), actor), error => error.statusCode === 400);
    await assert.rejects(f.service.updateSettings({ ...body(), reason: 'x' }, actor), error => error.statusCode === 400);
    await assert.rejects(f.service.updateSettings(body(), null), error => error.statusCode === 403);
    assert.equal(f.writes.length, 0);
});
test('unlinked or suspended vendors cannot have their fixed commission changed', async () => {
    for (const f of [fixture(null), fixture(undefined, false)]) {
        await assert.rejects(f.service.updateSettings(body(), actor), error => error.statusCode === 409); assert.equal(f.writes.length, 0);
    }
});
test('caller cannot retarget the store, modify category rates, or override the existing vendor binding', async () => {
    const f = fixture(); await assert.rejects(f.service.updateSettings({ ...body(), vendorId: actor }, actor), error => error.statusCode === 409);
    await f.service.updateSettings({ ...body(), categoryRates: [{ percentage: 100 }], approved: true }, actor);
    assert.equal(f.saved().costLowStore.vendorId, vendorId); assert.equal(f.saved().categoryRates, undefined);
});
test('stale fee revisions, concurrent edits and concurrent store relinking fail with 409', async () => {
    const f = fixture(); await assert.rejects(f.service.updateSettings(body(60, 4), actor), error => error.statusCode === 409);
    const results = await Promise.allSettled([f.service.updateSettings(body(60), actor), f.service.updateSettings(body(65), actor)]);
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(results.find(row => row.status === 'rejected').reason.statusCode, 409);
    const relink = fixture(); relink.onUpdate(saved => { saved.costLowStore.vendorId = actor; });
    await assert.rejects(relink.service.updateSettings(body(), actor), error => error.statusCode === 409);
    assert.equal(relink.saved().costLowStore.commissionKoboPerUnit, 5700);
});
test('corrupt stored fees and revisions are reported safely', () => {
    for (const fee of [-1, 0.1, Infinity, '5700']) assert.throws(() => payload({ costLowStore: { commissionKoboPerUnit: fee } }), error => error.statusCode === 503);
    assert.throws(() => payload({ costLowCommissionRevision: -1 }), error => error.statusCode === 503);
    assert.throws(() => payload({ costLowCommissionRevision: null }), error => error.statusCode === 503);
});
test('actual checkout uses the edited fixed commission times quantity and preserves saved snapshots', async () => {
    const f = fixture(); await f.service.updateSettings(body(60.25), actor);
    const source = fs.readFileSync(path.join(__dirname, '../routes/orderRoutes.js'), 'utf8');
    const begin = source.indexOf('const calculateItemCommission = ('); const end = source.indexOf('\n};', begin);
    const calculate = vm.runInNewContext(`(${source.slice(begin, end + 3).replace('const calculateItemCommission = ', '').replace(/;$/, '')})`, { rateForProduct: () => 0.12 });
    const savedOrder = { commissionKoboPerUnit: 5700, itemCommission: 114 };
    const config = { vendorId, commissionKoboPerUnit: f.saved().costLowStore.commissionKoboPerUnit, categoryOverrides: {} };
    const result = calculate({ sellerType: 'vendor', sellerId: vendorId, itemSubtotal: 1000, quantity: 2, category: 'Fashion', costLowConfig: config });
    assert.equal(result.itemCommission, 120.5); assert.equal(result.commissionType, 'fixed_per_unit');
    assert.deepEqual(savedOrder, { commissionKoboPerUnit: 5700, itemCommission: 114 });
    assert.equal(calculate({ sellerType: 'vendor', sellerId: actor, itemSubtotal: 1000, quantity: 2, category: 'Fashion', costLowConfig: config }).itemCommission, 120);
    assert.match(source, /commissionKoboPerUnit: item\.commissionKoboPerUnit/);
});
test('new optional audit fields validate in memory on the existing settings model', () => {
    const settings = new SettingModel({ key: 'cost_low_store', costLowStore: { vendorId, commissionKoboPerUnit: 6000 }, costLowCommissionRevision: 1,
        costLowCommissionHistory: [{ vendorId, previousKoboPerUnit: 5700, newKoboPerUnit: 6000, changedBy: actor, changedAt: new Date(), reason: 'Store fee revision' }] });
    assert.equal(settings.validateSync(), undefined);
});
test('actual fee routes return expected statuses and are mounted behind existing admin protection', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/adminRoutes.js'), 'utf8');
    assert.match(source, /router\.use\('\/commission-settings', protect, authorizeAdmin,/);
    const f = fixture(); const router = createVendorCommissionRouter({ lowCostSettingsService: f.service });
    const handle = router.stack.find(layer => layer.route?.path === '/low-cost-world' && layer.route.methods.put).route.stack[0].handle;
    async function submit(input, identity = actor) { let status = 200, data; await handle({ body: input, user: { _id: identity } }, {
        status(value) { status = value; return this; }, json(value) { data = value; return this; } }); return { status, data }; }
    assert.equal((await submit(body(-1))).status, 400); assert.equal((await submit(body(60, 2))).status, 409);
    assert.equal((await submit(body(), null)).status, 403); const result = await submit(body()); assert.equal(result.status, 200); assert.equal(result.data.feePerItem, 60.25);
});
