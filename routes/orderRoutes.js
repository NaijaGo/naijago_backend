// routes/orderRoutes.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const MainOrder = require('../models/MainOrder');
const Shipment = require('../models/Shipment');
const Product = require('../models/Product');
const User = require('../models/User');
const Rider = require('../models/Rider');
const CompanyDelivery = require('../models/CompanyDelivery');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const axios = require("axios");
const notificationService = require('../services/notificationService');
const { grantReferralRewardForVerifiedUser } = require('../services/referralService');
const { getDeliveryFeeSettings, buildDeliveryFeeQuote } = require('../services/deliveryFeeService');
const { notifyVendorOfPaidShipment } = require('../services/vendorOrderNotificationService');
const {
    calculateOrderRiderEarningsBreakdown,
    calculateShipmentRiderEarningBreakdown,
    creditRiderForCompletedOrder,
} = require('../services/riderEarningsService');
const { trackAnalyticsEvent } = require('../services/analyticsService');
const { notifyEligibleRidersForShipment } = require('../services/riderAssignmentService');

const parsePagination = (query, defaults = {}) => {
    const maxLimit = defaults.maxLimit || 200;
    const defaultLimit = defaults.defaultLimit || 50;
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const requestedLimit = parseInt(query.limit, 10) || defaultLimit;
    const limit = Math.min(Math.max(requestedLimit, 1), maxLimit);
    return { page, limit, skip: (page - 1) * limit };
};

function getActiveNaijaGoSubscription(user) {
    const subscription = user?.naijagoSubscription;
    if (!subscription || subscription.status !== 'active') return null;

    const expiresAt = subscription.expiresAt ? new Date(subscription.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) return null;
    if ((subscription.deliveriesRemaining || 0) <= 0) return null;

    return subscription;
}

function isWithinSubscriptionHours(subscription) {
    const validHours = subscription?.validHours || {};
    const start = validHours.start || '09:00';
    const end = validHours.end || '18:00';
    const [startHour, startMinute] = start.split(':').map(Number);
    const [endHour, endMinute] = end.split(':').map(Number);
    const now = new Date();
    const timeZone = process.env.SUBSCRIPTION_TIMEZONE || 'Africa/Lagos';
    const zonedParts = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone,
    }).formatToParts(now);
    const currentHour = Number(zonedParts.find((part) => part.type === 'hour')?.value || now.getHours());
    const currentMinute = Number(zonedParts.find((part) => part.type === 'minute')?.value || now.getMinutes());
    const currentMinutes = currentHour * 60 + currentMinute;
    const startMinutes = startHour * 60 + startMinute;
    const endMinutes = endHour * 60 + endMinute;
    if (startMinutes === endMinutes) return true;
    if (startMinutes < endMinutes) {
        return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    }
    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

function normalizeZone(value) {
    return String(value || '').trim().toLowerCase();
}

function getDeliveryZoneName(zone) {
    if (!zone) return '';
    return zone.zoneKey || zone.zoneName || '';
}

function buildSubscriptionDeliveryDiscount({ user, totalSubtotal, totalShippingPrice, matchedDeliveryZone, shippingAddress }) {
    const subscription = getActiveNaijaGoSubscription(user);
    if (!subscription) {
        return { eligible: false, discount: 0, reason: 'No active subscription.' };
    }

    if (Number(totalSubtotal || 0) < Number(subscription.minimumOrderValue || 0)) {
        return { eligible: false, discount: 0, reason: 'Minimum order value not met.' };
    }

    if (!isWithinSubscriptionHours(subscription)) {
        return { eligible: false, discount: 0, reason: 'Outside subscription delivery hours.' };
    }

    const deliveryZone = normalizeZone(getDeliveryZoneName(matchedDeliveryZone));
    const subscriptionZone = normalizeZone(subscription.zone);
    if (subscription.deliveryScope === 'same_zone' && subscriptionZone && deliveryZone && subscriptionZone !== deliveryZone) {
        return { eligible: false, discount: 0, reason: 'Delivery is outside your subscription zone.' };
    }

    const subscriptionCity = normalizeZone(subscription.city);
    const destinationCity = normalizeZone(shippingAddress?.city);
    if (subscription.deliveryScope === 'city_errands' && subscriptionCity && destinationCity && subscriptionCity !== destinationCity) {
        return { eligible: false, discount: 0, reason: 'Delivery is outside your subscription city.' };
    }

    const discount = Math.max(0, Number(totalShippingPrice || 0));
    if (discount <= 0) {
        return { eligible: false, discount: 0, reason: 'No delivery fee to waive.' };
    }

    return {
        eligible: true,
        discount: parseFloat(discount.toFixed(2)),
        reason: 'Subscription free delivery applied.',
        planId: subscription.planId,
        planName: subscription.planName,
        deliveriesRemaining: subscription.deliveriesRemaining,
    };
}

function formatLastSeen(date) {
    if (!date) return 'never';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
    return `${Math.floor(hours / 24)} day(s) ago`;
}

function isRiderTrackingVisible(order) {
    if (!order?.rider || !order?.isClaimed) return false;
    return !['cancelled', 'completed'].includes(order.mainOrderStatus);
}

async function consumeSubscriptionDeliveryIfNeeded({ buyer, mainOrder, session }) {
    if (!mainOrder.subscriptionFreeDeliveryApplied || mainOrder.subscriptionDeliveryConsumed) {
        return buyer;
    }

    const subscription = getActiveNaijaGoSubscription(buyer);
    if (!subscription) {
        throw new Error('Subscription delivery benefit is no longer available.');
    }

    subscription.deliveriesRemaining = Math.max(0, (subscription.deliveriesRemaining || 0) - 1);
    mainOrder.subscriptionDeliveryConsumed = true;
    await buyer.save({ session });
    return buyer;
}

// Category-based commission rates
// const CATEGORY_COMMISSION_RATES = {
//     // HIGH COMMISSION CATEGORIES (15%) - Luxury/High-margin items
//     'high': {
//         rate: 0.15,
//         categories: [
//             // Luxury Fashion
//             'Fashion > Men\'s Fashion',
//             'Fashion > Women\'s Fashion',
//             'Fashion > Watches',
//             'Fashion > Jewelry',
//             'Fashion > Eyewear',
            
//             // Electronics & Tech
//             'Electronics > Television & Video',
//             'Electronics > Camera & Photo',
//             'Electronics > Generator & Portable Power',
//             'Electronics > Gadgets',
//             'Electronics > Drones',
//             'Electronics > Smart Home Devices',
//             'Computing > Computers',
            
//             // Luxury Items
//             'Home & Office > Appliances',
//             'Home & Office > Furniture',
//             'Home & Office > Lighting',
//             'Home & Office > Home Security',
            
//             // Health & Beauty Luxury
//             'Health & Beauty > Make Up',
//             'Health & Beauty > Fragrance',
//             'Health & Beauty > Skin Care & Cosmetics',
            
//             // Automotive
//             'Automobiles > Performance Parts',
            
//             // Gaming
//             'Gaming > Play Station',
//             'Gaming > Xbox',
//             'Gaming > Nintendo',
//             'Gaming > PC Gaming',
//             'Gaming > Gaming Consoles',
//             'Gaming > Video Games',
//             'Gaming > VR Headsets',
            
//             // Sporting Goods (High-end)
//             'Sporting Goods > Cardio Training',
//             'Sporting Goods > Strength & Training Equipment',
//             'Sporting Goods > Fitness Trackers',
            
//             // Musical Instruments
//             'Music & Instruments > Guitars',
//             'Music & Instruments > Keyboards & Pianos',
//             'Music & Instruments > Audio Equipment',
            
//             // Photography
//             'Photography > Cameras',
//             'Photography > Lenses',
            
//             // Phones & Tablets
//             'Phones & Tablets > Mobile Phones',
//             'Phones & Tablets > Tablets',
//             'Phones & Tablets > Smartphones',
//             'Phones & Tablets > Wearable Technology',
            
//             // Jewelry & Watches
//             'Jewelry & Watches > Fine Jewelry',
//             'Jewelry & Watches > Fashion Jewelry',
//             'Jewelry & Watches > Wrist Watches',
//         ]
//     },
    
//     // MEDIUM COMMISSION CATEGORIES (12.5%) - Mid-range items
//     'medium': {
//         rate: 0.125,
//         categories: [
//             // Fashion (non-luxury)
//             'Fashion > Kids\' Fashion',
//             'Fashion > Luggages & Travel Gear',
//             'Fashion > Hair & Wigs',
//             'Fashion > Footwear',
//             'Fashion > Bags & Purses',
//             'Fashion > Belts & Accessories',
//             'Fashion > Traditional Attire',
//             'Fashion > Underwear & Lingerie',
//             'Fashion > Sportswear',
            
//             // Electronics (mid-range)
//             'Electronics > Audios',
//             'Electronics > Home Theater Systems',
//             'Electronics > Headphones & Earbuds',
//             'Electronics > Car Electronics',
//             'Electronics > Batteries & Power',
//             'Computing > Data Storage',
//             'Computing > Anti Virus & Security',
//             'Computing > Printers & Computer Accessories',
//             'Computing > Keyboards & Mice',
            
//             // Home & Office (mid-range)
//             'Home & Office > Home & Kitchen',
//             'Home & Office > Home Interior & Exterior',
//             'Home & Office > Office Products',
//             'Home & Office > Cleaning Supplies',
//             'Home & Office > Storage & Organization',
//             'Home & Office > Garden & Outdoor',
//             'Home & Office > Bedding & Bath',
            
//             // Health & Beauty (mid-range)
//             'Health & Beauty > Hair Care',
//             'Health & Beauty > Oral Care',
//             'Health & Beauty > Personal Care',
//             'Health & Beauty > Shaving & Hair Removal',
//             'Health & Beauty > Vitamins & Supplements',
            
//             // Baby Products
//             'Baby Products > Apparels & Accessories',
//             'Baby Products > Diapering',
//             'Baby Products > Feeding',
//             'Baby Products > Baby Toddlers Toys',
//             'Baby Products > Gears',
//             'Baby Products > Bathing & Skin Care',
//             'Baby Products > Potty Training',
//             'Baby Products > Safety',
//             'Baby Products > Nursery Furniture',
//             'Baby Products > Strollers & Prams',
//             'Baby Products > Car Seats',
//             'Baby Products > Educational Toys',
            
//             // Books & Stationery
//             'Books & Stationery > Fiction Books',
//             'Books & Stationery > Comics',
//             'Books & Stationery > Technology',
//             'Books & Stationery > Business',
//             'Books & Stationery > Story',
//             'Books & Stationery > Religious',
//             'Books & Stationery > Non-Fiction',
//             'Books & Stationery > Academic Textbooks',
//             'Books & Stationery > Children Books',
//             'Books & Stationery > Magazines',
//             'Books & Stationery > Writing Instruments',
//             'Books & Stationery > Office Supplies',
//             'Books & Stationery > Art Supplies',
//             'Books & Stationery > Calendars & Planners',
            
//             // Phones & Tablets Accessories
//             'Phones & Tablets > Mobile Phone Accessories',
//             'Phones & Tablets > Phone Cases & Covers',
//             'Phones & Tablets > Screen Protectors',
//             'Phones & Tablets > Chargers & Cables',
//             'Phones & Tablets > Power Banks',
//             'Phones & Tablets > Bluetooth Accessories',
//             'Phones & Tablets > Feature Phones',
            
//             // Sporting Goods (mid-range)
//             'Sporting Goods > Team Sports',
//             'Sporting Goods > Outdoor & Adventures',
//             'Sporting Goods > Yoga & Pilates',
//             'Sporting Goods > Swimming',
//             'Sporting Goods > Cycling',
//             'Sporting Goods > Camping & Hiking',
//             'Sporting Goods > Golf',
//             'Sporting Goods > Martial Arts',
            
