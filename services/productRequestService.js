const crypto = require('node:crypto');
const { RequestInputError, STATES, LABEL, id, revision, parseDraft, transition } = require('../utils/productRequestPolicy');
const { positiveLimit } = require('./geminiSearchService');

function createProductRequestService({ Request, Job, Usage, connection, queue, catalog, previewUrl = () => null, env = process.env, now = () => new Date() }) {
    async function transaction(work) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try { return await connection.transaction(work); }
            catch (error) { if (error.code !== 11000 || attempt === 2) throw error; }
        }
    }
    const enabled = () => env.PRODUCT_REQUESTS_ENABLED === 'true' && env.BACKGROUND_JOBS_ENABLED === 'true';
    const previewEnabled = () => enabled() && env.PRODUCT_REQUEST_PREVIEWS_ENABLED === 'true' && Boolean(env.GEMINI_API_KEY) &&
        Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) &&
        positiveLimit(env.GEMINI_PREVIEW_DAILY_LIMIT, 1000) > 0 && positiveLimit(env.GEMINI_PREVIEW_USER_DAILY_LIMIT || 3, 10) > 0;
    async function owned(requestId, owner, session, admin = false) {
        const row = await Request.findOne({ _id: id(requestId), ...(admin ? { submittedAt: { $exists: true } } : { owner }) }).session(session || null);
        if (!row) throw new RequestInputError('Request not found.', 404);
        return row;
    }
    async function serialize(row) {
        const p = row.preview || {};
        let previewState = p.state || 'not_requested';
        if (['queued', 'generating'].includes(previewState) && p.job) {
            const job = await Job.findById(p.job).select('state').lean();
            if (!job || ['failed', 'cancelled'].includes(job.state)) previewState = 'uncertain';
        }
        const matchedProduct = row.state === 'matched' && row.matchedProduct ? await catalog.available(String(row.matchedProduct)) : null;
        return { id: String(row._id), query: row.query, criteria: row.criteria, notes: row.notes, state: row.state,
            revision: row.revision, createdAt: row.createdAt, submittedAt: row.submittedAt, customerMessage: row.customerMessage,
            history: row.history.map(({ state, message, at }) => ({ state, message, at })),
            preview: { state: previewState, generation: p.generation || 0, label: LABEL, aiGenerated: true, purchasable: false,
                imageUrl: previewState === 'ready' ? previewUrl(p) : null,
                canGenerate: previewEnabled() && row.state !== 'cancelled' && !['queued', 'generating'].includes(previewState) && (p.generation || 0) < 3 },
            matchedProduct: matchedProduct ? { id: matchedProduct.id, name: matchedProduct.name, price: matchedProduct.effectivePrice ?? matchedProduct.price, sellerName: matchedProduct.sellerName } : null,
            matchedUnavailable: row.state === 'matched' && !matchedProduct };
    }
    async function create({ owner, input }) {
        const parsed = parseDraft(input);
        let row = await Request.findOne({ owner, clientRequestId: parsed.clientRequestId });
        if (row) {
            if (row.inputHash !== parsed.inputHash) throw new RequestInputError('This retry identifier belongs to another request.', 409);
            return serialize(row);
        }
        // Paid previews are checked separately. Saving a sourcing draft costs no AI quota.
        try { row = await Request.create({ ...parsed, owner }); }
        catch (error) {
            if (error.code !== 11000) throw error;
            row = await Request.findOne({ owner, clientRequestId: parsed.clientRequestId });
            if (!row || row.inputHash !== parsed.inputHash) throw new RequestInputError('This retry identifier belongs to another request.', 409);
        }
        return serialize(row);
    }
    async function get({ requestId, owner, admin = false }) { return serialize(await owned(requestId, owner, null, admin)); }
    async function matched({ requestId, owner }) {
        const row = await owned(requestId, owner);
        const product = row.state === 'matched' && row.matchedProduct ? await catalog.available(String(row.matchedProduct)) : null;
        if (!product) throw new RequestInputError('This matched product is no longer available. Check the request for updates.', 409);
        return { product };
    }
    async function list({ owner, admin = false, state, before, query }) {
        if (state && (!STATES.includes(state) || (admin && state === 'draft'))) throw new RequestInputError('Invalid request status.');
        if (query && (typeof query !== 'string' || query.length > 200)) throw new RequestInputError('Invalid request search.');
        const literal = query?.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rows = await Request.find({ ...(admin ? { submittedAt: { $exists: true } } : { owner }),
            ...(state ? { state } : {}), ...(before ? { _id: { $lt: id(before) } } : {}),
            ...(literal ? { query: { $regex: literal, $options: 'i' } } : {}),
        }).sort({ _id: -1 }).limit(21).lean();
        return { requests: await Promise.all(rows.slice(0, 20).map(serialize)), nextCursor: rows.length > 20 ? String(rows[19]._id) : null };
    }
    async function update({ requestId, owner, admin = false, input }) {
        const target = input.state;
        if (admin && target === 'matched' && !await catalog.available(id(input.productId))) throw new RequestInputError('Link an approved, active product with an available seller and stock.');
        await transaction(async (session) => {
            const row = await owned(requestId, owner, session, admin);
            const change = transition(row, { state: target, message: input.message, productId: input.productId, expectedRevision: input.revision, admin });
            if (!change) return;
            row.state = change.state; row.customerMessage = change.message; row.matchedProduct = change.matchedProduct;
            row.revision += 1;
            row.statusRevision = row.revision;
            if (target === 'requested') row.submittedAt = now();
            if (target === 'cancelled' && ['queued', 'generating'].includes(row.preview.state)) {
                row.preview.state = 'failed'; row.preview.code = 'request_cancelled';
            }
            row.history.push({ state: target, message: change.message, at: now(), actor: owner });
            await row.save({ session });
            if (target !== 'cancelled') await queue.enqueue({ type: 'request.notify', dedupeKey: `${row._id}:${row.revision}`, owner: row.owner,
                payload: { requestId: String(row._id), revision: row.revision } }, { session });
        });
        return get({ requestId, owner, admin });
    }
    async function reserve(bucket, limit, session) {
        if (!limit) throw new RequestInputError('Preview limit reached. You can still submit a text request.', 429);
        const date = now();
        const result = await Usage.findOneAndUpdate({ _id: `preview:${date.toISOString().slice(0, 10)}:${bucket}`, used: { $lt: limit } },
            { $inc: { used: 1 }, $setOnInsert: { expiresAt: new Date(date.getTime() + 3 * 86400000) } },
            { upsert: true, new: true, session, setDefaultsOnInsert: false });
        if (!result) throw new RequestInputError('Preview limit reached. You can still submit a text request.', 429);
    }
    async function generate({ requestId, owner, input }) {
        if (!previewEnabled()) throw new RequestInputError('AI previews are unavailable. You can still send a text request.', 503);
        if (input.aiConsent !== true) throw new RequestInputError('Confirm that your search description may be sent to the AI image provider.');
        revision(input.revision);
        const initial = await owned(requestId, owner);
        if (initial.state === 'cancelled') throw new RequestInputError('This request is cancelled.', 409);
        if (['queued', 'generating'].includes(initial.preview.state)) {
            const job = await Job.findById(initial.preview.job).select('state').lean();
            if (job && ['queued', 'running'].includes(job.state)) return serialize(initial);
        }
        if (await catalog.hasMatches(initial)) throw new RequestInputError('Matching products are now available. Refresh your search before generating a concept.', 409);
        try {
            await connection.transaction(async (session) => {
                const row = await owned(requestId, owner, session);
                if (row.revision !== input.revision || row.state === 'cancelled') throw new RequestInputError('This request changed. Refresh and try again.', 409);
                if (row.preview.generation >= 3) throw new RequestInputError('Preview attempt limit reached. Submit the text request instead.', 429);
                if (['queued', 'generating'].includes(row.preview.state)) {
                    const job = await Job.findById(row.preview.job).session(session);
                    if (job && ['queued', 'running'].includes(job.state)) return;
                }
                const actor = crypto.createHmac('sha256', env.GEMINI_API_KEY).update(String(owner)).digest('hex');
                await reserve(actor, positiveLimit(env.GEMINI_PREVIEW_USER_DAILY_LIMIT || 3, 10), session);
                await reserve('global', positiveLimit(env.GEMINI_PREVIEW_DAILY_LIMIT, 1000), session);
                const generation = row.preview.generation + 1;
                const job = await queue.enqueue({ type: 'request.preview', dedupeKey: `${row._id}:${generation}`, owner,
                    payload: { requestId: String(row._id), generation }, maxAttempts: 2 }, { session });
                row.preview = { state: 'queued', generation, job: job._id, consentAt: now() }; row.revision += 1;
                await row.save({ session });
            });
        } catch (error) {
            if (error.code === 11000) throw new RequestInputError('Preview limit reached. You can still submit a text request.', 429);
            throw error;
        }
        return get({ requestId, owner });
    }
    return { enabled, previewEnabled, create, get, matched, list, update, generate };
}
module.exports = { createProductRequestService };
