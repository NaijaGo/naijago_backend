const mongoose = require('mongoose');

// Receipts commit with inventory, never before or outside its transaction.
const schema = new mongoose.Schema({
  businessKey: { type: String, required: true, unique: true, maxlength: 240 },
  requestHash: { type: String, required: true },
  type: { type: String, required: true, enum: ['sale', 'hold', 'hold_confirm', 'hold_release', 'restock', 'adjustment'] },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'MainOrder', default: null },
  reservation: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryReservation', default: null },
  allocations: [{
    _id: false,
    product: { type: mongoose.Schema.Types.ObjectId, required: true },
    offer: { type: mongoose.Schema.Types.ObjectId, default: null },
    quantity: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  }],
  state: { type: String, enum: ['applied'], default: 'applied' },
}, { timestamps: true });
schema.index({ reservation: 1, type: 1 });
schema.index({ order: 1, type: 1 });
module.exports = mongoose.model('InventoryOperation', schema);
