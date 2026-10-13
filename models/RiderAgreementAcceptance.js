const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  riderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rider', required: true, immutable: true },
  agreementId: { type: mongoose.Schema.Types.ObjectId, ref: 'RiderAgreement', required: true, immutable: true },
  version: { type: String, required: true, immutable: true },
  contentHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  acceptedAt: { type: Date, required: true, immutable: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rider', required: true, immutable: true },
  method: { type: String, enum: ['in_app_explicit_consent'], required: true, immutable: true },
  requestId: { type: String, maxlength: 100, immutable: true },
  appVersion: { type: String, maxlength: 50, immutable: true },
  platform: { type: String, enum: ['android', 'ios', 'web', 'unknown'], immutable: true },
}, { autoIndex: false, autoCreate: false });
schema.index({ riderId: 1, version: 1 }, { unique: true, name: 'rider_version_unique' });
schema.index({ agreementId: 1, riderId: 1 }, { name: 'agreement_riders' });
schema.pre('save', function () { if (!this.isNew) throw new Error('Acceptance history is immutable.'); });
for (const method of ['updateOne', 'updateMany', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'bulkWrite']) {
  schema.pre(method, function () { throw new Error('Acceptance history cannot be modified or deleted.'); });
}
schema.pre('findOneAndUpdate', function () {
  const update = this.getUpdate();
  if (Object.keys(update).some(key => key !== '$setOnInsert')) throw new Error('Acceptance history is immutable.');
});
module.exports = mongoose.model('RiderAgreementAcceptance', schema);
