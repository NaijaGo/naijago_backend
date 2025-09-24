const express = require('express');
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Resend } = require('resend');
const bcrypt = require('bcryptjs');
const { protect } = require('../middleware/authMiddleware'); // Import 'protect' middleware
const fs = require('fs'); // For file system operations (saving images)
const path = require('path'); // For path manipulation
const Product = require('../models/Product');
const Review = require('../models/Review');
const DisputeRequest = require('../models/DisputeRequest');
const ReturnRequest = require('../models/ReturnRequest');


const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);
const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

// --- Helper Function: Generate JWT Token ---
const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: '30d',
    });
};

// --- Helper Function: Send Verification Email ---
const sendVerificationEmail = async (email, token, type) => {
    const verificationLink = (type === 'password')
        ? `${BASE_URL}/api/auth/reset-password-form/${token}`
        : `${BASE_URL}/api/auth/${type}/verify/${token}`;

    let subject, htmlContent, textContent;

    switch (type) {
    case 'email':
        subject = 'NaijaGo: Email Verification';
        htmlContent = `
        <div style="font-family: Arial, sans-serif; background: #f9fafb; padding: 20px; text-align: center; color: #333;">
            <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); padding: 30px;">
                <img src="https://naijago-backend.onrender.com/najago-app.jpg" alt="NaijaGo" style="width: 120px; margin-bottom: 20px; border-radius:60px" />
                <h2 style="color: #2563eb; margin-bottom: 10px;">Verify Your Email</h2>
                <p style="font-size: 16px; margin-bottom: 25px;">
                    Please verify your email for <strong>NaijaGo</strong> by clicking the button below.
                </p>
                <a href="${verificationLink}" 
                   style="display: inline-block; background: #16a34a; color: #fff; text-decoration: none; 
                          padding: 12px 24px; font-size: 16px; font-weight: bold; border-radius: 8px;">
                    Verify Email
                </a>
                <p style="font-size: 14px; color: #666; margin-top: 20px;">
                    This link will expire in <strong>24 hours</strong>.
                </p>
            </div>
        </div>`;
        textContent = `Please verify your email for NaijaGo by clicking the link: ${verificationLink}. This link will expire in 24 hours.`;
        break;

    case 'password':
        subject = 'NaijaGo: Password Reset Request';
        htmlContent = `
        <div style="font-family: Arial, sans-serif; background: #f9fafb; padding: 20px; text-align: center; color: #333;">
            <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); padding: 30px;">
                <img src="https://naijago-backend.onrender.com/najago-app.jpg" alt="NaijaGo" style="width: 120px; margin-bottom: 20px; border-radius:60px" />
                <h2 style="color: #dc2626; margin-bottom: 10px;">Password Reset Request</h2>
                <p style="font-size: 16px; margin-bottom: 25px;">
                    You are receiving this because you (or someone else) requested a password reset for your account.
                </p>
                <a href="${verificationLink}" 
                   style="display: inline-block; background: #dc2626; color: #fff; text-decoration: none; 
                          padding: 12px 24px; font-size: 16px; font-weight: bold; border-radius: 8px;">
                    Reset Password
                </a>
                <p style="font-size: 14px; color: #666; margin-top: 20px;">
                    This link will expire in <strong>1 hour</strong>. If you did not request this, please ignore it.
                </p>
            </div>
        </div>`;
        textContent = `You requested a password reset. Click the link: ${verificationLink}. This link will expire in 1 hour. If you did not request this, ignore this email.`;
        break;

    case 'device':
        subject = 'NaijaGo: Device Verification';
        htmlContent = `
        <div style="font-family: Arial, sans-serif; background: #f9fafb; padding: 20px; text-align: center; color: #333;">
            <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); padding: 30px;">
                <img src="https://naijago-backend.onrender.com/najago-app.jpg" alt="NaijaGo" style="width: 120px; margin-bottom: 20px; border-radius:60px" />
                <h2 style="color: #0891b2; margin-bottom: 10px;">New Device Verification</h2>
                <p style="font-size: 16px; margin-bottom: 25px;">
                    A new device is trying to access your <strong>NaijaGo</strong> account. Please verify it by clicking the button below.
                </p>
                <a href="${verificationLink}" 
                   style="display: inline-block; background: #0891b2; color: #fff; text-decoration: none; 
                          padding: 12px 24px; font-size: 16px; font-weight: bold; border-radius: 8px;">
                    Verify Device
                </a>
                <p style="font-size: 14px; color: #666; margin-top: 20px;">
                    This link will expire in <strong>24 hours</strong>.
                </p>
            </div>
        </div>`;
        textContent = `Please verify your new device by clicking on this link: ${verificationLink}. This link will expire in 24 hours.`;
        break;

    default:
        throw new Error('Unsupported verification type');
}


    try {
        const { data, error } = await resend.emails.send({
            from: 'NaijaGo <noreply@naijagoapp.com>',
            to: email,
            subject: subject,
            html: htmlContent,
            text: textContent,
        });

        if (error) {
            console.error('Resend email error:', error);
            throw new Error(`Failed to send email via Resend: ${error.message}`);
        }
        console.log('Resend email sent successfully:', data);
    } catch (error) {
        console.error('Error sending email with Resend:', error);
        throw error;
    }
};

