const MainOrder = require('../models/MainOrder');

const normalize = (value) => String(value || '').trim().toLowerCase();

const evaluateFreeDeliveryCampaign = async ({
  campaign,
  userId,
  orderSubtotal,
  routeDistanceKm,
  shippingAddress,
  deliveryShipments = [],
  promoCode = '',
  now = new Date(),
  session = null,
}) => {
  if (!campaign?.enabled) return { eligible: false, reason: '' };
  if (!deliveryShipments.length) {
    return { eligible: false, reason: 'No delivery fee is applicable to this order.' };
  }
  if (campaign.startsAt && new Date(campaign.startsAt) > now) {
    return { eligible: false, reason: 'Free delivery campaign has not started.' };
  }
  if (campaign.endsAt && new Date(campaign.endsAt) < now) {
    return { eligible: false, reason: 'Free delivery campaign has ended.' };
  }
  if (Number(orderSubtotal || 0) < Number(campaign.minimumOrderAmount || 0)) {
    return { eligible: false, reason: 'Free delivery minimum order amount was not met.' };
  }
  if (campaign.maximumDistanceKm != null &&
      Number(routeDistanceKm || 0) > Number(campaign.maximumDistanceKm)) {
    return { eligible: false, reason: 'Order exceeds the campaign delivery distance.' };
  }
  if (campaign.promoCode && normalize(promoCode).toUpperCase() !== campaign.promoCode) {
    return { eligible: false, reason: 'Enter the active free delivery promo code to qualify.' };
  }
  if (campaign.customerEligibility === 'first_order') {
    let previousOrdersQuery = MainOrder.countDocuments({
      user: userId,
      mainOrderStatus: { $ne: 'cancelled' },
    });
    if (session) previousOrdersQuery = previousOrdersQuery.session(session);
    const previousOrders = await previousOrdersQuery;
    if (previousOrders > 0) {
      return { eligible: false, reason: 'This free delivery offer is for first-time customers.' };
    }
  }

  const vendorIds = (campaign.vendorIds || []).map(String);
  if (vendorIds.length && deliveryShipments.some((shipment) =>
    !vendorIds.includes(String(shipment.sellerId || shipment.vendor || '')))) {
    return { eligible: false, reason: 'Every delivery shipment must be from an eligible vendor.' };
  }

  const productIds = (campaign.productIds || []).map(String);
  const orderProductIds = deliveryShipments.flatMap((shipment) =>
    (shipment.items || []).map((item) => String(item.product || '')),
  );
  if (productIds.length && (!orderProductIds.length || orderProductIds.some((id) => !productIds.includes(id)))) {
    return { eligible: false, reason: 'Every ordered product must be eligible for this offer.' };
  }

  const areas = (campaign.areas || []).map(normalize).filter(Boolean);
  const destination = normalize([
    shippingAddress?.address,
    shippingAddress?.city,
    shippingAddress?.state,
    shippingAddress?.postalCode,
  ].filter(Boolean).join(' '));
  if (areas.length && !areas.some((area) => destination.includes(area))) {
    return { eligible: false, reason: 'Delivery location is outside the campaign areas.' };
  }

  return {
    eligible: true,
    reason: 'Free delivery campaign applied.',
  };
};

module.exports = { evaluateFreeDeliveryCampaign };
