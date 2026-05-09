const mongoose = require('mongoose');

const companyDeliverySchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  deliveryId: {
    type: String,
    unique: true,
    required: true,
    index: true
  },
  rider: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CompanyRider',
    index: true
  },
  mainOrder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MainOrder'
  },
  customer: {
    name: String,
    phoneNumber: String,
    address: String
  },
  pickupDetails: {
    vendorName: String,
    vendorAddress: String,
    pickupTime: Date,
    pickupOTP: String,
    pickupVerified: {
      type: Boolean,
      default: false
    },
    pickupVerifiedAt: Date
  },
  deliveryDetails: {
    deliveryAddress: String,
    city: String,
    postalCode: String,
    deliveryTime: Date,
    deliveryOTP: String,
    deliveryVerified: {
      type: Boolean,
      default: false
    },
    deliveryVerifiedAt: Date
  },
  items: [{
    name: String,
    quantity: Number,
    price: Number
  }],
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  commission: {
    type: Number,
    default: 0
  },
  companyEarnings: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['pending', 'assigned', 'picked_up', 'in_transit', 'delivered', 'cancelled', 'failed'],
    default: 'pending',
    index: true
  },
  // SETTLEMENT FIELDS - ADDED
  settlementStatus: {
    type: String,
    enum: ['unpaid', 'processing', 'paid'],
    default: 'unpaid',
    index: true
  },
  settlement: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Settlement'
  },
  settledAt: Date,
  // END SETTLEMENT FIELDS
  timeline: [{
    status: String,
    timestamp: {
      type: Date,
      default: Date.now
    },
    notes: String
  }],
  notes: String,
  cancellationReason: String,
  rating: {
    stars: {
      type: Number,
      min: 1,
      max: 5
    },
    comment: String,
    givenAt: Date
  },
  estimatedDuration: Number, // in minutes
  actualDuration: Number, // in minutes
  distance: Number, // in kilometers
  completedAt: Date,
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
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

// Generate delivery ID
companyDeliverySchema.pre('save', async function(next) {
  if (!this.deliveryId) {
    const date = new Date();
    const dateStr = date.toISOString().slice(2, 10).replace(/-/g, '');
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    this.deliveryId = `CD-${dateStr}-${random}`;
  }
  
  // Calculate company earnings (80% of amount)
  if (this.amount && !this.companyEarnings) {
    this.companyEarnings = this.amount * 0.8; // 80% to company, 20% platform commission
    this.commission = this.amount * 0.2; // 20% commission
  }
  
  // Add to timeline when status changes
  if (this.isModified('status')) {
    this.timeline.push({
      status: this.status,
      notes: this.notes || 'Status updated',
      timestamp: new Date()
    });
  }
  
  next();
});

// Update company stats when delivery status changes
companyDeliverySchema.post('save', async function(doc) {
  const Company = mongoose.model('Company');
  const CompanyRider = mongoose.model('CompanyRider');
  
  try {
    const company = await Company.findById(doc.company);
    
    if (company) {
      if (doc.status === 'delivered') {
        company.stats.completedDeliveries += 1;
        company.stats.totalEarnings += doc.companyEarnings;
        
        // Only add to pending settlement if not already settled
        if (doc.settlementStatus === 'unpaid') {
          company.stats.pendingSettlement += doc.companyEarnings;
        }
      } else if (doc.status === 'pending' || doc.status === 'assigned' || doc.status === 'picked_up') {
        const pendingCount = await mongoose.model('CompanyDelivery').countDocuments({
          company: doc.company,
          status: { $in: ['pending', 'assigned', 'picked_up'] }
        });
        company.stats.pendingDeliveries = pendingCount;
      }
      await company.save();
    }
    
    // Update rider stats if assigned and delivered
    if (doc.rider && doc.status === 'delivered') {
      const rider = await CompanyRider.findById(doc.rider);
      if (rider) {
        rider.stats.completedDeliveries += 1;
        rider.stats.totalEarnings += doc.companyEarnings;
        await rider.save();
      }
    }
  } catch (error) {
    console.error('Error updating stats:', error);
  }
});

// Virtual for formatted amount
companyDeliverySchema.virtual('formattedAmount').get(function() {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 0
  }).format(this.amount || 0);
});

// Virtual for formatted company earnings
companyDeliverySchema.virtual('formattedCompanyEarnings').get(function() {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 0
  }).format(this.companyEarnings || 0);
});

// Indexes for better query performance
companyDeliverySchema.index({ company: 1, status: 1 });
companyDeliverySchema.index({ company: 1, settlementStatus: 1 });
companyDeliverySchema.index({ rider: 1, status: 1 });
companyDeliverySchema.index({ createdAt: -1 });

const CompanyDelivery = mongoose.model('CompanyDelivery', companyDeliverySchema);
module.exports = CompanyDelivery;
