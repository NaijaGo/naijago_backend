// utils/paymentProcessor.js
const mongoose = require('mongoose');
const Rider = require('../models/Rider');
const User = require('../models/User');
const { calculateDistance } = require('./distanceCalculator');

/**
 * CENTRAL PAYMENT PROCESSOR - Prevents double crediting
 * Processes payments for vendors and riders when order is completed
 */

class PaymentProcessor {
  /**
   * Process complete payout for an order (vendors + rider)
   * @param {Object} mainOrder - The MainOrder document
   * @param {Array} shipments - All shipments for this order
   * @param {mongoose.ClientSession} session - MongoDB session
   * @returns {Object} Payout summary
   */
  static async processOrderCompletion(mainOrder, shipments, session) {
    try {
      // Prevent double processing
      if (mainOrder.paymentProcessed) {
        throw new Error('Payment already processed for this order');
      }

      if (!mainOrder.isPaid) {
        throw new Error('Order is not paid, cannot process payout');
      }

      const payoutSummary = {
        vendorPayouts: [],
        totalVendorPayout: 0,
        riderPayout: 0,
        totalPayout: 0,
        processedAt: new Date()
      };

      // 1. PROCESS VENDOR PAYOUTS (from each shipment)
      for (const shipment of shipments) {
        const vendorPayout = await this.processVendorPayout(shipment, session);
        payoutSummary.vendorPayouts.push(vendorPayout);
        payoutSummary.totalVendorPayout += vendorPayout.amount;
      }

      // 2. PROCESS RIDER PAYOUT (if rider is assigned)
      if (mainOrder.rider) {
        const riderPayout = await this.processRiderPayout(mainOrder, shipments, session);
        payoutSummary.riderPayout = riderPayout.amount;
        payoutSummary.riderDetails = riderPayout;
      }

      payoutSummary.totalPayout = payoutSummary.totalVendorPayout + payoutSummary.riderPayout;

      // 3. Mark order as payment processed
      mainOrder.paymentProcessed = true;
      mainOrder.vendorsPaid = true;
      mainOrder.vendorsPaidAt = new Date();
      
      if (mainOrder.rider) {
        mainOrder.riderPaid = true;
        mainOrder.riderPaidAt = new Date();
        mainOrder.riderEarnings = payoutSummary.riderPayout;
      }

      await mainOrder.save({ session });

      return payoutSummary;

    } catch (error) {
      console.error('PaymentProcessor Error:', error);
      throw error;
    }
  }

  /**
   * Process vendor payout for a single shipment
   * @param {Object} shipment - Shipment document
   * @param {mongoose.ClientSession} session - MongoDB session
   * @returns {Object} Vendor payout details
   */
  static async processVendorPayout(shipment, session) {
    try {
      // Calculate vendor earnings: subtotal - platformFee (vendor gets 85-90% depending on commission)
      const revenue = shipment.subtotal;
      const commission = shipment.platformFee;
      const vendorEarning = revenue - commission;

      // Update vendor's wallet
      await User.findByIdAndUpdate(
        shipment.vendor,
        {
          $inc: { vendorWalletBalance: vendorEarning },
          $push: {
            notifications: {
              type: 'delivery_payout',
              message: `Payout of ₦${vendorEarning.toFixed(2)} received for completed order ${shipment.mainOrder}. Platform Fee: ₦${commission.toFixed(2)}.`,
              isRead: false,
              relatedModel: 'MainOrder',
              relatedId: shipment.mainOrder,
              createdAt: new Date()
            }
          }
        },
        { session }
      );

      // Mark shipment as vendor paid
      shipment.vendorPaidAt = new Date();
      await shipment.save({ session });

      return {
        vendorId: shipment.vendor,
        amount: vendorEarning,
        revenue: revenue,
        commission: commission,
        commissionRate: shipment.commissionRate || 0.15,
        shipmentId: shipment._id,
        paidAt: new Date()
      };

    } catch (error) {
      console.error('Vendor Payout Error:', error);
      throw new Error(`Failed to process vendor payout: ${error.message}`);
    }
  }

