const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const companySchema = new mongoose.Schema({
  companyName: {
    type: String,
    required: true,
    trim: true
  },
  rcNumber: {
    type: String,
    sparse: true
  },
  officeAddress: {
    type: String,
    required: true
  },
  contactPerson: {
    type: String,
    required: true
  },
  phoneNumber: {
    type: String,
    required: true,
    unique: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true
  },
  bankAccount: {
    bankName: String,
    accountNumber: String,
    accountName: String
  },
  estimatedRiders: {
    type: Number,
    default: 0
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  verificationCode: String,
  verificationExpires: Date,
  status: {
    type: String,
    enum: ['active', 'suspended', 'pending'],
    default: 'pending'
  },
  settings: {
    autoAssignRiders: {
      type: Boolean,
      default: true
    },
    notificationEmail: {
      type: Boolean,
      default: true
    },
    notificationSMS: {
      type: Boolean,
      default: true
    },
    settlementFrequency: {
      type: String,
      enum: ['weekly', 'bi-weekly', 'monthly'],
      default: 'weekly'
    }
  },
  stats: {
    totalEarnings: {
      type: Number,
      default: 0
    },
    pendingSettlement: {
      type: Number,
      default: 0
    },
    completedDeliveries: {
      type: Number,
      default: 0
    },
    pendingDeliveries: {
      type: Number,
      default: 0
    },
    totalRiders: {
      type: Number,
      default: 0
    },
    activeRiders: {
      type: Number,
      default: 0
    },
    cancellationRate: {
      type: Number,
      default: 0
    },
    averageRating: {
      type: Number,
      default: 0
    }
  },
  lastLogin: Date,
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Hash password before saving
companySchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
companySchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Generate verification code
companySchema.methods.generateVerificationCode = function() {
  // Generate a 6-digit code
  this.verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
  this.verificationExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  return this.verificationCode;
};

// Method to generate JWT token
companySchema.methods.generateAuthToken = function() {
  const token = jwt.sign(
    { 
      id: this._id,
      companyId: this._id,
      role: 'company',
      email: this.email,
      companyName: this.companyName,
      contactPerson: this.contactPerson
    }, 
    process.env.JWT_SECRET, 
    { expiresIn: '30d' }
  );
  return token;
};

const Company = mongoose.model('Company', companySchema);
module.exports = Company;