const jwt = require('jsonwebtoken'); // Import jsonwebtoken for token verification
const User = require('../models/User'); // Import the User model

// --- Middleware for protecting routes (authentication) ---
const protect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.user = await User.findById(decoded.id).select('-password');

            if (!req.user) {
                return res.status(401).json({ message: 'Not authorized, user not found for token' });
            }

            next();
        } catch (error) {
            console.error('Token verification failed:', error);
            res.status(401).json({ message: 'Not authorized, token failed' });
        }
    } else {
        res.status(401).json({ message: 'Not authorized, no token provided' });
    }
};

// --- Corrected Middleware for authorizing roles ---
const authorizeRoles = (...roles) => {
    return (req, res, next) => {
        // Ensure the protect middleware has run and attached a user to the request
        if (!req.user) {
            return res.status(401).json({ message: 'Not authorized, no user found (protect middleware missing or failed)' });
        }

        let isAuthorized = false;

        // Iterate through the roles required by the route
        for (const role of roles) {
            // Check the specific boolean flag on the user object
            if (role === 'admin' && req.user.isAdmin) {
                isAuthorized = true;
                break;
            }
            if (role === 'vendor' && req.user.isVendor) {
                isAuthorized = true;
                break;
            }
            // Add more roles if needed in the future
        }

        if (!isAuthorized) {
            return res.status(403).json({ message: `Not authorized. User does not have the required role(s): ${roles.join(', ')}.` });
        }

        next();
    };
};

module.exports = { protect, authorizeRoles };