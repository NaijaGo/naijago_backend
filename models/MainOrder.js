// models/MainOrder.js (This replaces the old models/Order.js)
const mongoose = require('mongoose');

const MainOrderSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    
    // An array of references to the individual shipments (sub-orders)
    shipments: [{ 
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Shipment',
    }], 
    
    // User's delivery details
    shippingAddress: {
        address: { type: String, required: true },
        city: { type: String, required: true },
        postalCode: { type: String, required: true },
        country: { type: String, required: true },
    },
    userLocation: { // User's delivery coordinates (required for distance calc)
        latitude: { type: Number, required: true },
        longitude: { type: Number, required: true },
    },
    
    // Aggregated Financial Totals (Sum of all shipment subtotals/fees)
    totalSubtotal: { type: Number, required: true, default: 0.0 },
    totalPlatformFees: { type: Number, required: true, default: 0.0 },
    totalShippingPrice: { type: Number, required: true, default: 0.0 }, // Sum of all shipment shippingPrices
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
    
    // High-level status (Derived from shipment statuses)
   mainOrderStatus: { 
    type: String,
    enum: [
        'pending_payment', 
        'processing', 
        'partially_shipped', 
        'shipped', // <-- ADD THIS
        'delivered', // <-- ADD THIS, (You should probably replace 'completed' with 'delivered' or keep 'completed' for final closure)
        'completed', // Keeping 'completed' for final closed status
        'cancelled'
    ],
    default: 'pending_payment',
},
}, {
    timestamps: true,
});

const MainOrder = mongoose.model('MainOrder', MainOrderSchema);
module.exports = MainOrder;


// // models/Order.js

// const mongoose = require('mongoose'); // Import Mongoose for schema definition

// // Define the schema for individual items within an order
// const OrderItemSchema = new mongoose.Schema({
//   product: {
//     type: mongoose.Schema.Types.ObjectId, // Reference to the Product model
//     ref: 'Product',
//     required: true,
//   },
//   name: {
//     type: String,
//     required: true,
//   },
//   image: {
//     type: String, // URL of the product image at the time of order
//     required: true,
//   },
//   quantity: {
//     type: Number,
//     required: true,
//     min: 1, // Minimum quantity is 1
//   },
//   price: {
//     type: Number, // Price of the single item at the time of order
//     required: true,
//     min: 0,
//   },
//   vendor: {
//     type: mongoose.Schema.Types.ObjectId, // Reference to the User (vendor) who owns this product
//     ref: 'User',
//     required: true,
//   },
// });

// // Define the main Order Schema
// const OrderSchema = new mongoose.Schema({
//   user: {
//     type: mongoose.Schema.Types.ObjectId, // Reference to the User (buyer) who placed the order
//     ref: 'User',
//     required: true,
//   },
//   orderItems: [OrderItemSchema], // Array of products in the order
//   shippingAddress: {
//     address: { type: String, required: true },
//     city: { type: String, required: true },
//     postalCode: { type: String, required: true },
//     country: { type: String, required: true },
//   },
//   // ADDITIONS START HERE for Delivery Fee Calculation
//   deliveryDistanceKm: { // Store the calculated distance in kilometers
//     type: Number,
//     required: true,
//     default: 0.0,
//     min: 0,
//   },
//   userLocation: { // User's delivery coordinates (required for distance calc)
//     latitude: { type: Number, required: true },
//     longitude: { type: Number, required: true },
//   },
//   vendorLocation: { // Vendor's business coordinates (required for distance calc)
//     latitude: { type: Number, required: true },
//     longitude: { type: Number, required: true },
//   },
//   // ADDITIONS END HERE
//   paymentMethod: {
//     type: String,
//     required: true,
//     // MODIFIED: Added 'Wallet' to the enum for the new payment method
//     enum: ['Card', 'Bank Transfer', 'Wallet'], 
//   },
//   paymentResult: { // Details from payment gateway (e.g., Stripe, Paystack transaction ID)
//     id: { type: String },
//     status: { type: String },
//     update_time: { type: String },
//     email_address: { type: String },
//     // Added payment_type field for wallet transactions
//     payment_type: { type: String, enum: ['Flutterwave', 'Wallet'], default: 'Flutterwave' }, 
//   },
//   // NEW FIELD: Service Fee
//   serviceFee: {
//     type: Number, // Platform commission (15% of subtotal) NOT charged to user
//     required: true,
//     default: 0.0,
//   },
//   taxPrice: {
//     type: Number,
//     required: true,
//     default: 0.0,
//   },
//   shippingPrice: {
//     type: Number,
//     required: true,
//     default: 0.0,
//   },
//   totalPrice: {
//     type: Number,
//     required: true,
//     default: 0.0,
//   },
//   isPaid: {
//     type: Boolean,
//     required: true,
//     default: false,
//   },
//   paidAt: {
//     type: Date,
//   },
//   isDelivered: {
//     type: Boolean,
//     required: true,
//     default: false,
//   },
//   deliveredAt: {
//     type: Date,
//   },
//   orderStatus: { // Custom status for tracking order progress
//     type: String,
//     enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
//     default: 'pending',
//   },
// }, {
//   timestamps: true, // Adds createdAt and updatedAt fields automatically
// });

// // Create the Order model from the schema
// const Order = mongoose.model('Order', OrderSchema);

// module.exports = Order; // Export the Order model























// // models/Order.js

// const mongoose = require('mongoose'); // Import Mongoose for schema definition