// --- Route 1: User Registration ---
router.post('/register', async (req, res) => {
    const { firstName, lastName, email, phoneNumber, password } = req.body;
    if (!firstName || !lastName || !email || !phoneNumber || !password) {
        return res.status(400).json({ message: 'Please enter all fields' });
    }
    try {
        let user = await User.findOne({ $or: [{ email }, { phoneNumber }] });
        if (user) {
            return res.status(400).json({ message: 'User with this email or phone number already exists' });
        }
        user = new User({
            firstName, lastName, email, phoneNumber, password,
        });
        const verificationToken = crypto.randomBytes(32).toString('hex');
        user.emailVerificationToken = verificationToken;
        user.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000;
        await user.save();

        try {
            await sendVerificationEmail(user.email, verificationToken, 'email');
        } catch (emailError) {
            console.error("Email sending failed:", emailError);
            await User.findByIdAndDelete(user._id); // rollback user if email fails
            return res.status(500).json({
                message: emailError?.response?.body?.error?.message || emailError.message || "Email sending failed"
            });
        }

        res.status(201).json({
            message: 'User registered successfully. Please check your email for verification.',
            userId: user._id, email: user.email,
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ message: error.message || 'Server error during registration' });
    }
});


// --- Route 2: Email Verification ---
router.get('/email/verify/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const user = await User.findOne({
            emailVerificationToken: token,
            emailVerificationExpires: { $gt: Date.now() },
        });
        if (!user) {
            return res.status(400).send('Email verification link is invalid or has expired.');
        }
        user.isEmailVerified = true;
        user.emailVerificationToken = undefined;
        user.emailVerificationExpires = undefined;
        await user.save();
        res.status(200).send('Email successfully verified! You can now close this page and log in to the app.');
    } catch (error) {
        console.error('Email verification error:', error);
        res.status(500).send('Server error during email verification.');
    }
});

// --- Route 3: User Login ---
router.post('/login', async (req, res) => {
    const { email, password, deviceFingerprint } = req.body;
    if (!email || !password) {
        return res.status(400).json({ message: 'Please enter all fields' });
    }
    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ message: 'Invalid credentials' });
        }
        if (!user.isEmailVerified) {
            return res.status(403).json({ message: 'Please verify your email before logging in.' });
        }
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid credentials' });
        }

        // NEW LOGIC: If the user is an admin, bypass device verification for development convenience
        if (user.isAdmin) {
            // For admin users, if deviceFingerprint is provided, update it.
            // This ensures the admin's device fingerprint is recorded for the browser they are using.
            if (deviceFingerprint && user.deviceFingerprint !== deviceFingerprint) {
                user.deviceFingerprint = deviceFingerprint;
                user.isDeviceVerified = true; // Mark as verified for this new device
                await user.save();
            }
            // Proceed with login for admin without device verification email
            return res.status(200).json({
                token: generateToken(user._id),
                user: {
                    id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email,
                    phoneNumber: user.phoneNumber, isEmailVerified: user.isEmailVerified, isAdmin: user.isAdmin,
                    isVendor: user.isVendor, vendorStatus: user.vendorStatus // Include vendor status for admin
                },
                message: 'Admin login successful. Device verification bypassed for convenience.',
            });
        }

        // Existing Device Verification Logic (for non-admin users)
        if (!user.deviceFingerprint) {
            user.deviceFingerprint = deviceFingerprint;
            await user.save();
            res.status(200).json({
                token: generateToken(user._id),
                user: {
                    id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email,
                    phoneNumber: user.phoneNumber, isEmailVerified: user.isEmailVerified,
                    isVendor: user.isVendor, vendorStatus: user.vendorStatus // Include vendor status for regular users
                },
                message: 'Login successful. Device captured as original.',
            });
        } else {
            if (user.deviceFingerprint !== deviceFingerprint) {
                const deviceVerificationToken = crypto.randomBytes(32).toString('hex');
                user.deviceVerificationToken = deviceVerificationToken;
                user.deviceVerificationExpires = Date.now() + 24 * 60 * 60 * 1000;
                await user.save();
                return res.status(403).json({
                    message: 'New device detected. Please check your email to verify this device.',
                });
            } else {
                res.status(200).json({
                    token: generateToken(user._id),
                    user: {
                        id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email,
                        phoneNumber: user.phoneNumber, isEmailVerified: user.isEmailVerified,
                        isVendor: user.isVendor, vendorStatus: user.vendorStatus // Include vendor status for regular users
                    },
                    message: 'Login successful from original device.',
                });
            }
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error during login' });
    }
});

