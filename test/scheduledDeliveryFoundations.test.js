const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { DEFAULTS } = require('../config/scheduledDelivery');
const time = require('../utils/schedulingTime');
const service = require('../services/scheduledDeliveryService');
const reservations = require('../services/deliveryReservationService');
const DeliveryWindow = require('../models/DeliveryWindow');
const DeliveryReservation = require('../models/DeliveryReservation');
const MainOrder = require('../models/MainOrder');
const Shipment = require('../models/Shipment');
const SchedulingJob = require('../models/SchedulingJob');
const AppSetting = require('../models/AppSetting');

const id = () => new mongoose.Types.ObjectId();
function fixture() {
  const startAt = new Date('2026-10-10T08:00:00Z');
  const endAt = new Date('2026-10-10T11:00:00Z');
  const timing = time.preparationTimes({ startAt, endAt, travelMinutes: 60, preparationMinutes: 30 });
  const reservation = { _id: id(), user: id(), order: id(), window: id(), state: 'confirmed',
    windowSnapshot: { serviceDate: '2026-10-10', startAt, endAt, timeZone: DEFAULTS.defaultTimeZone } };
  const order = { _id: reservation.order, user: reservation.user, isPaid: true, mainOrderStatus: 'processing',
    schedule: service.buildOrderScheduleSnapshot({ reservation, timing }) };
  return { reservation, order, config: { ...DEFAULTS, scheduledDeliveryEnabled: true },
    shipments: [{ shipmentStatus: 'ready_for_pickup', fulfillmentMethod: 'delivery' }],
    now: new Date('2026-10-10T07:15:00Z') };
}

test('defaults disable scheduling and immediate requests do not read configuration', async () => {
  assert.equal(DEFAULTS.scheduledDeliveryEnabled, false);
  assert.equal(DEFAULTS.checkoutReservationMinutes, 15);
  assert.equal(DEFAULTS.defaultTimeZone, 'Africa/Lagos');
  await service.assertImmediateOrderRequest({});
  await service.assertImmediateOrderRequest({ schedule: { mode: 'now' } });
  await assert.rejects(service.assertImmediateOrderRequest({ schedule: { mode: 'unknown' } }), { code: 'INVALID_SCHEDULE_MODE' });
  assert.equal(service.evaluateScheduledOrder({ order: fixture().order }).code, 'SCHEDULED_DELIVERY_DISABLED');
});

test('invalid configuration fails closed', () => {
  for (const minutes of [0, -1, 61, 1.5, NaN, Infinity, '15']) {
    assert.throws(() => service.normalizeConfiguration({ checkoutReservationMinutes: minutes }));
  }
  assert.throws(() => service.normalizeConfiguration({ scheduledDeliveryEnabled: 'true' }));
  assert.throws(() => service.normalizeConfiguration({ defaultTimeZone: 'UTC' }));
});

test('normal checkout rejects scheduled input both before and after an internal flag change', async (context) => {
  let stored = null;
  context.mock.method(AppSetting, 'findOne', () => ({ select: () => ({ lean: async () => stored }) }));
  await assert.rejects(service.assertImmediateOrderRequest({ schedule: { mode: 'scheduled' } }),
    { code: 'SCHEDULED_DELIVERY_DISABLED', statusCode: 409 });
  stored = { scheduledDelivery: { scheduledDeliveryEnabled: true } };
  await assert.rejects(service.assertImmediateOrderRequest({ schedule: { mode: 'scheduled' } }),
    { code: 'SCHEDULED_CHECKOUT_NOT_AVAILABLE', statusCode: 409 });
});

test('Lagos dates and boundaries are independent of host timezone', () => {
  const original = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = zone;
      assert.equal(time.calendarDate('2026-10-09T23:30:00Z'), '2026-10-10');
      assert.equal(time.localTimeToUtc('2026-10-10', '09:00').toISOString(), '2026-10-10T08:00:00.000Z');
      const overnight = time.windowBoundaries({ serviceDate: '2026-10-10', startTime: '23:00', endTime: '01:00' });
      assert.equal(overnight.endAt.toISOString(), '2026-10-11T00:00:00.000Z');
    }
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
  assert.throws(() => time.instant('2026-10-10T09:00:00'));
  assert.throws(() => time.validateServiceDate('2026-02-30'));
  assert.throws(() => time.localTimeToUtc('2026-10-10', '24:00'));
  assert.equal(time.addCalendarMonths('2028-01-31', 1), '2028-02-29');
});

test('dispatch may precede arrival window but cannot precede dispatchAt or meet/exceed deadline', () => {
  const input = fixture();
  assert.equal(service.isEligibleForDispatch(input).eligible, true);
  assert.equal(service.isEligibleForDispatch({ ...input, now: new Date('2026-10-10T06:59:59Z') }).eligible, false);
  assert.equal(service.isEligibleForDispatch({ ...input, now: input.order.schedule.dispatchDeadline }).code, 'DISPATCH_DEADLINE_PASSED');
  assert.equal(service.isEligibleForPreparation({ ...input, now: new Date('2026-10-10T06:30:00Z') }).eligible, true);
});

