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
