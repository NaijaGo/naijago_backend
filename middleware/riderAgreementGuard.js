const jwt = require('jsonwebtoken');
const Rider = require('../models/Rider');
const { getService, sendError, failure, validId } = require('../services/riderAgreementService');
function createAgreementIdentity({ Riders = Rider, verify = jwt.verify } = {}) {
  return async (req, res, next) => {
    try {
      const match = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
      if (!match) throw failure(401, 'RIDER_AUTH_REQUIRED', 'Sign in to review your agreement.');
      const decoded = verify(match[1], process.env.JWT_SECRET);
      if (!validId(decoded.id)) throw failure(401, 'RIDER_AUTH_REQUIRED', 'Invalid rider identity.');
      if (decoded.purpose && decoded.purpose !== 'rider_agreement') throw failure(401, 'RIDER_AUTH_REQUIRED', 'Invalid rider session.');
      if (decoded.purpose === 'rider_agreement' && decoded.aud !== 'rider-agreement') throw failure(401, 'RIDER_AUTH_REQUIRED', 'Invalid agreement session.');
      const rider = await Riders.findById(decoded.id).select('_id status').lean();
      if (!rider) throw failure(401, 'RIDER_AUTH_REQUIRED', 'Rider account not found.');
      if (!['pending', 'approved'].includes(rider.status)) throw failure(403, 'RIDER_ACCOUNT_RESTRICTED', 'This rider account is restricted.');
      req.rider = { _id: rider._id, status: rider.status };
      next();
    } catch (error) {
      if (['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) {
        return sendError(res, failure(401, 'RIDER_AUTH_REQUIRED', 'Your session expired. Sign in again.'));
      }
      sendError(res, error);
    }
  };
}
function createAgreementGuard(service = getService()) {
  return async (req, res, next) => {
    try { await service.requireAccepted(req.rider._id); next(); }
    catch (error) { sendError(res, error); }
  };
}
function agreementToken(riderId) {
  return jwt.sign({ id: String(riderId), purpose: 'rider_agreement' }, process.env.JWT_SECRET,
    { expiresIn: '2h', audience: 'rider-agreement' });
}
module.exports = { createAgreementIdentity, createAgreementGuard, agreementToken };
