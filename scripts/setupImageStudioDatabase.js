// Explicit operator CLI. Importing this module never provisions metadata.
const { setup, definitions } = require('../services/imageStudioDatabaseSetup');

function argumentsFor(args) {
  let apply = false, database;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && !apply) apply = true;
    else if (args[i] === '--database' && !database && args[i + 1] && !args[i + 1].startsWith('--')) database = args[++i];
    else throw new Error('Invalid arguments');
  }
  if (apply && !database) throw new Error('Database confirmation required');
  return { apply, database };
}

async function main(args = process.argv.slice(2), env = process.env) {
  const options = argumentsFor(args);
  if (!env.MONGO_URI) throw new Error('MONGO_URI required');
  const { MongoClient } = require('mongoose').mongo;
  const client = new MongoClient(env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    // Never switch databases based on CLI input: it must confirm the existing URI.
    const report = await setup({ db: client.db(), ...options });
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'BLOCKED') process.exitCode = 1;
  } finally { await client.close(); }
}
if (require.main === module) {
  require('dotenv').config({ quiet: true });
  main().catch(() => {
    console.error('Image Studio setup failed or was refused. Usage: node scripts/setupImageStudioDatabase.js [--apply --database EXACT_DATABASE_NAME]. No credentials or raw database errors printed. Metadata changes may be partial; inspect before retrying.');
    process.exitCode = 1;
  });
}
module.exports = { setup, definitions, argumentsFor };
