const assert = require('node:assert/strict');
const { createRiderAgreementService, contentHash } = require('../../services/riderAgreementService');
const { createRiderDailyBonusService } = require('../../services/riderDailyBonusService');
const ids = { rider: '640000000000000000000001', other: '640000000000000000000002',
  admin: '640000000000000000000003', agreement: '640000000000000000000004' };
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$and') return value.every(item => matches(row, item));
    if (key === '$or') return value.some(item => matches(row, item));
    const actual = key.split('.').reduce((item, field) => item?.[field], row);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.entries(value).every(([op, expected]) => {
        if (op === '$in') return expected.some(v => String(v) === String(actual));
        if (op === '$nin') return !expected.some(v => String(v) === String(actual));
        if (op === '$ne') return String(actual) !== String(expected);
        if (op === '$lt') return actual < expected;
        if (op === '$gte') return actual >= expected;
        throw new Error(`Unsupported fixture comparison: ${op}`);
      });
    }
    return String(actual) === String(value);
  });
}
function fixture({ configured = true, enforcement = true } = {}) {
  let serial = 10, time = new Date('2026-10-13T10:00:00.000Z'), tail = Promise.resolve();
  const state = { agreements: [], policies: [], acceptances: [], riders: [
    { _id: ids.rider, status: 'approved', isAvailable: true, isActive: true, activeDeliveries: 0, walletBalance: 10, totalEarnings: 10 },
    { _id: ids.other, status: 'approved', isAvailable: true, isActive: true, activeDeliveries: 0, walletBalance: 0, totalEarnings: 0 },
  ], bonuses: [], orders: [], shipments: [] };
  const reads = [], writes = [];
  let fail = '', readyFailure = false;
  function query(name, run) {
    let sort, limit;
    const result = { select() { return this; }, populate() { return this; }, session(session) { reads.push({ name, session }); return this; },
      lean() { return this; }, sort(value) { sort = value; return this; }, limit(value) { limit = value; return this; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        if (fail === name) throw new Error('Fixture database unavailable');
        let value = run();
        if (Array.isArray(value)) {
          if (sort) { const [field, direction] = Object.entries(sort)[0]; value = [...value].sort((a, b) => (a[field] > b[field] ? direction : -direction)); }
          if (limit) value = value.slice(0, limit);
        }
        return structuredClone(value);
      }).then(resolve, reject); } };
    return result;
  }
  function model(name) {
    function apply(row, update, inserted) {
      if (inserted) Object.assign(row, structuredClone(update.$setOnInsert || {}));
      Object.assign(row, structuredClone(update.$set || {}));
      for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value;
      for (const key of Object.keys(update.$unset || {})) delete row[key];
      for (const [key, value] of Object.entries(update.$push || {})) (row[key] ||= []).push(structuredClone(value));
    }
    return {
      find(filter = {}) { return query(name, () => state[name].filter(row => matches(row, filter))); },
      findById(id) { return this.findOne({ _id: String(id) }); },
      findOne(filter) { return query(name, () => state[name].find(row => matches(row, filter)) || null); },
      distinct(field, filter) { return query(name, () => [...new Set(state[name].filter(row => matches(row, filter)).map(row => row[field]))]); },
      async create(body) {
        if (fail === name) throw new Error('Fixture write failed');
        if (name === 'agreements' && state[name].some(row => row.version === body.version)) throw Object.assign(new Error('duplicate'), { code: 11000 });
        const row = { _id: String(serial++).padStart(24, '0'), __v: 0, ...structuredClone(body) };
        state[name].push(row); writes.push({ name, body }); return structuredClone(row);
      },
      findByIdAndUpdate(id, update, options) { return this.findOneAndUpdate({ _id: String(id) }, update, options); },
      findOneAndUpdate(filter, update, options = {}) {
        return query(name, () => {
          let row = state[name].find(candidate => matches(candidate, filter));
          const inserted = !row;
          if (!row && !options.upsert) return null;
          if (!row) { row = { _id: String(serial++).padStart(24, '0'), ...structuredClone(filter) }; state[name].push(row); }
          apply(row, update, inserted); writes.push({ name, filter, update, options }); return row;
        });
      },
      updateMany(filter, update, options = {}) {
        return query(name, () => { let count = 0; for (const row of state[name]) if (matches(row, filter)) { apply(row, update, false); count++; }
          writes.push({ name, filter, update, options }); return { modifiedCount: count }; });
      },
    };
  }
  const Agreement = model('agreements'), Policy = model('policies'), Acceptance = model('acceptances'),
    Rider = model('riders'), Bonus = model('bonuses'), MainOrder = model('orders'), Shipment = model('shipments');
  async function transact(action) {
    const previous = tail;
    let finish; tail = new Promise(resolve => { finish = resolve; });
    await previous;
    const snapshot = structuredClone(state);
    const session = { fixtureTransaction: true };
    try { return await action(session); }
    catch (error) { for (const key of Object.keys(state)) state[key] = snapshot[key]; throw error; }
    finally { finish(); }
  }
  const ready = async () => { if (readyFailure) throw new Error('Fixture index missing'); };
  const agreements = createRiderAgreementService({ Agreement, Policy, Acceptance, Rider, MainOrder, Shipment, transact, ready, now: () => time,
    enforcementEnabled: () => enforcement });
  const bonuses = createRiderDailyBonusService({ Bonus, MainOrder, Rider, transact, ready, now: () => time });
  state.policies.push({ _id: 'rider-partnership', agreementId: configured ? ids.agreement : null, revision: 0, fence: 0, history: [] });
  state.agreements.push({ _id: ids.agreement, __v: 0, version: '1.0', content: 'Full fixture agreement\nAll paragraphs remain visible.',
    contentHash: contentHash('Full fixture agreement\nAll paragraphs remain visible.'), status: 'published',
    publishedAt: time, effectiveAt: time, publishedBy: ids.admin, createdBy: ids.admin });
  const acceptance = () => ({ agreementId: ids.agreement, version: '1.0', contentHash: state.agreements[0].contentHash, accepted: true });
  function complete(count = 20) {
    for (let i = 0; i < count; i++) state.orders.push({ _id: String(100 + i).padStart(24, '0'), rider: ids.rider,
      isPaid: true, isDelivered: true, mainOrderStatus: 'delivered', deliveredAt: time });
  }
  return { state, reads, writes, agreements, bonuses, models: { Agreement, Policy, Acceptance, Rider, Bonus, MainOrder, Shipment },
    acceptance, complete, setEnforcement: value => { enforcement = value; }, setTime: date => { time = date; }, fail: name => { fail = name; }, failReady: () => { readyFailure = true; },
    assertTransactionWrites: () => writes.filter(row => row.options).forEach(row => assert.ok(row.options.session || row.name === 'riders')) };
}
module.exports = { fixture, ids };
