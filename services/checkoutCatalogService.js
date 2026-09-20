'use strict';

// A quote is a snapshot, not a stock reservation. Reuse this resolver for normal,
// group and recurring checkout; never trust prices or seller data in a cart.
class CheckoutCatalogError extends Error {
    constructor(code, message, statusCode = 409) { super(message); this.code = code; this.statusCode = statusCode; }
}
const fail = (code, message, status) => { throw new CheckoutCatalogError(code, message, status); };
const ref = (value) => String(value?._id || value || '');
const validId = (value) => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const id = (value) => {
    if (!validId(value)) fail('INVALID_ITEM', 'Choose the product again before checkout.', 400);
    return value.toLowerCase();
};
const attributes = (variant) => variant?.attributes instanceof Map ? Object.fromEntries(variant.attributes) : variant?.attributes || {};
const hasLocation = (location) => typeof location?.latitude === 'number' && Number.isFinite(location.latitude) &&
    Math.abs(location.latitude) <= 90 && typeof location?.longitude === 'number' && Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180;
function priceOf(record, fallback) {
    const price = record.price ?? fallback;
    const discount = record.discountPrice;
    if (!Number.isFinite(price) || price < 0 || (discount != null && (!Number.isFinite(discount) || discount < 0 || discount >= price))) {
        fail('PRICE_UNAVAILABLE', 'This product price needs updating. Please refresh your cart.');
    }
    return discount ?? price;
}
function normalizeItems(items) {
    if (!Array.isArray(items) || !items.length || items.length > 100) fail('INVALID_ITEMS', 'Choose between 1 and 100 cart items.', 400);
    return items.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) fail('INVALID_ITEM', 'Choose valid cart items.', 400);
        if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) fail('INVALID_QUANTITY', 'Item quantity must be a whole number from 1 to 99.', 400);
        if (item.customerNote != null && (typeof item.customerNote !== 'string' || item.customerNote.length > 500)) fail('INVALID_NOTE', 'Order notes must be 500 characters or fewer.', 400);
        return { product: id(item.product), offer: item.offer == null || item.offer === '' ? null : id(item.offer),
            variantId: item.variantId == null || item.variantId === '' ? null : id(item.variantId), quantity: item.quantity,
            selectedSize: item.selectedSize ?? null, customerNote: (item.customerNote || '').trim() };
    });
}

// Preserve the legacy mobile string/custom-dimension payload, but copy only a
// real catalog option. Arbitrary labels/dimensions and embedded prices are not data.
function resolveSize(selection, product) {
    if (selection == null) return null;
    if (typeof selection === 'string') {
        const match = (product.sizeData?.sizes || []).find((size) => size.value === selection);
        if (match) return match.value;
    } else if (typeof selection === 'object' && !Array.isArray(selection)) {
        const option = (product.sizeData?.sizes || []).find((size) => size.value === selection.value && (selection.unit == null || selection.unit === size.unit));
        if (option) return Object.fromEntries(['value', 'label', 'unit'].filter((key) => option[key] != null).map((key) => [key, option[key]]));
        const keys = ['length', 'width', 'height', 'unit'];
        const match = (product.sizeData?.customDimensions || []).find((size) => keys.every((key) => (size[key] ?? null) === (selection[key] ?? null)));
        if (match) return Object.fromEntries([...keys, 'label'].filter((key) => match[key] != null).map((key) => [key, match[key]]));
    }
    fail('SIZE_UNAVAILABLE', 'This size is no longer available. Please select it again.');
}

