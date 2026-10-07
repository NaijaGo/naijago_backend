const express = require('express');
const rateLimit = require('express-rate-limit');
const { protect } = require('../middleware/authMiddleware');
const User = require('../models/User');
const { GroupOrder, RecurringPlan, RecurringOccurrence } = require('../models/PlannedOrders');
const service = require('../services/plannedOrderService');
const orders = require('./orderRoutes');
const router = express.Router();
const wrap = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) { res.status(error.statusCode || 503).json({ message: error.statusCode ? error.message : 'Planned orders are temporarily unavailable. Please try again.' }); }
};
router.get('/config', (_req, res) => res.json({ groupOrderingEnabled: service.enabled(), recurringOrdersEnabled: service.enabled(), scheduledDeliveryEnabled: false, automaticPaymentsEnabled: false }));
router.use(protect, rateLimit({ windowMs: 15 * 60 * 1000, max: 120 }), async (req, res, next) => {
    if (!service.enabled()) return res.status(503).json({ code: 'PLANNED_ORDERS_DISABLED', message: 'Group and recurring orders are awaiting inventory runtime verification. Normal checkout is available.' });
    if (req.user.constructor.modelName !== 'User') return res.status(403).json({ message: 'A customer account is required.' });
    if (['POST', 'PUT'].includes(req.method) &&
        (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
        return res.status(400).json({ message: 'A valid request body is required.' });
    }
    next();
});
const changed = () => service.failure(409, 'This plan changed. Refresh it and try again.');
function pageFilter(req, base) {
    const limit = Number(req.query.limit || 20);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw service.failure(400, 'Invalid page size.');
    return { filter: { ...base, ...(req.query.before ? { _id: { $lt: service.id(req.query.before) } } : {}) }, limit };
}
async function groupFor(req, owner = false) {
    const group = await GroupOrder.findOne({ _id: service.id(req.params.id), ...(owner ? { owner: req.user._id } : { 'members.user': req.user._id }) });
    if (!group) throw service.failure(404, 'Group not found.');
    return group;
}
async function planFor(req) {
    const plan = await RecurringPlan.findOne({ _id: service.id(req.params.id), owner: req.user._id });
    if (!plan) throw service.failure(404, 'Plan not found.');
    return plan;
}
router.get('/groups', wrap(async (req, res) => {
    await service.advance();
    const { filter, limit } = pageFilter(req, { 'members.user': req.user._id });
    const rows = await GroupOrder.find(filter).sort({ _id: -1 }).limit(limit + 1);
    res.json({ groups: rows.slice(0, limit).map(row => service.groupView(row, req.user._id)), nextCursor: rows.length > limit ? String(rows[limit - 1]._id) : null });
}));
router.post('/groups', wrap(async (req, res) => {
    if (req.body.schedule?.mode && req.body.schedule.mode !== 'now') throw service.failure(400, 'Scheduled group checkout is not enabled.');
    const resolved = await service.items(req.body.items);
    const seller = resolved.sellers[0];
    if (resolved.sellers.some(row => row.sellerType !== seller.sellerType || String(row.sellerId) !== String(seller.sellerId))) throw service.failure(400, 'Group orders must use one shop.');
    const closesAt = new Date(req.body.cutoffAt), participantLimit = req.body.participantLimit;
    if (!Number.isFinite(closesAt.getTime()) || closesAt <= new Date() || closesAt > new Date(Date.now() + 7 * 86400000) || !Number.isSafeInteger(participantLimit) || participantLimit < 2 || participantLimit > 30) throw service.failure(400, 'Choose a cutoff within seven days and 2–30 participants.');
    if (await GroupOrder.countDocuments({ owner: req.user._id, state: { $in: ['open', 'closed'] } }) >= 20) throw service.failure(400, 'Close or cancel an existing group before creating another.');
    const inviteToken = service.token();
    const vendor = seller.sellerId ? await User.findById(seller.sellerId).select('businessName').lean() : null;
    const group = await GroupOrder.create({ owner: req.user._id, name: service.name(req.body.name), ...seller, sellerName: vendor?.businessName || 'NaijaGo', destination: service.destination(req.body.destination), members: [{ user: req.user._id, items: resolved.items }], closesAt, participantLimit, inviteHash: service.hash(inviteToken) });
    res.status(201).json({ group: service.groupView(group, req.user._id), inviteToken });
}));
router.post('/groups/join', wrap(async (req, res) => {
    if (typeof req.body.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(req.body.token)) throw service.failure(400, 'Invalid invitation code.');
    const inviteHash = service.hash(req.body.token);
    const group = await GroupOrder.findOneAndUpdate({ inviteHash, state: 'open', closesAt: { $gt: new Date() }, 'members.user': { $ne: req.user._id }, $expr: { $lt: [{ $size: '$members' }, '$participantLimit'] } }, { $push: { members: { user: req.user._id, items: [] } }, $inc: { revision: 1 }, $unset: { approval: 1 } }, { new: true });
    if (group) return res.json(service.groupView(group, req.user._id));
    const existing = await GroupOrder.findOne({ inviteHash, state: 'open', closesAt: { $gt: new Date() }, 'members.user': req.user._id });
    if (!existing) throw service.failure(409, 'Invitation expired, group closed or participant limit reached.');
    res.json(service.groupView(existing, req.user._id));
}));
router.get('/groups/:id', wrap(async (req, res) => { await service.advance(); res.json(service.groupView(await groupFor(req), req.user._id)); }));
router.post('/groups/:id/invite', wrap(async (req, res) => {
    const inviteToken = service.token();
    const group = await GroupOrder.findOneAndUpdate({ _id: service.id(req.params.id), owner: req.user._id, state: 'open', closesAt: { $gt: new Date() }, revision: service.revision(req.body.revision) }, { $set: { inviteHash: service.hash(inviteToken) }, $inc: { revision: 1 } }, { new: true });
    if (!group) throw changed();
    res.json({ group: service.groupView(group, req.user._id), inviteToken });
}));
router.put('/groups/:id/items', wrap(async (req, res) => {
    const group = await groupFor(req);
    const basket = Array.isArray(req.body.items) && !req.body.items.length ? [] : (await service.items(req.body.items, group)).items;
    const updated = await GroupOrder.findOneAndUpdate({ _id: group._id, 'members.user': req.user._id, state: 'open', closesAt: { $gt: new Date() }, revision: service.revision(req.body.revision) }, { $set: { 'members.$.items': basket }, $inc: { revision: 1 }, $unset: { approval: 1 } }, { new: true });
    if (!updated) throw changed();
    res.json(service.groupView(updated, req.user._id));
}));
router.post('/groups/:id/control', wrap(async (req, res) => {
    const action = req.body.action;
    if (!['close', 'cancel'].includes(action)) throw service.failure(400, 'Invalid group action.');
    const group = await GroupOrder.findOneAndUpdate({ _id: service.id(req.params.id), owner: req.user._id, state: { $in: action === 'cancel' ? ['open', 'closed'] : ['open'] }, revision: service.revision(req.body.revision) }, { $set: { state: action === 'cancel' ? 'cancelled' : 'closed' }, $inc: { revision: 1 }, $unset: { approval: 1 } }, { new: true });
    if (!group) throw changed();
    res.json(service.groupView(group, req.user._id));
}));
router.get('/recurring', wrap(async (req, res) => {
    await service.advance();
    const { filter, limit } = pageFilter(req, { owner: req.user._id });
    const rows = await RecurringPlan.find(filter).sort({ _id: -1 }).limit(limit + 1);
    res.json({ plans: rows.slice(0, limit).map(service.planView), nextCursor: rows.length > limit ? String(rows[limit - 1]._id) : null });
}));
router.post('/recurring', wrap(async (req, res) => {
    const rule = service.rule(req.body.rule), basket = (await service.items(req.body.items)).items;
    const reminderLeadDays = req.body.reminderLeadDays ?? 1;
    if (!Number.isSafeInteger(reminderLeadDays) || reminderLeadDays < 1 || reminderLeadDays > 7 || req.body.substitutionPreference && req.body.substitutionPreference !== 'do_not_replace') throw service.failure(400, 'Choose 1–7 reminder days; substitutions are not supported.');
    if (await RecurringPlan.countDocuments({ owner: req.user._id, state: { $ne: 'cancelled' } }) >= 20) throw service.failure(400, 'You can have up to 20 active or paused plans.');
    const plan = await RecurringPlan.create({ owner: req.user._id, name: service.name(req.body.name), items: basket, destination: service.destination(req.body.destination), rule, reminderLeadDays, nextGenerateAt: new Date(service.occurrenceDate(rule, 0).getTime() - reminderLeadDays * 86400000) });
    res.status(201).json(service.planView(plan));
}));
router.get('/recurring/:id', wrap(async (req, res) => {
    await service.advance();
    const plan = await planFor(req);
    const occurrences = await RecurringOccurrence.find({ plan: plan._id, owner: req.user._id }).sort({ startAt: -1 }).limit(30);
    res.json({ plan: service.planView(plan), occurrences: occurrences.map(service.occurrenceView) });
}));
router.put('/recurring/:id', wrap(async (req, res) => {
    const plan = await planFor(req), basket = req.body.items ? (await service.items(req.body.items)).items : null;
    const changes = { ...(basket ? { items: basket } : {}), ...(req.body.name !== undefined ? { name: service.name(req.body.name) } : {}), ...(req.body.destination ? { destination: service.destination(req.body.destination) } : {}) };
    if (!Object.keys(changes).length) throw service.failure(400, 'No supported changes supplied.');
    const updated = await service.transaction(async session => {
        const row = await RecurringPlan.findOneAndUpdate({ _id: plan._id, owner: req.user._id, state: { $in: ['active', 'paused'] }, revision: service.revision(req.body.revision) }, { $set: changes, $inc: { revision: 1 } }, { new: true, session, runValidators: true });
        if (!row) throw changed();
        await RecurringOccurrence.updateMany({ plan: plan._id, state: 'upcoming', startAt: { $gt: new Date() } }, { $set: { ...(basket ? { items: basket } : {}), ...(changes.destination ? { destination: changes.destination } : {}) }, $inc: { revision: 1 }, $unset: { approval: 1 } }, { session });
        return row;
    });
    res.json(service.planView(updated));
}));
router.post('/recurring/:id/control', wrap(async (req, res) => {
    const next = { pause: 'paused', resume: 'active', cancel: 'cancelled' }[req.body.action];
    if (!next) throw service.failure(400, 'Invalid plan action.');
    const plan = await service.transaction(async session => {
        const row = await RecurringPlan.findOneAndUpdate({ _id: service.id(req.params.id), owner: req.user._id, revision: service.revision(req.body.revision), state: { $in: req.body.action === 'resume' ? ['paused'] : req.body.action === 'pause' ? ['active'] : ['active', 'paused'] } }, { $set: { state: next }, $inc: { revision: 1 } }, { new: true, session });
        if (!row) throw changed();
        if (next === 'cancelled') await RecurringOccurrence.updateMany({ plan: row._id, state: { $in: ['upcoming', 'awaiting_review', 'needs_attention'] } }, { $set: { state: 'skipped' }, $inc: { revision: 1 }, $unset: { approval: 1 } }, { session });
        return row;
    });
    res.json(service.planView(plan));
}));
router.post('/occurrences/:id/control', wrap(async (req, res) => {
    if (req.body.action !== 'skip') throw service.failure(400, 'Only skipping an unpaid occurrence is supported.');
    const row = await RecurringOccurrence.findOneAndUpdate({ _id: service.id(req.params.id), owner: req.user._id, revision: service.revision(req.body.revision), state: { $in: ['upcoming', 'awaiting_review', 'needs_attention'] } }, { $set: { state: 'skipped' }, $inc: { revision: 1 }, $unset: { approval: 1 } }, { new: true });
    if (!row) throw changed();
    res.json(service.occurrenceView(row));
}));

// Execute the same real handlers used by /api/orders; there is no alternate
// price, inventory mutation, provider verification or scheduled payment path.
async function invoke(handler, request) {
    let status = 200, body;
    const response = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
    await handler(request, response);
    if (status >= 400 || !body) throw service.failure(status >= 400 ? status : 503, status < 500 && body?.message ? body.message : 'Unable to calculate or create this order right now.');
    return body;
}
const fingerprint = quote => service.hash(JSON.stringify({ total: quote.totalPrice, subtotal: quote.totalSubtotal, shipping: quote.totalShippingPrice, tax: quote.taxPrice,
    items: quote.shipmentSummaries.flatMap(summary => summary.items.map(item => ({ product: String(item.product), offer: String(item.offer || ''), size: item.selectedSize || '', quantity: item.quantity, price: item.price }))) }));
async function purchaseContext(req, kind) {
    const Model = kind === 'group' ? GroupOrder : RecurringOccurrence;
    const row = await Model.findOne({ _id: service.id(req.params.id), owner: req.user._id, revision: service.revision(req.body.revision) });
    if (!row) throw changed();
    let plan;
    if (kind === 'group') {
        if (row.state !== 'closed') throw service.failure(409, 'Close the group before reviewing its total.');
    } else {
        plan = await RecurringPlan.findOne({ _id: row.plan, owner: req.user._id, state: 'active' });
        if (!plan || !['awaiting_review', 'needs_attention'].includes(row.state) || row.startAt > new Date() || row.expiresAt <= new Date()) throw service.failure(409, 'This occurrence is not currently available for purchase.');
    }
    const basket = service.consolidate(kind === 'group' ? row.members.flatMap(member => member.items) : row.items);
    const resolved = await service.items(basket, kind === 'group' ? row : undefined, { requireAvailable: true });
    const shippingAddress = service.destination(row.destination.toObject());
    const payload = { cartItems: resolved.items.map(item => ({ ...item, product: String(item.product), offer: item.offer ? String(item.offer) : undefined })), shippingAddress, userLocation: { latitude: shippingAddress.latitude, longitude: shippingAddress.longitude }, taxPrice: 0 };
    const quote = await invoke(orders.calculateOrderSummary, { ...req, body: payload });
    if (!Number.isFinite(quote.totalPrice) || quote.totalPrice <= 0 || !Array.isArray(quote.shipmentSummaries) || !quote.shipmentSummaries.length) throw service.failure(503, 'A valid current total is unavailable.');
    return { Model, row, plan, payload, quote };
}
for (const [path, kind] of [['groups', 'group'], ['occurrences', 'occurrence']]) {
    router.post(`/${path}/:id/quote`, wrap(async (req, res) => {
        await service.advance();
        const { Model, row, quote } = await purchaseContext(req, kind), approvalToken = service.token();
        const approval = { hash: service.hash(approvalToken), fingerprint: fingerprint(quote), expiresAt: new Date(Date.now() + 15 * 60000) };
        const result = await Model.updateOne({ _id: row._id, owner: req.user._id, state: row.state, revision: row.revision }, { $set: { approval } });
        if (result.modifiedCount !== 1) throw changed();
        res.json({ quote, approvalToken, expiresAt: approval.expiresAt });
    }));
    router.post(`/${path}/:id/checkout`, wrap(async (req, res) => {
        if (typeof req.body.approvalToken !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(req.body.approvalToken)) throw service.failure(400, 'Review the current total first.');
        if (!['Card', 'Wallet'].includes(req.body.paymentMethod)) throw service.failure(400, 'Choose Card or Wallet.');
        const { Model, row, plan, payload, quote } = await purchaseContext(req, kind);
        const approvalHash = service.hash(req.body.approvalToken);
        if (!row.approval || row.approval.hash !== approvalHash || row.approval.expiresAt <= new Date() || row.approval.fingerprint !== fingerprint(quote)) throw service.failure(409, 'Prices or availability changed. Review the current total again.');
        const order = await invoke(orders.createMainOrder, { ...req, body: { ...quote, shippingAddress: payload.shippingAddress, userLocation: payload.userLocation, paymentMethod: req.body.paymentMethod }, plannedOrderContext: {
            approvedTotalKobo: Math.round(quote.totalPrice * 100),
            finalize: async ({ session, order }) => {
                if (plan) {
                    const fenced = await RecurringPlan.updateOne({ _id: plan._id, owner: req.user._id, state: 'active', revision: plan.revision }, { $inc: { checkoutRevision: 1 } }, { session });
                    if (fenced.modifiedCount !== 1) throw changed();
                }
                const result = await Model.updateOne({ _id: row._id, owner: req.user._id, revision: row.revision, state: row.state,
                    'approval.hash': approvalHash, 'approval.expiresAt': { $gt: new Date() },
                    ...(kind === 'occurrence' ? { startAt: { $lte: new Date() }, expiresAt: { $gt: new Date() } } : {}),
                }, { $set: { state: 'ordered', orderId: order._id }, $inc: { revision: 1 }, $unset: { approval: 1 } }, { session });
                if (result.modifiedCount !== 1) throw changed();
            },
        } });
        res.status(201).json({ orderId: order._id, totalPrice: order.totalPrice });
    }));
}
module.exports = router;
