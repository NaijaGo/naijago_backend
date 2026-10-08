const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const service = require('../services/dealService');
const router = express.Router();
const adminRouter = express.Router();
const writes = rateLimit({ windowMs: 5 * 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { message: 'Too many Deal changes. Please try again later.' } });
const handle = action => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { await action(req, res); }
  catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'Another approved Deal already exists for this product offer. Pause it first.' });
    const status = error.statusCode || (['ValidationError', 'CastError'].includes(error.name) ? 400 : 500);
    res.status(status).json({ message: status < 500 ? error.message : 'Deals are temporarily unavailable. Please try again.' });
  }
};
router.get('/mine', protect, authorizeRoles('vendor'), handle(async (req, res) => {
  await service.requireVendor(req.user);
  res.json(await service.listManaged(req.query, req.user));
}));
router.post('/', protect, authorizeRoles('vendor'), writes, handle(async (req, res) => res.status(201).json({ deal: await service.create(req.body, req.user) })));
router.patch('/:id', protect, authorizeRoles('vendor'), writes, handle(async (req, res) => res.json({ deal: await service.update(req.params.id, req.body, req.user) })));
router.get('/', handle(async (req, res) => res.json(await service.listActive(req.query))));
router.get('/:id', handle(async (req, res) => {
  const result = await service.listActive({}, req.params.id);
  if (!result.deals.length) return res.status(404).json({ message: 'Active Deal not found.' });
  res.json({ deal: result.deals[0], serverTime: result.serverTime });
}));
adminRouter.use(protect, authorizeRoles('admin'));
adminRouter.get('/', handle(async (req, res) => res.json(await service.listManaged(req.query, req.user, true))));
adminRouter.patch('/:id/moderation', writes, handle(async (req, res) => res.json({ deal: await service.moderate(req.params.id, req.body, req.user) })));
module.exports = { router, adminRouter };
