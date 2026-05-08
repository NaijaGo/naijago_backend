const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const riderSchema = new mongoose.Schema({
  // Personal Information
  fullName: { 
    type: String, 
    required: [true, 'Full name is required'],
    trim: true,
    minlength: [2, 'Full name must be at least 2 characters'],
    maxlength: [100, 'Full name cannot exceed 100 characters']
  },
  
  email: { 
    type: String, 
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email']
  },
  
  password: { 
    type: String, 
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters'],
    select: false // Don't include password in queries by default
  },
  
  phoneNumber: {
    type: String,
    required: [true, 'Phone number is required'],
    match: [/^\+?[\d\s-]{10,}$/, 'Please provide a valid phone number']
  },

  dateOfBirth: {
    type: Date
  },

  gender: {
    type: String,
    trim: true
  },

  homeAddress: {
    type: String,
    trim: true
  },
  
  // Vehicle Information
  plateNumber: { 
    type: String, 
    required: [true, 'Plate number is required'],
    uppercase: true,
    trim: true,
    unique: true
  },
  
  vehicleType: {
    type: String,
    enum: ['motorcycle', 'bicycle', 'car', 'scooter'],
    default: 'motorcycle'
  },
  
  vehicleBrand: {
    type: String,
    trim: true
  },
  
  vehicleColor: {
    type: String,
    trim: true
  },

  state: {
    type: String,
    trim: true
  },

  city: {
    type: String,
    trim: true
  },

  deliveryZone: {
    type: String,
    trim: true
  },

  licenseNumber: {
    type: String,
    trim: true
  },

  idType: {
    type: String,
    trim: true
  },

  idNumber: {
    type: String,
    trim: true
  },
  
  // Document Management
  documents: {
    ninFront: { 
      type: String,
      required: [true, 'Front NIN image is required']
    },
    ninBack: { 
      type: String,
      required: [true, 'Back NIN image is required']
    },
    platePhoto: { 
      type: String,
      required: [true, 'Plate photo is required']
    },
    selfie: { 
      type: String,
      required: [true, 'Selfie is required']
    },
    driverLicense: {
      type: String
    },
    insurance: {
      type: String
    },
    vehiclePapers: {
      type: String
    }
  },
  
  // Status Management
  status: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected', 'suspended'], 
    default: 'pending' 
  },
  
  isVerified: { 
    type: Boolean, 
    default: false 
  },
  
  isEmailVerified: { 
    type: Boolean, 
    default: false 
  },
  
  isActive: {
    type: Boolean,
    default: false
  },

  oneSignalUserId: {
    type: String,
    sparse: true,
  },

  oneSignalPlayerId: {
    type: String,
    sparse: true,
  },
  
  // Email Verification
  emailVerificationToken: { 
    type: String 
  },
  
  emailVerificationExpires: { 
    type: Date 
  },
  
  // Password Reset
  passwordResetToken: {
    type: String
  },
  
  passwordResetExpires: {
    type: Date
  },
  
  // Rejection Management
  rejectionReason: { 
    type: String,
    maxlength: [500, 'Rejection reason cannot exceed 500 characters']
  },
  
  rejectionDate: {
    type: Date
  },
  
  // Financial Management
  walletBalance: { 
    type: Number, 
    default: 0,
    min: [0, 'Wallet balance cannot be negative']
  },
  
  totalEarnings: { 
    type: Number, 
    default: 0,
    min: [0, 'Total earnings cannot be negative']
  },
  
  pendingEarnings: {
    type: Number,
    default: 0
  },
  
  totalWithdrawn: {
    type: Number,
    default: 0
  },
  
  // Activity Tracking
  activeDeliveries: { 
    type: Number, 
    default: 0 
  },
  
  completedDeliveries: {
    type: Number,
    default: 0
  },
  
  cancellationRate: {
    type: Number,
    default: 0
  },
  
  rating: {
    type: Number,
    default: 0,
    min: [0, 'Rating cannot be less than 0'],
    max: [5, 'Rating cannot exceed 5']
  },
  
  totalRatings: {
    type: Number,
    default: 0
  },
  
  // Withdrawal History
  withdrawalHistory: [{
    amount: {
      type: Number,
      required: true,
      min: [100, 'Minimum withdrawal amount is 100']
    },
    status: { 
      type: String, 
      enum: ['pending', 'completed', 'failed', 'cancelled'], 
      default: 'pending' 
    },
    createdAt: { 
      type: Date, 
      default: Date.now 
    },
    completedAt: {
      type: Date
    },
    reference: {
      type: String,
      unique: true
    },
    paymentMethod: {
      type: String,
      enum: ['bank_transfer', 'mobile_money', 'cash'],
      default: 'bank_transfer'
    },
    accountDetails: {
      bankName: String,
      accountNumber: String,
      accountName: String,
      mobileProvider: String,
      mobileNumber: String
    },
    failureReason: String
  }],
  notifications: [
  {
    type: {
      type: String,
      enum: [
        'product_sold',
        'payment_received',
        'wallet_deposit',
        'wallet_withdrawal',
        'vendor_status_update',
        'general',
        'admin_message',
        'order_update',
        'delivery_payout'           // ← include it here too
      ],
      default: 'general',
    },
    message: {
      type: String,
      required: true,
    },
    read: {
      type: Boolean,
      default: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    relatedId: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'notifications.relatedModel',
      sparse: true,
    },
    relatedModel: {
      type: String,
      enum: [
        'Product',
        'Order',
        'Transaction',
        'User',
        'MainOrder'                 // ← include it here too
      ],
      sparse: true,
    },
  }
],
  // Location Management
  currentLocation: {
    lat: {
      type: Number,
      min: [-90, 'Invalid latitude'],
      max: [90, 'Invalid latitude']
    },
    lng: {
      type: Number,
      min: [-180, 'Invalid longitude'],
      max: [180, 'Invalid longitude']
    },
    lastUpdated: {
      type: Date
    },
    address: String
  },
  
  // Availability
  isAvailable: {
    type: Boolean,
    default: false
  },
  
  lastActive: {
    type: Date
  },
  
  // Bank/Account Information
  bankAccount: {
    bankName: String,
    accountNumber: String,
    accountName: String,
    bankCode: String,
    verified: {
      type: Boolean,
      default: false
    }
  },
  
  // Metadata
  deviceToken: {
    type: String
  },
  
  devicePlatform: {
    type: String,
    enum: ['ios', 'android', 'web']
  },
  
  appVersion: {
    type: String
  },
  
  // Audit Fields
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  
  approvedAt: {
    type: Date
  },
  
  // Timestamps
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});



