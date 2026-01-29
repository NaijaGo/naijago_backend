
// routes/walletRoutes.js
const express = require('express');
const crypto = require('crypto'); 
const router = express.Router();
const axios = require('axios');
const User = require('../models/User');
const Rider = require('../models/Rider');
const Payment = require('../models/Payment');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const { dualProtect } = require('../middleware/dualAuthMiddleware');
const dotenv = require('dotenv');
const { Resend } = require('resend');
// Add this at the top of walletRoutes.js (after other imports)
const mongoose = require('mongoose');

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);


// @desc      Handle Flutterwave Webhook for payment events
// @route     POST /api/wallet/webhook
// @access    Public (but secured by signature)
router.post('/webhook', async (req, res) => {
    // 1. CAPTURE RAW BODY FIRST - Critical for signature verification[citation:1][citation:5]
    const rawBody = req.body.toString(); // Get the raw string of the request
    const secretHash = process.env.FLW_SECRET_HASH;

    // 2. LOG INCOMING REQUEST (for debugging)
    console.log(`[${new Date().toISOString()}] WEBHOOK RECEIVED: Headers:`, req.headers);
    console.log(`[${new Date().toISOString()}] WEBHOOK RAW BODY:`, rawBody);

    // 3. VERIFY SIGNATURE[citation:1][citation:5][citation:7]
    const signature = req.headers['verif-hash'];
    if (!secretHash || !signature) {
        console.error(`[${new Date().toISOString()}] WEBHOOK ERROR: Missing secret hash or signature.`);
        return res.status(401).send('Unauthorized');
    }

    // Compute the expected signature
    const expectedSignature = crypto
        .createHmac('sha256', secretHash)
        .update(rawBody)
        .digest('hex');

    if (signature !== expectedSignature) {
        console.error(`[${new Date().toISOString()}] WEBHOOK ERROR: Invalid signature.`);
        return res.status(401).send('Unauthorized');
    }

    console.log(`[${new Date().toISOString()}] WEBHOOK: Signature verified.`);

    // 4. PARSE AND PROCESS THE WEBHOOK
    let event;
    try {
        event = JSON.parse(rawBody); // Parse the verified raw body
    } catch (err) {
        console.error(`[${new Date().toISOString()}] WEBHOOK ERROR: Invalid JSON.`);
        return res.status(400).send('Bad Request');
    }

    // 5. HANDLE SPECIFIC EVENT TYPES[citation:1][citation:7]
    // Focus on successful charges for wallet top-up
    if (event.type === 'charge.completed' || event.event === 'charge.completed') {
        const transactionData = event.data;
        console.log(`[${new Date().toISOString()}] WEBHOOK PROCESSING: charge.completed for TX_REF: ${transactionData.tx_ref}`);

        // 6. IDEMPOTENCY CHECK: Prevent processing the same event twice[citation:8]
        const existingPayment = await Payment.findOne({ transactionRef: transactionData.tx_ref });
        if (existingPayment) {
            console.log(`[${new Date().toISOString()}] WEBHOOK DUPLICATE: TX_REF ${transactionData.tx_ref} already processed.`);
            return res.status(200).send('OK - Already processed'); // Still return 200
        }

        // 7. CRITICAL: VERIFY TRANSACTION WITH FLUTTERWAVE API (Best Practice)[citation:1][citation:6]
        // Double-check with Flutterwave's API before crediting the wallet.
        try {
            const verificationResponse = await axios.get(
                `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${transactionData.tx_ref}`,
                {
                    headers: { 'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` }
                }
            );

            const verifiedData = verificationResponse.data.data;
            if (verificationResponse.data.status !== 'success' || verifiedData.status !== 'successful') {
                console.error(`[${new Date().toISOString()}] WEBHOOK VERIFICATION FAILED: API check unsuccessful for ${transactionData.tx_ref}`);
                return res.status(400).send('Verification failed');
            }

            // 8. FIND USER (Link via `meta` or other identifier from your initial payment)
            // IMPORTANT: When initiating payment in Flutter, you MUST include the user's ID in the `meta` field.
            // Example: meta: { userId: "12345" }. This is how you link the webhook back to the user.
            const userId = transactionData.meta?.userId;
            if (!userId) {
                console.error(`[${new Date().toISOString()}] WEBHOOK ERROR: No userId found in meta data.`);
                return res.status(400).send('Missing user identifier');
            }

            // 9. CREDIT USER'S WALLET (Same logic as your verify-payment route)
            const user = await User.findById(userId);
            const isRider = user?.role === 'rider';
            const amount = verifiedData.amount;

            if (isRider) {
                await Rider.findByIdAndUpdate(userId, { $inc: { walletBalance: amount } });
            } else {
                await User.findByIdAndUpdate(userId, { $inc: { userWalletBalance: amount } });
            }

            // 10. CREATE PAYMENT RECORD (Idempotency)
            await Payment.create({
                userId: userId,
                userType: isRider ? 'rider' : 'user',
                transactionRef: transactionData.tx_ref,
                amount: amount,
                currency: verifiedData.currency,
                status: 'successful',
                source: 'webhook' // Mark as from webhook
            });

            console.log(`[${new Date().toISOString()}] WEBHOOK SUCCESS: Wallet credited for user ${userId} via ref ${transactionData.tx_ref}`);

            // Emit socket notification, send email, etc.
            // ... (your notification logic here)

        } catch (verifyError) {
            console.error(`[${new Date().toISOString()}] WEBHOOK API VERIFICATION ERROR:`, verifyError.message);
            // DO NOT credit the wallet. The webhook will be retried[citation:1].
            return res.status(500).send('Verification error');
        }
    } else {
        console.log(`[${new Date().toISOString()}] WEBHOOK IGNORED: Unhandled event type "${event.type || event.event}".`);
    }

    // 11. RESPOND QUICKLY WITH 200[citation:1]
    // Flutterwave expects a 200 OK response within 60 seconds[citation:1].
    res.status(200).send('Webhook received');
});


// @desc      Verify Flutterwave payment and credit user's wallet
// @route     POST /api/wallet/verify-payment
// @access    Private
router.post('/verify-payment', dualProtect, async (req, res) => {
    const { transactionRef } = req.body;
    const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;

    // CRITICAL LOG: Track request start
    console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT START: Request from user ${req.user.id}, Ref: ${transactionRef}`);
    console.log(`[${new Date().toISOString()}] Request Body:`, JSON.stringify(req.body));

    if (!transactionRef) {
        console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT ERROR: Missing transactionRef.`);
        return res.status(400).json({ message: 'Transaction reference is required.' });
    }

    if (!flutterwaveSecretKey) {
        console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT ERROR: FLUTTERWAVE_SECRET_KEY not set.`);
        return res.status(500).json({ message: 'Server configuration error.' });
    }

    try {
        // SECURITY FIX 1: Check if this transaction reference has already been processed
        const existingPayment = await Payment.findOne({ transactionRef });
        if (existingPayment) {
            console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT DUPLICATE: Ref ${transactionRef} already processed.`);
            return res.status(409).json({ message: 'Transaction has already been processed.' });
        }

        // CRITICAL LOG: Before API call
        console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT CALLING: Calling Flutterwave API for ref: ${transactionRef}`);

        const response = await axios.get(
            `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${transactionRef}`,
            {
                headers: {
                    'Authorization': `Bearer ${flutterwaveSecretKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // CRITICAL LOG: Raw Flutterwave response
        console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT RESPONSE: Flutterwave API Status: ${response.status}`);
        console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT RESPONSE DATA:`, JSON.stringify(response.data));

        const responseData = response.data;

        if (responseData.status === 'success' && responseData.data.status === 'successful') {
            const amount = responseData.data.amount;
            const currency = responseData.data.currency;
            console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT SUCCESS: Payment verified. Amount: ${amount} ${currency}`);

            // FIXED: Use req.user.isRider instead of querying User collection
            const isRider = req.user.isRider;
            let user;
            
            if (isRider) {
                user = await Rider.findById(req.user.id);
            } else {
                user = await User.findById(req.user.id);
            }
            
            let updatedUser;
            
            if (isRider) {
                console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT UPDATING: Crediting rider ${req.user.id} with ${amount}`);
                updatedUser = await Rider.findByIdAndUpdate(
                    req.user.id,
                    { $inc: { walletBalance: amount } },
                    { new: true, runValidators: true }
                );
            } else {
                console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT UPDATING: Crediting user ${req.user.id} with ${amount}`);
                updatedUser = await User.findByIdAndUpdate(
                    req.user.id,
                    { $inc: { userWalletBalance: amount } },
                    { new: true, runValidators: true }
                );
            }

            if (!updatedUser) {
                console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT ERROR: User ${req.user.id} not found after update.`);
                return res.status(404).json({ message: 'User not found.' });
            }

            // Create a new payment record to prevent future replay attacks
            await Payment.create({
                userId: req.user.id,
                userType: isRider ? 'rider' : 'user',
                transactionRef: transactionRef,
                amount: amount,
                currency: currency,
                status: 'successful'
            });

            console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT COMPLETE: Payment record saved for ref ${transactionRef}`);

            // Emit socket notification for admin
            const io = req.app.get('io');
            if (io) {
                const notifyAdmin = req.app.get('notifyAdmin');
                if (notifyAdmin) {
                    notifyAdmin({
                        type: 'wallet_topup',
                        message: `${isRider ? 'Rider' : 'User'} ${updatedUser.fullName || updatedUser.firstName} topped up wallet with ₦${amount}`,
                        userId: req.user.id,
                        userName: updatedUser.fullName || `${updatedUser.firstName} ${updatedUser.lastName}`,
                        amount,
                        userType: isRider ? 'rider' : 'user',
                        timestamp: new Date()
                    });
                }
            }

            console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT SUCCESS END: Returning 200 for ref ${transactionRef}`);
            return res.status(200).json({
                message: `Wallet credited with ${amount} ${currency}.`,
                newBalance: isRider ? updatedUser.walletBalance : updatedUser.userWalletBalance
            });
        } else {
            console.warn(`[${new Date().toISOString()}] VERIFY-PAYMENT FAILED: Flutterwave status not successful. Data:`, responseData);
            return res.status(400).json({
                message: 'Payment verification failed or payment was not successful.'
            });
        }
    } catch (error) {
        // CRITICAL LOG: This is where your error is likely being thrown
        console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT CATCH-ERROR:`, error.message);
        console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT CATCH-ERROR STACK:`, error.stack);

        // In case of a database error (e.g., transactionRef unique key violation)
        if (error.code === 11000) { // MongoDB's code for a duplicate key error
            console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT DUPLICATE KEY: ${transactionRef}`);
            return res.status(409).json({ message: 'Transaction has already been processed.' });
        }

        if (error.response) {
            // The request was made and the server responded with a status code outside 2xx
            console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT FLUTTERWAVE API ERROR:`, error.response.data);
            console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT FLUTTERWAVE API STATUS:`, error.response.status);
            // Return the exact error from Flutterwave if available
            const errorMessage = error.response.data?.message || 'Flutterwave verification failed.';
            return res.status(400).json({ message: errorMessage });
        } else if (error.request) {
            // The request was made but no response was received
            console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT NETWORK ERROR: No response received from Flutterwave API.`);
            return res.status(500).json({ message: 'Network error. Could not reach payment processor.' });
        } else {
            // Something happened in setting up the request that triggered an Error
            console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT CONFIGURATION ERROR:`, error.message);
            return res.status(500).json({ message: 'Error verifying payment.' });
        }
    }
});

// // @desc      Verify Flutterwave payment and credit user's wallet
// // @route     POST /api/wallet/verify-payment
// // @access    Private
// router.post('/verify-payment', protect, async (req, res) => {
//     const { transactionRef } = req.body;
//     const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;

//     if (!transactionRef) {
//         return res.status(400).json({ message: 'Transaction reference is required.' });
//     }

//     if (!flutterwaveSecretKey) {
//         console.error('FLUTTERWAVE_SECRET_KEY is not set in environment variables.');
//         return res.status(500).json({ message: 'Server configuration error.' });
//     }

//     try {
//         // SECURITY FIX 1: Check if this transaction reference has already been processed
//         const existingPayment = await Payment.findOne({ transactionRef });
//         if (existingPayment) {
//             return res.status(409).json({ message: 'Transaction has already been processed.' });
//         }

//         const response = await axios.get(
//             `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${transactionRef}`,
//             {
//                 headers: {
//                     'Authorization': `Bearer ${flutterwaveSecretKey}`,
//                     'Content-Type': 'application/json'
//                 }
//             }
//         );

//         const responseData = response.data;

//         if (responseData.status === 'success' && responseData.data.status === 'successful') {
//             const amount = responseData.data.amount;
//             const currency = responseData.data.currency;

//             // Check if user is a rider or regular user
//             const user = await User.findById(req.user.id);
//             const isRider = user.role === 'rider';
            
//             let updatedUser;
            
//             if (isRider) {
//                 // Credit rider's wallet
//                 updatedUser = await Rider.findByIdAndUpdate(
//                     req.user.id,
//                     { $inc: { walletBalance: amount } },
//                     { new: true, runValidators: true }
//                 );
//             } else {
//                 // Credit regular user's wallet
//                 updatedUser = await User.findByIdAndUpdate(
//                     req.user.id,
//                     { $inc: { userWalletBalance: amount } },
//                     { new: true, runValidators: true }
//                 );
//             }

//             if (!updatedUser) {
//                 return res.status(404).json({ message: 'User not found.' });
//             }

//             // Create a new payment record to prevent future replay attacks
//             await Payment.create({
//                 userId: req.user.id,
//                 userType: isRider ? 'rider' : 'user',
//                 transactionRef: transactionRef,
//                 amount: amount,
//                 currency: currency,
//                 status: 'successful'
//             });

//             // Emit socket notification for admin
//             const io = req.app.get('io');
//             if (io) {
//                 const notifyAdmin = req.app.get('notifyAdmin');
//                 if (notifyAdmin) {
//                     notifyAdmin({
//                         type: 'wallet_topup',
//                         message: `${isRider ? 'Rider' : 'User'} ${updatedUser.fullName || updatedUser.firstName} topped up wallet with ₦${amount}`,
//                         userId: req.user.id,
//                         userName: updatedUser.fullName || `${updatedUser.firstName} ${updatedUser.lastName}`,
//                         amount,
//                         userType: isRider ? 'rider' : 'user',
//                         timestamp: new Date()
//                     });
//                 }
//             }

//             return res.status(200).json({
//                 message: `Wallet credited with ${amount} ${currency}.`,
//                 newBalance: isRider ? updatedUser.walletBalance : updatedUser.userWalletBalance
//             });
//         } else {
//             return res.status(400).json({
//                 message: 'Payment verification failed or payment was not successful.'
//             });
//         }
//     } catch (error) {
//         // In case of a database error (e.g., transactionRef unique key violation)
//         if (error.code === 11000) { // MongoDB's code for a duplicate key error
//             return res.status(409).json({ message: 'Transaction has already been processed.' });
//         }

//         if (error.response) {
//             console.error('Flutterwave API responded with an error:', error.response.data);
//             res.status(400).json({ message: 'Flutterwave verification failed.' });
//         } else {
//             console.error('Error during payment verification:', error.message);
//             res.status(500).json({ message: 'Error verifying payment.' });
//         }
//     }
// });


// @desc    Get list of banks (via Flutterwave)
// @route   GET /api/wallet/banks
// @access  Private
router.get('/banks', dualProtect, async (req, res) => {
    try {
        const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;
        if (!flutterwaveSecretKey) {
            return res.status(500).json({ message: 'Missing Flutterwave Secret Key.' });
        }

        const response = await axios.get(
            'https://api.flutterwave.com/v3/banks/NG',
            {
                headers: {
                    Authorization: `Bearer ${flutterwaveSecretKey}`
                }
            }
        );

        if (response.data && response.data.status === 'success') {
            return res.status(200).json({
                banks: response.data.data
            });
        } else {
            return res.status(400).json({ message: 'Failed to fetch banks from Flutterwave.' });
        }
    } catch (error) {
        console.error('Error fetching banks:', error.response?.data || error.message);
        return res.status(500).json({ message: 'Error fetching banks.' });
    }
});


// @desc      Request an OTP for withdrawal
// @route     POST /api/wallet/request-otp
// @access    Private
router.post('/request-otp', dualProtect, async (req, res) => {
    try {
        let user;
        const isRider = req.user.isRider; // FIXED: Use req.user.isRider
        
        if (isRider) {
            user = await Rider.findById(req.user.id);
        } else {
            user = await User.findById(req.user.id);
        }
        
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Generate a 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        // Set OTP expiration to 5 minutes from now
        const otpExpires = Date.now() + 5 * 60 * 1000;

        // Save the OTP and its expiration to the user's document
        user.otp = otp;
        user.otpExpires = otpExpires;
        await user.save();

        // Send the OTP via Resend
        const { data, error } = await resend.emails.send({
            from: 'NaijaGo <noreply@naijagoapp.com>',
            to: [user.email],
            subject: 'Your Withdrawal Verification Code',
            html: `
                    <div style="font-family: 'Arial', sans-serif; background-color: #f7f7f7; padding: 20px; border-radius: 10px; border: 1px solid #ddd; max-width: 600px; margin: 20px auto;">
                        <div style="text-align: center; margin-bottom: 20px;">
                            <img src="https://naijago-backend.onrender.com/naijago-app.jpg" alt="NaijaGo Logo" style="width: 150px; height: auto;">
                        </div>
                        <div style="background-color: #160d0dff; padding: 20px; border-radius: 8px;">
                            <h2 style="color: #000080; text-align: center; font-size: 24px;">Withdrawal Verification Code</h2>
                            <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #555;">Hello ${user.fullName || user.firstName},</p>
                            <p style="color: #555;">To complete your withdrawal, please use the following One-Time Password (OTP):</p>
                            <div style="text-align: center; margin: 30px 0;">
                                <span style="display: inline-block; padding: 15px 25px; background-color: #ADFF2F; color: #000080; font-size: 28px; font-weight: bold; letter-spacing: 2px; border-radius: 8px;">${otp}</span>
                            </div>
                            <p style="color: #888; text-align: center; font-size: 14px;">This code is valid for 5 minutes. For your security, do not share this code.</p>
                            <p style="color: #888; font-size: 14px; margin-top: 30px;">If you did not request this, please contact support immediately.</p>
                            <img src="https://naijago-backend.onrender.com/naijago-flier3.jpg" alt="NaijaGo Flier" style="width: 150px; height: auto;">
                        </div>
                        <div style="text-align: center; margin-top: 20px; color: #aaa; font-size: 12px;">
                            <p>&copy; ${new Date().getFullYear()} NaijaGo. All rights reserved.</p>
                        </div>
                    </div>
                `
        });

        if (error) {
            console.error('Resend email error:', error);
            // Even if email fails, we tell the user it was sent to avoid leaking info.
            return res.status(500).json({ message: 'Failed to send OTP email.' });
        }

        console.log(`[DEV-LOG] OTP sent to ${user.email} with Resend ID: ${data.id}`);
        res.status(200).json({ message: 'OTP sent to your email address.' });

    } catch (error) {
        console.error('Error requesting OTP:', error.message);
        res.status(500).json({ message: 'Error requesting OTP.' });
    }
});

// @desc      Withdraw funds from wallet to bank account
// @route     POST /api/wallet/withdraw
// @access    Private
router.post('/withdraw', dualProtect, async (req, res) => {
    const { bank_code, account_number, account_name, amount, otp, wallet_type } = req.body;

    if (!bank_code || !account_number || !account_name || !amount || !otp || !wallet_type) {
        return res.status(400).json({ message: 'All required fields are needed.' });
    }

    if (amount <= 0) {
        return res.status(400).json({ message: 'Invalid withdrawal amount.' });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const isRider = req.user.isRider; // FIXED: Use req.user.isRider
        let user;
        
        if (isRider) {
            user = await Rider.findById(req.user.id).session(session);
        } else {
            user = await User.findById(req.user.id).session(session);
        }
        
        if (!user) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'User not found.' });
        }
        
        // 1. OTP Verification is performed first
        if (user.otp !== otp || user.otpExpires < Date.now()) {
            user.otp = undefined;
            user.otpExpires = undefined;
            await user.save({ session });
            await session.abortTransaction();
            session.endSession();
            return res.status(401).json({ message: 'Invalid or expired OTP.' });
        }

        // 2. Check wallet balance
        const balanceField = isRider ? 'walletBalance' : 
                           (wallet_type === 'vendor' ? 'vendorWalletBalance' : 'userWalletBalance');
        const currentBalance = user[balanceField] || 0;
        
        if (currentBalance < amount) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ 
                message: `Insufficient balance. Available: ₦${currentBalance.toFixed(2)}, Requested: ₦${amount}` 
            });
        }

        // 3. Minimum withdrawal check
        const MIN_WITHDRAWAL = 100;
        if (amount < MIN_WITHDRAWAL) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ 
                message: `Minimum withdrawal amount is ₦${MIN_WITHDRAWAL}` 
            });
        }

        // 4. Generate unique reference
        const reference = `WD${Date.now()}${Math.floor(Math.random() * 1000)}${isRider ? 'R' : 'U'}`;

        // 5. Create withdrawal record
        const withdrawalRecord = {
            amount,
            status: 'pending',
            createdAt: Date.now(),
            reference,
            paymentMethod: 'bank_transfer',
            accountDetails: {
                bankCode: bank_code,
                bankName: req.body.bank_name || '',
                accountNumber: account_number,
                accountName: account_name
            }
        };

        // 6. Update user balance and add withdrawal history
        user[balanceField] = currentBalance - amount;
        user.otp = undefined;
        user.otpExpires = undefined;
        
        if (isRider) {
            user.pendingEarnings = (user.pendingEarnings || 0) + amount;
            user.withdrawalHistory.push(withdrawalRecord);
        } else {
            // For vendors, track in vendorWithdrawals
            if (wallet_type === 'vendor') {
                user.vendorWithdrawals = user.vendorWithdrawals || [];
                user.vendorWithdrawals.push(withdrawalRecord);
            } else {
                user.userWithdrawals = user.userWithdrawals || [];
                user.userWithdrawals.push(withdrawalRecord);
            }
        }

        await user.save({ session });

        // 7. Send Flutterwave transfer request
        const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;
        if (!flutterwaveSecretKey) {
            await session.commitTransaction();
            session.endSession();
            return res.status(500).json({ message: 'Missing Flutterwave Secret Key.' });
        }

        const transferPayload = {
            account_bank: bank_code,
            account_number: account_number,
            amount: amount,
            narration: `Withdrawal from ${isRider ? 'rider' : wallet_type} wallet - ${reference}`,
            currency: "NGN",
            reference: reference,
            debit_currency: "NGN",
            meta: {
                userId: req.user.id,
                userType: isRider ? 'rider' : (wallet_type === 'vendor' ? 'vendor' : 'user'),
                userName: user.fullName || `${user.firstName} ${user.lastName}`,
                email: user.email
            }
        };

        let transferResponse;
        try {
            transferResponse = await axios.post(
                "https://api.flutterwave.com/v3/transfers",
                transferPayload,
                {
                    headers: {
                        Authorization: `Bearer ${flutterwaveSecretKey}`,
                        "Content-Type": "application/json"
                    }
                }
            );
        } catch (flwError) {
            console.error('Flutterwave transfer error:', flwError.response?.data || flwError.message);
            // If Flutterwave fails, we still record the withdrawal as pending
            // Admin will process manually later
        }

        // 8. Update withdrawal record with Flutterwave response
        if (transferResponse?.data?.status === "success") {
            withdrawalRecord.flutterwaveId = transferResponse.data.data.id;
            withdrawalRecord.flutterwaveStatus = transferResponse.data.data.status;
            
            // Auto-complete small withdrawals (under ₦5000)
            if (amount <= 5000) {
                withdrawalRecord.status = 'completed';
                withdrawalRecord.completedAt = Date.now();
                
                if (isRider) {
                    user.pendingEarnings = Math.max(0, (user.pendingEarnings || 0) - amount);
                    user.totalWithdrawn = (user.totalWithdrawn || 0) + amount;
                }
            }
        }

        // Save updated withdrawal record
        if (isRider) {
            // Update the specific withdrawal record in the array
            const withdrawalIndex = user.withdrawalHistory.length - 1;
            user.withdrawalHistory[withdrawalIndex] = withdrawalRecord;
        } else if (wallet_type === 'vendor') {
            const withdrawalIndex = user.vendorWithdrawals.length - 1;
            user.vendorWithdrawals[withdrawalIndex] = withdrawalRecord;
        } else {
            const withdrawalIndex = user.userWithdrawals.length - 1;
            user.userWithdrawals[withdrawalIndex] = withdrawalRecord;
        }

        await user.save({ session });

        // 9. Emit socket notification for admin
        const io = req.app.get('io');
        if (io) {
            const notifyAdmin = req.app.get('notifyAdmin');
            if (notifyAdmin) {
                notifyAdmin({
                    type: 'withdrawal_request',
                    message: `${isRider ? 'Rider' : (wallet_type === 'vendor' ? 'Vendor' : 'User')} ${user.fullName || user.firstName} requested withdrawal of ₦${amount}`,
                    userId: req.user.id,
                    userName: user.fullName || `${user.firstName} ${user.lastName}`,
                    amount,
                    reference,
                    userType: isRider ? 'rider' : (wallet_type === 'vendor' ? 'vendor' : 'user'),
                    status: withdrawalRecord.status,
                    timestamp: new Date()
                });
            }
        }

        await session.commitTransaction();
        session.endSession();

        // 10. Send email confirmation
        try {
            await resend.emails.send({
                from: 'NaijaGo <noreply@naijagoapp.com>',
                to: [user.email],
                subject: 'Withdrawal Request Received',
                html: `
                    <div style="font-family: 'Arial', sans-serif; background-color: #f7f7f7; padding: 20px; border-radius: 10px; border: 1px solid #ddd; max-width: 600px; margin: 20px auto;">
                        <div style="text-align: center; margin-bottom: 20px;">
                            <img src="https://naijago-backend.onrender.com/naijago-app.jpg" alt="NaijaGo Logo" style="width: 150px; height: auto;">
                        </div>
                        <div style="background-color: #160d0dff; padding: 20px; border-radius: 8px;">
                            <h2 style="color: #000080; text-align: center; font-size: 24px;">Withdrawal Request Confirmed</h2>
                            <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #555;">Hello ${user.fullName || user.firstName},</p>
                            <p style="color: #555;">Your withdrawal request has been received and is being processed.</p>
                            <div style="text-align: center; margin: 30px 0; padding: 20px; background-color: #2d3748; border-radius: 8px;">
                                <p style="color: #fff; font-size: 14px; margin: 0;">Reference: <strong>${reference}</strong></p>
                                <p style="color: #ADFF2F; font-size: 28px; font-weight: bold; margin: 10px 0;">₦${amount.toFixed(2)}</p>
                                <p style="color: #fff; font-size: 14px; margin: 0;">Status: <strong>${withdrawalRecord.status.toUpperCase()}</strong></p>
                                <p style="color: #fff; font-size: 12px; margin: 10px 0 0 0;">Account: ${account_number} (${account_name})</p>
                            </div>
                            <p style="color: #888; text-align: center; font-size: 14px;">
                                ${withdrawalRecord.status === 'completed' 
                                    ? 'Your withdrawal has been processed successfully. Funds should arrive in your account within 24 hours.' 
                                    : 'Your withdrawal is pending approval. You will be notified once processed.'}
                            </p>
                            <p style="color: #888; font-size: 14px; margin-top: 30px;">
                                If you did not request this withdrawal, please contact support immediately.
                            </p>
                        </div>
                        <div style="text-align: center; margin-top: 20px; color: #aaa; font-size: 12px;">
                            <p>&copy; ${new Date().getFullYear()} NaijaGo. All rights reserved.</p>
                        </div>
                    </div>
                `
            });
        } catch (emailError) {
            console.error('Withdrawal confirmation email error:', emailError);
        }

        res.status(200).json({
            success: true,
            message: `Withdrawal request submitted ${withdrawalRecord.status === 'completed' ? 'and processed' : 'successfully'}.`,
            reference,
            status: withdrawalRecord.status,
            amount,
            newBalance: user[balanceField],
            estimatedArrival: withdrawalRecord.status === 'completed' ? 'Within 24 hours' : 'After admin approval'
        });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error processing withdrawal:', error.message);
        res.status(500).json({ message: 'Error processing withdrawal.' });
    }
});

// @desc      Get withdrawal history
// @route     GET /api/wallet/withdrawals
// @access    Private
router.get('/withdrawals', dualProtect, async (req, res) => {
    try {
        const isRider = req.user.isRider; // FIXED: Use req.user.isRider
        let user;
        
        if (isRider) {
            user = await Rider.findById(req.user.id).select('withdrawalHistory');
        } else {
            user = await User.findById(req.user.id).select('vendorWithdrawals userWithdrawals');
        }
        
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        let withdrawals = [];
        if (isRider) {
            withdrawals = user.withdrawalHistory || [];
        } else {
            // Combine vendor and user withdrawals
            withdrawals = [
                ...(user.vendorWithdrawals || []),
                ...(user.userWithdrawals || [])
            ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        }

        // Calculate totals
        const totalWithdrawn = withdrawals.reduce((sum, w) => sum + w.amount, 0);
        const pendingWithdrawals = withdrawals.filter(w => w.status === 'pending');
        const totalPending = pendingWithdrawals.reduce((sum, w) => sum + w.amount, 0);

        res.json({
            withdrawals,
            summary: {
                totalCount: withdrawals.length,
                totalWithdrawn,
                totalPending,
                pendingCount: pendingWithdrawals.length,
                completedCount: withdrawals.filter(w => w.status === 'completed').length,
                failedCount: withdrawals.filter(w => w.status === 'failed').length
            }
        });

    } catch (error) {
        console.error('Error fetching withdrawal history:', error.message);
        res.status(500).json({ message: 'Error fetching withdrawal history.' });
    }
});

// @desc      Get wallet balance and statistics
// @route     GET /api/wallet/balance
// @access    Private
router.get('/balance', dualProtect, async (req, res) => {
    try {
        const isRider = req.user.isRider; // FIXED: Use req.user.isRider
        let user;
        
        if (isRider) {
            user = await Rider.findById(req.user.id).select('walletBalance totalEarnings pendingEarnings totalWithdrawn');
        } else {
            user = await User.findById(req.user.id).select('userWalletBalance vendorWalletBalance totalVendorEarnings totalUserSpent');
        }
        
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const response = {
            isRider,
            timestamp: new Date()
        };

        if (isRider) {
            response.walletBalance = user.walletBalance || 0;
            response.totalEarnings = user.totalEarnings || 0;
            response.pendingEarnings = user.pendingEarnings || 0;
            response.totalWithdrawn = user.totalWithdrawn || 0;
            response.availableForWithdrawal = user.walletBalance || 0;
            response.canWithdraw = (user.walletBalance || 0) >= 100;
            response.minimumWithdrawal = 100;
        } else {
            response.userWalletBalance = user.userWalletBalance || 0;
            response.vendorWalletBalance = user.vendorWalletBalance || 0;
            response.totalVendorEarnings = user.totalVendorEarnings || 0;
            response.totalUserSpent = user.totalUserSpent || 0;
            response.canWithdrawVendor = (user.vendorWalletBalance || 0) >= 100;
            response.canWithdrawUser = (user.userWalletBalance || 0) >= 100;
            response.minimumWithdrawal = 100;
        }

        res.json(response);

    } catch (error) {
        console.error('Error fetching wallet balance:', error.message);
        res.status(500).json({ message: 'Error fetching wallet balance.' });
    }
});

// ============================================
// ADMIN WITHDRAWAL MANAGEMENT ROUTES
// ============================================

// @desc      Get all pending withdrawals (Admin only)
// @route     GET /api/wallet/admin/pending-withdrawals
// @access    Private/Admin
router.get('/admin/pending-withdrawals', protect, authorizeRoles('admin'), async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;
        const status = req.query.status || 'pending';
        const userType = req.query.userType; // 'rider', 'vendor', 'user', or undefined for all

        let query = {};
        if (status !== 'all') {
            query['withdrawalHistory.status'] = status;
        }

        // Get rider withdrawals
        let riderWithdrawals = [];
        if (!userType || userType === 'rider') {
            const riders = await Rider.find({
                'withdrawalHistory.status': status !== 'all' ? status : { $exists: true }
            }).select('fullName email phoneNumber plateNumber withdrawalHistory');
            
            riders.forEach(rider => {
                rider.withdrawalHistory.forEach(withdrawal => {
                    if (status === 'all' || withdrawal.status === status) {
                        riderWithdrawals.push({
                            ...withdrawal.toObject(),
                            userType: 'rider',
                            userId: rider._id,
                            userName: rider.fullName,
                            userEmail: rider.email,
                            userPhone: rider.phoneNumber,
                            plateNumber: rider.plateNumber
                        });
                    }
                });
            });
        }

        // Get vendor withdrawals
        let vendorWithdrawals = [];
        if (!userType || userType === 'vendor') {
            const vendors = await User.find({
                role: 'vendor',
                'vendorWithdrawals.status': status !== 'all' ? status : { $exists: true }
            }).select('firstName lastName email phoneNumber businessName vendorWithdrawals');
            
            vendors.forEach(vendor => {
                (vendor.vendorWithdrawals || []).forEach(withdrawal => {
                    if (status === 'all' || withdrawal.status === status) {
                        vendorWithdrawals.push({
                            ...withdrawal.toObject(),
                            userType: 'vendor',
                            userId: vendor._id,
                            userName: `${vendor.firstName} ${vendor.lastName}`,
                            businessName: vendor.businessName,
                            userEmail: vendor.email,
                            userPhone: vendor.phoneNumber
                        });
                    }
                });
            });
        }

        // Get user withdrawals
        let userWithdrawals = [];
        if (!userType || userType === 'user') {
            const users = await User.find({
                role: 'user',
                'userWithdrawals.status': status !== 'all' ? status : { $exists: true }
            }).select('firstName lastName email phoneNumber userWithdrawals');
            
            users.forEach(user => {
                (user.userWithdrawals || []).forEach(withdrawal => {
                    if (status === 'all' || withdrawal.status === status) {
                        userWithdrawals.push({
                            ...withdrawal.toObject(),
                            userType: 'user',
                            userId: user._id,
                            userName: `${user.firstName} ${user.lastName}`,
                            userEmail: user.email,
                            userPhone: user.phoneNumber
                        });
                    }
                });
            });
        }

        // Combine all withdrawals
        const allWithdrawals = [...riderWithdrawals, ...vendorWithdrawals, ...userWithdrawals]
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        // Paginate
        const total = allWithdrawals.length;
        const paginatedWithdrawals = allWithdrawals.slice(skip, skip + limit);

        // Calculate totals
        const totalAmount = allWithdrawals.reduce((sum, w) => sum + w.amount, 0);
        const pendingAmount = allWithdrawals.filter(w => w.status === 'pending').reduce((sum, w) => sum + w.amount, 0);

        res.json({
            withdrawals: paginatedWithdrawals,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            },
            summary: {
                totalWithdrawals: total,
                totalAmount,
                pendingAmount,
                riderCount: riderWithdrawals.length,
                vendorCount: vendorWithdrawals.length,
                userCount: userWithdrawals.length,
                pendingCount: allWithdrawals.filter(w => w.status === 'pending').length,
                completedCount: allWithdrawals.filter(w => w.status === 'completed').length,
                failedCount: allWithdrawals.filter(w => w.status === 'failed').length
            }
        });

    } catch (error) {
        console.error('Error fetching pending withdrawals:', error.message);
        res.status(500).json({ message: 'Error fetching pending withdrawals.' });
    }
});

// @desc      Process a withdrawal (Admin only)
// @route     PUT /api/wallet/admin/process-withdrawal/:reference
// @access    Private/Admin
router.put('/admin/process-withdrawal/:reference', protect, authorizeRoles('admin'), async (req, res) => {
    const { reference } = req.params;
    const { status, failureReason } = req.body;

    if (!['completed', 'failed'].includes(status)) {
        return res.status(400).json({ message: 'Status must be either "completed" or "failed".' });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        // Try to find in riders first
        let rider = await Rider.findOne({
            'withdrawalHistory.reference': reference
        }).session(session);

        if (rider) {
            const withdrawalIndex = rider.withdrawalHistory.findIndex(w => w.reference === reference);
            if (withdrawalIndex === -1) {
                await session.abortTransaction();
                session.endSession();
                return res.status(404).json({ message: 'Withdrawal not found.' });
            }

            const withdrawal = rider.withdrawalHistory[withdrawalIndex];
            
            if (withdrawal.status === 'completed') {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ message: 'Withdrawal already processed.' });
            }

            // Update withdrawal
            rider.withdrawalHistory[withdrawalIndex].status = status;
            rider.withdrawalHistory[withdrawalIndex].completedAt = Date.now();
            rider.withdrawalHistory[withdrawalIndex].processedBy = req.user.id;
            
            if (status === 'failed' && failureReason) {
                rider.withdrawalHistory[withdrawalIndex].failureReason = failureReason;
                // Refund the amount back to wallet
                rider.walletBalance = (rider.walletBalance || 0) + withdrawal.amount;
                rider.pendingEarnings = Math.max(0, (rider.pendingEarnings || 0) - withdrawal.amount);
            } else if (status === 'completed') {
                rider.pendingEarnings = Math.max(0, (rider.pendingEarnings || 0) - withdrawal.amount);
                rider.totalWithdrawn = (rider.totalWithdrawn || 0) + withdrawal.amount;
            }

            await rider.save({ session });

            // Emit socket notification
            const io = req.app.get('io');
            if (io) {
                const notifyRider = req.app.get('notifyRider');
                if (notifyRider) {
                    notifyRider(rider._id, {
                        type: 'withdrawal_processed',
                        message: `Your withdrawal of ₦${withdrawal.amount} has been ${status}`,
                        amount: withdrawal.amount,
                        status,
                        reference,
                        timestamp: new Date()
                    });
                }
            }

            await session.commitTransaction();
            session.endSession();

            return res.json({
                success: true,
                message: `Rider withdrawal ${status} successfully.`,
                withdrawal: rider.withdrawalHistory[withdrawalIndex]
            });
        }

        // If not found in riders, try vendors
        let vendor = await User.findOne({
            role: 'vendor',
            'vendorWithdrawals.reference': reference
        }).session(session);

        if (vendor) {
            const withdrawalIndex = vendor.vendorWithdrawals.findIndex(w => w.reference === reference);
            if (withdrawalIndex === -1) {
                await session.abortTransaction();
                session.endSession();
                return res.status(404).json({ message: 'Withdrawal not found.' });
            }

            const withdrawal = vendor.vendorWithdrawals[withdrawalIndex];
            
            if (withdrawal.status === 'completed') {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ message: 'Withdrawal already processed.' });
            }

            // Update withdrawal
            vendor.vendorWithdrawals[withdrawalIndex].status = status;
            vendor.vendorWithdrawals[withdrawalIndex].completedAt = Date.now();
            vendor.vendorWithdrawals[withdrawalIndex].processedBy = req.user.id;
            
            if (status === 'failed' && failureReason) {
                vendor.vendorWithdrawals[withdrawalIndex].failureReason = failureReason;
                // Refund the amount back to vendor wallet
                vendor.vendorWalletBalance = (vendor.vendorWalletBalance || 0) + withdrawal.amount;
            }

            await vendor.save({ session });

            await session.commitTransaction();
            session.endSession();

            return res.json({
                success: true,
                message: `Vendor withdrawal ${status} successfully.`,
                withdrawal: vendor.vendorWithdrawals[withdrawalIndex]
            });
        }

        // If not found in vendors, try regular users
        let user = await User.findOne({
            role: 'user',
            'userWithdrawals.reference': reference
        }).session(session);

        if (user) {
            const withdrawalIndex = user.userWithdrawals.findIndex(w => w.reference === reference);
            if (withdrawalIndex === -1) {
                await session.abortTransaction();
                session.endSession();
                return res.status(404).json({ message: 'Withdrawal not found.' });
            }

            const withdrawal = user.userWithdrawals[withdrawalIndex];
            
            if (withdrawal.status === 'completed') {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ message: 'Withdrawal already processed.' });
            }

            // Update withdrawal
            user.userWithdrawals[withdrawalIndex].status = status;
            user.userWithdrawals[withdrawalIndex].completedAt = Date.now();
            user.userWithdrawals[withdrawalIndex].processedBy = req.user.id;
            
            if (status === 'failed' && failureReason) {
                user.userWithdrawals[withdrawalIndex].failureReason = failureReason;
                // Refund the amount back to user wallet
                user.userWalletBalance = (user.userWalletBalance || 0) + withdrawal.amount;
            }

            await user.save({ session });

            await session.commitTransaction();
            session.endSession();

            return res.json({
                success: true,
                message: `User withdrawal ${status} successfully.`,
                withdrawal: user.userWithdrawals[withdrawalIndex]
            });
        }

        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ message: 'Withdrawal not found.' });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error processing withdrawal:', error.message);
        res.status(500).json({ message: 'Error processing withdrawal.' });
    }
});

// @desc      Bulk process withdrawals (Admin only)
// @route     POST /api/wallet/admin/bulk-process-withdrawals
// @access    Private/Admin
router.post('/admin/bulk-process-withdrawals', protect, authorizeRoles('admin'), async (req, res) => {
    const { references, status } = req.body;

    if (!Array.isArray(references) || references.length === 0) {
        return res.status(400).json({ message: 'References array is required.' });
    }

    if (!['completed', 'failed'].includes(status)) {
        return res.status(400).json({ message: 'Status must be either "completed" or "failed".' });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const results = {
            processed: 0,
            failed: 0,
            errors: []
        };

        for (const reference of references) {
            try {
                // Similar logic as single processing but in bulk
                // For brevity, implementing single processing in loop
                // In production, you might want to optimize this
                
                let processed = false;
                
                // Try riders
                let rider = await Rider.findOne({ 'withdrawalHistory.reference': reference }).session(session);
                if (rider) {
                    const withdrawalIndex = rider.withdrawalHistory.findIndex(w => w.reference === reference);
                    if (withdrawalIndex !== -1 && rider.withdrawalHistory[withdrawalIndex].status !== 'completed') {
                        rider.withdrawalHistory[withdrawalIndex].status = status;
                        rider.withdrawalHistory[withdrawalIndex].completedAt = Date.now();
                        rider.withdrawalHistory[withdrawalIndex].processedBy = req.user.id;
                        
                        if (status === 'completed') {
                            rider.pendingEarnings = Math.max(0, (rider.pendingEarnings || 0) - rider.withdrawalHistory[withdrawalIndex].amount);
                            rider.totalWithdrawn = (rider.totalWithdrawn || 0) + rider.withdrawalHistory[withdrawalIndex].amount;
                        }
                        
                        await rider.save({ session });
                        results.processed++;
                        processed = true;
                    }
                }

                if (!processed) {
                    // Try vendors
                    let vendor = await User.findOne({ 
                        role: 'vendor',
                        'vendorWithdrawals.reference': reference 
                    }).session(session);
                    
                    if (vendor) {
                        const withdrawalIndex = vendor.vendorWithdrawals.findIndex(w => w.reference === reference);
                        if (withdrawalIndex !== -1 && vendor.vendorWithdrawals[withdrawalIndex].status !== 'completed') {
                            vendor.vendorWithdrawals[withdrawalIndex].status = status;
                            vendor.vendorWithdrawals[withdrawalIndex].completedAt = Date.now();
                            vendor.vendorWithdrawals[withdrawalIndex].processedBy = req.user.id;
                            await vendor.save({ session });
                            results.processed++;
                            processed = true;
                        }
                    }
                }

                if (!processed) {
                    // Try users
                    let user = await User.findOne({ 
                        role: 'user',
                        'userWithdrawals.reference': reference 
                    }).session(session);
                    
                    if (user) {
                        const withdrawalIndex = user.userWithdrawals.findIndex(w => w.reference === reference);
                        if (withdrawalIndex !== -1 && user.userWithdrawals[withdrawalIndex].status !== 'completed') {
                            user.userWithdrawals[withdrawalIndex].status = status;
                            user.userWithdrawals[withdrawalIndex].completedAt = Date.now();
                            user.userWithdrawals[withdrawalIndex].processedBy = req.user.id;
                            await user.save({ session });
                            results.processed++;
                            processed = true;
                        }
                    }
                }

                if (!processed) {
                    results.failed++;
                    results.errors.push({
                        reference,
                        error: 'Withdrawal not found or already processed'
                    });
                }

            } catch (error) {
                results.failed++;
                results.errors.push({
                    reference,
                    error: error.message
                });
            }
        }

        await session.commitTransaction();
        session.endSession();

        // Emit socket notification for bulk processing
        const io = req.app.get('io');
        if (io) {
            const notifyAdmin = req.app.get('notifyAdmin');
            if (notifyAdmin) {
                notifyAdmin({
                    type: 'bulk_withdrawal_processed',
                    message: `Bulk processed ${results.processed} withdrawals as ${status}`,
                    processed: results.processed,
                    failed: results.failed,
                    status,
                    processedBy: req.user.id,
                    timestamp: new Date()
                });
            }
        }

        res.json({
            success: true,
            message: `Bulk processing completed. Processed: ${results.processed}, Failed: ${results.failed}`,
            results
        });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error bulk processing withdrawals:', error.message);
        res.status(500).json({ message: 'Error bulk processing withdrawals.' });
    }
});

// @desc      Get withdrawal statistics (Admin only)
// @route     GET /api/wallet/admin/withdrawal-stats
// @access    Private/Admin
router.get('/admin/withdrawal-stats', protect, authorizeRoles('admin'), async (req, res) => {
    try {
        const { timeframe = 'month' } = req.query; // day, week, month, year
        
        let startDate = new Date();
        switch (timeframe) {
            case 'day':
                startDate.setDate(startDate.getDate() - 1);
                break;
            case 'week':
                startDate.setDate(startDate.getDate() - 7);
                break;
            case 'month':
                startDate.setMonth(startDate.getMonth() - 1);
                break;
            case 'year':
                startDate.setFullYear(startDate.getFullYear() - 1);
                break;
            default:
                startDate.setMonth(startDate.getMonth() - 1);
        }

        // Get all withdrawals from all sources
        const riders = await Rider.find({
            'withdrawalHistory.createdAt': { $gte: startDate }
        }).select('withdrawalHistory');

        const vendors = await User.find({
            role: 'vendor',
            'vendorWithdrawals.createdAt': { $gte: startDate }
        }).select('vendorWithdrawals');

        const users = await User.find({
            role: 'user',
            'userWithdrawals.createdAt': { $gte: startDate }
        }).select('userWithdrawals');

        // Process statistics
        let allWithdrawals = [];
        
        riders.forEach(rider => {
            rider.withdrawalHistory.forEach(w => {
                if (new Date(w.createdAt) >= startDate) {
                    allWithdrawals.push({
                        ...w.toObject(),
                        userType: 'rider'
                    });
                }
            });
        });

        vendors.forEach(vendor => {
            (vendor.vendorWithdrawals || []).forEach(w => {
                if (new Date(w.createdAt) >= startDate) {
                    allWithdrawals.push({
                        ...w.toObject(),
                        userType: 'vendor'
                    });
                }
            });
        });

        users.forEach(user => {
            (user.userWithdrawals || []).forEach(w => {
                if (new Date(w.createdAt) >= startDate) {
                    allWithdrawals.push({
                        ...w.toObject(),
                        userType: 'user'
                    });
                }
            });
        });

        // Calculate statistics
        const totalWithdrawals = allWithdrawals.length;
        const totalAmount = allWithdrawals.reduce((sum, w) => sum + w.amount, 0);
        
        const byStatus = {
            pending: allWithdrawals.filter(w => w.status === 'pending').length,
            completed: allWithdrawals.filter(w => w.status === 'completed').length,
            failed: allWithdrawals.filter(w => w.status === 'failed').length
        };

        const byUserType = {
            rider: allWithdrawals.filter(w => w.userType === 'rider').length,
            vendor: allWithdrawals.filter(w => w.userType === 'vendor').length,
            user: allWithdrawals.filter(w => w.userType === 'user').length
        };

        const amountByUserType = {
            rider: allWithdrawals.filter(w => w.userType === 'rider').reduce((sum, w) => sum + w.amount, 0),
            vendor: allWithdrawals.filter(w => w.userType === 'vendor').reduce((sum, w) => sum + w.amount, 0),
            user: allWithdrawals.filter(w => w.userType === 'user').reduce((sum, w) => sum + w.amount, 0)
        };

        // Daily breakdown for chart
        const dailyBreakdown = {};
        allWithdrawals.forEach(w => {
            const date = new Date(w.createdAt).toISOString().split('T')[0];
            if (!dailyBreakdown[date]) {
                dailyBreakdown[date] = { date, total: 0, completed: 0, pending: 0, failed: 0 };
            }
            dailyBreakdown[date].total += w.amount;
            dailyBreakdown[date][w.status] += w.amount;
        });

        const chartData = Object.values(dailyBreakdown).sort((a, b) => new Date(a.date) - new Date(b.date));

        res.json({
            timeframe,
            startDate,
            endDate: new Date(),
            summary: {
                totalWithdrawals,
                totalAmount,
                averageAmount: totalWithdrawals > 0 ? totalAmount / totalWithdrawals : 0,
                pendingAmount: allWithdrawals.filter(w => w.status === 'pending').reduce((sum, w) => sum + w.amount, 0),
                completedAmount: allWithdrawals.filter(w => w.status === 'completed').reduce((sum, w) => sum + w.amount, 0)
            },
            breakdown: {
                byStatus,
                byUserType,
                amountByUserType
            },
            chartData
        });

    } catch (error) {
        console.error('Error fetching withdrawal statistics:', error.message);
        res.status(500).json({ message: 'Error fetching withdrawal statistics.' });
    }
});

module.exports = router;




// // routes/walletRoutes.js
// const express = require('express');
// const crypto = require('crypto'); 
// const router = express.Router();
// const axios = require('axios');
// const User = require('../models/User');
// const Rider = require('../models/Rider');
// const Payment = require('../models/Payment');
// const { protect, authorizeRoles } = require('../middleware/authMiddleware');
// const { dualProtect } = require('../middleware/dualAuthMiddleware');
// const dotenv = require('dotenv');
// const { Resend } = require('resend');
// // Add this at the top of walletRoutes.js (after other imports)
// const mongoose = require('mongoose');

// dotenv.config();

// const resend = new Resend(process.env.RESEND_API_KEY);


// // @desc      Handle Flutterwave Webhook for payment events
// // @route     POST /api/wallet/webhook
// // @access    Public (but secured by signature)
// router.post('/webhook', async (req, res) => {
//     // 1. CAPTURE RAW BODY FIRST - Critical for signature verification[citation:1][citation:5]
//     const rawBody = req.body.toString(); // Get the raw string of the request
//     const secretHash = process.env.FLW_SECRET_HASH;

//     // 2. LOG INCOMING REQUEST (for debugging)
//     console.log(`[${new Date().toISOString()}] WEBHOOK RECEIVED: Headers:`, req.headers);
//     console.log(`[${new Date().toISOString()}] WEBHOOK RAW BODY:`, rawBody);

//     // 3. VERIFY SIGNATURE[citation:1][citation:5][citation:7]
//     const signature = req.headers['verif-hash'];
//     if (!secretHash || !signature) {
//         console.error(`[${new Date().toISOString()}] WEBHOOK ERROR: Missing secret hash or signature.`);
//         return res.status(401).send('Unauthorized');
//     }

//     // Compute the expected signature
//     const expectedSignature = crypto
//         .createHmac('sha256', secretHash)
//         .update(rawBody)
//         .digest('hex');

//     if (signature !== expectedSignature) {
//         console.error(`[${new Date().toISOString()}] WEBHOOK ERROR: Invalid signature.`);
//         return res.status(401).send('Unauthorized');
//     }

//     console.log(`[${new Date().toISOString()}] WEBHOOK: Signature verified.`);

//     // 4. PARSE AND PROCESS THE WEBHOOK
//     let event;
//     try {
//         event = JSON.parse(rawBody); // Parse the verified raw body
//     } catch (err) {
//         console.error(`[${new Date().toISOString()}] WEBHOOK ERROR: Invalid JSON.`);
//         return res.status(400).send('Bad Request');
//     }

//     // 5. HANDLE SPECIFIC EVENT TYPES[citation:1][citation:7]
//     // Focus on successful charges for wallet top-up
//     if (event.type === 'charge.completed' || event.event === 'charge.completed') {
//         const transactionData = event.data;
//         console.log(`[${new Date().toISOString()}] WEBHOOK PROCESSING: charge.completed for TX_REF: ${transactionData.tx_ref}`);

//         // 6. IDEMPOTENCY CHECK: Prevent processing the same event twice[citation:8]
//         const existingPayment = await Payment.findOne({ transactionRef: transactionData.tx_ref });
//         if (existingPayment) {
//             console.log(`[${new Date().toISOString()}] WEBHOOK DUPLICATE: TX_REF ${transactionData.tx_ref} already processed.`);
//             return res.status(200).send('OK - Already processed'); // Still return 200
//         }

//         // 7. CRITICAL: VERIFY TRANSACTION WITH FLUTTERWAVE API (Best Practice)[citation:1][citation:6]
//         // Double-check with Flutterwave's API before crediting the wallet.
//         try {
//             const verificationResponse = await axios.get(
//                 `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${transactionData.tx_ref}`,
//                 {
//                     headers: { 'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` }
//                 }
//             );