test('dispatch requires verified payment, confirmed owned reservation, no hold and all vendors ready', () => {
  for (const alter of [
    (input) => { input.order.isPaid = false; },
    (input) => { input.reservation.state = 'held'; },
    (input) => { input.reservation.user = id(); },
    (input) => { input.order.fulfillmentHold = { active: true }; },
    (input) => { input.order.schedule.state = 'needs_attention'; },
    (input) => { input.shipments.push({ shipmentStatus: 'accepted' }); },
    (input) => { input.shipments = []; },
    (input) => { input.order.schedule.endAt = new Date('2026-10-10T12:00:00Z'); },
  ]) {
    const input = fixture(); alter(input);
    assert.equal(service.isEligibleForDispatch(input).eligible, false);
  }
  assert.equal(service.hasDeliveryWindowBeenMissed(fixture().order, new Date('2026-10-10T11:00:00Z')), true);
});

test('window schema rejects overcapacity, fractional capacity and incorrect service date', async () => {
  const valid = { serviceDate: '2026-10-10', startAt: '2026-10-10T08:00:00Z', endAt: '2026-10-10T11:00:00Z',
    capacity: 2, reserved: 1, confirmed: 1, eligibility: { scopeKey: 'area:gwarinpa', areas: ['gwarinpa'] } };
  await new DeliveryWindow(valid).validate();
  for (const change of [{ reserved: 2 }, { capacity: 1.5 }, { reserved: -1 }, { serviceDate: '2026-10-11' }]) {
    await assert.rejects(new DeliveryWindow({ ...valid, ...change }).validate());
  }
  const indexes = DeliveryWindow.schema.indexes();
  assert.ok(indexes.some(([fields, options]) => fields['eligibility.scopeKey'] && options.unique));
});

test('legacy order/shipments get no scheduling fields and rejection preserves previous states', () => {
  assert.equal(new MainOrder().schedule, undefined);
  assert.equal(new MainOrder().fulfillmentHold, undefined);
  assert.equal(new Shipment().preparationDeadline, undefined);
  const statuses = Shipment.schema.path('shipmentStatus').enumValues;
  for (const status of ['processing', 'accepted', 'preparing', 'ready_for_pickup', 'delivered', 'cancelled', 'rejected']) {
    assert.ok(statuses.includes(status));
  }
  assert.equal(Shipment.schema.path('shipmentStatus').doValidateSync('rejected', new Shipment()), undefined);
});

test('reservation indexes preserve idempotency without TTL and exact allocations reject unsafe quantities', () => {
  const indexes = DeliveryReservation.schema.indexes();
  assert.ok(indexes.some(([fields, options]) => fields.user && fields.idempotencyKey && options.unique));
  assert.ok(indexes.every(([, options]) => options.expireAfterSeconds === undefined));
  const product = id();
  assert.equal(reservations.normalizeAllocations([{ product, quantity: 1 }, { product, quantity: 2 }])[0].quantity, 3);
  for (const quantity of [0, -1, 1.5, '1', Infinity]) {
    assert.throws(() => reservations.normalizeAllocations([{ product, quantity }]));
  }
  assert.throws(() => reservations.validateReservationOwnership({ user: id() }, id()), { code: 'RESERVATION_NOT_FOUND' });
  assert.throws(() => reservations.validateReservationRevision({ revision: 2 }, 1), { code: 'RESERVATION_CONFLICT' });
});

test('inventory foundation explicitly refuses an uncoordinated stock ledger', () => {
  assert.throws(() => reservations.assertInventoryCoordination(), { code: 'INVENTORY_COORDINATION_REQUIRED' });
});

test('vendor eligibility is server-derived and never releases scheduled preparation in Stage 1', () => {
  assert.equal(service.vendorFulfillmentEligibility({ isPaid: false }).preparationEligible, false);
  assert.equal(service.vendorFulfillmentEligibility({ isPaid: true }).preparationEligible, true);
  assert.equal(service.vendorFulfillmentEligibility(fixture().order).preparationEligible, false);
  assert.equal(service.vendorFulfillmentEligibility({ isPaid: true, fulfillmentHold: { active: true } }).preparationEligible, false);
});

test('persisted jobs require a target and have unique business keys; settings remain optional', async () => {
  await assert.rejects(new SchedulingJob({ type: 'reservation_expiry', dueAt: new Date(), nextAttemptAt: new Date(),
    businessKey: 'reservation:test:expiry', notificationBusinessKey: 'reservation:test:expiry:notice' }).validate());
  assert.ok(SchedulingJob.schema.indexes().some(([fields, options]) => fields.businessKey && options.unique));
  assert.equal(new AppSetting({ key: 'delivery_fee_settings' }).scheduledDelivery, undefined);
});
