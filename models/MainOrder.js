// models/MainOrder.js 
const mongoose = require('mongoose');
const OrderScheduleSchema = require('./OrderSchedule');

const PickupSequenceStopSchema = new mongoose.Schema({
    sequence: { type: Number, required: true, min: 1 },
    shipment: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment', required: true },
    sellerType: { type: String, enum: ['naijago', 'vendor'], default: 'vendor' },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    sellerName: { type: String, trim: true, default: 'Vendor' },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    formattedAddress: { type: String, trim: true, default: '' },
}, { _id: false });

const DeliveryFeeOverrideSchema = new mongoose.Schema({
    calculatedFee: { type: Number, min: 0, required: true },
    previousFinalFee: { type: Number, min: 0, required: true },
    finalFee: { type: Number, min: 0, required: true },
    adjustment: { type: Number, required: true },
    reason: { type: String, trim: true, maxlength: 500, required: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    changedAt: { type: Date, default: Date.now },
}, { _id: false });

const MainOrderSchema = new mongoose.Schema({
    // Optional snapshots only: old/immediate orders receive no scheduling defaults.
    schedule: { type: OrderScheduleSchema, default: undefined },
    fulfillmentHold: {
        type: new mongoose.Schema({
            active: { type: Boolean, default: true },
            code: { type: String, required: true },
            reason: { type: String, required: true, maxlength: 500 },
            state: { type: String, enum: ['needs_attention', 'resolved'], default: 'needs_attention' },
            history: [{ _id: false, action: String, reason: String,
                actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, at: Date,
                verifiedPaymentReference: String }],
        }, { _id: false }),
        default: undefined,
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    
    // ⬇️ ADD THIS: Company reference for settlement tracking
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        default: null,
        index: true // For faster queries
    },
    
    // ⬇️ ADD THIS: Company settlement earnings (150/km per shipment)
    companySettlementEarnings: {
        type: Number,
        default: 0,
        min: 0
    },
    
    // ⬇️ ADD THIS: Settlement status for company
    companySettlementStatus: {
        type: String,
        enum: ['unpaid', 'processing', 'paid'],
        default: 'unpaid',
        index: true
    },
    
    // An array of references to the individual shipments (sub-orders)
    shipments: [{ 
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Shipment',
    }], 
    // Snapshot of delivery pickup stops in stable MainOrder.shipments order.
    // Older orders may not have this field and are given a safe runtime fallback.
    pickupSequence: {
        type: [PickupSequenceStopSchema],
        default: [],
    },
    // Server-maintained dispatch state; multi-vendor orders become ready only
    // when every non-cancelled delivery shipment is ready for pickup.
    readyForDispatch: {
        type: Boolean,
        default: false,
        index: true,
    },
    
    // User's delivery details
    shippingAddress: {
        address: { type: String, required: true },
        city: { type: String, required: true },
        postalCode: { type: String, default: '' },
        country: { type: String, required: true },
        phoneNumber: { type: String },
    },
    userLocation: { // User's delivery coordinates (required for distance calc)
        latitude: { type: Number, required: true },
        longitude: { type: Number, required: true },
    },
    
    // Aggregated Financial Totals (Sum of all shipment subtotals/fees)
    totalSubtotal: { type: Number, required: true, default: 0.0 },
    totalPlatformFees: { type: Number, required: true, default: 0.0 },
    totalShippingPrice: { type: Number, required: true, default: 0.0 }, // Sum of all shipment shippingPrices
    originalShippingPrice: { type: Number, default: 0.0 },
    deliveryFeeCalculation: { type: mongoose.Schema.Types.Mixed, default: null },
    freeDeliveryCampaignApplied: { type: Boolean, default: false },
    freeDeliveryCampaignDiscount: { type: Number, min: 0, default: 0 },
    freeDeliveryCampaignReason: { type: String, trim: true, default: '' },
    deliveryFeeOverrideHistory: { type: [DeliveryFeeOverrideSchema], default: [] },
    subscriptionDeliveryDiscount: { type: Number, default: 0.0 },
    subscriptionFreeDeliveryApplied: { type: Boolean, default: false },
    subscriptionDeliveryConsumed: { type: Boolean, default: false },
    subscriptionPlanId: { type: String, default: '' },
    totalTaxPrice: { type: Number, default: 0.0 },
    totalPrice: { type: Number, required: true, default: 0.0 }, // The amount the user paid
    
    // Payment Status
    paymentMethod: {
        type: String,
        required: true,
        enum: ['Card', 'Bank Transfer', 'Wallet'],
    },
    paymentResult: { /* ... details from Flutterwave/Paystack ... */ },
    isPaid: { type: Boolean, required: true, default: false },
    paidAt: { type: Date },
    

    rider: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Rider', 
        default: null 
    },
    assignedRider: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Rider',
        default: null,
        index: true
    },
    assignedAt: { type: Date },
    assignmentRejectedBy: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Rider'
    }],
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
    vendorPaidAt: { type: Date, sparse: true },
    riderPaidAt: { type: Date, sparse: true },
    riderPayoutAmount: { type: Number, default: 0, min: 0 },
    riderPayoutBreakdown: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
    },
    payoutDetails: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
    },
    // High-level status (Derived from shipment statuses)
   mainOrderStatus: { 
    type: String,
    enum: [
        'pending_payment', 
        'processing', 
        'partially_shipped', 
        'shipped', // <-- ADD THIS
        'out_for_delivery',
        'delivered', // <-- ADD THIS, (You should probably replace 'completed' with 'delivered' or keep 'completed' for final closure)
        'completed', // Keeping 'completed' for final closed status
        'cancelled'
    ],
    default: 'pending_payment',
},
}, {
    timestamps: true,
});

