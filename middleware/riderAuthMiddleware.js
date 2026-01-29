// middleware/riderAuthMiddleware.js
const jwt = require('jsonwebtoken');
const Rider = require('../models/Rider');

// --- Middleware specifically for rider authentication ---
const riderProtect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            // Only look for rider (not regular user)
            const rider = await Rider.findById(decoded.id).select('-password');

            if (!rider) {
                return res.status(401).json({ 
                    success: false,
                    message: 'Not authorized, rider account not found' 
                });
            }

            // Check if rider is approved
            if (rider.status !== 'approved') {
                return res.status(403).json({
                    success: false,
                    message: `Rider account is ${rider.status}. Please contact admin.`,
                    status: rider.status
                });
            }

            // Check if rider is suspended
            if (rider.status === 'suspended') {
                return res.status(403).json({
                    success: false,
                    message: 'Rider account is suspended. Please contact support.',
                    status: 'suspended'
                });
            }

            // Attach the rider to the request object with normalized fields
            req.rider = {
                _id: rider._id,
                id: rider._id,
                fullName: rider.fullName,
                email: rider.email,
                phoneNumber: rider.phoneNumber,
                plateNumber: rider.plateNumber,
                status: rider.status,
                isActive: rider.isActive,
                isAvailable: rider.isAvailable,
                walletBalance: rider.walletBalance,
                currentLocation: rider.currentLocation,
                // For compatibility with existing code
                role: 'rider'
            };
            
            console.log(`RiderAuth: ${rider.fullName} (${rider._id}) authenticated`);
            
            next();
        } catch (error) {
            console.error('Rider token verification failed:', error);
            res.status(401).json({ 
                success: false,
                message: 'Not authorized, token failed' 
            });
        }
    } else {
        res.status(401).json({ 
            success: false,
            message: 'Not authorized, no token provided' 
        });
    }
};

module.exports = { riderProtect };