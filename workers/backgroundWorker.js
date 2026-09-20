const { startManagedWorker, createWorkerSchedule } = require('../services/backgroundWorkerLifecycle');

async function main() {
    // Importing this module in a test must not load live settings or start work.
    require('dotenv').config();
    const mongoose = require('mongoose');
    const BackgroundJob = require('../models/BackgroundJob');
    const MediaAsset = require('../models/MediaAsset');
    const Product = require('../models/Product');
    const cloudinary = require('../utils/cloudinary');
    const { CarouselSlide } = require('../models/CarouselSlide');
    const { createBackgroundJobService, createJobRunner } = require('../services/backgroundJobService');
    const { createMediaCleanupService } = require('../services/mediaCleanupService');
    const { createMediaRevocationService } = require('../services/mediaRevocationService');
    const { createExploreNotificationService } = require('../services/exploreNotificationService');
    return startManagedWorker({ env: process.env, db: mongoose,
        ensureIndexes: async (types) => {
            await BackgroundJob.createCollection();
            await BackgroundJob.createIndexes();
            if (types.includes('explore.notify') && !await require('../services/exploreRuntime').ready()) {
                throw new Error('Explore indexes are not ready.');
            }
        },
        createRuntime: (allowedTypes) => {
            const queue = createBackgroundJobService({ Job: BackgroundJob, allowedTypes });
            const media = createMediaCleanupService({ MediaAsset, Product, CarouselSlide, cloudinary, queue });
            const revocation = createMediaRevocationService({ MediaAsset, cloudinary, queue });
            const handlers = {};
            if (allowedTypes.includes('media.cleanup')) handlers['media.cleanup'] = media.cleanup;
            if (allowedTypes.includes('media.revoke')) handlers['media.revoke'] = revocation.revoke;
            if (allowedTypes.includes('explore.notify')) {
                handlers['explore.notify'] = createExploreNotificationService({ User: require('../models/User'),
                    UserBlock: require('../models/UserBlock'), FeedComment: require('../models/FeedComment'),
                    explore: require('../services/exploreRuntime').explore, notifications: require('../services/notificationService') });
            }
            return { runner: createJobRunner({ queue, handlers }),
                schedule: createWorkerSchedule({ allowedTypes, media, revocation }) };
        },
    });
}
if (require.main === module) main().catch((error) => {
    console.error('Background worker startup failed. Check database, indexes and enabled worker handlers.');
    if (error.forceExit) process.exit(1);
    else process.exitCode = 1;
});
module.exports = { main };
