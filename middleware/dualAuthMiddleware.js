// middleware/dualAuthMiddleware.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Rider = require('../models/Rider');

// --- Middleware for both user and rider authentication ---
const dualProtect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            let user = null;
            let isRider = false;
            
            // Try to find in User collection first
            user = await User.findById(decoded.id).select('-password');
            
            // If not found, try Rider collection
            if (!user) {
                user = await Rider.findById(decoded.id).select('-password');
                isRider = true;
            }

            if (!user) {
                return res.status(401).json({ 
                    success: false,
                    message: 'Not authorized, account not found' 
                });
            }

            // Normalize the user object
            req.dualUser = {
                _id: user._id,
                id: user._id,
                email: user.email,
                role: isRider ? 'rider' : (user.role || 'user'),
                isRider: isRider,
                // User fields
                firstName: user.firstName || user.fullName?.split(' ')[0] || '',
                lastName: user.lastName || user.fullName?.split(' ').slice(1).join(' ') || '',
                fullName: user.fullName || `${user.firstName || ''} ${user.lastName || ''}`.trim(),
                isAdmin: user.isAdmin || false,
                isVendor: user.isVendor || false,
                // Rider-specific fields
                plateNumber: user.plateNumber || null,
                walletBalance: user.walletBalance || user.userWalletBalance || 0,
                // Store the actual user object for the routes to use
                originalUser: user,
                isRider: isRider
            };
            
            // CRITICAL: Set req.user for backward compatibility with existing routes
            req.user = req.dualUser;
            
            console.log(`DualAuth: ${req.dualUser.fullName} (${req.dualUser.role}) authenticated`);
            
            next();
        } catch (error) {
            console.error('Dual token verification failed:', error);
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

module.exports = { dualProtect };