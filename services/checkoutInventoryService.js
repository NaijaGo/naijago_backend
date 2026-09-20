'use strict';
const { CheckoutCatalogError } = require('./checkoutCatalogService');

// Called only inside the existing wallet/provider settlement transaction. The
// caller owns payment idempotency and commits/aborts stock and order together.
function createCheckoutInventoryService({ Product, ProductOffer }) {
    async function decrement({ item, session, sellerType, sellerId }) {
        if (!session?.inTransaction()) throw new Error('Inventory settlement requires an active transaction.');
        const quantity = item.quantity;
        if (!Number.isSafeInteger(quantity) || quantity < 1) throw new CheckoutCatalogError('INVALID_QUANTITY', 'This order needs an inventory review.');
        const options = { new: true, session, runValidators: true };
        const insufficient = () => { throw new CheckoutCatalogError('INSUFFICIENT_STOCK', 'Stock changed while payment was being confirmed. Please contact support; do not pay again.'); };
        if (item.offer) {
            const filter = { _id: item.offer, product: item.product, stockQuantity: { $gte: quantity } };
            if (sellerType) { filter.sellerType = sellerType; filter.sellerId = sellerId || null; }
            const inc = { stockQuantity: -quantity };
            if (item.variantId) {
                filter.variants = { $elemMatch: { productVariantId: item.variantId, stockQuantity: { $gte: quantity } } };
                inc['variants.$.stockQuantity'] = -quantity;
            }
            const offer = await ProductOffer.findOneAndUpdate(filter, { $inc: inc }, options);
            if (!offer) insufficient();
            const productFilter = { _id: item.product };
            const update = { $inc: { salesCount: quantity } };
            // Product stock is the primary offer's legacy display mirror, NOT a
            // second shared inventory pool for all vendors selling this product.
            if (offer.isPrimary) {
                update.$set = { stockQuantity: offer.stockQuantity };
                if (item.variantId) {
                    const variant = offer.variants.find((entry) => String(entry.productVariantId) === String(item.variantId));
                    if (!variant) insufficient();
                    productFilter.variants = { $elemMatch: { _id: item.variantId } };
                    update.$set['variants.$.stockQuantity'] = variant.stockQuantity;
                }
            }
            if (!await Product.findOneAndUpdate(productFilter, update, options)) insufficient();
        } else {
            const filter = { _id: item.product, stockQuantity: { $gte: quantity } };
            const inc = { salesCount: quantity, stockQuantity: -quantity };
            if (item.variantId) {
                filter.variants = { $elemMatch: { _id: item.variantId, stockQuantity: { $gte: quantity } } };
                inc['variants.$.stockQuantity'] = -quantity;
            }
            if (!await Product.findOneAndUpdate(filter, { $inc: inc }, options)) insufficient();
        }
    }
    return { decrement };
}
module.exports = { createCheckoutInventoryService };
