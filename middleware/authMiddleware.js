const jwt = require('jsonwebtoken');
const User = require('../models/User'); 
const Rider = require('../models/Rider'); // NEW: Import Rider model

// --- Middleware for protecting routes (authentication) ---
const protect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            // 1. Try to find the user in the User collection first
            let user = await User.findById(decoded.id).select('-password');
            
            // 2. If not found in User, look in the Rider collection
            if (!user) {
                user = await Rider.findById(decoded.id).select('-password');
            }

            if (!user) {
                return res.status(401).json({ message: 'Not authorized, account not found' });
            }

            // Attach the found user (or rider) to the request object
            req.user = user;
            next();
        } catch (error) {
            console.error('Token verification failed:', error);
            res.status(401).json({ message: 'Not authorized, token failed' });
        }
    } else {
        res.status(401).json({ message: 'Not authorized, no token provided' });
    }
};

// --- Middleware for authorizing roles ---
const authorizeRoles = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ message: 'Not authorized, no user found' });
        }

        let isAuthorized = false;

        for (const role of roles) {
            // Check User roles
            if (role === 'admin' && req.user.isAdmin) {
                isAuthorized = true;
                break;
            }
            if (role === 'vendor' && req.user.isVendor) {
                isAuthorized = true;
                break;
            }
            // Check Rider role (Riders are verified based on their model type or a specific flag)
            // Since they come from the Rider model, we check if they have a plateNumber (unique to riders) 
            // or you can check if they have a 'rider' role.
            if (role === 'dispatch' && (req.user.plateNumber || req.user.role === 'dispatch')) {
                isAuthorized = true;
                break;
            }
        }

        if (!isAuthorized) {
            return res.status(403).json({ message: `Access denied. Requires: ${roles.join(', ')}.` });
        }

        next();
    };
};

module.exports = { protect, authorizeRoles };