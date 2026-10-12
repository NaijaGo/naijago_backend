const AppSetting = require('../models/AppSetting');
const { manifest, resolveLabels } = require('./catalogTaxonomyService');
const { getCommissionRateForCategory } = require('../utils/vendorCommissionRates');

const SETTINGS_KEY = 'vendor_category_commissions';
const parents = new Map(manifest.categories.map(parent => [parent.id, parent]));
function inputError(message, statusCode = 400) {
    return Object.assign(new Error(message), { statusCode });
}
function validPercentage(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 &&
        Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;
}
function savedOverrides(settings) {
    if (settings?.commissionRevision != null && (!Number.isSafeInteger(settings.commissionRevision) || settings.commissionRevision < 0)) {
        throw inputError('Stored commission revision needs administrator reconciliation.', 503);
    }
    const overrides = {};
    for (const entry of settings?.vendorCommissionRates || []) {
        if (!parents.has(String(entry.categoryId)) || !validPercentage(entry.percentage) ||
            Object.hasOwn(overrides, String(entry.categoryId))) {
            throw inputError('Stored commission settings need administrator reconciliation.', 503);
        }
        overrides[String(entry.categoryId)] = entry.percentage;
    }
    return overrides;
}
function rateForProduct(category, subcategory, overrides = {}) {
    const selected = resolveLabels(category, subcategory);
    if (selected && Object.hasOwn(overrides, selected.parent.id)) {
        const percentage = overrides[selected.parent.id];
        if (!validPercentage(percentage)) throw inputError('Invalid stored commission percentage.', 503);
        return percentage / 100;
    }
    // Preserve existing text-only commission behavior unless an admin explicitly overrides it.
    return getCommissionRateForCategory(category);
}
function buildPayload(settings) {
    const overrides = savedOverrides(settings);
    return {
        revision: settings?.commissionRevision || 0,
        updatedAt: settings?.updatedAt || null,
        categories: manifest.categories.map(parent => {
            const legacyRates = [getCommissionRateForCategory(parent.label),
                ...parent.children.map(child => getCommissionRateForCategory(`${parent.label} > ${child.label}`))];
            return { categoryId: parent.id, label: parent.label,
                overridePercentage: overrides[parent.id] ?? null,
                defaultPercentage: getCommissionRateForCategory(parent.label) * 100,
                defaultRange: { minimum: Math.min(...legacyRates) * 100, maximum: Math.max(...legacyRates) * 100 },
                subcategoryCount: parent.children.length };
        }),
        history: settings?.vendorCommissionHistory || [],
        scope: 'New vendor order calculations only. Saved orders retain their commission amounts. Admin-owned sales and Cost Low fixed-per-unit commissions are unchanged.',
    };
}
function validateChanges(body) {
    if (!body || !Number.isSafeInteger(body.revision) || body.revision < 0) throw inputError('Refresh settings before saving.');
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 3 || reason.length > 500) throw inputError('Enter a reason between 3 and 500 characters.');
    if (!Array.isArray(body.changes) || !body.changes.length || body.changes.length > parents.size) throw inputError('Select 1 to 23 category changes.');
    const seen = new Set();
    for (const entry of body.changes) {
        if (!entry || typeof entry.categoryId !== 'string' || !parents.has(entry.categoryId) || seen.has(entry.categoryId)) {
            throw inputError('Use each valid main category ID only once.');
        }
        seen.add(entry.categoryId);
        if (entry.percentage !== null && !validPercentage(entry.percentage)) throw inputError('Commission must be a percentage from 0 to 100, with at most two decimal places.');
    }
    return { ...body, reason };
}
function createCommissionService({ Setting = AppSetting } = {}) {
    async function read(session = null, fields = 'vendorCommissionRates commissionRevision vendorCommissionHistory updatedAt') {
        const query = Setting.findOne({ key: SETTINGS_KEY }).select(fields).lean();
        if (session) query.session(session);
        return await query;
    }
    async function getOverrides(session = null) { return savedOverrides(await read(session, 'vendorCommissionRates commissionRevision')); }
    async function getSettings() { return buildPayload(await read()); }
    async function updateSettings(body, actorId) {
        const input = validateChanges(body);
        if (!actorId) throw inputError('Administrator identity is required.', 403);
        const current = await read();
        if ((current?.commissionRevision || 0) !== input.revision) throw inputError('Settings changed. Refresh and review your changes again.', 409);
        const overrides = savedOverrides(current);
        const changes = [];
        for (const entry of input.changes) {
            const previousPercentage = overrides[entry.categoryId] ?? null;
            if (previousPercentage === entry.percentage) continue;
            changes.push({ categoryId: entry.categoryId, label: parents.get(entry.categoryId).label,
                previousPercentage, newPercentage: entry.percentage });
            if (entry.percentage === null) delete overrides[entry.categoryId];
            else overrides[entry.categoryId] = entry.percentage;
        }
        if (!changes.length) return { ...buildPayload(current), message: 'Commission rates are unchanged.' };
        const filter = { key: SETTINGS_KEY, ...(input.revision === 0
            ? { $or: [{ commissionRevision: 0 }, { commissionRevision: { $exists: false } }] }
            : { commissionRevision: input.revision }) };
        try {
            const saved = await Setting.findOneAndUpdate(filter, {
                $set: { vendorCommissionRates: manifest.categories.filter(parent => Object.hasOwn(overrides, parent.id))
                    .map(parent => ({ categoryId: parent.id, percentage: overrides[parent.id] })), updatedBy: actorId },
                $inc: { commissionRevision: 1 },
                $push: { vendorCommissionHistory: { $each: [{ changedBy: actorId, changedAt: new Date(), reason: input.reason, changes }], $slice: -100 } },
            }, { upsert: !current, new: true, runValidators: true, setDefaultsOnInsert: true }).lean();
            if (!saved) throw inputError('Settings changed. Refresh and review your changes again.', 409);
            return { ...buildPayload(saved), message: 'Commission settings saved for new orders.' };
        } catch (error) {
            if (error.code === 11000) throw inputError('Settings changed. Refresh and review your changes again.', 409);
            throw error;
        }
    }
    return { getSettings, getOverrides, updateSettings };
}
module.exports = { SETTINGS_KEY, createCommissionService, rateForProduct, buildPayload, validateChanges,
    ...createCommissionService() };
