const User = require('../models/User');
const notificationService = require('./notificationService');
const whatsappService = require('./whatsappService');
const { recordNotificationLog } = require('./notificationLogService');

const formatMoney = (value) => `₦${Number(value || 0).toFixed(0)}`;

const buildItemSummary = (items = []) =>
  items
    .map((item) => `${item.quantity}x ${item.name} (${formatMoney(item.price)} each)`)
    .join(', ');

const buildVendorOrderMessage = ({ order, shipment, paymentMethod = 'Payment' }) => {
  const shortOrderId = order._id.toString().slice(-8);
  const shortShipmentId = shipment._id.toString().slice(-6);
  return [
    'New paid order on NaijaGo',
    `Order: #${shortOrderId}`,
    `Shipment: #${shortShipmentId}`,
    `Items: ${buildItemSummary(shipment.items)}`,
    `Subtotal: ${formatMoney(shipment.subtotal)}`,
    `Shipping: ${formatMoney(shipment.shippingPrice)}`,
    `Payment: ${paymentMethod}`,
    'Please open your vendor dashboard and start preparing this order.',
  ].join('\n');
};

const notifyVendorOfPaidShipment = async ({
  app,
  order,
  shipment,
  paymentMethod = 'Payment',
  session,
}) => {
  const vendorId = shipment.vendor?.toString();
  if (!vendorId) return;

  const itemCount = shipment.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const title = 'New Paid Order Received';
  const message = buildVendorOrderMessage({ order, shipment, paymentMethod });
  const notificationData = {
    type: 'new_paid_order_vendor',
    orderId: order._id.toString(),
    shipmentId: shipment._id.toString(),
    subtotal: shipment.subtotal,
    itemCount,
    paymentMethod,
    timestamp: Date.now(),
  };

  const updatedVendor = await User.findByIdAndUpdate(
    vendorId,
    {
      $push: {
        notifications: {
          $each: [
            {
              type: 'new_order',
              message,
              read: false,
              relatedModel: 'Shipment',
              relatedId: shipment._id,
            },
          ],
          $position: 0,
        },
      },
    },
    { new: true, session },
  ).select('phoneNumber alternatePhoneNumber notificationPreferences');

  const notifyVendor = app?.get?.('notifyVendor');
  const preferences = updatedVendor?.notificationPreferences || {};
  const appOrderAlertsEnabled = preferences.appOrderAlerts !== false && preferences.orderUpdates !== false;
  const whatsappOrderAlertsEnabled = preferences.whatsappOrderAlerts !== false && preferences.orderUpdates !== false;
  const logBase = {
    vendor: vendorId,
    eventType: 'new_paid_order_vendor',
    order: order._id,
    shipment: shipment._id,
    title,
    message,
  };

  if (notifyVendor && appOrderAlertsEnabled) {
    notifyVendor(vendorId, {
      title,
      message,
      data: notificationData,
    });
    await recordNotificationLog({
      ...logBase,
      channel: 'app_socket',
      status: 'sent',
      recipient: vendorId,
    }, { session });
  } else {
    await recordNotificationLog({
      ...logBase,
      channel: 'app_socket',
      status: 'skipped',
      recipient: vendorId,
      errorMessage: appOrderAlertsEnabled
        ? 'Socket notifier is not configured.'
        : 'Vendor app order alerts are disabled.',
    }, { session });
  }

  try {
    if (appOrderAlertsEnabled) {
      const providerResponse = await notificationService.sendToUser(vendorId, {
        title,
        message: `New paid order #${order._id.toString().slice(-8)}: ${itemCount} item(s), ${formatMoney(shipment.subtotal)}.`,
        data: notificationData,
      });
      await recordNotificationLog({
        ...logBase,
        channel: 'push',
        status: 'sent',
        recipient: vendorId,
        providerResponse,
      }, { session });
    } else {
      await recordNotificationLog({
        ...logBase,
        channel: 'push',
        status: 'skipped',
        recipient: vendorId,
        errorMessage: 'Vendor app order alerts are disabled.',
      }, { session });
    }
  } catch (error) {
    console.error(`Vendor push notification failed for ${vendorId}:`, error.message);
    await recordNotificationLog({
      ...logBase,
      channel: 'push',
      status: 'failed',
      recipient: vendorId,
      errorMessage: error.message,
      providerResponse: error.response?.data,
    }, { session });
  }

  try {
    if (whatsappOrderAlertsEnabled) {
      const recipient = updatedVendor?.alternatePhoneNumber || updatedVendor?.phoneNumber;
      const providerResponse = await whatsappService.sendText({
        to: recipient,
        text: message,
      });
      await recordNotificationLog({
        ...logBase,
        channel: 'whatsapp',
        status: providerResponse?.skipped ? 'skipped' : 'sent',
        recipient,
        providerResponse,
        errorMessage: providerResponse?.reason,
      }, { session });
    } else {
      await recordNotificationLog({
        ...logBase,
        channel: 'whatsapp',
        status: 'skipped',
        recipient: updatedVendor?.alternatePhoneNumber || updatedVendor?.phoneNumber,
        errorMessage: 'Vendor WhatsApp order alerts are disabled.',
      }, { session });
    }
  } catch (error) {
    console.error(`Vendor WhatsApp notification failed for ${vendorId}:`, error.response?.data || error.message);
    await recordNotificationLog({
      ...logBase,
      channel: 'whatsapp',
      status: 'failed',
      recipient: updatedVendor?.alternatePhoneNumber || updatedVendor?.phoneNumber,
      errorMessage: error.message,
      providerResponse: error.response?.data,
    }, { session });
  }
};

module.exports = {
  notifyVendorOfPaidShipment,
};
