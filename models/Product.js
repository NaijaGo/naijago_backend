// models/Product.js

const mongoose = require('mongoose');
const { deriveSearchAttributes } = require('../utils/catalogSearch');

const productSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: { type: String, trim: true, lowercase: true, index: true },
    brand: { type: String, trim: true, default: '' },
    description: {
      type: String,
      required: true,
    },
    price: {
      type: Number,
      required: true,
      default: 0,
    },
    category: {
      type: String,
      required: true,
    },
    subcategory: { type: String, trim: true, default: '', index: true },
    searchTags: [{ type: String, trim: true, lowercase: true }],
    gender: { type: String, enum: ['female', 'male', 'unisex', 'unspecified'] },
    ageGroup: { type: String, enum: ['adult', 'child', 'all'] },
    productType: { type: String, trim: true, lowercase: true, maxlength: 60 },
    searchAttributes: {
      type: new mongoose.Schema({
        version: Number, categoryPath: [String], categoryFamily: String,
        gender: String, ageGroup: String, productTypes: [String], tokens: [String],
      }, { _id: false }),
      default: undefined,
    },
    sku: { type: String, trim: true, uppercase: true },
    gtin: { type: String, trim: true },
    // Optional; the actual URL is served only after media moderation. A unique
    // sparse reference prevents a video from being attached to two listings.
    videoAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'MediaAsset', unique: true, sparse: true },
    discountPrice: { type: Number, default: null, min: 0 },
    stockQuantity: {
      type: Number,
      required: true,
      default: 0,
    },
    variants: [{
      sku: { type: String, trim: true, uppercase: true },
      name: { type: String, trim: true },
      attributes: { type: Map, of: String, default: {} },
      price: { type: Number, min: 0 },
      discountPrice: { type: Number, min: 0, default: null },
      stockQuantity: { type: Number, min: 0, default: 0 },
      imageUrls: [{ type: String, trim: true }],
      isActive: { type: Boolean, default: true },
    }],

    // ------------------------------
    // SIZE DATA FOR MULTIPLE SIZES
    // ------------------------------
    sizeData: {
      type: {
        type: String,
        enum: ['clothing', 'shoes', 'watches', 'baby', 'pet', 'custom', null],
        default: null,
      },
      sizes: [
        {
          value: String, // e.g., "S", "M", "L", "40", "42mm"
          label: String, // Optional: "Small", "Medium", "Large"
          unit: String, // e.g., "size", "EU", "mm", "cm", "inch"
        },
      ],
      // For custom dimensions
      customDimensions: [
        {
          length: Number,
          width: Number,
          height: Number,
          unit: {
            type: String,
            enum: ['cm', 'inch', 'mm', 'm'],
            default: 'cm',
          },
          label: String, // Optional: "Small Sofa", "Large Dining Table"
        },
      ],
      multiple: {
        type: Boolean,
        default: false,
      },
    },

    // ------------------------------
    // OLD FIELD (kept for backward compatibility)
    // ------------------------------
    imageUrls: [
      {
        type: String,
        required: true,
      },
    ],
    refinementScanPending: { type: Boolean, select: false },
    refinementScanAfter: { type: Date, select: false },
    refinementScanCode: { type: String, select: false },
    refinementScanProfile: { type: String, enum: ['standard', 'relight'], select: false },
    refinementRequestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', select: false },

    // ------------------------------
    // NEW STRUCTURED IMAGE OBJECT
    // ------------------------------
    images: {
      main: { type: String, required: false }, // Main image
      front: { type: String, required: false },
      back: { type: String, required: false },
      rear: { type: String, required: false },

      // A flexible array for any other images (side view, top view, etc.)
      others: [
        {
          type: String,
        },
      ],
    },
    // ------------------------------

    // Durable seller fields. `vendor` remains temporarily for old clients.
    sellerType: {
      type: String,
      enum: ['naijago', 'vendor'],
      default: 'naijago',
      required: true,
      index: true,
    },
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      required: false,
      ref: 'User',
      default: null,
    },
    sellerHistory: [{
      sellerType: { type: String, enum: ['naijago', 'vendor'], required: true },
      sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      changedAt: { type: Date, default: Date.now },
      changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      reason: { type: String, trim: true, default: '' },
    }],
    productLocation: {
      latitude: { type: Number },
      longitude: { type: Number },
      formattedAddress: { type: String, trim: true },
    },

    // Restaurant / food listing support
    restaurantName: {
      type: String,
      trim: true,
    },
    foodInformation: {
      type: String,
      trim: true,
    },
    foodCategory: {
      type: String,
      trim: true,
      index: true,
    },
    orderStartTime: {
      type: String,
      default: '09:00',
      match: [/^\d{2}:\d{2}$/, 'Order start time must be HH:mm'],
    },
    orderEndTime: {
      type: String,
      default: '19:00',
      match: [/^\d{2}:\d{2}$/, 'Order end time must be HH:mm'],
    },

    // Pharmacy / medicine access support
    medicineAccess: {
      type: String,
      enum: ['over_the_counter', 'prescription', 'pharmacist_approval', 'restricted', null],
      default: null,
    },
    isOverTheCounter: {
      type: Boolean,
      default: false,
    },
    requiresPrescription: {
      type: Boolean,
      default: false,
    },
    requiresPharmacistApproval: {
      type: Boolean,
      default: false,
    },

    averageRating: {
      type: Number,
      default: 0,
    },
    numReviews: {
      type: Number,
      default: 0,
    },

    salesCount: {
      type: Number,
      default: 0,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
    productStatus: {
      type: String,
      enum: ['active', 'out_of_stock', 'disabled', 'draft'],
      default: 'active',
      index: true,
    },
    specifications: { type: Map, of: String, default: {} },
    source: {
      type: String,
      enum: ['vendor', 'naijago_catalog', 'admin', 'import', 'ai_assisted'],
      default: 'vendor',
    },
    provenance: {
      sourceName: { type: String, trim: true, default: '' },
      sourceUrl: { type: String, trim: true, default: '' },
      supplierReference: { type: String, trim: true, default: '' },
      imageRightsConfirmed: { type: Boolean, default: false },
      verifiedAt: { type: Date, default: null },
      verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    aiMetadata: {
      assisted: { type: Boolean, default: false },
      provider: { type: String, trim: true, default: '' },
      model: { type: String, trim: true, default: '' },
      generationId: { type: String, trim: true, default: '' },
      generatedAt: { type: Date, default: null },
      reviewedAt: { type: Date, default: null },
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    moderationStatus: {
      type: String,
      enum: ['approved', 'pending', 'rejected'],
      default: 'approved',
      index: true,
    },
    moderationNote: {
      type: String,
      trim: true,
      default: '',
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // Flashsale support
    is_flashsale: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Virtual field for availableSizes (for easy access)
productSchema.virtual('availableSizes').get(function () {
  if (!this.sizeData || !this.sizeData.type) {
    return [];
  }
  
  if (this.sizeData.type === 'custom') {
    return this.sizeData.customDimensions || [];
  }
  
  return this.sizeData.sizes || [];
});

// Ensure virtual fields are included in JSON output
productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

productSchema.pre('validate', function normalizeSeller(next) {
  this.searchAttributes = deriveSearchAttributes(this);
  if (this.vendor && !this.sellerId) this.sellerId = this.vendor;
  if (this.sellerId && !this.vendor) this.vendor = this.sellerId;
  if (this.sellerId || this.vendor) this.sellerType = 'vendor';

  if (this.sellerType === 'naijago') {
    this.sellerId = null;
    this.vendor = null;
  } else if (!this.sellerId) {
    return next(new Error('Vendor products require a sellerId.'));
  }
  if (this.discountPrice != null && this.discountPrice >= this.price) {
    return next(new Error('Discount price must be lower than the regular price.'));
  }
  if (
    this.source === 'ai_assisted' &&
    this.productStatus === 'active' &&
    (!this.provenance?.verifiedAt || this.provenance?.imageRightsConfirmed !== true)
  ) {
    return next(new Error('AI-assisted products require human verification and confirmed image rights before activation.'));
  }
  if (this.productStatus === 'out_of_stock') this.stockQuantity = 0;
  if (this.stockQuantity <= 0 && this.productStatus === 'active') {
    this.productStatus = 'out_of_stock';
  }
  this.isActive = this.productStatus === 'active' && this.moderationStatus === 'approved';
  next();
});

productSchema.index({ vendor: 1, createdAt: -1 });
productSchema.index({ isActive: 1, 'searchAttributes.categoryFamily': 1, 'searchAttributes.gender': 1 });
productSchema.index({ isActive: 1, 'searchAttributes.tokens': 1 });
productSchema.index({ sellerType: 1, sellerId: 1, createdAt: -1 });
productSchema.index({ category: 1, subcategory: 1, productStatus: 1, createdAt: -1 });
productSchema.index({ sku: 1 }, { unique: true, sparse: true });
productSchema.index({ gtin: 1 }, { unique: true, sparse: true });
productSchema.index({ vendor: 1, isActive: 1, createdAt: -1 });
productSchema.index({ isActive: 1, category: 1, createdAt: -1 });
productSchema.index({ isActive: 1, is_flashsale: 1, createdAt: -1 });
productSchema.index({ moderationStatus: 1, createdAt: -1 });
productSchema.index({ salesCount: -1, createdAt: -1 });
productSchema.index({ name: 'text', description: 'text', brand: 'text', category: 'text', subcategory: 'text', searchTags: 'text', restaurantName: 'text' });

productSchema.index({ refinementScanPending: 1, refinementScanAfter: 1, _id: 1 });
require('../services/imageRefinementProductHooks').imageRefinementProductHooks(productSchema);
const Product = mongoose.model('Product', productSchema);

module.exports = Product;



// // models/Product.js

// const mongoose = require('mongoose');

// const productSchema = mongoose.Schema(
//   {
//     name: {
//       type: String,
//       required: true,
//       trim: true,
//     },
//     description: {
//       type: String,
//       required: true,
//     },
//     price: {
//       type: Number,
//       required: true,
//       default: 0,
//     },
//     category: {
//       type: String,
//       required: true,
//     },
//     stockQuantity: {
//       type: Number,
//       required: true,
//       default: 0,
//     },

//     // ------------------------------
//     // OLD FIELD (kept for backward compatibility)
//     // ------------------------------
//     imageUrls: [
//       {
//         type: String,
//         required: true,
//       },
//     ],

//     // ------------------------------
//     // NEW STRUCTURED IMAGE OBJECT
//     // ------------------------------
//     images: {
//       main: { type: String, required: false }, // Main image
//       front: { type: String, required: false },
//       back: { type: String, required: false },
//       rear: { type: String, required: false },

//       // A flexible array for any other images (side view, top view, etc.)
//       others: [
//         {
//           type: String,
//         },
//       ],
//     },
//     // ------------------------------

//     vendor: {
//       type: mongoose.Schema.Types.ObjectId,
//       required: true,
//       ref: 'User',
//     },

//     averageRating: {
//       type: Number,
//       default: 0,
//     },
//     numReviews: {
//       type: Number,
//       default: 0,
//     },

//     salesCount: {
//       type: Number,
//       default: 0,
//     },

//     isActive: {
//       type: Boolean,
//       default: true,
//     },

//     // Flashsale support
//     is_flashsale: {
//       type: Boolean,
//       default: false,
//     },
//   },
//   {
//     timestamps: true,
//   }
// );

// const Product = mongoose.model('Product', productSchema);

// module.exports = Product;
