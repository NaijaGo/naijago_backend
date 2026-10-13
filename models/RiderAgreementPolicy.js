const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: { type: String, default: 'rider-partnership' },
  agreementId: { type: mongoose.Schema.Types.ObjectId, ref: 'RiderAgreement', default: null },
  revision: { type: Number, default: 0, min: 0 },
  fence: { type: Number, default: 0 },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  changedAt: Date,
  history: [{ previousAgreementId: mongoose.Schema.Types.ObjectId,
    agreementId: mongoose.Schema.Types.ObjectId, changedBy: mongoose.Schema.Types.ObjectId,
    changedAt: Date, reason: String, _id: false }],
}, { autoIndex: false, autoCreate: false });
module.exports = mongoose.model('RiderAgreementPolicy', schema);
