const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPickupSequence,
  evaluateDispatchReadiness,
} = require('../services/orderDispatchReadinessService');

const shipment = (id, overrides = {}) => ({
  _id: id,
  sellerType: 'vendor',
  sellerId: `seller-${id}`,
  sellerName: `Vendor ${id}`,
  fulfillmentMethod: 'delivery',
  shipmentStatus: 'processing',
  vendorLocation: {
    latitude: 9.0 + Number(id),
    longitude: 7.0 + Number(id),
    formattedAddress: `Pickup ${id}`,
  },
  ...overrides,
});

test('single-vendor accepted offers preserve the existing dispatch behavior', () => {
  const readiness = evaluateDispatchReadiness([
    shipment('1', { shipmentStatus: 'accepted' }),
  ]);

  assert.equal(readiness.requiredShipmentCount, 1);
  assert.equal(readiness.readyShipmentCount, 0);
  assert.equal(readiness.readyForDispatch, true);
});

test('multi-vendor orders wait for every required delivery shipment to be ready', () => {
  const partial = evaluateDispatchReadiness([
    shipment('1', { shipmentStatus: 'ready_for_pickup' }),
    shipment('2', { shipmentStatus: 'accepted' }),
  ]);
  assert.equal(partial.isMultiVendor, true);
  assert.equal(partial.readyShipmentCount, 1);
  assert.equal(partial.readyForDispatch, false);

  const complete = evaluateDispatchReadiness([
    shipment('1', { shipmentStatus: 'ready_for_pickup' }),
    shipment('2', { shipmentStatus: 'ready_for_pickup' }),
  ]);
  assert.equal(complete.readyForDispatch, true);
});

test('three-vendor readiness is blocked until the final vendor is ready', () => {
  const shipments = [
    shipment('1', { shipmentStatus: 'ready_for_pickup' }),
    shipment('2', { shipmentStatus: 'ready_for_pickup' }),
    shipment('3', { shipmentStatus: 'accepted' }),
  ];
  assert.equal(evaluateDispatchReadiness(shipments).readyForDispatch, false);

  shipments[2].shipmentStatus = 'ready_for_pickup';
  assert.equal(evaluateDispatchReadiness(shipments).readyForDispatch, true);
});

test('rejected, cancelled, and returned deliveries do not block remaining ready shipments', () => {
  const readiness = evaluateDispatchReadiness([
    shipment('1', { shipmentStatus: 'ready_for_pickup' }),
    shipment('2', { shipmentStatus: 'ready_for_pickup' }),
    shipment('3', { shipmentStatus: 'cancelled' }),
  ]);

  assert.equal(readiness.requiredShipmentCount, 2);
  assert.equal(readiness.cancelledShipmentCount, 1);
  assert.equal(readiness.readyForDispatch, true);
});

test('customer pickup shipments do not become rider pickup stops', () => {
  const readiness = evaluateDispatchReadiness([
    shipment('1', { shipmentStatus: 'ready_for_pickup' }),
    shipment('2', { fulfillmentMethod: 'pickup', shipmentStatus: 'processing' }),
  ]);

  assert.equal(readiness.requiredShipmentCount, 1);
  assert.equal(readiness.readyForDispatch, true);
});

test('pickup sequence is deterministic, snapshots locations, and is idempotent', () => {
  const shipments = [
    shipment('1', { shipmentStatus: 'ready_for_pickup' }),
    shipment('2', { shipmentStatus: 'ready_for_pickup' }),
    shipment('2', { shipmentStatus: 'ready_for_pickup' }),
    shipment('3', { shipmentStatus: 'cancelled' }),
  ];

  const first = buildPickupSequence(shipments);
  const repeated = buildPickupSequence(shipments);
  assert.deepEqual(first, repeated);
  assert.deepEqual(first.map((stop) => stop.sequence), [1, 2]);
  assert.deepEqual(first.map((stop) => stop.shipment), ['1', '2']);
  assert.equal(first[0].formattedAddress, 'Pickup 1');
  assert.equal(first[1].latitude, 11);
});

test('legacy orders without shipments safely produce an empty sequence and remain non-dispatchable', () => {
  assert.deepEqual(buildPickupSequence([]), []);
  assert.equal(evaluateDispatchReadiness([]).readyForDispatch, false);
});
