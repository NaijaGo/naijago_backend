const mongoose = require('mongoose');
const { failure, checkUniqueIndex } = require('./riderAgreementService');
const THRESHOLD = 20, AMOUNT = 10000, OFFSET = 3600000;
function lagosDay(now = new Date()) {
  const day = new Date(now.getTime() + OFFSET).toISOString().slice(0, 10);
  const start = new Date(Date.parse(`${day}T00:00:00.000Z`) - OFFSET);
  return { day, start, end: new Date(start.getTime() + 86400000) };
}
function createRiderDailyBonusService({ Bonus, MainOrder, Rider,
  transact = action => mongoose.connection.transaction(action), now = () => new Date(),
  ready = () => checkUniqueIndex(Bonus, 'rider_bonus_day_unique') }) {
  async function completed(riderId, day, session = null) {
    return MainOrder.find({ rider: riderId, isPaid: true, isDelivered: true,
      mainOrderStatus: { $in: ['delivered', 'completed'] }, deliveredAt: { $gte: day.start, $lt: day.end } })
      .select('_id').session(session).lean();
  }
  async function progress(riderId) {
    const day = lagosDay(now());
    const orders = await completed(riderId, day);
    const claim = await Bonus.findOne({ riderId, day: day.day }).lean();
    return { success: true, day: day.day, timezone: 'Africa/Lagos', threshold: THRESHOLD,
      amount: AMOUNT, completedOrders: orders.length, eligible: orders.length >= THRESHOLD,
      approvalRequired: true, claim: claim || null };
  }
  async function request(riderId) {
    await ready();
    try { return await transact(async session => {
      const day = lagosDay(now()), orders = await completed(riderId, day, session);
      if (orders.length < THRESHOLD) throw failure(409, 'BONUS_NOT_ELIGIBLE', 'Complete 20 paid delivery orders in one Lagos calendar day before requesting your bonus.');
      const rider = await Rider.findOne({ _id: riderId, status: 'approved' }).session(session).lean();
      if (!rider) throw failure(403, 'RIDER_ACCOUNT_RESTRICTED', 'An approved rider account is required.');
      return Bonus.findOneAndUpdate({ riderId, day: day.day }, { $setOnInsert: { riderId, day: day.day,
        timezone: 'Africa/Lagos', amount: AMOUNT, threshold: THRESHOLD, state: 'pending',
        completedOrderIds: orders.map(order => order._id), requestedAt: now() } },
      { upsert: true, new: true, session, setDefaultsOnInsert: false }).lean();
    }); } catch (error) {
      if (error.code === 11000) {
        const existing = await Bonus.findOne({ riderId, day: lagosDay(now()).day }).lean();
        if (existing) return existing;
      }
      throw error;
    }
  }
  async function review(actorId, id, body) {
    if (!mongoose.isValidObjectId(id) || !['approved', 'rejected'].includes(body.state) ||
        typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.length > 500) {
      throw failure(400, 'BONUS_VALIDATION_ERROR', 'Select approve or reject and give a review reason.');
    }
    await ready();
    return transact(async session => {
      const claim = await Bonus.findById(id).session(session).lean();
      if (!claim) throw failure(404, 'BONUS_NOT_FOUND', 'Bonus request not found.');
      if (claim.state === body.state) return claim;
      if (claim.state !== 'pending') throw failure(409, 'BONUS_ALREADY_REVIEWED', 'This bonus was already reviewed.');
      if (body.state === 'approved') {
        const start = new Date(Date.parse(`${claim.day}T00:00:00.000Z`) - OFFSET);
        const orders = await completed(claim.riderId, { start, end: new Date(start.getTime() + 86400000) }, session);
        if (orders.length < THRESHOLD) throw failure(409, 'BONUS_NOT_ELIGIBLE', 'Order eligibility changed. Do not credit this bonus.');
        const credited = await Rider.findOneAndUpdate({ _id: claim.riderId, status: 'approved' },
          { $inc: { walletBalance: AMOUNT, totalEarnings: AMOUNT } }, { new: true, session });
        if (!credited) throw failure(403, 'RIDER_ACCOUNT_RESTRICTED', 'Rider account must be approved for bonus credit.');
      }
      const result = await Bonus.findOneAndUpdate({ _id: id, state: 'pending' }, { $set: {
        state: body.state, reviewedBy: actorId, reviewedAt: now(), reviewReason: body.reason.trim(),
      } }, { new: true, session }).lean();
      if (!result) throw failure(409, 'BONUS_ALREADY_REVIEWED', 'Another administrator reviewed this bonus.');
      return result;
    });
  }
  return { progress, request, review };
}
let instance;
function getBonusService() { return instance ||= createRiderDailyBonusService({ Bonus: require('../models/RiderDailyBonus'),
  MainOrder: require('../models/MainOrder'), Rider: require('../models/Rider') }); }
module.exports = { createRiderDailyBonusService, getBonusService, lagosDay, THRESHOLD, AMOUNT };
