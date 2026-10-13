const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { getService, sendError } = require('../services/riderAgreementService');
const { createAgreementIdentity } = require('../middleware/riderAgreementGuard');
function createRiderAgreementRouter({ service = getService(), authenticate = createAgreementIdentity() } = {}) {
  const router = express.Router();
  router.use(authenticate);
  router.use(rateLimit({ windowMs: 60000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: req => String(req.rider._id), message: { code: 'AGREEMENT_RATE_LIMIT', message: 'Please wait before retrying.' } }));
  const wrap = action => async (req, res) => { try { res.set('Cache-Control', 'no-store'); await action(req, res); } catch (error) { sendError(res, error); } };
  router.get('/current', wrap(async (req, res) => res.json(await service.status(req.rider._id))));
  router.get('/status', wrap(async (req, res) => {
    const result = await service.status(req.rider._id);
    if (result.agreement) delete result.agreement.content;
    res.json(result);
  }));
  router.post('/accept', wrap(async (req, res) => res.json(await service.accept(req.rider._id,
    req.body, { requestId: req.id }))));
  return router;
}
module.exports = createRiderAgreementRouter();
module.exports.createRiderAgreementRouter = createRiderAgreementRouter;
