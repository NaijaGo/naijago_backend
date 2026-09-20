'use strict';
const { fail, id, integer } = require('./orderPlanningPolicy');
const MAX_PHOTOS = 5;
const MAX_BYTES = 10 * 1024 * 1024;
function normalizeReview(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_REVIEW', 'Provide a product and star rating.');
    const productId = id(input.productId);
    const rating = integer(input.rating, 1, 5, 'star rating');
    const comment = input.comment == null ? '' : input.comment;
    if (typeof comment !== 'string' || comment.length > 3000) fail('INVALID_REVIEW', 'Review text must be 3,000 characters or fewer.');
    const photos = input.photos || [];
    if (!Array.isArray(photos) || photos.length > MAX_PHOTOS) fail('TOO_MANY_PHOTOS', 'You can attach up to five photos.');
    const photoIds = photos.map(id);
    if (new Set(photoIds).size !== photoIds.length) fail('DUPLICATE_PHOTO', 'The same photo cannot be attached twice.');
    // Photos are owned, processed upload-record IDs, never arbitrary client URLs.
    return { productId, rating, comment: comment.trim(), photos: photoIds };
}
function photoFormat(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) fail('INVALID_PHOTO_SIZE', 'Each photo must be no larger than 10 MB.');
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
    // HEIC ISO BMFF ftyp: validate the major/compatible brands, not filename/MIME.
    if (bytes.length >= 24 && bytes.toString('ascii', 4, 8) === 'ftyp') {
        const boxSize = bytes.readUInt32BE(0);
        if (boxSize >= 24 && boxSize <= Math.min(bytes.length, 256) && boxSize % 4 === 0) {
            const brands = [bytes.toString('ascii', 8, 12)];
            for (let at = 16; at < boxSize; at += 4) brands.push(bytes.toString('ascii', at, at + 4));
            if (brands.some((brand) => ['heic', 'heix', 'hevc', 'hevx'].includes(brand))) return 'heic';
        }
    }
    fail('UNSUPPORTED_PHOTO', 'Choose a JPEG, PNG or HEIC photo.');
}
function isVerifiedPurchase({ order, shipment, actor, productId }) {
    if (!order || !shipment || String(order.user) !== String(actor) || !order.isPaid ||
        order.mainOrderStatus === 'cancelled' || String(shipment.mainOrder) !== String(order._id)) return false;
    const completed = shipment.shipmentStatus === 'delivered' ||
        (shipment.fulfillmentMethod === 'pickup' && shipment.shipmentStatus === 'picked_up' && Boolean(shipment.pickupDetails?.verifiedAt));
    return completed && shipment.items.some((item) => String(item.product) === String(productId));
}
module.exports = { MAX_PHOTOS, MAX_BYTES, normalizeReview, photoFormat, isVerifiedPurchase };
