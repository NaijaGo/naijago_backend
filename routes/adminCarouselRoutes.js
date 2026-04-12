const express = require('express');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const { CarouselSlide, VALID_CAROUSEL_PLACEMENTS } = require('../models/CarouselSlide');

const router = express.Router();
const ADMIN_FIELDS = 'firstName lastName email';

const normalizePlacement = (value) => String(value || '').trim().toLowerCase();

const sanitizeSlidePayload = (body = {}) => {
  const placement = normalizePlacement(body.placement);
  const parsedSortOrder = Number.parseInt(body.sortOrder, 10);

  return {
    placement,
    title: String(body.title || '').trim(),
    subtitle: String(body.subtitle || '').trim(),
    imageUrl: String(body.imageUrl || '').trim(),
    linkUrl: String(body.linkUrl || '').trim(),
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
  title: slide.title || '',
  subtitle: slide.subtitle || '',
  imageUrl: slide.imageUrl,
  linkUrl: slide.linkUrl || '',
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
    const slide = await CarouselSlide.findByIdAndUpdate(
      req.params.slideId,
      {
        $set: {
          ...payload,
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
