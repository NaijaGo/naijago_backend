'use strict';
const { randomInt, randomUUID } = require('node:crypto');
const { dispatchEligibilityFilter, id, fail } = require('../utils/orderPlanningPolicy');

// Admin HTTP and socket entry points share these transactions. Notify only
// AFTER commit: a failed shipment/delivery write must leave no rider offer.
function createAdminDispatchService({ MainOrder, Shipment, Rider, Company, CompanyRider, CompanyDelivery, connection, now = () => new Date() }) {
    const available = (orderId) => dispatchEligibilityFilter({ _id: orderId, isClaimed: false,
        rider: null, assignedRider: null, company: null }, now());
    async function assignIndividual({ orderId, riderId }) {
        orderId = id(orderId); riderId = id(riderId);
        return connection.transaction(async (session) => {
            const rider = await Rider.findOne({ _id: riderId, status: 'approved', isActive: true,
                activeDeliveries: { $lt: 5 } }).session(session);
            if (!rider) fail('RIDER_UNAVAILABLE', 'An approved active rider with available capacity is required.', 409);
            const shipments = await Shipment.find({ mainOrder: orderId, fulfillmentMethod: { $ne: 'pickup' },
                shipmentStatus: 'ready_for_pickup', isClaimed: false, company: null,
                assignedRider: null, assignmentRejectedBy: { $ne: riderId } }).session(session);
            if (!shipments.length) fail('SHIPMENT_UNAVAILABLE', 'No unclaimed ready delivery shipments are available.', 409);
            const assignedAt = now();
            const order = await MainOrder.findOneAndUpdate(available(orderId), { $set: {
                assignedRider: riderId, assignedAt, shipmentStatus: 'ready_for_pickup',
            }, $pull: { assignmentRejectedBy: riderId } }, { new: true, session })
                .populate('assignedRider', 'fullName phoneNumber plateNumber currentLocation lastActive isAvailable isActive')
                .populate('user', 'firstName lastName phoneNumber');
            if (!order) fail('ORDER_NOT_DISPATCHABLE', 'Check the order payment, delivery time and existing assignment.', 409);
            const updated = await Shipment.updateMany({ _id: { $in: shipments.map((row) => row._id) },
                mainOrder: orderId, fulfillmentMethod: { $ne: 'pickup' }, shipmentStatus: 'ready_for_pickup',
                isClaimed: false, company: null, assignedRider: null },
            { $set: { assignedRider: riderId, assignedAt } }, { session });
            if (updated.matchedCount !== shipments.length) fail('SHIPMENT_CHANGED', 'Shipment availability changed. Refresh the order.', 409);
            return order;
        });
    }
    async function assignCompany({ orderId, companyId, riderId = null }) {
        orderId = id(orderId); companyId = id(companyId); if (riderId) riderId = id(riderId);
        return connection.transaction(async (session) => {
            if (!await Company.findOne({ _id: companyId, status: 'active' }).session(session)) {
                fail('COMPANY_UNAVAILABLE', 'An active delivery company is required.', 409);
            }
            if (riderId && !await CompanyRider.findOne({ _id: riderId, company: companyId,
                status: 'active', isActive: true, 'stats.activeDeliveries': { $lt: 5 } }).session(session)) {
                fail('RIDER_UNAVAILABLE', 'Select an active rider belonging to this company with available capacity.', 409);
            }
            const shipments = await Shipment.find({ mainOrder: orderId }).populate('vendor', 'businessName').session(session);
            if (!shipments.length || shipments.some((row) => row.fulfillmentMethod === 'pickup' || row.isClaimed || row.company ||
                row.assignedRider || !['accepted', 'ready_for_pickup'].includes(row.shipmentStatus))) {
                fail('SHIPMENT_UNAVAILABLE', 'All company-delivery shipments must be accepted and unassigned; customer pickup is excluded.', 409);
            }
            const order = await MainOrder.findOneAndUpdate(available(orderId), { $set: { company: companyId } }, { new: true, session })
                .populate('user', 'firstName lastName phoneNumber');
            if (!order) fail('ORDER_NOT_DISPATCHABLE', 'Check the order payment, delivery time and existing assignment.', 409);
            const existing = await CompanyDelivery.findOne({ mainOrder: orderId,
                status: { $nin: ['cancelled', 'failed', 'delivered'] } }).session(session);
            if (existing) fail('DELIVERY_EXISTS', 'This order already has a company delivery.', 409);
            const first = shipments[0], address = order.shippingAddress;
            const [delivery] = await CompanyDelivery.create([{
                deliveryId: `CD-${randomUUID()}`, company: companyId, mainOrder: orderId, rider: riderId,
                customer: { name: [order.user?.firstName, order.user?.lastName].filter(Boolean).join(' '),
                    phoneNumber: order.user?.phoneNumber || address.phoneNumber, address: address.address },
                pickupDetails: { vendorName: first.vendor?.businessName || 'NaijaGo',
                    vendorAddress: first.vendorLocation?.formattedAddress || first.vendorLocation?.address || '',
                    pickupOTP: String(randomInt(100000, 1000000)) },
                deliveryDetails: { deliveryAddress: address.address, city: address.city, postalCode: address.postalCode,
                    deliveryOTP: String(randomInt(100000, 1000000)) },
                items: shipments.flatMap((row) => row.items.map(({ name, quantity, price }) => ({ name, quantity, price }))),
                amount: order.totalShippingPrice, status: riderId ? 'offered' : 'pending', assignedAt: riderId ? now() : null,
            }], { session });
            const updated = await Shipment.updateMany({ _id: { $in: shipments.map((row) => row._id) },
                mainOrder: orderId, isClaimed: false, company: null, assignedRider: null }, { $set: { company: companyId } }, { session });
            if (updated.matchedCount !== shipments.length) fail('SHIPMENT_CHANGED', 'Shipment availability changed. Refresh the order.', 409);
            // CompanyRider IDs must never be placed in MainOrder.rider (a Rider ref).
            return { order, delivery };
        });
    }
    return { assignIndividual, assignCompany };
}
module.exports = { createAdminDispatchService };