//             const verifiedData = verificationResponse.data.data;
//             if (verificationResponse.data.status !== 'success' || verifiedData.status !== 'successful') {
//                 console.error(`[${new Date().toISOString()}] WEBHOOK VERIFICATION FAILED: API check unsuccessful for ${transactionData.tx_ref}`);
//                 return res.status(400).send('Verification failed');
//             }

//             // 8. FIND USER (Link via `meta` or other identifier from your initial payment)
//             // IMPORTANT: When initiating payment in Flutter, you MUST include the user's ID in the `meta` field.
//             // Example: meta: { userId: "12345" }. This is how you link the webhook back to the user.
//             const userId = transactionData.meta?.userId;
//             if (!userId) {
//                 console.error(`[${new Date().toISOString()}] WEBHOOK ERROR: No userId found in meta data.`);
//                 return res.status(400).send('Missing user identifier');
//             }

//             // 9. CREDIT USER'S WALLET (Same logic as your verify-payment route)
//             const user = await User.findById(userId);
//             const isRider = user?.role === 'rider';
//             const amount = verifiedData.amount;

//             if (isRider) {
//                 await Rider.findByIdAndUpdate(userId, { $inc: { walletBalance: amount } });
//             } else {
//                 await User.findByIdAndUpdate(userId, { $inc: { userWalletBalance: amount } });
//             }

