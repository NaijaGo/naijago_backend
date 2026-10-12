// Keep policy independent of the reference resolver so reconciliation uses the
// same medicine/food evidence without a circular module dependency.
const manifest = require('../config/catalogTaxonomy.json');
const { isApprovedVendor, isApprovedPharmacistVendor } = require('./productPermissions');
const byId = new Map(manifest.categories.flatMap(parent => [parent, ...parent.children]).map(node => [node.id, node]));
function classificationEvidence(value, subcategory = '') {
    if (typeof value === 'string') return [value, subcategory].filter(Boolean);
    const product = value || {};
    // Include both supplied labels and known IDs: a contradictory field cannot hide a restriction.
    return [product.category, product.subcategory, byId.get(String(product.categoryId))?.label,
        byId.get(String(product.subcategoryId))?.label].filter(Boolean);
}
function categoryPath(value, subcategory = '') {
    return classificationEvidence(value, subcategory).join(' > ').toLowerCase();
}
function isMedicineCategory(value, subcategory) {
    const path = categoryPath(value, subcategory);
    return path.includes('medicine') || path.includes('pharmacy') || path.includes('drug');
}
function isRestaurantCategory(value, subcategory) {
    // Restrictions are additive: equipment in another field/path component
    // cannot cancel food evidence. Genuine Restaurant Equipment alone is non-food.
    return classificationEvidence(value, subcategory).some(evidence => String(evidence).split('>').some(part => {
        const label = part.trim().toLowerCase();
        return label === 'restaurant' || ['meal', 'fast food', 'local dishes', 'pastries', 'drinks', 'catering'].some(term => label.includes(term));
    }));
}
const isMedicineProduct = product => isMedicineCategory(product) || Boolean(product?.medicineAccess) ||
    product?.requiresPrescription === true || product?.requiresPharmacistApproval === true;
const requiresProductModeration = (value, subcategory) =>
    (typeof value === 'string' ? isMedicineCategory(value, subcategory) : isMedicineProduct(value)) || isRestaurantCategory(value, subcategory);
const isRestrictedMedicine = product => isMedicineProduct(product) && (
    ['prescription', 'pharmacist_approval', 'restricted'].includes(product.medicineAccess) ||
    product.requiresPrescription === true || product.requiresPharmacistApproval === true);
function preservesCategoryRestrictions(before, after) {
    return (!isMedicineProduct(before) || isMedicineProduct(after)) &&
        (!isRestaurantCategory(before) || isRestaurantCategory(after));
}
function productPurchaseError(product, seller, sellerType = product.sellerType) {
    // Missing status fields retain compatibility with older records. Explicit
    // pending/rejected/disabled states are never purchasable via a direct ID.
    if (product.isActive === false || (product.productStatus && product.productStatus !== 'active') ||
        (product.moderationStatus && product.moderationStatus !== 'approved')) return 'This product is not available for purchase.';
    if (isRestaurantCategory(product) && !String(product.restaurantName || '').trim()) return 'Restaurant information must be completed before this food listing can be ordered.';
    if (sellerType === 'vendor' && !seller) return 'The vendor account is unavailable for this listing.';
    // Actual checkout queries populate these seller fields. Lightweight legacy
    // fixtures without account fields do not imply an approval state.
    if (seller && typeof seller === 'object' && (seller.vendorStatus !== undefined || seller.isVendor !== undefined)) {
        if (!isApprovedVendor(seller)) return 'This vendor is not approved to accept orders.';
        if (isMedicineProduct(product) && !isApprovedPharmacistVendor(seller)) return 'An approved pharmacist vendor is required for this medicine listing.';
    }
    return null;
}
module.exports = { categoryPath, isMedicineCategory, isRestaurantCategory, requiresProductModeration,
    isMedicineProduct, isRestrictedMedicine, preservesCategoryRestrictions, productPurchaseError };
