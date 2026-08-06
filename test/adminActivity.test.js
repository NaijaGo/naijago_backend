const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeEvent } = require('../services/adminActivityService');

test('normalizes a complete admin activity event contract', () => {
  const orderId = '64d2f40a3d9b7c1a12345678';
  const event = normalizeEvent({
    eventId: 'order:placed:123',
    eventType: 'ORDER_PLACED',
    category: 'order',
    severity: 'success',
    title: 'Order placed',
    message: 'A customer placed an order.',
    orderId,
    destination: { page: 'orders.html', params: { orderId } },
  });

  assert.equal(event.eventType, 'order_placed');
  assert.equal(event.category, 'order');
  assert.equal(String(event.order), orderId);
  assert.equal(event.destination.page, 'orders.html');
});

test('falls back to safe activity defaults', () => {
  const event = normalizeEvent({ category: 'unknown', severity: 'noisy' });
  assert.equal(event.category, 'system');
  assert.equal(event.severity, 'info');
  assert.match(event.eventId, /^system_activity:/);
});