//             // 10. CREATE PAYMENT RECORD (Idempotency)
//             await Payment.create({
//                 userId: userId,
//                 userType: isRider ? 'rider' : 'user',
//                 transactionRef: transactionData.tx_ref,
//                 amount: amount,
//                 currency: verifiedData.currency,
//                 status: 'successful',
//                 source: 'webhook' // Mark as from webhook
//             });

//             console.log(`[${new Date().toISOString()}] WEBHOOK SUCCESS: Wallet credited for user ${userId} via ref ${transactionData.tx_ref}`);

//             // Emit socket notification, send email, etc.
//             // ... (your notification logic here)

//         } catch (verifyError) {
//             console.error(`[${new Date().toISOString()}] WEBHOOK API VERIFICATION ERROR:`, verifyError.message);
//             // DO NOT credit the wallet. The webhook will be retried[citation:1].
//             return res.status(500).send('Verification error');
//         }
//     } else {
//         console.log(`[${new Date().toISOString()}] WEBHOOK IGNORED: Unhandled event type "${event.type || event.event}".`);
//     }

//     // 11. RESPOND QUICKLY WITH 200[citation:1]
//     // Flutterwave expects a 200 OK response within 60 seconds[citation:1].
//     res.status(200).send('Webhook received');
// });


// // @desc      Verify Flutterwave payment and credit user's wallet
// // @route     POST /api/wallet/verify-payment
// // @access    Private
// router.post('/verify-payment', dualProtect, async (req, res) => {
//     const { transactionRef } = req.body;
//     const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;

