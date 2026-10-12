const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    _id: { type: mongoose.Schema.Types.ObjectId, required: true },
    key: { type: String, required: true, immutable: true },
    label: { type: String, required: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
    sortOrder: { type: Number, required: true, min: 0 },
    taxonomyVersion: { type: Number, required: true },
}, { versionKey: false, autoCreate: false, autoIndex: false });
schema.index({ key: 1 }, { unique: true });
schema.index({ parentId: 1, sortOrder: 1 });
module.exports = mongoose.model('Category', schema);
