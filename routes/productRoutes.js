// routes/productRoutes.js

const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const User = require('../models/User');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const multer = require('multer');
const cloudinary = require('../utils/cloudinary');
const path = require('path');

// =============================================================
// MULTER CONFIG (MEMORY STORAGE)
// =============================================================
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const isImage = file.mimetype.startsWith('image/');
        const isOctetAndImageExt =
            file.mimetype === 'application/octet-stream' &&
            ['.jpg', '.jpeg', '.png', '.gif'].includes(
                path.extname(file.originalname).toLowerCase()
            );

        if (isImage || isOctetAndImageExt) cb(null, true);
        else cb(new Error('Only image files allowed!'), false);
    },
});

// =============================================================
// UPDATED MULTIPLE IMAGE UPLOAD FORMAT
// =============================================================
// Accept:
//  mainImage → 1 file
//  extraImages → up to 10 files (front, back, side, etc.)
const multiUpload = upload.fields([
    { name: 'mainImage', maxCount: 1 },
    { name: 'extraImages', maxCount: 10 },
]);

const vendorPopulateFields = 'businessName businessLocation phoneNumber businessLogoUrl businessWhatsAppNumber businessSupportPhone deliveryRadiusKm prepTimeMinutes isTemporarilyClosed temporaryClosureReason operatingHours';

const parsePagination = (query, defaults = {}) => {
    const maxLimit = defaults.maxLimit || 100;
    const defaultLimit = defaults.defaultLimit || 50;
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const requestedLimit = parseInt(query.limit, 10) || defaultLimit;
    const limit = Math.min(Math.max(requestedLimit, 1), maxLimit);
    return { page, limit, skip: (page - 1) * limit };
};

const isMedicineCategory = (category = '') => {
    const normalized = String(category).toLowerCase();
    return normalized.includes('medicine') ||
        normalized.includes('pharmacy') ||
        normalized.includes('drug');
};

const isRestaurantCategory = (category = '') => {
    const normalized = String(category).toLowerCase();
    if (normalized.includes('restaurant equipment')) return false;
    return normalized === 'restaurant' ||
        normalized.startsWith('restaurant >') ||
        normalized.includes('meal') ||
        normalized.includes('fast food') ||
        normalized.includes('local dishes') ||
        normalized.includes('pastries') ||
        normalized.includes('drinks') ||
        normalized.includes('catering');
};

const requiresProductModeration = (category = '') =>
    isRestaurantCategory(category) || isMedicineCategory(category);

const toBoolean = (value) => value === true || value === 'true' || value === '1';

const normalizeTime = (value, fallback) => {
    const raw = typeof value === 'string' ? value.trim() : '';
    return /^\d{2}:\d{2}$/.test(raw) ? raw : fallback;
};

const normalizeFoodCategory = (value, category = '') => {
    const raw = String(value || '').trim();
    if (raw) return raw;

    const parts = String(category || '').split('>');
    const subcategory = parts.length > 1 ? parts[parts.length - 1].trim() : '';
    if (subcategory && subcategory.toLowerCase() !== 'restaurant') {
        return subcategory;
    }

    return 'Meals';
};

const deriveFoodCategory = (product = {}) => {
    const explicit = normalizeFoodCategory(product.foodCategory, product.category);
    if (explicit && explicit !== 'Meals') return explicit;

    const source = [
        product.name,
        product.category,
        product.description,
        product.foodInformation,
        product.restaurantName,
    ].filter(Boolean).join(' ').toLowerCase();

    const mapped = [
        ['Rice', ['rice', 'jollof', 'fried rice', 'ofada']],
        ['Swallow', ['swallow', 'eba', 'amala', 'fufu', 'pounded yam', 'semo']],
        ['Soups', ['soup', 'egusi', 'ogbono', 'okra', 'banga', 'afang']],
        ['Grills', ['grill', 'suya', 'barbecue', 'bbq', 'shawarma']],
        ['Breakfast', ['breakfast', 'tea', 'coffee', 'akara', 'pap']],
        ['Pastries', ['pastry', 'pastries', 'meat pie', 'doughnut', 'cake']],
        ['Drinks', ['drink', 'juice', 'smoothie', 'water', 'soda']],
        ['Snacks', ['snack', 'small chops', 'chips', 'burger']],
        ['Seafood', ['fish', 'seafood', 'prawn', 'shrimp']],
    ];

    return mapped.find(([, keywords]) => keywords.some((keyword) => source.includes(keyword)))?.[0] || explicit;
};

