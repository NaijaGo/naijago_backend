'use strict';
const { Schema } = require('mongoose');
const integer = (min, max) => ({ type: Number, required: true, min, max, validate: Number.isSafeInteger });
const key = { type: String, required: true, match: /^[a-zA-Z0-9_-]{1,120}$/ };
const clock = { type: String, required: true, match: /^(?:[01]\d|2[0-3]):[0-5]\d$/ };
const point = new Schema({ latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 } }, { _id: false });
const hours = new Schema({ day: { type: String, required: true, enum: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] },
    open: clock, close: clock, isClosed: { type: Boolean, default: false } }, { _id: false });
const area = new Schema({ key, enabled: { type: Boolean, default: false }, center: { type: point, required: true },
    radiusKm: { type: Number, required: true, min: 0.001, max: 1000 }, riderPoolKey: key }, { _id: false });
const shop = new Schema({ resourceKey: { type: String, required: true, match: /^(?:vendor|platform):[a-f0-9]{64}$/ },
    enabled: { type: Boolean, default: false }, deliveryRadiusKm: { type: Number, required: true, min: 0.001, max: 1000 },
    preparationMinutes: integer(0, 1440), operatingHours: { type: [hours], required: true, validate: (value) => value.length > 0 && value.length <= 21 } }, { _id: false });
const schema = new Schema({ enabled: { type: Boolean, default: false }, timeZone: { type: String, required: true, enum: ['Africa/Lagos'] },
    revision: integer(1, Number.MAX_SAFE_INTEGER), minimumLeadMinutes: integer(1, 10080), maximumAdvanceDays: integer(1, 365),
    dispatchLeadMinutes: integer(0, 10080), changeCutoffMinutes: integer(0, 10080), paymentHoldMinutes: integer(1, 60),
    areas: { type: [area], default: [] }, shops: { type: [shop], default: [] } }, { _id: false });
schema.pre('validate', function(next) {
    if (this.dispatchLeadMinutes > this.minimumLeadMinutes || this.changeCutoffMinutes < this.dispatchLeadMinutes) this.invalidate('dispatchLeadMinutes', 'Dispatch must fit inside the lead and change cutoffs.');
    if (this.enabled && (!this.areas.some(row => row.enabled) || !this.shops.some(row => row.enabled))) this.invalidate('enabled', 'Configure at least one enabled area and shop first.');
    if (new Set(this.areas.map(row => row.key)).size !== this.areas.length) this.invalidate('areas', 'Area keys must be unique.');
    if (new Set(this.shops.map(row => row.resourceKey)).size !== this.shops.length) this.invalidate('shops', 'Shop resource keys must be unique.');
    next();
});
module.exports = schema;
