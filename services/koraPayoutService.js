const crypto = require('node:crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Rider = require('../models/Rider');
const {getKoraCheckoutConfig, getKoraConfig, initiateKoraTransfer, verifyKoraTransfer, listKoraBanks} = require('./koraPaymentService');
const {nairaToKobo} = require('../utils/koraPayment');

const fail = (message, statusCode = 400) => {throw Object.assign(new Error(message), {statusCode});};
const targets = [
  {Model: Rider, array: 'withdrawalHistory', balance: 'walletBalance', rider: true},
  {Model: User, array: 'vendorWithdrawals', balance: 'vendorWalletBalance', rider: false},
  {Model: User, array: 'userWithdrawals', balance: 'userWalletBalance', rider: false},
];
const locate = async (reference, session = null) => {
  if (typeof reference !== 'string' || !/^NGW_[a-f\d]{36}$/.test(reference)) return null;
  for (const target of targets) {
    const query = target.Model.findOne({[target.array]: {$elemMatch: {reference, provider: 'korapay'}}});
    if (session) query.session(session);
    const user = await query;
    if (user) return {...target, user, withdrawal: user[target.array].find(item => item.reference === reference)};
  }
  return null;
};
const isKoraWithdrawal = async reference => Boolean(await locate(reference));

const reconcileKoraWithdrawal = async reference => {
  const initial = await locate(reference);
  if (!initial || initial.withdrawal.status !== 'pending' || initial.withdrawal.dispatchState === 'awaiting_approval') return initial;
  const config = getKoraConfig();
  if (initial.withdrawal.mode !== config.mode) fail('Withdrawal mode does not match the configured Kora account.', 503);
  await initial.Model.updateOne({_id: initial.user._id, [initial.array]: {$elemMatch: {reference, status: 'pending'}}},
    {$set: {[`${initial.array}.$.lastCheckedAt`]: new Date()}});
  const verified = await verifyKoraTransfer({transactionRef: reference});
  const data = verified?.data;
  if (verified?.status !== true || !data || data.reference !== reference || data.currency !== 'NGN'
    || nairaToKobo(data.amount) !== nairaToKobo(initial.withdrawal.amount)) return initial;
  const status = String(data.status || '').toLowerCase();
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const current = await locate(reference, session);
      if (!current || current.withdrawal.status !== 'pending') {result = current; return;}
      const {user, withdrawal, array, balance, rider} = current;
      withdrawal.providerStatus = status;
      withdrawal.lastCheckedAt = new Date();
      if (['success', 'failed'].includes(status)) {
        withdrawal.status = status === 'success' ? 'completed' : 'failed';
        withdrawal.completedAt = new Date();
        if (status === 'failed') {
          // Refund only a provider-verified terminal failure, exactly once.
          user[balance] = Number((user[balance] + withdrawal.amount).toFixed(2));
          withdrawal.failureReason = 'Kora confirmed that the bank transfer failed.';
        }
        if (rider) {
          user.pendingEarnings = Math.max(0, Number(((user.pendingEarnings || 0) - withdrawal.amount).toFixed(2)));
          if (status === 'success') user.totalWithdrawn = Number(((user.totalWithdrawn || 0) + withdrawal.amount).toFixed(2));
        }
      }
      user.markModified(array);
      await user.save({session}); result = current;
    });
  } finally {await session.endSession();}
  return result;
};
const dispatchKoraWithdrawal = async reference => {
  const current = await locate(reference);
  if (!current || current.withdrawal.status !== 'pending') return current;
  if (current.withdrawal.dispatchState === 'awaiting_approval') return current;
  if (current.withdrawal.dispatchState === 'reserved' && process.env.KORAPAY_PAYOUTS_ENABLED !== 'true') return current;
  const config = getKoraConfig();
  if (current.withdrawal.mode !== config.mode) fail('Withdrawal mode does not match the configured Kora account.', 503);
  const {Model, array, user} = current;
  // Commit the dispatch claim before contacting the bank. Never auto-resubmit
  // a submitted/unknown payout, even if verification temporarily returns 404.
  const claimed = await Model.findOneAndUpdate({_id: user._id, [array]: {$elemMatch: {
    reference, provider: 'korapay', status: 'pending', dispatchState: 'reserved',
  }}}, {$set: {[`${array}.$.dispatchState`]: 'submitted', [`${array}.$.submittedAt`]: new Date()}}, {new: true});
  if (claimed) {
    const record = claimed[array].find(item => item.reference === reference);
    try {
      await initiateKoraTransfer({reference, amount: record.amount,
        bank: record.accountDetails.bankCode, account: record.accountDetails.accountNumber,
        name: claimed.fullName || `${claimed.firstName || ''} ${claimed.lastName || ''}`.trim(), email: claimed.email});
    } catch {
      // A timeout may mean that Kora already accepted the transfer.
      await Model.updateOne({_id: user._id, [array]: {$elemMatch: {reference, status: 'pending'}}},
        {$set: {[`${array}.$.dispatchState`]: 'unknown', [`${array}.$.providerStatus`]: 'verification_pending'}});
    }
  }
  try {return await reconcileKoraWithdrawal(reference);}
  catch (error) {
    console.warn('[KORA PAYOUT] Verification pending:', reference, error.code || 'provider_unavailable');
    return locate(reference);
  }
};
const requestKoraWithdrawal = async ({userId, isRider, body}) => {
  const config = getKoraCheckoutConfig();
  if (process.env.KORAPAY_PAYOUTS_ENABLED !== 'true') fail('Kora withdrawals are not enabled yet.', 503);
  const {amount, bank_code: bank, account_number: account, account_name: accountName, otp, wallet_type: type} = body;
  const kobo = nairaToKobo(amount);
  if (typeof amount !== 'number' || kobo === null || kobo < 10000) fail('Minimum withdrawal is NGN 100, with at most two decimal places.');
  if (typeof bank !== 'string' || !/^\d{3,12}$/.test(bank) || typeof account !== 'string' || !/^\d{10}$/.test(account)
    || typeof accountName !== 'string' || !accountName.trim() || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) fail('Valid bank details and a six-digit withdrawal code are required.');
  if (!isRider && !['vendor', 'user'].includes(type)) fail('Invalid wallet type.');
  const target = isRider ? targets[0] : type === 'vendor' ? targets[1] : targets[2];
  const {Model, array, balance, rider} = target;
  const reference = `NGW_${crypto.randomBytes(18).toString('hex')}`;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const user = await Model.findById(userId).session(session);
      if (!user) fail('Account not found.', 404);
      if (!rider && type === 'vendor' && !user.isVendor && user.role !== 'vendor') fail('Vendor wallet access is required.', 403);
      const expires = new Date(user.otpExpires).getTime();
      if (user.otp !== otp || !Number.isFinite(expires) || expires <= Date.now()) fail('Invalid or expired withdrawal code.', 401);
      if (!user.email) fail('An email address is required.');
      if (!Number.isFinite(user[balance]) || user[balance] * 100 + 0.00001 < kobo) fail('Insufficient wallet balance.');
      user[balance] = Number((user[balance] - amount).toFixed(2));
      user.otp = undefined; user.otpExpires = undefined;
      user[array].push({reference, amount, status: 'pending', provider: 'korapay', mode: config.mode,
        providerStatus: 'reserved', dispatchState: 'reserved', paymentMethod: 'bank_transfer', createdAt: new Date(),
        accountDetails: {bankCode: bank, bankName: String(body.bank_name || ''), accountNumber: account, accountName: accountName.trim()}});
      if (rider) user.pendingEarnings = Number(((user.pendingEarnings || 0) + amount).toFixed(2));
      await user.save({session});
    });
  } finally {await session.endSession();}
  // The reserved record and debit exist before the provider sees the request.
  let current;
  try {current = await dispatchKoraWithdrawal(reference);}
  catch (error) {console.warn('[KORA PAYOUT] Reserved withdrawal awaiting recovery:', reference, error.code || 'unavailable');}
  const user = current?.user || await Model.findById(userId);
  const record = user[array].find(item => item.reference === reference);
  return {success: true, reference, status: record.status, amount, newBalance: user[balance],
    provider: 'korapay', message: record.status === 'completed' ? 'Bank transfer confirmed.'
      : record.status === 'failed' ? 'Bank transfer failed. The amount was returned to your wallet.'
        : 'Withdrawal is being verified. Do not request the same withdrawal again.',
    estimatedArrival: record.status === 'completed' ? 'Confirmed by bank transfer provider' : 'Awaiting bank confirmation'};
};
// The rider endpoint historically requires admin approval. Preserve that policy:
// a rider request reserves funds; only the admin action authorizes dispatch.
const requestKoraRiderWithdrawal = async ({riderId, amount}) => {
  const config = getKoraCheckoutConfig();
  if (process.env.KORAPAY_PAYOUTS_ENABLED !== 'true') fail('Kora withdrawals are not enabled yet.', 503);
  if (typeof amount !== 'number' || nairaToKobo(amount) === null || amount < 100) fail('Minimum withdrawal is NGN 100, with at most two decimal places.');
  const profile = await Rider.findById(riderId).select('bankAccount');
  if (!profile) fail('Rider not found.', 404);
  const account = profile.bankAccount;
  if (!account?.bankName || !account.accountName || !/^\d{10}$/.test(account.accountNumber || '')) fail('Update your registered bank account first.');
  const banks = await listKoraBanks();
  const normalized = value => String(value || '').toLowerCase().replace(/[^a-z\d]/g, '');
  const bank = banks.find(item => normalized(item.name) === normalized(account.bankName));
  if (!bank) fail('Your registered bank could not be matched to Kora. Update your bank details before withdrawing.');
  const session = await mongoose.startSession();
  let response;
  try {
    await session.withTransaction(async () => {
      const rider = await Rider.findById(riderId).session(session);
      if (!rider) fail('Rider not found.', 404);
      const existing = rider.withdrawalHistory.find(item => item.provider === 'korapay' && item.status === 'pending');
      if (existing) {
        if (existing.amount !== amount) fail('You already have a pending withdrawal. Check its status before requesting another.');
        response = {success: true, reference: existing.reference, status: existing.status, newBalance: rider.walletBalance,
          pendingWithdrawal: existing.amount, message: 'Your existing withdrawal is pending. No second withdrawal was created.'};
        return;
      }
      if (!rider.canWithdraw(amount)) fail('Insufficient available balance.');
      if (rider.bankAccount?.accountNumber !== account.accountNumber || normalized(rider.bankAccount?.bankName) !== normalized(account.bankName)) fail('Bank details changed. Review your profile before withdrawing.');
      const reference = `NGW_${crypto.randomBytes(18).toString('hex')}`;
      rider.walletBalance = Number((rider.walletBalance - amount).toFixed(2));
      rider.pendingEarnings = Number(((rider.pendingEarnings || 0) + amount).toFixed(2));
      rider.withdrawalHistory.push({reference, amount, status: 'pending', provider: 'korapay', mode: config.mode,
        providerStatus: 'awaiting_approval', dispatchState: 'awaiting_approval', paymentMethod: 'bank_transfer',
        accountDetails: {bankCode: bank.code, bankName: bank.name, accountNumber: account.accountNumber, accountName: account.accountName}});
      await rider.save({session});
      response = {success: true, reference, status: 'pending', newBalance: rider.walletBalance,
        pendingWithdrawal: amount, message: 'Withdrawal request saved for admin approval. Kora will send the bank transfer after approval.'};
    });
  } finally {await session.endSession();}
  return response;
};
const processKoraWithdrawalAdminAction = async ({reference, status, adminId}) => {
  if (!['completed', 'failed'].includes(status)) fail('Choose approval or rejection.');
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await locate(reference, session);
      if (!current || current.withdrawal.status !== 'pending' || current.withdrawal.dispatchState !== 'awaiting_approval') return;
      const {user, withdrawal, array, balance, rider} = current;
      withdrawal.processedBy = adminId;
      if (status === 'completed') {
        withdrawal.dispatchState = 'reserved'; withdrawal.providerStatus = 'reserved';
      } else {
        // No provider request is possible while awaiting approval, so this is
        // a safe pre-dispatch cancellation, distinct from an uncertain payout.
        withdrawal.status = 'cancelled'; withdrawal.completedAt = new Date();
        withdrawal.failureReason = 'Rejected before bank transfer was submitted.';
        user[balance] = Number((user[balance] + withdrawal.amount).toFixed(2));
        if (rider) user.pendingEarnings = Math.max(0, Number(((user.pendingEarnings || 0) - withdrawal.amount).toFixed(2)));
      }
      user.markModified(array); await user.save({session});
    });
  } finally {await session.endSession();}
  return dispatchKoraWithdrawal(reference);
};
let recoveryRunning = false;
const processPendingKoraWithdrawals = async () => {
  if (recoveryRunning || !process.env.KORAPAY_SECRET_KEY) return;
  recoveryRunning = true;
  try {
    for (const {Model, array} of targets) {
      // Rotate pending owners using the last attempt, including 404/timeouts.
      const candidates = await Model.aggregate([
        {$match: {[array]: {$elemMatch: {provider: 'korapay', status: 'pending', dispatchState: {$ne: 'awaiting_approval'}}}}},
        {$project: {records: {$filter: {input: '$' + array, as: 'w', cond: {$and: [
          {$eq: ['$$w.provider', 'korapay']}, {$eq: ['$$w.status', 'pending']}, {$ne: ['$$w.dispatchState', 'awaiting_approval']},
        ]}}}}},
        {$unwind: '$records'}, {$sort: {'records.lastCheckedAt': 1, 'records.createdAt': 1}}, {$limit: 20},
      ]);
      for (const {records: record} of candidates) {
        try {await dispatchKoraWithdrawal(record.reference);}
        catch (error) {
          console.warn('[KORA PAYOUT RECOVERY]', record.reference, error.code || 'unavailable');
          if (error.code === 'KORAPAY_RATE_LIMITED') return;
        }
      }
    }
  } finally {recoveryRunning = false;}
};
module.exports = {requestKoraWithdrawal, requestKoraRiderWithdrawal, processKoraWithdrawalAdminAction,
  reconcileKoraWithdrawal, processPendingKoraWithdrawals, isKoraWithdrawal};
