const ReturnRequest = require('../models/ReturnRequest');
const asyncHandler = require('../utils/asyncHandler');

exports.getReturns = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 50);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    ReturnRequest.find({ user: req.user._id }).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ReturnRequest.countDocuments({ user: req.user._id })
  ]);

  res.json({ items, page, limit, total });
});

exports.createReturn = asyncHandler(async (req, res) => {
  const { orderId, thumbnailUrl } = req.body;
  if (!orderId) return res.status(400).json({ message: 'orderId is required' });
  const newReturn = await ReturnRequest.create({ user: req.user._id, orderId, thumbnailUrl });
  res.status(201).json(newReturn);
});
