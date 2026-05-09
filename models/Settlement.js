const mongoose = require('mongoose');

const settlementSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  reference: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  startDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date,
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  deliveryCount: {
    type: Number,
    default: 0
  },
  deliveries: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CompanyDelivery'
  }],
  status: {
    type: String,
    enum: ['pending', 'processing', 'paid', 'failed', 'cancelled'],
    default: 'pending',
    index: true
  },
  paidAt: {
    type: Date
  },
  paymentReference: {
    type: String
  },
  paymentMethod: {
    type: String,
    enum: ['bank_transfer', 'wallet', 'card'],
    default: 'bank_transfer'
  },
  bankDetails: {
    accountNumber: String,
    bankName: String,
    accountName: String
  },
  notes: {
    type: String
  },
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Generate reference before saving
settlementSchema.pre('save', function(next) {
  if (!this.reference) {
    const date = new Date();
    const dateStr = date.toISOString().slice(2, 10).replace(/-/g, '');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    this.reference = `SET-${dateStr}-${random}`;
  }
  next();
});

// Update delivery settlement status after settlement is saved
settlementSchema.post('save', async function(doc) {
  const CompanyDelivery = mongoose.model('CompanyDelivery');
  const Company = mongoose.model('Company');
  
  try {
    if (doc.status === 'paid' && doc.deliveries && doc.deliveries.length > 0) {
      await CompanyDelivery.updateMany(
        { _id: { $in: doc.deliveries } },
        { 
          settlementStatus: 'paid',
          settlement: doc._id,
          settledAt: new Date()
        }
      );
      
      // Update company pending settlement
      const company = await Company.findById(doc.company);
      if (company) {
        company.stats.pendingSettlement = Math.max(0, company.stats.pendingSettlement - doc.amount);
        await company.save();
      }
    } else if (doc.status === 'failed' || doc.status === 'cancelled') {
      // Reset delivery settlement status if settlement fails
      await CompanyDelivery.updateMany(
        { _id: { $in: doc.deliveries } },
        { 
          settlementStatus: 'unpaid',
          settlement: null,
          settledAt: null
        }
      );
      
      // Restore company pending settlement
      const company = await Company.findById(doc.company);
      if (company) {
        company.stats.pendingSettlement = (company.stats.pendingSettlement || 0) + doc.amount;
        await company.save();
      }
    }
  } catch (error) {
    console.error('Error updating settlement status:', error);
  }
});

// Virtual for formatted amount
settlementSchema.virtual('formattedAmount').get(function() {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 0
  }).format(this.amount);
});

// Virtual for period string
settlementSchema.virtual('periodString').get(function() {
  const start = this.startDate ? this.startDate.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }) : 'N/A';
  
  const end = this.endDate ? this.endDate.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }) : 'N/A';
  
  return `${start} - ${end}`;
});

// Indexes for better query performance
settlementSchema.index({ company: 1, status: 1 });
settlementSchema.index({ createdAt: -1 });

const Settlement = mongoose.model('Settlement', settlementSchema);

module.exports = Settlement;
