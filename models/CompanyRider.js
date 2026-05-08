const mongoose = require('mongoose');

const companyRiderSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  riderId: {
    type: String,
    unique: true,
    required: true,
    default: function() {
    const timestamp = Date.now().toString().slice(-6);
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    return `CR${timestamp}${random}`;
  }
  },
  fullName: {
    type: String,
    required: true
  },
  phoneNumber: {
    type: String,
    required: true
  },
  email: {
    type: String,
    lowercase: true
  },
  plateNumber: {
    type: String,
    required: true
  },
  vehicleType: {
    type: String,
    enum: ['motorcycle', 'bicycle', 'car', 'scooter'],
    default: 'motorcycle'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isAvailable: {
    type: Boolean,
    default: false
  },
  currentLocation: {
    lat: Number,
    lng: Number,
    address: String,
    updatedAt: Date
  },
  stats: {
    completedDeliveries: {
      type: Number,
      default: 0
    },
    activeDeliveries: {
      type: Number,
      default: 0
    },
    totalEarnings: {
      type: Number,
      default: 0
    },
    averageRating: {
      type: Number,
      default: 0
    },
    cancellationCount: {
      type: Number,
      default: 0
    },
    totalHours: {
      type: Number,
      default: 0
    }
  },
  documents: {
    ninFront: String,
    ninBack: String,
    platePhoto: String,
    selfie: String,
    verified: {
      type: Boolean,
      default: false
    },
    verifiedAt: Date,
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin'
    }
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'suspended', 'pending_verification'],
    default: 'pending_verification'
  },
  lastActivity: Date,
  joinedAt: {
    type: Date,
    default: Date.now
  },
  notes: [{
    content: String,
    addedBy: {
      type: String,
      enum: ['system', 'company', 'admin']
    },
    addedAt: {
      type: Date,
      default: Date.now
    }
  }],
  meta: {
    internalId: String,
    customFields: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true
});

// Generate rider ID before saving
companyRiderSchema.pre('save', async function(next) {
  if (!this.riderId) {
    const count = await this.constructor.countDocuments({ company: this.company });
    this.riderId = `${this.company.toString().slice(-4)}-${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

// Update company stats when rider status changes
companyRiderSchema.post('save', async function(doc) {
  const Company = mongoose.model('Company');
  const company = await Company.findById(doc.company);
  
  if (company) {
    const activeRiders = await mongoose.model('CompanyRider').countDocuments({
      company: doc.company,
      isActive: true,
      status: 'active'
    });
    
    const totalRiders = await mongoose.model('CompanyRider').countDocuments({
      company: doc.company
    });
    
    company.stats.activeRiders = activeRiders;
    company.stats.totalRiders = totalRiders;
    await company.save();
  }
});

companyRiderSchema.index({ company: 1, status: 1 });
companyRiderSchema.index({ company: 1, isActive: 1 });
companyRiderSchema.index({ status: 1, createdAt: -1 });
companyRiderSchema.index({ isAvailable: 1, isActive: 1, status: 1 });

const CompanyRider = mongoose.model('CompanyRider', companyRiderSchema);
module.exports = CompanyRider;
