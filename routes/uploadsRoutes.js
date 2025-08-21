// routes/uploadRoutes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const cloudinary = require('cloudinary').v2;
const fileUpload = require('express-fileupload');

// Cloudinary configuration (make sure these are in your .env file)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

router.use(fileUpload({
  useTempFiles: true,
  tempFileDir: '/tmp/'
}));

// @desc Upload a file to Cloudinary
// @route POST /api/uploads/cloudinary
// @access Private
router.post('/cloudinary', protect, async (req, res) => {
  try {
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ message: 'No file was uploaded.' });
    }

    const file = req.files.image; // 'image' should be the key from your Flutter form data
    
    // Upload the file to Cloudinary
    const result = await cloudinary.uploader.upload(file.tempFilePath, {
      folder: `disputes/${req.user._id}`,
    });

    // Clean up temporary file
    const fs = require('fs');
    fs.unlinkSync(file.tempFilePath);

    res.json({ url: result.secure_url });
  } catch (error) {
    console.error('Cloudinary upload failed:', error);
    res.status(500).json({ message: 'Failed to upload image' });
  }
});

module.exports = router;