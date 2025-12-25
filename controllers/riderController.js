const Rider = require('../models/Rider');
const jwt = require('jsonwebtoken');
const crypto = require('crypto'); // Add this for token generation
const { sendVerificationEmail } = require('../utils/emailHelper');

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

    const riderExists = await Rider.findOne({ email });
    if (riderExists) return res.status(400).json({ message: 'Rider already exists' });

    // Generate Token
    const verificationToken = crypto.randomBytes(32).toString('hex');

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
      },
      emailVerificationToken: verificationToken,
      emailVerificationExpires: Date.now() + 24 * 60 * 60 * 1000 
    });

    // Send the Email
    await sendVerificationEmail(rider.email, verificationToken, 'email');

    res.status(201).json({
      success: true,
      _id: rider._id,
      fullName: rider.fullName,
      // Optional: You might want to wait until they verify email before giving a token
      token: generateToken(rider._id), 
      message: "Registration successful! Please check your email to verify your account."
    });
    
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
    const bcrypt = require('bcryptjs');

    if (rider && (await bcrypt.compare(password, rider.password))) {
      
      // 1. CHECK: Email Verification
      // If they haven't clicked the link in their email yet, block login.
      if (!rider.isEmailVerified) {
        return res.status(401).json({ 
          message: 'Please verify your email address. Check your inbox for the verification link.' 
        });
      }

      // 2. CHECK: Admin Approval Status
      // Case: Still Pending
      if (rider.status === 'pending') {
        return res.status(401).json({ 
          message: 'Your application is currently being reviewed by our admin team. Please wait for approval.' 
        });
      }

      // Case: Rejected
      if (rider.status === 'rejected') {
        return res.status(401).json({ 
          message: 'Your rider application was rejected.',
          reason: rider.rejectionReason || 'Documents provided did not meet our requirements.'
        });
      }

      // 3. SUCCESS: If email is verified and status is 'approved'
      res.json({
        _id: rider._id,
        fullName: rider.fullName,
        email: rider.email,
        isVerified: rider.isVerified, // This is the 'isVerified' from your schema
        status: rider.status,
        token: generateToken(rider._id),
      });

    } else {
      // General error for wrong email or wrong password
      res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};