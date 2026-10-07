const crypto = require('crypto');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const ProductOffer = require('../models/ProductOffer');
const User = require('../models/User');
const inventory = require('./inventoryService');
const { GroupOrder, RecurringPlan, RecurringOccurrence } = require('../models/PlannedOrders');
const failure = (statusCode, message) => Object.assign(new Error(message), { statusCode, code: 'PLANNED_ORDER_ERROR' });
const enabled = () => process.env.PLANNED_ORDERS_ENABLED === 'true';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(24).toString('base64url');
const id = value => {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw failure(400, 'Invalid record ID.');
    return value.toLowerCase();
};
function revision(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw failure(400, 'A valid revision is required.');
    return value;
}
function name(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw failure(400, 'Enter a name of up to 80 characters.');
    return value.trim();
}
function destination(input) {
    if (!input || typeof input !== 'object') throw failure(400, 'A delivery address is required.');
    const result = {};
    for (const key of ['address', 'city', 'state', 'postalCode', 'country']) {
        const value = input[key] ?? (key === 'country' ? 'Nigeria' : '');
        if (typeof value !== 'string' || value.length > (key === 'address' ? 500 : key === 'postalCode' ? 30 : 100)) throw failure(400, 'Invalid delivery address.');
        result[key] = value.trim();
    }
    if (!result.address || !result.city || !result.country) throw failure(400, 'Confirm your street address, city and country.');
    for (const [key, maximum] of [['latitude', 90], ['longitude', 180]]) {
        if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || Math.abs(input[key]) > maximum) throw failure(400, 'Confirm delivery coordinates before planning an order.');
        result[key] = input[key];
    }
    return result;
}
async function items(input, expectedSeller, { requireAvailable = false } = {}) {
    if (!Array.isArray(input) || !input.length || input.length > 100) throw failure(400, 'Choose 1–100 products.');
    const result = [], sellers = [], productQuantities = new Map(), offerQuantities = new Map();
    const products = await Product.find({ _id: { $in: input.map(row => id(row?.product)) } }).lean();
    const offers = await ProductOffer.find({ product: { $in: products.map(row => row._id) } }).lean();
    for (const row of input) {
        if (!Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 1000) throw failure(400, 'Quantity must be a whole number from 1 to 1,000.');
        if (row.variantId || row.productVariantId) throw failure(400, 'Variant-specific planned orders are not supported yet.');
        const productId = id(row.product);
        const product = products.find(p => String(p._id) === productId);
        if (!product) throw failure(404, 'A selected product no longer exists.');
        if (product.isActive === false || ['disabled', 'draft'].includes(product.productStatus) || ['pending', 'rejected'].includes(product.moderationStatus)) throw failure(409, 'A selected product is not available for ordering.');
        const offer = row.offer ? offers.find(o => String(o._id) === id(row.offer) && String(o.product) === productId) : offers.find(o => String(o.product) === productId && o.isPrimary && o.status === 'active');
        if (row.offer && !offer || offer && offer.status !== 'active') throw failure(409, 'A selected offer is unavailable.');
        const sellerType = offer?.sellerType || (product.vendor ? 'vendor' : product.sellerType || 'naijago');
        const sellerId = sellerType === 'vendor' ? String(offer?.sellerId || product.sellerId || product.vendor || '') : null;
        const seller = { sellerType, sellerId };
        if (sellerType === 'vendor' && !sellerId) throw failure(409, 'Product seller information is unavailable.');
        if (expectedSeller && (expectedSeller.sellerType !== sellerType || String(expectedSeller.sellerId || '') !== String(sellerId || ''))) throw failure(400, 'All group products must belong to the same shop.');
        const selectedSize = row.selectedSize ?? '', customerNote = row.customerNote ?? '';
        if (typeof selectedSize !== 'string' || selectedSize.length > 80 || typeof customerNote !== 'string' || customerNote.length > 500) throw failure(400, 'Invalid product option or note.');
        result.push({ product: product._id, offer: offer?._id || null, quantity: row.quantity, selectedSize: selectedSize.trim(), customerNote: customerNote.trim(), productName: String(product.name || 'Product').slice(0, 300) });
        productQuantities.set(String(product._id), (productQuantities.get(String(product._id)) || 0) + row.quantity);
        if (offer) offerQuantities.set(String(offer._id), (offerQuantities.get(String(offer._id)) || 0) + row.quantity);
        sellers.push(seller);
    }
    for (const sellerId of new Set(sellers.filter(s => s.sellerType === 'vendor').map(s => s.sellerId))) {
        if (!await User.exists({ _id: sellerId, isVendor: true, vendorStatus: 'approved' })) throw failure(409, 'A selected shop is not available for ordering.');
    }
    if (requireAvailable) {
        for (const product of products) {
            if (inventory.getAvailableQuantity(product) < productQuantities.get(String(product._id))) throw failure(409, 'There is not enough available stock for the combined basket.');
        }
        for (const offer of offers.filter(row => offerQuantities.has(String(row._id)))) {
            if (inventory.getAvailableQuantity(offer) < offerQuantities.get(String(offer._id))) throw failure(409, 'There is not enough available stock for a selected offer.');
        }
    }
    return { items: result, sellers };
}
function rule(input) {
    if (!input || input.timeZone !== 'Africa/Lagos' || !['weekly', 'fortnightly', 'monthly'].includes(input.frequency) || !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw failure(400, 'Choose a valid weekly, fortnightly or monthly plan in Africa/Lagos.');
    const start = new Date(`${input.startDate}T09:00:00+01:00`);
    if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== input.startDate || start <= new Date() || start > new Date(Date.now() + 366 * 86400000)) throw failure(400, 'Choose a valid future start date within one year.');
    return { timeZone: 'Africa/Lagos', frequency: input.frequency, startDate: input.startDate };
}
function occurrenceDate(rule, index) {
    const start = new Date(`${rule.startDate}T09:00:00+01:00`);
    if (rule.frequency !== 'monthly') { start.setUTCDate(start.getUTCDate() + index * (rule.frequency === 'weekly' ? 7 : 14)); return start; }
    const day = start.getUTCDate();
    start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() + index);
    const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    start.setUTCDate(Math.min(day, lastDay)); return start;
}
async function transaction(callback) {
    const session = await mongoose.startSession();
    try { let result; await session.withTransaction(async () => { result = await callback(session); }); return result; }
    finally { await session.endSession(); }
}
async function generate(planId) {
    return transaction(async session => {
        const plan = await RecurringPlan.findById(planId).session(session);
        if (!plan || plan.state !== 'active' || plan.nextGenerateAt > new Date()) return;
        // Skip missed cycles without creating an unbounded backlog or future purchases.
        let sequence = plan.nextIndex;
        let startAt = occurrenceDate(plan.rule, sequence);
        while (startAt.getTime() + 86400000 <= Date.now()) { sequence++; startAt = occurrenceDate(plan.rule, sequence); }
        const reminderAt = new Date(startAt.getTime() - plan.reminderLeadDays * 86400000);
        if (reminderAt <= new Date()) {
            await RecurringOccurrence.updateOne({ plan: plan._id, sequence }, { $setOnInsert: {
                owner: plan.owner, startAt, reminderAt, expiresAt: new Date(startAt.getTime() + 86400000),
                items: plan.items.map(row => row.toObject()), destination: plan.destination.toObject(),
                state: startAt <= new Date() ? 'awaiting_review' : 'upcoming', revision: 0,
            } }, { upsert: true, session, runValidators: true });
            sequence++;
        }
        plan.nextIndex = sequence;
        plan.nextGenerateAt = new Date(occurrenceDate(plan.rule, sequence).getTime() - plan.reminderLeadDays * 86400000);
        await plan.save({ session });
    });
}
async function advance() {
    if (!enabled()) return;
    await GroupOrder.updateMany({ state: 'open', closesAt: { $lte: new Date() } }, { $set: { state: 'closed' }, $inc: { revision: 1 }, $unset: { approval: 1 } });
    const due = await RecurringPlan.find({ state: 'active', nextGenerateAt: { $lte: new Date() } }).select('_id').limit(30).lean();
    for (const plan of due) await generate(plan._id);
    await RecurringOccurrence.updateMany({ state: 'upcoming', startAt: { $lte: new Date() }, expiresAt: { $gt: new Date() } }, { $set: { state: 'awaiting_review' }, $inc: { revision: 1 } });
    await RecurringOccurrence.updateMany({ state: { $in: ['upcoming', 'awaiting_review', 'needs_attention'] }, expiresAt: { $lte: new Date() } }, { $set: { state: 'missed' }, $inc: { revision: 1 }, $unset: { approval: 1 } });
}
function groupView(group, user) {
    const owner = String(group.owner) === String(user);
    return { id: group._id, name: group.name, sellerName: group.sellerName, state: group.state, revision: group.revision,
        closesAt: group.closesAt, participantLimit: group.participantLimit, memberCount: group.members.length, isOwner: owner,
        members: group.members.map(member => ({ isYou: String(member.user) === String(user), items: member.items })),
        ...(owner ? { destination: group.destination, orderId: group.orderId } : {}),
    };
}
function planView(plan) {
    const value = plan.toObject ? plan.toObject() : { ...plan };
    delete value.checkoutRevision; return { ...value, id: plan._id };
}
function occurrenceView(row) {
    const value = row.toObject ? row.toObject() : { ...row };
    delete value.approval; delete value.reminderLeaseUntil; return value;
}
function consolidate(rows) {
    const result = new Map();
    for (const row of rows) {
        const key = JSON.stringify([String(row.product), String(row.offer || ''), row.selectedSize || '', row.customerNote || '']);
        const existing = result.get(key);
        if (existing) existing.quantity += row.quantity;
        else result.set(key, { product: String(row.product), offer: row.offer ? String(row.offer) : undefined, quantity: row.quantity, selectedSize: row.selectedSize || '', customerNote: row.customerNote || '' });
    }
    if (!result.size || result.size > 100 || [...result.values()].some(row => row.quantity > 1000)) throw failure(400, 'The combined basket is empty or too large.');
    return [...result.values()];
}
module.exports = { failure, enabled, hash, token, id, revision, name, destination, items, rule, occurrenceDate, transaction, generate, advance, groupView, planView, occurrenceView, consolidate };