//             // Gaming (mid-range)
//             'Gaming > Gaming Accessories',
//             'Gaming > Arcade Games',
//             'Gaming > Board Games',
//             'Gaming > Card Games',
//             'Gaming > Puzzles',
            
//             // Music & Instruments (mid-range)
//             'Music & Instruments > Wind Instruments',
            
//             // Photography Accessories
//             'Photography > Lighting Equipment',
//             'Photography > Camera Bags & Cases',
//             'Photography > Tripods & Supports',
//         ]
//     },
    
//     // LOW COMMISSION CATEGORIES (10%) - Low-margin/essential items
//     'low': {
//         rate: 0.10,
//         categories: [
//             // Groceries & Essentials
//             'Groceries > Beer, Wine & Spirits',
//             'Groceries > Food Cupboard',
//             'Groceries > House Hold Cleaning',
//             'Groceries > Fresh Produce',
//             'Groceries > Dairy & Eggs',
//             'Groceries > Seafood',
            
//             // Health & Medicine
//             'Health & Beauty > Medicine',
//             'Health & Beauty > Condoms',
//             'Health & Beauty > Sex Toys',
//             'Health & Beauty > First Aid',
//             'Health & Beauty > Medical Equipment',
//             'Health & Beauty > Feminine Care',
            
//             // Automotive Essentials
//             'Automobiles > Car Care',
//             'Automobiles > Car Exterior and Interior Accessories',
//             'Automobiles > Tools & Equipment',
//             'Automobiles > Oils & Fluids',
//             'Automobiles > Car Safety',
            
//             // Animal Products
//             'Animal Products > Chicken Feeds',
//             'Animal Products > Dog Feeds',
//             'Animal Products > Cat Feeds',
//             'Animal Products > Fish Feeds',
//             'Animal Products > Pig Feeds',
//             'Animal Products > Pet Accessories',
//             'Animal Products > Pet Health & Care',
//             'Animal Products > Pet Toys',
//             'Animal Products > Pet Clothing',
//             'Animal Products > Pet Grooming',
//             'Animal Products > Aquarium Supplies',
//             'Animal Products > Bird Supplies',
            
//             // Building & Construction
//             'Building & Construction > Building Materials',
//             'Building & Construction > Electrical',
//             'Building & Construction > Plumbing',
//             'Building & Construction > Tools & Machinery',
//             'Building & Construction > Safety Equipment',
//             'Building & Construction > Paints & Coatings',
//             'Building & Construction > Hardware',
            
//             // Industrial & Scientific
//             'Industrial & Scientific > Lab Equipment',
//             'Industrial & Scientific > Packaging & Shipping',
//             'Industrial & Scientific > Janitorial & Sanitation',
            
//             // Agriculture
//             'Agriculture > Fertilizers',
//             'Agriculture > Pesticides',
            
//             // Toys & Games (non-electronic)
//             'Toys & Games > Dolls',
//             'Toys & Games > Educational Toys',
//             'Toys & Games > Outdoor Toys',
//             'Toys & Games > Remote Control Toys',
//             'Toys & Games > Stuffed Animals',
//             'Toys & Games > Toy Vehicles',
            
//             // Arts & Crafts
//             'Arts & Crafts > Painting',
//             'Arts & Crafts > Beading & Jewelry Making',
//             'Arts & Crafts > Clay & Pottery',
            
//             // Food & Beverage Equipment
//             'Food & Beverage > Restaurant Equipment',
//             'Food & Beverage > Catering Supplies',
//             'Food & Beverage > Baking Supplies',
//             'Food & Beverage > Food Processing',
//             'Food & Beverage > Beverage Equipment',
//             'Food & Beverage > Kitchen Utensils',
//             'Food & Beverage > Food Packaging',
            
//             // Travel & Tourism
//             'Travel & Tourism > Travel Accessories',
//             'Travel & Tourism > Luggage',
//             'Travel & Tourism > Hotel Supplies',
            
//             // Wedding & Events
//             'Wedding & Events > Wedding Attire',
//         ]
//     }
// };


// Category-based commission rates (NaijaGo Final Structure)
const CATEGORY_COMMISSION_RATES = {
    // Core Marketplace
    'Groceries': 0.05,
    'Food & Beverage': 0.15,

    'Phones & Tablets': 0.06,
    'Computing': 0.06,
    'Electronics': 0.06,
    'Appliances': 0.06,

    // Lifestyle & High Margin
    'Fashion': 0.12,
    'Jewelry & Watches': 0.12,
    'Fragrances': 0.12,
    'Health & Beauty': 0.06,

    // Home & Living
    'Home & Kitchen': 0.07,
    'Furniture': 0.08,
    'Home Interior & Exterior': 0.08,
    'Lighting': 0.08,

    // Everyday & Business
    'Office Products': 0.07,
    'Automobile': 0.08,
    'Agriculture': 0.05,

    // Entertainment & Hobby
    'Gaming': 0.10,
    'Sporting Goods': 0.10,
    'Toys & Games': 0.10,
    'Music & Instruments': 0.08,
    'Arts & Crafts': 0.10,
    'Photography': 0.08,

    // Services
    'Travel & Tourism': 0.10,
    'Events': 0.10,
};

// Helper function to get commission rate based on category
// function getCommissionRateForCategory(category) {
//     // Check each commission tier
//     for (const [tier, data] of Object.entries(CATEGORY_COMMISSION_RATES)) {
//         if (data.categories.includes(category)) {
//             return data.rate;
//         }
//     }
    
//     // Default rate if category not found
//     return 0.125; // 12.5% default
// }

function getCommissionRateForCategory(category) {
    if (!category || typeof category !== 'string') return 0.08;

    const normalizedCategory = category.trim();
    const mainCategory = normalizedCategory.split('>')[0].trim();
    const subCategory = normalizedCategory.includes('>')
        ? normalizedCategory.split('>')[1].trim()
        : '';

    // THIS IS ONLY FOR FOOD (15% platform fee)
    const lowerCat = normalizedCategory.toLowerCase();
    if (!lowerCat.includes('restaurant equipment') && (
        lowerCat === 'restaurant' ||
        lowerCat.startsWith('restaurant >') ||
        lowerCat.includes('meal') ||
        lowerCat.includes('fast food') ||
        lowerCat.includes('local dishes') ||
        lowerCat.includes('pastries') ||
        lowerCat.includes('drinks') ||
        lowerCat.includes('catering') ||
        mainCategory === 'Food & Beverage'
    )) {
        return 0.15;
    }

    // Exact match first
    if (CATEGORY_COMMISSION_RATES[normalizedCategory]) {
        return CATEGORY_COMMISSION_RATES[normalizedCategory];
    }

    // Main category match
    if (CATEGORY_COMMISSION_RATES[mainCategory]) {
        return CATEGORY_COMMISSION_RATES[mainCategory];
    }

    // Support old DB category names
    const CATEGORY_ALIASES = {
        'Home & Office': {
            'Home & Kitchen': 0.07,
            'Furniture': 0.08,
            'Home Interior & Exterior': 0.08,
            'Lighting': 0.08,
            'Office Products': 0.07,
            'Appliances': 0.06,
        },
        'Automobiles': 0.08,
        'Automobile': 0.08,
        'Health & Beauty': 0.06,
        'Fragrance': 0.12,
        'Fragrances': 0.12,
        'Groceries': 0.05,
        'Animal Products': 0.05,
    };

    const alias = CATEGORY_ALIASES[mainCategory];

    if (typeof alias === 'number') {
        return alias;
    }

    if (alias && subCategory && alias[subCategory]) {
        return alias[subCategory];
    }

    return 0.08;
}

function isMedicineProduct(product = {}) {
    const category = String(product.category || '').toLowerCase();
    return category.includes('medicine') ||
        category.includes('pharmacy') ||
        category.includes('drug') ||
        Boolean(product.medicineAccess);
}

function isRestrictedMedicine(product = {}) {
    return isMedicineProduct(product) && (
        product.medicineAccess === 'prescription' ||
        product.medicineAccess === 'pharmacist_approval' ||
        product.medicineAccess === 'restricted' ||
        product.requiresPrescription === true ||
        product.requiresPharmacistApproval === true
    );
}

function isRestaurantProduct(product = {}) {
    const category = String(product.category || '').toLowerCase();
    if (category.includes('restaurant equipment')) return false;
    return category === 'restaurant' ||
        category.startsWith('restaurant >') ||
        category.includes('meal') ||
        category.includes('fast food') ||
        category.includes('local dishes') ||
        category.includes('pastries') ||
        category.includes('drinks') ||
        category.includes('catering');
}

function minutesFromTime(value, fallback) {
    const source = typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)
        ? value
        : fallback;
    const [hours, minutes] = source.split(':').map(Number);
    return (hours * 60) + minutes;
}

function isWithinRestaurantOrderWindow(product = {}, date = new Date()) {
    const start = minutesFromTime(product.orderStartTime, '09:00');
    const end = minutesFromTime(product.orderEndTime, '19:00');
    const now = (date.getHours() * 60) + date.getMinutes();

    if (start === end) return true;
    if (start < end) return now >= start && now <= end;
    return now >= start || now <= end;
}

function currentDayKey(date = new Date()) {
    return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][date.getDay()];
}

function isWithinVendorOperatingHours(vendor = {}, date = new Date()) {
    if (vendor.isTemporarilyClosed) {
        return {
            open: false,
            reason: vendor.temporaryClosureReason || 'Restaurant is temporarily closed.',
        };
    }

    const day = currentDayKey(date);
    const hours = Array.isArray(vendor.operatingHours)
        ? vendor.operatingHours.find((entry) => entry.day === day)
        : null;

    if (!hours) {
        return { open: true };
    }

    if (hours.isOpen === false) {
        return { open: false, reason: 'Restaurant is closed today.' };
    }

    const start = minutesFromTime(hours.openTime, '09:00');
    const end = minutesFromTime(hours.lastOrderTime || hours.closeTime, '19:00');
    const now = (date.getHours() * 60) + date.getMinutes();
    const within = start === end
        ? true
        : start < end
        ? now >= start && now <= end
        : now >= start || now <= end;

    return within
        ? { open: true }
        : {
            open: false,
            reason: `Restaurant accepts store orders from ${hours.openTime || '09:00'} to ${hours.lastOrderTime || hours.closeTime || '19:00'}.`,
        };
}

function formatRadius(value) {
    const radius = Number(value || 15);
    return Number.isFinite(radius) ? radius : 15;
}

function buildOrderItemFromProduct(item, product) {
    return {
        product: item.product,
        name: item.name || product.name,
        image: product.imageUrls?.[0],
        quantity: item.quantity,
        price: product.price,
        selectedSize: item.selectedSize || null,
        category: product.category || 'Uncategorized',
        restaurantName: product.restaurantName || undefined,
        foodInformation: product.foodInformation || undefined,
        foodCategory: product.foodCategory || undefined,
        orderStartTime: product.orderStartTime || undefined,
        orderEndTime: product.orderEndTime || undefined,
        medicineAccess: product.medicineAccess || undefined,
        isOverTheCounter: product.isOverTheCounter === true,
        requiresPrescription: product.requiresPrescription === true,
        requiresPharmacistApproval: product.requiresPharmacistApproval === true,
    };
}

