const AppSetting = require('../models/AppSetting');
const User = require('../models/User');
const KEY = 'cost_low_store';
const DEFAULT_KOBO = 5700;
function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function feeToKobo(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw error('Enter a non-negative fee per item in naira, with at most two decimal places.');
    const kobo = Math.round(value * 100);
    if (!Number.isSafeInteger(kobo) ||
        value !== Number(value.toFixed(2))) throw error('Enter a non-negative fee per item in naira, with at most two decimal places.');
    return kobo;
}
function savedFee(settings) {
    const fee = settings?.costLowStore?.commissionKoboPerUnit ?? DEFAULT_KOBO;
    if (!Number.isSafeInteger(fee) || fee < 0) throw error('Stored Low Cost World commission needs administrator reconciliation.', 503);
    const revision = settings?.costLowCommissionRevision === undefined ? 0 : settings.costLowCommissionRevision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw error('Stored Low Cost World commission revision is invalid.', 503);
    return { fee, revision };
}
function payload(settings, vendor) {
    const { fee, revision } = savedFee(settings);
    const vendorId = settings?.costLowStore?.vendorId ? String(settings.costLowStore.vendorId) : null;
    return { vendorId, vendorName: vendor?.businessName || 'Low Cost World',
        configured: Boolean(vendorId && vendor?.isVendor && vendor.vendorStatus === 'approved'),
        revision, feePerItem: fee / 100, commissionKoboPerUnit: fee,
        source: settings?.costLowStore?.commissionKoboPerUnit == null ? 'default' : 'database',
        history: settings?.costLowCommissionHistory || [],
        scope: 'Fixed commission per purchased item, across all Low Cost World categories. Applies to new orders; saved orders retain their commission amounts.' };
}
function createLowCostCommissionService({ Setting = AppSetting, Vendor = User } = {}) {
    async function read() {
        return Setting.findOne({ key: KEY }).select('costLowStore costLowCommissionRevision costLowCommissionHistory').lean();
    }
    async function findVendor(settings) {
        if (!settings?.costLowStore?.vendorId) return null;
        return Vendor.findById(settings.costLowStore.vendorId).select('_id businessName isVendor vendorStatus').lean();
    }
    async function getSettings() { const settings = await read(); return payload(settings, await findVendor(settings)); }
    async function updateSettings(body, actorId) {
        const newKobo = feeToKobo(body?.feePerItem);
        if (!Number.isSafeInteger(body?.revision) || body.revision < 0 || typeof body.vendorId !== 'string' || !/^[a-f\d]{24}$/i.test(body.vendorId)) {
            throw error('Refresh the linked Low Cost World settings before saving.');
        }
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (reason.length < 3 || reason.length > 500) throw error('Enter a reason between 3 and 500 characters.');
        if (!actorId) throw error('Administrator identity is required.', 403);
        const current = await read(); const vendor = await findVendor(current); const original = payload(current, vendor);
        if (!original.configured) throw error('Link an approved Low Cost World vendor in Product Moderation before changing its commission.', 409);
        if (original.revision !== body.revision || original.vendorId !== body.vendorId) throw error('Low Cost World settings changed. Refresh and review your fee again.', 409);
        if (newKobo === original.commissionKoboPerUnit) return { ...original, message: 'Low Cost World commission is unchanged.' };
        const oldFee = current.costLowStore.commissionKoboPerUnit;
        const filter = { key: KEY, 'costLowStore.vendorId': current.costLowStore.vendorId,
            'costLowStore.commissionKoboPerUnit': oldFee === undefined ? { $exists: false } : oldFee,
            costLowCommissionRevision: current.costLowCommissionRevision === undefined ? { $exists: false } : current.costLowCommissionRevision };
        const saved = await Setting.findOneAndUpdate(filter, {
            $set: { 'costLowStore.commissionKoboPerUnit': newKobo, updatedBy: actorId },
            $inc: { costLowCommissionRevision: 1 },
            $push: { costLowCommissionHistory: { $each: [{ vendorId: current.costLowStore.vendorId,
                previousKoboPerUnit: original.commissionKoboPerUnit, newKoboPerUnit: newKobo,
                changedBy: actorId, changedAt: new Date(), reason }], $slice: -100 } },
        }, { new: true, upsert: false, runValidators: true }).lean();
        if (!saved) throw error('Low Cost World settings changed. Refresh and review your fee again.', 409);
        return { ...payload(saved, vendor), message: 'Low Cost World commission saved for new orders.' };
    }
    return { getSettings, updateSettings };
}
module.exports = { createLowCostCommissionService, feeToKobo, payload, ...createLowCostCommissionService() };
