const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const { getService, sendError, validId, failure } = require('../services/riderAgreementService');
const { getBonusService } = require('../services/riderDailyBonusService');
function createRiderPartnershipAdminRouter({ agreements = getService(), bonuses = getBonusService(),
  Agreement = require('../models/RiderAgreement'), Policy = require('../models/RiderAgreementPolicy'),
  Acceptance = require('../models/RiderAgreementAcceptance'), Bonus = require('../models/RiderDailyBonus'),
  Rider = require('../models/Rider'),
  authenticate = protect, admin = authorizeRoles('admin') } = {}) {
  const router = express.Router();
  router.use(authenticate, admin, rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: req => String(req.user._id) }));
  const wrap = action => async (req, res) => { try { res.set('Cache-Control', 'no-store'); await action(req, res); } catch (error) { sendError(res, error); } };
  router.get('/agreements', wrap(async (req, res) => res.json({ agreements: await Agreement.find({}).sort({ createdAt: -1 }).limit(100).lean(),
    policy: await Policy.findById('rider-partnership').lean(), setup: await agreements.setupStatus() })));
  router.post('/agreements', wrap(async (req, res) => res.status(201).json({ agreement: await agreements.createDraft(req.user._id, req.body) })));
  router.put('/agreements/:id', wrap(async (req, res) => res.json({ agreement: await agreements.editDraft(req.params.id, req.body) })));
  router.post('/agreements/:id/publish', wrap(async (req, res) => res.json({ agreement: await agreements.publish(req.user._id, req.params.id, req.body) })));
  router.put('/required', wrap(async (req, res) => {
    const policy = await agreements.setRequired(req.user._id, req.body);
    await req.app.get('onRiderAgreementChanged')?.(policy);
    res.json({ policy });
  }));
  router.get('/acceptances', wrap(async (req, res) => {
    if (!validId(req.query.riderId)) throw failure(400, 'AGREEMENT_VALIDATION_ERROR', 'Select a rider ID to review acceptance history.');
    const rider = await Rider.findById(req.query.riderId)
      .select('fullName email phoneNumber plateNumber status').lean();
    if (!rider) throw failure(404, 'RIDER_NOT_FOUND', 'This Go-Rider account could not be found. Search and select the rider again.');
    const acceptances = await Acceptance.find({ riderId: req.query.riderId })
      .sort({ acceptedAt: -1 }).limit(100).lean();
    let status = null, statusError = null;
    try { status = await agreements.status(req.query.riderId); }
    catch (error) {
      // Historical records remain readable before an effective policy exists.
      // Never interpret this as acceptance or change the work eligibility guard.
      if (error.code !== 'RIDER_AGREEMENT_NOT_CONFIGURED') throw error;
      statusError = { code: error.code, message: error.message };
    }
    res.json({ rider: { _id: String(rider._id), fullName: rider.fullName,
      email: rider.email, phoneNumber: rider.phoneNumber, plateNumber: rider.plateNumber, status: rider.status },
      status, ...(statusError ? { statusError } : {}), acceptances });
  }));
  router.get('/bonuses', wrap(async (req, res) => res.json({ bonuses: await Bonus.find({ state: 'pending' })
    .sort({ requestedAt: 1 }).limit(100).populate('riderId', 'fullName plateNumber').lean() })));
  router.post('/bonuses/:id/review', wrap(async (req, res) => res.json({ bonus: await bonuses.review(req.user._id, req.params.id, req.body) })));
  return router;
}
module.exports = createRiderPartnershipAdminRouter();
module.exports.createRiderPartnershipAdminRouter = createRiderPartnershipAdminRouter;