// 👇 START OF ADDITIONS 1: Distance Calculation Utility (KEEPING THIS)
/**
 * Calculates the distance between two geographical coordinates using the Haversine formula.
 * @param {number} lat1 Latitude of point 1
 * @param {number} lon1 Longitude of point 1
 * @param {number} lat2 Latitude of point 2
 * @param {number} lon2 Longitude of point 2
 * @returns {number} Distance in Kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the Earth in kilometers
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c; // Distance in km
  return parseFloat(distance.toFixed(2)); // Round to 2 decimal places
}
// 👆 END OF ADDITIONS 1

// @desc    Get all orders (Admin access only)
// @route   GET /api/orders
// @access  Private/Admin
router.get('/', protect, async (req, res) => {
  try {
      const { limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 200 });
      // Find MainOrder documents and populate the linked shipments
      const orders = await MainOrder.find({}) 
        .populate('user', 'firstName lastName email phoneNumber') 
        .populate({
            path: 'shipments',
            populate: {
                path: 'vendor', // Populate vendor details within each shipment
                select: 'businessName phoneNumber businessLocation'
            }
        })
        .populate('rider', 'fullName phoneNumber plateNumber') // Populate rider info
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      res.status(200).json(orders);
  } catch (error) {
      console.error('Error fetching all orders:', error);
      res.status(500).json({ message: 'Error fetching all orders.', error: error.message });
  }
});

// ---
// ## Price Calculation Route


// @desc    Calculate total price, split by vendor, and return summary
// @route   POST /api/orders/calculate_summary
// @access  Private
router.post('/summary', protect, async (req, res) => {
    const { cartItems, shippingAddress, userLocation } = req.body;

    if (!cartItems || cartItems.length === 0) {
        return res.status(400).json({ message: 'No items in cart for summary calculation' });
    }
    if (!shippingAddress || !userLocation) {
        return res.status(400).json({ message: 'Shipping address and location are required' });
    }
    
    try {
        const vendorCartMap = new Map();
        let totalSubtotal = 0;
        let totalPlatformFees = 0;
        const deliveryFeeSettings = await getDeliveryFeeSettings();
        let matchedDeliveryZone = null;

        // 1. Group items by vendor and calculate subtotal for each vendor
        for (const item of cartItems) {
            // Fetch product, vendor, and category data
            const [product, vendorUser] = await Promise.all([
                Product.findById(item.product, 'name price imageUrls vendor category restaurantName foodInformation foodCategory orderStartTime orderEndTime medicineAccess isOverTheCounter requiresPrescription requiresPharmacistApproval'),
                User.findById(item.vendor, 'businessName businessLocation')
            ]);
            
            if (!product) {
                return res.status(404).json({ message: `Product not found: ${item.name}` });
            }

            if (isRestrictedMedicine(product)) {
                return res.status(400).json({
                    message: `${product.name} requires pharmacist consultation before purchase.`
                });
            }

            if (isRestaurantProduct(product) && !isWithinRestaurantOrderWindow(product)) {
                return res.status(400).json({
                    message: `${product.name} can only be ordered from ${product.orderStartTime || '09:00'} to ${product.orderEndTime || '19:00'}.`
                });
            }
            
            const vendorId = product.vendor.toString(); 

            if (!vendorUser || !vendorUser.businessLocation) {
                 return res.status(404).json({ message: `Vendor or location not found for product: ${item.name}` });
            }

            const itemPrice = product.price * item.quantity;
            totalSubtotal += itemPrice;

            // Get category-based commission rate
            const productCategory = product.category || 'Uncategorized';
            const commissionRate = getCommissionRateForCategory(productCategory);
            const itemCommission = itemPrice * commissionRate;
            totalPlatformFees += itemCommission;

            if (!vendorCartMap.has(vendorId)) {
                vendorCartMap.set(vendorId, {
                    vendorId: vendorId,
                    vendorName: vendorUser.businessName,
                    vendorLocation: {
                        latitude: vendorUser.businessLocation.latitude,
                        longitude: vendorUser.businessLocation.longitude,
                        formattedAddress: vendorUser.businessLocation.formattedAddress,
                        address: vendorUser.businessLocation.address,
                        addressLine: vendorUser.businessLocation.addressLine,
                    },
                    items: [],
                    subtotal: 0,
                    platformFee: 0,
                    commissionRate: 0,
                });
            }
            
            const vendorData = vendorCartMap.get(vendorId);
            vendorData.items.push({
                ...buildOrderItemFromProduct(item, product),
                commissionRate: commissionRate, // Store individual commission rate
                itemCommission: itemCommission, // Store calculated commission
            });
            
            vendorData.subtotal += itemPrice;
            vendorData.platformFee += itemCommission;
            // Store the average commission rate for this vendor's shipment
            vendorData.commissionRate = vendorData.platformFee / vendorData.subtotal;
        }

        // 2. Calculate fees for each shipment
        const shipmentSummaries = [];
        let totalShippingPrice = 0;
        let originalShippingPrice = 0;

        for (const data of vendorCartMap.values()) {
            const vendorLocation = data.vendorLocation;
            
            // Calculate Distance (Haversine)
            const distanceKm = calculateDistance(
                vendorLocation.latitude,
                vendorLocation.longitude,
                userLocation.latitude,
                userLocation.longitude
            );
            
            const deliveryFeeQuote = buildDeliveryFeeQuote({
                shippingAddress,
                distanceKm,
                settings: deliveryFeeSettings,
            });
            const shippingPrice = deliveryFeeQuote.amount;
            matchedDeliveryZone = matchedDeliveryZone || deliveryFeeQuote.zone;
            
            totalShippingPrice += shippingPrice;
            originalShippingPrice += shippingPrice;

            shipmentSummaries.push({
                vendorId: data.vendorId,
                vendorName: data.vendorName,
                vendorLocation: vendorLocation, 
                vendorZone: vendorLocation.formattedAddress || vendorLocation.address || vendorLocation.addressLine || '',
                subtotal: parseFloat(data.subtotal.toFixed(2)),
                shippingPrice: shippingPrice,
                originalShippingPrice: shippingPrice,
                subscriptionDeliveryDiscount: 0,
                subscriptionFreeDeliveryApplied: false,
                deliveryFeeSource: deliveryFeeQuote.source,
                deliveryFeeZone: deliveryFeeQuote.zone
                    ? {
                        zoneKey: deliveryFeeQuote.zone.zoneKey,
                        zoneName: deliveryFeeQuote.zone.zoneName,
                        group: deliveryFeeQuote.zone.group,
                        amount: deliveryFeeQuote.zone.amount,
                    }
                    : null,
                platformFee: parseFloat(data.platformFee.toFixed(2)),
                commissionRate: parseFloat(data.commissionRate.toFixed(3)),
                // Total cost for the items and delivery from this specific vendor
                totalShipmentCost: parseFloat((data.subtotal + shippingPrice).toFixed(2)), 
                items: data.items,
                commissionBreakdown: {
                    rate: data.commissionRate,
                    amount: data.platformFee,
                    description: `Commission applied based on product categories`
                }
            });
        }

        const buyer = await User.findById(req.user._id).select('naijagoSubscription');
        const subscriptionDiscount = buildSubscriptionDeliveryDiscount({
            user: buyer,
            totalSubtotal,
            totalShippingPrice,
            matchedDeliveryZone,
            shippingAddress,
        });

        if (subscriptionDiscount.eligible) {
            totalShippingPrice = 0;
            shipmentSummaries.forEach((summary) => {
                summary.subscriptionDeliveryDiscount = summary.originalShippingPrice;
                summary.subscriptionFreeDeliveryApplied = true;
                summary.shippingPrice = 0;
                summary.totalShipmentCost = parseFloat(summary.subtotal.toFixed(2));
            });
        }

        const totalPrice = totalSubtotal + totalShippingPrice + (req.body.taxPrice || 0.0);

        // 3. Prepare commission breakdown for response
        const commissionBreakdown = {};
        cartItems.forEach(item => {
            // Calculate commission per item for transparency
            // (You might want to fetch the product again or store commission in vendorCartMap)
        });

        // 4. Respond to Flutter
        res.json({
            totalSubtotal: parseFloat(totalSubtotal.toFixed(2)),
            totalShippingPrice: parseFloat(totalShippingPrice.toFixed(2)),
            originalShippingPrice: parseFloat(originalShippingPrice.toFixed(2)),
            subscriptionDeliveryDiscount: subscriptionDiscount.eligible
                ? parseFloat(subscriptionDiscount.discount.toFixed(2))
                : 0,
            subscriptionFreeDeliveryApplied: subscriptionDiscount.eligible,
            subscriptionPlanId: subscriptionDiscount.planId || '',
            totalPlatformFees: parseFloat(totalPlatformFees.toFixed(2)),
            totalPrice: parseFloat(totalPrice.toFixed(2)),
            taxPrice: req.body.taxPrice || 0.0,
            shipmentSummaries,
            deliveryFeePolicy: {
                fallbackRatePerKm: deliveryFeeSettings.fallbackRatePerKm,
                minimumDeliveryFee: deliveryFeeSettings.minimumDeliveryFee,
                matchedZone: matchedDeliveryZone
                    ? {
                        zoneKey: matchedDeliveryZone.zoneKey,
                        zoneName: matchedDeliveryZone.zoneName,
                        group: matchedDeliveryZone.group,
                        amount: matchedDeliveryZone.amount,
                    }
                    : null,
                subscription: {
                    eligible: subscriptionDiscount.eligible,
                    reason: subscriptionDiscount.reason,
                    planId: subscriptionDiscount.planId || '',
                    planName: subscriptionDiscount.planName || '',
                    deliveriesRemaining: subscriptionDiscount.deliveriesRemaining || 0,
                    discount: subscriptionDiscount.eligible
                        ? parseFloat(subscriptionDiscount.discount.toFixed(2))
                        : 0,
                },
            },
            userLocation, 
            shippingAddress,
            commissionSummary: {
                totalCommission: parseFloat(totalPlatformFees.toFixed(2)),
                averageRate: parseFloat((totalPlatformFees / totalSubtotal).toFixed(3)),
                note: 'Commission rates vary by product category (5% - 12%)'
            }
        });

    } catch (error) {
        console.error('Error calculating order summary:', error);
        res.status(500).json({ message: 'Error calculating order summary.', error: error.message });
    }
});

// ## Order Creation Route

// @desc    Create new MainOrder and associated Shipment documents
// @route   POST /api/orders
// @access  Private
router.post('/', protect, async (req, res) => {
    // ⚠️ We now receive the entire calculated summary from Flutter.
    const { 
        shippingAddress, 
        paymentMethod,
        totalSubtotal,
        totalShippingPrice,
        totalPlatformFees,
        totalPrice,
        taxPrice,
        userLocation,
        shipmentSummaries, // The calculated breakdown array is VITAL
        originalShippingPrice,
        subscriptionDeliveryDiscount,
        subscriptionFreeDeliveryApplied,
        subscriptionPlanId,
    } = req.body;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        if (!shipmentSummaries || shipmentSummaries.length === 0) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'No shipment summaries provided. Please calculate summary first.' });
        }

        // --- Step 1: Stock Check (Must check stock for ALL items across ALL shipments) ---
        const deliveryFeeSettings = await getDeliveryFeeSettings();
        let recalculatedSubtotal = 0;
        let recalculatedPlatformFees = 0;
        let recalculatedShippingPrice = 0;
        let recalculatedOriginalShippingPrice = 0;
        let matchedDeliveryZone = null;

        for (const summary of shipmentSummaries) {
            let summarySubtotal = 0;
            let summaryPlatformFee = 0;
            let summaryVendorLocation = summary.vendorLocation || {};
            let summaryVendorId = summary.vendor || summary.vendorId;
            if (!Array.isArray(summary.items) || summary.items.length === 0) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ message: 'Each shipment summary must include items.' });
            }

            for (const item of summary.items) {
                const product = await Product.findById(item.product)
                    .populate('vendor', 'businessName businessLocation operatingHours isTemporarilyClosed temporaryClosureReason deliveryRadiusKm prepTimeMinutes')
                    .session(session);
                if (!product) {
                    await session.abortTransaction();
                    session.endSession();
                    return res.status(404).json({ message: `Product not found: ${item.name}` });
                }
                if (product.stockQuantity < item.quantity) {
                    await session.abortTransaction();
                    session.endSession();
                    return res.status(400).json({ message: `Insufficient stock for ${product.name}. Available: ${product.stockQuantity}` });
                }
                if (isRestrictedMedicine(product)) {
                    await session.abortTransaction();
                    session.endSession();
                    return res.status(400).json({
                        message: `${product.name} requires pharmacist consultation before purchase.`
                    });
                }
                if (isRestaurantProduct(product) && !isWithinRestaurantOrderWindow(product)) {
                    await session.abortTransaction();
                    session.endSession();
                    return res.status(400).json({
                        message: `${product.name} can only be ordered from ${product.orderStartTime || '09:00'} to ${product.orderEndTime || '19:00'}.`
                    });
                }
                if (isRestaurantProduct(product)) {
                    const vendorHours = isWithinVendorOperatingHours(product.vendor || {});
                    if (!vendorHours.open) {
                        await session.abortTransaction();
                        session.endSession();
                        return res.status(400).json({
                            message: `${product.vendor?.businessName || product.restaurantName || 'This restaurant'} is not accepting orders now. ${vendorHours.reason}`
                        });
                    }

                    if (userLocation?.latitude && userLocation?.longitude && product.vendor?.businessLocation) {
                        const distance = calculateDistance(
                            userLocation.latitude,
                            userLocation.longitude,
                            product.vendor.businessLocation.latitude,
                            product.vendor.businessLocation.longitude
                        );
                        const radius = formatRadius(product.vendor.deliveryRadiusKm);
                        if (distance > radius) {
                            await session.abortTransaction();
                            session.endSession();
                            return res.status(400).json({
                                message: `${product.vendor?.businessName || product.restaurantName || 'This restaurant'} only delivers within ${radius} km.`
                            });
                        }
                    }
                }

                if (!summaryVendorLocation?.latitude && product.vendor?.businessLocation) {
                    summaryVendorLocation = product.vendor.businessLocation;
                }
                if (!summaryVendorId && product.vendor?._id) {
                    summaryVendorId = product.vendor._id;
                }

                const safeQuantity = Math.max(1, Number(item.quantity || 1));
                const commissionRate = getCommissionRateForCategory(product.category || 'Uncategorized');
                const itemSubtotal = Number(product.price || 0) * safeQuantity;
                const itemCommission = itemSubtotal * commissionRate;

                summarySubtotal += itemSubtotal;
                summaryPlatformFee += itemCommission;

                Object.assign(item, buildOrderItemFromProduct({ ...item, quantity: safeQuantity }, product), {
                    commissionRate,
                    itemCommission: parseFloat(itemCommission.toFixed(2)),
                });
            }

            const distanceKm =
                userLocation?.latitude &&
                userLocation?.longitude &&
                summaryVendorLocation?.latitude &&
                summaryVendorLocation?.longitude
                    ? calculateDistance(
                        summaryVendorLocation.latitude,
                        summaryVendorLocation.longitude,
                        userLocation.latitude,
                        userLocation.longitude,
                    )
                    : 0;

            const deliveryFeeQuote = buildDeliveryFeeQuote({
                shippingAddress,
                distanceKm,
                settings: deliveryFeeSettings,
            });
            const shippingPrice = deliveryFeeQuote.amount;
            matchedDeliveryZone = matchedDeliveryZone || deliveryFeeQuote.zone;

            summary.vendor = summaryVendorId;
            summary.vendorId = summaryVendorId;
            summary.vendorLocation = summaryVendorLocation;
            summary.subtotal = parseFloat(summarySubtotal.toFixed(2));
            summary.platformFee = parseFloat(summaryPlatformFee.toFixed(2));
            summary.commissionRate = summarySubtotal > 0
                ? parseFloat((summaryPlatformFee / summarySubtotal).toFixed(3))
                : 0;
            summary.shippingPrice = shippingPrice;
            summary.originalShippingPrice = shippingPrice;
            summary.subscriptionDeliveryDiscount = 0;
            summary.subscriptionFreeDeliveryApplied = false;
            summary.deliveryFeeSource = deliveryFeeQuote.source;
            summary.deliveryFeeZone = deliveryFeeQuote.zone;

            recalculatedSubtotal += summarySubtotal;
            recalculatedPlatformFees += summaryPlatformFee;
            recalculatedShippingPrice += shippingPrice;
            recalculatedOriginalShippingPrice += shippingPrice;
        }

        const buyerForSubscription = await User.findById(req.user._id)
            .select('naijagoSubscription')
            .session(session);
        const authoritativeSubscriptionDiscount = buildSubscriptionDeliveryDiscount({
            user: buyerForSubscription,
            totalSubtotal: recalculatedSubtotal,
            totalShippingPrice: recalculatedShippingPrice,
            matchedDeliveryZone,
            shippingAddress,
        });

        if (authoritativeSubscriptionDiscount.eligible) {
            recalculatedShippingPrice = 0;
            shipmentSummaries.forEach((summary) => {
                summary.subscriptionDeliveryDiscount = summary.originalShippingPrice;
                summary.subscriptionFreeDeliveryApplied = true;
                summary.shippingPrice = 0;
            });
        }

        const authoritativeTotalPrice = parseFloat((
            recalculatedSubtotal +
            recalculatedShippingPrice +
            Number(taxPrice || 0)
        ).toFixed(2));
        
        // --- Step 2: Create the MainOrder document (The Receipt) ---
        const mainOrder = new MainOrder({ // Use MainOrder model
            user: req.user._id,
            shippingAddress,
            userLocation,
            totalSubtotal: parseFloat(recalculatedSubtotal.toFixed(2)),
            totalPlatformFees: parseFloat(recalculatedPlatformFees.toFixed(2)),
            totalShippingPrice: parseFloat(recalculatedShippingPrice.toFixed(2)),
            originalShippingPrice: parseFloat(recalculatedOriginalShippingPrice.toFixed(2)),
            subscriptionDeliveryDiscount: authoritativeSubscriptionDiscount.eligible
                ? parseFloat(authoritativeSubscriptionDiscount.discount.toFixed(2))
                : 0,
            subscriptionFreeDeliveryApplied: authoritativeSubscriptionDiscount.eligible,
            subscriptionPlanId: authoritativeSubscriptionDiscount.planId || '',
            totalTaxPrice: taxPrice || 0.0,
            totalPrice: authoritativeTotalPrice,
            paymentMethod,
            isPaid: false, 
            mainOrderStatus: 'pending_payment',
            shipments: [], // Start empty, populate in next step
        });

        const createdMainOrder = await mainOrder.save({ session });
        
        const shipmentIds = [];
        
        // --- Step 3: Create Shipment documents for each vendor ---
        for (const summary of shipmentSummaries) {
            const summaryVendorId = summary.vendor || summary.vendorId;
            let vendorLocation = summary.vendorLocation || {};
            if (!vendorLocation.formattedAddress && summaryVendorId) {
                const vendorForZone = await User.findById(summaryVendorId)
                    .select('businessLocation')
                    .session(session)
                    .lean();
                if (vendorForZone?.businessLocation) {
                    vendorLocation = {
                        ...vendorForZone.businessLocation,
                        ...vendorLocation,
                        formattedAddress:
                            vendorLocation.formattedAddress ||
                            vendorForZone.businessLocation.formattedAddress,
                    };
                }
            }

            const newShipment = new Shipment({
                mainOrder: createdMainOrder._id,
                vendor: summaryVendorId,
                vendorLocation,
                items: summary.items.map(item => ({
                    product: item.product,
                    name: item.name,
                    image: item.image,
                    quantity: item.quantity,
                    price: item.price,
                    selectedSize: item.selectedSize || null,
                    category: item.category, // Store category
                    commissionRate: item.commissionRate, // Store individual item commission rate
                    restaurantName: item.restaurantName,
                    foodInformation: item.foodInformation,
                    foodCategory: item.foodCategory,
                    orderStartTime: item.orderStartTime,
                    orderEndTime: item.orderEndTime,
                    medicineAccess: item.medicineAccess,
                    isOverTheCounter: item.isOverTheCounter,
                    requiresPrescription: item.requiresPrescription,
                    requiresPharmacistApproval: item.requiresPharmacistApproval,
                })),
                subtotal: summary.subtotal,
                platformFee: summary.platformFee,
                shippingPrice: summary.shippingPrice,
                originalShippingPrice: summary.originalShippingPrice || summary.shippingPrice || 0,
                subscriptionDeliveryDiscount: summary.subscriptionDeliveryDiscount || 0,
                subscriptionFreeDeliveryApplied: summary.subscriptionFreeDeliveryApplied === true,
                commissionRate: summary.commissionRate, // Store average commission rate for this shipment
                shipmentStatus: 'processing',
                isDelivered: false,
            });

            const createdShipment = await newShipment.save({ session });
            shipmentIds.push(createdShipment._id);
        }
        
        // --- Step 4: Link Shipments back to the MainOrder ---
        createdMainOrder.shipments = shipmentIds;
        await createdMainOrder.save({ session });

        await session.commitTransaction();
        session.endSession();

        const foodItems = shipmentSummaries.flatMap((summary) =>
            (summary.items || []).filter((item) =>
                isRestaurantProduct({ category: item.category }) || item.restaurantName
            )
        );

        if (foodItems.length > 0) {
            trackAnalyticsEvent({
                eventType: 'food_order_created',
                user: req.user._id,
                source: 'checkout',
                targetType: 'order',
                targetId: createdMainOrder._id.toString(),
                metadata: {
                    orderId: createdMainOrder._id.toString(),
                    foodItemCount: foodItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
                    foodSubtotal: foodItems.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 0)), 0),
                    vendorCount: new Set(
                        shipmentSummaries
                            .filter((summary) => (summary.items || []).some((item) =>
                                isRestaurantProduct({ category: item.category }) || item.restaurantName
                            ))
                            .map((summary) => String(summary.vendor || ''))
                    ).size,
                    paymentMethod,
                },
            }).catch((error) => {
                console.error('Food order analytics failed:', error.message);
            });
        }

        // Return the MainOrder (with populated shipment IDs)
        res.status(201).json(createdMainOrder);

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error creating multi-vendor order:', error);
        res.status(500).json({ message: 'Server Error during order creation.', error: error.message });
    }
});

// ---

// ## Status Update, User, and Vendor Routes

// @desc    Update pending orders to processing after some time delay / server check
// @route   POST /api/orders/update-pending-to-processing
// @access  Private (called by client's polling timer)
router.post('/update-pending-to-processing', protect, async (req, res) => {
    try {
        // Logic now uses MainOrder and updates associated Shipments
        const mainOrdersResult = await MainOrder.updateMany(
            { 
                mainOrderStatus: 'pending_payment', 
                isPaid: true 
            },
            { $set: { mainOrderStatus: 'processing' } }
        );

        // This route is deprecated by the immediate update in the payment routes, but kept for legacy/polling cleanup.
        // It should update all associated Shipments to 'processing' as well.
        const ordersToUpdate = await MainOrder.find({ mainOrderStatus: 'processing', isPaid: true, shipments: { $ne: [] } }).select('shipments');
        const shipmentIds = ordersToUpdate.flatMap(order => order.shipments);

        const shipmentsResult = await Shipment.updateMany(
            { _id: { $in: shipmentIds }, shipmentStatus: 'awaiting_payment' },
            { $set: { shipmentStatus: 'processing' } }
        );

        res.json({ 
            message: `Successfully updated ${mainOrdersResult.modifiedCount} paid main orders to 'processing' and ${shipmentsResult.modifiedCount} shipments.`,
            count: mainOrdersResult.modifiedCount 
        });
    } catch (error) {
        console.error('Error updating pending orders:', error);
        res.status(500).json({ message: 'Server Error during pending order update' });
    }
});


// @desc    Get logged in user's orders (Now fetching MainOrders)
// @route   GET /api/orders/my
// @access  Private
router.get('/my', protect, async (req, res) => {
    try {
        // Fetch MainOrder and populate linked Shipments
        const orders = await MainOrder.find({ user: req.user.id })
            .populate({
                path: 'shipments',
                populate: [
                    { 
                        path: 'vendor', 
                        select: 'businessName businessLocation phoneNumber alternatePhoneNumber'
                    },
                    { 
                        path: 'items.product', 
                        select: 'name imageUrls price category' 
                    }
                ]
            })
            .populate('rider', 'fullName phoneNumber plateNumber currentLocation')
            .sort({ createdAt: -1 });
        
        // Add logging for debugging
        console.log(`User ${req.user.id} fetched ${orders.length} orders`);
        if (orders.length > 0 && orders[0].shipments && orders[0].shipments.length > 0) {
            const firstShipment = orders[0].shipments[0];
            if (firstShipment.items && firstShipment.items.length > 0) {
                console.log('First item in user order:', JSON.stringify(firstShipment.items[0], null, 2));
            }
        }
        
        res.json(orders);
    } catch (error) {
        console.error('Error fetching user orders:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});


// @desc    Get vendor-specific shipments
// @route   GET /api/orders/vendor
// @access  Private/Vendor
router.get('/vendor', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
    try {
        // Vendors now only care about their Shipments, not the entire MainOrder
        const shipments = await Shipment.find({ vendor: req.user.id })
            .populate({
                path: 'mainOrder',
                select: 'shippingAddress userLocation totalPrice totalShippingPrice paymentMethod createdAt rider mainOrderStatus pickupOTP riderPayoutAmount riderPayoutBreakdown payoutDetails',
                populate: [
                    {
                        path: 'user',
                        select: 'firstName lastName email phoneNumber'
                    },
                    {
                        path: 'rider',
                        select: 'fullName phoneNumber plateNumber'
                    }
                ]
            })
            .populate('vendor', 'businessName phoneNumber')
            .populate('rider', 'fullName phoneNumber plateNumber')
            .populate('items.product', 'name imageUrls price stockQuantity category')
            .sort({ createdAt: -1 });
        
        // Add logging to debug
        console.log(`Vendor ${req.user.id} fetched ${shipments.length} shipments`);
        if (shipments.length > 0 && shipments[0].items.length > 0) {
            console.log('First item in first shipment:', JSON.stringify(shipments[0].items[0], null, 2));
        }
        
        res.json(shipments);
    } catch (error) {
        console.error('Error fetching vendor orders:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});

async function findOwnedShipmentForVendor(req, res) {
    const shipment = await Shipment.findById(req.params.id);
    if (!shipment) {
        res.status(404).json({ message: 'Shipment not found.' });
        return null;
    }
    if (!req.user.isAdmin && shipment.vendor.toString() !== req.user.id.toString()) {
        res.status(403).json({ message: 'You can only update your own shipment.' });
        return null;
    }
    if (['delivered', 'cancelled', 'rejected', 'returned'].includes(shipment.shipmentStatus)) {
        res.status(400).json({ message: `Shipment is already ${shipment.shipmentStatus}.` });
        return null;
    }
    return shipment;
}

// @desc    Vendor accepts a paid shipment
// @route   PUT /api/orders/shipments/:id/accept
// @access  Private/Vendor/Admin
router.put('/shipments/:id/accept', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
    try {
        const shipment = await findOwnedShipmentForVendor(req, res);
        if (!shipment) return;

        shipment.shipmentStatus = 'accepted';
        shipment.acceptedAt = new Date();
        shipment.rejectionReason = undefined;
        await shipment.save();

        const mainOrder = await MainOrder.findById(shipment.mainOrder);
        if (mainOrder?.isPaid) {
            await notifyEligibleRidersForShipment({
                app: req.app,
                shipment,
                mainOrder,
                markReady: false,
            });
        }

        const io = req.app.get('io');
        if (io) {
            io.emit(`order_${shipment.mainOrder}`, {
                type: 'shipment_accepted',
                shipmentId: shipment._id,
                status: shipment.shipmentStatus,
                timestamp: Date.now(),
            });
        }

        res.status(200).json({ message: 'Shipment accepted.', shipment });
    } catch (error) {
        console.error('Error accepting shipment:', error);
        res.status(500).json({ message: 'Server error accepting shipment.' });
    }
});

// @desc    Vendor rejects a shipment with a reason
// @route   PUT /api/orders/shipments/:id/reject
// @access  Private/Vendor/Admin
router.put('/shipments/:id/reject', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
    try {
        const reason = String(req.body.reason || '').trim();
        if (reason.length < 5) {
            return res.status(400).json({ message: 'Please provide a clear rejection reason.' });
        }

        const shipment = await findOwnedShipmentForVendor(req, res);
        if (!shipment) return;

        shipment.shipmentStatus = 'rejected';
        shipment.rejectedAt = new Date();
        shipment.rejectionReason = reason.slice(0, 300);
        await shipment.save();

        const io = req.app.get('io');
        if (io) {
            io.emit(`order_${shipment.mainOrder}`, {
                type: 'shipment_rejected',
                shipmentId: shipment._id,
                reason: shipment.rejectionReason,
                status: shipment.shipmentStatus,
                timestamp: Date.now(),
            });
        }

        res.status(200).json({ message: 'Shipment rejected.', shipment });
    } catch (error) {
        console.error('Error rejecting shipment:', error);
        res.status(500).json({ message: 'Server error rejecting shipment.' });
    }
});

    // @desc    Get commission rates for different categories
    // @route   GET /api/orders/commission-rates
    // @access  Public
        router.get('/commission-rates', async (req, res) => {
        try {
            const commissionStructure = {};

            for (const [category, rate] of Object.entries(CATEGORY_COMMISSION_RATES)) {
                commissionStructure[category] = {
                    rate: rate * 100,
                    rateDecimal: rate
                };
            }

            res.json({
                success: true,
                commissionStructure,
                note: 'Commission rates are applied per product category',
                defaultRate: 0.08
            });
        } catch (error) {
            console.error('Error fetching commission rates:', error);
            res.status(500).json({
                success: false,
                message: 'Error fetching commission rates',
                error: error.message
            });
        }
    });
    // router.get('/commission-rates', async (req, res) => {
    //     try {
    //         const commissionStructure = {};
            
    //         // Transform the CATEGORY_COMMISSION_RATES for easier consumption
    //         for (const [tier, data] of Object.entries(CATEGORY_COMMISSION_RATES)) {
    //             commissionStructure[tier] = {
    //                 rate: data.rate * 100, // Convert to percentage
    //                 rateDecimal: data.rate,
    //                 description: getTierDescription(tier),
    //                 exampleCategories: data.categories.slice(0, 5) // Show first 5 examples
    //             };
    //         }
            
    //         res.json({
    //             success: true,
    //             commissionStructure,
    //             note: 'Commission rates are applied per product based on category',
    //             defaultRate: 0.125 // Default if category not found
    //         });
    //     } catch (error) {
    //         console.error('Error fetching commission rates:', error);
    //         res.status(500).json({ 
    //             success: false, 
    //             message: 'Error fetching commission rates', 
    //             error: error.message 
    //         });
    //     }
    // });

    // Helper function for tier descriptions
    function getTierDescription(tier) {
        switch(tier) {
            case 'high':
                return 'Luxury & High-margin items (Electronics, Luxury Fashion, etc.)';
            case 'medium':
                return 'Mid-range items (Regular Fashion, Home Goods, etc.)';
            case 'low':
                return 'Essentials & Low-margin items (Groceries, Medicine, Animal Feed, etc.)';
            default:
                return 'Standard items';
        }
    }


// ## Wallet Payment Route (Escrow)

// ## Wallet Payment Route (Escrow)
// @desc Update MainOrder/Shipments to paid + Debit User Wallet (NO IMMEDIATE VENDOR CREDIT)
// @route PUT /api/orders/:id/pay/wallet
// @access Private
router.put('/:id/pay/wallet', protect, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const mainOrder = await MainOrder.findById(req.params.id).session(session);
        if (!mainOrder) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Main Order not found' });
        }
        if (mainOrder.isPaid) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Order is already paid' });
        }
        // 1. Authorization check
        if (mainOrder.user.toString() !== req.user.id.toString()) {
            await session.abortTransaction();
            session.endSession();
            return res.status(401).json({ message: 'Not authorized to modify this order' });
        }
       
        // 2. Fetch the user (buyer) document within the transaction
        const buyer = await User.findById(req.user.id).session(session);
        if (!buyer) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Buyer user account not found.' });
        }
        // 3. Balance check
        const orderTotal = mainOrder.totalPrice;
        if (buyer.userWalletBalance < orderTotal) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                message: `Insufficient wallet balance. Required: ₦${orderTotal.toFixed(2)}, Available: ₦${buyer.userWalletBalance.toFixed(2)}`
            });
        }
       
        // 4. Debit the buyer's wallet and consume subscription delivery if used
        buyer.userWalletBalance = Number(((buyer.userWalletBalance || 0) - orderTotal).toFixed(2));
        await consumeSubscriptionDeliveryIfNeeded({ buyer, mainOrder, session });
        const updatedBuyer = await buyer.save({ session });
       
        // 5. Update MainOrder payment status
        mainOrder.isPaid = true;
        mainOrder.paidAt = Date.now();
        mainOrder.mainOrderStatus = 'processing';
        mainOrder.paymentResult = {
            id: 'WALLET-' + Date.now().toString(),
            status: 'successful',
            payment_type: 'Wallet Balance',
            amount: orderTotal,
            currency: 'NGN',
            email_address: buyer.email,
        };

        // Buyer notification (already existing)
        try {
            await notificationService.sendToUser(req.user.id.toString(), {
                title: 'Payment Successful!',
                message: `Your payment of ₦${orderTotal.toFixed(2)} was successful. Order #${mainOrder._id}`,
                data: {
                    type: 'payment_success',
                    orderId: mainOrder._id,
                    amount: orderTotal
                }
            });
        } catch (notifError) {
            console.error('Payment notification failed:', notifError);
        }

        // 6. Process shipments
        const shipments = await Shipment.find({ mainOrder: mainOrder._id }).session(session);
        const productUpdates = [];
        for (const shipment of shipments) {
            shipment.shipmentStatus = 'processing';
            await shipment.save({ session });

            await notifyVendorOfPaidShipment({
                app: req.app,
                order: mainOrder,
                shipment,
                paymentMethod: 'Wallet',
                session,
            });

            // Stock updates
            for (const item of shipment.items) {
                const soldCount = item.quantity;
                productUpdates.push(
                    Product.findByIdAndUpdate(
                        item.product,
                        { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
                        { new: true, session }
                    )
                );
            }
        }
        await Promise.all(productUpdates);
       
        const updatedOrder = await mainOrder.save({ session });
        await session.commitTransaction();
        session.endSession();

        try {
            await grantReferralRewardForVerifiedUser(req.user.id);
        } catch (referralError) {
            console.error('Referral reward processing error after wallet payment:', referralError);
        }

        res.json({
            ...updatedOrder.toObject(),
            newBuyerWalletBalance: updatedBuyer.userWalletBalance,
        });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error processing wallet payment for order:', error.message);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});

router.put('/:id/pay', protect, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        console.log(`[PAY ENDPOINT] Starting payment confirmation for order ID: ${req.params.id} | User: ${req.user.id}`);
        const mainOrder = await MainOrder.findById(req.params.id).session(session);
        if (!mainOrder) {
            console.error(`[PAY ENDPOINT] ERROR: Main Order not found - ID: ${req.params.id}`);
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Main Order not found' });
        }
        console.log(`[PAY ENDPOINT] Found order: ${mainOrder._id} | Current isPaid: ${mainOrder.isPaid} | Status: ${mainOrder.mainOrderStatus}`);
        if (mainOrder.isPaid) {
            console.warn(`[PAY ENDPOINT] WARNING: Order already paid - ID: ${mainOrder._id} | Paid at: ${mainOrder.paidAt}`);
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Order is already paid' });
        }
        if (mainOrder.user.toString() !== req.user.id.toString()) {
            console.error(`[PAY ENDPOINT] Unauthorized attempt - Order user: ${mainOrder.user} | Request user: ${req.user.id}`);
            await session.abortTransaction();
            session.endSession();
            return res.status(401).json({ message: 'Not authorized to modify this order' });
        }
        const buyer = await User.findById(req.user.id).session(session);
        if (!buyer) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Buyer user account not found.' });
        }
        const { transaction_id } = req.body;
        if (!transaction_id) {
            console.error(`[PAY ENDPOINT] Missing transaction_id - Order: ${mainOrder._id}`);
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Transaction ID is required' });
        }
        console.log(`[PAY ENDPOINT] Received tx_ref / transaction_id: ${transaction_id}`);
        // ────────────────────────────────────────────────────────────────
        // Idempotency check: prevent replay of same tx_ref on different orders
        // ────────────────────────────────────────────────────────────────
        const alreadyUsed = await MainOrder.findOne({
            'paymentResult.tx_ref': transaction_id,
            _id: { $ne: mainOrder._id } // allow retry on the same order
        }).select('_id paymentResult').session(session);
        if (alreadyUsed) {
            console.warn(`[PAY ENDPOINT] REPLAY DETECTED - tx_ref ${transaction_id} already used on order ${alreadyUsed._id}`);
            await session.abortTransaction();
            session.endSession();
            return res.status(409).json({
                message: 'This transaction reference has already been used on another order'
            });
        }
        console.log(`[PAY ENDPOINT] Idempotency check passed - no conflicting order found for tx_ref: ${transaction_id}`);
        // Verify payment with Flutterwave
        console.log(`[PAY ENDPOINT] Verifying transaction with Flutterwave: ${transaction_id}`);
        const flwResponse = await axios.get(
            `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${transaction_id}`,
            {
                headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` }
            }
        );
        const flwData = flwResponse.data;
        console.log(`[PAY ENDPOINT] Flutterwave verify response - Status: ${flwData.status} | Data status: ${flwData.data?.status} | Amount: ${flwData.data?.amount} | tx_ref: ${flwData.data?.tx_ref}`);
        if (flwData.status !== "success" || flwData.data.status !== "successful") {
            console.error(`[PAY ENDPOINT] VERIFICATION FAILED - Order: ${mainOrder._id} | tx_ref: ${transaction_id} | Flutterwave response:`, JSON.stringify(flwData, null, 2));
            await MainOrder.deleteOne({ _id: mainOrder._id }, { session });
            await Shipment.deleteMany({ mainOrder: mainOrder._id }, { session });
            await session.commitTransaction();
            session.endSession();
            return res.status(400).json({
                message: 'Payment verification failed and order has been removed.',
                flutterwave: flwData
            });
        }
        console.log(`[PAY ENDPOINT] VERIFICATION SUCCESS - tx_ref: ${transaction_id} | Amount: ${flwData.data.amount} NGN | Customer: ${flwData.data.customer.email}`);
        // Verified — update MainOrder
        mainOrder.isPaid = true;
        mainOrder.paidAt = Date.now();
        mainOrder.mainOrderStatus = 'processing';
        mainOrder.paymentResult = {
            id: flwData.data.id,
            status: flwData.data.status,
            tx_ref: flwData.data.tx_ref,
            flw_ref: flwData.data.flw_ref,
            amount: flwData.data.amount,
            currency: flwData.data.currency,
            email_address: flwData.data.customer.email,
            verifiedAt: new Date(),
            verificationMethod: 'direct_verify'
        };
        await consumeSubscriptionDeliveryIfNeeded({ buyer, mainOrder, session });
        console.log(`[PAY ENDPOINT] Updated paymentResult for order ${mainOrder._id}:`, JSON.stringify(mainOrder.paymentResult, null, 2));
        // Update shipments & stock
        const shipments = await Shipment.find({ mainOrder: mainOrder._id }).session(session);
        const productUpdates = [];
        console.log(`[PAY ENDPOINT] Found ${shipments.length} shipments for order ${mainOrder._id}`);
        for (const shipment of shipments) {
            shipment.shipmentStatus = 'processing';
            await shipment.save({ session });
            console.log(`[PAY ENDPOINT] Shipment ${shipment._id} → status set to 'processing'`);
            await notifyVendorOfPaidShipment({
                app: req.app,
                order: mainOrder,
                shipment,
                paymentMethod: 'Flutterwave',
                session,
            });
            console.log(`[PAY ENDPOINT] Vendor notification sent for shipment ${shipment._id}`);
            for (const item of shipment.items) {
                const soldCount = item.quantity;
                productUpdates.push(
                    Product.findByIdAndUpdate(
                        item.product,
                        { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
                        { new: true, session }
                    )
                );
            }
        }
        await Promise.all(productUpdates);
        console.log(`[PAY ENDPOINT] Stock updated for ${productUpdates.length} products`);
        const updatedOrder = await mainOrder.save({ session });
        await session.commitTransaction();
        session.endSession();

        try {
            await grantReferralRewardForVerifiedUser(req.user.id);
        } catch (referralError) {
            console.error('[PAY ENDPOINT] Referral reward processing error:', referralError);
        }

        console.log(`[PAY ENDPOINT] SUCCESS - Order ${mainOrder._id} marked as paid | Total: ₦${updatedOrder.totalPrice}`);
        res.json(updatedOrder);
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error(`[PAY ENDPOINT] CRITICAL ERROR for order ${req.params.id}:`, {
            message: error.message,
            stack: error.stack,
            flutterwaveError: error.response?.data || null
        });
        res.status(500).json({
            message: 'Server Error during payment confirmation',
            error: error.message
        });
    }
});

// ## Shipment Delivery and Vendor Payout Route (UPDATED)

// @desc     Mark a specific Shipment as delivered, update metrics (NO PAYOUT HERE)
// @route    PUT /api/orders/shipments/:id/deliver
// @access   Private/Admin/Vendor (Vendor can only mark their own shipments as delivered)
router.put('/shipments/:id/deliver', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
    const SHIPMENT_ID = req.params.id;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        // 1. Find the Shipment and ensure it's not already delivered
        const shipment = await Shipment.findById(SHIPMENT_ID).session(session);

        if (!shipment) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Shipment not found' });
        }

        if (shipment.isDelivered) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Shipment is already marked as delivered' });
        }
        
        // 2. Authorization: Vendor can only update their own shipments unless they are an admin
        if (!req.user.isAdmin && shipment.vendor.toString() !== req.user.id.toString()) {
            await session.abortTransaction();
            session.endSession();
            return res.status(401).json({ message: 'Not authorized to update this shipment' });
        }
        
        // 3. NO VENDOR CREDITING HERE - Only mark as delivered
        // Vendor will be credited when MainOrder is marked as 'completed' by admin
        
        // 4. Update the Shipment status
        shipment.isDelivered = true;
        shipment.deliveredAt = Date.now();
        shipment.shipmentStatus = 'delivered';

        const updatedShipment = await shipment.save({ session });
        
        // 5. Check if all Shipments in the MainOrder are now delivered
        const mainOrder = await MainOrder.findById(shipment.mainOrder).session(session);
        const pendingShipments = await Shipment.countDocuments({ 
            mainOrder: mainOrder._id, 
            isDelivered: false 
        }).session(session);

        if (pendingShipments === 0) {
            // All shipments for this MainOrder are delivered
            // Update status to 'delivered' but DON'T credit yet
            mainOrder.isDelivered = true;
            mainOrder.deliveredAt = Date.now();
            mainOrder.mainOrderStatus = 'delivered'; // Changed from 'completed' to 'delivered'
            await mainOrder.save({ session });
            
            // Send notification to admin that order is ready for completion/verification
            const adminUsers = await User.find({ role: 'admin' }).session(session);
            for (const admin of adminUsers) {
                await User.findByIdAndUpdate(
                    admin._id,
                    {
                        $push: {
                            notifications: {
                                type: 'order_ready_for_completion',
                                message: `Order ${mainOrder._id} has all shipments delivered and is ready for final verification and completion.`,
                                isRead: false,
                                relatedModel: 'MainOrder',
                                relatedId: mainOrder._id,
                            }
                        }
                    },
                    { new: true, session }
                );
            }
            
            // Emit socket notification
            const io = req.app.get('io');
            if (io) {
                io.emit('admin_notification', {
                    type: 'order_ready_for_completion',
                    message: `Order ${mainOrder._id} has all shipments delivered and is ready for final verification and completion.`,
                    orderId: mainOrder._id,
                    timestamp: Date.now()
                });
            }
        }

        await session.commitTransaction();
        session.endSession();

        res.json({
            message: `Shipment ${SHIPMENT_ID} marked as delivered. Order will be completed after admin verification.`,
            shipment: updatedShipment,
        });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error processing shipment delivery:', error.message);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});


router.put('/shipments/:id/status-update', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
    const { status } = req.body;
    const SHIPMENT_ID = req.params.id;

    const vendorStatuses = ['accepted', 'ready_for_pickup'];
    const adminStatuses = ['accepted', 'ready_for_pickup', 'out_for_delivery', 'returned', 'cancelled'];
    const validStatuses = req.user?.isAdmin ? adminStatuses : vendorStatuses;
    
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ 
            message: `Invalid or non-updatable shipment status provided. Must be one of: ${validStatuses.join(', ')}` 
        });
    }

    try {
        const shipment = await Shipment.findById(SHIPMENT_ID).populate('mainOrder');

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }

        if (!req.user.isAdmin && shipment.vendor.toString() !== req.user.id.toString()) {
            return res.status(403).json({ message: 'You can only update your own shipment.' });
        }
        
        // Prevent accidental updates if already delivered
        if (['delivered', 'rejected', 'returned'].includes(shipment.shipmentStatus)) {
            return res.status(400).json({ message: `Cannot update a shipment that is already ${shipment.shipmentStatus}.` });
        }

        if (req.user.isVendor && status === 'cancelled') {
            return res.status(400).json({ message: 'Use reject with reason if you cannot fulfil this shipment.' });
        }

        if (req.user.isVendor && ['out_for_delivery', 'delivered'].includes(status)) {
            return res.status(400).json({
                message: 'Rider pickup and delivery statuses are updated through rider OTP verification.'
            });
        }

        // Update the status
        shipment.shipmentStatus = status;
        await shipment.save();

        if (status === 'ready_for_pickup') {
            const mainOrderId = shipment.mainOrder?._id || shipment.mainOrder;
            const siblingShipments = await Shipment.find({
                mainOrder: mainOrderId,
                shipmentStatus: { $nin: ['rejected', 'cancelled', 'returned'] }
            }).select('shipmentStatus');
            const allFulfillableShipmentsReady = siblingShipments.length > 0 &&
                siblingShipments.every((item) => item.shipmentStatus === 'ready_for_pickup');

            const mainOrder = await MainOrder.findByIdAndUpdate(mainOrderId, {
                shipmentStatus: allFulfillableShipmentsReady ? 'ready_for_pickup' : 'processing',
                mainOrderStatus: 'processing'
            }, { new: true });

            const io = req.app.get('io');
            if (io) {
                io.emit('admin_notification', {
                    type: 'shipment_ready_for_pickup',
                    message: `Shipment ${shipment._id} is ready for rider pickup`,
                    shipmentId: shipment._id,
                    orderId: mainOrderId,
                    vendorId: shipment.vendor,
                    timestamp: Date.now()
                });
            }

            await notifyEligibleRidersForShipment({
                app: req.app,
                shipment,
                mainOrder: mainOrder || shipment.mainOrder,
            });
        }

        res.json({ message: `Shipment ${SHIPMENT_ID} status updated to ${status}.`, shipment });

    } catch (error) {
        console.error('Error during generic status update:', error);
        res.status(500).json({ message: 'Server Error during status update.', error: error.message });
    }
});


// @desc    Update order status by dispatch rider
// @route   PUT /api/orders/:id/dispatch-status
// @access  Private/Dispatch
router.put('/:id/dispatch-status', protect, authorizeRoles('dispatch', 'admin'), async (req, res) => {
    const { status } = req.body;
    
    if (!['shipped', 'delivered'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status provided.' });
    }

    try {
        const order = await Order.findById(req.params.id);

        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        if (status === 'shipped' && (order.orderStatus === 'pending' || order.orderStatus === 'processing')) {
            order.orderStatus = status;
        } else if (status === 'delivered' && order.orderStatus === 'shipped') {
            order.orderStatus = status;
            order.isDelivered = true;
            order.deliveredAt = Date.now();
        } else {
            return res.status(400).json({ message: 'Invalid status transition.' });
        }

        const updatedOrder = await order.save();
        res.json(updatedOrder);
    } catch (error) {
        console.error('Error updating order status:', error);
        if (error.kind === 'ObjectId') {
            return res.status(400).json({ message: 'Invalid Order ID format' });
        }
        res.status(500).json({ message: 'Server Error' });
    }
});



router.put('/:id/status', protect, authorizeRoles('admin'), async (req, res) => {
    const { status } = req.body;
    const MAIN_ORDER_ID = req.params.id;
    let mainOrder;
    let updatedMainOrder;
    let payoutSummary = null;

    const validStatuses = [
        'pending_payment',
        'processing',
        'partially_shipped',
        'shipped',
        'out_for_delivery',
        'delivered',
        'completed',
        'cancelled'
    ];

    if (!validStatuses.includes(status)) {
        return res.status(400).json({
            message: `Invalid main order status: ${status}. Must be one of: ${validStatuses.join(', ')}`
        });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        mainOrder = await MainOrder.findById(MAIN_ORDER_ID).session(session);
        if (!mainOrder) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Main Order not found.' });
        }

        // Allow a completed order to repair a missing rider payout once, but
        // block true duplicate completion.
        if (status === 'completed' && mainOrder.mainOrderStatus === 'completed') {
            if (!mainOrder.riderPaidAt) {
                const shipments = await Shipment.find({ mainOrder: MAIN_ORDER_ID }).session(session);
                const riderPayout = await creditRiderForCompletedOrder({
                    mainOrder,
                    shipments,
                    session,
                    updateDeliveryStats: true,
                });
                await mainOrder.save({ session });
                await session.commitTransaction();
                session.endSession();

                return res.json({
                    message: `Rider payout repaired for completed order ${MAIN_ORDER_ID}.`,
                    order: mainOrder,
                    payoutSummary: {
                        totalRiderPayout: riderPayout.amount,
                        riderPayoutBreakdown: riderPayout.breakdown || mainOrder.riderPayoutBreakdown,
                        payoutDate: mainOrder.riderPaidAt,
                    },
                });
            }

            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                message: 'Order already marked as completed and credited. No further action allowed.'
            });
        }

        // Update the status
        mainOrder.mainOrderStatus = status;

        if (status === 'processing') {
            mainOrder.shipmentStatus = 'processing';
            await Shipment.updateMany(
                {
                    mainOrder: MAIN_ORDER_ID,
                    shipmentStatus: { $nin: ['delivered', 'cancelled', 'returned'] }
                },
                { $set: { shipmentStatus: 'processing' } },
                { session }
            );
        } else if (status === 'out_for_delivery') {
            mainOrder.shipmentStatus = 'out_for_delivery';
            await Shipment.updateMany(
                {
                    mainOrder: MAIN_ORDER_ID,
                    shipmentStatus: { $nin: ['delivered', 'cancelled', 'returned'] }
                },
                { $set: { shipmentStatus: 'out_for_delivery' } },
                { session }
            );
        } else if (status === 'cancelled') {
            mainOrder.shipmentStatus = 'cancelled';
            await Shipment.updateMany(
                {
                    mainOrder: MAIN_ORDER_ID,
                    shipmentStatus: { $nin: ['delivered', 'cancelled', 'returned'] }
                },
                { $set: { shipmentStatus: 'cancelled' } },
                { session }
            );
        } else if (status === 'delivered') {
            mainOrder.isDelivered = true;
            mainOrder.deliveredAt = Date.now();
            mainOrder.shipmentStatus = 'delivered';
            await Shipment.updateMany(
                { mainOrder: MAIN_ORDER_ID, isDelivered: { $ne: true } },
                {
                    $set: {
                        shipmentStatus: 'delivered',
                        isDelivered: true,
                        deliveredAt: new Date()
                    }
                },
                { session }
            );
        }

        // SIMULTANEOUS PAYOUT + NOTIFICATION LOGIC WHEN STATUS IS 'completed'
        if (status === 'completed') {
            mainOrder.isDelivered = true;
            mainOrder.deliveredAt = Date.now();
            mainOrder.shipmentStatus = 'delivered';
            mainOrder.vendorPaidAt = Date.now();

            if (mainOrder.isPaid) {
                const shipments = await Shipment.find({ mainOrder: MAIN_ORDER_ID }).session(session);

                let totalRiderPayout = 0;
                let totalVendorPayout = 0;
                let totalCompanySettlement = 0;
                let payoutDetails = [];

                const riderPayout = await creditRiderForCompletedOrder({
                    mainOrder,
                    shipments,
                    session,
                    updateDeliveryStats: mainOrder.riderPaidAt ? false : true,
                });
                totalRiderPayout = riderPayout.amount;

                for (const shipment of shipments) {
                    const vendorEarning = shipment.subtotal - shipment.platformFee;
                    totalVendorPayout += vendorEarning;

                    const riderPayoutBreakdownPerShipment = calculateShipmentRiderEarningBreakdown(shipment, mainOrder);
                    const riderPayoutPerShipment = riderPayoutBreakdownPerShipment.amount;
                    let companySettlementPerShipment = 0;

                    if (shipment.vendorLocation && mainOrder.userLocation) {
                        const distance = calculateDistance(
                            shipment.vendorLocation.latitude,
                            shipment.vendorLocation.longitude,
                            mainOrder.userLocation.latitude,
                            mainOrder.userLocation.longitude
                        );

                        companySettlementPerShipment = distance * 150;
                        totalCompanySettlement += companySettlementPerShipment;

                    }

                    // Credit vendor
                    const updatedVendor = await User.findByIdAndUpdate(
                        shipment.vendor,
                        {
                            $inc: { vendorWalletBalance: vendorEarning },
                            $push: {
                                notifications: {
                                    $each: [{
                                        type: 'delivery_payout',
                                        message: `Payout of ₦${vendorEarning.toFixed(2)} received for completed order ${mainOrder._id}. Platform Fee: ₦${shipment.platformFee.toFixed(2)}.`,
                                        isRead: false,
                                        relatedModel: 'MainOrder',
                                        relatedId: mainOrder._id,
                                    }],
                                    $position: 0,
                                },
                            },
                        },
                        { new: true, session }
                    );

                    // ───────────────────────────────────────────────────────────────
                    //                SEND ONESIGNAL NOTIFICATION TO VENDOR
                    // ───────────────────────────────────────────────────────────────
                    try {
                        await notificationService.sendToUser(
                            shipment.vendor.toString(),
                            {
                                title: "🎉 Order Completed",
                                message: `Order #${mainOrder._id.toString().slice(-8)} has been marked as completed. Thank you for your service!`,
                                data: {
                                    type: "order_completed_vendor",
                                    orderId: mainOrder._id.toString(),
                                    status: "completed",
                                    completedAt: new Date().toISOString(),
                                }
                            }
                        );
                    } catch (notifyError) {
                        console.error(`Failed to send completion notification to vendor ${shipment.vendor}:`, notifyError);
                        // Do NOT throw - we don't want to rollback the whole payout
                    }
                    // ───────────────────────────────────────────────────────────────

                    payoutDetails.push({
                        vendorId: shipment.vendor,
                        vendorName: updatedVendor?.businessName || 'Unknown Vendor',
                        vendorPayout: vendorEarning,
                        shipmentId: shipment._id,
                        distance: riderPayoutBreakdownPerShipment.distanceKm,
                        riderRatePerKm: riderPayoutBreakdownPerShipment.ratePerKm,
                        riderPayoutMethod: riderPayoutBreakdownPerShipment.method,
                        riderPayout: riderPayoutPerShipment,
                        riderPayoutBreakdown: riderPayoutBreakdownPerShipment,
                        companySettlement: companySettlementPerShipment
                    });

                    if (!shipment.isDelivered) {
                        shipment.shipmentStatus = 'delivered';
                        shipment.isDelivered = true;
                        shipment.deliveredAt = Date.now();
                        await shipment.save({ session });
                    }
                }

                mainOrder.companySettlementEarnings = totalCompanySettlement;
                mainOrder.companySettlementStatus = 'unpaid';

                mainOrder.payoutDetails = {
                    totalVendorPayout,
                    totalRiderPayout,
                    totalCompanySettlement,
                    payoutDate: Date.now(),
                        details: payoutDetails
                };

                payoutSummary = {
                    totalVendorPayout,
                    totalRiderPayout,
                    riderPayoutBreakdown: riderPayout.breakdown || mainOrder.riderPayoutBreakdown,
                    totalCompanySettlement,
                    payoutDate: mainOrder.payoutDetails.payoutDate
                };
            }
        }

        updatedMainOrder = await mainOrder.save({ session });
        await session.commitTransaction();
        session.endSession();

        const emitOrderUpdate = req.app.get('emitOrderUpdate');
        if (typeof emitOrderUpdate === 'function') {
            emitOrderUpdate(MAIN_ORDER_ID, {
                orderId: MAIN_ORDER_ID,
                status,
                shipmentStatus: updatedMainOrder.shipmentStatus,
                deliveredAt: updatedMainOrder.deliveredAt,
                vendorPaidAt: updatedMainOrder.vendorPaidAt,
                isPaid: updatedMainOrder.isPaid,
                updatedAt: updatedMainOrder.updatedAt,
                message: `Order status updated to ${status.replace(/_/g, ' ')}.`,
            });
        }

        res.json({
            message: `Main Order ${MAIN_ORDER_ID} status updated to ${status}.${status === 'completed' ? ' Vendors and rider paid.' : ''}`,
            order: updatedMainOrder,
            ...(status === 'completed' && payoutSummary ? { payoutSummary } : {})
        });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error updating main order status:', error);
        res.status(500).json({ message: 'Server Error during main order status update.', error: error.message });
        return;
    }

    // Optional: Send notification to buyer about status change
    try {
        let title, message;
        switch(status) {
            case 'processing':
                title = 'Order Processing';
                message = `Order #${MAIN_ORDER_ID} is now being processed by our vendors.`;
                break;
            case 'shipped':
                title = 'Order Shipped!';
                message = `Your order #${MAIN_ORDER_ID} has been shipped. Track your delivery in the app.`;
                break;
            case 'partially_shipped':
                title = 'Order Update';
                message = `Part of your order #${MAIN_ORDER_ID} has moved forward in fulfilment.`;
                break;
            case 'out_for_delivery':
                title = 'Out for Delivery';
                message = `Your order #${MAIN_ORDER_ID} is currently out for delivery.`;
                break;
            case 'delivered':
                title = 'Order Delivered!';
                message = `Your order #${MAIN_ORDER_ID} has been delivered. Please confirm receipt.`;
                break;
            case 'completed':
                title = 'Order Completed';
                message = `Order #${MAIN_ORDER_ID} is now complete. Thank you for shopping with us!`;
                break;
            case 'cancelled':
                title = 'Order Cancelled';
                message = `Your order #${MAIN_ORDER_ID} has been cancelled.`;
                break;
        }

        if (title && message && mainOrder.user) {
            await notificationService.sendToUser(mainOrder.user.toString(), {
                title,
                message,
                data: {
                    type: 'order_update',
                    orderId: MAIN_ORDER_ID,
                    status: status
                }
            });
        }
    } catch (notifError) {
        console.error('Buyer status notification failed:', notifError);
    }
});

// @desc    All orders for Admin
// @route   GET /api/orders/admin
// @access  Private/Admin
router.get('/admin', protect, authorizeRoles('admin'), async (req, res) => {
    try {
        const { limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 300 });
        const orders = await MainOrder.find({})
            .populate('user', 'firstName lastName email phoneNumber')
            .populate('rider', 'fullName phoneNumber plateNumber vehicleType currentLocation lastActive isAvailable isActive')
            .populate('assignedRider', 'fullName phoneNumber plateNumber vehicleType currentLocation lastActive isAvailable isActive')
            .populate('company', 'companyName name phoneNumber contactPhone')
            .populate({
                path: 'shipments',
                populate: [
                    { path: 'vendor', select: 'businessName phoneNumber' },
                    { path: 'rider', select: 'fullName phoneNumber plateNumber vehicleType currentLocation lastActive isAvailable isActive' },
                    { path: 'assignedRider', select: 'fullName phoneNumber plateNumber vehicleType currentLocation lastActive isAvailable isActive' },
                    { path: 'company', select: 'companyName name phoneNumber contactPhone' },
                    { path: 'items.product', select: 'name imageUrls price stockQuantity' }
                ]
            })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const orderIds = orders.map((order) => order._id);
        const companyDeliveries = await CompanyDelivery.find({
            mainOrder: { $in: orderIds },
        })
            .populate('company', 'companyName name phoneNumber contactPhone')
            .populate('rider', 'fullName phoneNumber plateNumber riderId')
            .lean();

        const companyDeliveriesByOrder = companyDeliveries.reduce((acc, delivery) => {
            const orderId = delivery.mainOrder?.toString();
            if (!orderId) return acc;
            if (!acc[orderId]) acc[orderId] = [];
            acc[orderId].push(delivery);
            return acc;
        }, {});

        orders.forEach((order) => {
            order.companyDeliveries = companyDeliveriesByOrder[order._id.toString()] || [];
        });

        res.json(orders);
    } catch (error) {
        console.error('Error fetching all orders for admin:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @desc    Customer-safe rider tracking for an order
// @route   GET /api/orders/:id/rider-location
// @access  Private/Owner/Admin
router.get('/:id/rider-location', protect, async (req, res) => {
    try {
        const order = await MainOrder.findById(req.params.id)
            .populate('rider', 'fullName phoneNumber plateNumber vehicleType currentLocation lastActive isAvailable isActive')
            .populate({
                path: 'shipments',
                select: 'vendor vendorLocation shippingPrice subtotal platformFee',
                populate: {
                    path: 'vendor',
                    select: 'businessName businessLocation phoneNumber'
                }
            })
            .lean();

        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        const isOwner = order.user?.toString() === req.user.id.toString();
        const isAdmin = req.user.isAdmin || req.user.role === 'admin';

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ message: 'Not authorized to track this order' });
        }

        const trackingAvailable = isRiderTrackingVisible(order);
        const payoutBreakdown =
            order.riderPayoutBreakdown ||
            calculateOrderRiderEarningsBreakdown({
                mainOrder: order,
                shipments: order.shipments || [],
            });

        if (!trackingAvailable) {
            return res.json({
                success: true,
                trackingAvailable: false,
                stage: order.isClaimed ? 'accepted' : 'awaiting_rider',
                message: order.rider
                    ? 'Rider tracking will appear when this delivery is active.'
                    : 'A rider has not accepted this order yet.',
                orderId: order._id,
                riderPayout: {
                    amount: order.riderPayoutAmount || payoutBreakdown.amount,
                    distanceKm: payoutBreakdown.totalDistanceKm,
                    ratePerKm: payoutBreakdown.ratePerKm,
                    breakdown: payoutBreakdown,
                },
            });
        }

        const rider = order.rider || {};
        const location = rider.currentLocation || {};
        const lastUpdated = location.lastUpdated || rider.lastActive || null;
        const staleMs = Number(process.env.CUSTOMER_TRACKING_STALE_SECONDS || 180) * 1000;
        const isStale = !lastUpdated || Date.now() - new Date(lastUpdated).getTime() > staleMs;
        const stage =
            order.shipmentStatus === 'out_for_delivery' || order.mainOrderStatus === 'out_for_delivery'
                ? 'after_pickup'
                : 'accepted';

        res.json({
            success: true,
            trackingAvailable: true,
            stage,
            orderId: order._id,
            shipmentStatus: order.shipmentStatus,
            mainOrderStatus: order.mainOrderStatus,
            rider: {
                _id: rider._id,
                fullName: rider.fullName,
                phoneNumber: rider.phoneNumber,
                plateNumber: rider.plateNumber,
                vehicleType: rider.vehicleType,
                isOnline: rider.isAvailable === true && rider.isActive === true,
                currentLocation: {
                    lat: location.lat ?? null,
                    lng: location.lng ?? null,
                    address: location.address || '',
                    lastUpdated,
                    lastSeenLabel: formatLastSeen(lastUpdated),
                    isStale,
                },
            },
            riderPayout: {
                amount: order.riderPayoutAmount || payoutBreakdown.amount,
                distanceKm: payoutBreakdown.totalDistanceKm,
                ratePerKm: payoutBreakdown.ratePerKm,
                breakdown: payoutBreakdown,
            },
        });
    } catch (error) {
        console.error('Error fetching customer rider tracking:', error);
        if (error.kind === 'ObjectId') {
            return res.status(400).json({ message: 'Invalid Order ID format' });
        }
        res.status(500).json({ message: 'Server Error' });
    }
});


// @desc    Get single order by ID
// @route   GET /api/orders/:id
// @access  Private
router.get('/:id', protect, async (req, res) => {
    try {
        const order = await MainOrder.findById(req.params.id)
            .populate('user', 'firstName lastName email phoneNumber')
            .populate('rider', 'fullName phoneNumber plateNumber')
            .populate({
                path: 'shipments',
                populate: [
                    { path: 'vendor', select: 'businessName phoneNumber' },
                    { path: 'items.product', select: 'name imageUrls price stockQuantity' }
                ]
            });

        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        const isOwner = order.user.toString() === req.user.id.toString();
        const isAdmin = req.user.isAdmin;
        const isDispatchRider = req.user.role === 'dispatch';
        const isVendor = order.shipments?.some(shipment =>
            shipment.vendor && shipment.vendor._id.toString() === req.user.id.toString()
        );

        if (!isOwner && !isAdmin && !isDispatchRider && !isVendor) {
            return res.status(401).json({ message: 'Not authorized to view this order' });
        }
        
        const payload = order.toObject();
        if (!isOwner && !isAdmin) {
            delete payload.deliveryOTP;
            delete payload.pickupOTP;
        }

        res.json(payload);
    } catch (error) {
        console.error('Error fetching single order:', error);
        if (error.kind === 'ObjectId') {
            return res.status(400).json({ message: 'Invalid Order ID format' });
        }
        res.status(500).json({ message: 'Server Error' });
    }
});


router.post('/webhooks/flutterwave', async (req, res) => {
  // 1. Verify signature (Flutterwave sends this header)
  const secretHash = req.headers['verif-hash'];
  if (!secretHash || secretHash !== process.env.FLUTTERWAVE_WEBHOOK_SECRET) {
    console.warn('Invalid Flutterwave webhook signature');
    return res.status(401).send('Signature mismatch');
  }

  const event = req.body;

  // We only care about successful charge completions
  if (event.event !== 'charge.completed' || !event.data) {
    return res.sendStatus(200); // acknowledge but ignore
  }

  const tx = event.data;

  if (tx.status !== 'successful') {
    console.log(`Webhook: non-successful charge → ${tx.status} for tx_ref ${tx.tx_ref}`);
    return res.sendStatus(200);
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Find the order by the tx_ref we generated client-side
    const order = await MainOrder.findOne({
      'paymentResult.tx_ref': tx.tx_ref,
      isPaid: false   // only process if not already marked paid
    }).session(session);

    if (!order) {
      console.log(`Webhook: No matching unpaid order found for tx_ref ${tx.tx_ref}`);
      await session.commitTransaction();
      return res.sendStatus(200);
    }

    // Mark as paid
    order.isPaid = true;
    order.paidAt = new Date();
    order.mainOrderStatus = 'processing';
    order.paymentResult = {
      ...order.paymentResult,
      id: tx.id,
      status: tx.status,
      tx_ref: tx.tx_ref,
      flw_ref: tx.flw_ref,
      amount: tx.amount,
      currency: tx.currency,
      email_address: tx.customer?.email,
      verifiedVia: 'webhook'
    };

    // Update shipments + reduce stock
    const shipments = await Shipment.find({ mainOrder: order._id }).session(session);
    const productUpdates = [];

    for (const shipment of shipments) {
      shipment.shipmentStatus = 'processing';
      await shipment.save({ session });

      await notifyVendorOfPaidShipment({
        app: req.app,
        order,
        shipment,
        paymentMethod: 'Flutterwave',
        session,
      });

      for (const item of shipment.items) {
        productUpdates.push(
          Product.findByIdAndUpdate(
            item.product,
            { $inc: { salesCount: item.quantity, stockQuantity: -item.quantity } },
            { new: true, session }
          )
        );
      }
    }

    await Promise.all(productUpdates);
    await order.save({ session });

    await session.commitTransaction();
    console.log(`Webhook success: Order ${order._id} marked paid via webhook (tx_ref: ${tx.tx_ref})`);

    try {
      await grantReferralRewardForVerifiedUser(order.user);
    } catch (referralError) {
      console.error('Webhook referral reward processing error:', referralError);
    }

    res.sendStatus(200);
  } catch (err) {
    await session.abortTransaction();
    console.error('Webhook processing error:', err);
    res.status(500).send('Internal error');
  } finally {
    session.endSession();
  }
});



module.exports = router;
