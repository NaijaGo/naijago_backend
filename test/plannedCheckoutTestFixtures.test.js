'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const User = require('../models/User');
const { plannedCheckoutUsers } = require('../scripts/lib/plannedCheckoutTestFixtures');
const fixtures = () => plannedCheckoutUsers({ owner: new Types.ObjectId(), seller: new Types.ObjectId() });

test('exact planned checkout user fixtures pass real schema validation without a database', async () => {
    const rows = fixtures();
    assert.equal(rows.length, 2);
    for (const row of rows) {
        await new User(row).validate();
        assert.match(row.email, /@example\.invalid$/);
    }
    assert.notEqual(String(rows[0]._id), String(rows[1]._id));
    assert.equal(rows[0].isVendor, undefined);
    assert.equal(rows[1].isVendor, true);
    assert.equal(rows[1].vendorStatus, 'approved');
    assert.deepEqual(rows[1].businessLocation, { latitude: 9, longitude: 7, formattedAddress: 'Synthetic shop only' });
});

test('planned checkout fixtures have distinct values for every actual unique User index', () => {
    const rows = fixtures().map((row) => new User(row));
    const indexes = User.schema.indexes().filter(([, options]) => options.unique);
    assert.ok(indexes.some(([fields]) => fields.email === 1));
    assert.ok(indexes.some(([fields]) => fields.phoneNumber === 1));
    for (const [fields, options] of indexes) {
        const seen = new Set();
        for (const row of rows) {
            const values = Object.keys(fields).map((name) => row.get(name));
            if (options.sparse && values.every((value) => value === undefined)) continue;
            assert.ok(values.every((value) => value != null && value !== ''), `Missing unique index field: ${Object.keys(fields)}`);
            const key = JSON.stringify(values);
            assert.ok(!seen.has(key), `Duplicate synthetic index key: ${Object.keys(fields)}`);
            seen.add(key);
        }
    }
});

test('missing email and phone are rejected by schema validation before fixture insertion', async () => {
    for (const field of ['email', 'phoneNumber']) {
        const row = fixtures()[0]; delete row[field];
        await assert.rejects(new User(row).validate(), (error) => error.errors[field]?.kind === 'required');
    }
});
