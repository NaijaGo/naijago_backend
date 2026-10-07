const mongoose = require('mongoose');
const { Schema } = mongoose;
const itemSchema = new Schema({
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    offer: { type: Schema.Types.ObjectId, ref: 'ProductOffer', default: null },
    quantity: { type: Number, min: 1, max: 1000, required: true, validate: Number.isSafeInteger },
    selectedSize: { type: String, maxlength: 80, default: '' },
    customerNote: { type: String, maxlength: 500, default: '' },
    productName: { type: String, maxlength: 300, default: '' },
}, { _id: false });
const destinationSchema = new Schema({
    address: { type: String, required: true, maxlength: 500 },
    city: { type: String, required: true, maxlength: 100 },
    state: { type: String, maxlength: 100 },
    postalCode: { type: String, maxlength: 30, default: '' },
    country: { type: String, maxlength: 100, default: 'Nigeria' },
    latitude: { type: Number, min: -90, max: 90, required: true },
    longitude: { type: Number, min: -180, max: 180, required: true },
}, { _id: false });
const approvalSchema = new Schema({ hash: String, fingerprint: String, expiresAt: Date }, { _id: false });
const groupSchema = new Schema({
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, maxlength: 80, required: true },
    sellerType: { type: String, enum: ['vendor', 'naijago'], required: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    sellerName: String,
    destination: { type: destinationSchema, required: true },
    members: [{ user: { type: Schema.Types.ObjectId, ref: 'User', required: true }, items: [itemSchema] }],
    participantLimit: { type: Number, min: 2, max: 30, required: true },
    closesAt: { type: Date, required: true },
    inviteHash: { type: String, required: true },
    state: { type: String, enum: ['open', 'closed', 'cancelled', 'ordered'], default: 'open' },
    revision: { type: Number, default: 0, min: 0 },
    approval: { type: approvalSchema, default: undefined },
    orderId: { type: Schema.Types.ObjectId, ref: 'MainOrder' },
}, { timestamps: true });
groupSchema.index({ inviteHash: 1 }, { unique: true });
groupSchema.index({ 'members.user': 1, _id: -1 });
const planSchema = new Schema({
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, maxlength: 80, required: true },
    items: [itemSchema], destination: { type: destinationSchema, required: true },
    rule: {
        timeZone: { type: String, enum: ['Africa/Lagos'], default: 'Africa/Lagos' },
        startDate: { type: String, required: true },
        frequency: { type: String, enum: ['weekly', 'fortnightly', 'monthly'], required: true },
    },
    reminderLeadDays: { type: Number, default: 1, min: 1, max: 7 },
    substitutionPreference: { type: String, enum: ['do_not_replace'], default: 'do_not_replace' },
    state: { type: String, enum: ['active', 'paused', 'cancelled'], default: 'active' },
    revision: { type: Number, default: 0, min: 0 },
    checkoutRevision: { type: Number, default: 0 },
    nextIndex: { type: Number, default: 0 },
    nextGenerateAt: { type: Date, required: true },
}, { timestamps: true });
planSchema.index({ owner: 1, _id: -1 });
planSchema.index({ state: 1, nextGenerateAt: 1 });
const occurrenceSchema = new Schema({
    plan: { type: Schema.Types.ObjectId, ref: 'RecurringPlan', required: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sequence: { type: Number, required: true },
    startAt: { type: Date, required: true }, reminderAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    items: [itemSchema], destination: { type: destinationSchema, required: true },
    state: { type: String, enum: ['upcoming', 'awaiting_review', 'needs_attention', 'skipped', 'missed', 'ordered'], default: 'upcoming' },
    revision: { type: Number, min: 0, default: 0 },
    approval: { type: approvalSchema, default: undefined },
    orderId: { type: Schema.Types.ObjectId, ref: 'MainOrder' },
    reminderSentAt: Date, reminderLeaseUntil: Date,
}, { timestamps: true });
occurrenceSchema.index({ plan: 1, sequence: 1 }, { unique: true });
occurrenceSchema.index({ owner: 1, startAt: -1 });
occurrenceSchema.index({ state: 1, reminderAt: 1 });
module.exports = {
    GroupOrder: mongoose.model('GroupOrder', groupSchema),
    RecurringPlan: mongoose.model('RecurringPlan', planSchema),
    RecurringOccurrence: mongoose.model('RecurringOccurrence', occurrenceSchema),
};
