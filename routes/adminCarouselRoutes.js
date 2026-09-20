const express = require('express');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const { CarouselSlide, VALID_CAROUSEL_PLACEMENTS } = require('../models/CarouselSlide');

const router = express.Router();
const MediaAsset = require('../models/MediaAsset');
const User = require('../models/User');
const cloudinary = require('../utils/cloudinary');
const { createProductVideoService } = require('../services/productVideoService');
const { campaignFields, ExploreInputError } = require('../utils/explorePolicy');
const mongoose = require('mongoose');
const { escapeRegex } = require('../utils/catalogSearch');
const videoService = createProductVideoService({ cloudinary, MediaAsset });

async function validateCampaign(body, user, placement, previousAssetId) {
  const fields = campaignFields({ ...body, placement });
  if (placement !== 'explore') return fields;
  if (fields.vendor && !await User.exists({ _id: fields.vendor, isVendor: true, vendorStatus: 'approved' })) {
    throw new ExploreInputError('Select an approved vendor for this campaign.');
  }
  if (fields.mediaKind === 'video') {
    const retained = previousAssetId && String(previousAssetId) === String(fields.videoAssetId);
    const asset = await MediaAsset.findOne({ _id: fields.videoAssetId, ...(retained ? {} : { owner: user._id }), status: 'approved', purpose: 'campaign_video' }).lean();
    if (!asset) throw new ExploreInputError('Upload and approve your campaign video before publishing.');
    fields.imageUrl = videoService.serialize(asset).posterUrl;
  }
  return fields;
}
const ADMIN_FIELDS = 'firstName lastName email';

const normalizePlacement = (value) => String(value || '').trim().toLowerCase();

const sanitizeSlidePayload = (body = {}) => {
  const placement = normalizePlacement(body.placement);
  const parsedSortOrder = Number.parseInt(body.sortOrder, 10);
  const actionType = String(body.actionType || 'none').trim().toLowerCase();
  const validActionTypes = ['none', 'restaurant', 'pharmacy', 'category', 'product', 'vendor', 'external'];

  return {
    placement,
    title: String(body.title || '').trim(),
    subtitle: String(body.subtitle || '').trim(),
    imageUrl: String(body.imageUrl || '').trim(),
    linkUrl: String(body.linkUrl || '').trim(),
    actionType: validActionTypes.includes(actionType) ? actionType : 'none',
    actionValue: String(body.actionValue || '').trim(),
    sortOrder: Number.isFinite(parsedSortOrder) ? parsedSortOrder : 0,
    isActive:
      typeof body.isActive === 'boolean'
        ? body.isActive
        : String(body.isActive || '').trim().toLowerCase() !== 'false',
  };
};

const mapAdminIdentity = (admin) => {
  if (!admin) {
    return null;
  }

  const fullName = `${admin.firstName || ''} ${admin.lastName || ''}`.trim();

  return {
    id: admin._id || null,
    name: fullName || admin.email || 'Admin',
    email: admin.email || '',
  };
};

const mapSlide = (slide) => ({
  _id: slide._id,
  id: slide._id,
  placement: slide.placement,
  advertiserName: slide.advertiserName || '',
  vendor: slide.vendor || null,
  mediaKind: slide.mediaKind || 'image',
  videoAssetId: slide.videoAssetId || null,
  startsAt: slide.startsAt || null,
  endsAt: slide.endsAt || null,
  imageRightsConfirmed: slide.imageRightsConfirmed === true,
  title: slide.title || '',
  subtitle: slide.subtitle || '',
  imageUrl: slide.imageUrl,
  linkUrl: slide.linkUrl || '',
  actionType: slide.actionType || 'none',
  actionValue: slide.actionValue || '',
  sortOrder: Number(slide.sortOrder || 0),
  isActive: Boolean(slide.isActive),
  createdAt: slide.createdAt || null,
  updatedAt: slide.updatedAt || null,
  createdBy: mapAdminIdentity(slide.createdBy),
  updatedBy: mapAdminIdentity(slide.updatedBy),
});

const buildGroupedSlidesPayload = (slides) => {
  const grouped = {
    main: [],
    promo: [],
    explore: [],
  };

  for (const slide of slides) {
    if (!VALID_CAROUSEL_PLACEMENTS.includes(slide.placement)) {
      continue;
    }

    grouped[slide.placement].push(mapSlide(slide));
  }

  return grouped;
};

const fetchSlidesForAdmin = async (placement) => {
  const filter = {};
  if (placement) {
    filter.placement = placement;
  }

  const slides = await CarouselSlide.find(filter)
    .populate('createdBy', ADMIN_FIELDS)
    .populate('updatedBy', ADMIN_FIELDS)
    .sort({ placement: 1, sortOrder: 1, updatedAt: -1, createdAt: 1 });

  return buildGroupedSlidesPayload(slides);
};

router.get('/carousel-vendors', protect, authorizeRoles('admin'), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().slice(0, 120);
    const vendors = await User.find({ isVendor: true, vendorStatus: 'approved', ...(search ? { businessName: { $regex: escapeRegex(search), $options: 'i' } } : {}) })
      .select('businessName').sort({ businessName: 1, _id: 1 }).limit(51).lean();
    res.json({ vendors: vendors.slice(0, 50), refineSearch: vendors.length > 50 });
  } catch (_) { res.status(503).json({ message: 'Unable to load vendors right now.' }); }
});

