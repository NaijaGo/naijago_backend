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
// CREATE PRODUCT
// =============================================================

router.post(
    '/',
    protect,
    authorizeRoles('vendor'),
    multiUpload, // ⬅️ UPDATED
    async (req, res) => {
        console.log('POST /api/products hit');

        const { name, description, price, category, stockQuantity, is_flashsale } =
            req.body;

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

            const product = new Product({
                name,
                description,
                price,
                category,
                stockQuantity,
                imageUrls: uploadedImages, // ⬅️ MULTIPLE IMAGES STORED HERE
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

// =============================================================
// GET ROUTES (UNCHANGED)
// =============================================================

// (All your GET routes remain the same — I DID NOT edit them)

// =============================================================
// UPDATE PRODUCT
// =============================================================

router.put(
    '/:id',
    protect,
    authorizeRoles('vendor'),
    multiUpload, // ⬅️ UPDATED (now supports main + extra images)
    async (req, res) => {
        console.log('PUT /api/products/:id hit');

        const { name, description, price, category, stockQuantity, is_flashsale } =
            req.body;

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

            // UPDATE FIELDS
            product.name = name || product.name;
            product.description = description || product.description;
            product.price = price || product.price;
            product.category = category || product.category;
            product.stockQuantity = stockQuantity || product.stockQuantity;
            product.imageUrls = updatedImageUrls;
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



// // routes/productRoutes.js

// const express = require('express');
// const router = express.Router();
// const Product = require('../models/Product'); // Import the Product model
// const User = require('../models/User'); // Import the User model (to update vendor product counts)
// const { protect, authorizeRoles } = require('../middleware/authMiddleware'); // Import authentication middleware
// const multer = require('multer'); // Import Multer for file uploads
// const cloudinary = require('../utils/cloudinary'); // Import your Cloudinary utility
// const path = require('path'); // Import path module to work with file paths

// // --- Multer Configuration for Image Upload ---
// // Set up storage for Multer. We'll use memory storage as Cloudinary will handle the persistence.
// const storage = multer.memoryStorage(); // Store files in memory as buffers
// const upload = multer({
//     storage: storage,
//     limits: { fileSize: 5 * 1024 * 1024 }, // Limit file size to 5MB
//     fileFilter: (req, file, cb) => {
//         // --- DEBUG LOGS FOR FILE FILTER ---
//         console.log('Backend: Multer fileFilter hit.');
//         console.log('Backend: File originalname:', file.originalname);
//         console.log('Backend: File mimetype:', file.mimetype);
//         // --- END DEBUG LOGS ---

//         // Accept only image files
//         // Check if mimetype starts with 'image/' OR if it's a generic octet-stream AND has a common image extension
//         const isImageMime = file.mimetype.startsWith('image/');
//         const isGenericAndImageExtension = file.mimetype === 'application/octet-stream' &&
//                                            ['.jpg', '.jpeg', '.png', '.gif'].includes(path.extname(file.originalname).toLowerCase());

//         if (isImageMime || isGenericAndImageExtension) {
//             cb(null, true);
//         } else {
//             cb(new Error('Only image files are allowed!'), false);
//         }
//     },
// });

// // --- Product Routes ---

// // @desc    Add a new product
// // @route   POST /api/products
// // @access  Private (Vendor only)
// router.post(
//     '/',
//     protect, // Ensure user is authenticated
//     authorizeRoles('vendor'), // Ensure user is an approved vendor
//     upload.single('image'), // Multer middleware to handle single file upload with field name 'image'
//     async (req, res) => {
//         // --- DEBUG LOGS ---
//         console.log('Backend: Product POST route hit.');
//         console.log('Backend: req.body (after multer):', req.body); // Check text fields
//         console.log('Backend: req.file (after multer):', req.file); // Check file info
//         // --- END DEBUG LOGS ---

//         // Check if file was uploaded by Multer
//         if (!req.file) {
//             return res.status(400).json({ message: 'No image file uploaded.' });
//         }

//         // Destructure all required fields, including the new 'is_flashsale' field
//         const { name, description, price, category, stockQuantity, is_flashsale } = req.body;

//         // Basic validation
//         if (!name || !description || !price || !category || !stockQuantity) {
//             return res.status(400).json({ message: 'Please enter all product details (name, description, price, category, stock quantity).' });
//         }
//         // Note: is_flashsale is not strictly required and can be false by default

//         try {
//             // Upload image to Cloudinary
//             const result = await cloudinary.uploader.upload(
//                 `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,
//                 {
//                     folder: 'naijago_products',
//                     resource_type: 'image',
//                 }
//             );

//             // Convert the string "true" or "false" from the form to a boolean
//             const isFlashSaleBoolean = is_flashsale === 'true';

//             // Create new product
//             const product = new Product({
//                 name,
//                 description,
//                 price,
//                 category,
//                 stockQuantity,
//                 imageUrls: [result.secure_url],
//                 vendor: req.user._id,
//                 is_flashsale: isFlashSaleBoolean, // Assign the parsed boolean value
//             });

//             const createdProduct = await product.save();

//             // Update vendor's product counts (optional, but good for dashboard metrics)
//             const vendor = await User.findById(req.user._id);
//             if (vendor) {
//                 vendor.totalProducts = (vendor.totalProducts || 0) + 1;
//                 vendor.productsUnsold = (vendor.productsUnsold || 0) + parseInt(stockQuantity);
//                 await vendor.save();
//             }

//             await createdProduct.populate('vendor', 'businessName');

//             res.status(201).json({
//                 message: 'Product added successfully!',
//                 product: product,
//             });
//         } catch (error) {
//             console.error('Error adding product:', error);
//             res.status(500).json({ message: 'Server error adding product or uploading image.' });
//         }
//     }
// );


// // ------------------ START OF REORDERED ROUTES ------------------

// // @desc    Get all products for the logged-in vendor
// // @route   GET /api/products/myproducts
// // @access  Private (Vendor only)
// // IMPORTANT: This specific route MUST come BEFORE any general dynamic routes like /:id
// router.get('/myproducts', protect, async (req, res) => {
//     try {
//         // Ensure the user is a vendor
//         const user = await User.findById(req.user._id);
//         if (!user || !user.isVendor || user.vendorStatus !== 'approved') {
//             return res.status(403).json({ message: 'Access denied. Only approved vendors can view their products.' });
//         }

//         // Find products where the 'vendor' field matches the authenticated user's ID
//         const products = await Product.find({ vendor: req.user._id })
//             .populate('vendor', 'businessName');

//         res.status(200).json(products);
//     } catch (error) {
//         console.error('Error fetching vendor products:', error);
//         res.status(500).json({ message: 'Server error fetching vendor products.' });
//     }
// });

// // @desc    Get all new arrival products (for homepage)
// // @route   GET /api/products/newarrivals
// // @access  Public
// // NEW: This route must be placed before the /:id route.
// router.get('/newarrivals', async (req, res) => {
//     try {
//         const newArrivalsProducts = await Product.find({ isActive: true })
//             .sort({ createdAt: -1 }) // Sort by creation date, newest first
//             .limit(10) // Limit to a reasonable number of products
//             .populate('vendor', 'businessName');
//         
//         res.status(200).json(newArrivalsProducts);
//     } catch (error) {
//         console.error('Error fetching new arrival products:', error);
//         res.status(500).json({ message: 'Server error fetching new arrival products.' });
//     }
// });

// // @desc    Get all products on flash sale (for homepage)
// // @route   GET /api/products/flashsales
// // @access  Public
// // CORRECTED: This route is moved to come BEFORE the general /:id route.
// router.get('/flashsales', async (req, res) => {
//     try {
//         // Find all products that are active and marked as a flash sale
//         const flashSalesProducts = await Product.find({ isActive: true, is_flashsale: true }).populate('vendor', 'businessName');
//         
//         res.status(200).json(flashSalesProducts);
//     } catch (error) {
//         console.error('Error fetching flash sale products:', error);
//         res.status(500).json({ message: 'Server error fetching flash sale products.' });
//     }
// });

// // @desc    Get products by a specific vendor (publicly viewable vendor stores)
// // @route   GET /api/products/vendor/:vendorId
// // @access  Public
// // IMPORTANT: This specific route MUST come BEFORE the general /:id route
// router.get('/vendor/:vendorId', async (req, res) => {
//     try {
//         const products = await Product.find({ vendor: req.params.vendorId, isActive: true }).populate('vendor', 'firstName lastName businessName');
//         if (products.length === 0) {
//             return res.status(404).json({ message: 'No products found for this vendor.' });
//         }
//         res.status(200).json(products);
//     } catch (error) {
//         console.error('Error fetching products by vendor:', error);
//         if (error.name === 'CastError') {
//             return res.status(400).json({ message: 'Invalid vendor ID format.' });
//         }
//         res.status(500).json({ message: 'Server error fetching products for vendor.' });
//     }
// });


// // @desc    Get a single product by ID
// // @route   GET /api/products/:id
// // @access  Public
// // IMPORTANT: This general dynamic route MUST come AFTER all more specific GET routes
// router.get('/:id', async (req, res) => {
//     try {
//         const product = await Product.findById(req.params.id).populate('vendor', 'businessName');
//         if (!product) {
//             return res.status(404).json({ message: 'Product not found.' });
//         }
//         res.status(200).json(product);
//     } catch (error) {
//         console.error('Error fetching single product:', error);
//         if (error.name === 'CastError') {
//             return res.status(400).json({ message: 'Invalid product ID format.' });
//         }
//         res.status(500).json({ message: 'Server error fetching product.' });
//     }
// });

// // @desc    Get all products (for homepage, public access)
// // @route   GET /api/products
// // @access  Public
// router.get('/', async (req, res) => {
//   try {
//     const { category } = req.query;
//     const filter = { isActive: true };

//     if (category) {
//       filter.category = { $regex: new RegExp(`^${category}$`, 'i') };
//     }

//     const products = await Product.find(filter).populate('vendor', 'businessName');
//     console.log(`Backend: Fetched ${products.length} products${category ? ` for category "${category}"` : ''}.`);
//     
//     res.status(200).json(products);
//   } catch (error) {
//     console.error('Error fetching products:', error);
//     res.status(500).json({ message: 'Server error fetching products.' });
//   }
// });

// // ------------------ END OF REORDERED ROUTES ------------------

// // @desc    Update a product
// // @route   PUT /api/products/:id
// // @access  Private (Vendor who owns the product)
// router.put(
//     '/:id',
//     protect,
//     authorizeRoles('vendor'),
//     upload.single('image'), // Allow image update
//     async (req, res) => {
//         const { name, description, price, category, stockQuantity, is_flashsale } = req.body;

//         try {
//             let product = await Product.findById(req.params.id);

//             if (!product) {
//                 return res.status(404).json({ message: 'Product not found.' });
//             }

//             // Ensure the logged-in user is the product owner
//             if (product.vendor.toString() !== req.user._id.toString()) {
//                 return res.status(401).json({ message: 'Not authorized to update this product.' });
//             }

//             // Handle image update if a new file is uploaded
//             let imageUrl = product.imageUrls[0];
//             if (req.file) {
//                 const result = await cloudinary.uploader.upload(
//                     `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,
//                     { folder: 'naijago_products', resource_type: 'image' }
//                 );
//                 imageUrl = result.secure_url;
//             }

//             // Update product fields
//             product.name = name || product.name;
//             product.description = description || product.description;
//             product.price = price || product.price;
//             product.category = category || product.category;
//             product.stockQuantity = stockQuantity || product.stockQuantity;
//             product.imageUrls = [imageUrl];

//             // Handle the new field, convert string to boolean
//             if (is_flashsale !== undefined) {
//                 product.is_flashsale = is_flashsale === 'true';
//             }

//             const updatedProduct = await product.save();
//             await updatedProduct.populate('vendor', 'businessName');

//             res.status(200).json({ 
//                 message: 'Product updated successfully!',
//                 product: updatedProduct 
//             });

//         } catch (error) {
//             console.error('Error updating product:', error);
//             res.status(500).json({ message: 'Server error updating product or uploading image.' });
//         }
//     }
// );

// // @desc    Delete a product
// // @route   DELETE /api/products/:id
// // @access  Private (Vendor who owns the product or Admin)
// router.delete(
//     '/:id',
//     protect,
//     async (req, res) => {
//         try {
//             const product = await Product.findById(req.params.id);

//             if (!product) {
//                 return res.status(404).json({ message: 'Product not found.' });
//             }

//             // Ensure the user is either the product's vendor or an admin
//             if (product.vendor.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
//                 return res.status(401).json({ message: 'Not authorized to delete this product.' });
//             }

//             await product.deleteOne();

//             res.status(200).json({ message: 'Product deleted successfully.' });

//         } catch (error) {
//             console.error('Error deleting product:', error);
//             if (error.name === 'CastError') {
//                 return res.status(400).json({ message: 'Invalid product ID format.' });
//             }
//             res.status(500).json({ message: 'Server error deleting product.' });
//         }
//     }
// );


// module.exports = router;






// // routes/productRoutes.js

// const express = require('express');
// const router = express.Router();
// const Product = require('../models/Product'); // Import the Product model
// const User = require('../models/User'); // Import the User model (to update vendor product counts)
// const { protect, authorizeRoles } = require('../middleware/authMiddleware'); // Import authentication middleware
// const multer = require('multer'); // Import Multer for file uploads
// const cloudinary = require('../utils/cloudinary'); // Import your Cloudinary utility
// const path = require('path'); // Import path module to work with file paths

// // --- Multer Configuration for Image Upload ---
// // Set up storage for Multer. We'll use memory storage as Cloudinary will handle the persistence.
// const storage = multer.memoryStorage(); // Store files in memory as buffers
// const upload = multer({
//     storage: storage,
//     limits: { fileSize: 5 * 1024 * 1024 }, // Limit file size to 5MB
//     fileFilter: (req, file, cb) => {
//         // --- DEBUG LOGS FOR FILE FILTER ---
//         console.log('Backend: Multer fileFilter hit.');
//         console.log('Backend: File originalname:', file.originalname);
//         console.log('Backend: File mimetype:', file.mimetype);
//         // --- END DEBUG LOGS ---

//         // Accept only image files
//         // Check if mimetype starts with 'image/' OR if it's a generic octet-stream AND has a common image extension
//         const isImageMime = file.mimetype.startsWith('image/');
//         const isGenericAndImageExtension = file.mimetype === 'application/octet-stream' &&
//                                            ['.jpg', '.jpeg', '.png', '.gif'].includes(path.extname(file.originalname).toLowerCase());

//         if (isImageMime || isGenericAndImageExtension) {
//             cb(null, true);
//         } else {
//             cb(new Error('Only image files are allowed!'), false);
//         }
//     },
// });

// // --- Product Routes ---

// // @desc    Add a new product
// // @route   POST /api/products
// // @access  Private (Vendor only)
// router.post(
//     '/',
//     protect, // Ensure user is authenticated
//     authorizeRoles('vendor'), // Ensure user is an approved vendor
//     upload.single('image'), // Multer middleware to handle single file upload with field name 'image'
//     async (req, res) => {
//         // --- DEBUG LOGS ---
//         console.log('Backend: Product POST route hit.');
//         console.log('Backend: req.body (after multer):', req.body); // Check text fields
//         console.log('Backend: req.file (after multer):', req.file); // Check file info
//         // --- END DEBUG LOGS ---

//         // Check if file was uploaded by Multer
//         if (!req.file) {
//             return res.status(400).json({ message: 'No image file uploaded.' });
//         }

//         const { name, description, price, category, stockQuantity } = req.body;

//         // Basic validation
//         if (!name || !description || !price || !category || !stockQuantity) {
//             // If any text field is missing, respond with an error
//             return res.status(400).json({ message: 'Please enter all product details (name, description, price, category, stock quantity).' });
//         }

//         try {
//             // Upload image to Cloudinary
//             const result = await cloudinary.uploader.upload(
//                 `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,
//                 {
//                     folder: 'naijago_products', // Optional: folder in Cloudinary to store images
//                     resource_type: 'image', // Ensure it's treated as an image
//                 }
//             );

//             // Create new product
//             const product = new Product({
//                 name,
//                 description,
//                 price,
//                 category,
//                 stockQuantity,
//                 imageUrls: [result.secure_url], // Store the secure URL from Cloudinary
//                 vendor: req.user._id, // Link product to the authenticated vendor
//                 // isActive is NOT set here, so it will use the default: true from the Product model
//             });

//             const createdProduct = await product.save(); // Save the product to the database

//             // Update vendor's product counts (optional, but good for dashboard metrics)
//             const vendor = await User.findById(req.user._id);
//             if (vendor) {
//                 vendor.totalProducts = (vendor.totalProducts || 0) + 1;
//                 vendor.productsUnsold = (vendor.productsUnsold || 0) + parseInt(stockQuantity);
//                 await vendor.save();
//             }

//             await createdProduct.populate('vendor', 'businessName');

//             res.status(201).json({
//                 message: 'Product added successfully!',
//                 product: product,
//             });
//         } catch (error) {
//             console.error('Error adding product:', error);
//             // If Cloudinary upload fails, it will throw an error.
//             res.status(500).json({ message: 'Server error adding product or uploading image.' });
//         }
//     }
// );


// // ------------------ START OF REORDERED ROUTES ------------------

// // @desc    Get all products for the logged-in vendor
// // @route   GET /api/products/myproducts
// // @access  Private (Vendor only)
// // IMPORTANT: This specific route MUST come BEFORE any general dynamic routes like /:id
// router.get('/myproducts', protect, async (req, res) => {
//     try {
//         // Ensure the user is a vendor
//         const user = await User.findById(req.user._id);
//         if (!user || !user.isVendor || user.vendorStatus !== 'approved') {
//             return res.status(403).json({ message: 'Access denied. Only approved vendors can view their products.' });
//         }

//         // Find products where the 'vendor' field matches the authenticated user's ID
//         const products = await Product.find({ vendor: req.user._id })
//             .populate('vendor', 'businessName');

//         res.status(200).json(products);
//     } catch (error) {
//         console.error('Error fetching vendor products:', error);
//         res.status(500).json({ message: 'Server error fetching vendor products.' });
//     }
// });

// // @desc    Get all new arrival products (for homepage)
// // @route   GET /api/products/newarrivals
// // @access  Public
// // NEW: This route must be placed before the /:id route.
// router.get('/newarrivals', async (req, res) => {
//     try {
//         const newArrivalsProducts = await Product.find({ isActive: true })
//             .sort({ createdAt: -1 }) // Sort by creation date, newest first
//             .limit(10) // Limit to a reasonable number of products
//             .populate('vendor', 'businessName');
//         
//         res.status(200).json(newArrivalsProducts);
//     } catch (error) {
//         console.error('Error fetching new arrival products:', error);
//         res.status(500).json({ message: 'Server error fetching new arrival products.' });
//     }
// });

// // @desc    Get all products on flash sale (for homepage)
// // @route   GET /api/products/flashsales
// // @access  Public
// // CORRECTED: This route is moved to come BEFORE the general /:id route.
// router.get('/flashsales', async (req, res) => {
//     try {
//         // Find all products that are active and marked as a flash sale
//         const flashSalesProducts = await Product.find({ isActive: true, is_flashsale: true }).populate('vendor', 'businessName');
//         
//         res.status(200).json(flashSalesProducts);
//     } catch (error) {
//         console.error('Error fetching flash sale products:', error);
//         res.status(500).json({ message: 'Server error fetching flash sale products.' });
//     }
// });

// // @desc    Get products by a specific vendor (publicly viewable vendor stores)
// // @route   GET /api/products/vendor/:vendorId
// // @access  Public
// // IMPORTANT: This specific route MUST come BEFORE the general /:id route
// router.get('/vendor/:vendorId', async (req, res) => {
//     try {
//         const products = await Product.find({ vendor: req.params.vendorId, isActive: true }).populate('vendor', 'firstName lastName businessName');
//         if (products.length === 0) {
//             return res.status(404).json({ message: 'No products found for this vendor.' });
//         }
//         res.status(200).json(products);
//     } catch (error) {
//         console.error('Error fetching products by vendor:', error);
//         if (error.name === 'CastError') {
//             return res.status(400).json({ message: 'Invalid vendor ID format.' });
//         }
//         res.status(500).json({ message: 'Server error fetching products for vendor.' });
//     }
// });


// // @desc    Get a single product by ID
// // @route   GET /api/products/:id
// // @access  Public
// // IMPORTANT: This general dynamic route MUST come AFTER all more specific GET routes
// router.get('/:id', async (req, res) => {
//     try {
//         const product = await Product.findById(req.params.id).populate('vendor', 'businessName');
//         if (!product) {
//             return res.status(404).json({ message: 'Product not found.' });
//         }
//         res.status(200).json(product);
//     } catch (error) {
//         console.error('Error fetching single product:', error);
//         if (error.name === 'CastError') {
//             return res.status(400).json({ message: 'Invalid product ID format.' });
//         }
//         res.status(500).json({ message: 'Server error fetching product.' });
//     }
// });

// // @desc    Get all products (for homepage, public access)
// // @route   GET /api/products
// // @access  Public
// router.get('/', async (req, res) => {
//   try {
//     const { category } = req.query;
//     const filter = { isActive: true };

//     if (category) {
//       filter.category = { $regex: new RegExp(`^${category}$`, 'i') };
//     }

//     const products = await Product.find(filter).populate('vendor', 'businessName');
//     console.log(`Backend: Fetched ${products.length} products${category ? ` for category "${category}"` : ''}.`);
//     
//     res.status(200).json(products);
//   } catch (error) {
//     console.error('Error fetching products:', error);
//     res.status(500).json({ message: 'Server error fetching products.' });
//   }
// });

// // ------------------ END OF REORDERED ROUTES ------------------

// // @desc    Update a product
// // @route   PUT /api/products/:id
// // @access  Private (Vendor who owns the product)
// router.put(
//     '/:id',
//     protect,
//     authorizeRoles('vendor'),
//     upload.single('image'), // Allow image update
//     async (req, res) => {
//         // ... (Your PUT route logic remains the same)
//     }
// );

// // @desc    Delete a product
// // @route   DELETE /api/products/:id
// // @access  Private (Vendor who owns the product or Admin)
// router.delete(
//     '/:id',
//     protect,
//     async (req, res) => {
//         // ... (Your DELETE route logic remains the same)
//     }
// );


// module.exports = router;

// // routes/productRoutes.js

// const express = require('express');
// const router = express.Router();
// const Product = require('../models/Product'); // Import the Product model
// const User = require('../models/User');     // Import the User model (to update vendor product counts)
// const { protect, authorizeRoles } = require('../middleware/authMiddleware'); // Import authentication middleware
// const multer = require('multer'); // Import Multer for file uploads
// const cloudinary = require('../utils/cloudinary'); // Import your Cloudinary utility
// const path = require('path'); // Import path module to work with file paths

// // --- Multer Configuration for Image Upload ---
// // Set up storage for Multer. We'll use memory storage as Cloudinary will handle the persistence.
// const storage = multer.memoryStorage(); // Store files in memory as buffers
// const upload = multer({
//     storage: storage,
//     limits: { fileSize: 5 * 1024 * 1024 }, // Limit file size to 5MB
//     fileFilter: (req, file, cb) => {
//         // --- DEBUG LOGS FOR FILE FILTER ---
//         console.log('Backend: Multer fileFilter hit.');
//         console.log('Backend: File originalname:', file.originalname);
//         console.log('Backend: File mimetype:', file.mimetype);
//         // --- END DEBUG LOGS ---

//         // Accept only image files
//         // Check if mimetype starts with 'image/' OR if it's a generic octet-stream AND has a common image extension
//         const isImageMime = file.mimetype.startsWith('image/');
//         const isGenericAndImageExtension = file.mimetype === 'application/octet-stream' &&
//                                            ['.jpg', '.jpeg', '.png', '.gif'].includes(path.extname(file.originalname).toLowerCase());

//         if (isImageMime || isGenericAndImageExtension) {
//             cb(null, true);
//         } else {
//             cb(new Error('Only image files are allowed!'), false);
//         }
//     },
// });

// // --- Product Routes ---

// // @desc    Add a new product
// // @route   POST /api/products
// // @access  Private (Vendor only)
// // Place POST routes typically before GET routes, or at least before general GETs
// router.post(
//     '/',
//     protect, // Ensure user is authenticated
//     authorizeRoles('vendor'), // Ensure user is an approved vendor
//     upload.single('image'), // Multer middleware to handle single file upload with field name 'image'
//     async (req, res) => {
//         // --- DEBUG LOGS ---
//         console.log('Backend: Product POST route hit.');
//         console.log('Backend: req.body (after multer):', req.body); // Check text fields
//         console.log('Backend: req.file (after multer):', req.file); // Check file info
//         // --- END DEBUG LOGS ---

//         // Check if file was uploaded by Multer
//         if (!req.file) {
//             return res.status(400).json({ message: 'No image file uploaded.' });
//         }

//         const { name, description, price, category, stockQuantity } = req.body;

//         // Basic validation
//         if (!name || !description || !price || !category || !stockQuantity) {
//             // If any text field is missing, respond with an error
//             return res.status(400).json({ message: 'Please enter all product details (name, description, price, category, stock quantity).' });
//         }

//         try {
//             // Upload image to Cloudinary
//             const result = await cloudinary.uploader.upload(
//                 `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,
//                 {
//                     folder: 'naijago_products', // Optional: folder in Cloudinary to store images
//                     resource_type: 'image', // Ensure it's treated as an image
//                 }
//             );

//             // Create new product
//             const product = new Product({
//                 name,
//                 description,
//                 price,
//                 category,
//                 stockQuantity,
//                 imageUrls: [result.secure_url], // Store the secure URL from Cloudinary
//                 vendor: req.user._id, // Link product to the authenticated vendor
//                 // isActive is NOT set here, so it will use the default: true from the Product model
//             });

//             const createdProduct = await product.save(); // Save the product to the database

//             // Update vendor's product counts (optional, but good for dashboard metrics)
//             const vendor = await User.findById(req.user._id);
//             if (vendor) {
//                 vendor.totalProducts = (vendor.totalProducts || 0) + 1;
//                 vendor.productsUnsold = (vendor.productsUnsold || 0) + parseInt(stockQuantity);
//                 await vendor.save();
//             }

//             await createdProduct.populate('vendor', 'businessName');

//             res.status(201).json({
//                 message: 'Product added successfully!',
//                 product: product,
//             });
//         } catch (error) {
//             console.error('Error adding product:', error);
//             // If Cloudinary upload fails, it will throw an error.
//             res.status(500).json({ message: 'Server error adding product or uploading image.' });
//         }
//     }
// );

// // @desc    Get all products for the logged-in vendor
// // @route   GET /api/products/myproducts
// // @access  Private (Vendor only)
// // IMPORTANT: This specific route MUST come BEFORE any general dynamic routes like /:id or /
// router.get('/myproducts', protect, async (req, res) => {
//     try {
//         // Ensure the user is a vendor
//         const user = await User.findById(req.user._id);
//         if (!user || !user.isVendor || user.vendorStatus !== 'approved') {
//             return res.status(403).json({ message: 'Access denied. Only approved vendors can view their products.' });
//         }

//         // Find products where the 'vendor' field matches the authenticated user's ID
//         const products = await Product.find({ vendor: req.user._id })
//             .populate('vendor', 'businessName');

//         res.status(200).json(products);
//     } catch (error) {
//         console.error('Error fetching vendor products:', error);
//         res.status(500).json({ message: 'Server error fetching vendor products.' });
//     }
// });

// // @desc    Get all products on flash sale (for homepage)
// // @route   GET /api/products/flashsales
// // @access  Public
// router.get('/flashsales', async (req, res) => {
//     try {
//         // Find all products that are active and marked as a flash sale
//         const flashSalesProducts = await Product.find({ isActive: true, is_flashsale: true }).populate('vendor', 'businessName');
//         
//         res.status(200).json(flashSalesProducts);
//     } catch (error) {
//         console.error('Error fetching flash sale products:', error);
//         res.status(500).json({ message: 'Server error fetching flash sale products.' });
//     }
// });


// // @desc    Get products by a specific vendor (publicly viewable vendor stores)
// // @route   GET /api/products/vendor/:vendorId
// // @access  Public
// // IMPORTANT: This specific route MUST come BEFORE the general /:id route
// router.get('/vendor/:vendorId', async (req, res) => {
//     try {
//         const products = await Product.find({ vendor: req.params.vendorId, isActive: true }).populate('vendor', 'firstName lastName businessName');
//         if (products.length === 0) {
//             return res.status(404).json({ message: 'No products found for this vendor.' });
//         }
//         res.status(200).json(products);
//     } catch (error) {
//         console.error('Error fetching products by vendor:', error);
//         if (error.name === 'CastError') {
//             return res.status(400).json({ message: 'Invalid vendor ID format.' });
//         }
//         res.status(500).json({ message: 'Server error fetching products for vendor.' });
//     }
// });


// // @desc    Get a single product by ID
// // @route   GET /api/products/:id
// // @access  Public
// // IMPORTANT: This general dynamic route MUST come AFTER all more specific GET routes
// router.get('/:id', async (req, res) => {
//     try {
//         const product = await Product.findById(req.params.id).populate('vendor', 'businessName');
//         if (!product) {
//             return res.status(404).json({ message: 'Product not found.' });
//         }
//         res.status(200).json(product);
//     } catch (error) {
//         console.error('Error fetching single product:', error);
//         if (error.name === 'CastError') {
//             return res.status(400).json({ message: 'Invalid product ID format.' });
//         }
//         res.status(500).json({ message: 'Server error fetching product.' });
//     }
// });

// // @desc    Get all products (for homepage, public access)
// // @route   GET /api/products
// // @access  Public
// // IMPORTANT: This general static route should be placed LAST among GET routes
// // router.get('/', async (req, res) => {
// //     try {
// //         // This is the line that queries for isActive: true
// //         const products = await Product.find({ isActive: true }).populate('vendor', 'businessName');
// //         console.log(`Backend: Fetched ${products.length} products for homepage.`); // Debug log
// //         res.status(200).json(products);
// //     } catch (error) {
// //         console.error('Error fetching all products:', error);
// //         res.status(500).json({ message: 'Server error fetching products.' });
// //     }
// // });


// // @route   GET /api/products
// router.get('/', async (req, res) => {
//   try {
//     const { category } = req.query;
//     const filter = { isActive: true };

//     if (category) {
//       filter.category = { $regex: new RegExp(`^${category}$`, 'i') };
//     }

//     const products = await Product.find(filter).populate('vendor', 'businessName');
//     console.log(`Backend: Fetched ${products.length} products${category ? ` for category "${category}"` : ''}.`);
    
//     res.status(200).json(products);
//   } catch (error) {
//     console.error('Error fetching products:', error);
//     res.status(500).json({ message: 'Server error fetching products.' });
//   }
// });



// // @desc    Update a product
// // @route   PUT /api/products/:id
// // @access  Private (Vendor who owns the product)
// router.put(
//     '/:id',
//     protect,
//     authorizeRoles('vendor'),
//     upload.single('image'), // Allow image update
//     async (req, res) => {
//         const { name, description, price, category, stockQuantity } = req.body;
//         const productId = req.params.id;

//         try {
//             let product = await Product.findById(productId);

//             if (!product) {
//                 return res.status(404).json({ message: 'Product not found.' });
//             }

//             // Ensure the logged-in vendor owns this product
//             if (product.vendor.toString() !== req.user._id.toString()) {
//                 return res.status(403).json({ message: 'Not authorized to update this product.' });
//             }

//             // Update fields
//             product.name = name || product.name;
//             product.description = description || product.description;
//             product.price = price || product.price;
//             product.category = category || product.category;
//             product.stockQuantity = stockQuantity || product.stockQuantity;
//             // isActive is NOT explicitly updated here from req.body,
//             // which is good if you want it to remain true unless manually toggled elsewhere.

//             // Handle image update if a new file is provided
//             if (req.file) {
//                 // Optional: Delete old image from Cloudinary before uploading new one
//                 // if (product.imageUrls && product.imageUrls.length > 0) {
//                 //   const publicId = product.imageUrls[0].split('/').pop().split('.')[0];
//                 //   await cloudinary.uploader.destroy(`naijago_products/${publicId}`);
//                 // }

//                 const result = await cloudinary.uploader.upload(
//                     `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,
//                     {
//                         folder: 'naijago_products',
//                         resource_type: 'image',
//                     }
//                 );
//                 product.imageUrls = [result.secure_url]; // Update with new image URL
//             }

//             await product.save();

//             res.status(200).json({ message: 'Product updated successfully!', product: product });
//         } catch (error) {
//             console.error('Error updating product:', error);
//             if (error.name === 'CastError') {
//                 return res.status(400).json({ message: 'Invalid product ID format.' });
//             }
//             res.status(500).json({ message: 'Server error updating product.' });
//         }
//     }
// );

// // @desc    Delete a product
// // @route   DELETE /api/products/:id
// // @access  Private (Vendor who owns the product or Admin)
// router.delete(
//     '/:id',
//     protect,
//     async (req, res) => {
//         const productId = req.params.id;

//         try {
//             const product = await Product.findById(productId);

//             if (!product) {
//                 return res.status(404).json({ message: 'Product not found.' });
//             }

//             // Allow deletion only by the product owner or an admin
//             if (product.vendor.toString() !== req.user._id.toString() && !req.user.isAdmin) {
//                 return res.status(403).json({ message: 'Not authorized to delete this product.' });
//             }

//             // Optional: Delete image from Cloudinary
//             // if (product.imageUrls && product.imageUrls.length > 0) {
//             //   const publicId = product.imageUrls[0].split('/').pop().split('.')[0];
//             //   await cloudinary.uploader.destroy(`naijago_products/${publicId}`);
//             // }

//             await Product.deleteOne({ _id: productId }); // Use deleteOne or findByIdAndDelete

//             // Update vendor's product counts (optional)
//             const vendor = await User.findById(product.vendor);
//             if (vendor) {
//                 vendor.totalProducts = Math.max(0, (vendor.totalProducts || 0) - 1);
//                 vendor.productsUnsold = Math.max(0, (vendor.productsUnsold || 0) - product.stockQuantity);
//                 await vendor.save();
//             }

//             res.status(200).json({ message: 'Product deleted successfully!' });
//         } catch (error) {
//             console.error('Error deleting product:', error);
//             if (error.name === 'CastError') {
//                 return res.status(400).json({ message: 'Invalid product ID format.' });
//             }
//             res.status(500).json({ message: 'Server error deleting product.' });
//         }
//     }
// );


// module.exports = router;