// @desc    Get current authenticated user profile
// @route   GET /api/auth/me
// @access  Private
router.get('/me', protect, async (req, res) => {
    console.log('Backend: /api/auth/me route hit. User ID:', req.user?._id); // DEBUG LOG
    try {
        // req.user is populated by the 'protect' middleware
        // Select all fields relevant to the user's profile, including new vendor/wallet/notification fields
        const user = await User.findById(req.user._id).select(
            '-password -emailVerificationToken -emailVerificationExpires -deviceVerificationToken -deviceVerificationExpires -passwordResetToken -passwordResetExpires'
        );

        if (!user) {
            console.error('Backend: User not found in DB for /me route, ID:', req.user?._id); // DEBUG LOG
            return res.status(404).json({ message: 'User not found.' });
        }

        // Return the user object, which now includes all the new fields
        res.status(200).json(user);
    } catch (error) {
        console.error('Backend: Error fetching user profile in /me route:', error); // DEBUG LOG
        res.status(500).json({ message: 'Server error fetching user profile.' });
    }
});

// @desc    Delete a user account and all associated data
// @route   DELETE /api/auth/delete-account
// @access  Private
router.delete('/delete-account', protect, async (req, res) => {
    try {
        const userId = req.user._id;

        // 1. Find the user to check their role before deletion
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // 2. Perform Cascading Deletion for all related documents

        // If the user is a vendor, delete all their products
        if (user.isVendor) {
            console.log(`Deleting all products for vendor: ${userId}`);
            await Product.deleteMany({ vendor: userId });
        }

        // Delete all reviews submitted by this user
        console.log(`Deleting all reviews for user: ${userId}`);
        await Review.deleteMany({ user: userId });

        // Delete all dispute requests created by this user
        console.log(`Deleting all dispute requests for user: ${userId}`);
        await DisputeRequest.deleteMany({ user: userId });

        // Delete all return requests created by this user
        console.log(`Deleting all return requests for user: ${userId}`);
        await ReturnRequest.deleteMany({ user: userId });

        // 3. Finally, delete the user account itself
        await User.findByIdAndDelete(userId);

        res.status(200).json({ message: 'Account and all associated data successfully deleted.' });
        
    } catch (error) {
        console.error('Error during account deletion:', error);
        res.status(500).json({ message: 'Server error during account deletion.' });
    }
});

// @desc    Vendor desists from being a vendor
// @route   PUT /api/auth/desist-vendor
// @access  Private (Vendor only)
router.put('/desist-vendor', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        if (!user.isVendor) {
            return res.status(400).json({ message: 'You are not currently an approved vendor.' });
        }

        // Reset vendor status
        user.isVendor = false;
        user.vendorStatus = 'none'; // Or 'desisted', depending on desired future flow
        user.vendorRequestDate = undefined;
        user.vendorRejectionDate = undefined;
        user.businessName = undefined;
        user.businessCategories = [];
        user.profilePicUrl = undefined;
        user.totalProducts = 0;
        user.productsSold = 0;
        user.productsUnsold = 0;
        user.followersCount = 0;
        // Optionally, handle wallet balances:
        // user.vendorWalletBalance = 0; // Decide if balance should be reset or transferred
        // user.appWalletBalance = 0;   // Decide if balance should be reset or transferred
        // For now, let's keep balances as they are, but clear vendor-specific data

        await user.save();

        res.status(200).json({ message: 'You have successfully desisted from being a vendor. Your vendor privileges have been revoked.', isVendor: false, vendorStatus: 'none' });

    } catch (error) {
        console.error('Error during vendor desist process:', error);
        res.status(500).json({ message: 'Server error during vendor desist process.' });
    }
});


