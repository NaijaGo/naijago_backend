const fs = require('node:fs/promises');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const asyncHandler = require('../utils/asyncHandler');
const cloudinary = require('../utils/cloudinary');
const User = require('../models/User');
const Product = require('../models/Product');
const ExploreVideo = require('../models/ExploreVideo');
const ExploreLike = require('../models/ExploreLike');
const ExploreComment = require('../models/ExploreComment');

const MAX_VIDEO_BYTES = 90 * 1024 * 1024;
const MAX_CAPTION_LENGTH = 500;
const MAX_COMMENT_LENGTH = 1000;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.m4v', '.3gp', '.3g2', '.avi', '.mkv', '.mpg', '.mpeg', '.wmv', '.flv']);
const userPublicFields = 'firstName lastName businessName businessLogoUrl isVendor';
const productPublicFields = 'name price imageUrls sellerType sellerId vendor isActive productStatus moderationStatus';

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validId(value) {
  return typeof value === 'string' && mongoose.Types.ObjectId.isValid(value) && String(new mongoose.Types.ObjectId(value)) === value.toLowerCase();
}

function isAdmin(user) {
  return Boolean(user?.isAdmin || user?.role === 'admin');
}

function publisherName(user) {
  return user.businessName || [user.firstName, user.lastName].filter(Boolean).join(' ') || 'NaijaGo creator';
}

async function requirePublisher(req, res, next) {
  try {
    const user = await User.findById(req.user?._id).select('_id isAdmin role isVendor vendorStatus businessName firstName lastName businessLogoUrl');
    if (!user) return res.status(401).json({ message: 'Authenticated user not found.' });
    const admin = isAdmin(user);
    const approvedVendor = user.isVendor === true && user.vendorStatus === 'approved';
    if (!admin && !approvedVendor) return res.status(403).json({ message: 'Only administrators and approved vendors can publish Explore videos.' });
    req.explorePublisher = user;
    req.explorePublisherType = admin ? 'admin' : 'vendor';
    next();
  } catch (error) {
    next(error);
  }
}

