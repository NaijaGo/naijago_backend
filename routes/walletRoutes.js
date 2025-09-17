const express = require('express');
const router = express.Router();
const axios = require('axios');
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');
const dotenv = require('dotenv');

dotenv.config();

// @desc    Verify Flutterwave payment and credit user's wallet
// @route   POST /api/wallet/verify-payment
// @access  Private
router.post('/verify-payment', protect, async (req, res) => {
    const { transactionRef } = req.body; // ✅ Matches frontend now
    const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;

    if (!transactionRef) {
        return res.status(400).json({ message: 'Transaction reference is required.' });
    }

    if (!flutterwaveSecretKey) {
        console.error('FLUTTERWAVE_SECRET_KEY is not set in environment variables.');
        return res.status(500).json({ message: 'Server configuration error.' });
    }

    try {
        // ✅ Verify payment by tx_ref
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
            
            const updatedUser = await User.findByIdAndUpdate(
                req.user.id,
                { $inc: { userWalletBalance: amount } },
                { new: true, runValidators: true }
            );

            if (!updatedUser) {
                return res.status(404).json({ message: 'User not found.' });
            }
            
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
        if (error.response) {
            console.error('Flutterwave API responded with an error:');
            console.error('Status code:', error.response.status);
            console.error('Error data:', error.response.data);
        } else if (error.request) {
            console.error('Flutterwave API request error:', error.request);
        } else {
            console.error('Error during Flutterwave API request setup:', error.message);
        }
        res.status(500).json({ message: 'Error verifying payment with Flutterwave.' });
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


// @desc    Withdraw funds from wallet to bank account
// @route   POST /api/wallet/withdraw
// @access  Private
router.post('/withdraw', protect, async (req, res) => {
  const { bank_code, account_number, account_name, amount } = req.body;

  if (!bank_code || !account_number || !account_name || !amount) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  if (amount <= 0) {
    return res.status(400).json({ message: 'Invalid withdrawal amount.' });
  }

  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (user.userWalletBalance < amount) {
      return res.status(400).json({ message: 'Insufficient balance.' });
    }

    const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!flutterwaveSecretKey) {
      return res.status(500).json({ message: 'Missing Flutterwave Secret Key.' });
    }

    // ✅ Prepare transfer request
    const transferPayload = {
      account_bank: bank_code,        // Bank code
      account_number: account_number, // Account number
      amount: amount,
      narration: "Wallet withdrawal",
      currency: "NGN",
      reference: `wd_${Date.now()}`, // unique reference
      debit_currency: "NGN"
    };

    // ✅ Call Flutterwave Transfers API
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

    if (transferData.status === "success") {
      // Deduct from wallet balance only if Flutterwave accepted transfer
      user.userWalletBalance -= amount;
      await user.save();

      return res.status(200).json({
        message: "Withdrawal request successful. Funds will arrive shortly.",
        newBalance: user.userWalletBalance,
        transferId: transferData.data.id,
        flutterwaveStatus: transferData.data.status
      });
    } else {
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