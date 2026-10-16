const crypto = require('node:crypto');
const MainOrder = require('../models/MainOrder');
const {getKoraCheckoutConfig, initiateKoraPayment, validCheckoutUrl} = require('./koraPaymentService');
const {nairaToKobo} = require('../utils/koraPayment');

const fail = (message, statusCode = 409) => {throw Object.assign(new Error(message), {statusCode});};
const prepareKoraCheckout = async ({order, buyer}) => {
  const config = getKoraCheckoutConfig();
  const kobo = nairaToKobo(order.totalPrice);
  if (kobo === null) fail('A valid order total is required.', 400);
  if (!buyer?.email) fail('An email address is required for checkout.', 400);
  if (!order.paymentResult?.tx_ref) {
    // Reserve one reference before any provider request, including concurrent requests.
    const reserved = await MainOrder.findOneAndUpdate({_id: order._id, isPaid: false, totalPrice: kobo / 100,
      'paymentResult.tx_ref': {$in: [null, '']}}, {$set: {paymentResult: {
      // Keep provider-facing references compact and alphanumeric. The order is
      // linked by paymentResult and metadata; its ID need not lengthen the ref.
      provider: 'korapay', tx_ref: `NGK${crypto.randomBytes(16).toString('hex')}`,
      mode: config.mode, status: 'initiated', expectedAmount: kobo / 100, expectedAmountKobo: kobo,
      expectedCustomerEmail: buyer.email, currency: 'NGN', initiatedAt: new Date(),
    }}}, {new: true});
    order = reserved || await MainOrder.findById(order._id);
  }
  if (order?.isPaid) return {status: 'verified', orderId: order._id};
  const payment = order?.paymentResult;
  if (!payment || payment.provider !== 'korapay') fail('This order already has a payment reference. Verify the existing payment in My Orders before starting another payment.');
  if (payment.mode !== config.mode || payment.expectedAmountKobo !== kobo) fail('Payment settings or the order total changed. Contact support before paying again.');
  const result = () => ({provider: 'korapay', mode: payment.mode, orderId: order._id,
    tx_ref: payment.tx_ref, checkout_url: payment.checkoutUrl, amount: kobo / 100, amount_kobo: kobo,
    currency: 'NGN', status: 'initiated'});
  if (validCheckoutUrl(payment.checkoutUrl)) return result();
  const token = crypto.randomBytes(16).toString('hex');
  const lock = await MainOrder.findOneAndUpdate({_id: order._id, isPaid: false, totalPrice: kobo / 100,
    'paymentResult.tx_ref': payment.tx_ref, $or: [
      {'paymentResult.checkoutLeaseUntil': {$exists: false}}, {'paymentResult.checkoutLeaseUntil': {$lt: new Date()}},
    ]}, {$set: {'paymentResult.checkoutLease': token, 'paymentResult.checkoutLeaseUntil': new Date(Date.now() + 60000)}}, {new: true});
  if (!lock) fail('Checkout is being prepared. Wait a moment before trying again; do not pay twice.');
  try {
    const checkout = await initiateKoraPayment({amountNaira: kobo / 100, email: buyer.email,
      customerName: `${buyer.firstName || ''} ${buyer.lastName || ''}`.trim(), transactionRef: payment.tx_ref, orderId: order._id});
    await MainOrder.updateOne({_id: order._id, 'paymentResult.tx_ref': payment.tx_ref,
      'paymentResult.checkoutLease': token}, {$set: {'paymentResult.checkoutUrl': checkout.data.checkout_url},
      $unset: {'paymentResult.checkoutLease': '', 'paymentResult.checkoutLeaseUntil': ''}});
    payment.checkoutUrl = checkout.data.checkout_url;
    return result();
  } catch (error) {
    // Keep the same reference on timeouts; a retry may never create a second charge.
    await MainOrder.updateOne({_id: order._id, 'paymentResult.checkoutLease': token},
      {$unset: {'paymentResult.checkoutLease': '', 'paymentResult.checkoutLeaseUntil': ''}});
    throw error;
  }
};
module.exports = {prepareKoraCheckout};
