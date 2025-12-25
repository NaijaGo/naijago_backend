const Rider = require('../models/Rider');
const jwt = require('jsonwebtoken');

// Helper to create JWT
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

/**
 * @desc Register a new rider
 * @route POST /api/riders/register
 */
exports.registerRider = async (req, res) => {
  try {
    const { fullName, email, password, plateNumber, documentUrls } = req.body;

    // 1. Check if rider exists
    const riderExists = await Rider.findOne({ email });
    if (riderExists) return res.status(400).json({ message: 'Rider already exists' });

    // 2. Create Rider
    const rider = await Rider.create({
      fullName,
      email,
      password,
      plateNumber,
      documents: {
        ninFront: documentUrls?.ninFront,
        ninBack: documentUrls?.ninBack,
        platePhoto: documentUrls?.platePhoto,
        selfie: documentUrls?.selfie,
      }
    });

    if (rider) {
      res.status(201).json({
        success: true,
        _id: rider._id,
        fullName: rider.fullName,
        token: generateToken(rider._id),
        message: "Registration successful! Wait for admin approval."
      });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Login rider
 * @route POST /api/riders/login
 */
exports.loginRider = async (req, res) => {
  const { email, password } = req.body;
  try {
    const rider = await Rider.findOne({ email });
    
    // Check password using bcrypt (we'll add a method to model or compare here)
    const bcrypt = require('bcryptjs');
    if (rider && (await bcrypt.compare(password, rider.password))) {
      res.json({
        _id: rider._id,
        fullName: rider.fullName,
        email: rider.email,
        isVerified: rider.isVerified,
        status: rider.status,
        token: generateToken(rider._id),
      });
    } else {
      res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};