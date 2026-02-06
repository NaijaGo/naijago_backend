// models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Define the User Schema
const UserSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: [true, 'First name is required'],
    trim: true,
  },
  lastName: {
    type: String,
    required: [true, 'Last name is required'],
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    trim: true,
    lowercase: true,
    match: [/.+@.+\..+/, 'Please enter a valid email address'],
  },
  phoneNumber: {
    type: String,
    required: [true, 'Phone number is required'],
    unique: true,
    trim: true,
    match: [/^(?:\+?234|0)[789]\d{9}$/, 'Please enter a valid Nigerian phone number'],
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters long'],
  },
  isEmailVerified: {
    type: Boolean,
    default: false,
  },
  emailVerificationToken: String,
  emailVerificationExpires: Date,

  isDeviceVerified: {
    type: Boolean,
    default: false,
  },
  deviceFingerprint: {
    type: String,
    sparse: true,
  },
  deviceVerificationToken: String,
  deviceVerificationExpires: Date,

  passwordResetToken: String,
  passwordResetExpires: Date,

  // --- VENDOR-SPECIFIC FIELDS ---
  isVendor: {
    type: Boolean,
    default: false,
  },
  vendorStatus: {
    type: String,
    enum: ['none', 'sent', 'received', 'reviewing', 'approved', 'rejected'],
    default: 'none',
  },
  vendorRequestDate: {
    type: Date,
  },
  vendorRejectionDate: {
    type: Date,
  },
  businessName: {
    type: String,
    trim: true,
    sparse: true,
  },
  businessCategories: {
    type: [String],
    sparse: true,
  },
  profilePicUrl: {
    type: String,
    sparse: true,
  },
  // NEW FIELD: Business Location
  businessLocation: {
    type: {
      latitude: { type: Number, required: true },
      longitude: { type: Number, required: true },
      formattedAddress: { type: String, required: false },
    },
    sparse: true,
  },
  // Vendor Dashboard Metrics (Initialize for future use)
  totalProducts: {
    type: Number,
    default: 0,
  },
  productsSold: {
    type: Number,
    default: 0,
  },
  productsUnsold: {
    type: Number,
    default: 0,
  },
  followersCount: {
    type: Number,
    default: 0,
  },
  // Vendor Wallet (Earnings from sales)
  vendorWalletBalance: {
    type: Number,
    default: 0.00,
    min: 0,
  },
  // App Wallet (For vendor payments to app, e.g., ads)
  appWalletBalance: {
    type: Number,
    default: 0.00,
    min: 0,
  },

  // --- BUYER-SPECIFIC FIELDS (NEW) ---
  userWalletBalance: { // General user's wallet for making purchases
    type: Number,
    default: 0.00,
    min: 0,
  },
  savedItems: [ // Wishlist/Saved Products
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
    }
  ],
  deliveryAddresses: [ // Array of embedded address objects
    {
      address: { type: String, required: true },
      city: { type: String, required: true },
      postalCode: { type: String, required: true },
      country: { type: String, required: true },
      isDefault: { type: Boolean, default: false }, // Mark one as default
      _id: false // Do not create a separate _id for subdocuments unless needed
    }
  ],

  // --- COMMON FIELDS ---
  otp: String,
  otpExpires: Date,
  
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
          'order_update',
          'delivery_payout',
          'new_order',           // ← ADDED THIS LINE
          'order_shipped',       // ← ADDED THIS LINE (optional but good to have)
          'order_delivered'      // ← ADDED THIS LINE (optional but good to have)
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
          'MainOrder',
          'Shipment'            // ← ADDED THIS LINE
        ],
        sparse: true,
      },
    }
  ],

     // OneSignal integration
    oneSignalUserId: {
        type: String,
        sparse: true
    },
    
     oneSignalPlayerId: {
    type: String,
    sparse: true // Allows null/undefined values
  },
    
    // Notification preferences
    notificationPreferences: {
        orderUpdates: { type: Boolean, default: true },
        promotions: { type: Boolean, default: true },
        priceAlerts: { type: Boolean, default: true }
    },
  
  isAdmin: {
    type: Boolean,
    default: false,
  },
  role: {
    type: String,
    enum: ['user', 'pharmacist', 'admin'],
    default: 'user',
  },
  isAvailable: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// ----------------------------------------------------------------------------------
