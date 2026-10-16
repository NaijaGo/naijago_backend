const test = require('node:test');
const assert = require('node:assert/strict');
const {withKoraEnvironment, payoutFixture} = require('./helpers/koraFixtures.cjs');
const body = () => ({amount: 100, bank_code: '044', account_number: '0000000000', account_name: 'Local Fixture', otp: '123456', wallet_type: 'vendor'});
const request = (fixture, changes = {}) => fixture.service.requestKoraWithdrawal({userId: fixture.user._id, isRider: false, body: {...body(), ...changes}});

// These are deterministic adapter tests, not proof of MongoDB transaction or
// banking behaviour. They cannot connect to MongoDB or a payment provider.
test('withdrawal commits its reservation before dispatch and processing is not completed', async () => withKoraEnvironment(async () => {
  const fixture = payoutFixture(); const result = await request(fixture);
  assert.equal(result.status, 'pending'); assert.equal(result.newBalance, 900);
  assert.equal(fixture.metrics.transfers, 1); assert.equal(fixture.user.otp, undefined);
  assert.ok(fixture.events.indexOf('commit') < fixture.events.indexOf('provider-post'));
  assert.equal(fixture.user.vendorWithdrawals[0].dispatchState, 'submitted');
}));
test('confirmed success completes exactly once without another bank transfer', async () => withKoraEnvironment(async () => {
  const fixture = payoutFixture({status: 'success'}); const result = await request(fixture);
  assert.equal(result.status, 'completed'); assert.equal(fixture.user.vendorWalletBalance, 900);
  await fixture.service.reconcileKoraWithdrawal(result.reference);
  assert.equal(fixture.metrics.transfers, 1); assert.equal(fixture.user.vendorWalletBalance, 900);
}));
test('confirmed failure refunds the reservation once across repeated notifications', async () => withKoraEnvironment(async () => {
  const fixture = payoutFixture({status: 'failed'}); const result = await request(fixture);
  assert.equal(result.status, 'failed'); assert.equal(fixture.user.vendorWalletBalance, 1000);
  for (let index = 0; index < 5; index++) await fixture.service.reconcileKoraWithdrawal(result.reference);
  assert.equal(fixture.user.vendorWalletBalance, 1000); assert.equal(fixture.metrics.transfers, 1);
}));
test('timeout and subsequent 404 neither refund nor resend an uncertain transfer', async () => withKoraEnvironment(async () => {
  const fixture = payoutFixture({timeout: true, verification: {notFound: true}});
  const result = await request(fixture);
  assert.equal(result.status, 'pending'); assert.equal(fixture.user.vendorWalletBalance, 900);
  assert.equal(fixture.user.vendorWithdrawals[0].dispatchState, 'unknown');
  await fixture.service.processPendingKoraWithdrawals();
  assert.equal(fixture.metrics.transfers, 1); assert.equal(fixture.user.vendorWalletBalance, 900);
}));
test('mismatched verified payout amount, currency or reference cannot complete or refund', async () => withKoraEnvironment(async () => {
  for (const verification of [{amount: 1}, {currency: 'USD'}, {reference: 'wrong-reference'}]) {
    const fixture = payoutFixture({status: 'success', verification}); const result = await request(fixture);
    assert.equal(result.status, 'pending'); assert.equal(fixture.user.vendorWalletBalance, 900);
  }
}));
test('disabled payouts, invalid OTP and insufficient funds cannot send a transfer', async () => withKoraEnvironment(async () => {
  let fixture = payoutFixture(); process.env.KORAPAY_PAYOUTS_ENABLED = 'false';
  await assert.rejects(request(fixture), /not enabled/);
  assert.equal(fixture.metrics.sessions, 0); assert.equal(fixture.metrics.transfers, 0);
  process.env.KORAPAY_PAYOUTS_ENABLED = 'true';
  for (const changes of [{otp: '654321'}, {amount: 1001}, {amount: '100'}, {amount: -100}, {wallet_type: 'other'}, {account_number: 'bad'}]) {
    fixture = payoutFixture(); await assert.rejects(request(fixture, changes));
    assert.equal(fixture.metrics.transfers, 0); assert.equal(fixture.user.vendorWalletBalance, 1000);
    assert.equal(fixture.user.vendorWithdrawals.length, 0);
  }
}));
test('a used OTP cannot create a second withdrawal', async () => withKoraEnvironment(async () => {
  const fixture = payoutFixture(); await request(fixture);
  await assert.rejects(request(fixture), /withdrawal code/);
  assert.equal(fixture.user.vendorWithdrawals.length, 1); assert.equal(fixture.metrics.transfers, 1);
}));
test('rider withdrawal reserves funds and waits for admin approval', async () => withKoraEnvironment(async () => {
  const fixture = payoutFixture({rider: true});
  const result = await fixture.service.requestKoraRiderWithdrawal({riderId: fixture.user._id, amount: 100});
  assert.equal(result.status, 'pending'); assert.equal(result.newBalance, 400);
  assert.equal(fixture.user.pendingEarnings, 100); assert.equal(fixture.metrics.transfers, 0);
  await fixture.service.processPendingKoraWithdrawals(); assert.equal(fixture.metrics.transfers, 0);
  const repeated = await fixture.service.requestKoraRiderWithdrawal({riderId: fixture.user._id, amount: 100});
  assert.equal(repeated.reference, result.reference); assert.equal(fixture.user.withdrawalHistory.length, 1);
}));
test('rider approval initiates one transfer but waits for provider confirmation', async () => withKoraEnvironment(async () => {
  const fixture = payoutFixture({rider: true});
  const result = await fixture.service.requestKoraRiderWithdrawal({riderId: fixture.user._id, amount: 100});
  await fixture.service.processKoraWithdrawalAdminAction({reference: result.reference, status: 'completed', adminId: 'fixture-admin'});
  assert.equal(fixture.metrics.transfers, 1); assert.equal(fixture.user.withdrawalHistory[0].status, 'pending');
  await fixture.service.processKoraWithdrawalAdminAction({reference: result.reference, status: 'completed', adminId: 'fixture-admin'});
  assert.equal(fixture.metrics.transfers, 1);
}));
test('rider rejection before dispatch refunds once and never calls the bank', async () => withKoraEnvironment(async () => {
  const fixture = payoutFixture({rider: true});
  const result = await fixture.service.requestKoraRiderWithdrawal({riderId: fixture.user._id, amount: 100});
  await fixture.service.processKoraWithdrawalAdminAction({reference: result.reference, status: 'failed', adminId: 'fixture-admin'});
  await fixture.service.processKoraWithdrawalAdminAction({reference: result.reference, status: 'failed', adminId: 'fixture-admin'});
  assert.equal(fixture.user.withdrawalHistory[0].status, 'cancelled'); assert.equal(fixture.user.walletBalance, 500);
  assert.equal(fixture.user.pendingEarnings, 0); assert.equal(fixture.metrics.transfers, 0);
}));
test('admin cannot manually fail/refund a submitted payout that is still processing', async () => withKoraEnvironment(async () => {
  const fixture = payoutFixture(); const result = await request(fixture);
  await fixture.service.processKoraWithdrawalAdminAction({reference: result.reference, status: 'failed', adminId: 'fixture-admin'});
  assert.equal(fixture.user.vendorWithdrawals[0].status, 'pending');
  assert.equal(fixture.user.vendorWalletBalance, 900); assert.equal(fixture.metrics.transfers, 1);
}));
