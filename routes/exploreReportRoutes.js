const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const Report = require('../models/FeedReport');
const Comment = require('../models/ExploreComment');
const Video = require('../models/ExploreVideo');
const Product = require('../models/Product');
const { CarouselSlide } = require('../models/CarouselSlide');
const { objectId, text } = require('../utils/explorePolicy');
const { createFeatureReadiness } = require('../services/adminFeatureReadiness');
const ready = createFeatureReadiness({ models: [Report] });
const router = express.Router();
const wrap = work => async (req, res) => {
  try { await work(req, res); }
  catch (error) {
    const status = [400, 403, 404, 409].includes(error.status) ? error.status : 503;
    res.status(status).json({ message: status === 503 ? 'Reports are temporarily unavailable. Please retry.' : error.message });
  }
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const limit = rateLimit({ windowMs: 60000, limit: 60, keyGenerator: req => String(req.user._id), legacyHeaders: false, standardHeaders: 'draft-7' });
const writeReady = async (_req, res, next) => {
  if (await ready()) return next();
  res.status(503).json({ message: 'Report indexes require administrator preparation before changes can be saved.' });
};
router.get('/admin/reports', protect, authorizeRoles('admin'), limit, wrap(async (req, res) => {
  if (req.query.before) objectId(req.query.before, 'report cursor');
  const state = req.query.state || 'open';
  if (!['open', 'resolved', 'dismissed'].includes(state)) throw fail(400, 'Select a valid report status.');
  const rows = await Report.find({ state, ...(req.query.before ? { _id: { $lt: req.query.before } } : {}) }).sort({ _id: -1 }).limit(21).maxTimeMS(10000).lean();
  const comments = await Comment.find({ _id: { $in: rows.filter(row => row.targetType === 'comment').map(row => row.target) } }).select('text video state').lean();
  const byId = new Map(comments.map(row => [String(row._id), { body: row.text, state: row.state || 'visible' }]));
  res.json({ reports: rows.slice(0, 20).map(row => ({ ...row, comment: byId.get(String(row.target)) || null })), nextCursor: rows.length > 20 ? String(rows[19]._id) : null });
}));
router.put('/admin/reports/:id', protect, authorizeRoles('admin'), limit, writeReady, wrap(async (req, res) => {
  objectId(req.params.id, 'report');
  const input = req.body || {};
  if (!['resolved', 'dismissed'].includes(input.state) || !Number.isSafeInteger(input.revision) || input.revision < 0
    || (input.hideComment !== undefined && typeof input.hideComment !== 'boolean')) throw fail(400, 'Select a valid review and revision.');
  const resolution = text(input.resolution, 1000, 'review reason', true);
  await Report.db.transaction(async session => {
    const report = await Report.findById(req.params.id).session(session);
    if (!report) throw fail(404, 'Report not found.');
    if (report.__v !== input.revision || report.state !== 'open') throw fail(409, 'This report changed. Refresh before reviewing.');
    if (input.hideComment) {
      if (report.targetType !== 'comment' || input.state !== 'resolved') throw fail(400, 'Only resolved comment reports can hide a comment.');
      const changed = await Comment.updateOne({ _id: report.target, state: { $ne: 'hidden' } }, { $set: { state: 'hidden', moderatedBy: req.user._id, moderationReason: resolution, moderatedAt: new Date() } }, { session });
      if (!changed.matchedCount) throw fail(409, 'Comment changed or is unavailable. Refresh this report.');
    }
    report.state = input.state; report.resolution = resolution; report.reviewedBy = req.user._id; report.reviewedAt = new Date();
    report.reviewHistory.push({ actor: req.user._id, action: input.hideComment ? 'hide_comment' : input.state, reason: resolution });
    await report.save({ session });
  });
  res.json({ reviewed: true });
}));
router.post('/reports', protect, limit, writeReady, wrap(async (req, res) => {
  const input = req.body || {};
  objectId(input.target, 'reported item');
  if (!['spam', 'misleading', 'inappropriate', 'harassment', 'rights', 'other'].includes(input.reason)) throw fail(400, 'Select a report reason.');
  let exists;
  if (input.targetType === 'comment') {
    const comment = await Comment.findOne({ _id: input.target, state: { $ne: 'hidden' } }).select('video').lean();
    exists = comment && await Video.exists({ _id: comment.video, status: 'published', moderationStatus: 'approved', visibility: 'public', deletedAt: null });
  } else if (input.targetType === 'product') exists = await Product.exists({ _id: input.target, isActive: true, productStatus: 'active', moderationStatus: 'approved' });
  else if (input.targetType === 'campaign') exists = await CarouselSlide.exists({ _id: input.target, isActive: true, placement: 'explore' });
  else throw fail(400, 'Select a valid report target.');
  if (!exists) throw fail(404, 'Reported item is unavailable.');
  const identity = { reporter: req.user._id, targetType: input.targetType, target: input.target };
  try { await Report.updateOne(identity, { $setOnInsert: { ...identity, reason: input.reason, details: text(input.details, 1000, 'report details') } }, { upsert: true, runValidators: true }); }
  catch (error) { if (error.code !== 11000) throw error; }
  res.status(201).json({ message: 'Report received. The NaijaGo team will review it.' });
}));
module.exports = router;