//     // CRITICAL LOG: Track request start
//     console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT START: Request from user ${req.user.id}, Ref: ${transactionRef}`);
//     console.log(`[${new Date().toISOString()}] Request Body:`, JSON.stringify(req.body));

//     if (!transactionRef) {
//         console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT ERROR: Missing transactionRef.`);
//         return res.status(400).json({ message: 'Transaction reference is required.' });
//     }

//     if (!flutterwaveSecretKey) {
//         console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT ERROR: FLUTTERWAVE_SECRET_KEY not set.`);
//         return res.status(500).json({ message: 'Server configuration error.' });
//     }

//     try {
//         // SECURITY FIX 1: Check if this transaction reference has already been processed
//         const existingPayment = await Payment.findOne({ transactionRef });
//         if (existingPayment) {
//             console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT DUPLICATE: Ref ${transactionRef} already processed.`);
//             return res.status(409).json({ message: 'Transaction has already been processed.' });
//         }

//         // CRITICAL LOG: Before API call
//         console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT CALLING: Calling Flutterwave API for ref: ${transactionRef}`);

//         const response = await axios.get(
//             `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${transactionRef}`,
//             {
//                 headers: {
//                     'Authorization': `Bearer ${flutterwaveSecretKey}`,
//                     'Content-Type': 'application/json'
//                 }
//             }
//         );

