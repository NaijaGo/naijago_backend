// Safe Render Shell diagnostic. Never creates indexes, jobs or published images.
const zlib = require('node:zlib');
const { createImageRefinementService } = require('../services/imageRefinementService');
const { inspectFeatureReadiness } = require('../services/adminFeatureReadiness');
const { imageBytes, MAX_BYTES } = require('../utils/imageRefinementPolicy');

function sampleImage() {
  // Synthetic fixture only: white canvas and a blue rectangle, not customer data.
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(256, 0); header.writeUInt32BE(256, 4);
  header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(256 * (1 + 256 * 3), 255);
  for (let y = 0; y < 256; y++) {
    const offset = y * 769; pixels[offset] = 0;
    for (let x = 75; y >= 50 && y < 205 && x < 180; x++) {
      const pixel = offset + 1 + x * 3; pixels[pixel] = 20; pixels[pixel + 1] = 80; pixels[pixel + 2] = 190;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function diagnose({ env = process.env, databaseReadOnly = false, probe = false, http = require('axios') } = {}) {
  const config = createImageRefinementService({ env }).configuration();
  const report = { configuration: { ...config, ready: !config.missingConfiguration.length && !config.keyModeMismatch },
    database: { status: 'NOT_RUN' }, photoroom: { status: 'NOT_RUN' },
    worker: { status: 'NOT_VERIFIED', command: config.workerCommand } };
  if (databaseReadOnly) {
    const uri = env.INVENTORY_TEST_MONGO_URI || env.MONGO_URI;
    if (!uri) report.database = { status: 'BLOCKED', reason: 'Database URI unavailable. Do not share its value.' };
    else {
      const mongoose = require('mongoose');
      // Raw driver avoids application model initialization and automatic indexes.
      const client = new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
      try {
        await client.connect();
        const db = client.db(), hello = await db.admin().command({ hello: 1 });
        const models = [require('../models/ImageRefinement'), require('../models/BackgroundJob'), require('../models/AiUsageBucket')]
          .map(model => ({ schema: model.schema, collection: db.collection(model.collection.collectionName) }));
        const readiness = await inspectFeatureReadiness({ models });
        const transactionCapable = Boolean(hello.setName || hello.msg === 'isdbgrid');
        report.database = { status: readiness.ready && transactionCapable ? 'PASS' : 'BLOCKED', transactionCapable,
          indexChecks: readiness.checks, transactionsExecuted: false };
      } catch (_) { report.database = { status: 'BLOCKED', reason: 'Database connection/read unavailable. No writes attempted.' }; }
      finally { await client.close().catch(() => {}); }
    }
  }
  if (probe) {
    if (!env.PHOTOROOM_API_KEY || env.PHOTOROOM_SANDBOX !== 'true') {
      report.photoroom = { status: 'BLOCKED', reason: 'A configured key and PHOTOROOM_SANDBOX=true are required. Live probing is refused.' };
    } else {
      try {
        const form = new FormData();
        form.append('imageFile', new Blob([sampleImage()], { type: 'image/png' }), 'diagnostic.png');
        for (const [name, value] of Object.entries({ removeBackground: 'true', 'background.color': 'FFFFFF',
          outputSize: '1000x1000', padding: '0.15', 'shadow.mode': 'ai.soft', 'export.format': 'png' })) form.append(name, value);
        const key = String(env.PHOTOROOM_API_KEY).trim();
        const response = await http.post('https://image-api.photoroom.com/v2/edit', form, {
          headers: { 'x-api-key': key.startsWith('sandbox_') ? key : `sandbox_${key}` },
          timeout: 45000, maxRedirects: 0, responseType: 'arraybuffer', maxContentLength: MAX_BYTES,
        });
        const mime = String(response.headers?.['content-type'] || '').split(';')[0];
        const bytes = imageBytes(Buffer.from(response.data), mime);
        report.photoroom = { status: 'PASS', mode: 'sandbox', httpStatus: response.status, bytes: bytes.length,
          note: 'Synthetic image processed. Product quality, Cloudinary storage and publication are not verified.' };
      } catch (error) {
        report.photoroom = { status: 'FAIL', mode: 'sandbox',
          ...(Number.isInteger(error.response?.status) ? { httpStatus: error.response.status } : {}),
          reason: 'Sandbox request failed, timed out or returned an invalid image. No raw provider error or key is printed.' };
      }
    }
  }
  return report;
}

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const args = process.argv.slice(2);
  if (args.some(arg => !['--database-read-only', '--probe'].includes(arg))) {
    console.error('Usage: node scripts/diagnoseImageRefinement.js [--database-read-only] [--probe]'); process.exitCode = 1;
  } else diagnose({ databaseReadOnly: args.includes('--database-read-only'), probe: args.includes('--probe') })
    .then(report => {
      console.log(JSON.stringify(report, null, 2));
      if (!report.configuration.ready || report.database.status === 'BLOCKED' || ['FAIL', 'BLOCKED'].includes(report.photoroom.status)) process.exitCode = 1;
    }).catch(() => { console.error('Diagnostic unavailable. No secrets printed or production writes attempted.'); process.exitCode = 1; });
}
module.exports = { diagnose };
