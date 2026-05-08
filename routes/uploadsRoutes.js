const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const cloudinary = require('cloudinary').v2;
const fileUpload = require('express-fileupload');
const fs = require('fs'); // Moved to top so all routes can use it

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

router.use(fileUpload({
  useTempFiles: true,
  tempFileDir: '/tmp/'
}));

// --- EXISTING ROUTES ---

// @desc Upload a file to Cloudinary (Private)
router.post('/cloudinary', protect, async (req, res) => {
  try {
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ message: 'No file was uploaded.' });
    }
    const file = req.files.image; 
    const result = await cloudinary.uploader.upload(file.tempFilePath, {
      folder: `disputes/${req.user._id}`,
    });
    if (fs.existsSync(file.tempFilePath)) fs.unlinkSync(file.tempFilePath);
    res.json({ url: result.secure_url });
  } catch (error) {
    res.status(500).json({ message: 'Failed to upload image' });
  }
});

router.post('/cloudinary/carousel', protect, authorizeRoles('admin'), async (req, res) => {
  try {
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ message: 'No image was uploaded.' });
    }

    const file = req.files.image;
    const placement = ['main', 'promo'].includes(String(req.body?.placement || '').toLowerCase())
      ? String(req.body.placement).toLowerCase()
      : 'misc';

    const result = await cloudinary.uploader.upload(file.tempFilePath, {
      folder: `carousel-slides/${placement}`,
    });

    if (fs.existsSync(file.tempFilePath)) fs.unlinkSync(file.tempFilePath);

    res.json({ url: result.secure_url });
  } catch (error) {
    console.error('Carousel upload failed:', error);
    res.status(500).json({ message: 'Failed to upload carousel image.' });
  }
});

router.post('/cloudinary/vendor-logo', protect, authorizeRoles('vendor'), async (req, res) => {
  try {
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ message: 'No logo image was uploaded.' });
    }

    const file = req.files.image;
    if (!file?.mimetype?.startsWith('image/')) {
      return res.status(400).json({ message: 'Only image files are allowed for store logos.' });
    }

    const result = await cloudinary.uploader.upload(file.tempFilePath, {
      folder: `vendor-logos/${req.user._id}`,
      resource_type: 'image',
      transformation: [
        { width: 640, height: 640, crop: 'limit' },
        { quality: 'auto', fetch_format: 'auto' },
      ],
    });

    if (fs.existsSync(file.tempFilePath)) fs.unlinkSync(file.tempFilePath);

    res.json({ url: result.secure_url });
  } catch (error) {
    console.error('Vendor logo upload failed:', error);
    res.status(500).json({ message: 'Failed to upload store logo.' });
  }
});

router.post('/cloudinary/vendor-onboarding', protect, async (req, res) => {
  try {
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ message: 'No onboarding file was uploaded.' });
    }

    const file = req.files.file || req.files.image || Object.values(req.files)[0];
    const allowedMimeTypes = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ]);

    if (!file?.mimetype || !allowedMimeTypes.has(file.mimetype)) {
      return res.status(400).json({ message: 'Only JPG, PNG, WEBP, or PDF files are allowed.' });
    }

    const purpose = String(req.body?.purpose || 'document')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .slice(0, 40);

    const result = await cloudinary.uploader.upload(file.tempFilePath, {
      folder: `vendor-onboarding/${req.user._id}/${purpose || 'document'}`,
      resource_type: 'auto',
      transformation: file.mimetype.startsWith('image/')
        ? [
            { width: 1600, height: 1600, crop: 'limit' },
            { quality: 'auto', fetch_format: 'auto' },
          ]
        : undefined,
    });

    if (fs.existsSync(file.tempFilePath)) fs.unlinkSync(file.tempFilePath);

    res.json({ url: result.secure_url });
  } catch (error) {
    console.error('Vendor onboarding upload failed:', error);
    res.status(500).json({ message: 'Failed to upload onboarding file.' });
  }
});

router.post('/cloudinary/food-campaign', protect, authorizeRoles('admin'), async (req, res) => {
  try {
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ message: 'No campaign image was uploaded.' });
    }

    const file = req.files.image;
    if (!file?.mimetype?.startsWith('image/')) {
      return res.status(400).json({ message: 'Only image files are allowed.' });
    }

    const result = await cloudinary.uploader.upload(file.tempFilePath, {
      folder: 'food-readiness-campaigns',
      resource_type: 'image',
      transformation: [
        { width: 1200, height: 600, crop: 'limit' },
        { quality: 'auto', fetch_format: 'auto' },
      ],
    });

    if (fs.existsSync(file.tempFilePath)) fs.unlinkSync(file.tempFilePath);

    res.json({ url: result.secure_url });
  } catch (error) {
    console.error('Food campaign upload failed:', error);
    res.status(500).json({ message: 'Failed to upload campaign image.' });
  }
});

// @desc Update existing rider docs (Private)
router.post('/rider-bundle', protect, async (req, res) => {
  try {
    if (!req.files) return res.status(400).json({ message: 'No files uploaded' });
    const results = {};
    const keys = ['ninFront', 'ninBack', 'platePhoto', 'selfieWithBike'];
    for (const key of keys) {
      if (req.files[key]) {
        const upload = await cloudinary.uploader.upload(req.files[key].tempFilePath, {
          folder: `riders/${req.user._id}/verification`,
        });
        results[key] = upload.secure_url;
        if (fs.existsSync(req.files[key].tempFilePath)) fs.unlinkSync(req.files[key].tempFilePath);
      }
    }
    res.json({ message: "Bundle uploaded", urls: results });
  } catch (error) {
    res.status(500).json({ message: 'Upload failed', error: error.message });
  }
});

// --- NEW PUBLIC ROUTE FOR REGISTRATION ---

/**
 * @desc Public Upload for NEW Rider Registration (No Token Needed)
 * @route POST /api/uploads/rider-bundle-public
 * @access Public
 */
router.post('/rider-bundle-public', async (req, res) => {
  try {
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ message: 'No documents attached' });
    }

    const results = {};
    // Matches the keys used in your React RiderAuth.jsx state
    const keys = ['ninFront', 'ninBack', 'platePhoto', 'selfie'];

    for (const key of keys) {
      if (req.files[key]) {
        const upload = await cloudinary.uploader.upload(req.files[key].tempFilePath, {
          folder: `riders/pending_registrations`,
        });
        results[key] = upload.secure_url;
        
        // Cleanup temp file
        if (fs.existsSync(req.files[key].tempFilePath)) {
          fs.unlinkSync(req.files[key].tempFilePath);
        }
      }
    }

    res.json({ 
      success: true, 
      urls: results 
    });
  } catch (error) {
    console.error('Public upload error:', error);
    res.status(500).json({ message: 'Document upload failed' });
  }
});

module.exports = router;
