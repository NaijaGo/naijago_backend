// Explicit operator operation only. Never imported from application startup.
async function setupAppleAuth(db, { apply = false, replacePhoneIndex = false } = {}) {
  const hello = await db.admin().command({ hello: 1 });
  if (hello.maxWireVersion < 13 || (!hello.setName && hello.msg !== 'isdbgrid')) {
    throw new Error('Apple auth requires MongoDB 5+ with transactions. No writes started.');
  }
  const collections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  if (!collections.has('users')) throw new Error('Existing users collection required.');
  const indexes = await db.collection('users').listIndexes().toArray();
  const existingEmail = indexes.some(i => i.unique && !i.sparse && !i.partialFilterExpression && JSON.stringify(i.key) === '{"email":1}');
  if (indexes.some(i => i.name === 'user_phone_string_unique' && JSON.stringify(i.key) !== '{"phoneNumber":1}')) {
    throw new Error('Phone index name conflicts; no changes started.');
  }
  const phone = indexes.filter(i => JSON.stringify(i.key) === '{"phoneNumber":1}');
  const duplicates = await db.collection('users').aggregate([
    { $match: { phoneNumber: { $type: 'string' } } }, { $group: { _id: '$phoneNumber', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }, { $count: 'groups' },
  ]).toArray();
  if (duplicates.length) throw new Error('Duplicate phone numbers require separate investigation. No writes started.');
  const emailDuplicates = await db.collection('users').aggregate([
    { $match: { email: { $type: 'string' } } }, { $group: { _id: '$email', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }, { $count: 'groups' },
  ]).toArray();
  if (emailDuplicates.length) throw new Error('Duplicate emails require separate investigation. No writes started.');
  if (collections.has('appleauthchallenges')) {
    const challengeIndexes = await db.collection('appleauthchallenges').listIndexes().toArray();
    if (challengeIndexes.some(i => i.name === 'apple_challenge_expiry' &&
        (JSON.stringify(i.key) !== '{"expiresAt":1}' || i.expireAfterSeconds !== 0))) {
      throw new Error('Challenge expiry index conflicts; no changes started.');
    }
  }
  const legacy = phone.filter(i => !i.partialFilterExpression);
  if (phone.some(i => !i.unique || i.sparse || (i.partialFilterExpression && JSON.stringify(i.partialFilterExpression) !== '{"phoneNumber":{"$type":"string"}}'))) {
    throw new Error('Unexpected phone index definition; no changes started.');
  }
  const plan = { mode: apply ? 'apply' : 'dry-run', createCollections: ['appleidentities', 'appleauthchallenges'].filter(c => !collections.has(c)),
    createPhoneIndex: 'user_phone_string_unique', replaceLegacyPhoneIndexes: legacy.map(i => i.name),
    createEmailIndex: !existingEmail,
    userDataWrites: false, expiryIndex: 'apple_challenge_expiry' };
  if (apply) {
    if (legacy.length && !replacePhoneIndex) throw new Error('Phone index replacement requires explicit approval and --replace-phone-index.');
    // Build the replacement before dropping legacy indexes: populated phone
    // numbers remain uniquely protected even if an operation fails halfway.
    await db.collection('users').createIndex({ phoneNumber: 1 }, { unique: true, name: 'user_phone_string_unique', partialFilterExpression: { phoneNumber: { $type: 'string' } } });
    if (!existingEmail) await db.collection('users').createIndex({ email: 1 }, { unique: true, name: 'email_1' });
    for (const i of legacy) await db.collection('users').dropIndex(i.name);
    for (const c of plan.createCollections) await db.createCollection(c);
    await db.collection('appleauthchallenges').createIndex({ expiresAt: 1 }, { name: 'apple_challenge_expiry', expireAfterSeconds: 0 });
  }
  return plan;
}
async function main() {
  const args = process.argv.slice(2), database = args.find(a => a.startsWith('--database='))?.slice(11);
  const uri = process.env.APPLE_AUTH_SETUP_MONGO_URI;
  if (!uri || !/^[\w-]+$/.test(database || '')) throw new Error('Explicit setup connection and database required.');
  const apply = args.includes('--apply');
  if (apply && !args.includes(`--confirm-database=${database}`)) throw new Error('Confirm the exact database before applying.');
  const { MongoClient } = require('mongoose').mongo;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  try { await client.connect(); console.log(JSON.stringify(await setupAppleAuth(client.db(database), { apply, replacePhoneIndex: args.includes('--replace-phone-index') }), null, 2)); }
  finally { await client.close(); }
}
if (require.main === module) main().catch(() => { console.error('Apple auth setup stopped. Check the explicit database identity and proposed indexes.'); process.exitCode = 1; });
module.exports = { setupAppleAuth };
