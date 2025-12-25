const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const riderSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  plateNumber: { type: String, required: true },
  documents: {
    ninFront: { type: String },
    ninBack: { type: String },
    platePhoto: { type: String },
    selfie: { type: String }
  },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  isVerified: { type: Boolean, default: false },
  // Add these fields to your riderSchema
  emailVerificationToken: { type: String },
  emailVerificationExpires: { type: Date },
  isEmailVerified: { type: Boolean, default: false },
  rejectionReason: { type: String }, // To store why they were rejected
  createdAt: { type: Date, default: Date.now }
});

// Password Hashing Hook
riderSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

module.exports = mongoose.model('Rider', riderSchema);