const buildProductLocation = (body = {}) => {
    const formattedAddress = String(
        body.productLocationAddress ||
        body.pickupLocationAddress ||
        ''
    ).trim();
    const latitude = Number(body.productLatitude ?? body.pickupLatitude);
    const longitude = Number(body.productLongitude ?? body.pickupLongitude);

    if (!formattedAddress && !Number.isFinite(latitude) && !Number.isFinite(longitude)) {
        return undefined;
    }

    return {
        formattedAddress,
        latitude: Number.isFinite(latitude) ? latitude : undefined,
        longitude: Number.isFinite(longitude) ? longitude : undefined,
    };
};

const resolveProductLocation = (product) => {
    return product.productLocation?.latitude && product.productLocation?.longitude
        ? product.productLocation
        : product.vendor?.businessLocation;
};

const buildCategoryFilter = (category) => {
    if (!category) return {};
    if (String(category).toLowerCase() === 'restaurant') {
        return {
            category: {
                $regex: /^(restaurant($| >)|.*\b(meal|fast food|local dishes|pastries|drinks|catering)\b.*)/i,
            },
        };
    }
    return { category: { $regex: new RegExp(`^${escapeRegex(category)}$`, 'i') } };
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const distanceKm = (lat1, lon1, lat2, lon2) => {
    const toRad = (degrees) => degrees * Math.PI / 180;
    const earthRadiusKm = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const minutesFromTime = (value, fallback = null) => {
    if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return fallback;
    const [hours, minutes] = value.split(':').map(Number);
    return (hours * 60) + minutes;
};

const isWithinWindow = (currentMinutes, start, end) => {
    const startMinutes = minutesFromTime(start, 0);
    const endMinutes = minutesFromTime(end, 1439);
    if (startMinutes <= endMinutes) {
        return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    }
    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
};

const isRestaurantProductOpenNow = (product, now = new Date()) => {
    if (product.vendor?.isTemporarilyClosed) return false;

    const currentMinutes = (now.getHours() * 60) + now.getMinutes();
    const day = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const vendorHours = Array.isArray(product.vendor?.operatingHours)
        ? product.vendor.operatingHours.find((entry) => entry.day === day)
        : null;

    if (vendorHours) {
        if (vendorHours.isOpen === false) return false;
        const lastOrderTime = vendorHours.lastOrderTime || vendorHours.closeTime;
        if (!isWithinWindow(currentMinutes, vendorHours.openTime, lastOrderTime)) {
            return false;
        }
    }

    return isWithinWindow(
        currentMinutes,
        product.orderStartTime || '09:00',
        product.orderEndTime || '19:00'
    );
};

const restaurantMealKeywords = {
    breakfast: ['breakfast', 'tea', 'coffee', 'pap', 'akara', 'bread', 'yam', 'egg'],
    lunch: ['lunch', 'rice', 'swallow', 'meal', 'beans', 'spaghetti', 'jollof'],
    dinner: ['dinner', 'grill', 'soup', 'pepper soup', 'shawarma', 'suya'],
};

const matchesRestaurantMeal = (product, mealType = '') => {
    const keywords = restaurantMealKeywords[String(mealType).toLowerCase()];
    if (!keywords) return true;

    const source = [
        product.name,
        product.category,
        product.description,
        product.foodInformation,
        product.restaurantName,
    ].filter(Boolean).join(' ').toLowerCase();

    return keywords.some((keyword) => source.includes(keyword));
};

// =============================================================
// CREATE PRODUCT (UPDATED FOR SIZE DATA)
// =============================================================

router.post(
    '/',
    protect,
    authorizeRoles('vendor'),
    multiUpload,
    async (req, res) => {
        console.log('POST /api/products hit');

        const { 
            name, 
            description, 
            price, 
            category, 
            stockQuantity, 
            is_flashsale,
            restaurantName,
            foodInformation,
            orderStartTime,
            orderEndTime,
            foodCategory,
            medicineAccess,
            isOverTheCounter,
            requiresPrescription,
            requiresPharmacistApproval,
            size_data // NEW: Size data from Flutter
        } = req.body;

        if (!name || !description || !price || !category || !stockQuantity) {
            return res.status(400).json({
                message:
                    'Please enter all product details (name, description, price, category, stock quantity).',
            });
        }

        try {
            const vendor = await User.findById(req.user._id);
            if (!vendor || !vendor.isVendor || vendor.vendorStatus !== 'approved') {
                return res.status(403).json({
                    message: 'Only approved vendors can add products.',
                });
            }

            if (isMedicineCategory(category) && vendor.role !== 'pharmacist') {
                return res.status(403).json({
                    message: 'Medicine listings are only available to approved pharmacist vendors.',
                });
            }

            if (isRestaurantCategory(category) && !restaurantName) {
                return res.status(400).json({
                    message: 'Restaurant name is required for food listings.',
                });
            }

            // -----------------------------------------------------
            // HANDLE IMAGE UPLOAD TO CLOUDINARY
            // -----------------------------------------------------
            const uploadedImages = [];

            // Main image required
            if (!req.files.mainImage) {
                return res.status(400).json({ message: 'Main product image required.' });
            }

            const mainImageFile = req.files.mainImage[0];
            const mainImageUpload = await cloudinary.uploader.upload(
                `data:${mainImageFile.mimetype};base64,${mainImageFile.buffer.toString(
                    'base64'
                )}`,
                { folder: 'naijago_products' }
            );
            uploadedImages.push(mainImageUpload.secure_url);

            // Extra images (optional)
            if (req.files.extraImages && req.files.extraImages.length > 0) {
                for (const img of req.files.extraImages) {
                    const uploaded = await cloudinary.uploader.upload(
                        `data:${img.mimetype};base64,${img.buffer.toString('base64')}`,
                        { folder: 'naijago_product_views' }
                    );
                    uploadedImages.push(uploaded.secure_url);
                }
            }

            // -----------------------------------------------------
            // PROCESS SIZE DATA (NEW)
            // -----------------------------------------------------
            let sizeData = null;
            
            if (size_data) {
                try {
                    const parsedSizeData = JSON.parse(size_data);
                    
                    if (parsedSizeData.type) {
                        sizeData = {
                            type: parsedSizeData.type,
                            multiple: parsedSizeData.multiple || false,
                        };
                        
                        // Handle standard sizes (clothing, shoes, etc.)
                        if (parsedSizeData.type !== 'custom' && parsedSizeData.sizes) {
                            sizeData.sizes = parsedSizeData.sizes.map(size => ({
                                value: size.toString(),
                                label: size.toString(),
                                unit: parsedSizeData.unit || getDefaultUnit(parsedSizeData.type)
                            }));
                        }
                        
                        // Handle custom dimensions
                        if (parsedSizeData.type === 'custom' && parsedSizeData.sizes) {
                            sizeData.customDimensions = parsedSizeData.sizes.map(dim => ({
                                length: parseFloat(dim.length) || 0,
                                width: parseFloat(dim.width) || 0,
                                height: parseFloat(dim.height) || 0,
                                unit: dim.unit || 'cm',
                                label: dim.label || `Custom ${sizeData.customDimensions ? sizeData.customDimensions.length + 1 : 1}`
                            }));
                        }
                    }
                } catch (error) {
                    console.log('Error parsing size data:', error.message);
                    // Continue without size data if parsing fails
                }
            }

            const requiresModeration = requiresProductModeration(category);
            const product = new Product({
                name,
                description,
                price,
                category,
                stockQuantity,
                imageUrls: uploadedImages,
                sizeData, // NEW: Add size data to product
                vendor: req.user._id,
                productLocation: buildProductLocation(req.body),
                is_flashsale: is_flashsale === 'true',
                isActive: !requiresModeration,
                moderationStatus: requiresModeration ? 'pending' : 'approved',
                restaurantName: isRestaurantCategory(category) ? String(restaurantName).trim() : undefined,
                foodInformation: isRestaurantCategory(category)
                    ? String(foodInformation || description).trim()
                    : undefined,
                foodCategory: isRestaurantCategory(category)
                    ? normalizeFoodCategory(foodCategory || req.body.foodType || req.body.subcategory, category)
                    : undefined,
                orderStartTime: isRestaurantCategory(category)
                    ? normalizeTime(orderStartTime, '09:00')
                    : undefined,
                orderEndTime: isRestaurantCategory(category)
                    ? normalizeTime(orderEndTime, '19:00')
                    : undefined,
                medicineAccess: isMedicineCategory(category)
                    ? (medicineAccess || (toBoolean(isOverTheCounter) ? 'over_the_counter' : 'pharmacist_approval'))
                    : undefined,
                isOverTheCounter: isMedicineCategory(category)
                    ? toBoolean(isOverTheCounter)
                    : false,
                requiresPrescription: isMedicineCategory(category)
                    ? toBoolean(requiresPrescription)
                    : false,
                requiresPharmacistApproval: isMedicineCategory(category)
                    ? toBoolean(requiresPharmacistApproval)
                    : false,
            });

            const createdProduct = await product.save();

            if (vendor) {
                vendor.totalProducts = (vendor.totalProducts || 0) + 1;
                vendor.productsUnsold =
                    (vendor.productsUnsold || 0) + parseInt(stockQuantity);
                await vendor.save();
            }

            await createdProduct.populate('vendor', vendorPopulateFields);

            res.status(201).json({
                message: requiresModeration
                    ? 'Product submitted for admin review. It will go live after approval.'
                    : 'Product added successfully!',
                product: createdProduct,
            });
        } catch (error) {
            console.error('Error adding product:', error);
            res.status(500).json({ message: 'Server error adding product.' });
        }
    }
);

// Helper function to get default unit for size type
function getDefaultUnit(type) {
    switch (type) {
        case 'shoes':
            return 'EU';
        case 'watches':
            return 'mm';
        case 'clothing':
        case 'baby':
        case 'pet':
            return 'size';
        default:
            return 'unit';
    }
}

// =============================================================
// UPDATE PRODUCT (UPDATED FOR SIZE DATA)
// =============================================================

router.put(
    '/:id',
    protect,
    authorizeRoles('vendor'),
    multiUpload,
    async (req, res) => {
        console.log('PUT /api/products/:id hit');

        const { 
            name, 
            description, 
            price, 
            category, 
            stockQuantity, 
            is_flashsale,
            restaurantName,
            foodInformation,
            orderStartTime,
            orderEndTime,
            foodCategory,
            medicineAccess,
            isOverTheCounter,
            requiresPrescription,
            requiresPharmacistApproval,
            size_data // NEW: Size data from Flutter
        } = req.body;

        try {
            let product = await Product.findById(req.params.id);

            if (!product) {
                return res.status(404).json({ message: 'Product not found.' });
            }

            if (product.vendor.toString() !== req.user._id.toString()) {
                return res.status(401).json({
                    message: 'Not authorized to update this product.',
                });
            }

            const vendor = await User.findById(req.user._id);
            const nextCategory = category || product.category;
            if (isMedicineCategory(nextCategory) && vendor?.role !== 'pharmacist') {
                return res.status(403).json({
                    message: 'Medicine listings are only available to approved pharmacist vendors.',
                });
            }

            if (isRestaurantCategory(nextCategory) && restaurantName !== undefined && !restaurantName) {
                return res.status(400).json({
                    message: 'Restaurant name is required for food listings.',
                });
            }

            // -----------------------------------------------------
            // HANDLE IMAGE UPDATES
            // -----------------------------------------------------
            let updatedImageUrls = [...product.imageUrls];

            // If main image is provided, replace old main image
            if (req.files.mainImage) {
                const mainImage = req.files.mainImage[0];
                const upload = await cloudinary.uploader.upload(
                    `data:${mainImage.mimetype};base64,${mainImage.buffer.toString(
                        'base64'
                    )}`,
                    { folder: 'naijago_products' }
                );
                updatedImageUrls[0] = upload.secure_url;
            }

            // Add extra new images
            if (req.files.extraImages) {
                for (const img of req.files.extraImages) {
                    const upload = await cloudinary.uploader.upload(
                        `data:${img.mimetype};base64,${img.buffer.toString('base64')}`,
                        { folder: 'naijago_product_views' }
                    );
                    updatedImageUrls.push(upload.secure_url);
                }
            }

            // -----------------------------------------------------
            // PROCESS SIZE DATA (NEW)
            // -----------------------------------------------------
            let sizeData = product.sizeData || null;
            
            if (size_data) {
                try {
                    const parsedSizeData = JSON.parse(size_data);
                    
                    if (parsedSizeData.type) {
                        sizeData = {
                            type: parsedSizeData.type,
                            multiple: parsedSizeData.multiple || false,
                        };
                        
                        // Handle standard sizes
                        if (parsedSizeData.type !== 'custom' && parsedSizeData.sizes) {
                            sizeData.sizes = parsedSizeData.sizes.map(size => ({
                                value: size.toString(),
                                label: size.toString(),
                                unit: parsedSizeData.unit || getDefaultUnit(parsedSizeData.type)
                            }));
                        }
                        
                        // Handle custom dimensions
                        if (parsedSizeData.type === 'custom' && parsedSizeData.sizes) {
                            sizeData.customDimensions = parsedSizeData.sizes.map(dim => ({
                                length: parseFloat(dim.length) || 0,
                                width: parseFloat(dim.width) || 0,
                                height: parseFloat(dim.height) || 0,
                                unit: dim.unit || 'cm',
                                label: dim.label || `Custom ${sizeData.customDimensions ? sizeData.customDimensions.length + 1 : 1}`
                            }));
                        }
                    }
                } catch (error) {
                    console.log('Error parsing size data:', error.message);
                    // Keep existing size data if parsing fails
                }
            }

            // UPDATE FIELDS
            product.name = name || product.name;
            product.description = description || product.description;
            product.price = price || product.price;
            product.category = category || product.category;
            product.stockQuantity = stockQuantity || product.stockQuantity;
            product.imageUrls = updatedImageUrls;
            product.sizeData = sizeData; // NEW: Update size data
            const nextProductLocation = buildProductLocation(req.body);
            if (nextProductLocation !== undefined) {
                product.productLocation = nextProductLocation;
            }
            if (is_flashsale !== undefined)
                product.is_flashsale = is_flashsale === 'true';
            if (requiresProductModeration(product.category)) {
                product.isActive = false;
                product.moderationStatus = 'pending';
                product.moderationNote = '';
                product.reviewedAt = null;
                product.reviewedBy = null;
            }

            if (isRestaurantCategory(product.category)) {
                if (restaurantName !== undefined) product.restaurantName = String(restaurantName).trim();
                if (foodInformation !== undefined) product.foodInformation = String(foodInformation).trim();
                if (foodCategory !== undefined || req.body.foodType !== undefined || req.body.subcategory !== undefined) {
                    product.foodCategory = normalizeFoodCategory(
                        foodCategory || req.body.foodType || req.body.subcategory,
                        product.category
                    );
                } else if (!product.foodCategory) {
                    product.foodCategory = normalizeFoodCategory('', product.category);
                }
                if (orderStartTime !== undefined) product.orderStartTime = normalizeTime(orderStartTime, '09:00');
                if (orderEndTime !== undefined) product.orderEndTime = normalizeTime(orderEndTime, '19:00');
            } else {
                product.restaurantName = undefined;
                product.foodInformation = undefined;
                product.foodCategory = undefined;
                product.orderStartTime = undefined;
                product.orderEndTime = undefined;
            }

            if (isMedicineCategory(product.category)) {
                if (medicineAccess !== undefined) product.medicineAccess = medicineAccess;
                if (isOverTheCounter !== undefined) product.isOverTheCounter = toBoolean(isOverTheCounter);
                if (requiresPrescription !== undefined) product.requiresPrescription = toBoolean(requiresPrescription);
                if (requiresPharmacistApproval !== undefined) {
                    product.requiresPharmacistApproval = toBoolean(requiresPharmacistApproval);
                }
            } else {
                product.medicineAccess = undefined;
                product.isOverTheCounter = false;
                product.requiresPrescription = false;
                product.requiresPharmacistApproval = false;
            }

            const updatedProduct = await product.save();
            await updatedProduct.populate('vendor', vendorPopulateFields);

            res.status(200).json({
                message: 'Product updated successfully!',
                product: updatedProduct,
            });
        } catch (error) {
            console.error('Error updating product:', error);
            res.status(500).json({ message: 'Server error updating product.' });
        }
    }
);

// =============================================================
// GET ROUTES (UNCHANGED - but they will now return size data)
// =============================================================

// @desc    Get all products for the logged-in vendor
router.get('/myproducts', protect, async (req, res) => {
    try {
        const { limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 300 });
        // Ensure the user is a vendor
        const user = await User.findById(req.user._id);
        if (!user || !user.isVendor || user.vendorStatus !== 'approved') {
            return res.status(403).json({ message: 'Access denied. Only approved vendors can view their products.' });
        }

        // Find products where the 'vendor' field matches the authenticated user's ID
        const products = await Product.find({ vendor: req.user._id })
            .populate('vendor', vendorPopulateFields)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        res.status(200).json(products);
    } catch (error) {
        console.error('Error fetching vendor products:', error);
        res.status(500).json({ message: 'Server error fetching vendor products.' });
    }
});

// @desc    Get all new arrival products (for homepage)
router.get('/newarrivals', async (req, res) => {
    try {
        // Fetch extra products to allow filtering out restaurant products
        let newArrivalsProducts = await Product.find({ isActive: true })
            .sort({ createdAt: -1 }) // Sort by creation date, newest first
            .limit(30) 
            .populate('vendor', vendorPopulateFields);
            
        // Filter out food/restaurant items from new arrivals
        newArrivalsProducts = newArrivalsProducts
            .filter(p => !isRestaurantCategory(p.category))
            .slice(0, 10);
        
        res.status(200).json(newArrivalsProducts);
    } catch (error) {
        console.error('Error fetching new arrival products:', error);
        res.status(500).json({ message: 'Server error fetching new arrival products.' });
    }
});

// @desc    Get all products on flash sale (for homepage)
router.get('/flashsales', async (req, res) => {
    try {
        const { limit } = parsePagination(req.query, { defaultLimit: 30, maxLimit: 100 });
        // Find all products that are active and marked as a flash sale
        const flashSalesProducts = await Product.find({ isActive: true, is_flashsale: true })
            .sort({ createdAt: -1 })
            .limit(limit)
            .populate('vendor', vendorPopulateFields)
            .lean();
        
        res.status(200).json(flashSalesProducts);
    } catch (error) {
        console.error('Error fetching flash sale products:', error);
        res.status(500).json({ message: 'Server error fetching flash sale products.' });
    }
});

// @desc    Get products by a specific vendor (publicly viewable vendor stores)
router.get('/vendor/:vendorId', async (req, res) => {
    try {
        const { limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 300 });
        const products = await Product.find({ vendor: req.params.vendorId, isActive: true })
            .populate('vendor', `firstName lastName ${vendorPopulateFields}`)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();
        if (products.length === 0) {
            return res.status(404).json({ message: 'No products found for this vendor.' });
        }
        res.status(200).json(products);
    } catch (error) {
        console.error('Error fetching products by vendor:', error);
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'Invalid vendor ID format.' });
        }
        res.status(500).json({ message: 'Server error fetching products for vendor.' });
    }
});

