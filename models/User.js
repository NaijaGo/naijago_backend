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
  alternatePhoneNumber: {
    type: String,
    trim: true,
    sparse: true,
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
  businessLogoUrl: {
    type: String,
    trim: true,
    sparse: true,
  },
  businessWhatsAppNumber: {
    type: String,
    trim: true,
    sparse: true,
    match: [/^(?:\+?234|0)[789]\d{9}$/, 'Please enter a valid Nigerian WhatsApp number'],
  },
  vendorContactEmail: {
    type: String,
    trim: true,
    lowercase: true,
    sparse: true,
    match: [/.+@.+\..+/, 'Please enter a valid vendor email address'],
  },
  businessSupportPhone: {
    type: String,
    trim: true,
    sparse: true,
    match: [/^(?:\+?234|0)[789]\d{9}$/, 'Please enter a valid Nigerian support phone number'],
  },
  deliveryRadiusKm: {
    type: Number,
    min: 0,
    max: 100,
    default: 15,
  },
  prepTimeMinutes: {
    type: Number,
    min: 0,
    max: 240,
    default: 30,
  },
  isTemporarilyClosed: {
    type: Boolean,
    default: false,
  },
  temporaryClosureReason: {
    type: String,
    trim: true,
    maxlength: 160,
  },
  operatingHours: [
    {
      day: {
        type: String,
        enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
        required: true,
      },
      isOpen: { type: Boolean, default: true },
      openTime: { type: String, default: '09:00' },
      closeTime: { type: String, default: '19:00' },
      lastOrderTime: { type: String, default: '18:30' },
      _id: false,
    }
  ],
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
  validIdentification: {
    idType: {
      type: String,
      enum: ['national_id', 'voters_card', 'drivers_license', 'international_passport', null],
      default: null,
    },
    idNumber: { type: String, trim: true },
    documentUrl: { type: String, trim: true },
  },
  shopPhotoUrls: [{ type: String, trim: true }],
  sampleProducts: [
    {
      description: { type: String, trim: true },
      price: { type: Number, min: 0 },
      photoUrls: [{ type: String, trim: true }],
      _id: false,
    }
  ],
  socialMediaPage: { type: String, trim: true },
  cacCertificateUrl: { type: String, trim: true },
  cacNumber: { type: String, trim: true },
  bankAccountDetails: {
    accountName: { type: String, trim: true },
    bankName: { type: String, trim: true },
    accountNumber: {
      type: String,
      trim: true,
      match: [/^\d{10}$/, 'Please enter a valid 10 digit account number'],
    },
  },
  deliveryAvailable: { type: Boolean, default: false },
  emergencyContactNumber: {
    type: String,
    trim: true,
    match: [/^(?:\+?234|0)[789]\d{9}$/, 'Please enter a valid Nigerian emergency contact number'],
  },
  vendorAgreements: {
    respondQuickly: { type: Boolean, default: false },
    prepareOrdersOnTime: { type: Boolean, default: false },
    keepProductsUpdated: { type: Boolean, default: false },
    maintainAccuratePricing: { type: Boolean, default: false },
    packageItemsProperly: { type: Boolean, default: false },
    treatCustomersProfessionally: { type: Boolean, default: false },
    followNaijaGoPolicies: { type: Boolean, default: false },
    avoidFakeOrProhibitedProducts: { type: Boolean, default: false },
  },
  prohibitedProductsAcknowledged: { type: Boolean, default: false },
  pharmacistStatus: {
    type: String,
    enum: ['none', 'sent', 'received', 'reviewing', 'approved', 'rejected', 'suspended'],
    default: 'none',
  },
  pharmacistRequestDate: {
    type: Date,
  },
  pharmacistRejectionDate: {
    type: Date,
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
  pharmacySubscription: {
    planType: {
      type: String,
      enum: ['none', 'one_time', 'weekly', 'monthly'],
      default: 'none',
    },
    status: {
      type: String,
      enum: ['inactive', 'active'],
      default: 'inactive',
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    oneTimeCredits: {
      type: Number,
      min: 0,
      default: 0,
    },
    purchasedAt: {
      type: Date,
      default: null,
    },
  },
  naijagoSubscription: {
    planId: {
      type: String,
      enum: ['none', 'student', 'standard', 'premium'],
      default: 'none',
    },
    planName: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['inactive', 'payment_pending', 'active', 'expired', 'cancelled'],
      default: 'inactive',
    },
    price: {
      type: Number,
      default: 0,
      min: 0,
    },
    monthlyDeliveryLimit: {
      type: Number,
      default: 0,
      min: 0,
    },
    deliveriesRemaining: {
      type: Number,
      default: 0,
      min: 0,
    },
    minimumOrderValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    deliveryScope: {
      type: String,
      default: '',
    },
    validHours: {
      start: { type: String, default: '09:00' },
      end: { type: String, default: '18:00' },
    },
    preferences: {
      type: [String],
      default: [],
    },
    zone: {
      type: String,
      default: '',
      trim: true,
    },
    city: {
      type: String,
      default: '',
      trim: true,
    },
    activatedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    lastResetAt: {
      type: Date,
      default: null,
    },
    paymentReference: {
      type: String,
      default: '',
    },
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
      phoneNumber: { type: String, trim: true },
      isDefault: { type: Boolean, default: false }, // Mark one as default
      latitude: { type: Number },
      longitude: { type: Number },
      _id: false // Do not create a separate _id for subdocuments unless needed
    }
  ],
  referralCode: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
    uppercase: true,
  },
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    sparse: true,
  },
  referredAt: {
    type: Date,
  },
  referralRewardGrantedAt: {
    type: Date,
  },
  referralRewardAmount: {
    type: Number,
    min: 0,
  },

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
          'referral_reward',
          'vendor_status_update',
          'general',
          'admin_message',
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
        appOrderAlerts: { type: Boolean, default: true },
        whatsappOrderAlerts: { type: Boolean, default: true },
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

UserSchema.pre('save', function(next) {
  if (this.role === 'pharmacist') {
    this.pharmacistStatus = 'approved';
  }
  next();
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

UserSchema.index({ createdAt: -1 });
UserSchema.index({ role: 1, createdAt: -1 });
UserSchema.index({ isAdmin: 1, isVendor: 1, role: 1, createdAt: -1 });
UserSchema.index({ isVendor: 1, vendorStatus: 1, createdAt: -1 });
UserSchema.index({ vendorStatus: 1, createdAt: -1 });
UserSchema.index({ pharmacistStatus: 1, createdAt: -1 });
UserSchema.index({ businessName: 1 });
UserSchema.index({ 'naijagoSubscription.status': 1, 'naijagoSubscription.expiresAt': 1 });
UserSchema.index({ referredBy: 1, createdAt: -1 });
UserSchema.index({ oneSignalUserId: 1 }, { sparse: true });
UserSchema.index({ oneSignalPlayerId: 1 }, { sparse: true });
UserSchema.index({ 'vendorWithdrawals.status': 1, 'vendorWithdrawals.createdAt': -1 });
UserSchema.index({ 'userWithdrawals.status': 1, 'userWithdrawals.createdAt': -1 });

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