  /**
   * Process rider payout based on distance (₦150/km)
   * @param {Object} mainOrder - MainOrder document
   * @param {Array} shipments - All shipments for this order
   * @param {mongoose.ClientSession} session - MongoDB session
   * @returns {Object} Rider payout details
   */
  static async processRiderPayout(mainOrder, shipments, session) {
    try {
      // Calculate total distance for all shipments
      let totalDistanceKm = 0;
      let totalEarnings = 0;
      const shipmentDetails = [];

      for (const shipment of shipments) {
        // Calculate distance between vendor and user for each shipment
        const distanceKm = calculateDistance(
          shipment.vendorLocation.latitude,
          shipment.vendorLocation.longitude,
          mainOrder.userLocation.latitude,
          mainOrder.userLocation.longitude
        );

        // Rider gets ₦150 per kilometer
        const shipmentEarnings = distanceKm * 150;
        
        totalDistanceKm += distanceKm;
        totalEarnings += shipmentEarnings;

        shipmentDetails.push({
          shipmentId: shipment._id,
          distanceKm: parseFloat(distanceKm.toFixed(2)),
          earnings: shipmentEarnings,
          vendorLocation: shipment.vendorLocation,
          userLocation: mainOrder.userLocation
        });
      }

      // Ensure minimum earnings
      const minEarnings = 500; // Minimum ₦500 per delivery
      const finalEarnings = Math.max(totalEarnings, minEarnings);

      // Update rider's wallet
      await Rider.findByIdAndUpdate(
        mainOrder.rider,
        {
          $inc: {
            walletBalance: finalEarnings,
            totalEarnings: finalEarnings,
            completedDeliveries: 1,
            activeDeliveries: -1
          },
          $push: {
            walletTransactions: {
              amount: finalEarnings,
              type: 'credit',
              description: `Delivery payout for order ${mainOrder._id}`,
              balanceAfter: (await Rider.findById(mainOrder.rider)).walletBalance + finalEarnings,
              reference: `RIDER-${Date.now()}`,
              timestamp: new Date()
            },
            notifications: {
              type: 'delivery_payout',
              message: `₦${finalEarnings.toFixed(2)} credited for completing order ${mainOrder._id}. Distance: ${totalDistanceKm.toFixed(2)}km`,
              isRead: false,
              relatedModel: 'MainOrder',
              relatedId: mainOrder._id,
              createdAt: new Date()
            }
          }
        },
        { session }
      );

      return {
        riderId: mainOrder.rider,
        amount: finalEarnings,
        distanceKm: parseFloat(totalDistanceKm.toFixed(2)),
        ratePerKm: 150,
        shipmentDetails: shipmentDetails,
        calculatedAt: new Date()
      };

    } catch (error) {
      console.error('Rider Payout Error:', error);
      throw new Error(`Failed to process rider payout: ${error.message}`);
    }
  }

