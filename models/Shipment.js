const mongoose = require('mongoose');

// Schema for items within a specific shipment
const ShipmentItemSchema = new mongoose.Schema({
    product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true,
    },
    name: { type: String, required: true },
    image: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 }, // Price at time of order
    selectedSize: {  // NEW FIELD: Store selected size/variant
        type: mongoose.Schema.Types.Mixed, // Can be String, Object, or null
        default: null,
    },
    category: { type: String },
    commissionRate: { type: Number, default: 0 },
    restaurantName: { type: String },
    foodInformation: { type: String },
    orderStartTime: { type: String },
    orderEndTime: { type: String },
    medicineAccess: { type: String },
    isOverTheCounter: { type: Boolean, default: false },
    requiresPrescription: { type: Boolean, default: false },
    requiresPharmacistApproval: { type: Boolean, default: false },
}, { _id: false });

// Main Shipment Schema
const ShipmentSchema = new mongoose.Schema({
    // Link to the primary Order the user placed
    mainOrder: { 
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MainOrder',
        required: true,
        index: true
    },
    
    // ⬇️ ADD THIS: Company reference for settlement tracking
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        default: null,
        index: true
    },
    
    // The specific vendor fulfilling this package
    vendor: { 
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User', 
        required: true,
    },
    vendorLocation: { // Vendor's coordinates
        latitude: { type: Number, required: true },
        longitude: { type: Number, required: true },
    },
    
    // Items included in THIS specific shipment
    items: [ShipmentItemSchema], 
    
    // Financials for THIS shipment (crucial for payouts)
    subtotal: { type: Number, required: true, default: 0.0 },
    platformFee: { type: Number, required: true, default: 0.0 }, // Commission for this sub-order
    shippingPrice: { type: Number, required: true, default: 0.0 }, // Cost for THIS shipment

    // --- RIDER & LOGISTICS UPDATES ---
    rider: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Rider', 
        default: null 
    },
    isClaimed: { type: Boolean, default: false },
    claimedAt: { type: Date },
    
    
    shipmentStatus: { // Individual tracking status for this package
        type: String, 
        enum: ['processing', 'accepted', 'rejected', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'returned', 'cancelled'],
        default: 'processing',
    },
    acceptedAt: { type: Date },
    rejectedAt: { type: Date },
    rejectionReason: { type: String, trim: true, maxlength: 300 },
    
    // Security Codes (OTP)
    pickupOTP: { type: String },   // Generated when rider claims
    deliveryOTP: { type: String }, // Generated when rider starts delivery
    
    trackingNumber: { type: String, sparse: true },
    logisticsPartner: { type: String, sparse: true },
    deliveredAt: { type: Date },
    isDelivered: { type: Boolean, default: false },
    vendorPaidAt: { type: Date, sparse: true }, // Timestamp for vendor payout
    
}, {
    timestamps: true,
});

// ⬇️ ADD THIS: Index for better query performance
ShipmentSchema.index({ company: 1, mainOrder: 1 });
ShipmentSchema.index({ deliveredAt: 1, company: 1 });

const Shipment = mongoose.model('Shipment', ShipmentSchema);
module.exports = Shipment;




// const mongoose = require('mongoose');

// // Schema for items within a specific shipment
// const ShipmentItemSchema = new mongoose.Schema({
//     product: {
//         type: mongoose.Schema.Types.ObjectId,
//         ref: 'Product',
//         required: true,
//     },
//     name: { type: String, required: true },
//     image: { type: String, required: true },
//     quantity: { type: Number, required: true, min: 1 },
//     price: { type: Number, required: true, min: 0 }, // Price at time of order
//     selectedSize: {  // NEW FIELD: Store selected size/variant
//         type: mongoose.Schema.Types.Mixed, // Can be String, Object, or null
//         default: null,
//     },
// }, { _id: false });

// // Main Shipment Schema
// const ShipmentSchema = new mongoose.Schema({
//     // Link to the primary Order the user placed
//     mainOrder: { 
//         type: mongoose.Schema.Types.ObjectId,
//         ref: 'MainOrder', // Will be created in the next step
//         required: true,
//     },
//     // The specific vendor fulfilling this package
//     vendor: { 
//         type: mongoose.Schema.Types.ObjectId,
//         ref: 'User', 
//         required: true,
//     },
//     vendorLocation: { // Vendor's coordinates
//         latitude: { type: Number, required: true },
//         longitude: { type: Number, required: true },
//     },
    