function createCheckoutCatalogService({ Product, ProductOffer, User }) {
    const read = (query, session) => { if (session) query.session(session); return query.lean(); };
    async function resolve(rawItems, { session = null } = {}) {
        const items = normalizeItems(rawItems);
        const productIds = [...new Set(items.map((item) => item.product))];
        // Sequential reads are intentional: a Mongo transaction must not run
        // parallel operations on the same session.
        const products = await read(Product.find({ _id: { $in: productIds } }), session);
        const offers = await read(ProductOffer.find({ product: { $in: productIds } }), session);
        const sellerIds = [...new Set([...products.flatMap((product) => [ref(product.vendor), ref(product.sellerId)]), ...offers.map((offer) => ref(offer.sellerId))].filter(Boolean))];
        const sellers = sellerIds.length ? await read(User.find({ _id: { $in: sellerIds } }).select('isVendor vendorStatus businessName businessLocation phoneNumber businessSupportPhone pickupEnabled pickupSettings operatingHours isTemporarilyClosed temporaryClosureReason deliveryRadiusKm prepTimeMinutes'), session) : [];
        const productMap = new Map(products.map((product) => [ref(product), product]));
        const sellerMap = new Map(sellers.map((seller) => [ref(seller), seller]));
        const approved = (sellerId) => sellerMap.get(ref(sellerId))?.isVendor === true && sellerMap.get(ref(sellerId))?.vendorStatus === 'approved';
        const eligible = (offer) => offer.sellerType === 'naijago' ? !offer.sellerId : offer.sellerType === 'vendor' && approved(offer.sellerId);
        const totals = new Map();
        function stock(key, available, quantity) {
            const total = (totals.get(key) || 0) + quantity;
            if (!Number.isSafeInteger(available) || available < total) fail('INSUFFICIENT_STOCK', 'There is not enough stock for the combined quantities in your cart. Please refresh it.');
            totals.set(key, total);
        }
        return items.map((item) => {
            const product = productMap.get(item.product);
            if (!product || product.isActive !== true || product.moderationStatus !== 'approved' || product.productStatus !== 'active') fail('PRODUCT_UNAVAILABLE', 'A product in your cart is no longer available. Please refresh your cart.');
            const owner = product.vendor || product.sellerId;
            if (owner ? !approved(owner) : product.sellerType && product.sellerType !== 'naijago') fail('SELLER_UNAVAILABLE', 'This seller is not currently accepting orders.');
            const productOffers = offers.filter((offer) => ref(offer.product) === item.product);
            const candidates = productOffers.filter((offer) => eligible(offer) && ['active', 'out_of_stock'].includes(offer.status))
                .sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)) || a.price - b.price || ref(a).localeCompare(ref(b)));
            const offer = item.offer ? productOffers.find((entry) => ref(entry) === item.offer) : candidates[0];
            if ((item.offer || productOffers.length) && (!offer || offer.status !== 'active' || !eligible(offer))) fail('OFFER_UNAVAILABLE', 'The selected seller offer is no longer available. Please refresh your cart.');
            const sellerType = offer?.sellerType || (owner ? 'vendor' : 'naijago');
            const sellerId = sellerType === 'vendor' ? ref(offer?.sellerId || owner) : null;
            const sellerVendor = sellerId ? sellerMap.get(sellerId) : null;
            const sellerName = sellerType === 'naijago' ? 'NaijaGo' : sellerVendor.businessName || 'Vendor';
            const sellerLocation = hasLocation(offer?.fulfilmentLocation) ? offer.fulfilmentLocation : sellerVendor?.businessLocation || product.productLocation;
            if (!hasLocation(sellerLocation)) fail('LOCATION_UNAVAILABLE', 'A shop or warehouse location must be configured before this product can be ordered.');
            const sellerKey = sellerType === 'naijago' ? 'naijago' : `vendor:${sellerId}`;
            const fulfillmentKey = `${sellerKey}:${sellerLocation.latitude}:${sellerLocation.longitude}`;
            const variants = product.variants || [];
            const selectedValue = typeof item.selectedSize === 'string' ? item.selectedSize : item.selectedSize?.value;
            let variant = item.variantId ? variants.find((entry) => ref(entry) === item.variantId) : null;
            // Legacy sizes can map to a structured variant only when unambiguous.
            if (!variant && !item.variantId && typeof selectedValue === 'string' && variants.length) {
                const matches = variants.filter((entry) => (attributes(entry).size ?? entry.name) === selectedValue);
                if (matches.length === 1) variant = matches[0];
            }
            if ((item.variantId || variants.length || offer?.variants?.length) && (!variant || variant.isActive !== true)) fail('VARIANT_UNAVAILABLE', 'Choose an available product variant before checkout.');
            let selectedSize = item.selectedSize;
            if (variant && selectedSize != null) {
                if (typeof selectedValue !== 'string' || (attributes(variant).size ?? variant.name) !== selectedValue) fail('SIZE_UNAVAILABLE', 'The selected size does not match this product variant.');
                selectedSize = selectedValue;
            } else {
                selectedSize = resolveSize(selectedSize, product);
                if (!variant && selectedSize == null && ((product.sizeData?.sizes?.length || 0) + (product.sizeData?.customDimensions?.length || 0) > 0)) fail('SIZE_REQUIRED', 'Choose a product size before checkout.');
            }
            let priceRecord = offer || product;
            let sku = priceRecord.sku || product.sku || '';
            stock(offer ? `offer:${ref(offer)}` : `product:${item.product}`, priceRecord.stockQuantity, item.quantity);
            if (variant) {
                const offerVariant = offer?.variants?.find((entry) => ref(entry.productVariantId) === ref(variant));
                if (offer && (!offerVariant || offerVariant.isActive !== true)) fail('VARIANT_UNAVAILABLE', 'This variant is not available from the selected seller.');
                priceRecord = offerVariant || variant;
                stock(`${offer ? ref(offer) : item.product}:variant:${ref(variant)}`, priceRecord.stockQuantity, item.quantity);
                sku = priceRecord.sku || variant.sku || sku;
            }
            const unitPrice = priceOf(priceRecord, variant && !offer ? product.price : undefined);
            return { product, offer: offer || null, sellerType, sellerId, sellerName, sellerKey, fulfillmentKey, sellerVendor, sellerLocation, unitPrice,
                item: { product: item.product, offer: offer ? ref(offer) : null, variantId: variant ? ref(variant) : null,
                    quantity: item.quantity, selectedSize, sku, customerNote: item.customerNote,
                    variantAttributes: variant ? attributes(variant) : {}, authoritativePrice: unitPrice } };
        });
    }
    return { resolve };
}
module.exports = { createCheckoutCatalogService, CheckoutCatalogError, hasLocation, normalizeItems };