/**
 * @desc    Search products by name (case-insensitive partial match)
 * @route   GET /api/products/search
 * @access  Public
 * @query   ?q=search term
 */
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.trim() === '') {
      return res.status(200).json([]); // or 400 - your choice
    }

    const searchTerm = q.trim();

    const products = await Product.find({
      isActive: true,
      $or: [
        { name: { $regex: searchTerm, $options: 'i' } },
        { description: { $regex: searchTerm, $options: 'i' } },
      ]
    })
      .populate('vendor', vendorPopulateFields)
      .limit(50);

    console.log(`Search for "${searchTerm}" → found ${products.length} products`);

    res.status(200).json(products);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ message: 'Error performing search' });
  }
});

// @desc    Get restaurant/food products, optionally nearby by customer coordinates
// @route   GET /api/products/restaurants?lat=&lng=&radiusKm=
// @access  Public
router.get('/restaurants/categories', async (req, res) => {
    try {
        const products = await Product.find({
            isActive: true,
            ...buildCategoryFilter('Restaurant'),
        })
            .select('name category description foodInformation restaurantName foodCategory')
            .lean();

        const categoryMap = new Map();
        for (const product of products) {
            const label = deriveFoodCategory(product);
            const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            const current = categoryMap.get(key) || { key, label, count: 0 };
            current.count += 1;
            categoryMap.set(key, current);
        }

        const categories = Array.from(categoryMap.values()).sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return a.label.localeCompare(b.label);
        });

        res.status(200).json({ categories });
    } catch (error) {
        console.error('Error fetching restaurant food categories:', error);
        res.status(500).json({ message: 'Server error fetching restaurant food categories.' });
    }
});