  /**
   * Validate if payout can be processed
   * @param {Object} mainOrder - MainOrder document
   * @returns {Object} Validation result
   */
  static validatePayout(mainOrder) {
    const errors = [];

    if (!mainOrder.isPaid) {
      errors.push('Order is not paid');
    }

    if (mainOrder.paymentProcessed) {
      errors.push('Payment already processed for this order');
    }

    if (mainOrder.mainOrderStatus !== 'delivered' && mainOrder.mainOrderStatus !== 'completed') {
      errors.push('Order must be delivered before payout');
    }

    if (mainOrder.rider && !mainOrder.riderPaid) {
      // Check if rider exists and is approved
      // This will be validated in the main process
    }

    return {
      isValid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * Process withdrawal for rider (minimum ₦5000)
   * @param {Object} rider - Rider document
   * @param {Number} amount - Withdrawal amount
   * @param {Object} bankDetails - Bank account details
   * @returns {Object} Withdrawal result
   */
  static async processRiderWithdrawal(rider, amount, bankDetails) {
    const MIN_WITHDRAWAL = 5000;
    const session = await mongoose.startSession();
    
    try {
      session.startTransaction();

      // Validate withdrawal
      if (amount < MIN_WITHDRAWAL) {
        throw new Error(`Minimum withdrawal amount is ₦${MIN_WITHDRAWAL.toLocaleString()}`);
      }

      if (rider.walletBalance < amount) {
        throw new Error(`Insufficient balance. Available: ₦${rider.walletBalance.toLocaleString()}`);
      }

      if (!rider.bankAccount || !rider.bankAccount.verified) {
        throw new Error('Bank account not verified');
      }

      // Generate unique reference
      const reference = `WD${Date.now()}${Math.floor(Math.random() * 1000)}`;

      // Create withdrawal record
      const withdrawalRecord = {
        amount: amount,
        status: 'pending',
        reference: reference,
        createdAt: new Date(),
        paymentMethod: 'bank_transfer',
        accountDetails: bankDetails || rider.bankAccount
      };

      // Deduct from wallet
      rider.walletBalance -= amount;
      rider.withdrawalHistory.unshift(withdrawalRecord);
      
      // Add transaction record
      rider.walletTransactions.push({
        amount: -amount,
        type: 'debit',
        description: `Withdrawal request ${reference}`,
        balanceAfter: rider.walletBalance,
        reference: reference,
        timestamp: new Date()
      });

      await rider.save({ session });

      await session.commitTransaction();
      session.endSession();

      // TODO: Integrate with payment gateway (Paystack/Flutterwave)
      // For now, simulate processing
      this.simulateBankTransfer(rider._id, reference, amount);

      return {
        success: true,
        reference: reference,
        amount: amount,
        newBalance: rider.walletBalance,
        estimatedCompletion: 'Within 24 hours'
      };

    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }

  /**
   * Simulate bank transfer (replace with actual payment gateway)
   * @param {String} riderId - Rider ID
   * @param {String} reference - Withdrawal reference
   * @param {Number} amount - Withdrawal amount
   */
  static async simulateBankTransfer(riderId, reference, amount) {
    // Simulate 5-second processing delay
    setTimeout(async () => {
      try {
        const rider = await Rider.findById(riderId);
        const withdrawalIndex = rider.withdrawalHistory.findIndex(
          w => w.reference === reference
        );
        
        if (withdrawalIndex !== -1) {
          rider.withdrawalHistory[withdrawalIndex].status = 'completed';
          rider.withdrawalHistory[withdrawalIndex].completedAt = new Date();
          rider.totalWithdrawn += amount;
          
          // Add successful transaction record
          rider.walletTransactions.push({
            amount: -amount,
            type: 'debit',
            description: `Withdrawal completed ${reference}`,
            balanceAfter: rider.walletBalance,
            reference: reference,
            timestamp: new Date()
          });

          await rider.save();
          
          console.log(`Withdrawal ${reference} completed for rider ${riderId}`);
        }
      } catch (error) {
        console.error('Bank transfer simulation error:', error);
      }
    }, 5000);
  }

  /**
   * Get payout summary for an order
   * @param {String} orderId - MainOrder ID
   * @returns {Object} Payout summary
   */
  static async getPayoutSummary(orderId) {
    try {
      const mainOrder = await mongoose.model('MainOrder').findById(orderId)
        .populate('rider', 'fullName walletBalance')
        .populate({
          path: 'shipments',
          populate: {
            path: 'vendor',
            select: 'businessName vendorWalletBalance'
          }
        });

      if (!mainOrder) {
        throw new Error('Order not found');
      }

      const summary = {
        orderId: mainOrder._id,
        orderStatus: mainOrder.mainOrderStatus,
        isPaid: mainOrder.isPaid,
        paymentProcessed: mainOrder.paymentProcessed || false,
        totalPrice: mainOrder.totalPrice,
        vendorPayouts: [],
        riderPayout: null,
        canProcess: false
      };

      // Calculate vendor payouts
      for (const shipment of mainOrder.shipments) {
        const vendorEarning = shipment.subtotal - shipment.platformFee;
        summary.vendorPayouts.push({
          vendorId: shipment.vendor._id,
          vendorName: shipment.vendor.businessName,
          shipmentId: shipment._id,
          subtotal: shipment.subtotal,
          commission: shipment.platformFee,
          payoutAmount: vendorEarning,
          currentBalance: shipment.vendor.vendorWalletBalance
        });
      }

      // Calculate rider payout if assigned
      if (mainOrder.rider) {
        let totalDistanceKm = 0;
        
        for (const shipment of mainOrder.shipments) {
          const distanceKm = calculateDistance(
            shipment.vendorLocation.latitude,
            shipment.vendorLocation.longitude,
            mainOrder.userLocation.latitude,
            mainOrder.userLocation.longitude
          );
          totalDistanceKm += distanceKm;
        }

        const riderEarnings = totalDistanceKm * 150;
        const minEarnings = 500;
        const finalEarnings = Math.max(riderEarnings, minEarnings);

        summary.riderPayout = {
          riderId: mainOrder.rider._id,
          riderName: mainOrder.rider.fullName,
          distanceKm: parseFloat(totalDistanceKm.toFixed(2)),
          ratePerKm: 150,
          calculatedEarnings: riderEarnings,
          finalEarnings: finalEarnings,
          currentBalance: mainOrder.rider.walletBalance
        };
      }

      // Check if payout can be processed
      const validation = this.validatePayout(mainOrder);
      summary.canProcess = validation.isValid;
      summary.validationErrors = validation.errors;

      return summary;

    } catch (error) {
      console.error('Get Payout Summary Error:', error);
      throw error;
    }
  }
}

module.exports = PaymentProcessor;