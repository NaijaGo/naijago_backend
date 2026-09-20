const crypto = require('node:crypto');
const { parseSearchInput } = require('../services/catalogSearchService');
class RequestInputError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}
const STATES = ['draft', 'requested', 'sourcing', 'matched', 'unavailable', 'cancelled'];
const FILTERS = ['category', 'subcategory', 'gender', 'ageGroup', 'productType', 'brand', 'minPrice', 'maxPrice', 'vendor'];
const LABEL = 'AI-generated concept - not an actual product. Not for sale.';
function text(value, max, required = false) {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new RequestInputError('Check the request text and try again.');
    return value.trim();
}
function id(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) throw new RequestInputError('Invalid request identifier.');
    return value;
}
function revision(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RequestInputError('Refresh this request before changing it.');
    return value;
}
function parseDraft(input = {}) {
    const query = text(input.query, 200, true);
    if (query.length < 3) throw new RequestInputError('Describe the product using at least three characters.');
    const clientRequestId = text(input.clientRequestId, 80, true);
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(clientRequestId)) throw new RequestInputError('A valid retry identifier is required.');
    if (input.criteria !== undefined && (!input.criteria || Array.isArray(input.criteria) || typeof input.criteria !== 'object')) throw new RequestInputError('Invalid search criteria.');
    const criteria = {};
    for (const key of Object.keys(input.criteria || {}).sort()) {
        if (!FILTERS.includes(key)) throw new RequestInputError('Unsupported search criterion.');
        const value = input.criteria[key];
        if (value !== '' && value !== null) criteria[key] = text(value, 200, true);
    }
    try { parseSearchInput({ ...criteria, q: query }); }
    catch (_) { throw new RequestInputError('Check the search filters and budget range.'); }
    const notes = text(input.notes, 1000);
    const inputHash = crypto.createHash('sha256').update(JSON.stringify({ query, criteria, notes })).digest('hex');
    return { query, criteria, notes, clientRequestId, inputHash };
}
function transition(row, { state, message, productId, expectedRevision, admin = false }) {
    revision(expectedRevision);
    if (!STATES.includes(state) || state === 'draft') throw new RequestInputError('Choose a valid request status.');
    const note = text(message, 1000, admin);
    const matchedProduct = state === 'matched' ? id(productId) : null;
    if (!admin && !['requested', 'cancelled'].includes(state)) throw new RequestInputError('Only NaijaGo can update sourcing progress.', 403);
    if (row.state === state && row.customerMessage === note && String(row.matchedProduct || '') === String(matchedProduct || '')) return null;
    if (row.revision !== expectedRevision) throw new RequestInputError('This request changed. Refresh and try again.', 409);
    const allowed = admin ? { requested: ['sourcing', 'matched', 'unavailable'], sourcing: ['matched', 'unavailable'], matched: ['sourcing', 'unavailable'], unavailable: ['sourcing', 'matched'] }
        : { draft: ['requested', 'cancelled'], requested: ['cancelled'], sourcing: ['cancelled'], matched: ['cancelled'], unavailable: ['cancelled'] };
    if (!allowed[row.state]?.includes(state)) throw new RequestInputError('That status change is not available.', 409);
    if (row.history.length >= 100) throw new RequestInputError('This request reached its update limit. Contact support.', 409);
    return { state, message: note, matchedProduct };
}
module.exports = { RequestInputError, STATES, FILTERS, LABEL, text, id, revision, parseDraft, transition };
