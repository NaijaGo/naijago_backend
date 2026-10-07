const express = require('express');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const AppSetting = require('../models/AppSetting');
const OperationsDigest = require('../models/OperationsDigest');
const monitor = require('../services/operationsMonitorService');
const notificationService = require('../services/notificationService');
const router = express.Router();
router.use(protect, authorizeRoles('admin'));
router.get('/settings', async (req, res) => {
  try { res.json({ settings: await monitor.getSettings(), pushConfigured: notificationService.hasAudienceConfiguration('admin') }); }
  catch (_) { res.status(503).json({ message: 'Monitoring settings are temporarily unavailable.' }); }
});
router.put('/settings', async (req, res) => {
  let settings;
  try { settings = monitor.validateSettings(req.body); }
  catch (error) { return res.status(400).json({ message: error.message }); }
  try {
    await AppSetting.findOneAndUpdate({ key: 'operations_monitor' },
      { $set: { operationsMonitor: settings, updatedBy: req.user._id } }, { upsert: true, runValidators: true, setDefaultsOnInsert: true });
    return res.json({ settings });
  } catch (_) { return res.status(503).json({ message: 'Unable to save monitoring settings.' }); }
});
router.get('/overview', async (req, res) => {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 86400000);
    const [snapshot, digests] = await Promise.all([monitor.operationalSnapshot(from, to),
      OperationsDigest.find({ status: 'completed' }).select('windowStart windowEnd snapshot priorities generator createdAt').sort({ windowEnd: -1 }).limit(10).maxTimeMS(10000).lean()]);
    res.json({ from, to, snapshot, metrics: monitor.METRICS, digests });
  } catch (_) { res.status(503).json({ message: 'Operational figures are temporarily unavailable.' }); }
});
router.get('/visitors', async (req, res) => {
  const days = Number(req.query.days || 1);
  const page = Number(req.query.page || 1);
  if (!Number.isSafeInteger(days) || days < 1 || days > 30 || !Number.isSafeInteger(page) || page < 1 || page > 1000) {
    return res.status(400).json({ message: 'Use days 1–30 and page 1–1000.' });
  }
  try { return res.json(await monitor.visitorStats(days, page)); }
  catch (_) { return res.status(503).json({ message: 'Visitor figures are temporarily unavailable.' }); }
});
module.exports = router;
