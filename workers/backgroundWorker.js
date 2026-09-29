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
            if (types.includes('image.refine') && !await require('../services/imageRefinementRuntime').ready()) {
                throw new Error('Image refinement indexes are not ready.');
            }
            if (types.includes('request.notify') && !await require('../services/productRequestRuntime').ready()) {
                throw new Error('Product request indexes are not ready.');
            }
            if (types.includes('explore.notify') && !await require('../services/exploreRuntime').ready()) {
                throw new Error('Explore indexes are not ready.');
            }
            if (types.includes('group.notify') && !await require('../services/plannedOrderRuntime').ready()) {
                throw new Error('Planned order indexes are not ready.');
            }
        },
        createRuntime: (allowedTypes) => {
            const queue = createBackgroundJobService({ Job: BackgroundJob, allowedTypes });
            const media = createMediaCleanupService({ MediaAsset, Product, CarouselSlide, cloudinary, queue });
            const revocation = createMediaRevocationService({ MediaAsset, cloudinary, queue });
            const handlers = {};
            const planning = allowedTypes.includes('group.notify')
                ? require('../services/plannedOrderRuntime').lifecycle()
                : null;
            const refinement = allowedTypes.includes('image.refine') ? require('../services/imageRefinementRuntime') : null;
            if (refinement) Object.assign(handlers, refinement.handlers());
            if (allowedTypes.includes('request.notify')) Object.assign(handlers, require('../services/productRequestRuntime').handlers());
            if (allowedTypes.includes('media.cleanup')) handlers['media.cleanup'] = media.cleanup;
            if (allowedTypes.includes('media.revoke')) handlers['media.revoke'] = revocation.revoke;
            if (allowedTypes.includes('explore.notify')) {
                handlers['explore.notify'] = createExploreNotificationService({ User: require('../models/User'),
                    UserBlock: require('../models/UserBlock'), FeedComment: require('../models/FeedComment'),
                    explore: require('../services/exploreRuntime').explore, notifications: require('../services/notificationService') });
            }
            if (planning) {
                const { createPlanningNotificationService } = require('../services/planningNotificationService');
                const notifyPlanning = createPlanningNotificationService({
                    Group: require('../models/GroupOrder'),
                    Occurrence: require('../models/RecurringOccurrence'),
                    User: require('../models/User'),
                    notifications: require('../services/notificationService'),
                });
                handlers['group.notify'] = notifyPlanning;
                handlers['recurring.notify'] = notifyPlanning;
            }
            return { runner: createJobRunner({ queue, handlers }),
                schedule: createWorkerSchedule({ allowedTypes, media, revocation,
                    refinement: refinement?.service, planning }) };
        },
    });
}
if (require.main === module) main().catch((error) => {
    console.error('Background worker startup failed. Check database, indexes and enabled worker handlers.');
    if (error.forceExit) process.exit(1);
    else process.exitCode = 1;
});
module.exports = { main };