// // Define the schema for individual items within an order
// const OrderItemSchema = new mongoose.Schema({
//   product: {
//     type: mongoose.Schema.Types.ObjectId, // Reference to the Product model
//     ref: 'Product',
//     required: true,
//   },
//   name: {
//     type: String,
//     required: true,
//   },
//   image: {
//     type: String, // URL of the product image at the time of order
//     required: true,
//   },
//   quantity: {
//     type: Number,
//     required: true,
//     min: 1, // Minimum quantity is 1
//   },
//   price: {
//     type: Number, // Price of the single item at the time of order
//     required: true,
//     min: 0,
//   },
//   vendor: {
//     type: mongoose.Schema.Types.ObjectId, // Reference to the User (vendor) who owns this product
//     ref: 'User',
//     required: true,
//   },
// });

// // Define the main Order Schema
// const OrderSchema = new mongoose.Schema({
//   user: {
//     type: mongoose.Schema.Types.ObjectId, // Reference to the User (buyer) who placed the order
//     ref: 'User',
//     required: true,
//   },
//   orderItems: [OrderItemSchema], // Array of products in the order
//   shippingAddress: {
//     address: { type: String, required: true },
//     city: { type: String, required: true },
//     postalCode: { type: String, required: true },
//     country: { type: String, required: true },
//   },
//   paymentMethod: {
//     type: String,
//     required: true,
//     // MODIFIED: Added 'Wallet' to the enum for the new payment method
//     enum: ['Card', 'Bank Transfer', 'Wallet'], 
//   },
//   paymentResult: { // Details from payment gateway (e.g., Stripe, Paystack transaction ID)
//     id: { type: String },
//     status: { type: String },
//     update_time: { type: String },
//     email_address: { type: String },
//     // Added payment_type field for wallet transactions
//     payment_type: { type: String, enum: ['Flutterwave', 'Wallet'], default: 'Flutterwave' }, 
//   },
//   // NEW FIELD: Service Fee
//   serviceFee: {
//     type: Number, // Platform commission (15% of subtotal) NOT charged to user
//     required: true,
//     default: 0.0,
//   },
//   taxPrice: {
//     type: Number,
//     required: true,
//     default: 0.0,
//   },
//   shippingPrice: {
//     type: Number,
//     required: true,
//     default: 0.0,
//   },
//   totalPrice: {
//     type: Number,
//     required: true,
//     default: 0.0,
//   },
//   isPaid: {
//     type: Boolean,
//     required: true,
//     default: false,
//   },
//   paidAt: {
//     type: Date,
//   },
//   isDelivered: {
//     type: Boolean,
//     required: true,
//     default: false,
//   },
//   deliveredAt: {
//     type: Date,
//   },
//   orderStatus: { // Custom status for tracking order progress
//     type: String,
//     enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
//     default: 'pending',
//   },
// }, {
//   timestamps: true, // Adds createdAt and updatedAt fields automatically
// });

// // Create the Order model from the schema
// const Order = mongoose.model('Order', OrderSchema);

// module.exports = Order; // Export the Order model



// // models/Order.js

// const mongoose = require('mongoose'); // Import Mongoose for schema definition

// // Define the schema for individual items within an order
// const OrderItemSchema = new mongoose.Schema({
//   product: {
//     type: mongoose.Schema.Types.ObjectId, // Reference to the Product model
//     ref: 'Product',
//     required: true,
//   },
//   name: {
//     type: String,
//     required: true,
//   },
//   image: {
//     type: String, // URL of the product image at the time of order
//     required: true,
//   },
//   quantity: {
//     type: Number,
//     required: true,
//     min: 1, // Minimum quantity is 1
//   },
//   price: {
//     type: Number, // Price of the single item at the time of order
//     required: true,
//     min: 0,
//   },
//   vendor: {
//     type: mongoose.Schema.Types.ObjectId, // Reference to the User (vendor) who owns this product
//     ref: 'User',
//     required: true,
//   },
// });

// // Define the main Order Schema
// const OrderSchema = new mongoose.Schema({
//   user: {
//     type: mongoose.Schema.Types.ObjectId, // Reference to the User (buyer) who placed the order
//     ref: 'User',
//     required: true,
//   },
//   orderItems: [OrderItemSchema], // Array of products in the order
//   shippingAddress: {
//     address: { type: String, required: true },
//     city: { type: String, required: true },
//     postalCode: { type: String, required: true },
//     country: { type: String, required: true },
//   },
//   paymentMethod: {
//     type: String,
//     required: true,
//     enum: ['Card', 'Bank Transfer', 'Wallet'], // Example payment methods
//   },
//   paymentResult: { // Details from payment gateway (e.g., Stripe, Paystack transaction ID)
//     id: { type: String },
//     status: { type: String },
//     update_time: { type: String },
//     email_address: { type: String },
//   },
//   taxPrice: {
//     type: Number,
//     required: true,
//     default: 0.0,
//   },
//   shippingPrice: {
//     type: Number,
//     required: true,
//     default: 0.0,
//   },
//   totalPrice: {
//     type: Number,
//     required: true,
//     default: 0.0,
//   },
//   isPaid: {
//     type: Boolean,
//     required: true,
//     default: false,
//   },
//   paidAt: {
//     type: Date,
//   },
//   isDelivered: {
//     type: Boolean,
//     required: true,
//     default: false,
//   },
//   deliveredAt: {
//     type: Date,
//   },
//   orderStatus: { // Custom status for tracking order progress
//     type: String,
//     enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
//     default: 'pending',
//   },
// }, {
//   timestamps: true, // Adds createdAt and updatedAt fields automatically
// });

// // Create the Order model from the schema
// const Order = mongoose.model('Order', OrderSchema);

// module.exports = Order; // Export the Order model
