const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  version: { type: String, required: true, maxlength: 40 },
  content: { type: String, required: true, maxlength: 200000 },
  contentHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  status: { type: String, enum: ['draft', 'published'], default: 'draft', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  publishedAt: Date,
  effectiveAt: Date,
}, { timestamps: true, autoIndex: false, autoCreate: false });
schema.index({ version: 1 }, { unique: true, name: 'agreement_version_unique' });
schema.pre('save', async function () {
  if (!this.isNew && this.isModified()) {
    const saved = await this.constructor.findById(this._id).session(this.$session()).lean();
    if (saved?.status === 'published') throw new Error('Published agreement content is immutable.');
  }
});
for (const method of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace']) {
  schema.pre(method, async function () {
    const existing = await this.model.findOne({ $and: [this.getFilter(), { status: 'published' }] })
      .session(this.getOptions().session || null).lean();
    if (existing) throw new Error('Published agreements cannot be modified.');
  });
}
for (const method of ['deleteOne', 'deleteMany', 'findOneAndDelete', 'bulkWrite']) {
  schema.pre(method, function () { throw new Error('Agreement history cannot be deleted or bulk overwritten.'); });
}
module.exports = mongoose.model('RiderAgreement', schema);
