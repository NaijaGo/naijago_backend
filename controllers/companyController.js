const Company = require('../models/Company');
const CompanyRider = require('../models/CompanyRider');
const CompanyDelivery = require('../models/CompanyDelivery');
const Settlement = require('../models/Settlement');
const jwt = require('jsonwebtoken');
const csv = require('csv-parser');
const { sendVerificationEmail, sendSettlementEmail } = require('../utils/emailHelper');

// Generate JWT Token for companies
const generateToken = (company) => {
  return jwt.sign(
    { 
      id: company._id,
      companyId: company._id,  // Explicit companyId for socket.io
      role: 'company',
      email: company.email,
      companyName: company.companyName,
      contactPerson: company.contactPerson
    }, 
    process.env.JWT_SECRET, 
    { expiresIn: '30d' }
  );
};

// @desc    Register a new company
// @route   POST /api/companies/register
// @access  Public
exports.registerCompany = async (req, res) => {
  try {
    const {
      companyName,
      rcNumber,
      officeAddress,
      contactPerson,
      phoneNumber,
      email,
      bankAccount,
      estimatedRiders,
      password
    } = req.body;

    // Check if company already exists
    const companyExists = await Company.findOne({ 
      $or: [{ email }, { phoneNumber }] 
    });

    if (companyExists) {
      return res.status(400).json({
        success: false,
        message: 'Company with this email or phone already exists'
      });
    }

    // Create company
    const company = await Company.create({
      companyName,
      rcNumber,
      officeAddress,
      contactPerson,
      phoneNumber,
      email,
      bankAccount,
      estimatedRiders,
      password
    });

    // Generate verification code
    const verificationCode = company.generateVerificationCode();
    await company.save();

    // Send verification email using Resend
    try {
      await sendVerificationEmail(
        company.email, 
        verificationCode, 
        'company_registration', 
        {
          companyName: company.companyName,
          contactPerson: company.contactPerson
        }
      );
    } catch (emailError) {
      console.error('Email sending failed:', emailError);
      // Don't fail registration if email fails
    }

    res.status(201).json({
      success: true,
      message: 'Company registered successfully. Please check your email for verification.',
      data: {
        _id: company._id,
        companyName: company.companyName,
        email: company.email,
        contactPerson: company.contactPerson
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors
      });
    }

    // Handle duplicate key errors
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `A company with this ${field} already exists`
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// @desc    Verify company email
// @route   GET /api/companies/verify-email/:token
// @access  Public
exports.verifyEmail = async (req, res) => {
  try {
    const { token } = req.params;
    
    // Find company with this verification code that hasn't expired
    const company = await Company.findOne({
      verificationCode: token,
      verificationExpires: { $gt: Date.now() }
    });

    if (!company) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired verification token'
      });
    }

    // Update company as verified
    company.isVerified = true;
    company.status = 'active';
    company.verificationCode = undefined;
    company.verificationExpires = undefined;
    await company.save();

    // Generate a token for immediate login
    const authToken = generateToken(company);

    // Send success response
    res.status(200).json({
      success: true,
      message: 'Email verified successfully! Your account is now active.',
      token: authToken,
      company: {
        _id: company._id,
        companyName: company.companyName,
        email: company.email,
        contactPerson: company.contactPerson,
        phoneNumber: company.phoneNumber
      }
    });

  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during email verification'
    });
  }
};

