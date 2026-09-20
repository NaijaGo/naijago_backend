const mongoose = require('mongoose');
const item = new mongoose.Schema({
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    offer: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductOffer', default: null },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    quantity: { type: Number, min: 1, max: 99, required: true, validate: Number.isSafeInteger },
    customerNote: { type: String, trim: true, maxlength: 500, default: '' },
}, { _id: false });
const destination = new mongoose.Schema({
    address: { type: String, required: true, maxlength: 500 },
    city: { type: String, required: true, maxlength: 100 },
    postalCode: { type: String, required: true, maxlength: 20 },
    country: { type: String, required: true, maxlength: 80 },
    phoneNumber: { type: String, required: true, maxlength: 30 },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
}, { _id: false });
const schedule = new mongoose.Schema({
    mode: { type: String, enum: ['now', 'scheduled'], default: 'now' },
    startAt: Date, endAt: Date, timeZone: { type: String, enum: ['Africa/Lagos'], default: 'Africa/Lagos' },
}, { _id: false });
const history = new mongoose.Schema({ action: { type: String, required: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, at: { type: Date, required: true },
    revision: { type: Number, required: true }, reason: { type: String, maxlength: 300, default: '' },
}, { _id: false });
module.exports = { item, destination, schedule, history };
