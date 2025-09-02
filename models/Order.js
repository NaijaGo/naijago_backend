// models/Order.js

const mongoose = require('mongoose'); // Import Mongoose for schema definition

// Define the schema for individual items within an order
const OrderItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId, // Reference to the Product model
    ref: 'Product',
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  image: {
    type: String, // URL of the product image at the time of order
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 1, // Minimum quantity is 1
  },
  price: {
    type: Number, // Price of the single item at the time of order
    required: true,
    min: 0,
  },
  vendor: {
    type: mongoose.Schema.Types.ObjectId, // Reference to the User (vendor) who owns this product
    ref: 'User',
    required: true,
  },
});

// Define the main Order Schema
const OrderSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId, // Reference to the User (buyer) who placed the order
    ref: 'User',
    required: true,
  },
  orderItems: [OrderItemSchema], // Array of products in the order
  shippingAddress: {
    address: { type: String, required: true },
    city: { type: String, required: true },
    postalCode: { type: String, required: true },
    country: { type: String, required: true },
  },
  paymentMethod: {
    type: String,
    required: true,
    enum: ['Card', 'Bank Transfer', 'Wallet'], // Example payment methods
  },
  paymentResult: { // Details from payment gateway (e.g., Stripe, Paystack transaction ID)
    id: { type: String },
    status: { type: String },
    update_time: { type: String },
    email_address: { type: String },
  },
  taxPrice: {
    type: Number,
    required: true,
    default: 0.0,
  },
  shippingPrice: {
    type: Number,
    required: true,
    default: 0.0,
  },
  totalPrice: {
    type: Number,
    required: true,
    default: 0.0,
  },
  isPaid: {
    type: Boolean,
    required: true,
    default: false,
  },
  paidAt: {
    type: Date,
  },
  isDelivered: {
    type: Boolean,
    required: true,
    default: false,
  },
  deliveredAt: {
    type: Date,
  },
  orderStatus: { // Custom status for tracking order progress
    type: String,
    enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
    default: 'pending',
  },
}, {
  timestamps: true, // Adds createdAt and updatedAt fields automatically
});

// Create the Order model from the schema
const Order = mongoose.model('Order', OrderSchema);

module.exports = Order; // Export the Order model
