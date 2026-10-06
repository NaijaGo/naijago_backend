const TERMINAL_SHIPMENT_STATUSES = new Set(['rejected', 'cancelled', 'returned']);
const RIDER_CLAIMABLE_SHIPMENT_STATUSES = new Set(['accepted', 'ready_for_pickup']);
const MainOrder = require('../models/MainOrder');
const Shipment = require('../models/Shipment');

const isDeliveryShipment = (shipment) =>
  String(shipment?.fulfillmentMethod || 'delivery').toLowerCase() !== 'pickup';

const isCancelledOrInvalidShipment = (shipment) =>
  TERMINAL_SHIPMENT_STATUSES.has(String(shipment?.shipmentStatus || '').toLowerCase());

const getRequiredDeliveryShipments = (shipments = []) =>
  shipments.filter((shipment) => isDeliveryShipment(shipment) && !isCancelledOrInvalidShipment(shipment));

const evaluateDispatchReadiness = (shipments = []) => {
  const requiredShipments = getRequiredDeliveryShipments(shipments);
  const readyShipments = requiredShipments.filter(
    (shipment) => shipment.shipmentStatus === 'ready_for_pickup',
  );
  const claimableShipments = requiredShipments.filter((shipment) =>
    RIDER_CLAIMABLE_SHIPMENT_STATUSES.has(String(shipment.shipmentStatus || '').toLowerCase()),
  );
  const cancelledShipmentCount = shipments.filter(
    (shipment) => isDeliveryShipment(shipment) && isCancelledOrInvalidShipment(shipment),
  ).length;

  // Preserve the existing single-shipment offer flow: an accepted shipment may
  // be offered before it is ready, while rider claim remains limited to accepted
  // or ready shipments. Multi-vendor dispatch waits for every required stop.
  const readyForDispatch = requiredShipments.length === 1
    ? claimableShipments.length === 1
    : requiredShipments.length > 1 && readyShipments.length === requiredShipments.length;

  return {
    requiredShipmentCount: requiredShipments.length,
    readyShipmentCount: readyShipments.length,
    cancelledShipmentCount,
    isMultiVendor: requiredShipments.length > 1,
    readyForDispatch,
    requiredShipments,
    readyShipments,
    claimableShipments,
  };
};

const getShipmentId = (shipment) => {
  const id = shipment?._id || shipment?.shipment || shipment?.shipmentId;
  return id == null ? null : String(id);
};

const buildPickupSequence = (shipments = []) => {
  const seenShipmentIds = new Set();
  const uniqueShipments = getRequiredDeliveryShipments(shipments).filter((shipment) => {
    const shipmentId = getShipmentId(shipment);
    if (!shipmentId) return true;
    if (seenShipmentIds.has(shipmentId)) return false;
    seenShipmentIds.add(shipmentId);
    return true;
  });

  return uniqueShipments.map((shipment, index) => {
    const location = shipment.vendorLocation || {};
    const latitude = Number(location.latitude);
    const longitude = Number(location.longitude);

    return {
      sequence: index + 1,
      shipment: shipment._id || shipment.shipment || shipment.shipmentId || null,
      sellerType: shipment.sellerType || (shipment.vendor ? 'vendor' : 'naijago'),
      sellerId: shipment.sellerId || shipment.vendor || null,
      sellerName: shipment.sellerName || shipment.vendor?.businessName || 'Vendor',
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
      formattedAddress: String(
        location.formattedAddress || location.address || location.addressLine || '',
      ).trim(),
    };
  });
};

const orderShipmentsByReference = (mainOrder, shipments = []) => {
  const ids = Array.isArray(mainOrder?.shipments)
    ? mainOrder.shipments.map((shipment) => getShipmentId(shipment)).filter(Boolean)
    : [];
  const rank = new Map(ids.map((id, index) => [id, index]));

  return [...shipments].sort((left, right) => {
    const leftRank = rank.get(getShipmentId(left));
    const rightRank = rank.get(getShipmentId(right));
    if (leftRank != null && rightRank != null && leftRank !== rightRank) return leftRank - rightRank;
    if (leftRank != null && rightRank == null) return -1;
    if (rightRank != null && leftRank == null) return 1;
    const createdAtDifference = new Date(left.createdAt || 0) - new Date(right.createdAt || 0);
    if (createdAtDifference !== 0) return createdAtDifference;
    return getShipmentId(left).localeCompare(getShipmentId(right));
  });
};

const refreshMainOrderDispatchState = async ({ mainOrderId, session } = {}) => {
  let mainOrderQuery = MainOrder.findById(mainOrderId);
  if (session) mainOrderQuery = mainOrderQuery.session(session);
  const mainOrder = await mainOrderQuery;
  if (!mainOrder) return null;

  let shipmentQuery = Shipment.find({ mainOrder: mainOrder._id });
  if (session) shipmentQuery = shipmentQuery.session(session);
  const shipments = orderShipmentsByReference(mainOrder, await shipmentQuery);
  const readiness = evaluateDispatchReadiness(shipments);

  mainOrder.readyForDispatch = readiness.readyForDispatch;
  mainOrder.pickupSequence = buildPickupSequence(shipments);
  await mainOrder.save(session ? { session } : undefined);

  return { mainOrder, shipments, readiness };
};

module.exports = {
  TERMINAL_SHIPMENT_STATUSES,
  RIDER_CLAIMABLE_SHIPMENT_STATUSES,
  isDeliveryShipment,
  getRequiredDeliveryShipments,
  evaluateDispatchReadiness,
  buildPickupSequence,
  orderShipmentsByReference,
  refreshMainOrderDispatchState,
};
