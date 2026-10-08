const crypto = require('node:crypto');
class RefinementError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}
const STATES = ['queued', 'preserving', 'generating', 'pending_review', 'publishing', 'approved', 'rejected', 'failed', 'uncertain', 'obsolete'];
const MAX_BYTES = 10 * 1024 * 1024;
function id(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) throw new RefinementError('Invalid image or product identifier.');
    return value;
}
function revision(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RefinementError('Refresh the image review before continuing.');
    return value;
}
function sourceImages(product) {
    return [...new Set([...(product.imageUrls || []), ...['main', 'front', 'back', 'rear'].map((key) => product.images?.[key]),
        ...(product.images?.others || []), ...(product.variants || []).flatMap((variant) => variant.imageUrls || [])].filter(Boolean))];
}
function sourceKey(url) { return crypto.createHash('sha256').update(url).digest('hex'); }
function sourceIdentity(value, cloudName) {
    let url;
    try { url = new URL(value); } catch (_) { throw new RefinementError('Re-upload this image to NaijaGo before refinement.'); }
    const segments = url.pathname.split('/').filter(Boolean);
    if (!cloudName || url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com' || url.port || url.username || url.password || url.search || url.hash ||
        segments[0] !== cloudName || segments[1] !== 'image' || segments[2] !== 'upload' || !/^v[0-9]+$/.test(segments[3] || '')) {
        throw new RefinementError('Re-upload this image to NaijaGo before refinement.');
    }
    const path = segments.slice(4).join('/');
    if (!/^(naijago_products|naijago_product_views|naijago_ai_catalog_drafts)\/[a-zA-Z0-9_/-]+\.(jpg|jpeg|png|webp)$/.test(path) || path.includes('..')) {
        throw new RefinementError('This legacy image needs a fresh product upload before refinement.');
    }
    return { publicId: path.replace(/\.[^.]+$/, ''), version: Number(segments[3].slice(1)), format: path.split('.').pop() };
}
function imageBytes(bytes, mime) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > MAX_BYTES) throw new RefinementError('Invalid or oversized image.');
    const valid = mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : mime === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mime === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    if (!valid) throw new RefinementError('The image service returned an invalid image.');
    return bytes;
}
function replacement(product, from, to) {
    if (!sourceImages(product).includes(from)) throw new RefinementError('The product image changed. This review is obsolete.', 409);
    const result = {};
    if (product.imageUrls?.includes(from)) result.imageUrls = product.imageUrls.map((url) => url === from ? to : url);
    for (const key of ['main', 'front', 'back', 'rear']) if (product.images?.[key] === from) result[`images.${key}`] = to;
    if (product.images?.others?.includes(from)) result['images.others'] = product.images.others.map((url) => url === from ? to : url);
    (product.variants || []).forEach((variant, index) => {
        if (variant.imageUrls?.includes(from)) result[`variants.${index}.imageUrls`] = variant.imageUrls.map((url) => url === from ? to : url);
    });
    return result;
}
module.exports = { RefinementError, STATES, MAX_BYTES, id, revision, sourceImages, sourceKey, sourceIdentity, imageBytes, replacement };
