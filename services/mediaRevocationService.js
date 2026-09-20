const crypto = require('node:crypto');
const permanent = (code) => Object.assign(new Error('Video access revocation requires review.'), { jobCode: code, retryable: false });

function beginVideoRevocation(asset, now = new Date()) {
    const token = crypto.randomUUID();
    return { token, state: 'pending', fromPublicId: asset.publicId,
        toPublicId: `naijago/product_videos/${asset.owner}/revoked-${token}`, requestedAt: now };
}
function createMediaRevocationService({ MediaAsset, cloudinary, queue, now = () => new Date() }) {
    async function schedule() {
        const rows = await MediaAsset.find({ status: 'rejected', 'revocation.state': 'pending',
            'revocation.queuedAt': { $exists: false } }).select('_id owner revocation.token').sort({ _id: 1 }).limit(50).lean();
        for (const row of rows) {
            await queue.enqueue({ type: 'media.revoke', dedupeKey: `${row._id}:${row.revocation.token}`, owner: row.owner,
                payload: { assetId: String(row._id), token: row.revocation.token }, priority: 10 });
            await MediaAsset.updateOne({ _id: row._id, 'revocation.token': row.revocation.token },
                { $set: { 'revocation.queuedAt': now() } });
        }
        return rows.length;
    }
    async function revoke({ assetId, token }, { signal }) {
        signal.throwIfAborted();
        if (!/^[a-f0-9]{24}$/i.test(assetId) || !/^[a-f0-9-]{36}$/i.test(token)) throw permanent('invalid_revocation');
        const asset = await MediaAsset.findOne({ _id: assetId, status: 'rejected', 'revocation.token': token }).lean();
        if (!asset || asset.revocation.state === 'completed') return { skipped: 'already_revoked_or_changed' };
        if (asset.revocation.state !== 'pending') throw permanent('invalid_revocation_state');
        const { fromPublicId, toPublicId } = asset.revocation;
        const prefix = `naijago/product_videos/${asset.owner}/`;
        if (!fromPublicId?.startsWith(prefix) || !toPublicId?.startsWith(prefix) || fromPublicId !== asset.publicId ||
            toPublicId !== `${prefix}revoked-${token}` || fromPublicId.includes('..')) throw permanent('invalid_media_path');
        let resource;
        // A previous worker may have renamed the file before losing its DB lease.
        try { resource = await cloudinary.api.resource(toPublicId, { resource_type: 'video', type: 'authenticated', timeout: 30000 }); }
        catch (error) { if (error.http_code !== 404 && error.error?.http_code !== 404) throw error; }
        signal.throwIfAborted();
        if (!resource) {
            resource = await cloudinary.uploader.rename(fromPublicId, toPublicId, {
                resource_type: 'video', type: 'authenticated', overwrite: false, invalidate: true, timeout: 30000,
            });
        }
        if (resource.public_id !== toPublicId || resource.resource_type !== 'video' || resource.type !== 'authenticated' ||
            !Number.isFinite(resource.version)) throw permanent('revocation_metadata_invalid');
        signal.throwIfAborted();
        const saved = await MediaAsset.updateOne({ _id: asset._id, status: 'rejected', 'revocation.token': token, 'revocation.state': 'pending' },
            { $set: { publicId: toPublicId, version: resource.version, 'revocation.state': 'completed', 'revocation.completedAt': now() }, $inc: { __v: 1 } });
        if (!saved.matchedCount) throw permanent('revocation_record_changed');
        return { revoked: true, assetId, invalidationRequested: true };
    }
    return { schedule, revoke };
}
module.exports = { createMediaRevocationService, beginVideoRevocation };
