function inventorySaleBusinessKey({ item, orderId, shipmentId, itemIndex }) {
  const validId = value => /^[a-f\d]{24}$/i.test(String(value || ''));
  // Shipment items historically have _id:false. Their persisted array position
  // is stable: settlement never reorders or edits the order's item allocations.
  const identity = item?._id && validId(item._id)
    ? String(item._id)
    : !item?._id && Number.isSafeInteger(itemIndex) && itemIndex >= 0
      ? `line:${itemIndex}` : null;
  if (!item || typeof item !== 'object' || !validId(orderId) || !validId(shipmentId) || !identity) {
    const error = new Error('Order inventory identity requires reconciliation.');
    error.statusCode = 409;
    throw error;
  }
  return `sale:${orderId}:${shipmentId}:${identity}`;
}
module.exports = { inventorySaleBusinessKey };
