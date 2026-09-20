function createImageRefinementWorkers({ Refinement, Product, service, images, now = () => new Date() }) {
    async function refine({ refinementId, generation }, { job, signal }) {
        signal.throwIfAborted();
        const filter = { _id: refinementId, generation, job: job._id };
        const row = await Refinement.findOne(filter).lean();
        if (!row || !['queued', 'preserving', 'generating'].includes(row.state)) return { skipped: 'already_processed' };
        const finish = async (state, fields = {}) => {
            signal.throwIfAborted();
            const result = await Refinement.updateOne({ ...filter, state: row.state }, { $set: { state, ...fields }, $inc: { revision: 1 } });
            return { state: result.modifiedCount ? state : 'superseded' };
        };
        if (!service.enabled()) return finish('failed', { code: 'refinement_disabled' });
        const product = await Product.findById(row.product).lean();
        if (!service.applicable(product, row)) return finish('obsolete', { code: 'source_changed' });
        // A durable generating checkpoint means a provider MAY have charged us.
        // Recover only an already-stored candidate; never blindly re-generate.
        if (row.state === 'generating') {
            const asset = await images.recover(row, 'candidate');
            return asset ? finish('pending_review', { candidate: asset, code: '' }) : finish('uncertain', { code: 'generation_interrupted' });
        }
        if (!service.processingEnabled()) return finish('failed', { code: 'provider_not_configured' });
        if (row.budgetDay !== now().toISOString().slice(0, 10)) return finish('failed', { code: 'budget_window_expired' });
        if (row.state === 'queued') {
            const claim = await Refinement.updateOne({ ...filter, state: 'queued' }, { $set: { state: 'preserving' }, $inc: { revision: 1 } });
            if (!claim.modifiedCount) return { skipped: 'already_started' };
            row.state = 'preserving';
        }
        // Storage-only steps can be retried at the same immutable identity.
        const original = await images.preserve(row, signal);
        signal.throwIfAborted();
        // A backlog must not spend yesterday's reservations in today's budget.
        if (row.budgetDay !== now().toISOString().slice(0, 10)) return finish('failed', { original, code: 'budget_window_expired' });
        const claim = await Refinement.updateOne({ ...filter, state: 'preserving' }, {
            $set: { state: 'generating', original }, $inc: { revision: 1 },
        });
        if (!claim.modifiedCount) return { skipped: 'already_started' };
        row.state = 'generating'; row.original = original;
        try {
            const candidate = await images.refine(row, signal);
            return finish('pending_review', { candidate, code: '' });
        } catch (_) {
            signal.throwIfAborted();
            // A timeout can happen after storage as well as after provider acceptance.
            const candidate = await images.recover(row, 'candidate');
            return candidate ? finish('pending_review', { candidate, code: '' }) : finish('uncertain', { code: 'generation_unconfirmed' });
        }
    }
    async function publish({ refinementId, generation }, { job, signal }) {
        signal.throwIfAborted();
        const row = await Refinement.findOne({ _id: refinementId, generation, job: job._id, state: 'publishing' }).lean();
        if (!row) return { skipped: 'already_processed' };
        if (!service.enabled()) throw Object.assign(new Error('Image publication is disabled.'), { retryable: false, jobCode: 'refinement_disabled' });
        const product = await Product.findById(row.product).lean();
        if (!service.applicable(product, row)) {
            await Refinement.updateOne({ _id: row._id, generation, job: job._id, state: 'publishing' }, { $set: { state: 'obsolete', code: 'source_changed' }, $inc: { revision: 1 } });
            return { skipped: 'source_changed' };
        }
        const asset = await images.publish(row, signal);
        signal.throwIfAborted();
        return service.completePublication(row, asset);
    }
    return { 'image.refine': refine, 'image.publish': publish };
}
module.exports = { createImageRefinementWorkers };
