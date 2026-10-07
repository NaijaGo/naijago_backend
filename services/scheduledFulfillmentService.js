const mongoose = require('mongoose');
const MainOrder = require('../models/MainOrder');
const { schedulingError } = require('../utils/schedulingTime');

// Internal boundary only. Caller must supply server-verified evidence, never a gateway/client callback.
// Stage 1 does not call this from payment settlement or change isPaid/payment amounts.
async function recordFulfillmentAttention({ orderId, expectedRevision, reason, verifiedPaymentReference, actor }) {
  if (!mongoose.isObjectIdOrHexString(orderId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 500 ||
      typeof verifiedPaymentReference !== 'string' || !verifiedPaymentReference.trim()) {
    throw schedulingError('INVALID_FULFILLMENT_REVIEW', 'Review requires a reason, reference and schedule revision.');
  }
  const order = await MainOrder.findOneAndUpdate({
    _id: orderId, 'schedule.mode': 'scheduled', 'schedule.revision': expectedRevision,
    'paymentResult.tx_ref': verifiedPaymentReference,
    mainOrderStatus: { $nin: ['completed', 'delivered', 'cancelled'] },
  }, {
    $set: { 'fulfillmentHold.active': true, 'fulfillmentHold.state': 'needs_attention',
      'fulfillmentHold.code': 'PAID_FULFILLMENT_REVIEW', 'fulfillmentHold.reason': reason.trim(),
      'schedule.state': 'needs_attention' },
    $inc: { 'schedule.revision': 1 },
    $push: { 'fulfillmentHold.history': { action: 'review_requested', reason: reason.trim(), actor,
      at: new Date(), verifiedPaymentReference } },
  }, { new: true, runValidators: true });
  if (!order) throw schedulingError('FULFILLMENT_REVIEW_CONFLICT', 'Order changed or payment reference does not match.', 409);
  return order;
}
module.exports = { recordFulfillmentAttention };