router.get('/restaurants', async (req, res) => {
    try {
        const { limit } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 300 });
        const lat = req.query.lat !== undefined ? Number(req.query.lat) : null;
        const lng = req.query.lng !== undefined ? Number(req.query.lng) : null;
        const radiusKm = req.query.radiusKm !== undefined ? Number(req.query.radiusKm) : 15;
        const mealType = String(req.query.mealType || '').toLowerCase();
        const openNow = toBoolean(req.query.openNow);
        const minPrice = req.query.minPrice !== undefined ? Number(req.query.minPrice) : null;
        const maxPrice = req.query.maxPrice !== undefined ? Number(req.query.maxPrice) : null;
        const sort = String(req.query.sort || 'nearby').toLowerCase();
        const foodCategory = String(req.query.foodCategory || '').trim().toLowerCase();

        const filter = {
            isActive: true,
            ...buildCategoryFilter('Restaurant'),
        };

        if (Number.isFinite(minPrice) || Number.isFinite(maxPrice)) {
            filter.price = {};
            if (Number.isFinite(minPrice)) filter.price.$gte = minPrice;
            if (Number.isFinite(maxPrice)) filter.price.$lte = maxPrice;
        }

        let products = await Product.find(filter)
            .sort(sort === 'popular' ? { salesCount: -1, createdAt: -1 } : { createdAt: -1 })
            .limit(limit * 2)
            .populate('vendor', vendorPopulateFields)
            .lean();

        products = products.filter((product) => matchesRestaurantMeal(product, mealType));
        if (foodCategory) {
            products = products.filter((product) => {
                const label = deriveFoodCategory(product).toLowerCase();
                const key = label.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                return label === foodCategory || key === foodCategory;
            });
        }

        if (openNow) {
            products = products.filter((product) => isRestaurantProductOpenNow(product));
        }

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            if (sort === 'popular') {
                products.sort((a, b) => (b.salesCount || 0) - (a.salesCount || 0));
            } else if (sort === 'price_low') {
                products.sort((a, b) => (a.price || 0) - (b.price || 0));
            } else if (sort === 'price_high') {
                products.sort((a, b) => (b.price || 0) - (a.price || 0));
            }
            return res.status(200).json(products.slice(0, limit));
        }

        const withDistances = products.map((product) => {
            const vendorLocation = resolveProductLocation(product);
            if (!vendorLocation?.latitude || !vendorLocation?.longitude) {
                return { product, distanceKm: null };
            }

            return {
                product,
                distanceKm: distanceKm(
                    lat,
                    lng,
                    vendorLocation.latitude,
                    vendorLocation.longitude
                ),
            };
        });

        const nearby = withDistances
            .filter((entry) => entry.distanceKm !== null && entry.distanceKm <= radiusKm)
            .sort((a, b) => {
                if (sort === 'popular') {
                    return (b.product.salesCount || 0) - (a.product.salesCount || 0);
                }
                if (sort === 'price_low') {
                    return (a.product.price || 0) - (b.product.price || 0);
                }
                if (sort === 'price_high') {
                    return (b.product.price || 0) - (a.product.price || 0);
                }
                return a.distanceKm - b.distanceKm;
            })
            .map((entry) => entry.product);

        res.status(200).json((nearby.length > 0 ? nearby : products).slice(0, limit));
    } catch (error) {
        console.error('Error fetching restaurant products:', error);
        res.status(500).json({ message: 'Server error fetching restaurant products.' });
    }
});

