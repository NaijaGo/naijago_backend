const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Dependency-injected local fixtures: no application bootstrap, .env loading,
// database connection or provider network client is permitted by this loader.
function loadWithFixtures(relativeFile, dependencies) {
  const filename = path.resolve(__dirname, '../..', relativeFile);
  const source = fs.readFileSync(filename, 'utf8');
  const module = {exports: {}};
  const localRequire = id => {
    if (!Object.hasOwn(dependencies, id)) throw new Error('Unexpected fixture dependency: ' + id);
    return dependencies[id];
  };
  const wrapper = vm.runInThisContext(`(function(require, module, exports) {\n${source}\n})`, {filename});
  wrapper(localRequire, module, module.exports);
  return module.exports;
}
async function withKoraEnvironment(work, overrides = {}) {
  const values = {NODE_ENV: 'test', KORAPAY_MODE: 'test', KORAPAY_SECRET_KEY: 'sk_test_local_fixture_only',
    KORAPAY_PUBLIC_KEY: 'pk_test_local_fixture_only', KORAPAY_NOTIFICATION_URL: 'https://example.com/kora-webhook',
    KORAPAY_REDIRECT_URL: '', KORAPAY_CHANNELS: 'bank_transfer,card', KORAPAY_PAYOUTS_ENABLED: 'true', ...overrides};
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try {return await work();} finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
const get = (object, key) => key.split('.').reduce((value, name) => value?.[name], object);
function matches(document, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some(option => matches(document, option));
    const actual = get(document, key);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('$elemMatch' in value) return Array.isArray(actual) && actual.some(item => matches(item, value.$elemMatch));
      if ('$exists' in value) return (actual !== undefined) === value.$exists;
      if ('$in' in value) return value.$in.some(item => item === actual || item === null && actual === undefined);
      if ('$lt' in value) return actual != null && new Date(actual) < value.$lt;
    }
    return actual === value;
  });
}
function applyUpdate(document, update, query) {
  // Mongo resolves the positional array element once, before applying fields.
  const positional = new Map(Object.entries(query).filter(([, value]) => value?.$elemMatch)
    .map(([key, value]) => [key, document[key].find(item => matches(item, value.$elemMatch))]));
  for (const [operation, changes] of Object.entries(update)) for (const [key, value] of Object.entries(changes)) {
    const names = key.split('.'); let target = document;
    for (let index = 0; index < names.length - 1; index++) {
      const name = names[index];
      if (names[index + 1] === '$') {
        target = positional.get(name); index++;
      } else {target[name] ??= {}; target = target[name];}
    }
    if (operation === '$unset') delete target[names.at(-1)];
    else target[names.at(-1)] = value;
  }
}
function query(value) {return {select() {return this;}, session() {return this;},
  then(resolve, reject) {return Promise.resolve(value).then(resolve, reject);}};}
function memoryModel(documents, events) {
  return {
    findById: id => query(documents.find(document => document._id === id) || null),
    findOne: search => query(documents.find(document => matches(document, search)) || null),
    findOneAndUpdate: async (search, update) => {
      const document = documents.find(item => matches(item, search));
      if (!document) return null;
      applyUpdate(document, update, search); events.push('atomic-update'); return document;
    },
    updateOne: async (search, update) => {
      const document = documents.find(item => matches(item, search));
      if (document) applyUpdate(document, update, search);
      return {modifiedCount: document ? 1 : 0};
    },
    aggregate: async pipeline => {
      const array = Object.keys(pipeline[0].$match)[0];
      return documents.flatMap(document => (document[array] || []).filter(record => record.provider === 'korapay'
        && record.status === 'pending' && record.dispatchState !== 'awaiting_approval').map(records => ({records})));
    },
  };
}
function payoutFixture({rider = false, status = 'processing', timeout = false, verification = {}} = {}) {
  const events = [];
  const user = {_id: 'fixture-owner', firstName: 'Local', lastName: 'Fixture', email: 'fixture@example.com',
    role: 'user', isVendor: true, vendorWalletBalance: 1000, userWalletBalance: 500, walletBalance: 500,
    pendingEarnings: 0, totalWithdrawn: 0, otp: '123456', otpExpires: new Date(Date.now() + 60000),
    vendorWithdrawals: [], userWithdrawals: [], withdrawalHistory: [],
    bankAccount: {bankName: 'Fixture Bank', bankCode: '044', accountNumber: '0000000000', accountName: 'Local Fixture'},
    save: async () => {events.push('save');}, markModified: () => {}, canWithdraw: amount => user.walletBalance >= amount && amount >= 100};
  const User = memoryModel(rider ? [] : [user], events), Rider = memoryModel(rider ? [user] : [], events);
  const metrics = {transfers: 0, verifications: 0, sessions: 0};
  const mongoose = {startSession: async () => {metrics.sessions++; return {
    withTransaction: async work => {
      const saved = JSON.parse(JSON.stringify(user));
      try {const result = await work(); events.push('commit'); return result;}
      catch (error) {for (const key of Object.keys(saved)) user[key] = saved[key]; throw error;}
    }, endSession: async () => {},
  };}};
  const provider = {
    getKoraConfig: () => ({mode: 'test'}), getKoraCheckoutConfig: () => ({mode: 'test'}),
    listKoraBanks: async () => [{name: 'Fixture Bank', code: '044'}],
    initiateKoraTransfer: async args => {metrics.transfers++; events.push('provider-post');
      if (!events.includes('commit')) throw new Error('Provider called before debit committed');
      if (timeout) throw new Error('Fixture transport timeout');
      return {status: true, data: {reference: args.reference, status: 'processing'}};},
    verifyKoraTransfer: async ({transactionRef}) => {
      metrics.verifications++;
      const record = [...user.vendorWithdrawals, ...user.userWithdrawals, ...user.withdrawalHistory].find(item => item.reference === transactionRef);
      if (verification.notFound) return {status: false, data: null};
      return {status: true, data: {reference: transactionRef, currency: 'NGN', amount: record.amount, status, ...verification}};
    },
  };
  const service = loadWithFixtures('services/koraPayoutService.js', {
    'node:crypto': require('node:crypto'), mongoose, '../models/User': User, '../models/Rider': Rider,
    './koraPaymentService': provider, '../utils/koraPayment': require('../../utils/koraPayment'),
  });
  return {service, user, metrics, events};
}
module.exports = {loadWithFixtures, withKoraEnvironment, memoryModel, payoutFixture};
