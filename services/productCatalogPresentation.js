const ProductOffer = require('../models/ProductOffer');

const vendorPopulateFields = 'businessName businessLocation phoneNumber businessLogoUrl businessWhatsAppNumber businessSupportPhone deliveryRadiusKm prepTimeMinutes isTemporarilyClosed temporaryClosureReason operatingHours';

function createProductCatalogPresentation({ Offer = ProductOffer } = {}) {
    async function attachPrimaryOffers(products, { offers: preloadedOffers } = {}) {
        const list = (Array.isArray(products) ? products : [products]).filter(Boolean);
        const productIds = list.map((product) => product._id);
        if (!productIds.length) return Array.isArray(products) ? [] : products;
        const offers = preloadedOffers !== undefined
            ? await Offer.populate(preloadedOffers, { path: 'sellerId', select: vendorPopulateFields })
            : await Offer.find({
                product: { $in: productIds }, status: { $in: ['active', 'out_of_stock'] },
            }).populate('sellerId', vendorPopulateFields).sort({ isPrimary: -1, price: 1, _id: 1 }).lean();
        const byProduct = new Map();
        for (const offer of offers) {
            const key = String(offer.product);
            if (!byProduct.has(key)) byProduct.set(key, []);
            byProduct.get(key).push(offer);
        }
        const enriched = list.map((product) => {
            const availableOffers = byProduct.get(String(product._id)) || [];
            const selectedOffer = availableOffers.find((offer) => offer.isPrimary) || availableOffers[0] || null;
            const selectedDiscount = selectedOffer ? selectedOffer.discountPrice ?? null : product.discountPrice ?? null;
            const selectedPrice = selectedOffer?.price ?? product.price;
            const sellerType = selectedOffer?.sellerType || (product.vendor ? 'vendor' : product.sellerType || 'naijago');
            return {
                ...product, offers: availableOffers, selectedOffer, sellerType,
                sellerId: sellerType === 'naijago' ? null : selectedOffer?.sellerId?._id || selectedOffer?.sellerId || product.sellerId || product.vendor?._id || product.vendor || null,
                sellerName: sellerType === 'naijago' ? 'NaijaGo' : selectedOffer?.sellerId?.businessName || product.vendor?.businessName || 'Vendor',
                effectivePrice: selectedDiscount !== null && selectedDiscount >= 0 && selectedDiscount < selectedPrice ? selectedDiscount : selectedPrice,
                price: selectedPrice, discountPrice: selectedDiscount,
                stockQuantity: selectedOffer?.stockQuantity ?? product.stockQuantity,
            };
        });
        return Array.isArray(products) ? enriched : enriched[0];
    }
    return { attachPrimaryOffers };
}
const { attachPrimaryOffers } = createProductCatalogPresentation();
module.exports = { attachPrimaryOffers, createProductCatalogPresentation, vendorPopulateFields };