const storage = multer.diskStorage({
  destination: os.tmpdir(),
  filename: (_req, file, callback) => callback(null, `naijago-explore-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
});
const videoUpload = multer({
  storage,
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    // Mobile multipart uploads commonly use a generic MIME. The actual
    // container signature and Cloudinary video tracks are checked after upload.
    if (!VIDEO_EXTENSIONS.has(extension) || !(file.mimetype.startsWith('video/') || file.mimetype === 'application/octet-stream')) {
      const error = httpError(400, 'Choose a supported video file such as MP4, MOV, M4V, WebM, 3GP, AVI or MKV.');
      return callback(error);
    }
    callback(null, true);
  },
});
function parseVideo(req, res, next) {
  videoUpload.single('video')(req, res, (error) => {
    if (error?.code === 'LIMIT_FILE_SIZE') {
      error.statusCode = 413;
      error.message = 'This video exceeds the 90 MB upload limit. Compress it before uploading.';
    }
    else if (error && !error.statusCode) error.statusCode = 400;
    next(error);
  });
}

async function validateVideoSignature(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const extension = path.extname(filePath).toLowerCase();
    if (['.webm', '.mkv'].includes(extension)) return bytesRead >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (extension === '.avi') return bytesRead >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'AVI ';
    if (extension === '.flv') return bytesRead >= 3 && buffer.toString('ascii', 0, 3) === 'FLV';
    if (extension === '.wmv') return bytesRead >= 16 && buffer.equals(Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]));
    if (['.mpg', '.mpeg'].includes(extension)) return bytesRead >= 4 && buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1 && [0xba, 0xb3].includes(buffer[3]);
    return bytesRead >= 8 && buffer.toString('ascii', 4, 8) === 'ftyp';
  } finally {
    await handle.close();
  }
}

function publicVideo(video, liked = false) {
  const creator = video.creator || {};
  const vendor = video.vendor || null;
  const product = video.product || null;
  return {
    id: String(video._id),
    _id: String(video._id),
    videoUrl: video.videoUrl,
    thumbnailUrl: video.thumbnailUrl || null,
    caption: video.caption,
    creator: {
      id: creator._id ? String(creator._id) : String(video.creator),
      name: publisherName(creator),
      avatarUrl: creator.businessLogoUrl || null,
      type: video.creatorType,
    },
    vendor: vendor ? { id: String(vendor._id), name: publisherName(vendor), avatarUrl: vendor.businessLogoUrl || null } : null,
    product: product ? { id: String(product._id), name: product.name, price: product.price, imageUrl: product.imageUrls?.[0] || null } : null,
    likesCount: video.likesCount || 0,
    commentsCount: video.commentsCount || 0,
    viewsCount: video.viewsCount || 0,
    isLiked: liked,
    createdAt: video.createdAt,
  };
}

async function visibleVideo(id, session) {
  if (!validId(id)) throw httpError(400, 'Invalid video ID.');
  let query = ExploreVideo.findOne({ _id: id, status: 'published', visibility: 'public', moderationStatus: 'approved', deletedAt: null });
  if (session) query = query.session(session);
  const video = await query;
  if (!video) throw httpError(404, 'Explore video not found.');
  return video;
}

async function runTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } catch (error) {
    if (/Transaction numbers are only allowed|replica set|mongos/i.test(error.message || '')) {
      throw httpError(503, 'Explore interactions require a transaction-enabled MongoDB deployment.');
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

const createVideo = asyncHandler(async (req, res) => {
  const file = req.file;
  let uploaded;
  let savedVideo;
  try {
    if (!file) throw httpError(400, 'A video file is required in the video field.');
    const caption = String(req.body?.caption || '').trim();
    if (!caption) throw httpError(400, 'Caption is required.');
    if (caption.length > MAX_CAPTION_LENGTH) throw httpError(400, `Caption must be ${MAX_CAPTION_LENGTH} characters or fewer.`);

    const productId = req.body?.productId ? String(req.body.productId) : null;
    let product = null;
    if (productId) {
      if (!validId(productId)) throw httpError(400, 'Invalid product ID.');
      product = await Product.findOne({ _id: productId, isActive: true, productStatus: 'active', moderationStatus: 'approved' })
        .select('_id name price imageUrls sellerType sellerId vendor isActive productStatus moderationStatus');
      if (!product) throw httpError(404, 'Active approved product not found.');
      if (req.explorePublisherType === 'vendor' && product.sellerType === 'vendor' && String(product.sellerId || product.vendor) !== String(req.explorePublisher._id)) {
        throw httpError(403, 'Approved vendors can only link their own products.');
      }
      if (req.explorePublisherType === 'vendor' && product.sellerType !== 'vendor') {
        throw httpError(403, 'Approved vendors can only link their own products.');
      }
    }

    const productVendorId = product?.sellerType === 'vendor' ? (product.sellerId || product.vendor) : null;
    const responseVendor = req.explorePublisherType === 'vendor'
      ? req.explorePublisher
      : productVendorId ? await User.findById(productVendorId).select(userPublicFields) : null;

    if (!(await validateVideoSignature(file.path))) throw httpError(400, 'The file is not a valid supported video.');
    const cloudinaryConfig = cloudinary.config();
    if (!cloudinaryConfig.cloud_name || !cloudinaryConfig.api_key || !cloudinaryConfig.api_secret) throw httpError(503, 'Video storage is not configured.');

    try {
      uploaded = await cloudinary.uploader.upload(file.path, {
        folder: `explore/videos/${req.explorePublisher._id}`,
        resource_type: 'video',
        format: 'mp4',
        transformation: [{ video_codec: 'h264', audio_codec: 'aac' }],
        timeout: 120000,
        overwrite: false,
        use_filename: false,
      });
    } catch (_) {
      throw httpError(502, 'Video upload failed. Please try again.');
    }
    if (!uploaded.secure_url || !Number.isFinite(uploaded.duration) || uploaded.duration <= 0 || !Number.isFinite(uploaded.width) || uploaded.width <= 0 || !Number.isFinite(uploaded.height) || uploaded.height <= 0) {
      throw httpError(400, 'The file must contain a playable video track. Audio-only or damaged files cannot be published.');
    }

    savedVideo = await ExploreVideo.create({
      creator: req.explorePublisher._id,
      creatorType: req.explorePublisherType,
      vendor: req.explorePublisherType === 'vendor' ? req.explorePublisher._id : productVendorId,
      videoUrl: uploaded.secure_url,
      thumbnailUrl: cloudinary.url(uploaded.public_id, { resource_type: 'video', format: 'jpg', secure: true, transformation: [{ width: 480, height: 854, crop: 'fill', gravity: 'auto' }] }),
      cloudinaryPublicId: uploaded.public_id,
      caption,
      product: product?._id || null,
      status: 'published',
      visibility: 'public',
      moderationStatus: 'approved',
    });

    // Build the acknowledgement from records loaded before saving. A failed
    // post-save populate must not report a published video as an upload failure.
    res.status(201).json({ video: publicVideo({
      ...savedVideo.toObject(),
      creator: req.explorePublisher,
      vendor: responseVendor,
      product,
    }) });
  } catch (error) {
    if (uploaded?.public_id && !savedVideo) {
      try { await cloudinary.uploader.destroy(uploaded.public_id, { resource_type: 'video' }); } catch (_) { console.error('Explore upload cleanup failed.'); }
    }
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    console.error('Explore video request failed.');
    return res.status(500).json({ message: 'Unable to publish Explore video right now.' });
  } finally {
    if (file?.path) {
      try { await fs.unlink(file.path); } catch (_) { /* Temporary file may already be gone. */ }
    }
  }
});

const getFeed = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
  const filter = { status: 'published', visibility: 'public', moderationStatus: 'approved', deletedAt: null };
  const [videos, total] = await Promise.all([
    ExploreVideo.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('creator', userPublicFields).populate('vendor', userPublicFields)
      .populate({ path: 'product', select: 'name price imageUrls' }).lean(),
    ExploreVideo.countDocuments(filter),
  ]);
  const ids = videos.map((video) => video._id);
  const likedIds = ids.length ? await ExploreLike.find({ user: req.user._id, video: { $in: ids } }).distinct('video') : [];
  const liked = new Set(likedIds.map(String));
  res.json({ items: videos.map((video) => publicVideo(video, liked.has(String(video._id)))), page, limit, total, hasMore: page * limit < total });
});

const getMyVideos = asyncHandler(async (req, res) => {
  const page = Number(req.query.page || 1), limit = Number(req.query.limit || 50);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw httpError(400, 'Invalid video pagination.');
  }
  const filter = { creator: req.user._id, status: { $ne: 'deleted' }, deletedAt: null };
  const [videos, total] = await Promise.all([
    ExploreVideo.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('creator', userPublicFields).populate('vendor', userPublicFields)
      .populate({ path: 'product', select: 'name price imageUrls' }).lean(),
    ExploreVideo.countDocuments(filter),
  ]);
  const likedIds = videos.length ? await ExploreLike.find({ user: req.user._id, video: { $in: videos.map((video) => video._id) } }).distinct('video') : [];
  const liked = new Set(likedIds.map(String));
  res.json({ items: videos.map((video) => ({ ...publicVideo(video, liked.has(String(video._id))), status: video.status, moderationStatus: video.moderationStatus })), page, limit, total, hasMore: page * limit < total });
});

const likeVideo = asyncHandler(async (req, res) => {
  try {
    await runTransaction(async (session) => {
      await visibleVideo(req.params.videoId, session);
      const exists = await ExploreLike.findOne({ video: req.params.videoId, user: req.user._id }).session(session).select('_id').lean();
      if (exists) return;
      await ExploreLike.create([{ video: req.params.videoId, user: req.user._id }], { session });
      const update = await ExploreVideo.updateOne({ _id: req.params.videoId, status: 'published', visibility: 'public', moderationStatus: 'approved', deletedAt: null }, { $inc: { likesCount: 1 } }, { session });
      if (!update.matchedCount) throw httpError(404, 'Explore video not found.');
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
    const existingLike = await ExploreLike.exists({ video: req.params.videoId, user: req.user._id });
    if (!existingLike) throw error;
  }
  const video = await ExploreVideo.findById(req.params.videoId).select('likesCount').lean();
  res.json({ liked: true, likesCount: video?.likesCount || 0 });
});

const unlikeVideo = asyncHandler(async (req, res) => {
  await runTransaction(async (session) => {
    await visibleVideo(req.params.videoId, session);
    const deleted = await ExploreLike.findOneAndDelete({ video: req.params.videoId, user: req.user._id }, { session });
    if (!deleted) return;
    await ExploreVideo.updateOne({ _id: req.params.videoId, status: 'published', visibility: 'public', moderationStatus: 'approved', deletedAt: null }, [
      { $set: { likesCount: { $max: [{ $subtract: [{ $ifNull: ['$likesCount', 0] }, 1] }, 0] } } },
    ], { session });
  });
  const video = await ExploreVideo.findById(req.params.videoId).select('likesCount').lean();
  res.json({ liked: false, likesCount: video?.likesCount || 0 });
});

const getComments = asyncHandler(async (req, res) => {
  await visibleVideo(req.params.videoId);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const [items, total] = await Promise.all([
    ExploreComment.find({ video: req.params.videoId }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('user', userPublicFields).lean(),
    ExploreComment.countDocuments({ video: req.params.videoId }),
  ]);
  res.json({ items: items.map((comment) => ({
    id: String(comment._id),
    videoId: String(comment.video),
    user: { id: String(comment.user?._id || comment.user), name: publisherName(comment.user || {}), avatarUrl: comment.user?.businessLogoUrl || null },
    isMine: String(comment.user?._id || comment.user) === String(req.user._id),
    text: comment.text,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  })), page, limit, total, hasMore: page * limit < total });
});

const addComment = asyncHandler(async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) throw httpError(400, 'Comment text is required.');
  if (text.length > MAX_COMMENT_LENGTH) throw httpError(400, `Comments must be ${MAX_COMMENT_LENGTH} characters or fewer.`);
  const comment = await runTransaction(async (session) => {
    const video = await visibleVideo(req.params.videoId, session);
    const [created] = await ExploreComment.create([{ video: video._id, user: req.user._id, text }], { session });
    const update = await ExploreVideo.updateOne({ _id: video._id, status: 'published', deletedAt: null }, { $inc: { commentsCount: 1 } }, { session });
    if (!update.matchedCount) throw httpError(404, 'Explore video not found.');
    await created.populate({ path: 'user', select: userPublicFields, options: { session } });
    return created;
  });
  const updatedVideo = await ExploreVideo.findById(req.params.videoId).select('commentsCount').lean();
  res.status(201).json({ commentsCount: updatedVideo?.commentsCount || 0, comment: {
    id: String(comment._id), videoId: String(comment.video),
    user: { id: String(comment.user._id), name: publisherName(comment.user), avatarUrl: comment.user.businessLogoUrl || null },
    isMine: true, text: comment.text, createdAt: comment.createdAt, updatedAt: comment.updatedAt,
  } });
});

const deleteComment = asyncHandler(async (req, res) => {
  if (!validId(req.params.commentId)) throw httpError(400, 'Invalid comment ID.');
  await runTransaction(async (session) => {
    const video = await visibleVideo(req.params.videoId, session);
    const comment = await ExploreComment.findOne({ _id: req.params.commentId, video: video._id }).session(session);
    if (!comment) throw httpError(404, 'Comment not found.');
    const userIsAdmin = await User.exists({ _id: req.user._id, $or: [{ isAdmin: true }, { role: 'admin' }] }).session(session);
    if (String(comment.user) !== String(req.user._id) && !userIsAdmin) throw httpError(403, 'You may only delete your own comment.');
    await comment.deleteOne({ session });
    await ExploreVideo.updateOne({ _id: video._id }, [
      { $set: { commentsCount: { $max: [{ $subtract: [{ $ifNull: ['$commentsCount', 0] }, 1] }, 0] } } },
    ], { session });
  });
  const video = await ExploreVideo.findById(req.params.videoId).select('commentsCount').lean();
  res.json({ message: 'Comment deleted.', commentsCount: video?.commentsCount || 0 });
});

const unpublishVideo = asyncHandler(async (req, res) => {
  if (!validId(req.params.videoId)) throw httpError(400, 'Invalid video ID.');
  const video = await ExploreVideo.findOne({ _id: req.params.videoId, status: { $ne: 'deleted' }, deletedAt: null });
  if (!video) throw httpError(404, 'Explore video not found.');
  const admin = await User.exists({ _id: req.user._id, $or: [{ isAdmin: true }, { role: 'admin' }] });
  if (String(video.creator) !== String(req.user._id) && !admin) throw httpError(403, 'You may only unpublish your own Explore videos.');
  video.status = 'unpublished';
  await video.save();
  res.json({ message: 'Explore video unpublished.' });
});
const deleteVideo = asyncHandler(async (req, res) => {
  if (!validId(req.params.videoId)) throw httpError(400, 'Invalid video ID.');
  const video = await ExploreVideo.findOne({ _id: req.params.videoId, status: { $ne: 'deleted' }, deletedAt: null });
  if (!video) throw httpError(404, 'Explore video not found.');
  const admin = await User.exists({ _id: req.user._id, $or: [{ isAdmin: true }, { role: 'admin' }] });
  if (String(video.creator) !== String(req.user._id) && !admin) throw httpError(403, 'You may only remove your own Explore videos.');
  video.status = 'deleted';
  video.deletedAt = new Date();
  await video.save();
  res.json({ message: 'Explore video removed.' });
});

module.exports = {
  requirePublisher,
  parseVideo,
  createVideo,
  getFeed,
  getMyVideos,
  likeVideo,
  unlikeVideo,
  getComments,
  addComment,
  deleteComment,
  unpublishVideo,
  deleteVideo,
  publicVideo,
  httpError,
};
