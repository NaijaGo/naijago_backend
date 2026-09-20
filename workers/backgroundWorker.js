require('dotenv').config();
const mongoose = require('mongoose');
const BackgroundJob = require('../models/BackgroundJob');
const MediaAsset = require('../models/MediaAsset');
const Product = require('../models/Product');
const cloudinary = require('../utils/cloudinary');
const { createBackgroundJobService, createJobRunner } = require('../services/backgroundJobService');
const { createMediaCleanupService } = require('../services/mediaCleanupService');
const { createMediaRevocationService } = require('../services/mediaRevocationService');
const { createExploreNotificationService } = require('../services/exploreNotificationService');
const { CarouselSlide } = require('../models/CarouselSlide');

async function main() {
    if (process.env.BACKGROUND_JOBS_ENABLED !== 'true') throw new Error('BACKGROUND_JOBS_ENABLED must be true to start this worker.');
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required.');
    await mongoose.connect(process.env.MONGO_URI);
    await BackgroundJob.createCollection();
    await BackgroundJob.createIndexes(); // Required even when autoIndex is disabled.
    if (process.env.EXPLORE_ENABLED === 'true' && !await require('../services/exploreRuntime').ready()) {
        throw new Error('Explore indexes are not ready.');
    }
    const allowedTypes = process.env.MEDIA_CLEANUP_ENABLED === 'true' ? ['media.cleanup'] : [];
    if (process.env.EXPLORE_ENABLED === 'true') allowedTypes.push('explore.notify');
    if (process.env.PRODUCT_VIDEO_ENABLED === 'true') allowedTypes.push('media.revoke');
    const queue = createBackgroundJobService({ Job: BackgroundJob, allowedTypes });
    const media = createMediaCleanupService({ MediaAsset, Product, CarouselSlide, cloudinary, queue });
    const revocation = createMediaRevocationService({ MediaAsset, cloudinary, queue });
    const notify = createExploreNotificationService({ User: require('../models/User'), UserBlock: require('../models/UserBlock'),
        FeedComment: require('../models/FeedComment'), explore: require('../services/exploreRuntime').explore,
        notifications: require('../services/notificationService') });
    const runner = createJobRunner({ queue, handlers: { 'media.cleanup': media.cleanup, 'media.revoke': revocation.revoke, 'explore.notify': notify } });
    let scheduling = false;
    let lastScheduledAt = 0;
    let lastRevocationScan = 0;
    async function tick() {
        if (scheduling || runner.busy) return;
        scheduling = true;
        try {
            if (allowedTypes.includes('media.revoke') && Date.now() - lastRevocationScan > 15000) {
                await revocation.schedule(); lastRevocationScan = Date.now();
            }
            if (allowedTypes.includes('media.cleanup') && Date.now() - lastScheduledAt > 3600000) {
                await media.schedule(); lastScheduledAt = Date.now();
            }
            await runner.tick();
        } catch (_) { console.error('Background worker tick unavailable; it will retry.'); }
        finally { scheduling = false; }
    }
    const interval = setInterval(tick, 5000);
    async function stop() {
        clearInterval(interval);
        runner.stop();
        // In-flight provider calls have a 30s timeout; lease recovery handles a
        // forced process stop. Never mark work completed just because we exit.
        await mongoose.disconnect();
    }
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    console.log('Durable background worker started. Enabled types:', allowedTypes.join(', ') || 'none');
    await tick();
}
main().catch(() => { console.error('Background worker startup failed. Check database and worker configuration.'); process.exitCode = 1; });
