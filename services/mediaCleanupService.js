const crypto = require('node:crypto');

// Only invalid/never-completed uploads are eligible. Approved and pending-review
// assets are deliberately excluded: removal from a form is not deletion authority.
function createMediaCleanupService({ MediaAsset, Product, CarouselSlide, cloudinary, queue, now = () => new Date() }) {
    const purposes = CarouselSlide ? ['product_video', 'campaign_video'] : ['product_video'];
    async function schedule() {
        const cutoff = new Date(now().getTime() - 7 * 24 * 60 * 60 * 1000);
        const assets = await MediaAsset.find({ purpose: { $in: purposes },
            status: { $in: ['invalid', 'pending_upload', 'abandoned'] },
            uploadExpiresAt: { $lt: cutoff }, cleanedAt: { $exists: false },
            cleanupQueuedAt: { $exists: false },
        }).select('_id owner').limit(50).lean();
        for (const asset of assets) {
            await queue.enqueue({ type: 'media.cleanup', dedupeKey: String(asset._id), owner: asset.owner,
                payload: { assetId: String(asset._id) } });
            await MediaAsset.updateOne({ _id: asset._id }, { $set: { cleanupQueuedAt: now() } });
        }
        return assets.length;
    }
    async function cleanup({ assetId }, { signal }) {
        signal.throwIfAborted();
        if (!/^[a-f0-9]{24}$/i.test(assetId)) throw Object.assign(new Error('Invalid media ID.'), { retryable: false, jobCode: 'invalid_media_id' });
        const cutoff = new Date(now().getTime() - 7 * 24 * 60 * 60 * 1000);
        if (await Product.exists({ videoAssetId: assetId })) return { skipped: 'attached_to_product' };
        if (CarouselSlide && await CarouselSlide.exists({ videoAssetId: assetId })) return { skipped: 'attached_to_campaign' };
        const asset = await MediaAsset.findOneAndUpdate({ _id: assetId, purpose: { $in: purposes },
            status: { $in: ['invalid', 'pending_upload', 'abandoned'] }, uploadExpiresAt: { $lt: cutoff }, cleanedAt: { $exists: false },
        }, { $set: { status: 'abandoned' } }, { new: true });
        if (!asset) return { skipped: 'not_eligible' };
        const prefix = `naijago/product_videos/${asset.owner}/`;
        if (!asset.publicId.startsWith(prefix)) throw Object.assign(new Error('Invalid owned path.'), { retryable: false, jobCode: 'invalid_media_path' });
        signal.throwIfAborted();
        const result = await cloudinary.uploader.destroy(asset.publicId, { resource_type: 'video', type: 'authenticated', invalidate: true, timeout: 30000 });
        if (!['ok', 'not found'].includes(result.result)) throw Object.assign(new Error('Deletion not confirmed.'), { jobCode: 'media_cleanup_unconfirmed' });
        await MediaAsset.updateOne({ _id: asset._id, status: 'abandoned' }, { $set: { cleanedAt: now(), cleanupReceipt: crypto.createHash('sha256').update(asset.publicId).digest('hex') } });
        return { cleaned: true, assetId };
    }
    return { schedule, cleanup };
}
module.exports = { createMediaCleanupService };