// @desc    Get a single product by ID
router.get('/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id).populate('vendor', vendorPopulateFields);
        if (!product) {
            return res.status(404).json({ message: 'Product not found.' });
        }
        res.status(200).json(product);
    } catch (error) {
        console.error('Error fetching single product:', error);
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'Invalid product ID format.' });
        }
        res.status(500).json({ message: 'Server error fetching product.' });
    }
});

// @desc    Get all products (for homepage, public access)
router.get('/', async (req, res) => {
  try {
    const { limit } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 300 });
    const { category } = req.query;
    const lat = req.query.lat !== undefined ? Number(req.query.lat) : null;
    const lng = req.query.lng !== undefined ? Number(req.query.lng) : null;
    const radiusKm = req.query.radiusKm !== undefined ? Number(req.query.radiusKm) : null;
    const filter = { isActive: true };

    if (category) {
      Object.assign(filter, buildCategoryFilter(category));
    }

    const products = await Product.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit * 2)
      .populate('vendor', vendorPopulateFields)
      .lean();
    const canSortByCustomerLocation = Number.isFinite(lat) && Number.isFinite(lng);
    const sortedProducts = canSortByCustomerLocation
      ? products
          .map((product) => {
            const vendorLocation = resolveProductLocation(product);
            if (!vendorLocation?.latitude || !vendorLocation?.longitude) {
              return { product, distanceKm: null };
            }

            return {
              product,
              distanceKm: distanceKm(
                lat,
                lng,
                vendorLocation.latitude,
                vendorLocation.longitude
              ),
            };
          })
          .filter((entry) => !Number.isFinite(radiusKm) || entry.distanceKm === null || entry.distanceKm <= radiusKm)
          .sort((a, b) => {
            if (a.distanceKm === null && b.distanceKm === null) return 0;
            if (a.distanceKm === null) return 1;
            if (b.distanceKm === null) return -1;
            return a.distanceKm - b.distanceKm;
          })
          .map((entry) => entry.product)
      : products;

    console.log(`Backend: Fetched ${products.length} products${category ? ` for category "${category}"` : ''}.`);
    
    res.status(200).json(sortedProducts.slice(0, limit));
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ message: 'Server error fetching products.' });
  }
});

// =============================================================
// NEW: GET PRODUCTS BY SIZE TYPE (Optional)
// =============================================================
router.get('/size/:type', async (req, res) => {
    try {
        const { limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 300 });
        const { type } = req.params;
        const { category } = req.query;
        
        const filter = { 
            isActive: true,
            'sizeData.type': type 
        };
        
        if (category) {
            filter.category = category;
        }
        
        const products = await Product.find(filter)
            .populate('vendor', vendorPopulateFields)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();
        
        res.status(200).json({
            count: products.length,
            products
        });
    } catch (error) {
        console.error('Error fetching products by size type:', error);
        res.status(500).json({ message: 'Server error fetching products by size.' });
    }
});

// =============================================================
// DELETE PRODUCT (UNCHANGED)
// =============================================================
router.delete('/:id', protect, async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);

        if (!product) {
            return res.status(404).json({ message: 'Product not found.' });
        }

        if (
            product.vendor.toString() !== req.user._id.toString() &&
            req.user.role !== 'admin'
        ) {
            return res.status(401).json({
                message: 'Not authorized to delete this product.',
            });
        }

        await product.deleteOne();

        res.status(200).json({ message: 'Product deleted successfully.' });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ message: 'Server error deleting product.' });
    }
});

module.exports = router;