//         // CRITICAL LOG: Raw Flutterwave response
//         console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT RESPONSE: Flutterwave API Status: ${response.status}`);
//         console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT RESPONSE DATA:`, JSON.stringify(response.data));

//         const responseData = response.data;

//         if (responseData.status === 'success' && responseData.data.status === 'successful') {
//             const amount = responseData.data.amount;
//             const currency = responseData.data.currency;
//             console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT SUCCESS: Payment verified. Amount: ${amount} ${currency}`);

//             const user = await User.findById(req.user.id);
//             const isRider = user.role === 'rider';
            
//             let updatedUser;
            
//             if (isRider) {
//                 console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT UPDATING: Crediting rider ${req.user.id} with ${amount}`);
//                 updatedUser = await Rider.findByIdAndUpdate(
//                     req.user.id,
//                     { $inc: { walletBalance: amount } },
//                     { new: true, runValidators: true }
//                 );
//             } else {
//                 console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT UPDATING: Crediting user ${req.user.id} with ${amount}`);
//                 updatedUser = await User.findByIdAndUpdate(
//                     req.user.id,
//                     { $inc: { userWalletBalance: amount } },
//                     { new: true, runValidators: true }
//                 );
//             }

//             if (!updatedUser) {
//                 console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT ERROR: User ${req.user.id} not found after update.`);
//                 return res.status(404).json({ message: 'User not found.' });
//             }

//             // Create a new payment record to prevent future replay attacks
//             await Payment.create({
//                 userId: req.user.id,
//                 userType: isRider ? 'rider' : 'user',
//                 transactionRef: transactionRef,
//                 amount: amount,
//                 currency: currency,
//                 status: 'successful'
//             });

//             console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT COMPLETE: Payment record saved for ref ${transactionRef}`);

//             // Emit socket notification for admin
//             const io = req.app.get('io');
//             if (io) {
//                 const notifyAdmin = req.app.get('notifyAdmin');
//                 if (notifyAdmin) {
//                     notifyAdmin({
//                         type: 'wallet_topup',
//                         message: `${isRider ? 'Rider' : 'User'} ${updatedUser.fullName || updatedUser.firstName} topped up wallet with ₦${amount}`,
//                         userId: req.user.id,
//                         userName: updatedUser.fullName || `${updatedUser.firstName} ${updatedUser.lastName}`,
//                         amount,
//                         userType: isRider ? 'rider' : 'user',
//                         timestamp: new Date()
//                     });
//                 }
//             }

//             console.log(`[${new Date().toISOString()}] VERIFY-PAYMENT SUCCESS END: Returning 200 for ref ${transactionRef}`);
//             return res.status(200).json({
//                 message: `Wallet credited with ${amount} ${currency}.`,
//                 newBalance: isRider ? updatedUser.walletBalance : updatedUser.userWalletBalance
//             });
//         } else {
//             console.warn(`[${new Date().toISOString()}] VERIFY-PAYMENT FAILED: Flutterwave status not successful. Data:`, responseData);
//             return res.status(400).json({
//                 message: 'Payment verification failed or payment was not successful.'
//             });
//         }
//     } catch (error) {
//         // CRITICAL LOG: This is where your error is likely being thrown
//         console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT CATCH-ERROR:`, error.message);
//         console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT CATCH-ERROR STACK:`, error.stack);

//         // In case of a database error (e.g., transactionRef unique key violation)
//         if (error.code === 11000) { // MongoDB's code for a duplicate key error
//             console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT DUPLICATE KEY: ${transactionRef}`);
//             return res.status(409).json({ message: 'Transaction has already been processed.' });
//         }

//         if (error.response) {
//             // The request was made and the server responded with a status code outside 2xx
//             console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT FLUTTERWAVE API ERROR:`, error.response.data);
//             console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT FLUTTERWAVE API STATUS:`, error.response.status);
//             // Return the exact error from Flutterwave if available
//             const errorMessage = error.response.data?.message || 'Flutterwave verification failed.';
//             return res.status(400).json({ message: errorMessage });
//         } else if (error.request) {
//             // The request was made but no response was received
//             console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT NETWORK ERROR: No response received from Flutterwave API.`);
//             return res.status(500).json({ message: 'Network error. Could not reach payment processor.' });
//         } else {
//             // Something happened in setting up the request that triggered an Error
//             console.error(`[${new Date().toISOString()}] VERIFY-PAYMENT CONFIGURATION ERROR:`, error.message);
//             return res.status(500).json({ message: 'Error verifying payment.' });
//         }
//     }
// });

// // // @desc      Verify Flutterwave payment and credit user's wallet
// // // @route     POST /api/wallet/verify-payment
// // // @access    Private
// // router.post('/verify-payment', protect, async (req, res) => {
// //     const { transactionRef } = req.body;
// //     const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;

// //     if (!transactionRef) {
// //         return res.status(400).json({ message: 'Transaction reference is required.' });
// //     }

// //     if (!flutterwaveSecretKey) {
// //         console.error('FLUTTERWAVE_SECRET_KEY is not set in environment variables.');
// //         return res.status(500).json({ message: 'Server configuration error.' });
// //     }

// //     try {
// //         // SECURITY FIX 1: Check if this transaction reference has already been processed
// //         const existingPayment = await Payment.findOne({ transactionRef });
// //         if (existingPayment) {
// //             return res.status(409).json({ message: 'Transaction has already been processed.' });
// //         }

// //         const response = await axios.get(
// //             `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${transactionRef}`,
// //             {
// //                 headers: {
// //                     'Authorization': `Bearer ${flutterwaveSecretKey}`,
// //                     'Content-Type': 'application/json'
// //                 }
// //             }
// //         );

// //         const responseData = response.data;

// //         if (responseData.status === 'success' && responseData.data.status === 'successful') {
// //             const amount = responseData.data.amount;
// //             const currency = responseData.data.currency;

// //             // Check if user is a rider or regular user
// //             const user = await User.findById(req.user.id);
// //             const isRider = user.role === 'rider';
            
// //             let updatedUser;
            
// //             if (isRider) {
// //                 // Credit rider's wallet
// //                 updatedUser = await Rider.findByIdAndUpdate(
// //                     req.user.id,
// //                     { $inc: { walletBalance: amount } },
// //                     { new: true, runValidators: true }
// //                 );
// //             } else {
// //                 // Credit regular user's wallet
// //                 updatedUser = await User.findByIdAndUpdate(
// //                     req.user.id,
// //                     { $inc: { userWalletBalance: amount } },
// //                     { new: true, runValidators: true }
// //                 );
// //             }

// //             if (!updatedUser) {
// //                 return res.status(404).json({ message: 'User not found.' });
// //             }

// //             // Create a new payment record to prevent future replay attacks
// //             await Payment.create({
// //                 userId: req.user.id,
// //                 userType: isRider ? 'rider' : 'user',
// //                 transactionRef: transactionRef,
// //                 amount: amount,
// //                 currency: currency,
// //                 status: 'successful'
// //             });

// //             // Emit socket notification for admin
// //             const io = req.app.get('io');
// //             if (io) {
// //                 const notifyAdmin = req.app.get('notifyAdmin');
// //                 if (notifyAdmin) {
// //                     notifyAdmin({
// //                         type: 'wallet_topup',
// //                         message: `${isRider ? 'Rider' : 'User'} ${updatedUser.fullName || updatedUser.firstName} topped up wallet with ₦${amount}`,
// //                         userId: req.user.id,
// //                         userName: updatedUser.fullName || `${updatedUser.firstName} ${updatedUser.lastName}`,
// //                         amount,
// //                         userType: isRider ? 'rider' : 'user',
// //                         timestamp: new Date()
// //                     });
// //                 }
// //             }

