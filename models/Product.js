// models/Product.js

const mongoose = require('mongoose');

const productSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
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
    stockQuantity: {
      type: Number,
      required: true,
      default: 0,
    },

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

    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: 'User',
    },
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