//     // Items included in THIS specific shipment
//     items: [ShipmentItemSchema], 
    
//     // Financials for THIS shipment (crucial for payouts)
//     subtotal: { type: Number, required: true, default: 0.0 },
//     platformFee: { type: Number, required: true, default: 0.0 }, // Commission for this sub-order
//     shippingPrice: { type: Number, required: true, default: 0.0 }, // Cost for THIS shipment

//     // --- RIDER & LOGISTICS UPDATES ---
//     rider: { 
//         type: mongoose.Schema.Types.ObjectId, 
//         ref: 'Rider', 
//         default: null 
//     },
//     isClaimed: { type: Boolean, default: false },
//     claimedAt: { type: Date },
    
    
//     shipmentStatus: { // Individual tracking status for this package
//         type: String, 
//         enum: ['processing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'returned', 'cancelled'],
//         default: 'processing',
//     },
    
//     // Security Codes (OTP)
//     pickupOTP: { type: String },   // Generated when rider claims
//     deliveryOTP: { type: String }, // Generated when rider starts delivery
    
//     trackingNumber: { type: String, sparse: true },
//     logisticsPartner: { type: String, sparse: true },
//     deliveredAt: { type: Date },
//     isDelivered: { type: Boolean, default: false },
//     vendorPaidAt: { type: Date, sparse: true }, // Timestamp for vendor payout
    
// }, {
//     timestamps: true,
// });

// const Shipment = mongoose.model('Shipment', ShipmentSchema);
// module.exports = Shipment;




// // models/Shipment.js
// const mongoose = require('mongoose');

// // Schema for items within a specific shipment
// const ShipmentItemSchema = new mongoose.Schema({
//     product: {
//         type: mongoose.Schema.Types.ObjectId,
//         ref: 'Product',
//         required: true,
//     },
//     name: { type: String, required: true },
//     image: { type: String, required: true },
//     quantity: { type: Number, required: true, min: 1 },
//     price: { type: Number, required: true, min: 0 }, // Price at time of order
// }, { _id: false });

// // Main Shipment Schema
// const ShipmentSchema = new mongoose.Schema({
//     // Link to the primary Order the user placed
//     mainOrder: { 
//         type: mongoose.Schema.Types.ObjectId,
//         ref: 'MainOrder', // Will be created in the next step
//         required: true,
//     },
//     // The specific vendor fulfilling this package
//     vendor: { 
//         type: mongoose.Schema.Types.ObjectId,
//         ref: 'User', 
//         required: true,
//     },
//     vendorLocation: { // Vendor's coordinates
//         latitude: { type: Number, required: true },
//         longitude: { type: Number, required: true },
//     },
    
//     // Items included in THIS specific shipment
//     items: [ShipmentItemSchema], 
    
//     // Financials for THIS shipment (crucial for payouts)
//     subtotal: { type: Number, required: true, default: 0.0 },
//     platformFee: { type: Number, required: true, default: 0.0 }, // Commission for this sub-order
//     shippingPrice: { type: Number, required: true, default: 0.0 }, // Cost for THIS shipment

//     // --- RIDER & LOGISTICS UPDATES ---
//     rider: { 
//         type: mongoose.Schema.Types.ObjectId, 
//         ref: 'Rider', 
//         default: null 
//     },
//     isClaimed: { type: Boolean, default: false },
//     claimedAt: { type: Date },
    
    
//     shipmentStatus: { // Individual tracking status for this package
//         type: String, 
//         enum: ['processing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'returned', 'cancelled'],
//         default: 'processing',
//     },
    
//     // Security Codes (OTP)
//     pickupOTP: { type: String },   // Generated when rider claims
//     deliveryOTP: { type: String }, // Generated when rider starts delivery
    
//     trackingNumber: { type: String, sparse: true },
//     logisticsPartner: { type: String, sparse: true },
//     deliveredAt: { type: Date },
//     isDelivered: { type: Boolean, default: false },
//     vendorPaidAt: { type: Date, sparse: true }, // Timestamp for vendor payout
    
// }, {
//     timestamps: true,
// });

// const Shipment = mongoose.model('Shipment', ShipmentSchema);
// module.exports = Shipment;
