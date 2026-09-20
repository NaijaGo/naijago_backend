const mongoose = require('mongoose');
const fields = require('./schemas/plannedOrderFields');
const schema = new mongoose.Schema({
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ownerDisplayName: { type: String, required: true, maxlength: 80 },
    name: { type: String, required: true, maxlength: 80 },
    sellerType: { type: String, enum: ['vendor', 'naijago'], required: true },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    fulfillmentKey: { type: String, required: true, maxlength: 160 },
    inviteHash: { type: String, required: true, select: false },
    destinationLabel: { type: String, required: true, maxlength: 80 },
    destination: { type: fields.destination, required: true, select: false },
    schedule: { type: fields.schedule, default: () => ({ mode: 'now' }) },
    cutoffAt: { type: Date, required: true },
    participantLimit: { type: Number, default: 10, min: 2, max: 50, validate: Number.isSafeInteger },
    state: { type: String, enum: ['open', 'closed', 'checkout', 'ordered', 'cancelled', 'expired'], default: 'open' },
    revision: { type: Number, default: 0, min: 0 },
    members: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        displayName: { type: String, maxlength: 80, required: true },
        state: { type: String, enum: ['active', 'removed'], default: 'active' },
        items: { type: [fields.item], default: [] }, joinedAt: Date, submittedAt: Date }],
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'MainOrder', default: null },
    history: { type: [fields.history], default: [] },
}, { timestamps: true });
schema.index({ inviteHash: 1 }, { unique: true });
schema.index({ owner: 1, createdAt: -1 });
schema.index({ 'members.user': 1, createdAt: -1 });
schema.index({ state: 1, cutoffAt: 1 });
schema.pre('validate', function() {
    if ((this.sellerType === 'vendor') !== Boolean(this.sellerId)) this.invalidate('sellerId', 'Seller identity mismatch.');
    const members = this.members || [];
    if (new Set(members.map((member) => String(member.user))).size !== members.length) this.invalidate('members', 'Duplicate participant.');
    if (members.filter((member) => member.state === 'active').length > this.participantLimit) this.invalidate('members', 'Participant limit exceeded.');
});
module.exports = mongoose.model('GroupOrder', schema);
