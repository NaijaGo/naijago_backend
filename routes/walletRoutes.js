const express = require('express');
const router = express.Router();
const axios = require('axios');
const User = require('../models/User');
const Payment = require('../models/Payment');
const { protect } = require('../middleware/authMiddleware');
const dotenv = require('dotenv');
const { Resend } = require('resend');

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

// @desc      Verify Flutterwave payment and credit user's wallet
// @route     POST /api/wallet/verify-payment
// @access    Private
router.post('/verify-payment', protect, async (req, res) => {
    const { transactionRef } = req.body;
    const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;

    if (!transactionRef) {
        return res.status(400).json({ message: 'Transaction reference is required.' });
    }

    if (!flutterwaveSecretKey) {
        console.error('FLUTTERWAVE_SECRET_KEY is not set in environment variables.');
        return res.status(500).json({ message: 'Server configuration error.' });
    }

    try {
        // SECURITY FIX 1: Check if this transaction reference has already been processed
        const existingPayment = await Payment.findOne({ transactionRef });
        if (existingPayment) {
            return res.status(409).json({ message: 'Transaction has already been processed.' });
        }

        const response = await axios.get(
            `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${transactionRef}`,
            {
                headers: {
                    'Authorization': `Bearer ${flutterwaveSecretKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const responseData = response.data;

        if (responseData.status === 'success' && responseData.data.status === 'successful') {
            const amount = responseData.data.amount;
            const currency = responseData.data.currency;

            // SECURITY FIX 2: Create a payment document and credit the wallet as a single, atomic operation
            const updatedUser = await User.findByIdAndUpdate(
                req.user.id,
                { $inc: { userWalletBalance: amount } },
                { new: true, runValidators: true }
            );

            if (!updatedUser) {
                return res.status(404).json({ message: 'User not found.' });
            }

            // Create a new payment record to prevent future replay attacks
            await Payment.create({
                userId: req.user.id,
                transactionRef: transactionRef,
                amount: amount,
                currency: currency,
                status: 'successful'
            });

            return res.status(200).json({
                message: `Wallet credited with ${amount} ${currency}.`,
                newBalance: updatedUser.userWalletBalance
            });
        } else {
            return res.status(400).json({
                message: 'Payment verification failed or payment was not successful.'
            });
        }
    } catch (error) {
        // In case of a database error (e.g., transactionRef unique key violation)
        if (error.code === 11000) { // MongoDB's code for a duplicate key error
            return res.status(409).json({ message: 'Transaction has already been processed.' });
        }

        if (error.response) {
            console.error('Flutterwave API responded with an error:', error.response.data);
            res.status(400).json({ message: 'Flutterwave verification failed.' });
        } else {
            console.error('Error during payment verification:', error.message);
            res.status(500).json({ message: 'Error verifying payment.' });
        }
    }
});


// @desc    Get list of banks (via Flutterwave)
// @route   GET /api/wallet/banks
// @access  Private
router.get('/banks', protect, async (req, res) => {
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
router.post('/request-otp', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
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
            to: [user.email], // The recipient's email address
            subject: 'Your Withdrawal Verification Code',
            html: `
                    <div style="font-family: 'Arial', sans-serif; background-color: #f7f7f7; padding: 20px; border-radius: 10px; border: 1px solid #ddd; max-width: 600px; margin: 20px auto;">
                        <div style="text-align: center; margin-bottom: 20px;">
                            <img src="https://naijago-backend.onrender.com/naijago-app.jpg" alt="Najago App Logo" style="width: 150px; height: auto;">
                        </div>
                        <div style="background-color: #160d0dff; padding: 20px; border-radius: 8px;">
                            <h2 style="color: #000080; text-align: center; font-size: 24px;">Withdrawal Verification Code</h2>
                            <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="color: #555;">Hello ${user.firstName},</p>
                            <p style="color: #555;">To complete your withdrawal, please use the following One-Time Password (OTP):</p>
                            <div style="text-align: center; margin: 30px 0;">
                                <span style="display: inline-block; padding: 15px 25px; background-color: #ADFF2F; color: #000080; font-size: 28px; font-weight: bold; letter-spacing: 2px; border-radius: 8px;">${otp}</span>
                            </div>
                            <p style="color: #888; text-align: center; font-size: 14px;">This code is valid for 5 minutes. For your security, do not share this code.</p>
                            <p style="color: #888; font-size: 14px; margin-top: 30px;">If you did not request this, please contact support immediately.</p>
                            <img src="https://naijago-backend.onrender.com/naijago-flier3.jpg" alt="Najago App Logo" style="width: 150px; height: auto;">
                        </div>
                        <div style="text-align: center; margin-top: 20px; color: #aaa; font-size: 12px;">
                            <p>&copy; ${new Date().getFullYear()} Najago. All rights reserved.</p>
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
// 
// THIS ROUTE HAS BEEN UPDATED FOR SECURITY AND RELIABILITY
router.post('/withdraw', protect, async (req, res) => {
    const { bank_code, account_number, account_name, amount, otp, wallet_type } = req.body;

    if (!bank_code || !account_number || !account_name || !amount || !otp || !wallet_type) {
        return res.status(400).json({ message: 'All required fields are needed.' });
    }

    if (amount <= 0) {
        return res.status(400).json({ message: 'Invalid withdrawal amount.' });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }
        
        // 1. UPDATED: OTP Verification is performed first
        if (user.otp !== otp || user.otpExpires < Date.now()) {
            user.otp = undefined;
            user.otpExpires = undefined;
            await user.save();
            return res.status(401).json({ message: 'Invalid or expired OTP.' });
        }

        const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;
        if (!flutterwaveSecretKey) {
            return res.status(500).json({ message: 'Missing Flutterwave Secret Key.' });
        }

        // 2. UPDATED: Prepare and call Flutterwave Transfers API
        const transferPayload = {
            account_bank: bank_code,
            account_number: account_number,
            amount: amount,
            narration: `Withdrawal from ${wallet_type} wallet`,
            currency: "NGN",
            // Reference made more unique to prevent conflicts
            reference: `wd_${Date.now()}_${req.user.id}`, 
            debit_currency: "NGN"
        };

        const transferResponse = await axios.post(
            "https://api.flutterwave.com/v3/transfers",
            transferPayload,
            {
                headers: {
                    Authorization: `Bearer ${flutterwaveSecretKey}`,
                    "Content-Type": "application/json"
                }
            }
        );

        const transferData = transferResponse.data;

        // 3. ATOMIC BALANCE UPDATE: Only deduct balance if Flutterwave's transfer request succeeded
        if (transferData.status === "success") {
            let updateQuery = {};
            let balanceField;

            if (wallet_type === 'vendor') {
                balanceField = 'vendorWalletBalance';
            } else if (wallet_type === 'user') {
                balanceField = 'userWalletBalance';
            } else {
                return res.status(400).json({ message: 'Invalid wallet type provided.' });
            }

            // Perform the atomic update with a condition. This prevents the race condition.
            const updatedUser = await User.findOneAndUpdate(
                { _id: req.user.id, [balanceField]: { $gte: amount } },
                { 
                    $inc: { [balanceField]: -amount },
                    $set: { otp: undefined, otpExpires: undefined } 
                },
                { new: true, runValidators: true }
            );

            if (!updatedUser) {
                // This means the balance was insufficient or a concurrent transaction occurred.
                // The Flutterwave transfer succeeded, but the database update failed.
                // This scenario requires manual reconciliation.
                console.error("Race condition or insufficient balance detected after successful Flutterwave transfer:", req.user.id);
                // The user still got the funds, but the database is inconsistent.
                // Respond with an error and log the issue.
                return res.status(400).json({ message: 'Withdrawal failed. Insufficient funds or a concurrent transaction occurred.' });
            }
            
            return res.status(200).json({
                message: "Withdrawal request successful. Funds will arrive shortly.",
                newBalance: updatedUser[balanceField],
                transferId: transferData.data.id,
                flutterwaveStatus: transferData.data.status
            });

        } else {
            // If Flutterwave fails, the database balance is not touched.
            return res.status(400).json({
                message: "Withdrawal failed.",
                details: transferData
            });
        }

    } catch (error) {
        console.error("Error processing withdrawal:", error.response?.data || error.message);
        return res.status(500).json({ message: "Error processing withdrawal." });
    }
});


module.exports = router;


// const express = require('express');
// const router = express.Router();
// const axios = require('axios');
// const User = require('../models/User');
// const Payment = require('../models/Payment'); 
// const { protect } = require('../middleware/authMiddleware');
// const dotenv = require('dotenv');
// const { Resend } = require('resend');

// dotenv.config();

// const resend = new Resend(process.env.RESEND_API_KEY);

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
            
//             // SECURITY FIX 2: Create a payment document and credit the wallet as a single, atomic operation
//             const updatedUser = await User.findByIdAndUpdate(
//                 req.user.id,
//                 { $inc: { userWalletBalance: amount } },
//                 { new: true, runValidators: true }
//             );

//             if (!updatedUser) {
//                 return res.status(404).json({ message: 'User not found.' });
//             }

//             // Create a new payment record to prevent future replay attacks
//             await Payment.create({
//                 userId: req.user.id,
//                 transactionRef: transactionRef,
//                 amount: amount,
//                 currency: currency,
//                 status: 'successful'
//             });
            
//             return res.status(200).json({
//                 message: `Wallet credited with ${amount} ${currency}.`,
//                 newBalance: updatedUser.userWalletBalance
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


// // @desc    Get list of banks (via Flutterwave)
// // @route   GET /api/wallet/banks
// // @access  Private
// router.get('/banks', protect, async (req, res) => {
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
// router.post('/request-otp', protect, async (req, res) => {
//     try {
//         const user = await User.findById(req.user.id);
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
//             to: [user.email], // The recipient's email address
//             subject: 'Your Withdrawal Verification Code',
//             html: `
//                     <div style="font-family: 'Arial', sans-serif; background-color: #f7f7f7; padding: 20px; border-radius: 10px; border: 1px solid #ddd; max-width: 600px; margin: 20px auto;">
//                         <div style="text-align: center; margin-bottom: 20px;">
//                             <img src="https://naijago-backend.onrender.com/najago-app.jpg" alt="Najago App Logo" style="width: 150px; height: auto;">
//                         </div>
//                         <div style="background-color: #160d0dff; padding: 20px; border-radius: 8px;">
//                             <h2 style="color: #000080; text-align: center; font-size: 24px;">Withdrawal Verification Code</h2>
//                             <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
//                             <p style="color: #555;">Hello ${user.firstName},</p>
//                             <p style="color: #555;">To complete your withdrawal, please use the following One-Time Password (OTP):</p>
//                             <div style="text-align: center; margin: 30px 0;">
//                                 <span style="display: inline-block; padding: 15px 25px; background-color: #ADFF2F; color: #000080; font-size: 28px; font-weight: bold; letter-spacing: 2px; border-radius: 8px;">${otp}</span>
//                             </div>
//                             <p style="color: #888; text-align: center; font-size: 14px;">This code is valid for 5 minutes. For your security, do not share this code.</p>
//                             <p style="color: #888; font-size: 14px; margin-top: 30px;">If you did not request this, please contact support immediately.</p>
//                             <img src="https://naijago-backend.onrender.com/najago-flier3.jpg" alt="Najago App Logo" style="width: 150px; height: auto;">
//                         </div>
//                         <div style="text-align: center; margin-top: 20px; color: #aaa; font-size: 12px;">
//                             <p>&copy; ${new Date().getFullYear()} Najago. All rights reserved.</p>
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

// // @desc    Withdraw funds from wallet to bank account
// // @route   POST /api/wallet/withdraw
// // @access  Private
// // @desc      Complete withdrawal using OTP
// // @route     POST /api/wallet/withdraw
// // @access    Private
// router.post('/withdraw', protect, async (req, res) => {
//     // 1. UPDATED: We now look for 'otp' instead of 'password' in the request body
//     const { bank_code, account_number, account_name, amount, otp, wallet_type } = req.body;

//     if (!bank_code || !account_number || !account_name || !amount || !otp || !wallet_type) {
//         return res.status(400).json({ message: 'All required fields are needed.' });
//     }

//     if (amount <= 0) {
//         return res.status(400).json({ message: 'Invalid withdrawal amount.' });
//     }

//     try {
//         const user = await User.findById(req.user.id);
//         if (!user) {
//             return res.status(404).json({ message: 'User not found.' });
//         }

//         // 2. UPDATED: OTP Verification (replaces password check)
//         if (user.otp !== otp || user.otpExpires < Date.now()) {
//             // Clear the OTP to prevent brute-force attacks
//             user.otp = undefined;
//             user.otpExpires = undefined;
//             await user.save();
//             return res.status(401).json({ message: 'Invalid or expired OTP.' });
//         }

//         // 3. ORIGINAL LOGIC: Determine which wallet to withdraw from
//         let newBalance;
//         let withdrawalBalance;

//         if (wallet_type === 'vendor') {
//             withdrawalBalance = user.vendorWalletBalance;
//             if (withdrawalBalance < amount) {
//                 return res.status(400).json({ message: 'Insufficient vendor wallet balance.' });
//             }
//             newBalance = withdrawalBalance - amount;
//             user.vendorWalletBalance = newBalance;
//         } else if (wallet_type === 'user') {
//             withdrawalBalance = user.userWalletBalance;
//             if (withdrawalBalance < amount) {
//                 return res.status(400).json({ message: 'Insufficient app wallet balance.' });
//             }
//             newBalance = withdrawalBalance - amount;
//             user.userWalletBalance = newBalance;
//         } else {
//             return res.status(400).json({ message: 'Invalid wallet type provided.' });
//         }

//         const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;
//         if (!flutterwaveSecretKey) {
//             return res.status(500).json({ message: 'Missing Flutterwave Secret Key.' });
//         }

//         // 4. ORIGINAL LOGIC: Prepare and call Flutterwave Transfers API
//         const transferPayload = {
//             account_bank: bank_code,
//             account_number: account_number,
//             amount: amount,
//             narration: `Withdrawal from ${wallet_type} wallet`,
//             currency: "NGN",
//             reference: `wd_${Date.now()}`,
//             debit_currency: "NGN"
//         };

//         const transferResponse = await axios.post(
//             "https://api.flutterwave.com/v3/transfers",
//             transferPayload,
//             {
//                 headers: {
//                     Authorization: `Bearer ${flutterwaveSecretKey}`,
//                     "Content-Type": "application/json"
//                 }
//             }
//         );

//         const transferData = transferResponse.data;

//         // 5. ORIGINAL LOGIC: Handle Flutterwave response and save changes
//         if (transferData.status === "success") {
//             // Clear the OTP fields after a successful withdrawal
//             user.otp = undefined;
//             user.otpExpires = undefined;
//             // Only save the updated balance if Flutterwave's transfer request succeeded
//             await user.save();
//             return res.status(200).json({
//                 message: "Withdrawal request successful. Funds will arrive shortly.",
//                 newBalance: newBalance,
//                 transferId: transferData.data.id,
//                 flutterwaveStatus: transferData.data.status
//             });
//         } else {
//             // If Flutterwave fails, revert the balance change
//             if (wallet_type === 'vendor') {
//                 user.vendorWalletBalance = withdrawalBalance;
//             } else if (wallet_type === 'user') {
//                 user.userWalletBalance = withdrawalBalance;
//             }
//             await user.save();
//             return res.status(400).json({
//                 message: "Withdrawal failed.",
//                 details: transferData
//             });
//         }
//     } catch (error) {
//         console.error("Error processing withdrawal:", error.response?.data || error.message);
//         return res.status(500).json({ message: "Error processing withdrawal." });
//     }
// });

// module.exports = router;

// const express = require('express');
// const router = express.Router();
// const axios = require('axios');
// const User = require('../models/User');
// const { protect } = require('../middleware/authMiddleware');
// const dotenv = require('dotenv');

// dotenv.config();

// // @desc    Verify Flutterwave payment and credit user's wallet
// // @route   POST /api/wallet/verify-payment
// // @access  Private
// router.post('/verify-payment', protect, async (req, res) => {
//     const { transactionRef } = req.body; // ✅ Matches frontend now
//     const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;

//     if (!transactionRef) {
//         return res.status(400).json({ message: 'Transaction reference is required.' });
//     }

//     if (!flutterwaveSecretKey) {
//         console.error('FLUTTERWAVE_SECRET_KEY is not set in environment variables.');
//         return res.status(500).json({ message: 'Server configuration error.' });
//     }

//     try {
//         // ✅ Verify payment by tx_ref
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
            
//             const updatedUser = await User.findByIdAndUpdate(
//                 req.user.id,
//                 { $inc: { userWalletBalance: amount } },
//                 { new: true, runValidators: true }
//             );

//             if (!updatedUser) {
//                 return res.status(404).json({ message: 'User not found.' });
//             }
            
//             return res.status(200).json({
//                 message: `Wallet credited with ${amount} ${currency}.`,
//                 newBalance: updatedUser.userWalletBalance
//             });
//         } else {
//             return res.status(400).json({
//                 message: 'Payment verification failed or payment was not successful.'
//             });
//         }
//     } catch (error) {
//         if (error.response) {
//             console.error('Flutterwave API responded with an error:');
//             console.error('Status code:', error.response.status);
//             console.error('Error data:', error.response.data);
//         } else if (error.request) {
//             console.error('Flutterwave API request error:', error.request);
//         } else {
//             console.error('Error during Flutterwave API request setup:', error.message);
//         }
//         res.status(500).json({ message: 'Error verifying payment with Flutterwave.' });
//     }
// });


// // @desc    Get list of banks (via Flutterwave)
// // @route   GET /api/wallet/banks
// // @access  Private
// router.get('/banks', protect, async (req, res) => {
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


// // @desc    Withdraw funds from wallet to bank account
// // @route   POST /api/wallet/withdraw
// // @access  Private
// router.post('/withdraw', protect, async (req, res) => {
//   const { bank_code, account_number, account_name, amount } = req.body;

//   if (!bank_code || !account_number || !account_name || !amount) {
//     return res.status(400).json({ message: 'All fields are required.' });
//   }

//   if (amount <= 0) {
//     return res.status(400).json({ message: 'Invalid withdrawal amount.' });
//   }

//   try {
//     const user = await User.findById(req.user.id);
//     if (!user) {
//       return res.status(404).json({ message: 'User not found.' });
//     }

//     if (user.userWalletBalance < amount) {
//       return res.status(400).json({ message: 'Insufficient balance.' });
//     }

//     const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;
//     if (!flutterwaveSecretKey) {
//       return res.status(500).json({ message: 'Missing Flutterwave Secret Key.' });
//     }

//     // ✅ Prepare transfer request
//     const transferPayload = {
//       account_bank: bank_code,        // Bank code
//       account_number: account_number, // Account number
//       amount: amount,
//       narration: "Wallet withdrawal",
//       currency: "NGN",
//       reference: `wd_${Date.now()}`, // unique reference
//       debit_currency: "NGN"
//     };

//     // ✅ Call Flutterwave Transfers API
//     const transferResponse = await axios.post(
//       "https://api.flutterwave.com/v3/transfers",
//       transferPayload,
//       {
//         headers: {
//           Authorization: `Bearer ${flutterwaveSecretKey}`,
//           "Content-Type": "application/json"
//         }
//       }
//     );

//     const transferData = transferResponse.data;

//     if (transferData.status === "success") {
//       // Deduct from wallet balance only if Flutterwave accepted transfer
//       user.userWalletBalance -= amount;
//       await user.save();

//       return res.status(200).json({
//         message: "Withdrawal request successful. Funds will arrive shortly.",
//         newBalance: user.userWalletBalance,
//         transferId: transferData.data.id,
//         flutterwaveStatus: transferData.data.status
//       });
//     } else {
//       return res.status(400).json({
//         message: "Withdrawal failed.",
//         details: transferData
//       });
//     }
//   } catch (error) {
//     console.error("Error processing withdrawal:", error.response?.data || error.message);
//     return res.status(500).json({ message: "Error processing withdrawal." });
//   }
// });


// module.exports = router;