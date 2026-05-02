const express = require('express');
const { CarouselSlide, VALID_CAROUSEL_PLACEMENTS } = require('../models/CarouselSlide');

const router = express.Router();

const mapSlide = (slide) => ({
  _id: slide._id,
  id: slide._id,
  placement: slide.placement,
  title: slide.title || '',
  subtitle: slide.subtitle || '',
  imageUrl: slide.imageUrl,
  linkUrl: slide.linkUrl || '',
  actionType: slide.actionType || 'none',
  actionValue: slide.actionValue || '',
  sortOrder: Number(slide.sortOrder || 0),
  isActive: Boolean(slide.isActive),
  updatedAt: slide.updatedAt || null,
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

const fetchActiveSlidesByPlacement = async (placement) => {
  if (!VALID_CAROUSEL_PLACEMENTS.includes(placement)) {
    return null;
  }

  return CarouselSlide.find({ isActive: true, placement })
    .sort({ sortOrder: 1, updatedAt: -1, createdAt: 1 })
    .lean();
};

router.get('/home', async (req, res) => {
  try {
    const slides = await CarouselSlide.find({ isActive: true })
      .sort({ placement: 1, sortOrder: 1, updatedAt: -1, createdAt: 1 })
      .lean();

    res.status(200).json(buildGroupedSlidesPayload(slides));
  } catch (error) {
    console.error('Error fetching carousel slides:', error);
    res.status(500).json({ message: 'Failed to fetch carousel slides.' });
  }
});

router.get('/:placement', async (req, res) => {
  const placement = String(req.params.placement || '').trim().toLowerCase();

  try {
    const slides = await fetchActiveSlidesByPlacement(placement);
    if (!slides) {
      return res.status(400).json({
        message: 'Invalid carousel placement. Use "main" or "promo".',
      });
    }

    res.status(200).json(slides.map(mapSlide));
  } catch (error) {
    console.error(`Error fetching ${placement} carousel slides:`, error);
    res.status(500).json({ message: 'Failed to fetch carousel slides.' });
  }
});

module.exports = router;