// //             return res.status(200).json({
// //                 message: `Wallet credited with ${amount} ${currency}.`,
// //                 newBalance: isRider ? updatedUser.walletBalance : updatedUser.userWalletBalance
// //             });
// //         } else {
// //             return res.status(400).json({
// //                 message: 'Payment verification failed or payment was not successful.'
// //             });
// //         }
// //     } catch (error) {
// //         // In case of a database error (e.g., transactionRef unique key violation)
// //         if (error.code === 11000) { // MongoDB's code for a duplicate key error
// //             return res.status(409).json({ message: 'Transaction has already been processed.' });
// //         }

// //         if (error.response) {
// //             console.error('Flutterwave API responded with an error:', error.response.data);
// //             res.status(400).json({ message: 'Flutterwave verification failed.' });
// //         } else {
// //             console.error('Error during payment verification:', error.message);
// //             res.status(500).json({ message: 'Error verifying payment.' });
// //         }
// //     }
// // });


// // @desc    Get list of banks (via Flutterwave)
// // @route   GET /api/wallet/banks
// // @access  Private
// router.get('/banks', dualProtect, async (req, res) => {
//     try {
//         const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;
//         if (!flutterwaveSecretKey) {
//             return res.status(500).json({ message: 'Missing Flutterwave Secret Key.' });
//         }

//         const response = await axios.get(
//             'https://api.flutterwave.com/v3/banks/NG',
//             {
//                 headers: {
//                     Authorization: `Bearer ${flutterwaveSecretKey}`
//                 }
//             }
//         );

//         if (response.data && response.data.status === 'success') {
//             return res.status(200).json({
//                 banks: response.data.data
//             });
//         } else {
//             return res.status(400).json({ message: 'Failed to fetch banks from Flutterwave.' });
//         }
//     } catch (error) {
//         console.error('Error fetching banks:', error.response?.data || error.message);
//         return res.status(500).json({ message: 'Error fetching banks.' });
//     }
// });


// // @desc      Request an OTP for withdrawal
// // @route     POST /api/wallet/request-otp
// // @access    Private
// router.post('/request-otp', dualProtect, async (req, res) => {
//     try {
//         let user;
//         const isRider = req.user.role === 'rider';
        
//         if (isRider) {
//             user = await Rider.findById(req.user.id);
//         } else {
//             user = await User.findById(req.user.id);
//         }
        
//         if (!user) {
//             return res.status(404).json({ message: 'User not found.' });
//         }

//         // Generate a 6-digit OTP
//         const otp = Math.floor(100000 + Math.random() * 900000).toString();
//         // Set OTP expiration to 5 minutes from now
//         const otpExpires = Date.now() + 5 * 60 * 1000;

//         // Save the OTP and its expiration to the user's document
//         user.otp = otp;
//         user.otpExpires = otpExpires;
//         await user.save();

//         // Send the OTP via Resend
//         const { data, error } = await resend.emails.send({
//             from: 'NaijaGo <noreply@naijagoapp.com>',
//             to: [user.email],
//             subject: 'Your Withdrawal Verification Code',
//             html: `
//                     <div style="font-family: 'Arial', sans-serif; background-color: #f7f7f7; padding: 20px; border-radius: 10px; border: 1px solid #ddd; max-width: 600px; margin: 20px auto;">
//                         <div style="text-align: center; margin-bottom: 20px;">
//                             <img src="https://naijago-backend.onrender.com/naijago-app.jpg" alt="NaijaGo Logo" style="width: 150px; height: auto;">
//                         </div>
//                         <div style="background-color: #160d0dff; padding: 20px; border-radius: 8px;">
//                             <h2 style="color: #000080; text-align: center; font-size: 24px;">Withdrawal Verification Code</h2>
//                             <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
//                             <p style="color: #555;">Hello ${user.fullName || user.firstName},</p>
//                             <p style="color: #555;">To complete your withdrawal, please use the following One-Time Password (OTP):</p>
//                             <div style="text-align: center; margin: 30px 0;">
//                                 <span style="display: inline-block; padding: 15px 25px; background-color: #ADFF2F; color: #000080; font-size: 28px; font-weight: bold; letter-spacing: 2px; border-radius: 8px;">${otp}</span>
//                             </div>
//                             <p style="color: #888; text-align: center; font-size: 14px;">This code is valid for 5 minutes. For your security, do not share this code.</p>
//                             <p style="color: #888; font-size: 14px; margin-top: 30px;">If you did not request this, please contact support immediately.</p>
//                             <img src="https://naijago-backend.onrender.com/naijago-flier3.jpg" alt="NaijaGo Flier" style="width: 150px; height: auto;">
//                         </div>
//                         <div style="text-align: center; margin-top: 20px; color: #aaa; font-size: 12px;">
//                             <p>&copy; ${new Date().getFullYear()} NaijaGo. All rights reserved.</p>
//                         </div>
//                     </div>
//                 `
//         });

//         if (error) {
//             console.error('Resend email error:', error);
//             // Even if email fails, we tell the user it was sent to avoid leaking info.
//             return res.status(500).json({ message: 'Failed to send OTP email.' });
//         }

//         console.log(`[DEV-LOG] OTP sent to ${user.email} with Resend ID: ${data.id}`);
//         res.status(200).json({ message: 'OTP sent to your email address.' });

//     } catch (error) {
//         console.error('Error requesting OTP:', error.message);
//         res.status(500).json({ message: 'Error requesting OTP.' });
//     }
// });

// // @desc      Withdraw funds from wallet to bank account
// // @route     POST /api/wallet/withdraw
// // @access    Private
// router.post('/withdraw', dualProtect, async (req, res) => {
//     const { bank_code, account_number, account_name, amount, otp, wallet_type } = req.body;

//     if (!bank_code || !account_number || !account_name || !amount || !otp || !wallet_type) {
//         return res.status(400).json({ message: 'All required fields are needed.' });
//     }

//     if (amount <= 0) {
//         return res.status(400).json({ message: 'Invalid withdrawal amount.' });
//     }

//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         const isRider = req.user.role === 'rider';
//         let user;
        
//         if (isRider) {
//             user = await Rider.findById(req.user.id).session(session);
//         } else {
//             user = await User.findById(req.user.id).session(session);
//         }
        
//         if (!user) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(404).json({ message: 'User not found.' });
//         }
        
//         // 1. OTP Verification is performed first
//         if (user.otp !== otp || user.otpExpires < Date.now()) {
//             user.otp = undefined;
//             user.otpExpires = undefined;
//             await user.save({ session });
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(401).json({ message: 'Invalid or expired OTP.' });
//         }

//         // 2. Check wallet balance
//         const balanceField = isRider ? 'walletBalance' : 
//                            (wallet_type === 'vendor' ? 'vendorWalletBalance' : 'userWalletBalance');
//         const currentBalance = user[balanceField] || 0;
        
//         if (currentBalance < amount) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ 
//                 message: `Insufficient balance. Available: ₦${currentBalance.toFixed(2)}, Requested: ₦${amount}` 
//             });
//         }

//         // 3. Minimum withdrawal check
//         const MIN_WITHDRAWAL = 100;
//         if (amount < MIN_WITHDRAWAL) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ 
//                 message: `Minimum withdrawal amount is ₦${MIN_WITHDRAWAL}` 
//             });
//         }

//         // 4. Generate unique reference
//         const reference = `WD${Date.now()}${Math.floor(Math.random() * 1000)}${isRider ? 'R' : 'U'}`;

//         // 5. Create withdrawal record
//         const withdrawalRecord = {
//             amount,
//             status: 'pending',
//             createdAt: Date.now(),
//             reference,
//             paymentMethod: 'bank_transfer',
//             accountDetails: {
//                 bankCode: bank_code,
//                 bankName: req.body.bank_name || '',
//                 accountNumber: account_number,
//                 accountName: account_name
//             }
//         };

//         // 6. Update user balance and add withdrawal history
//         user[balanceField] = currentBalance - amount;
//         user.otp = undefined;
//         user.otpExpires = undefined;
        
//         if (isRider) {
//             user.pendingEarnings = (user.pendingEarnings || 0) + amount;
//             user.withdrawalHistory.push(withdrawalRecord);
//         } else {
//             // For vendors, track in vendorWithdrawals
//             if (wallet_type === 'vendor') {
//                 user.vendorWithdrawals = user.vendorWithdrawals || [];
//                 user.vendorWithdrawals.push(withdrawalRecord);
//             } else {
//                 user.userWithdrawals = user.userWithdrawals || [];
//                 user.userWithdrawals.push(withdrawalRecord);
//             }
//         }

//         await user.save({ session });

//         // 7. Send Flutterwave transfer request
//         const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;
//         if (!flutterwaveSecretKey) {
//             await session.commitTransaction();
//             session.endSession();
//             return res.status(500).json({ message: 'Missing Flutterwave Secret Key.' });
//         }

//         const transferPayload = {
//             account_bank: bank_code,
//             account_number: account_number,
//             amount: amount,
//             narration: `Withdrawal from ${isRider ? 'rider' : wallet_type} wallet - ${reference}`,
//             currency: "NGN",
//             reference: reference,
//             debit_currency: "NGN",
//             meta: {
//                 userId: req.user.id,
//                 userType: isRider ? 'rider' : (wallet_type === 'vendor' ? 'vendor' : 'user'),
//                 userName: user.fullName || `${user.firstName} ${user.lastName}`,
//                 email: user.email
//             }
//         };

//         let transferResponse;
//         try {
//             transferResponse = await axios.post(
//                 "https://api.flutterwave.com/v3/transfers",
//                 transferPayload,
//                 {
//                     headers: {
//                         Authorization: `Bearer ${flutterwaveSecretKey}`,
//                         "Content-Type": "application/json"
//                     }
//                 }
//             );
//         } catch (flwError) {
//             console.error('Flutterwave transfer error:', flwError.response?.data || flwError.message);
//             // If Flutterwave fails, we still record the withdrawal as pending
//             // Admin will process manually later
//         }

//         // 8. Update withdrawal record with Flutterwave response
//         if (transferResponse?.data?.status === "success") {
//             withdrawalRecord.flutterwaveId = transferResponse.data.data.id;
//             withdrawalRecord.flutterwaveStatus = transferResponse.data.data.status;
            
//             // Auto-complete small withdrawals (under ₦5000)
//             if (amount <= 5000) {
//                 withdrawalRecord.status = 'completed';
//                 withdrawalRecord.completedAt = Date.now();
                
//                 if (isRider) {
//                     user.pendingEarnings = Math.max(0, (user.pendingEarnings || 0) - amount);
//                     user.totalWithdrawn = (user.totalWithdrawn || 0) + amount;
//                 }
//             }
//         }

//         // Save updated withdrawal record
//         if (isRider) {
//             // Update the specific withdrawal record in the array
//             const withdrawalIndex = user.withdrawalHistory.length - 1;
//             user.withdrawalHistory[withdrawalIndex] = withdrawalRecord;
//         } else if (wallet_type === 'vendor') {
//             const withdrawalIndex = user.vendorWithdrawals.length - 1;
//             user.vendorWithdrawals[withdrawalIndex] = withdrawalRecord;
//         } else {
//             const withdrawalIndex = user.userWithdrawals.length - 1;
//             user.userWithdrawals[withdrawalIndex] = withdrawalRecord;
//         }

//         await user.save({ session });

//         // 9. Emit socket notification for admin
//         const io = req.app.get('io');
//         if (io) {
//             const notifyAdmin = req.app.get('notifyAdmin');
//             if (notifyAdmin) {
//                 notifyAdmin({
//                     type: 'withdrawal_request',
//                     message: `${isRider ? 'Rider' : (wallet_type === 'vendor' ? 'Vendor' : 'User')} ${user.fullName || user.firstName} requested withdrawal of ₦${amount}`,
//                     userId: req.user.id,
//                     userName: user.fullName || `${user.firstName} ${user.lastName}`,
//                     amount,
//                     reference,
//                     userType: isRider ? 'rider' : (wallet_type === 'vendor' ? 'vendor' : 'user'),
//                     status: withdrawalRecord.status,
//                     timestamp: new Date()
//                 });
//             }
//         }

//         await session.commitTransaction();
//         session.endSession();