// @desc    Login company
// @route   POST /api/companies/login
// @access  Public
exports.loginCompany = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find company
    const company = await Company.findOne({ email });

    if (!company) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check password
    const isPasswordMatch = await company.comparePassword(password);

    if (!isPasswordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check if company is verified
    if (!company.isVerified) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email address first'
      });
    }

    // Check if company is active
    if (company.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: 'Your account is not active. Please contact support.'
      });
    }

    // Update last login
    company.lastLogin = new Date();
    await company.save();

    // Generate token
    const token = generateToken(company);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        company: {
          _id: company._id,
          companyName: company.companyName,
          email: company.email,
          contactPerson: company.contactPerson,
          phoneNumber: company.phoneNumber,
          stats: company.stats
        }
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get company profile
// @route   GET /api/companies/profile
// @access  Private
exports.getProfile = async (req, res) => {
  try {
    const company = await Company.findById(req.company._id)
      .select('-password -verificationCode -verificationExpires');

    // Calculate real-time stats
    const totalRiders = await CompanyRider.countDocuments({ company: req.company._id });
    const activeRiders = await CompanyRider.countDocuments({ 
      company: req.company._id, 
      isActive: true 
    });
    const completedDeliveries = await CompanyDelivery.countDocuments({
      company: req.company._id,
      status: 'delivered'
    });
    const pendingDeliveries = await CompanyDelivery.countDocuments({
      company: req.company._id,
      status: { $in: ['pending', 'assigned', 'picked_up'] }
    });
    
    // Calculate total earnings from delivered orders
    const earningsResult = await CompanyDelivery.aggregate([
      {
        $match: {
          company: req.company._id,
          status: 'delivered'
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$companyEarnings' }
        }
      }
    ]);
    
    // Calculate pending settlement from unpaid deliveries
    const pendingSettlementResult = await CompanyDelivery.aggregate([
      {
        $match: {
          company: req.company._id,
          status: 'delivered',
          settlementStatus: 'unpaid'
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$companyEarnings' }
        }
      }
    ]);

    const profileWithUpdatedStats = {
      ...company.toObject(),
      totalEarnings: earningsResult[0]?.total || 0,
      pendingSettlement: pendingSettlementResult[0]?.total || 0,
      totalRiders,
      activeRiders,
      completedDeliveries,
      pendingDeliveries
    };

    res.json({
      success: true,
      data: profileWithUpdatedStats
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Update company profile
// @route   PUT /api/companies/profile
// @access  Private
exports.updateProfile = async (req, res) => {
  try {
    const updates = req.body;
    const allowedUpdates = ['companyName', 'officeAddress', 'contactPerson', 'phoneNumber', 'bankAccount', 'settings'];
    
    // Filter updates
    const filteredUpdates = Object.keys(updates)
      .filter(key => allowedUpdates.includes(key))
      .reduce((obj, key) => {
        obj[key] = updates[key];
        return obj;
      }, {});
    
    const company = await Company.findByIdAndUpdate(
      req.company._id,
      filteredUpdates,
      { new: true, runValidators: true }
    ).select('-password -verificationCode -verificationExpires');
    
    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: company
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get company stats
// @route   GET /api/companies/stats
// @access  Private
exports.getStats = async (req, res) => {
  try {
    const companyId = req.company._id;
    
    // Get current date ranges
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    // Get today's deliveries
    const todayDeliveries = await CompanyDelivery.countDocuments({
      company: companyId,
      status: 'delivered',
      completedAt: { $gte: today, $lt: tomorrow }
    });
    
    // Get today's earnings
    const todayEarningsResult = await CompanyDelivery.aggregate([
      {
        $match: {
          company: companyId,
          status: 'delivered',
          completedAt: { $gte: today, $lt: tomorrow }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$companyEarnings' }
        }
      }
    ]);
    
    const todayEarnings = todayEarningsResult[0]?.total || 0;
    
    // Get completion rate (last 7 days)
    const weekDeliveries = await CompanyDelivery.find({
      company: companyId,
      createdAt: { $gte: oneWeekAgo }
    });
    
    const completed = weekDeliveries.filter(d => d.status === 'delivered').length;
    const total = weekDeliveries.length;
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    // Calculate weekly growth compared to previous week
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    
    const lastWeekEarningsResult = await CompanyDelivery.aggregate([
      {
        $match: {
          company: companyId,
          status: 'delivered',
          completedAt: { 
            $gte: twoWeeksAgo, 
            $lt: oneWeekAgo 
          }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$companyEarnings' }
        }
      }
    ]);
    
    const lastWeekEarnings = lastWeekEarningsResult[0]?.total || 0;
    let weeklyGrowth = '+0%';
    
    if (lastWeekEarnings > 0) {
      const growth = ((todayEarnings - lastWeekEarnings) / lastWeekEarnings) * 100;
      weeklyGrowth = `${growth >= 0 ? '+' : ''}${Math.round(growth)}%`;
    } else if (todayEarnings > 0) {
      weeklyGrowth = '+100%';
    }
    
    res.json({
      success: true,
      data: {
        todayDeliveries,
        todayEarnings,
        completionRate: `${completionRate}%`,
        weeklyGrowth,
        totalRiders: req.company.stats?.totalRiders || 0,
        activeRiders: req.company.stats?.activeRiders || 0,
        totalEarnings: req.company.stats?.totalEarnings || 0,
        pendingSettlement: req.company.stats?.pendingSettlement || 0,
        completedDeliveries: req.company.stats?.completedDeliveries || 0,
        pendingDeliveries: req.company.stats?.pendingDeliveries || 0
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get company riders
// @route   GET /api/companies/riders
// @access  Private
exports.getRiders = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const skip = (page - 1) * limit;
    
    const query = { company: req.company._id };
    
    // Apply filters
    if (status && status !== 'all') {
      if (status === 'active') {
        query.isActive = true;
      } else if (status === 'inactive') {
        query.isActive = false;
      } else {
        query.status = status;
      }
    }
    
    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { phoneNumber: { $regex: search, $options: 'i' } },
        { plateNumber: { $regex: search, $options: 'i' } },
        { riderId: { $regex: search, $options: 'i' } }
      ];
    }
    
    const riders = await CompanyRider.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await CompanyRider.countDocuments(query);
    
    res.json({
      success: true,
      data: {
        riders,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Get riders error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Add new rider
// @route   POST /api/companies/riders
// @access  Private
exports.addRider = async (req, res) => {
  try {
    const { fullName, phoneNumber, email, plateNumber, vehicleType } = req.body;
    
    // Validate required fields
    if (!fullName || !phoneNumber || !plateNumber || !vehicleType) {
      return res.status(400).json({
        success: false,
        message: 'Please provide fullName, phoneNumber, plateNumber, and vehicleType'
      });
    }
    
    // Check if rider with same phone or plate already exists for this company
    const existingRider = await CompanyRider.findOne({
      company: req.company._id,
      $or: [
        { phoneNumber },
        { plateNumber }
      ]
    });
    
    if (existingRider) {
      let message = 'A rider with this ';
      if (existingRider.phoneNumber === phoneNumber) {
        message += 'phone number ';
      }
      if (existingRider.plateNumber === plateNumber) {
        message += existingRider.phoneNumber === phoneNumber ? 'and plate number ' : 'plate number ';
      }
      message += 'already exists';
      
      return res.status(400).json({
        success: false,
        message
      });
    }
    
    // Create rider
    const rider = await CompanyRider.create({
      company: req.company._id,
      fullName,
      phoneNumber,
      email: email || undefined,
      plateNumber,
      vehicleType,
      isActive: true,
      isAvailable: false,
      status: 'active',
      currentLocation: {
        lat: null,
        lng: null,
        address: '',
        updatedAt: null
      },
      stats: {
        totalDeliveries: 0,
        completedDeliveries: 0,
        cancelledDeliveries: 0,
        totalEarnings: 0,
        rating: 0,
        averageRating: 0,
        totalReviews: 0
      },
      lastActivity: new Date()
    });
    
    res.status(201).json({
      success: true,
      message: 'Rider added successfully',
      data: rider
    });
    
  } catch (error) {
    console.error('Add rider error:', error);
    
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message
      }));
      
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validationErrors
      });
    }
    
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `A rider with this ${field} already exists`
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to add rider. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// @desc    Update rider details
// @route   PUT /api/companies/riders/:id
// @access  Private
exports.updateRider = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // Find rider belonging to this company
    const rider = await CompanyRider.findOne({
      _id: id,
      company: req.company._id
    });
    
    if (!rider) {
      return res.status(404).json({
        success: false,
        message: 'Rider not found'
      });
    }
    
    // Allowed fields to update
    const allowedUpdates = ['fullName', 'phoneNumber', 'email', 'plateNumber', 'vehicleType', 'isActive', 'isAvailable', 'status'];
    const filteredUpdates = {};
    
    Object.keys(updates).forEach(key => {
      if (allowedUpdates.includes(key)) {
        filteredUpdates[key] = updates[key];
      }
    });
    
    // Check for duplicate phone or plate if updating
    if (filteredUpdates.phoneNumber || filteredUpdates.plateNumber) {
      const duplicateQuery = {
        company: req.company._id,
        _id: { $ne: id }
      };
      
      const orConditions = [];
      if (filteredUpdates.phoneNumber) {
        orConditions.push({ phoneNumber: filteredUpdates.phoneNumber });
      }
      if (filteredUpdates.plateNumber) {
        orConditions.push({ plateNumber: filteredUpdates.plateNumber });
      }
      
      if (orConditions.length > 0) {
        duplicateQuery.$or = orConditions;
        
        const existingRider = await CompanyRider.findOne(duplicateQuery);
        if (existingRider) {
          let message = 'Another rider with this ';
          if (existingRider.phoneNumber === filteredUpdates.phoneNumber) {
            message += 'phone number ';
          }
          if (existingRider.plateNumber === filteredUpdates.plateNumber) {
            message += existingRider.phoneNumber === filteredUpdates.phoneNumber ? 'and plate number ' : 'plate number ';
          }
          message += 'already exists';
          
          return res.status(400).json({
            success: false,
            message
          });
        }
      }
    }
    
    // Update rider
    Object.assign(rider, filteredUpdates);
    await rider.save();
    
    res.json({
      success: true,
      message: 'Rider updated successfully',
      data: rider
    });
    
  } catch (error) {
    console.error('Update rider error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Delete rider
// @route   DELETE /api/companies/riders/:id
// @access  Private
exports.deleteRider = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Find and delete rider belonging to this company
    const rider = await CompanyRider.findOneAndDelete({
      _id: id,
      company: req.company._id
    });
    
    if (!rider) {
      return res.status(404).json({
        success: false,
        message: 'Rider not found'
      });
    }
    
    // Check if rider has active deliveries
    const activeDeliveries = await CompanyDelivery.countDocuments({
      rider: id,
      status: { $in: ['assigned', 'picked_up', 'in_transit'] }
    });
    
    if (activeDeliveries > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete rider with active deliveries. Please reassign deliveries first.'
      });
    }
    
    res.json({
      success: true,
      message: 'Rider deleted successfully'
    });
    
  } catch (error) {
    console.error('Delete rider error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Bulk upload riders from CSV
// @route   POST /api/companies/riders/bulk
// @access  Private
exports.bulkUploadRiders = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }
    
    // Parse CSV file from buffer
    const csvData = await parseCSV(req.file.buffer);
    
    if (!csvData.length) {
      return res.status(400).json({
        success: false,
        message: 'CSV file is empty'
      });
    }
    
    const companyId = req.company._id;
    const addedRiders = [];
    const skippedRiders = [];
    
    // Process each row
    for (const row of csvData) {
      try {
        const { fullName, phoneNumber, email, plateNumber, vehicleType = 'motorcycle' } = row;
        
        // Validate required fields
        if (!fullName || !phoneNumber || !plateNumber) {
          skippedRiders.push({
            row,
            reason: 'Missing required fields (fullName, phoneNumber, or plateNumber)'
          });
          continue;
        }
        
        // Check for duplicates
        const existingRider = await CompanyRider.findOne({
          company: companyId,
          $or: [
            { phoneNumber },
            { plateNumber }
          ]
        });
        
        if (existingRider) {
          skippedRiders.push({
            row,
            reason: 'Duplicate phone number or plate number'
          });
          continue;
        }
        
        // Create rider
        const rider = await CompanyRider.create({
          company: companyId,
          fullName,
          phoneNumber,
          email,
          plateNumber,
          vehicleType,
          isActive: true,
          isAvailable: false,
          status: 'active',
          stats: {
            totalDeliveries: 0,
            completedDeliveries: 0,
            cancelledDeliveries: 0,
            totalEarnings: 0,
            rating: 0
          }
        });
        
        addedRiders.push(rider);
        
      } catch (error) {
        skippedRiders.push({
          row,
          reason: error.message
        });
      }
    }
    
    res.status(200).json({
      success: true,
      message: `Successfully added ${addedRiders.length} riders, skipped ${skippedRiders.length}`,
      data: {
        added: addedRiders.length,
        skipped: skippedRiders.length,
        riders: addedRiders,
        skippedDetails: skippedRiders
      }
    });
    
  } catch (error) {
    console.error('Bulk upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process bulk upload',
      error: error.message
    });
  }
};

// Helper function to parse CSV from buffer
const parseCSV = (buffer) => {
  return new Promise((resolve, reject) => {
    const results = [];
    const stream = require('stream');
    const bufferStream = new stream.PassThrough();
    bufferStream.end(buffer);
    
    bufferStream
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (error) => reject(error));
  });
};

// @desc    Update rider status
// @route   PUT /api/companies/riders/:id/status
// @access  Private
exports.updateRiderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isActive must be a boolean value'
      });
    }
    
    const rider = await CompanyRider.findOne({
      _id: id,
      company: req.company._id
    });
    
    if (!rider) {
      return res.status(404).json({
        success: false,
        message: 'Rider not found'
      });
    }
    
    rider.isActive = isActive;
    rider.status = isActive ? 'active' : 'inactive';
    await rider.save();
    
    res.json({
      success: true,
      message: `Rider ${isActive ? 'activated' : 'deactivated'} successfully`,
      data: rider
    });
  } catch (error) {
    console.error('Update rider status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get company deliveries
// @route   GET /api/companies/deliveries
// @access  Private
exports.getDeliveries = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, startDate, endDate, riderId } = req.query;
    const skip = (page - 1) * limit;
    
    const query = { company: req.company._id };
    
    // Apply filters
    if (status && status !== 'all') {
      query.status = status;
    }
    
    if (riderId) {
      query.rider = riderId;
    }
    
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    
    const deliveries = await CompanyDelivery.find(query)
      .populate('rider', 'fullName phoneNumber riderId')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await CompanyDelivery.countDocuments(query);
    
    res.json({
      success: true,
      data: {
        deliveries,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Get deliveries error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get single delivery
// @route   GET /api/companies/deliveries/:id
// @access  Private
exports.getDelivery = async (req, res) => {
  try {
    const { id } = req.params;
    
    const delivery = await CompanyDelivery.findOne({
      _id: id,
      company: req.company._id
    }).populate('rider', 'fullName phoneNumber riderId');
    
    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found'
      });
    }
    
    res.json({
      success: true,
      data: delivery
    });
  } catch (error) {
    console.error('Get delivery error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get settlements
// @route   GET /api/companies/settlements
// @access  Private
exports.getSettlements = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (page - 1) * limit;
    
    const query = { company: req.company._id };
    
    if (status && status !== 'all') {
      query.status = status;
    }
    
    const settlements = await Settlement.find(query)
      .populate('deliveries', 'deliveryId amount customer')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await Settlement.countDocuments(query);
    
    res.json({
      success: true,
      data: {
        settlements,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Get settlements error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get single settlement
// @route   GET /api/companies/settlements/:id
// @access  Private
exports.getSettlement = async (req, res) => {
  try {
    const { id } = req.params;
    
    const settlement = await Settlement.findOne({
      _id: id,
      company: req.company._id
    }).populate('deliveries');
    
    if (!settlement) {
      return res.status(404).json({
        success: false,
        message: 'Settlement not found'
      });
    }
    
    res.json({
      success: true,
      data: settlement
    });
  } catch (error) {
    console.error('Get settlement error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Request new settlement
// @route   POST /api/companies/settlements/request
// @access  Private
exports.requestSettlement = async (req, res) => {
  try {
    const companyId = req.company._id;
    
    // Find all unpaid completed deliveries
    const unpaidDeliveries = await CompanyDelivery.find({
      company: companyId,
      status: 'delivered',
      settlementStatus: 'unpaid'
    });
    
    if (unpaidDeliveries.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No pending deliveries for settlement'
      });
    }
    
    // Calculate total amount
    const totalAmount = unpaidDeliveries.reduce((sum, delivery) => sum + delivery.companyEarnings, 0);
    
    if (totalAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'No earnings to settle'
      });
    }
    
    // Get date range for settlement period
    const oldestDelivery = unpaidDeliveries.reduce((oldest, delivery) => 
      delivery.completedAt < oldest.completedAt ? delivery : oldest
    );
    const newestDelivery = unpaidDeliveries.reduce((newest, delivery) => 
      delivery.completedAt > newest.completedAt ? delivery : newest
    );
    
    // Create settlement
    const settlement = await Settlement.create({
      company: companyId,
      startDate: oldestDelivery.completedAt,
      endDate: newestDelivery.completedAt,
      amount: totalAmount,
      deliveryCount: unpaidDeliveries.length,
      deliveries: unpaidDeliveries.map(d => d._id),
      status: 'pending',
      bankDetails: req.company.bankAccount
    });
    
    // Update delivery settlement status
    await CompanyDelivery.updateMany(
      { _id: { $in: unpaidDeliveries.map(d => d._id) } },
      { 
        settlementStatus: 'processing',
        settlement: settlement._id
      }
    );
    
    // Update company pending settlement
    const company = await Company.findById(companyId);
    if (company) {
      company.stats.pendingSettlement = Math.max(0, company.stats.pendingSettlement - totalAmount);
      await company.save();
    }
    
    // Send settlement email notification
    try {
      await sendSettlementEmail(
        req.company.email, 
        settlement, 
        {
          companyName: req.company.companyName,
          contactPerson: req.company.contactPerson
        }
      );
    } catch (emailError) {
      console.error('Failed to send settlement email:', emailError);
      // Don't fail the settlement request if email fails
    }
    
    res.status(201).json({
      success: true,
      message: 'Settlement requested successfully',
      data: settlement
    });
    
  } catch (error) {
    console.error('Request settlement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to request settlement',
      error: error.message
    });
  }
};

// @desc    Get analytics data
// @route   GET /api/companies/analytics
// @access  Private
exports.getAnalytics = async (req, res) => {
  try {
    const companyId = req.company._id;
    const { period = 'week' } = req.query;
    
    // Calculate date ranges based on period
    const endDate = new Date();
    const startDate = new Date();
    
    switch (period) {
      case 'day':
        startDate.setDate(startDate.getDate() - 1);
        break;
      case 'week':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case 'month':
        startDate.setMonth(startDate.getMonth() - 1);
        break;
      case 'year':
        startDate.setFullYear(startDate.getFullYear() - 1);
        break;
      default:
        startDate.setDate(startDate.getDate() - 7);
    }
    
    // Get delivery trends
    const deliveryTrends = await CompanyDelivery.aggregate([
      {
        $match: {
          company: companyId,
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" }
          },
          count: { $sum: 1 },
          earnings: { $sum: "$companyEarnings" }
        }
      },
      {
        $sort: { _id: 1 }
      }
    ]);
    
    // Get rider performance
    const riderPerformance = await CompanyDelivery.aggregate([
      {
        $match: {
          company: companyId,
          createdAt: { $gte: startDate, $lte: endDate },
          status: 'delivered'
        }
      },
      {
        $group: {
          _id: "$rider",
          deliveries: { $sum: 1 },
          earnings: { $sum: "$companyEarnings" },
          averageDuration: { $avg: "$actualDuration" }
        }
      },
      {
        $lookup: {
          from: 'companyriders',
          localField: '_id',
          foreignField: '_id',
          as: 'rider'
        }
      },
      {
        $unwind: "$rider"
      },
      {
        $project: {
          riderName: "$rider.fullName",
          riderId: "$rider.riderId",
          deliveries: 1,
          earnings: 1,
          averageDuration: 1
        }
      },
      {
        $sort: { deliveries: -1 }
      },
      {
        $limit: 10
      }
    ]);
    
    // Get status distribution
    const statusDistribution = await CompanyDelivery.aggregate([
      {
        $match: {
          company: companyId,
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 }
        }
      }
    ]);
    
    res.json({
      success: true,
      data: {
        period: {
          startDate,
          endDate
        },
        deliveryTrends,
        riderPerformance,
        statusDistribution,
        summary: {
          totalDeliveries: deliveryTrends.reduce((sum, day) => sum + day.count, 0),
          totalEarnings: deliveryTrends.reduce((sum, day) => sum + day.earnings, 0),
          averageDeliveriesPerDay: deliveryTrends.length > 0 ? 
            (deliveryTrends.reduce((sum, day) => sum + day.count, 0) / deliveryTrends.length).toFixed(2) : 0
        }
      }
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Update company profile
// @route   PUT /api/companies/profile
// @access  Private
exports.updateProfile = async (req, res) => {
  try {
    const updates = req.body;
    const allowedUpdates = ['companyName', 'officeAddress', 'contactPerson', 'phoneNumber', 'bankAccount', 'settings'];
    
    // Filter updates
    const filteredUpdates = Object.keys(updates)
      .filter(key => allowedUpdates.includes(key))
      .reduce((obj, key) => {
        obj[key] = updates[key];
        return obj;
      }, {});
    
    const company = await Company.findByIdAndUpdate(
      req.company._id,
      filteredUpdates,
      { new: true, runValidators: true }
    ).select('-password -verificationCode -verificationExpires');
    
    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: company
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get company stats
// @route   GET /api/companies/stats
// @access  Private
exports.getStats = async (req, res) => {
  try {
    const companyId = req.company._id;
    
    // Get current date ranges
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    // Get today's deliveries
    const todayDeliveries = await CompanyDelivery.countDocuments({
      company: companyId,
      status: 'delivered',
      completedAt: { $gte: today, $lt: tomorrow }
    });
    
    // Get today's earnings
    const todayEarningsResult = await CompanyDelivery.aggregate([
      {
        $match: {
          company: companyId,
          status: 'delivered',
          completedAt: { $gte: today, $lt: tomorrow }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$companyEarnings' }
        }
      }
    ]);
    
    const todayEarnings = todayEarningsResult[0]?.total || 0;
    
    // Get completion rate (last 7 days)
    const weekDeliveries = await CompanyDelivery.find({
      company: companyId,
      createdAt: { $gte: oneWeekAgo }
    });
    
    const completed = weekDeliveries.filter(d => d.status === 'delivered').length;
    const total = weekDeliveries.length;
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    // Calculate weekly growth compared to previous week
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    
    const lastWeekEarningsResult = await CompanyDelivery.aggregate([
      {
        $match: {
          company: companyId,
          status: 'delivered',
          completedAt: { 
            $gte: twoWeeksAgo, 
            $lt: oneWeekAgo 
          }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$companyEarnings' }
        }
      }
    ]);
    
    const lastWeekEarnings = lastWeekEarningsResult[0]?.total || 0;
    let weeklyGrowth = '+0%';
    
    if (lastWeekEarnings > 0) {
      const growth = ((todayEarnings - lastWeekEarnings) / lastWeekEarnings) * 100;
      weeklyGrowth = `${growth >= 0 ? '+' : ''}${Math.round(growth)}%`;
    } else if (todayEarnings > 0) {
      weeklyGrowth = '+100%';
    }
    
    res.json({
      success: true,
      data: {
        todayDeliveries,
        todayEarnings,
        completionRate: `${completionRate}%`,
        weeklyGrowth,
        totalRiders: req.company.stats?.totalRiders || 0,
        activeRiders: req.company.stats?.activeRiders || 0,
        totalEarnings: req.company.stats?.totalEarnings || 0,
        pendingSettlement: req.company.stats?.pendingSettlement || 0,
        completedDeliveries: req.company.stats?.completedDeliveries || 0,
        pendingDeliveries: req.company.stats?.pendingDeliveries || 0
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get company riders
// @route   GET /api/companies/riders
// @access  Private
exports.getRiders = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const skip = (page - 1) * limit;
    
    const query = { company: req.company._id };
    
    // Apply filters
    if (status && status !== 'all') {
      if (status === 'active') {
        query.isActive = true;
      } else if (status === 'inactive') {
        query.isActive = false;
      } else {
        query.status = status;
      }
    }
    
    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { phoneNumber: { $regex: search, $options: 'i' } },
        { plateNumber: { $regex: search, $options: 'i' } },
        { riderId: { $regex: search, $options: 'i' } }
      ];
    }
    
    const riders = await CompanyRider.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await CompanyRider.countDocuments(query);
    
    res.json({
      success: true,
      data: {
        riders,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Get riders error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Add new rider
// @route   POST /api/companies/riders
// @access  Private
exports.addRider = async (req, res) => {
  try {
    const { fullName, phoneNumber, email, plateNumber, vehicleType } = req.body;
    
    // Validate required fields
    if (!fullName || !phoneNumber || !plateNumber || !vehicleType) {
      return res.status(400).json({
        success: false,
        message: 'Please provide fullName, phoneNumber, plateNumber, and vehicleType'
      });
    }
    
    // Check if rider with same phone or plate already exists for this company
    const existingRider = await CompanyRider.findOne({
      company: req.company._id,
      $or: [
        { phoneNumber },
        { plateNumber }
      ]
    });
    
    if (existingRider) {
      let message = 'A rider with this ';
      if (existingRider.phoneNumber === phoneNumber) {
        message += 'phone number ';
      }
      if (existingRider.plateNumber === plateNumber) {
        message += existingRider.phoneNumber === phoneNumber ? 'and plate number ' : 'plate number ';
      }
      message += 'already exists';
      
      return res.status(400).json({
        success: false,
        message
      });
    }
    
    // Create rider with additional default fields
    const rider = await CompanyRider.create({
      company: req.company._id,
      fullName,
      phoneNumber,
      email: email || undefined,
      plateNumber,
      vehicleType,
      isActive: true,
      isAvailable: false,
      status: 'active',
      currentLocation: {
        lat: null,
        lng: null,
        address: '',
        updatedAt: null
      },
      stats: {
        totalDeliveries: 0,
        completedDeliveries: 0,
        cancelledDeliveries: 0,
        totalEarnings: 0,
        rating: 0,
        averageRating: 0,
        totalReviews: 0
      },
      lastActivity: new Date()
    });
    
    res.status(201).json({
      success: true,
      message: 'Rider added successfully',
      data: rider
    });
    
  } catch (error) {
    console.error('Add rider error:', error);
    
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message
      }));
      
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validationErrors
      });
    }
    
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `A rider with this ${field} already exists`
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to add rider. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// @desc    Update rider details
// @route   PUT /api/companies/riders/:id
// @access  Private
exports.updateRider = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // Find rider belonging to this company
    const rider = await CompanyRider.findOne({
      _id: id,
      company: req.company._id
    });
    
    if (!rider) {
      return res.status(404).json({
        success: false,
        message: 'Rider not found'
      });
    }
    
    // Allowed fields to update
    const allowedUpdates = ['fullName', 'phoneNumber', 'email', 'plateNumber', 'vehicleType', 'isActive', 'isAvailable', 'status'];
    const filteredUpdates = {};
    
    Object.keys(updates).forEach(key => {
      if (allowedUpdates.includes(key)) {
        filteredUpdates[key] = updates[key];
      }
    });
    
    // Check for duplicate phone or plate if updating
    if (filteredUpdates.phoneNumber || filteredUpdates.plateNumber) {
      const duplicateQuery = {
        company: req.company._id,
        _id: { $ne: id }
      };
      
      const orConditions = [];
      if (filteredUpdates.phoneNumber) {
        orConditions.push({ phoneNumber: filteredUpdates.phoneNumber });
      }
      if (filteredUpdates.plateNumber) {
        orConditions.push({ plateNumber: filteredUpdates.plateNumber });
      }
      
      if (orConditions.length > 0) {
        duplicateQuery.$or = orConditions;
        
        const existingRider = await CompanyRider.findOne(duplicateQuery);
        if (existingRider) {
          let message = 'Another rider with this ';
          if (existingRider.phoneNumber === filteredUpdates.phoneNumber) {
            message += 'phone number ';
          }
          if (existingRider.plateNumber === filteredUpdates.plateNumber) {
            message += existingRider.phoneNumber === filteredUpdates.phoneNumber ? 'and plate number ' : 'plate number ';
          }
          message += 'already exists';
          
          return res.status(400).json({
            success: false,
            message
          });
        }
      }
    }
    
    // Update rider
    Object.assign(rider, filteredUpdates);
    await rider.save();
    
    res.json({
      success: true,
      message: 'Rider updated successfully',
      data: rider
    });
    
  } catch (error) {
    console.error('Update rider error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Delete rider
// @route   DELETE /api/companies/riders/:id
// @access  Private
exports.deleteRider = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Find and delete rider belonging to this company
    const rider = await CompanyRider.findOneAndDelete({
      _id: id,
      company: req.company._id
    });
    
    if (!rider) {
      return res.status(404).json({
        success: false,
        message: 'Rider not found'
      });
    }
    
    // Check if rider has active deliveries
    const activeDeliveries = await CompanyDelivery.countDocuments({
      rider: id,
      status: { $in: ['assigned', 'picked_up', 'in_transit'] }
    });
    
    if (activeDeliveries > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete rider with active deliveries. Please reassign deliveries first.'
      });
    }
    
    res.json({
      success: true,
      message: 'Rider deleted successfully'
    });
    
  } catch (error) {
    console.error('Delete rider error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Bulk upload riders from CSV
// @route   POST /api/companies/riders/bulk
// @access  Private
exports.bulkUploadRiders = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }
    
    // Parse CSV file
    const csvData = await parseCSV(req.file.buffer);
    
    if (!csvData.length) {
      return res.status(400).json({
        success: false,
        message: 'CSV file is empty'
      });
    }
    
    const companyId = req.company._id;
    const addedRiders = [];
    const skippedRiders = [];
    
    // Process each row
    for (const row of csvData) {
      try {
        const { fullName, phoneNumber, email, plateNumber, vehicleType = 'motorcycle' } = row;
        
        // Validate required fields
        if (!fullName || !phoneNumber || !plateNumber) {
          skippedRiders.push({
            row,
            reason: 'Missing required fields (fullName, phoneNumber, or plateNumber)'
          });
          continue;
        }
        
        // Check for duplicates
        const existingRider = await CompanyRider.findOne({
          company: companyId,
          $or: [
            { phoneNumber },
            { plateNumber }
          ]
        });
        
        if (existingRider) {
          skippedRiders.push({
            row,
            reason: 'Duplicate phone number or plate number'
          });
          continue;
        }
        
        // Create rider
        const rider = await CompanyRider.create({
          company: companyId,
          fullName,
          phoneNumber,
          email,
          plateNumber,
          vehicleType,
          isActive: true,
          isAvailable: false,
          status: 'active',
          stats: {
            totalDeliveries: 0,
            completedDeliveries: 0,
            cancelledDeliveries: 0,
            totalEarnings: 0,
            rating: 0
          }
        });
        
        addedRiders.push(rider);
        
      } catch (error) {
        skippedRiders.push({
          row,
          reason: error.message
        });
      }
    }
    
    res.status(200).json({
      success: true,
      message: `Successfully added ${addedRiders.length} riders, skipped ${skippedRiders.length}`,
      data: {
        added: addedRiders.length,
        skipped: skippedRiders.length,
        riders: addedRiders,
        skippedDetails: skippedRiders
      }
    });
    
  } catch (error) {
    console.error('Bulk upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process bulk upload',
      error: error.message
    });
  }
};

// @desc    Update rider status
// @route   PUT /api/companies/riders/:id/status
// @access  Private
exports.updateRiderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isActive must be a boolean value'
      });
    }
    
    const rider = await CompanyRider.findOne({
      _id: id,
      company: req.company._id
    });
    
    if (!rider) {
      return res.status(404).json({
        success: false,
        message: 'Rider not found'
      });
    }
    
    rider.isActive = isActive;
    rider.status = isActive ? 'active' : 'inactive';
    await rider.save();
    
    res.json({
      success: true,
      message: `Rider ${isActive ? 'activated' : 'deactivated'} successfully`,
      data: rider
    });
  } catch (error) {
    console.error('Update rider status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get company deliveries
// @route   GET /api/companies/deliveries
// @access  Private
exports.getDeliveries = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, startDate, endDate, riderId } = req.query;
    const skip = (page - 1) * limit;
    
    const query = { company: req.company._id };
    
    // Apply filters
    if (status && status !== 'all') {
      query.status = status;
    }
    
    if (riderId) {
      query.rider = riderId;
    }
    
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    
    const deliveries = await CompanyDelivery.find(query)
      .populate('rider', 'fullName phoneNumber riderId')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await CompanyDelivery.countDocuments(query);
    
    res.json({
      success: true,
      data: {
        deliveries,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Get deliveries error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get single delivery
// @route   GET /api/companies/deliveries/:id
// @access  Private
exports.getDelivery = async (req, res) => {
  try {
    const { id } = req.params;
    
    const delivery = await CompanyDelivery.findOne({
      _id: id,
      company: req.company._id
    }).populate('rider', 'fullName phoneNumber riderId');
    
    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found'
      });
    }
    
    res.json({
      success: true,
      data: delivery
    });
  } catch (error) {
    console.error('Get delivery error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get settlements
// @route   GET /api/companies/settlements
// @access  Private
exports.getSettlements = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const skip = (page - 1) * limit;
    
    const query = { company: req.company._id };
    
    if (status && status !== 'all') {
      query.status = status;
    }
    
    const settlements = await Settlement.find(query)
      .populate('deliveries', 'deliveryId amount customer')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await Settlement.countDocuments(query);
    
    res.json({
      success: true,
      data: {
        settlements,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Get settlements error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get single settlement
// @route   GET /api/companies/settlements/:id
// @access  Private
exports.getSettlement = async (req, res) => {
  try {
    const { id } = req.params;
    
    const settlement = await Settlement.findOne({
      _id: id,
      company: req.company._id
    }).populate('deliveries');
    
    if (!settlement) {
      return res.status(404).json({
        success: false,
        message: 'Settlement not found'
      });
    }
    
    res.json({
      success: true,
      data: settlement
    });
  } catch (error) {
    console.error('Get settlement error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Request new settlement
// @route   POST /api/companies/settlements/request
// @access  Private
exports.requestSettlement = async (req, res) => {
  try {
    const companyId = req.company._id;
    
    // Find all unpaid completed deliveries
    const unpaidDeliveries = await CompanyDelivery.find({
      company: companyId,
      status: 'delivered',
      settlementStatus: 'unpaid'
    });
    
    if (unpaidDeliveries.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No pending deliveries for settlement'
      });
    }
    
    // Calculate total amount
    const totalAmount = unpaidDeliveries.reduce((sum, delivery) => sum + delivery.companyEarnings, 0);
    
    if (totalAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'No earnings to settle'
      });
    }
    
    // Get date range for settlement period
    const oldestDelivery = unpaidDeliveries.reduce((oldest, delivery) => 
      delivery.completedAt < oldest.completedAt ? delivery : oldest
    );
    const newestDelivery = unpaidDeliveries.reduce((newest, delivery) => 
      delivery.completedAt > newest.completedAt ? delivery : newest
    );
    
    // Create settlement
    const settlement = await Settlement.create({
      company: companyId,
      startDate: oldestDelivery.completedAt,
      endDate: newestDelivery.completedAt,
      amount: totalAmount,
      deliveryCount: unpaidDeliveries.length,
      deliveries: unpaidDeliveries.map(d => d._id),
      status: 'pending',
      bankDetails: req.company.bankAccount
    });
    
    // Update delivery settlement status
    await CompanyDelivery.updateMany(
      { _id: { $in: unpaidDeliveries.map(d => d._id) } },
      { 
        settlementStatus: 'processing',
        settlement: settlement._id
      }
    );
    
    // Update company pending settlement
    const company = await Company.findById(companyId);
    if (company) {
      company.stats.pendingSettlement = Math.max(0, company.stats.pendingSettlement - totalAmount);
      await company.save();
    }
    
    res.status(201).json({
      success: true,
      message: 'Settlement requested successfully',
      data: settlement
    });
    
  } catch (error) {
    console.error('Request settlement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to request settlement',
      error: error.message
    });
  }
};

// @desc    Get analytics data
// @route   GET /api/companies/analytics
// @access  Private
exports.getAnalytics = async (req, res) => {
  try {
    const companyId = req.company._id;
    const { period = 'week' } = req.query;
    
    // Calculate date ranges based on period
    const endDate = new Date();
    const startDate = new Date();
    
    switch (period) {
      case 'day':
        startDate.setDate(startDate.getDate() - 1);
        break;
      case 'week':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case 'month':
        startDate.setMonth(startDate.getMonth() - 1);
        break;
      case 'year':
        startDate.setFullYear(startDate.getFullYear() - 1);
        break;
      default:
        startDate.setDate(startDate.getDate() - 7);
    }
    
    // Get delivery trends
    const deliveryTrends = await CompanyDelivery.aggregate([
      {
        $match: {
          company: companyId,
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" }
          },
          count: { $sum: 1 },
          earnings: { $sum: "$companyEarnings" }
        }
      },
      {
        $sort: { _id: 1 }
      }
    ]);
    
    // Get rider performance
    const riderPerformance = await CompanyDelivery.aggregate([
      {
        $match: {
          company: companyId,
          createdAt: { $gte: startDate, $lte: endDate },
          status: 'delivered'
        }
      },
      {
        $group: {
          _id: "$rider",
          deliveries: { $sum: 1 },
          earnings: { $sum: "$companyEarnings" },
          averageDuration: { $avg: "$actualDuration" }
        }
      },
      {
        $lookup: {
          from: 'companyriders',
          localField: '_id',
          foreignField: '_id',
          as: 'rider'
        }
      },
      {
        $unwind: "$rider"
      },
      {
        $project: {
          riderName: "$rider.fullName",
          riderId: "$rider.riderId",
          deliveries: 1,
          earnings: 1,
          averageDuration: 1
        }
      },
      {
        $sort: { deliveries: -1 }
      },
      {
        $limit: 10
      }
    ]);
    
    // Get status distribution
    const statusDistribution = await CompanyDelivery.aggregate([
      {
        $match: {
          company: companyId,
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 }
        }
      }
    ]);
    
    res.json({
      success: true,
      data: {
        period: {
          startDate,
          endDate
        },
        deliveryTrends,
        riderPerformance,
        statusDistribution,
        summary: {
          totalDeliveries: deliveryTrends.reduce((sum, day) => sum + day.count, 0),
          totalEarnings: deliveryTrends.reduce((sum, day) => sum + day.earnings, 0),
          averageDeliveriesPerDay: deliveryTrends.length > 0 ? 
            (deliveryTrends.reduce((sum, day) => sum + day.count, 0) / deliveryTrends.length).toFixed(2) : 0
        }
      }
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};
