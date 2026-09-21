'use strict';
const { assertCanPrepare } = require('../utils/orderFulfillmentPolicy');
const { canDispatch } = require('../utils/orderPlanningPolicy');
const fail = (code, message, statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode }); };

// Reused by accept, reject and status-update routes; all related writes share
// a transaction. Provider calls and socket broadcasts happen only afterward.
function createShipmentStatusService({ MainOrder, Shipment, connection, now = () => new Date() }) {
    async function transition({ shipmentId, actorId, isAdmin = false, status, reason = '' }) {
        const allowed = isAdmin ? ['accepted', 'ready_for_pickup', 'rejected', 'out_for_delivery', 'returned', 'cancelled'] : ['accepted', 'ready_for_pickup', 'rejected'];
        if (!allowed.includes(status)) fail('INVALID_STATUS', 'Choose an allowed shipment status.', 400);
        const rejection = String(reason || '').trim();
        if (status === 'rejected' && rejection.length < 5) fail('REJECTION_REASON_REQUIRED', 'Please provide a clear rejection reason.', 400);
        return connection.transaction(async session => {
            const shipment = await Shipment.findById(shipmentId).session(session);
            if (!shipment) fail('SHIPMENT_NOT_FOUND', 'Shipment not found.', 404);
            if (!isAdmin && (!shipment.vendor || String(shipment.vendor) !== String(actorId))) fail('SHIPMENT_FORBIDDEN', 'You can only update your own shipment.', 403);
            const mainOrder = await MainOrder.findById(shipment.mainOrder).session(session);
            assertCanPrepare(mainOrder, now());
            if (shipment.fulfillmentMethod === 'pickup') fail('PICKUP_WORKFLOW_REQUIRED', 'Use the Pickup Orders workflow for customer pickup orders.');
            if (['delivered', 'cancelled', 'rejected', 'returned', 'picked_up'].includes(shipment.shipmentStatus)) fail('SHIPMENT_CLOSED', 'This shipment is already closed.');
            if (['accepted', 'ready_for_pickup', 'rejected'].includes(status) && ['out_for_delivery'].includes(shipment.shipmentStatus)) fail('SHIPMENT_IN_TRANSIT', 'This shipment is already with the rider.');
            if (status === 'accepted' && shipment.shipmentStatus === 'ready_for_pickup') fail('STATUS_REGRESSION', 'A ready shipment cannot move back to accepted.');
            if (status === 'out_for_delivery' && !canDispatch(mainOrder, now())) fail('SCHEDULE_NOT_DUE', 'This order is not ready for dispatch.');
            if (mainOrder.schedule?.mode === 'scheduled' && ['rejected', 'cancelled', 'returned'].includes(status)) fail('SCHEDULE_LOCKED', 'Scheduled changes require reservation and payment reconciliation. Use support.');
            if (shipment.shipmentStatus === status) return { shipment, mainOrder, changed: false };
            shipment.shipmentStatus = status;
            if (status === 'accepted') { shipment.acceptedAt = now(); shipment.rejectionReason = undefined; }
            if (status === 'rejected') { shipment.rejectedAt = now(); shipment.rejectionReason = rejection.slice(0, 300); }
            await shipment.save({ session });
            if (status === 'ready_for_pickup') {
                const siblings = await Shipment.find({ mainOrder: mainOrder._id,
                    shipmentStatus: { $nin: ['rejected', 'cancelled', 'returned'] } }).select('shipmentStatus').session(session);
                mainOrder.shipmentStatus = siblings.length > 0 && siblings.every(row => row.shipmentStatus === 'ready_for_pickup') ? 'ready_for_pickup' : 'processing';
            }
            // Force a parent write even for acceptance/rejection. A concurrent
            // cancellation or payment review must conflict, not be overwritten.
            mainOrder.increment();
            await mainOrder.save({ session });
            return { shipment, mainOrder, changed: true };
        });
    }
    return { transition };
}
module.exports = { createShipmentStatusService };