//         // 10. Send email confirmation
//         try {
//             await resend.emails.send({
//                 from: 'NaijaGo <noreply@naijagoapp.com>',
//                 to: [user.email],
//                 subject: 'Withdrawal Request Received',
//                 html: `
//                     <div style="font-family: 'Arial', sans-serif; background-color: #f7f7f7; padding: 20px; border-radius: 10px; border: 1px solid #ddd; max-width: 600px; margin: 20px auto;">
//                         <div style="text-align: center; margin-bottom: 20px;">
//                             <img src="https://naijago-backend.onrender.com/naijago-app.jpg" alt="NaijaGo Logo" style="width: 150px; height: auto;">
//                         </div>
//                         <div style="background-color: #160d0dff; padding: 20px; border-radius: 8px;">
//                             <h2 style="color: #000080; text-align: center; font-size: 24px;">Withdrawal Request Confirmed</h2>
//                             <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
//                             <p style="color: #555;">Hello ${user.fullName || user.firstName},</p>
//                             <p style="color: #555;">Your withdrawal request has been received and is being processed.</p>
//                             <div style="text-align: center; margin: 30px 0; padding: 20px; background-color: #2d3748; border-radius: 8px;">
//                                 <p style="color: #fff; font-size: 14px; margin: 0;">Reference: <strong>${reference}</strong></p>
//                                 <p style="color: #ADFF2F; font-size: 28px; font-weight: bold; margin: 10px 0;">₦${amount.toFixed(2)}</p>
//                                 <p style="color: #fff; font-size: 14px; margin: 0;">Status: <strong>${withdrawalRecord.status.toUpperCase()}</strong></p>
//                                 <p style="color: #fff; font-size: 12px; margin: 10px 0 0 0;">Account: ${account_number} (${account_name})</p>
//                             </div>
//                             <p style="color: #888; text-align: center; font-size: 14px;">
//                                 ${withdrawalRecord.status === 'completed' 
//                                     ? 'Your withdrawal has been processed successfully. Funds should arrive in your account within 24 hours.' 
//                                     : 'Your withdrawal is pending approval. You will be notified once processed.'}
//                             </p>
//                             <p style="color: #888; font-size: 14px; margin-top: 30px;">
//                                 If you did not request this withdrawal, please contact support immediately.
//                             </p>
//                         </div>
//                         <div style="text-align: center; margin-top: 20px; color: #aaa; font-size: 12px;">
//                             <p>&copy; ${new Date().getFullYear()} NaijaGo. All rights reserved.</p>
//                         </div>
//                     </div>
//                 `
//             });
//         } catch (emailError) {
//             console.error('Withdrawal confirmation email error:', emailError);
//         }

//         res.status(200).json({
//             success: true,
//             message: `Withdrawal request submitted ${withdrawalRecord.status === 'completed' ? 'and processed' : 'successfully'}.`,
//             reference,
//             status: withdrawalRecord.status,
//             amount,
//             newBalance: user[balanceField],
//             estimatedArrival: withdrawalRecord.status === 'completed' ? 'Within 24 hours' : 'After admin approval'
//         });

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error processing withdrawal:', error.message);
//         res.status(500).json({ message: 'Error processing withdrawal.' });
//     }
// });

// // @desc      Get withdrawal history
// // @route     GET /api/wallet/withdrawals
// // @access    Private
// router.get('/withdrawals', dualProtect, async (req, res) => {
//     try {
//         const isRider = req.user.role === 'rider';
//         let user;
        
//         if (isRider) {
//             user = await Rider.findById(req.user.id).select('withdrawalHistory');
//         } else {
//             user = await User.findById(req.user.id).select('vendorWithdrawals userWithdrawals');
//         }
        
//         if (!user) {
//             return res.status(404).json({ message: 'User not found.' });
//         }

//         let withdrawals = [];
//         if (isRider) {
//             withdrawals = user.withdrawalHistory || [];
//         } else {
//             // Combine vendor and user withdrawals
//             withdrawals = [
//                 ...(user.vendorWithdrawals || []),
//                 ...(user.userWithdrawals || [])
//             ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
//         }

//         // Calculate totals
//         const totalWithdrawn = withdrawals.reduce((sum, w) => sum + w.amount, 0);
//         const pendingWithdrawals = withdrawals.filter(w => w.status === 'pending');
//         const totalPending = pendingWithdrawals.reduce((sum, w) => sum + w.amount, 0);

//         res.json({
//             withdrawals,
//             summary: {
//                 totalCount: withdrawals.length,
//                 totalWithdrawn,
//                 totalPending,
//                 pendingCount: pendingWithdrawals.length,
//                 completedCount: withdrawals.filter(w => w.status === 'completed').length,
//                 failedCount: withdrawals.filter(w => w.status === 'failed').length
//             }
//         });

//     } catch (error) {
//         console.error('Error fetching withdrawal history:', error.message);
//         res.status(500).json({ message: 'Error fetching withdrawal history.' });
//     }
// });

// // @desc      Get wallet balance and statistics
// // @route     GET /api/wallet/balance
// // @access    Private
// router.get('/balance', dualProtect, async (req, res) => {
//     try {
//         const isRider = req.user.role === 'rider';
//         let user;
        
//         if (isRider) {
//             user = await Rider.findById(req.user.id).select('walletBalance totalEarnings pendingEarnings totalWithdrawn');
//         } else {
//             user = await User.findById(req.user.id).select('userWalletBalance vendorWalletBalance totalVendorEarnings totalUserSpent');
//         }
        
//         if (!user) {
//             return res.status(404).json({ message: 'User not found.' });
//         }

//         const response = {
//             isRider,
//             timestamp: new Date()
//         };

//         if (isRider) {
//             response.walletBalance = user.walletBalance || 0;
//             response.totalEarnings = user.totalEarnings || 0;
//             response.pendingEarnings = user.pendingEarnings || 0;
//             response.totalWithdrawn = user.totalWithdrawn || 0;
//             response.availableForWithdrawal = user.walletBalance || 0;
//             response.canWithdraw = (user.walletBalance || 0) >= 100;
//             response.minimumWithdrawal = 100;
//         } else {
//             response.userWalletBalance = user.userWalletBalance || 0;
//             response.vendorWalletBalance = user.vendorWalletBalance || 0;
//             response.totalVendorEarnings = user.totalVendorEarnings || 0;
//             response.totalUserSpent = user.totalUserSpent || 0;
//             response.canWithdrawVendor = (user.vendorWalletBalance || 0) >= 100;
//             response.canWithdrawUser = (user.userWalletBalance || 0) >= 100;
//             response.minimumWithdrawal = 100;
//         }

//         res.json(response);

//     } catch (error) {
//         console.error('Error fetching wallet balance:', error.message);
//         res.status(500).json({ message: 'Error fetching wallet balance.' });
//     }
// });

// // ============================================
// // ADMIN WITHDRAWAL MANAGEMENT ROUTES
// // ============================================

// // @desc      Get all pending withdrawals (Admin only)
// // @route     GET /api/wallet/admin/pending-withdrawals
// // @access    Private/Admin
// router.get('/admin/pending-withdrawals', protect, authorizeRoles('admin'), async (req, res) => {
//     try {
//         const page = parseInt(req.query.page) || 1;
//         const limit = parseInt(req.query.limit) || 20;
//         const skip = (page - 1) * limit;
//         const status = req.query.status || 'pending';
//         const userType = req.query.userType; // 'rider', 'vendor', 'user', or undefined for all

//         let query = {};
//         if (status !== 'all') {
//             query['withdrawalHistory.status'] = status;
//         }

//         // Get rider withdrawals
//         let riderWithdrawals = [];
//         if (!userType || userType === 'rider') {
//             const riders = await Rider.find({
//                 'withdrawalHistory.status': status !== 'all' ? status : { $exists: true }
//             }).select('fullName email phoneNumber plateNumber withdrawalHistory');
            
//             riders.forEach(rider => {
//                 rider.withdrawalHistory.forEach(withdrawal => {
//                     if (status === 'all' || withdrawal.status === status) {
//                         riderWithdrawals.push({
//                             ...withdrawal.toObject(),
//                             userType: 'rider',
//                             userId: rider._id,
//                             userName: rider.fullName,
//                             userEmail: rider.email,
//                             userPhone: rider.phoneNumber,
//                             plateNumber: rider.plateNumber
//                         });
//                     }
//                 });
//             });
//         }

//         // Get vendor withdrawals
//         let vendorWithdrawals = [];
//         if (!userType || userType === 'vendor') {
//             const vendors = await User.find({
//                 role: 'vendor',
//                 'vendorWithdrawals.status': status !== 'all' ? status : { $exists: true }
//             }).select('firstName lastName email phoneNumber businessName vendorWithdrawals');
            
//             vendors.forEach(vendor => {
//                 (vendor.vendorWithdrawals || []).forEach(withdrawal => {
//                     if (status === 'all' || withdrawal.status === status) {
//                         vendorWithdrawals.push({
//                             ...withdrawal.toObject(),
//                             userType: 'vendor',
//                             userId: vendor._id,
//                             userName: `${vendor.firstName} ${vendor.lastName}`,
//                             businessName: vendor.businessName,
//                             userEmail: vendor.email,
//                             userPhone: vendor.phoneNumber
//                         });
//                     }
//                 });
//             });
//         }

//         // Get user withdrawals
//         let userWithdrawals = [];
//         if (!userType || userType === 'user') {
//             const users = await User.find({
//                 role: 'user',
//                 'userWithdrawals.status': status !== 'all' ? status : { $exists: true }
//             }).select('firstName lastName email phoneNumber userWithdrawals');
            
//             users.forEach(user => {
//                 (user.userWithdrawals || []).forEach(withdrawal => {
//                     if (status === 'all' || withdrawal.status === status) {
//                         userWithdrawals.push({
//                             ...withdrawal.toObject(),
//                             userType: 'user',
//                             userId: user._id,
//                             userName: `${user.firstName} ${user.lastName}`,
//                             userEmail: user.email,
//                             userPhone: user.phoneNumber
//                         });
//                     }
//                 });
//             });
//         }

//         // Combine all withdrawals
//         const allWithdrawals = [...riderWithdrawals, ...vendorWithdrawals, ...userWithdrawals]
//             .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

//         // Paginate
//         const total = allWithdrawals.length;
//         const paginatedWithdrawals = allWithdrawals.slice(skip, skip + limit);

//         // Calculate totals
//         const totalAmount = allWithdrawals.reduce((sum, w) => sum + w.amount, 0);
//         const pendingAmount = allWithdrawals.filter(w => w.status === 'pending').reduce((sum, w) => sum + w.amount, 0);

//         res.json({
//             withdrawals: paginatedWithdrawals,
//             pagination: {
//                 page,
//                 limit,
//                 total,
//                 pages: Math.ceil(total / limit)
//             },
//             summary: {
//                 totalWithdrawals: total,
//                 totalAmount,
//                 pendingAmount,
//                 riderCount: riderWithdrawals.length,
//                 vendorCount: vendorWithdrawals.length,
//                 userCount: userWithdrawals.length,
//                 pendingCount: allWithdrawals.filter(w => w.status === 'pending').length,
//                 completedCount: allWithdrawals.filter(w => w.status === 'completed').length,
//                 failedCount: allWithdrawals.filter(w => w.status === 'failed').length
//             }
//         });

//     } catch (error) {
//         console.error('Error fetching pending withdrawals:', error.message);
//         res.status(500).json({ message: 'Error fetching pending withdrawals.' });
//     }
// });

// // @desc      Process a withdrawal (Admin only)
// // @route     PUT /api/wallet/admin/process-withdrawal/:reference
// // @access    Private/Admin
// router.put('/admin/process-withdrawal/:reference', protect, authorizeRoles('admin'), async (req, res) => {
//     const { reference } = req.params;
//     const { status, failureReason } = req.body;

//     if (!['completed', 'failed'].includes(status)) {
//         return res.status(400).json({ message: 'Status must be either "completed" or "failed".' });
//     }

//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         // Try to find in riders first
//         let rider = await Rider.findOne({
//             'withdrawalHistory.reference': reference
//         }).session(session);

//         if (rider) {
//             const withdrawalIndex = rider.withdrawalHistory.findIndex(w => w.reference === reference);
//             if (withdrawalIndex === -1) {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(404).json({ message: 'Withdrawal not found.' });
//             }

//             const withdrawal = rider.withdrawalHistory[withdrawalIndex];
            
//             if (withdrawal.status === 'completed') {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(400).json({ message: 'Withdrawal already processed.' });
//             }

//             // Update withdrawal
//             rider.withdrawalHistory[withdrawalIndex].status = status;
//             rider.withdrawalHistory[withdrawalIndex].completedAt = Date.now();
//             rider.withdrawalHistory[withdrawalIndex].processedBy = req.user.id;
            
//             if (status === 'failed' && failureReason) {
//                 rider.withdrawalHistory[withdrawalIndex].failureReason = failureReason;
//                 // Refund the amount back to wallet
//                 rider.walletBalance = (rider.walletBalance || 0) + withdrawal.amount;
//                 rider.pendingEarnings = Math.max(0, (rider.pendingEarnings || 0) - withdrawal.amount);
//             } else if (status === 'completed') {
//                 rider.pendingEarnings = Math.max(0, (rider.pendingEarnings || 0) - withdrawal.amount);
//                 rider.totalWithdrawn = (rider.totalWithdrawn || 0) + withdrawal.amount;
//             }

//             await rider.save({ session });

//             // Emit socket notification
//             const io = req.app.get('io');
//             if (io) {
//                 const notifyRider = req.app.get('notifyRider');
//                 if (notifyRider) {
//                     notifyRider(rider._id, {
//                         type: 'withdrawal_processed',
//                         message: `Your withdrawal of ₦${withdrawal.amount} has been ${status}`,
//                         amount: withdrawal.amount,
//                         status,
//                         reference,
//                         timestamp: new Date()
//                     });
//                 }
//             }