// ⬇️ ADD THIS: Method to calculate company settlement earnings
MainOrderSchema.methods.calculateCompanySettlement = function() {
    // Calculate based on your business rule: ₦150/km per shipment
    // You'll need to implement the distance calculation logic here
    return this.companySettlementEarnings;
};

// ⬇️ ADD THIS: Index for better query performance
MainOrderSchema.index({ company: 1, companySettlementStatus: 1 });
MainOrderSchema.index({ createdAt: -1, company: 1 });
MainOrderSchema.index({ createdAt: -1 });
MainOrderSchema.index({ user: 1, createdAt: -1 });
MainOrderSchema.index({ rider: 1, createdAt: -1 });
MainOrderSchema.index({ assignedRider: 1, isClaimed: 1, createdAt: -1 });
MainOrderSchema.index({ isPaid: 1, mainOrderStatus: 1, createdAt: -1 });
MainOrderSchema.index(
    { 'paymentResult.tx_ref': 1 },
    { unique: true, sparse: true, name: 'unique_flutterwave_tx_ref' }
);
MainOrderSchema.index({ isPaid: 1, shipmentStatus: 1, isClaimed: 1, rider: 1, createdAt: -1 });
MainOrderSchema.index({ subscriptionFreeDeliveryApplied: 1, createdAt: -1 });
MainOrderSchema.index({ vendorPaidAt: 1, createdAt: -1 });

const MainOrder = mongoose.model('MainOrder', MainOrderSchema);
module.exports = MainOrder;










// // models/MainOrder.js 
// const mongoose = require('mongoose');

// const MainOrderSchema = new mongoose.Schema({
//     user: {
//         type: mongoose.Schema.Types.ObjectId,
//         ref: 'User',
//         required: true,
//     },
    
//     // An array of references to the individual shipments (sub-orders)
//     shipments: [{ 
//         type: mongoose.Schema.Types.ObjectId,
//         ref: 'Shipment',
//     }], 
    
//     // User's delivery details
//     shippingAddress: {
//         address: { type: String, required: true },
//         city: { type: String, required: true },
//         postalCode: { type: String, required: true },
//         country: { type: String, required: true },
//     },
//     userLocation: { // User's delivery coordinates (required for distance calc)
//         latitude: { type: Number, required: true },
//         longitude: { type: Number, required: true },
//     },
    
//     // Aggregated Financial Totals (Sum of all shipment subtotals/fees)
//     totalSubtotal: { type: Number, required: true, default: 0.0 },
//     totalPlatformFees: { type: Number, required: true, default: 0.0 },
//     totalShippingPrice: { type: Number, required: true, default: 0.0 }, // Sum of all shipment shippingPrices
//     totalTaxPrice: { type: Number, default: 0.0 },
//     totalPrice: { type: Number, required: true, default: 0.0 }, // The amount the user paid
    
//     // Payment Status
//     paymentMethod: {
//         type: String,
//         required: true,
//         enum: ['Card', 'Bank Transfer', 'Wallet'],
//     },
//     paymentResult: { /* ... details from Flutterwave/Paystack ... */ },
//     isPaid: { type: Boolean, required: true, default: false },
//     paidAt: { type: Date },
    

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
//     vendorPaidAt: { type: Date, sparse: true },
//     // High-level status (Derived from shipment statuses)
//    mainOrderStatus: { 
//     type: String,
//     enum: [
//         'pending_payment', 
//         'processing', 
//         'partially_shipped', 
//         'shipped', // <-- ADD THIS
//         'delivered', // <-- ADD THIS, (You should probably replace 'completed' with 'delivered' or keep 'completed' for final closure)
//         'completed', // Keeping 'completed' for final closed status
//         'cancelled'
//     ],
//     default: 'pending_payment',
// },
// }, {
//     timestamps: true,
// });

// const MainOrder = mongoose.model('MainOrder', MainOrderSchema);
// module.exports = MainOrder;
