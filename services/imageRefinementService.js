const { RefinementError, STATES, id, revision, sourceImages, sourceKey, sourceIdentity, replacement, canUseAsMain } = require('../utils/imageRefinementPolicy');
const { positiveLimit } = require('../utils/featureBudget');

function createImageRefinementService({ Refinement, Product, Job, Usage, queue, connection, images, env = process.env, now = () => new Date() }) {
    const enabled = () => env.IMAGE_REFINEMENT_ENABLED === 'true' && env.BACKGROUND_JOBS_ENABLED === 'true';
    function configuration() {
        const missingConfiguration = ['PHOTOROOM_API_KEY', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']
            .filter(name => !String(env[name] || '').trim());
        if (env.IMAGE_REFINEMENT_ENABLED !== 'true') missingConfiguration.push('IMAGE_REFINEMENT_ENABLED');
        if (env.BACKGROUND_JOBS_ENABLED !== 'true') missingConfiguration.push('BACKGROUND_JOBS_ENABLED');
        if (!positiveLimit(env.PHOTOROOM_DAILY_LIMIT, 1000)) missingConfiguration.push('PHOTOROOM_DAILY_LIMIT');
        if (!positiveLimit(env.PHOTOROOM_VENDOR_DAILY_LIMIT || 20, 500)) missingConfiguration.push('PHOTOROOM_VENDOR_DAILY_LIMIT');
        const sandbox = env.PHOTOROOM_SANDBOX !== 'false';
        const keyModeMismatch = !sandbox && String(env.PHOTOROOM_API_KEY || '').startsWith('sandbox_');
        return { missingConfiguration, sandbox, keyModeMismatch, workerCommand: 'npm run worker:image-refinements' };
    }
    const processingEnabled = () => {
        const config = configuration();
        return !config.missingConfiguration.length && !config.keyModeMismatch;
    };
    const owner = (product) => String(product.sellerId || product.vendor || '');
    const applicable = (product, row) => product && owner(product) === String(row.owner || '') && sourceImages(product).includes(row.sourceUrl);
    async function transaction(work) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try { return await connection.transaction(work); }
            catch (error) { if (error.code !== 11000 || attempt === 2) throw error; }
        }
    }
    async function reserve(bucket, limit, session) {
        const date = now();
        const key = `refine:${date.toISOString().slice(0, 10)}:${bucket}`;
        const existing = await Usage.findById(key).session(session);
        if ((existing?.used || 0) >= limit) throw new RefinementError('Image processing daily limit reached. Try tomorrow.', 429);
        // A concurrent first upsert may collide without exhausting the budget.
        // Let the enclosing transaction retry that collision with a fresh snapshot.
        const result = await Usage.findOneAndUpdate({ _id: key, used: { $lt: limit } },
            { $inc: { used: 1 }, $setOnInsert: { expiresAt: new Date(date.getTime() + 3 * 86400000) } },
            { upsert: true, new: true, session, setDefaultsOnInsert: false });
        if (!result) throw new RefinementError('Image processing daily limit reached. Try tomorrow.', 429);
    }
    async function allocate(row, actor, session, signal) {
        row.budgetDay = now().toISOString().slice(0, 10);
        await reserve('global', positiveLimit(env.PHOTOROOM_DAILY_LIMIT, 1000), session);
        await reserve(`seller:${row.owner || 'naijago'}`, positiveLimit(env.PHOTOROOM_VENDOR_DAILY_LIMIT || 20, 500), session);
        signal?.throwIfAborted();
        const job = await queue.enqueue({ type: 'image.refine', dedupeKey: `${row._id}:${row.generation}`, owner: actor,
            payload: { refinementId: String(row._id), generation: row.generation }, maxAttempts: 3 }, { session });
        row.job = job._id;
    }
    async function serialize(row) {
        let state = row.state;
        const product = await Product.findById(row.product).select('imageUrls images sellerId vendor').lean();
        const publishedUrl = row.state === 'approved' && row.published ? images.publicUrl(row, row.published) : null;
        const mainSource = publishedUrl || row.sourceUrl;
        if (['queued', 'preserving', 'generating', 'publishing'].includes(state)) {
            const job = await Job.findById(row.job).select('state').lean();
            if (!job || ['failed', 'cancelled'].includes(job.state)) state = 'uncertain';
        }
        return { id: String(row._id), productId: String(row.product), productName: row.productName, state, storedState: row.state,
            generation: row.generation, revision: row.revision, profile: row.profile, sandbox: row.sandbox, code: row.code,
            publicationTarget: row.publicationTarget || 'source', canSetAsMain: Boolean(product && owner(product) === String(row.owner || '') && canUseAsMain(product, mainSource) &&
                !(publishedUrl && product.imageUrls?.[0] === publishedUrl && product.images?.main === publishedUrl)),
            originalUrl: images.url(row.original), candidateUrl: row.candidate ? images.url(row.candidate) : null,
            history: row.history.map(({ action, generation, at, reason, publicationTarget }) => ({ action, generation, at, reason, publicationTarget })),
            canRegenerate: processingEnabled() && row.generation < 3 && ['pending_review', 'rejected', 'failed', 'uncertain'].includes(state) && row.state !== 'publishing' };
    }
    async function get(refinementId) {
        const row = await Refinement.findById(id(refinementId));
        if (!row) throw new RefinementError('Image review not found.', 404);
        return serialize(row);
    }
    async function list({ state, before, productId } = {}) {
        if (state && !STATES.includes(state)) throw new RefinementError('Invalid image state.');
        const rows = await Refinement.find({ ...(state ? { state } : {}), ...(before ? { _id: { $lt: id(before) } } : {}), ...(productId ? { product: id(productId) } : {}) }).sort({ _id: -1 }).limit(21).lean();
        return { images: await Promise.all(rows.slice(0, 20).map(serialize)), nextCursor: rows.length > 20 ? String(rows[19]._id) : null };
    }
    async function requestBatch({ productIds, actor, profile = 'standard' }) {
        if (!processingEnabled()) throw new RefinementError('Image processing is not configured or its daily budget is missing.', 503);
        if (!Array.isArray(productIds) || !productIds.length || productIds.length > 20 || !['standard', 'relight'].includes(profile)) throw new RefinementError('Select up to 20 products and a refinement style.');
        productIds.forEach(id);
        const results = [];
        for (const productId of new Set(productIds)) {
            const product = await Product.findById(productId).lean();
            if (!product) { results.push({ productId, state: 'not_found' }); continue; }
            const urls = sourceImages(product);
            const eligible = urls.filter((url) => { try { sourceIdentity(url, env.CLOUDINARY_CLOUD_NAME); return true; } catch (_) { return false; } }).length;
            if (!eligible || urls.length > 40) { results.push({ productId, state: 'reupload_required', eligible: 0 }); continue; }
            const result = await Product.updateOne({ _id: productId, updatedAt: product.updatedAt }, { $set: {
                refinementScanPending: true, refinementScanAfter: new Date(0), refinementScanProfile: profile, refinementRequestedBy: actor, refinementScanCode: '',
            } });
            results.push({ productId, state: result.matchedCount ? 'scheduled' : 'product_changed', eligible, skipped: urls.length - eligible });
        }
        return { results };
    }
    // Read-only inspection: no reservation, job, provider call or product update.
    async function previewBatch({ productIds }) {
        if (!Array.isArray(productIds) || !productIds.length || productIds.length > 20) throw new RefinementError('Select between 1 and 20 products.');
        productIds.forEach(id);
        const products = [];
        for (const productId of new Set(productIds)) {
            const product = await Product.findById(productId).lean();
            if (!product) { products.push({ productId, state: 'not_found', images: [], newImages: 0 }); continue; }
            const sources = sourceImages(product);
            const existing = await Refinement.find({ product: product._id }).select('sourceKey state').lean();
            const recorded = new Map(existing.map(row => [row.sourceKey, row.state]));
            const images = sources.map(sourceUrl => {
                try {
                    sourceIdentity(sourceUrl, env.CLOUDINARY_CLOUD_NAME);
                    const state = recorded.get(sourceKey(`${sourceUrl}\n${owner(product)}`));
                    return { sourceUrl, eligible: true, recordedState: state || null };
                } catch (_) { return { eligible: false, reason: 'Re-upload this image to NaijaGo before processing.' }; }
            });
            const eligible = images.filter(image => image.eligible).length;
            const blocked = !eligible || sources.length > 40;
            products.push({ productId, productName: product.name, state: blocked ? 'reupload_required' : 'eligible',
                images, newImages: blocked ? 0 : images.filter(image => image.eligible && !image.recordedState).length,
                skippedImages: images.filter(image => !image.eligible).length });
        }
        return { products, newImages: products.reduce((total, product) => total + product.newImages, 0),
            message: 'Estimate only. Products and budgets are checked again by the worker. Existing reviews are not regenerated automatically.' };
    }
    async function stage({ productId, actor, profile = 'standard', signal }) {
        signal?.throwIfAborted();
        if (!processingEnabled()) throw new RefinementError('Image processing is not configured or its daily budget is missing.', 503);
        if (!['standard', 'relight'].includes(profile)) throw new RefinementError('Invalid refinement style.');
        const product = await Product.findById(id(productId)).lean();
        if (!product) throw new RefinementError('Product not found.', 404);
        const urls = sourceImages(product);
        if (urls.length > 40) throw new RefinementError('This product has more than 40 image sources. Review it individually.');
        const results = [];
        for (const sourceUrl of urls) {
            signal?.throwIfAborted();
            try {
                sourceIdentity(sourceUrl, env.CLOUDINARY_CLOUD_NAME);
                const rowId = await transaction(async (session) => {
                    signal?.throwIfAborted();
                    const current = await Product.findById(product._id).session(session).lean();
                    if (!current || owner(current) !== owner(product) || !sourceImages(current).includes(sourceUrl)) throw new RefinementError('Product images changed. Refresh and try again.', 409);
                    // Reassignment starts a new review identity, retaining the old
                    // seller audit without allowing their candidate to publish.
                    const key = { product: product._id, sourceKey: sourceKey(`${sourceUrl}\n${owner(product)}`) };
                    let row = await Refinement.findOne(key).session(session);
                    if (row) return row._id;
                    row = new Refinement({ ...key, owner: owner(product) || null, sourceUrl, productName: product.name, profile,
                        sandbox: env.PHOTOROOM_SANDBOX !== 'false', history: [{ action: 'queued', generation: 1, actor, at: now() }] });
                    await allocate(row, actor, session, signal);
                    signal?.throwIfAborted();
                    await row.save({ session });
                    return row._id;
                });
                results.push({ id: String(rowId), state: 'recorded' });
            } catch (error) {
                if (!(error instanceof RefinementError)) throw error;
                results.push({ state: 'not_queued', status: error.status, message: error.message });
                if (error.status === 429) break;
            }
        }
        return { productId, images: results };
    }
    async function review({ refinementId, actor, input }) {
        id(refinementId); revision(input.revision);
        if (!['approve', 'reject', 'regenerate', 'retry_publish', 'set_main'].includes(input.action)) throw new RefinementError('Choose an image review action.');
        if (input.setAsMain !== undefined && (typeof input.setAsMain !== 'boolean' || input.action !== 'approve')) {
            throw new RefinementError('Choose a valid main-image option when approving the image.');
        }
        if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) throw new RefinementError('Add a short review reason.');
        await transaction(async (session) => {
            const row = await Refinement.findById(refinementId).session(session);
            if (!row) throw new RefinementError('Image review not found.', 404);
            if (row.revision !== input.revision) throw new RefinementError('This image review changed. Refresh before acting.', 409);
            const product = await Product.findById(row.product).session(session).lean();
            // An already-published live image can be promoted without another
            // provider call. Validate its current published identity, not its old source.
            if (input.action === 'set_main') {
                if (row.state !== 'approved' || row.sandbox !== false || !row.published || !product || owner(product) !== String(row.owner || '')) {
                    throw new RefinementError('Only an approved live image from this product can become its main photo.', 409);
                }
                if (input.identityConfirmed !== true) throw new RefinementError('Confirm the product, colour, label, quantity and image rights before approval.');
                const publishedUrl = images.publicUrl(row, row.published);
                const change = await Product.updateOne({ _id: product._id, updatedAt: product.updatedAt }, {
                    $set: replacement(product, publishedUrl, publishedUrl, { setAsMain: true }), $inc: { __v: 1 },
                }, { session });
                if (!change.modifiedCount) throw new RefinementError('Product changed during publication. Refresh before continuing.', 409);
                row.publicationTarget = 'main'; row.revision += 1;
                row.history.push({ action: 'set_main', generation: row.generation, actor, at: now(), reason: input.reason.trim(), publicationTarget: 'main' });
                await row.save({ session });
                return;
            }
            if (!applicable(product, row)) throw new RefinementError('The product, seller or source image changed. This review is obsolete.', 409);
            const job = row.job ? await Job.findById(row.job).session(session).lean() : null;
            const active = job && ['queued', 'running'].includes(job.state);
            const prior = row.candidate?.toObject ? row.candidate.toObject() : row.candidate;
            if (input.action === 'approve') {
                if (row.state !== 'pending_review' || !row.candidate || !row.original) throw new RefinementError('Wait for a complete original and refined image pair.', 409);
                if (row.sandbox) throw new RefinementError('Sandbox images cannot be published. Generate a new live candidate after configuring the provider.', 409);
                if (input.identityConfirmed !== true) throw new RefinementError('Confirm the product, colour, label, quantity and image rights before approval.');
                if (input.setAsMain === true && !canUseAsMain(product, row.sourceUrl)) throw new RefinementError('A variant-only photo cannot become the main product image.', 409);
                row.publicationTarget = input.setAsMain === true ? 'main' : 'source';
                row.state = 'publishing';
            } else if (input.action === 'retry_publish') {
                if (row.state !== 'publishing' || active || row.history.filter((item) => item.action === 'retry_publish').length >= 3) throw new RefinementError('Publication is active or its retry limit was reached.', 409);
            } else if (input.action === 'reject') {
                if (!['pending_review', 'failed', 'uncertain'].includes(row.state)) throw new RefinementError('This image cannot be rejected in its current state.', 409);
                row.state = 'rejected';
            } else {
                if (!processingEnabled()) throw new RefinementError('Image processing is unavailable.', 503);
                if (active && ['queued', 'preserving', 'generating'].includes(row.state)) throw new RefinementError('Image processing is still active.', 409);
                if (['publishing', 'approved', 'obsolete'].includes(row.state) || row.generation >= 3) throw new RefinementError('This image cannot be regenerated; three attempts maximum.', 409);
                if (!['standard', 'relight'].includes(input.profile || 'standard')) throw new RefinementError('Invalid refinement style.');
                row.generation += 1; row.profile = input.profile || 'standard'; row.sandbox = env.PHOTOROOM_SANDBOX !== 'false';
                row.state = 'queued'; row.candidate = undefined; row.code = '';
                row.publicationTarget = 'source';
                await allocate(row, actor, session);
            }
            row.revision += 1;
            row.history.push({ action: input.action, generation: input.action === 'regenerate' ? row.generation - 1 : row.generation,
                actor, at: now(), reason: input.reason.trim(), candidate: prior,
                ...(input.action === 'approve' ? { publicationTarget: row.publicationTarget } : {}) });
            if (['approve', 'retry_publish'].includes(input.action)) {
                const nextJob = await queue.enqueue({ type: 'image.publish', dedupeKey: `${row._id}:${row.generation}:${row.revision}`, owner: actor,
                    payload: { refinementId, generation: row.generation }, maxAttempts: 4 }, { session });
                row.job = nextJob._id;
            }
            await row.save({ session });
        });
        return get(refinementId);
    }
    async function completePublication(row, asset) {
        return transaction(async (session) => {
            const current = await Refinement.findOne({ _id: row._id, generation: row.generation, job: row.job, state: 'publishing' }).session(session);
            if (!current) return { skipped: 'obsolete' };
            const product = await Product.findById(row.product).session(session).lean();
            if (!applicable(product, current)) {
                current.state = 'obsolete'; current.code = 'source_changed';
            } else {
                const change = await Product.updateOne({ _id: product._id, updatedAt: product.updatedAt }, {
                    $set: replacement(product, current.sourceUrl, images.publicUrl(current, asset), { setAsMain: current.publicationTarget === 'main' }), $inc: { __v: 1 },
                }, { session });
                if (!change.modifiedCount) throw new RefinementError('Product changed during publication. Retry safely.', 409);
                current.state = 'approved'; current.published = asset; current.code = '';
            }
            current.revision += 1;
            current.history.push({ action: current.state, generation: current.generation, at: now(), publicationTarget: current.publicationTarget || 'source' });
            await current.save({ session });
            return { state: current.state };
        });
    }
    async function schedule({ signal }) {
        if (!processingEnabled()) return;
        const rows = await Product.find({ refinementScanPending: true, $or: [{ refinementScanAfter: { $exists: false } }, { refinementScanAfter: { $lte: now() } }] })
            .select('+refinementScanPending +refinementScanAfter +refinementScanProfile +refinementRequestedBy').sort({ _id: 1 }).limit(5).lean();
        for (const product of rows) {
            signal.throwIfAborted();
            let wait = false, code = '';
            try {
                const result = await stage({ productId: String(product._id), actor: product.refinementRequestedBy || product.sellerId || product.vendor,
                    profile: product.refinementScanProfile || 'standard', signal });
                wait = result.images.some((item) => item.status === 429 || item.status >= 500);
                if (result.images.some((item) => item.state === 'not_queued')) code = wait ? 'budget_or_provider_unavailable' : 'legacy_image_reupload_required';
            } catch (_) { signal.throwIfAborted(); wait = true; code = 'scheduling_unavailable'; }
            signal.throwIfAborted();
            await Product.updateOne({ _id: product._id, updatedAt: product.updatedAt }, { $set: {
                refinementScanPending: wait, refinementScanAfter: new Date(now().getTime() + 3600000), refinementScanCode: code,
            } });
        }
    }
    return { enabled, configuration, processingEnabled, applicable, previewBatch, requestBatch, stage, review, get, list, completePublication, schedule };
}
module.exports = { createImageRefinementService };
