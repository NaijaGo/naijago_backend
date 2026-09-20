// Build required indexes before accepting writes that rely on uniqueness. Never
// sync/drop indexes here: a conflicting existing index needs an operator review.
function createFeatureReadiness({ models, now = Date.now, retryAfterMs = 30000 }) {
    let ready = false, pending = null, retryAt = 0;
    return async function ensureReady() {
        if (ready) return true;
        if (pending) return pending;
        if (now() < retryAt) return false;
        pending = (async () => {
            try {
                for (const model of models) {
                    await model.createCollection();
                    await model.createIndexes();
                }
                ready = true;
                return true;
            } catch (_) {
                retryAt = now() + retryAfterMs;
                return false;
            } finally { pending = null; }
        })();
        return pending;
    };
}
module.exports = { createFeatureReadiness };