// ⭐ VIRTUAL FIELDS FIX: Creates 'isPharmacist' for Flutter compatibility
// ----------------------------------------------------------------------------------

// 1. Define the 'isPharmacist' virtual property
UserSchema.virtual('isPharmacist').get(function() {
    // This function runs when the document is converted to JSON.
    // It returns true if the 'role' field is 'pharmacist', and false otherwise.
    return this.role === 'pharmacist';
});

// 2. CRITICAL: Configure Mongoose to include virtuals when converting the document to JSON
UserSchema.set('toJSON', { virtuals: true }); // This ensures the 'isPharmacist: true' field is sent to the client.

// ----------------------------------------------------------------------------------
// --- Pre-save hook to hash password before saving ---
UserSchema.pre('save', async function(next) {
  if (!this.isModified('password')) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// --- Method to compare entered password with hashed password ---
UserSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Create the User model from the schema
const User = mongoose.model('User', UserSchema);

module.exports = User;








// // models/User.js
// const mongoose = require('mongoose');
// const bcrypt = require('bcryptjs');

// // Define the User Schema
// const UserSchema = new mongoose.Schema({
//   firstName: {
//     type: String,
//     required: [true, 'First name is required'],
//     trim: true,
//   },
//   lastName: {
//     type: String,
//     required: [true, 'Last name is required'],
//     trim: true,
//   },
//   email: {
//     type: String,
//     required: [true, 'Email is required'],
//     unique: true,
//     trim: true,
//     lowercase: true,
//     match: [/.+@.+\..+/, 'Please enter a valid email address'],
//   },
//   phoneNumber: {
//     type: String,
//     required: [true, 'Phone number is required'],
//     unique: true,
//     trim: true,
//     match: [/^(?:\+?234|0)[789]\d{9}$/, 'Please enter a valid Nigerian phone number'],
//   },
//   password: {
//     type: String,
//     required: [true, 'Password is required'],
//     minlength: [6, 'Password must be at least 6 characters long'],
//   },
//   isEmailVerified: {
//     type: Boolean,
//     default: false,
//   },
//   emailVerificationToken: String,
//   emailVerificationExpires: Date,

//   isDeviceVerified: {
//     type: Boolean,
//     default: false,
//   },
//   deviceFingerprint: {
//     type: String,
//     sparse: true,
//   },
//   deviceVerificationToken: String,
//   deviceVerificationExpires: Date,

//   passwordResetToken: String,
//   passwordResetExpires: Date,

//   // --- VENDOR-SPECIFIC FIELDS ---
//   isVendor: {
//     type: Boolean,
//     default: false,
//   },
//   vendorStatus: {
//     type: String,
//     enum: ['none', 'sent', 'received', 'reviewing', 'approved', 'rejected'],
//     default: 'none',
//   },
//   vendorRequestDate: {
//     type: Date,
//   },
//   vendorRejectionDate: {
//     type: Date,
//   },
//   businessName: {
//     type: String,
//     trim: true,
//     sparse: true,
//   },
//   businessCategories: {
//     type: [String],
//     sparse: true,
//   },
//   profilePicUrl: {
//     type: String,
//     sparse: true,
//   },
//   // NEW FIELD: Business Location
//   businessLocation: {
//     type: {
//       latitude: { type: Number, required: true },
//       longitude: { type: Number, required: true },
//       formattedAddress: { type: String, required: false },
//     },
//     sparse: true,
//   },
//   // Vendor Dashboard Metrics (Initialize for future use)
//   totalProducts: {
//     type: Number,
//     default: 0,
//   },
//   productsSold: {
//     type: Number,
//     default: 0,
//   },
//   productsUnsold: {
//     type: Number,
//     default: 0,
//   },
//   followersCount: {
//     type: Number,
//     default: 0,
//   },
//   // Vendor Wallet (Earnings from sales)
//   vendorWalletBalance: {
//     type: Number,
//     default: 0.00,
//     min: 0,
//   },
//   // App Wallet (For vendor payments to app, e.g., ads)
//   appWalletBalance: {
//     type: Number,
//     default: 0.00,
//     min: 0,
//   },

//   // --- BUYER-SPECIFIC FIELDS (NEW) ---
//   userWalletBalance: { // General user's wallet for making purchases
//     type: Number,
//     default: 0.00,
//     min: 0,
//   },
//   savedItems: [ // Wishlist/Saved Products
//     {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Product',
//     }
//   ],
//   deliveryAddresses: [ // Array of embedded address objects
//     {
//       address: { type: String, required: true },
//       city: { type: String, required: true },
//       postalCode: { type: String, required: true },
//       country: { type: String, required: true },
//       isDefault: { type: Boolean, default: false }, // Mark one as default
//       _id: false // Do not create a separate _id for subdocuments unless needed
//     }
//   ],

//   // --- COMMON FIELDS ---
//   otp: String,
//   otpExpires: Date,
// notifications: [
//   {
//     type: {
//       type: String,
//       enum: [
//         'product_sold',
//         'payment_received',
//         'wallet_deposit',
//         'wallet_withdrawal',
//         'vendor_status_update',
//         'general',
//         'order_update',
//         'delivery_payout'           // ← ADD THIS LINE
//       ],
//       default: 'general',
//     },
//     message: {
//       type: String,
//       required: true,
//     },
//     read: {
//       type: Boolean,
//       default: false,
//     },
//     createdAt: {
//       type: Date,
//       default: Date.now,
//     },
//     relatedId: {
//       type: mongoose.Schema.Types.ObjectId,
//       refPath: 'notifications.relatedModel',
//       sparse: true,
//     },
//     relatedModel: {
//       type: String,
//       enum: [
//         'Product',
//         'Order',
//         'Transaction',
//         'User',
//         'MainOrder'                 // ← ADD THIS LINE
//       ],
//       sparse: true,
//     },
//   }
// ],

// //   notifications: [
// //     {
// //       type: {
// //         type: String,
// //         enum: ['product_sold', 'payment_received', 'wallet_deposit', 'wallet_withdrawal', 'vendor_status_update', 'general', 'order_update'],
// //         default: 'general',
// //       },
// //       message: {
// //         type: String,
// //         required: true,
// //       },
// //       read: {
// //         type: Boolean,
// //         default: false,
// //       },
// //       createdAt: {
// //         type: Date,
// //         default: Date.now,
// //       },
// //       relatedId: {
// //         type: mongoose.Schema.Types.ObjectId,
// //         refPath: 'notifications.relatedModel',
// //         sparse: true,
// //       },
// //       relatedModel: {
// //         type: String,
// //         enum: ['Product', 'Order', 'Transaction', 'User'],
// //         sparse: true,
// //       },
// //     }
// //   ],
//   isAdmin: {
//     type: Boolean,
//     default: false,
//   },
//     role: {
//     type: String,
//     enum: ['user', 'pharmacist', 'admin'],
//     default: 'user',
//   },
//   isAvailable: {
//     type: Boolean,
//     default: false,
//   },
//   createdAt: {
//     type: Date,
//     default: Date.now,
//   },
// });

// // ----------------------------------------------------------------------------------
// // ⭐ VIRTUAL FIELDS FIX: Creates 'isPharmacist' for Flutter compatibility
// // ----------------------------------------------------------------------------------

// // 1. Define the 'isPharmacist' virtual property
// UserSchema.virtual('isPharmacist').get(function() {
//     // This function runs when the document is converted to JSON.
//     // It returns true if the 'role' field is 'pharmacist', and false otherwise.
//     return this.role === 'pharmacist';
// });

// // 2. CRITICAL: Configure Mongoose to include virtuals when converting the document to JSON
// UserSchema.set('toJSON', { virtuals: true }); // This ensures the 'isPharmacist: true' field is sent to the client.

// // ----------------------------------------------------------------------------------
// // --- Pre-save hook to hash password before saving ---
// UserSchema.pre('save', async function(next) {
//   if (!this.isModified('password')) {
//     return next();
//   }
//   const salt = await bcrypt.genSalt(10);
//   this.password = await bcrypt.hash(this.password, salt);
//   next();
// });

// // --- Method to compare entered password with hashed password ---
// UserSchema.methods.matchPassword = async function(enteredPassword) {
//   return await bcrypt.compare(enteredPassword, this.password);
// };

// // Create the User model from the schema
// const User = mongoose.model('User', UserSchema);

// module.exports = User;







// // models/User.js
// const mongoose = require('mongoose'); // Import Mongoose for schema definition
// const bcrypt = require('bcryptjs'); // Import bcryptjs for password hashing

// // Define the User Schema
// const UserSchema = new mongoose.Schema({
//   firstName: {
//     type: String,
//     required: [true, 'First name is required'], // First name is mandatory
//     trim: true, // Remove whitespace from both ends of a string
//   },
//   lastName: {
//     type: String,
//     required: [true, 'Last name is required'], // Last name is mandatory
//     trim: true,
//   },
//   email: {
//     type: String,
//     required: [true, 'Email is required'], // Email is mandatory
//     unique: true, // Email must be unique for each user
//     trim: true,
//     lowercase: true, // Store emails in lowercase to avoid case sensitivity issues
//     match: [/.+@.+\..+/, 'Please enter a valid email address'], // Basic email format validation
//   },
//   phoneNumber: {
//     type: String,
//     required: [true, 'Phone number is required'], // Phone number is mandatory
//     unique: true, // Phone number must be unique
//     trim: true,
//     // Basic regex for phone number, adjust as per Nigerian phone number formats if needed
//     // Example: Allows numbers starting with +, or 0, and then 7-15 digits
//     match: [/^(?:\+?234|0)[789]\d{9}$/, 'Please enter a valid Nigerian phone number'],
//   },
//   password: {
//     type: String,
//     required: [true, 'Password is required'], // Password is mandatory
//     minlength: [6, 'Password must be at least 6 characters long'], // Minimum password length
//   },
//   isEmailVerified: {
//     type: Boolean,
//     default: false, // Default to false, set to true after email verification
//   },
//   emailVerificationToken: String, // Token for email verification
//   emailVerificationExpires: Date, // Expiration for email verification token

//   isDeviceVerified: {
//     type: Boolean,
//     default: false, // Default to false, set to true after device verification
//   },
//   deviceFingerprint: {
//     type: String,
//     sparse: true, // Allows multiple documents to have null or missing deviceFingerprint
//     // Unique if present, to ensure one device fingerprint per user (for primary device)
//     // We'll handle multiple devices later if needed, for now, it's about the "original" device
//   },
//   deviceVerificationToken: String, // Token for device verification
//   deviceVerificationExpires: Date, // Expiration for device verification token

//   passwordResetToken: String, // Token for password reset
//   passwordResetExpires: Date, // Expiration for password reset token

//   // --- VENDOR-SPECIFIC FIELDS ---
//   isVendor: {
//     type: Boolean,
//     default: false, // True if the user is an approved vendor
//   },
//   vendorStatus: {
//     type: String,
//     enum: ['none', 'sent', 'received', 'reviewing', 'approved', 'rejected'], // Tracking status
//     default: 'none', // 'none' means no request has been made yet
//   },
//   vendorRequestDate: {
//     type: Date, // Timestamp when the vendor request was submitted
//   },
//   vendorRejectionDate: {
//     type: Date, // Timestamp if the vendor request was rejected
//   },
//   businessName: {
//     type: String,
//     trim: true,
//     sparse: true, // Optional, only present for vendors
//   },
//   businessCategories: {
//     type: [String], // Array of strings for categories (e.g., ['supermarkets', 'boutiques'])
//     sparse: true,
//   },
//   profilePicUrl: {
//     type: String, // URL to the vendor's profile picture
//     sparse: true,
//   },
//   // NEW FIELD: Business Location
//   businessLocation: {
//     type: {
//       latitude: { type: Number, required: true },
//       longitude: { type: Number, required: true },
//       formattedAddress: { type: String, required: false },
//     },
//     sparse: true, // This field is optional and only for vendors
//   },
//   // Vendor Dashboard Metrics (Initialize for future use)
//   totalProducts: {
//     type: Number,
//     default: 0,
//   },
//   productsSold: {
//     type: Number,
//     default: 0,
//   },
//   productsUnsold: {
//     type: Number,
//     default: 0,
//   },
//   followersCount: {
//     type: Number,
//     default: 0,
//   },
//   // Vendor Wallet (Earnings from sales)
//   vendorWalletBalance: {
//     type: Number,
//     default: 0.00,
//     min: 0,
//   },
//   // App Wallet (For vendor payments to app, e.g., ads)
//   appWalletBalance: {
//     type: Number,
//     default: 0.00,
//     min: 0,
//   },

//   // --- BUYER-SPECIFIC FIELDS (NEW) ---
//   userWalletBalance: { // General user's wallet for making purchases
//     type: Number,
//     default: 0.00,
//     min: 0,
//   },
//   savedItems: [ // Wishlist/Saved Products
//     {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Product',
//     }
//   ],
//   deliveryAddresses: [ // Array of embedded address objects
//     {
//       address: { type: String, required: true },
//       city: { type: String, required: true },
//       postalCode: { type: String, required: true },
//       country: { type: String, required: true },
//       isDefault: { type: Boolean, default: false }, // Mark one as default
//       _id: false // Do not create a separate _id for subdocuments unless needed
//     }
//   ],

//   // --- COMMON FIELDS ---
//   otp: String,
//   otpExpires: Date,

//   notifications: [
//     {
//       type: {
//         type: String,
//         enum: ['product_sold', 'payment_received', 'wallet_deposit', 'wallet_withdrawal', 'vendor_status_update', 'general', 'order_update'], // Added order_update
//         default: 'general',
//       },
//       message: {
//         type: String,
//         required: true,
//       },
//       read: {
//         type: Boolean,
//         default: false,
//       },
//       createdAt: {
//         type: Date,
//         default: Date.now,
//       },
//       relatedId: {
//         type: mongoose.Schema.Types.ObjectId,
//         refPath: 'notifications.relatedModel',
//         sparse: true,
//       },
//       relatedModel: {
//         type: String,
//         enum: ['Product', 'Order', 'Transaction', 'User'], // Added User for potentially linking to buyer/vendor
//         sparse: true,
//       },
//     }
//   ],
//   isAdmin: {
//     type: Boolean,
//     default: false,
//   },
//     role: {
//     type: String,
//     enum: ['user', 'pharmacist', 'admin'],
//     default: 'user',
//   },
//   isAvailable: {
//     type: Boolean,
//     default: false,
//   },
//   createdAt: {
//     type: Date,
//     default: Date.now,
//   },
// });

// // --- Pre-save hook to hash password before saving ---
// UserSchema.pre('save', async function(next) {
//   if (!this.isModified('password')) {
//     return next();
//   }
//   const salt = await bcrypt.genSalt(10);
//   this.password = await bcrypt.hash(this.password, salt);
//   next();
// });

// // --- Method to compare entered password with hashed password ---
// UserSchema.methods.matchPassword = async function(enteredPassword) {
//   return await bcrypt.compare(enteredPassword, this.password);
// };

// // Create the User model from the schema
// const User = mongoose.model('User', UserSchema);

// module.exports = User;
