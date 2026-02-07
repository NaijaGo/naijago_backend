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
            size_data // NEW: Size data from Flutter
        } = req.body;

        if (!name || !description || !price || !category || !stockQuantity) {
            return res.status(400).json({
                message:
                    'Please enter all product details (name, description, price, category, stock quantity).',
            });
        }

        try {
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

            const product = new Product({
                name,
                description,
                price,
                category,
                stockQuantity,
                imageUrls: uploadedImages,
                sizeData, // NEW: Add size data to product
                vendor: req.user._id,
                is_flashsale: is_flashsale === 'true',
            });

            const createdProduct = await product.save();

            const vendor = await User.findById(req.user._id);
            if (vendor) {
                vendor.totalProducts = (vendor.totalProducts || 0) + 1;
                vendor.productsUnsold =
                    (vendor.productsUnsold || 0) + parseInt(stockQuantity);
                await vendor.save();
            }

            await createdProduct.populate('vendor', 'businessName');

            res.status(201).json({
                message: 'Product added successfully!',
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
            if (is_flashsale !== undefined)
                product.is_flashsale = is_flashsale === 'true';

            const updatedProduct = await product.save();
            await updatedProduct.populate('vendor', 'businessName');

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
        // Ensure the user is a vendor
        const user = await User.findById(req.user._id);
        if (!user || !user.isVendor || user.vendorStatus !== 'approved') {
            return res.status(403).json({ message: 'Access denied. Only approved vendors can view their products.' });
        }

        // Find products where the 'vendor' field matches the authenticated user's ID
        const products = await Product.find({ vendor: req.user._id })
            .populate('vendor', 'businessName');

        res.status(200).json(products);
    } catch (error) {
        console.error('Error fetching vendor products:', error);
        res.status(500).json({ message: 'Server error fetching vendor products.' });
    }
});

// @desc    Get all new arrival products (for homepage)
router.get('/newarrivals', async (req, res) => {
    try {
        const newArrivalsProducts = await Product.find({ isActive: true })
            .sort({ createdAt: -1 }) // Sort by creation date, newest first
            .limit(10) // Limit to a reasonable number of products
            .populate('vendor', 'businessName');
        
        res.status(200).json(newArrivalsProducts);
    } catch (error) {
        console.error('Error fetching new arrival products:', error);
        res.status(500).json({ message: 'Server error fetching new arrival products.' });
    }
});

// @desc    Get all products on flash sale (for homepage)
router.get('/flashsales', async (req, res) => {
    try {
        // Find all products that are active and marked as a flash sale
        const flashSalesProducts = await Product.find({ isActive: true, is_flashsale: true }).populate('vendor', 'businessName');
        
        res.status(200).json(flashSalesProducts);
    } catch (error) {
        console.error('Error fetching flash sale products:', error);
        res.status(500).json({ message: 'Server error fetching flash sale products.' });
    }
});

// @desc    Get products by a specific vendor (publicly viewable vendor stores)
router.get('/vendor/:vendorId', async (req, res) => {
    try {
        const products = await Product.find({ vendor: req.params.vendorId, isActive: true }).populate('vendor', 'firstName lastName businessName');
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
      .populate('vendor', 'businessName')
      .limit(50);

    console.log(`Search for "${searchTerm}" → found ${products.length} products`);

    res.status(200).json(products);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ message: 'Error performing search' });
  }
});

// @desc    Get a single product by ID
router.get('/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id).populate('vendor', 'businessName');
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
    const { category } = req.query;
    const filter = { isActive: true };

    if (category) {
      filter.category = { $regex: new RegExp(`^${category}$`, 'i') };
    }

    const products = await Product.find(filter).populate('vendor', 'businessName');
    console.log(`Backend: Fetched ${products.length} products${category ? ` for category "${category}"` : ''}.`);
    
    res.status(200).json(products);
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
            .populate('vendor', 'businessName');
        
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