// --- Route 4: Device Verification ---
router.get('/device/verify/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const user = await User.findOne({
            deviceVerificationToken: token,
            deviceVerificationExpires: { $gt: Date.now() },
        });
        if (!user) {
            return res.status(400).send('Invalid or expired device verification token.');
        }
        user.deviceVerificationToken = undefined;
        user.deviceVerificationExpires = undefined;
        await user.save();
        res.status(200).send('Device successfully verified! You can now close this page and log in to the app.');
    } catch (error) {
        console.error('Device verification error:', error);
        res.status(500).send('Server error during device verification.');
    }
});

// --- Route 5: Forgot Password Request ---
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(200).json({ message: 'If an account with that email exists, a password reset link has been sent.' });
        }
        const resetToken = crypto.randomBytes(32).toString('hex');
        user.passwordResetToken = resetToken;
        user.passwordResetExpires = Date.now() + 3600000; // 1 hour
        await user.save();
        await sendVerificationEmail(user.email, resetToken, 'password');
        res.status(200).json({ message: 'If an account with that email exists, a password reset link has been sent.' });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ message: 'Server error during password reset request.' });
    }
});

// --- Route 6: Render Password Reset Form (GET request from email link) ---
router.get('/reset-password-form/:token', async (req, res) => {
    const { token } = req.params;
    try {
        const user = await User.findOne({
            passwordResetToken: token,
            passwordResetExpires: { $gt: Date.now() },
        });
        if (!user) {
            return res.status(400).send('<h1>Invalid or Expired Password Reset Link</h1><p>The link you clicked is either invalid or has expired. Please request a new password reset.</p>');
        }
        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Reset Your Password</title>
                <style>
                    body { font-family: Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
                    .container { background-color: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); width: 100%; max-width: 400px; text-align: center; }
                    h1 { color: #000080; margin-bottom: 20px; }
                    input[type="password"] { width: calc(100% - 20px); padding: 10px; margin-bottom: 15px; border: 1px solid #ddd; border-radius: 4px; }
                    button { background-color: #000080; color: white; padding: 12px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; width: 100%; }
                    button:hover { background-color: #000066; }
                    .message { margin-top: 15px; font-weight: bold; }
                    .success { color: green; }
                    .error { color: red; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Reset Your Password</h1>
                    <form id="resetForm" action="${BASE_URL}/api/auth/reset-password-submit" method="POST">
                        <input type="hidden" name="token" value="${token}">
                        <input type="password" name="newPassword" placeholder="Enter new password" required>
                        <input type="password" name="confirmNewPassword" placeholder="Confirm new password" required>
                        <button type="submit">Reset Password</button>
                    </form>
                    <div id="message" class="message"></div>
                </div>
                <script>
                    document.getElementById('resetForm').addEventListener('submit', async function(event) {
                        event.preventDefault();
                        const form = event.target;
                        const newPassword = form.newPassword.value;
                        const confirmNewPassword = form.confirmNewPassword.value;
                        const messageDiv = document.getElementById('message');

                        if (newPassword !== confirmNewPassword) {
                            messageDiv.className = 'message error';
                            messageDiv.textContent = 'Passwords do not match!';
                            return;
                        }

                        try {
                            const response = await fetch(form.action, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ token: form.token.value, newPassword: newPassword })
                            });
                            const data = await response.json();
                            if (response.ok) {
                                messageDiv.className = 'message success';
                                messageDiv.textContent = data.message || 'Password reset successfully!';
                                form.reset(); // Clear the form
                            } else {
                                messageDiv.className = 'message error';
                                messageDiv.textContent = data.message || 'Failed to reset password.';
                            }
                        } catch (error) {
                            console.error('Error:', error);
                            messageDiv.className = 'message error';
                            messageDiv.textContent = 'An error occurred while resetting password.';
                        }
                    });
                </script>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('Error rendering reset password form:', error);
        res.status(500).send('Server error when trying to render password reset form.');
    }
});

// --- Route 7: Submit New Password (POST request from the HTML form) ---
router.post('/reset-password-submit', async (req, res) => {
    const { token, newPassword } = req.body;
    if (!newPassword || !token) {
        return res.status(400).json({ message: 'New password and token are required.' });
    }
    try {
        const user = await User.findOne({
            passwordResetToken: token,
            passwordResetExpires: { $gt: Date.now() },
        });
        if (!user) {
            return res.status(400).json({ message: 'Password reset link is invalid or has expired.' });
        }
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        user.passwordResetToken = undefined;
        user.passwordResetExpires = undefined;
        await user.save();
        res.status(200).json({ message: 'Password has been reset successfully. You can now log in with your new password.' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ message: 'Server error during password reset.' });
    }
});

// @desc    Mark a user's notification as read
// @route   PUT /api/auth/notifications/mark-read/:notificationId
// @access  Private
router.put('/notifications/mark-read/:notificationId', protect, async (req, res) => {
    try {
        const { notificationId } = req.params;
        const userId = req.user._id;

        // Find the user and update the specific notification within their array
        const user = await User.findOneAndUpdate(
            {
                _id: userId,
                'notifications._id': notificationId // Find the notification by its ID within the array
            },
            {
                '$set': { 'notifications.$.read': true } // Set 'read' to true for the matched notification
            },
            { new: true } // Return the updated document
        );

        if (!user) {
            return res.status(404).json({ message: 'User or notification not found.' });
        }

        res.status(200).json({ message: 'Notification marked as read successfully.' });

    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ message: 'Server error marking notification as read.' });
    }
});