router.get('/carousel-campaigns', protect, authorizeRoles('admin'), async (req, res) => {
  if (req.query.before && !mongoose.isObjectIdOrHexString(req.query.before)) return res.status(400).json({ message: 'Invalid campaign cursor.' });
  try {
    const rows = await CarouselSlide.find({ placement: 'explore', ...(req.query.before ? { _id: { $lt: req.query.before } } : {}) })
      .sort({ _id: -1 }).limit(21).populate('createdBy', ADMIN_FIELDS).populate('updatedBy', ADMIN_FIELDS);
    const page = rows.slice(0, 20);
    const stats = await require('../services/exploreRuntime').explore.statistics(page.map((slide) => ({ type: 'campaign', id: slide._id })));
    res.json({ campaigns: page.map((slide) => ({ ...mapSlide(slide), engagement: stats.get(`campaign:${slide._id}`) })), nextCursor: rows.length > 20 ? String(rows[19]._id) : null });
  } catch (_) { res.status(503).json({ message: 'Unable to load campaigns right now.' }); }
});

router.get('/carousel-slides', protect, authorizeRoles('admin'), async (req, res) => {
  const placement = req.query?.placement
    ? normalizePlacement(req.query.placement)
    : '';

  if (placement && !VALID_CAROUSEL_PLACEMENTS.includes(placement)) {
    return res.status(400).json({ message: 'Invalid carousel placement.' });
  }

  try {
    const groupedSlides = await fetchSlidesForAdmin(placement);
    res.status(200).json(groupedSlides);
  } catch (error) {
    console.error('Error fetching admin carousel slides:', error);
    res.status(500).json({ message: 'Failed to fetch carousel slides.' });
  }
});

router.post('/carousel-slides', protect, authorizeRoles('admin'), async (req, res) => {
  const payload = sanitizeSlidePayload(req.body);

  if (!VALID_CAROUSEL_PLACEMENTS.includes(payload.placement)) {
    return res.status(400).json({ message: 'placement must be either "main" or "promo".' });
  }

  if (!payload.imageUrl) {
    return res.status(400).json({ message: 'imageUrl is required.' });
  }

  try {
    const slide = await CarouselSlide.create({
      ...payload,
      ...await validateCampaign(req.body, req.user, payload.placement),
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    const populatedSlide = await CarouselSlide.findById(slide._id)
      .populate('createdBy', ADMIN_FIELDS)
      .populate('updatedBy', ADMIN_FIELDS);

    res.status(201).json({
      message: 'Carousel slide created successfully.',
      slide: mapSlide(populatedSlide),
    });
  } catch (error) {
    if (error instanceof ExploreInputError) return res.status(400).json({ message: error.message });
    console.error('Error creating carousel slide:', error);
    res.status(500).json({ message: 'Failed to create carousel slide.' });
  }
});

router.put('/carousel-slides/:slideId', protect, authorizeRoles('admin'), async (req, res) => {
  const payload = sanitizeSlidePayload(req.body);

  if (!VALID_CAROUSEL_PLACEMENTS.includes(payload.placement)) {
    return res.status(400).json({ message: 'placement must be either "main" or "promo".' });
  }

  if (!payload.imageUrl) {
    return res.status(400).json({ message: 'imageUrl is required.' });
  }

  try {
    if (!mongoose.isObjectIdOrHexString(req.params.slideId)) return res.status(400).json({ message: 'Invalid campaign.' });
    const previous = await CarouselSlide.findById(req.params.slideId).select('videoAssetId').lean();
    if (!previous) return res.status(404).json({ message: 'Carousel slide not found.' });
    const campaign = await validateCampaign(req.body, req.user, payload.placement, previous.videoAssetId);
    const slide = await CarouselSlide.findByIdAndUpdate(
      req.params.slideId,
      {
        $set: {
          ...payload,
          ...campaign,
          updatedBy: req.user._id,
        },
      },
      {
        new: true,
        runValidators: true,
      },
    )
      .populate('createdBy', ADMIN_FIELDS)
      .populate('updatedBy', ADMIN_FIELDS);

    if (!slide) {
      return res.status(404).json({ message: 'Carousel slide not found.' });
    }

    res.status(200).json({
      message: 'Carousel slide updated successfully.',
      slide: mapSlide(slide),
    });
  } catch (error) {
    if (error instanceof ExploreInputError) return res.status(400).json({ message: error.message });
    console.error('Error updating carousel slide:', error);
    res.status(500).json({ message: 'Failed to update carousel slide.' });
  }
});

router.delete('/carousel-slides/:slideId', protect, authorizeRoles('admin'), async (req, res) => {
  try {
    const slide = await CarouselSlide.findByIdAndDelete(req.params.slideId);

    if (!slide) {
      return res.status(404).json({ message: 'Carousel slide not found.' });
    }

    res.status(200).json({ message: 'Carousel slide deleted successfully.' });
  } catch (error) {
    console.error('Error deleting carousel slide:', error);
    res.status(500).json({ message: 'Failed to delete carousel slide.' });
  }
});

module.exports = router;
