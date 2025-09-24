// models/Payment.js

const mongoose = require('mongoose');

const PaymentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  transactionRef: {
    type: String,
    required: true,
    unique: true, // This ensures no two payments can have the same reference
  },
  amount: {
    type: Number,
    required: true,
  },
  currency: {
    type: String,
    required: true,
    default: 'NGN',
  },
  status: {
    type: String,
    required: true,
    enum: ['successful', 'failed', 'pending'], // You can add more statuses as needed
    default: 'successful',
  },
  gateway: {
    type: String,
    required: true,
    default: 'Flutterwave',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const Payment = mongoose.model('Payment', PaymentSchema);

module.exports = Payment;