// @desc    Get user's saved items (wishlist)
// @route   GET /api/auth/saved-items
// @access  Private
router.get('/saved-items', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).populate('savedItems'); // Populate saved product details
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }
        res.status(200).json({ savedItems: user.savedItems });
    } catch (error) {
        console.error('Error fetching saved items:', error);
        res.status(500).json({ message: 'Server error fetching saved items.' });
    }
});


router.post('/saved-items', protect, async (req, res) => {
    const { productId } = req.body;

    if (!productId) {
        return res.status(400).json({ message: 'Product ID is required.' });
    }

    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Check if product already exists in saved items
        if (user.savedItems.includes(productId)) {
            return res.status(400).json({ message: 'Product already in saved items.' });
        }

        user.savedItems.push(productId);
        await user.save();

        res.status(200).json({ message: 'Product added to saved items.', savedItems: user.savedItems });
    } catch (error) {
        console.error('Error adding product to saved items:', error);
        res.status(500).json({ message: 'Server error adding product to saved items.' });
    }
});

// @desc    Remove a product from user's saved items (wishlist)
// @route   DELETE /api/auth/saved-items/:productId
// @access  Private
router.delete('/saved-items/:productId', protect, async (req, res) => {
    const { productId } = req.params;

    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Filter out the product to be removed
        const initialLength = user.savedItems.length;
        user.savedItems = user.savedItems.filter(item => item.toString() !== productId);

        if (user.savedItems.length === initialLength) {
            return res.status(404).json({ message: 'Product not found in saved items.' });
        }

        await user.save();

        res.status(200).json({ message: 'Product removed from saved items.', savedItems: user.savedItems });
    } catch (error) {
        console.error('Error removing product from saved items:', error);
        res.status(500).json({ message: 'Server error removing product from saved items.' });
    }
});

// @desc    Add a new delivery address for the user
// @route   POST /api/auth/addresses
// @access  Private
router.post('/addresses', protect, async (req, res) => {
    const { address, city, postalCode, country, isDefault } = req.body;

    if (!address || !city || !postalCode || !country) {
        return res.status(400).json({ message: 'All address fields are required.' });
    }

    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // If new address is set as default, clear default from others
        if (isDefault) {
            user.deliveryAddresses.forEach(addr => addr.isDefault = false);
        } else if (user.deliveryAddresses.length === 0) {
            // If this is the first address, make it default
            // Note: isDefault is a boolean, so directly assign true
            req.body.isDefault = true; // Modify req.body to reflect this for the push
        }

        user.deliveryAddresses.push({ address, city, postalCode, country, isDefault: req.body.isDefault });
        await user.save();

        res.status(201).json({ message: 'Address added successfully.', addresses: user.deliveryAddresses });
    } catch (error) {
        console.error('Error adding delivery address:', error);
        res.status(500).json({ message: 'Server error adding delivery address.' });
    }
});

