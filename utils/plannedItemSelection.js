'use strict';
const { fail } = require('./orderPlanningPolicy');

// Structural validation only. Catalog resolution must still verify the actual
// available option before saving/submitting an order. Never persist client prices.
function normalizeSelectedSize(value) {
    if (value == null) return null;
    const text = (input, max = 100) => typeof input === 'string' && input.length > 0 && input.length <= max;
    if (typeof value === 'string') {
        if (!text(value)) fail('INVALID_SIZE', 'Choose a valid product size.');
        return value;
    }
    if (typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SIZE', 'Choose a valid product size.');
    const result = {};
    if (value.value !== undefined) {
        if (!text(value.value)) fail('INVALID_SIZE', 'Choose a valid product size.');
        result.value = value.value;
        if (value.unit != null) { if (!text(value.unit, 20)) fail('INVALID_SIZE', 'Choose a valid size unit.'); result.unit = value.unit; }
    } else {
        for (const key of ['length', 'width', 'height']) {
            if (value[key] == null) continue;
            if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] <= 0 || value[key] > 1000000) fail('INVALID_SIZE', 'Choose valid product dimensions.');
            result[key] = value[key];
        }
        if (!Object.keys(result).length || !['cm', 'inch', 'mm', 'm'].includes(value.unit)) fail('INVALID_SIZE', 'Choose valid product dimensions.');
        result.unit = value.unit;
    }
    if (value.label != null) { if (typeof value.label !== 'string' || value.label.length > 100) fail('INVALID_SIZE', 'Choose a valid size label.'); result.label = value.label; }
    return result;
}
function sizeIdentity(value) {
    const size = normalizeSelectedSize(value);
    if (size == null) return '';
    if (typeof size === 'string') return JSON.stringify(['size', size]);
    if (size.value != null) return JSON.stringify(['size', size.value]);
    return JSON.stringify(['dimensions', size.length ?? null, size.width ?? null, size.height ?? null, size.unit]);
}
module.exports = { normalizeSelectedSize, sizeIdentity };