// Virtual for average rating
riderSchema.virtual('averageRating').get(function() {
  return this.totalRatings > 0 ? (this.rating / this.totalRatings).toFixed(1) : 0;
});

// Virtual for total deliveries
riderSchema.virtual('totalDeliveries').get(function() {
  return this.completedDeliveries + this.activeDeliveries;
});

// Indexes for better query performance
riderSchema.index({ email: 1 }, { unique: true });
riderSchema.index({ plateNumber: 1 }, { unique: true });
riderSchema.index({ status: 1 });
riderSchema.index({ isActive: 1 });
riderSchema.index({ isAvailable: 1 });
riderSchema.index({ 'currentLocation': '2dsphere' });
riderSchema.index({ createdAt: -1 });
riderSchema.index({ walletBalance: -1 });
riderSchema.index({ status: 1, createdAt: -1 });
riderSchema.index({ isAvailable: 1, isActive: 1, status: 1 });
riderSchema.index({ 'withdrawalHistory.status': 1, 'withdrawalHistory.createdAt': -1 });

// Password Hashing Middleware
riderSchema.pre('save', async function (next) {
  // Only hash the password if it's modified (or new)
  if (!this.isModified('password')) return next();
  
  try {
    // Generate salt
    const salt = await bcrypt.genSalt(12);
    
    // Hash password
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Update timestamp on save
riderSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Method to compare password
riderSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to generate email verification token
riderSchema.methods.generateEmailVerificationToken = function() {
  // Generate random token
  const verificationToken = crypto.randomBytes(32).toString('hex');
  
  // Hash token and set to emailVerificationToken field
  this.emailVerificationToken = crypto
    .createHash('sha256')
    .update(verificationToken)
    .digest('hex');
    
  // Set expiration (24 hours from now)
  this.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000;
  
  return verificationToken;
};

// Method to generate password reset token
riderSchema.methods.generatePasswordResetToken = function() {
  // Generate random token
  const resetToken = crypto.randomBytes(32).toString('hex');
  
  // Hash token and set to passwordResetToken field
  this.passwordResetToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');
    
  // Set expiration (1 hour from now)
  this.passwordResetExpires = Date.now() + 60 * 60 * 1000;
  
  return resetToken;
};

// Method to check if rider can withdraw
riderSchema.methods.canWithdraw = function(amount) {
  return this.walletBalance >= amount && amount >= 100;
};

// Method to update location
riderSchema.methods.updateLocation = function(lat, lng, address = '') {
  this.currentLocation = {
    lat,
    lng,
    lastUpdated: Date.now(),
    address
  };
  return this.save();
};

// Static method to find nearby riders
riderSchema.statics.findNearby = async function(lat, lng, maxDistance = 5000, limit = 10) {
  return this.find({
    isActive: true,
    isAvailable: true,
    status: 'approved',
    currentLocation: {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: [lng, lat]
        },
        $maxDistance: maxDistance
      }
    }
  })
  .select('fullName currentLocation plateNumber vehicleType rating')
  .limit(limit);
};

module.exports = mongoose.model('Rider', riderSchema);





// const mongoose = require('mongoose');
// const bcrypt = require('bcryptjs');

// const riderSchema = new mongoose.Schema({
//   fullName: { type: String, required: true },
//   email: { type: String, required: true, unique: true, lowercase: true },
//   password: { type: String, required: true },
//   plateNumber: { type: String, required: true },
//   documents: {
//     ninFront: { type: String },
//     ninBack: { type: String },
//     platePhoto: { type: String },
//     selfie: { type: String }
//   },
//   status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
//   isVerified: { type: Boolean, default: false },
//   // Add these fields to your riderSchema
//   emailVerificationToken: { type: String },
//   emailVerificationExpires: { type: Date },
//   isEmailVerified: { type: Boolean, default: false },
//   rejectionReason: { type: String }, // To store why they were rejected
//   // Add these to your riderSchema
//   walletBalance: { type: Number, default: 0 },
//   totalEarnings: { type: Number, default: 0 },
//   activeDeliveries: { type: Number, default: 0 },
//   withdrawalHistory: [{
//     amount: Number,
//     status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
//     createdAt: { type: Date, default: Date.now },
//     reference: String
//   }],
//   currentLocation: {
//     lat: Number,
//     lng: Number
//   },
//   createdAt: { type: Date, default: Date.now }
// });

// // Password Hashing Hook
// riderSchema.pre('save', async function (next) {
//   if (!this.isModified('password')) return next();
//   const salt = await bcrypt.genSalt(10);
//   this.password = await bcrypt.hash(this.password, salt);
//   next();
// });

// module.exports = mongoose.model('Rider', riderSchema);
