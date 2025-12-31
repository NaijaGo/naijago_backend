// models/Shipment.js
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
}, { _id: false });

// Main Shipment Schema
const ShipmentSchema = new mongoose.Schema({
    // Link to the primary Order the user placed
    mainOrder: { 
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MainOrder', // Will be created in the next step
        required: true,
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
        enum: ['processing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'returned', 'cancelled'],
        default: 'processing',
    },
    
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

const Shipment = mongoose.model('Shipment', ShipmentSchema);
module.exports = Shipment;