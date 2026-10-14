const express = require('express');
const jwt = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');
const { createAppleAuthService } = require('../services/appleAuthService');
function createAppleRouter({ service = createAppleAuthService({ User: require('../models/User'),
  Identity: require('../models/AppleIdentity'), Challenge: require('../models/AppleAuthChallenge') }),
  sign = user => jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' }) } = {}) {
  const router = express.Router();
  router.use(rateLimit({ windowMs: 900000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }));
  const wrap = action => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await action(req, res); } catch (error) {
      const known = Number.isInteger(error.status);
      res.status(known ? error.status : error.code === 11000 ? 409 : 503).json({
        code: known ? error.code : error.code === 11000 ? 'APPLE_ACCOUNT_CONFLICT' : 'APPLE_UNAVAILABLE',
        message: known ? error.message : 'Apple sign-in could not be completed. Sign in again to verify the outcome.',
      });
    }
  };
  router.post('/challenge', wrap(async (req, res) => res.json(await service.challenge(req.body || {}))));
  router.post('/', wrap(async (req, res) => {
    const result = await service.authenticate(req.body || {});
    if (result.status) return res.status(result.status).json(result.body);
    const u = result.user;
    res.json({ token: sign(u), loginProvider: 'apple', message: 'Signed in with Apple.', user: {
      id: u._id, firstName: u.firstName || undefined, lastName: u.lastName || undefined, email: u.email,
      phoneNumber: u.phoneNumber || '', isEmailVerified: u.isEmailVerified,
      isAdmin: u.isAdmin, isVendor: u.isVendor, vendorStatus: u.vendorStatus,
    } });
  }));
  return router;
}
module.exports = { createAppleRouter };
