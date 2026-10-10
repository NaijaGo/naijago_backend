const { RequestInputError } = require('../utils/productRequestPolicy');

function createConceptImageAdapter({ generate, cloudinary, now = () => new Date() }) {
    const path = (requestId, generation) => {
        if (!/^[a-f0-9]{24}$/i.test(String(requestId)) || !Number.isInteger(generation) || generation < 1 || generation > 3) throw new RequestInputError('Invalid concept identity.');
        return `naijago/request_concepts/${requestId}/preview-${generation}`;
    };
    const receipt = (asset, publicId) => {
        if (asset?.public_id !== publicId || asset?.type !== 'authenticated' || asset?.resource_type !== 'image' || !['jpg', 'jpeg', 'png', 'webp'].includes(asset?.format)) throw new Error('Unconfirmed concept storage.');
        return { publicId, format: asset.format };
    };
    async function recover(requestId, generation) {
        const publicId = path(requestId, generation);
        try { return receipt(await cloudinary.api.resource(publicId, { resource_type: 'image', type: 'authenticated', timeout: 20000 }), publicId); }
        catch (error) { if (error.http_code === 404 || error.error?.http_code === 404) return null; throw error; }
    }
    async function create({ requestId, generation, query, signal }) {
        signal.throwIfAborted();
        // No automatic provider retry: acceptance may occur before a timeout.
        const image = await generate({ prompt: query, signal, attempts: 1, concept: true });
        signal.throwIfAborted();
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType) || typeof image.data !== 'string' ||
            image.data.length > 14 * 1024 * 1024 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(image.data)) throw new Error('Invalid concept image.');
        const bytes = Buffer.from(image.data, 'base64');
        const valid = image.mimeType === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 : image.mimeType === 'image/png'
            ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
        if (!valid || bytes.length > 10 * 1024 * 1024) throw new Error('Invalid concept image.');
        const publicId = path(requestId, generation);
        const asset = await cloudinary.uploader.upload(`data:${image.mimeType};base64,${image.data}`, {
            public_id: publicId, resource_type: 'image', type: 'authenticated', overwrite: false, timeout: 30000,
        });
        signal.throwIfAborted();
        return { ...receipt(asset, publicId), model: image.model };
    }
    function url(preview) {
        if (!/^naijago\/request_concepts\/[a-f0-9]{24}\/preview-[123]$/i.test(preview.publicId || '') || !['jpg', 'jpeg', 'png', 'webp'].includes(preview.format)) return null;
        return cloudinary.utils.private_download_url(preview.publicId, preview.format, {
            type: 'authenticated', resource_type: 'image', expires_at: Math.floor(now().getTime() / 1000) + 300, attachment: false,
        });
    }
    return { create, recover, url };
}

function createRequestPreviewWorker({ Request, images, enabled, now = () => new Date() }) {
    return async ({ requestId, generation }, { job, signal }) => {
        signal.throwIfAborted();
        const filter = { _id: requestId, state: { $ne: 'cancelled' }, 'preview.generation': generation, 'preview.job': job._id };
        const row = await Request.findOne(filter).lean();
        if (!row || row.preview.state === 'ready') return { skipped: 'obsolete_or_ready' };
        const finish = async (state, result = {}) => {
            signal.throwIfAborted();
            await Request.updateOne(filter, { $set: { 'preview.state': state, 'preview.finishedAt': now(),
                ...Object.fromEntries(Object.entries(result).map(([key, value]) => [`preview.${key}`, value])) } });
            return { state };
        };
        if (!enabled()) return finish('failed', { code: 'preview_disabled' });
        // A previous process may have paid for generation or uploaded before its
        // database write. Recover the exact owned asset; NEVER repeat generation.
        if (row.preview.state === 'generating' || job.attempts > 1) {
            const asset = await images.recover(requestId, generation);
            return asset ? finish('ready', asset) : finish('uncertain', { code: 'interrupted_generation' });
        }
        if (row.preview.state !== 'queued') return { skipped: 'already_attempted' };
        const claim = await Request.updateOne({ ...filter, 'preview.state': 'queued' }, {
            $set: { 'preview.state': 'generating', 'preview.startedAt': now() },
        });
        if (!claim.modifiedCount) return { skipped: 'already_started' };
        try {
            const asset = await images.create({ requestId, generation, query: row.query, signal });
            return finish('ready', asset);
        } catch (error) {
            signal.throwIfAborted();
            return finish('failed', { code: 'generation_unavailable' });
        }
    };
}

function createRequestNotificationWorker({ Request, User, notifications, now = () => new Date() }) {
    return async ({ requestId, revision }, { job, signal }) => {
        signal.throwIfAborted();
        const row = await Request.findById(requestId).lean();
        if (!row || row.statusRevision !== revision || ['draft', 'cancelled'].includes(row.state)) return { skipped: 'stale_request' };
        const message = { requested: 'Your product request was received by NaijaGo.', sourcing: 'NaijaGo is sourcing your requested product.',
            matched: 'NaijaGo found a real listing for your request. Review its current details before ordering.',
            unavailable: 'There is an update on your product request. Open it to see the details.' }[row.state];
        const recipient = String(row.owner);
        await User.updateOne({ _id: row.owner, 'notifications._id': { $ne: job._id } }, { $push: { notifications: {
            _id: job._id, type: 'general', message, relatedId: row._id, relatedModel: 'ProductRequest', read: false, createdAt: now(),
        } } });
        signal.throwIfAborted();
        if (!notifications.hasAudienceConfiguration('customer')) throw Object.assign(new Error('Customer push unavailable.'), { jobCode: 'push_not_configured', retryable: false });
        if (!job.deliveryKey) throw Object.assign(new Error('Delivery identity unavailable.'), { jobCode: 'missing_delivery_key', retryable: false });
        const result = await notifications.createNotification('customer', {
            headings: { en: 'NaijaGo product request' }, contents: { en: message },
            include_aliases: { external_id: [recipient] }, target_channel: 'push', idempotency_key: job.deliveryKey,
            data: { type: 'product_request', requestId }, ...notifications.getPlatformOptions('customer'),
        });
        if (!result.body?.id || result.body.errors) throw Object.assign(new Error('Customer push recipient unavailable.'), { jobCode: 'push_recipient_unavailable', retryable: false });
        return { inApp: true, pushAccepted: true };
    };
}
module.exports = { createConceptImageAdapter, createRequestPreviewWorker, createRequestNotificationWorker };
