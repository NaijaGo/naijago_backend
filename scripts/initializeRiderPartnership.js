// Explicit setup only. Never read .env/MONGO_URI or run during startup.
const SPECS = [
  { name: 'rideragreements', indexes: [[{ version: 1 }, { unique: true, name: 'agreement_version_unique' }]] },
  { name: 'rideragreementpolicies', indexes: [] },
  { name: 'rideragreementacceptances', indexes: [
    [{ riderId: 1, version: 1 }, { unique: true, name: 'rider_version_unique' }],
    [{ agreementId: 1, riderId: 1 }, { name: 'agreement_riders' }],
  ] },
  { name: 'riderdailybonuses', indexes: [
    [{ riderId: 1, day: 1 }, { unique: true, name: 'rider_bonus_day_unique' }],
    [{ state: 1, requestedAt: -1 }, { name: 'pending_bonus_review' }],
  ] },
];
async function initializeRiderPartnership(db, { apply = false } = {}) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(row => row.name));
  const plan = [];
  for (const spec of SPECS) {
    const indexes = existing.has(spec.name) ? await db.collection(spec.name).listIndexes().toArray() : [];
    for (const [keys, options] of spec.indexes) {
      const same = indexes.find(index => index.name === options.name);
      if (same && (JSON.stringify(same.key) !== JSON.stringify(keys) || !!same.unique !== !!options.unique)) {
        throw new Error('An existing partnership index conflicts with the required definition. No writes were started.');
      }
    }
    plan.push({ collection: spec.name, missing: !existing.has(spec.name), indexes: spec.indexes.map(([, options]) => options.name) });
  }
  if (apply) {
    for (const spec of SPECS) {
      if (!existing.has(spec.name)) await db.createCollection(spec.name);
      for (const [keys, options] of spec.indexes) await db.collection(spec.name).createIndex(keys, options);
    }
    await db.collection('rideragreementpolicies').updateOne({ _id: 'rider-partnership' }, {
      $setOnInsert: { agreementId: null, revision: 0, fence: 0, history: [] },
    }, { upsert: true });
    if (existing.has('mainorders')) await db.collection('mainorders').createIndex(
      { rider: 1, isDelivered: 1, deliveredAt: 1 }, { name: 'rider_daily_bonus_completion' });
  }
  return { mode: apply ? 'apply' : 'dry-run', plan, publishesAgreement: false, creditsWallets: false };
}
async function main() {
  const args = process.argv.slice(2);
  const database = args.find(arg => arg.startsWith('--database='))?.slice(11);
  const uri = process.env.RIDER_PARTNERSHIP_SETUP_MONGO_URI;
  if (!uri || !database || !/^[\w-]+$/.test(database)) throw new Error('Provide RIDER_PARTNERSHIP_SETUP_MONGO_URI and --database=<explicit database>.');
  const apply = args.includes('--apply');
  if (apply && !args.includes(`--confirm-database=${database}`)) throw new Error('Apply requires --confirm-database matching the selected database.');
  const mongoose = require('mongoose');
  try {
    await mongoose.connect(uri, { dbName: database, autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await initializeRiderPartnership(mongoose.connection.db, { apply }), null, 2));
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(() => { console.error('Partnership setup failed. Check explicit database identity, indexes and permissions. No agreement is published by setup.'); process.exitCode = 1; });
module.exports = { initializeRiderPartnership, SPECS };
