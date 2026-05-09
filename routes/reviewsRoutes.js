// ... (existing imports like mongoose, express, protect, Review, Product, User) ...
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const Review = require('../models/Review');
const Product = require('../models/Product'); // Ensure Product model is imported
const User = require('../models/User'); // Ensure User model is imported
const Shipment = require('../models/Shipment');
const MainOrder = require('../models/MainOrder');

// @desc    Get all reviews by the logged-in user
// @route   GET /api/reviews/myreviews
// @access  Private
router.get('/myreviews', protect, async (req, res) => {
    try {
        const reviews = await Review.find({ user: req.user._id })
            .populate('product', 'name imageUrls') // Populate product name and images
            .populate('user', 'firstName lastName'); // Populate user's first and last name

        res.status(200).json(reviews);
    } catch (error) {
        console.error('Error fetching user reviews:', error);
        res.status(500).json({ message: 'Server error fetching reviews.' });
    }
});

// @desc    Submit a new review for a product
// @route   POST /api/reviews
// @access  Private (User)
router.post('/', protect, async (req, res) => {
    const { productId, rating, comment } = req.body;

    // Basic validation
    if (!productId || !rating || !comment) {
        return res.status(400).json({ message: 'Please provide product ID, rating, and comment.' });
    }
    if (rating < 1 || rating > 5) {
        return res.status(400).json({ message: 'Rating must be between 1 and 5.' });
    }

    try {
        const product = await Product.findById(productId);
        if (!product) {
            return res.status(404).json({ message: 'Product not found.' });
        }

        // Optional: Check if the user has already reviewed this product
        const alreadyReviewed = await Review.findOne({
            product: productId,
            user: req.user._id,
        });

        if (alreadyReviewed) {
            return res.status(400).json({ message: 'You have already reviewed this product.' });
        }

        const paidOrderIds = await MainOrder.find({
            user: req.user._id,
            isPaid: true,
            mainOrderStatus: { $ne: 'cancelled' },
        }).select('_id').lean();

        const purchasedShipment = paidOrderIds.length > 0
            ? await Shipment.exists({
                mainOrder: { $in: paidOrderIds.map((order) => order._id) },
                'items.product': productId,
                shipmentStatus: { $nin: ['cancelled', 'rejected'] },
            })
            : null;

        if (!purchasedShipment) {
            return res.status(403).json({ message: 'You can only review products you have purchased.' });
        }


        const review = new Review({
            product: productId,
            user: req.user._id,
            rating,
            comment,
        });

        await review.save();

        // Optional: Update product's average rating and number of reviews
        // This is important for displaying product ratings on the frontend
        const productReviews = await Review.find({ product: productId });
        const totalRatings = productReviews.reduce((acc, item) => item.rating + acc, 0);
        product.numReviews = productReviews.length;
        product.averageRating = totalRatings / productReviews.length;
        await product.save();


        res.status(201).json({ message: 'Review added successfully!', review });
    } catch (error) {
        console.error('Error submitting review:', error);
        res.status(500).json({ message: 'Server error submitting review.' });
    }
});

module.exports = router;