// @desc    Update an existing delivery address
// @route   PUT /api/auth/addresses/:index
// @access  Private
router.put('/addresses/:index', protect, async (req, res) => {
    const { index } = req.params; // Index of the address in the array
    const { address, city, postalCode, country, isDefault } = req.body;

    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const addressIndex = parseInt(index);
        if (isNaN(addressIndex) || addressIndex < 0 || addressIndex >= user.deliveryAddresses.length) {
            return res.status(400).json({ message: 'Invalid address index.' });
        }

        // If this address is set as default, clear default from others
        if (isDefault) {
            user.deliveryAddresses.forEach(addr => addr.isDefault = false);
        }

        const targetAddress = user.deliveryAddresses[addressIndex];
        targetAddress.address = address || targetAddress.address;
        targetAddress.city = city || targetAddress.city;
        targetAddress.postalCode = postalCode || targetAddress.postalCode;
        targetAddress.country = country || targetAddress.country;
        targetAddress.isDefault = isDefault !== undefined ? isDefault : targetAddress.isDefault;

        await user.save(); // Mongoose will detect changes in subdocuments and save

        res.status(200).json({ message: 'Address updated successfully.', addresses: user.deliveryAddresses });
    } catch (error) {
        console.error('Error updating delivery address:', error);
        res.status(500).json({ message: 'Server error updating delivery address.' });
    }
});

// @desc    Delete a delivery address
// @route   DELETE /api/auth/addresses/:index
// @access  Private
router.delete('/addresses/:index', protect, async (req, res) => {
    const { index } = req.params;

    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const addressIndex = parseInt(index);
        if (isNaN(addressIndex) || addressIndex < 0 || addressIndex >= user.deliveryAddresses.length) {
            return res.status(400).json({ message: 'Invalid address index.' });
        }

        const deletedAddress = user.deliveryAddresses.splice(addressIndex, 1); // Remove 1 element at index

        // If the deleted address was default, and there are other addresses, set the first one as default
        if (deletedAddress[0].isDefault && user.deliveryAddresses.length > 0) {
            user.deliveryAddresses[0].isDefault = true;
        }

        await user.save();

        res.status(200).json({ message: 'Address deleted successfully.', addresses: user.deliveryAddresses });
    } catch (error) {
        console.error('Error deleting delivery address:', error);
        res.status(500).json({ message: 'Server error deleting delivery address.' });
    }
});

// @desc    Update user profile (first name, last name, email, phone, profile pic)
// @route   PUT /api/auth/profile
// @access  Private
router.put('/profile', protect, async (req, res) => {
    const { firstName, lastName, email, phoneNumber, profilePicBase64 } = req.body;

    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Update basic profile fields
        user.firstName = firstName || user.firstName;
        user.lastName = lastName || user.lastName;
        user.phoneNumber = phoneNumber || user.phoneNumber;

        // Only update email if it's different and not already taken by another user
        if (email && email !== user.email) {
            const emailExists = await User.findOne({ email });
            if (emailExists && emailExists._id.toString() !== user._id.toString()) {
                return res.status(400).json({ message: 'Email already in use by another account.' });
            }
            user.email = email;
            // You might want to set isEmailVerified to false here and trigger re-verification
            // For now, we'll assume email change doesn't invalidate verification without explicit logic
        }

        // Handle profile picture upload if base64 data is provided
        if (profilePicBase64) {
            // It's highly recommended to use Cloudinary for profile pictures too,
            // similar to how product images are handled.
            // For local storage (as currently implemented):
            const base64Data = profilePicBase64.replace(/^data:image\/\w+;base64,/, "");
            const buffer = Buffer.from(base64Data, 'base64');
            const fileName = `profile_${user._id}_${Date.now()}.png`; // Unique filename
            const uploadDir = path.join(__dirname, '../uploads/profile_pics'); // Define upload directory

            // Create directory if it doesn't exist
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }

            const filePath = path.join(uploadDir, fileName);
            fs.writeFileSync(filePath, buffer);

            // Store the relative URL in the database
            user.profilePicUrl = `/uploads/profile_pics/${fileName}`;
        }

        await user.save();

        // Respond with updated user data (excluding sensitive info)
        const updatedUser = await User.findById(req.user._id).select('-password -emailVerificationToken -emailVerificationExpires -deviceVerificationToken -deviceVerificationExpires -passwordResetToken -passwordResetExpires');

        res.status(200).json({
            message: 'Profile updated successfully!',
            user: updatedUser
        });

    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({ message: 'Server error updating profile.' });
    }
});


module.exports = router;