//             await session.commitTransaction();
//             session.endSession();

//             return res.json({
//                 success: true,
//                 message: `Rider withdrawal ${status} successfully.`,
//                 withdrawal: rider.withdrawalHistory[withdrawalIndex]
//             });
//         }

//         // If not found in riders, try vendors
//         let vendor = await User.findOne({
//             role: 'vendor',
//             'vendorWithdrawals.reference': reference
//         }).session(session);

//         if (vendor) {
//             const withdrawalIndex = vendor.vendorWithdrawals.findIndex(w => w.reference === reference);
//             if (withdrawalIndex === -1) {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(404).json({ message: 'Withdrawal not found.' });
//             }

//             const withdrawal = vendor.vendorWithdrawals[withdrawalIndex];
            
//             if (withdrawal.status === 'completed') {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(400).json({ message: 'Withdrawal already processed.' });
//             }

//             // Update withdrawal
//             vendor.vendorWithdrawals[withdrawalIndex].status = status;
//             vendor.vendorWithdrawals[withdrawalIndex].completedAt = Date.now();
//             vendor.vendorWithdrawals[withdrawalIndex].processedBy = req.user.id;
            
//             if (status === 'failed' && failureReason) {
//                 vendor.vendorWithdrawals[withdrawalIndex].failureReason = failureReason;
//                 // Refund the amount back to vendor wallet
//                 vendor.vendorWalletBalance = (vendor.vendorWalletBalance || 0) + withdrawal.amount;
//             }

//             await vendor.save({ session });

//             await session.commitTransaction();
//             session.endSession();

//             return res.json({
//                 success: true,
//                 message: `Vendor withdrawal ${status} successfully.`,
//                 withdrawal: vendor.vendorWithdrawals[withdrawalIndex]
//             });
//         }

//         // If not found in vendors, try regular users
//         let user = await User.findOne({
//             role: 'user',
//             'userWithdrawals.reference': reference
//         }).session(session);

//         if (user) {
//             const withdrawalIndex = user.userWithdrawals.findIndex(w => w.reference === reference);
//             if (withdrawalIndex === -1) {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(404).json({ message: 'Withdrawal not found.' });
//             }

//             const withdrawal = user.userWithdrawals[withdrawalIndex];
            
//             if (withdrawal.status === 'completed') {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(400).json({ message: 'Withdrawal already processed.' });
//             }

//             // Update withdrawal
//             user.userWithdrawals[withdrawalIndex].status = status;
//             user.userWithdrawals[withdrawalIndex].completedAt = Date.now();
//             user.userWithdrawals[withdrawalIndex].processedBy = req.user.id;
            
//             if (status === 'failed' && failureReason) {
//                 user.userWithdrawals[withdrawalIndex].failureReason = failureReason;
//                 // Refund the amount back to user wallet
//                 user.userWalletBalance = (user.userWalletBalance || 0) + withdrawal.amount;
//             }

//             await user.save({ session });

//             await session.commitTransaction();
//             session.endSession();

//             return res.json({
//                 success: true,
//                 message: `User withdrawal ${status} successfully.`,
//                 withdrawal: user.userWithdrawals[withdrawalIndex]
//             });
//         }

//         await session.abortTransaction();
//         session.endSession();
//         return res.status(404).json({ message: 'Withdrawal not found.' });

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error processing withdrawal:', error.message);
//         res.status(500).json({ message: 'Error processing withdrawal.' });
//     }
// });

// // @desc      Bulk process withdrawals (Admin only)
// // @route     POST /api/wallet/admin/bulk-process-withdrawals
// // @access    Private/Admin
// router.post('/admin/bulk-process-withdrawals', protect, authorizeRoles('admin'), async (req, res) => {
//     const { references, status } = req.body;

//     if (!Array.isArray(references) || references.length === 0) {
//         return res.status(400).json({ message: 'References array is required.' });
//     }

//     if (!['completed', 'failed'].includes(status)) {
//         return res.status(400).json({ message: 'Status must be either "completed" or "failed".' });
//     }

//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         const results = {
//             processed: 0,
//             failed: 0,
//             errors: []
//         };

//         for (const reference of references) {
//             try {
//                 // Similar logic as single processing but in bulk
//                 // For brevity, implementing single processing in loop
//                 // In production, you might want to optimize this
                
//                 let processed = false;
                
//                 // Try riders
//                 let rider = await Rider.findOne({ 'withdrawalHistory.reference': reference }).session(session);
//                 if (rider) {
//                     const withdrawalIndex = rider.withdrawalHistory.findIndex(w => w.reference === reference);
//                     if (withdrawalIndex !== -1 && rider.withdrawalHistory[withdrawalIndex].status !== 'completed') {
//                         rider.withdrawalHistory[withdrawalIndex].status = status;
//                         rider.withdrawalHistory[withdrawalIndex].completedAt = Date.now();
//                         rider.withdrawalHistory[withdrawalIndex].processedBy = req.user.id;
                        
//                         if (status === 'completed') {
//                             rider.pendingEarnings = Math.max(0, (rider.pendingEarnings || 0) - rider.withdrawalHistory[withdrawalIndex].amount);
//                             rider.totalWithdrawn = (rider.totalWithdrawn || 0) + rider.withdrawalHistory[withdrawalIndex].amount;
//                         }
                        
//                         await rider.save({ session });
//                         results.processed++;
//                         processed = true;
//                     }
//                 }

//                 if (!processed) {
//                     // Try vendors
//                     let vendor = await User.findOne({ 
//                         role: 'vendor',
//                         'vendorWithdrawals.reference': reference 
//                     }).session(session);
                    
//                     if (vendor) {
//                         const withdrawalIndex = vendor.vendorWithdrawals.findIndex(w => w.reference === reference);
//                         if (withdrawalIndex !== -1 && vendor.vendorWithdrawals[withdrawalIndex].status !== 'completed') {
//                             vendor.vendorWithdrawals[withdrawalIndex].status = status;
//                             vendor.vendorWithdrawals[withdrawalIndex].completedAt = Date.now();
//                             vendor.vendorWithdrawals[withdrawalIndex].processedBy = req.user.id;
//                             await vendor.save({ session });
//                             results.processed++;
//                             processed = true;
//                         }
//                     }
//                 }

//                 if (!processed) {
//                     // Try users
//                     let user = await User.findOne({ 
//                         role: 'user',
//                         'userWithdrawals.reference': reference 
//                     }).session(session);
                    
//                     if (user) {
//                         const withdrawalIndex = user.userWithdrawals.findIndex(w => w.reference === reference);
//                         if (withdrawalIndex !== -1 && user.userWithdrawals[withdrawalIndex].status !== 'completed') {
//                             user.userWithdrawals[withdrawalIndex].status = status;
//                             user.userWithdrawals[withdrawalIndex].completedAt = Date.now();
//                             user.userWithdrawals[withdrawalIndex].processedBy = req.user.id;
//                             await user.save({ session });
//                             results.processed++;
//                             processed = true;
//                         }
//                     }
//                 }

//                 if (!processed) {
//                     results.failed++;
//                     results.errors.push({
//                         reference,
//                         error: 'Withdrawal not found or already processed'
//                     });
//                 }

//             } catch (error) {
//                 results.failed++;
//                 results.errors.push({
//                     reference,
//                     error: error.message
//                 });
//             }
//         }

//         await session.commitTransaction();
//         session.endSession();

//         // Emit socket notification for bulk processing
//         const io = req.app.get('io');
//         if (io) {
//             const notifyAdmin = req.app.get('notifyAdmin');
//             if (notifyAdmin) {
//                 notifyAdmin({
//                     type: 'bulk_withdrawal_processed',
//                     message: `Bulk processed ${results.processed} withdrawals as ${status}`,
//                     processed: results.processed,
//                     failed: results.failed,
//                     status,
//                     processedBy: req.user.id,
//                     timestamp: new Date()
//                 });
//             }
//         }

//         res.json({
//             success: true,
//             message: `Bulk processing completed. Processed: ${results.processed}, Failed: ${results.failed}`,
//             results
//         });

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error bulk processing withdrawals:', error.message);
//         res.status(500).json({ message: 'Error bulk processing withdrawals.' });
//     }
// });

// // @desc      Get withdrawal statistics (Admin only)
// // @route     GET /api/wallet/admin/withdrawal-stats
// // @access    Private/Admin
// router.get('/admin/withdrawal-stats', protect, authorizeRoles('admin'), async (req, res) => {
//     try {
//         const { timeframe = 'month' } = req.query; // day, week, month, year
        
//         let startDate = new Date();
//         switch (timeframe) {
//             case 'day':
//                 startDate.setDate(startDate.getDate() - 1);
//                 break;
//             case 'week':
//                 startDate.setDate(startDate.getDate() - 7);
//                 break;
//             case 'month':
//                 startDate.setMonth(startDate.getMonth() - 1);
//                 break;
//             case 'year':
//                 startDate.setFullYear(startDate.getFullYear() - 1);
//                 break;
//             default:
//                 startDate.setMonth(startDate.getMonth() - 1);
//         }

//         // Get all withdrawals from all sources
//         const riders = await Rider.find({
//             'withdrawalHistory.createdAt': { $gte: startDate }
//         }).select('withdrawalHistory');

//         const vendors = await User.find({
//             role: 'vendor',
//             'vendorWithdrawals.createdAt': { $gte: startDate }
//         }).select('vendorWithdrawals');

//         const users = await User.find({
//             role: 'user',
//             'userWithdrawals.createdAt': { $gte: startDate }
//         }).select('userWithdrawals');

//         // Process statistics
//         let allWithdrawals = [];
        
//         riders.forEach(rider => {
//             rider.withdrawalHistory.forEach(w => {
//                 if (new Date(w.createdAt) >= startDate) {
//                     allWithdrawals.push({
//                         ...w.toObject(),
//                         userType: 'rider'
//                     });
//                 }
//             });
//         });

//         vendors.forEach(vendor => {
//             (vendor.vendorWithdrawals || []).forEach(w => {
//                 if (new Date(w.createdAt) >= startDate) {
//                     allWithdrawals.push({
//                         ...w.toObject(),
//                         userType: 'vendor'
//                     });
//                 }
//             });
//         });

//         users.forEach(user => {
//             (user.userWithdrawals || []).forEach(w => {
//                 if (new Date(w.createdAt) >= startDate) {
//                     allWithdrawals.push({
//                         ...w.toObject(),
//                         userType: 'user'
//                     });
//                 }
//             });
//         });

//         // Calculate statistics
//         const totalWithdrawals = allWithdrawals.length;
//         const totalAmount = allWithdrawals.reduce((sum, w) => sum + w.amount, 0);
        
//         const byStatus = {
//             pending: allWithdrawals.filter(w => w.status === 'pending').length,
//             completed: allWithdrawals.filter(w => w.status === 'completed').length,
//             failed: allWithdrawals.filter(w => w.status === 'failed').length
//         };

//         const byUserType = {
//             rider: allWithdrawals.filter(w => w.userType === 'rider').length,
//             vendor: allWithdrawals.filter(w => w.userType === 'vendor').length,
//             user: allWithdrawals.filter(w => w.userType === 'user').length
//         };

//         const amountByUserType = {
//             rider: allWithdrawals.filter(w => w.userType === 'rider').reduce((sum, w) => sum + w.amount, 0),
//             vendor: allWithdrawals.filter(w => w.userType === 'vendor').reduce((sum, w) => sum + w.amount, 0),
//             user: allWithdrawals.filter(w => w.userType === 'user').reduce((sum, w) => sum + w.amount, 0)
//         };

//         // Daily breakdown for chart
//         const dailyBreakdown = {};
//         allWithdrawals.forEach(w => {
//             const date = new Date(w.createdAt).toISOString().split('T')[0];
//             if (!dailyBreakdown[date]) {
//                 dailyBreakdown[date] = { date, total: 0, completed: 0, pending: 0, failed: 0 };
//             }
//             dailyBreakdown[date].total += w.amount;
//             dailyBreakdown[date][w.status] += w.amount;
//         });

//         const chartData = Object.values(dailyBreakdown).sort((a, b) => new Date(a.date) - new Date(b.date));

//         res.json({
//             timeframe,
//             startDate,
//             endDate: new Date(),
//             summary: {
//                 totalWithdrawals,
//                 totalAmount,
//                 averageAmount: totalWithdrawals > 0 ? totalAmount / totalWithdrawals : 0,
//                 pendingAmount: allWithdrawals.filter(w => w.status === 'pending').reduce((sum, w) => sum + w.amount, 0),
//                 completedAmount: allWithdrawals.filter(w => w.status === 'completed').reduce((sum, w) => sum + w.amount, 0)
//             },
//             breakdown: {
//                 byStatus,
//                 byUserType,
//                 amountByUserType
//             },
//             chartData
//         });

//     } catch (error) {
//         console.error('Error fetching withdrawal statistics:', error.message);
//         res.status(500).json({ message: 'Error fetching withdrawal statistics.' });
//     }
// });

// module.exports = router;